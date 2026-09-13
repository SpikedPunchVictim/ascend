import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StoreBusyError, isBusyError, openStore } from '../src/index.js';

/**
 * asc-51t: recognising a lock conflict turned out to be the hard half.
 *
 * `node:sqlite` exports no error class for it, so the guard in `db.ts` is duck-typed on `code` and
 * `errcode`. A duck-typed guard that has only ever been tested against a hand-written fixture is a
 * guard that agrees with the fixture and nothing else -- and the comment claiming "there is no
 * `SQLiteError` export" is a claim about a dependency, which is the kind that rots quietly.
 *
 * So these drive the REAL driver into a REAL lock conflict and assert the guard fires on what
 * actually comes out. If `node:sqlite` ever grows a class, or changes its error shape, this fails
 * loudly instead of leaving the store unable to recognise its own most common failure.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-busy-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A store with one table, and a second connection holding the write lock on it. */
const withContendedStore = (body: (locked: () => Error) => void): void => {
  const store = openStore({ dir: tempDir() });
  const other = new DatabaseSync(store.file);
  try {
    store.db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    other.exec('PRAGMA busy_timeout = 0');

    // Zero, so the attempt below fails now rather than after the production 5s. The point is the
    // ERROR SHAPE, and it does not depend on how long we waited.
    store.db.exec('PRAGMA busy_timeout = 0');
    other.exec('BEGIN EXCLUSIVE');

    body(() => {
      // The throw is returned rather than asserted inside, so the caller can inspect the object.
      let caught: unknown;
      try {
        store.db.prepare('INSERT INTO t (id) VALUES (?)').run('mine');
      } catch (error) {
        caught = error;
      }
      if (caught === undefined)
        throw new Error('the write was expected to lose the lock and did not');
      return caught as Error;
    });
  } finally {
    other.close();
    store.close();
  }
};

describe('a real lock conflict is recognised by the guard that has to recognise it', () => {
  it('matches errcode 5, and the error is a plain Error with no class of its own', () => {
    withContendedStore((locked) => {
      const error = locked();

      // The facts the duck-typing rests on, measured rather than assumed.
      expect(error.constructor.name).toBe('Error');
      expect(error).toBeInstanceOf(Error);
      expect((error as { errcode?: number }).errcode).toBe(5);
      expect((error as { code?: string }).code).toBe('ERR_SQLITE_ERROR');
      expect(error.message).toBe('database is locked');

      // And the guard, on that very object.
      expect(isBusyError(error)).toBe(true);
    });
  });

  it('matches the EXTENDED busy and locked codes, which is where the real ones live', () => {
    // Measured, not enumerated from a header. The probe that mutation-tests this fix
    // (`/tmp/probe-51t-real.mjs`) runs the real `openStore` under 20-way contention with the busy
    // timeout switched off; recorded runs of 500 opens produced 11-13 failures each, and in each of
    // them **1-3 carried errcode 261 -- SQLITE_BUSY_RECOVERY**, i.e. SQLITE_BUSY with the recovery
    // extension in the high bits. A check written as `errcode === 5` recognises none of those, so a
    // real fraction of genuine lock conflicts would fall through to the bare `database is locked`
    // string that this whole change exists to remove. The first version of the guard was that
    // check, and this test is why it is not any more.
    //
    // Each case is `primary | (extension << 8)`, and the extension is what the guard must ignore.
    const extended: readonly [string, number][] = [
      ['SQLITE_BUSY', 5 | (0 << 8)],
      ['SQLITE_BUSY_RECOVERY (measured)', 5 | (1 << 8)],
      ['SQLITE_BUSY_SNAPSHOT', 5 | (2 << 8)],
      ['SQLITE_BUSY_TIMEOUT', 5 | (3 << 8)],
      ['SQLITE_LOCKED', 6 | (0 << 8)],
      ['SQLITE_LOCKED_SHAREDCACHE', 6 | (1 << 8)],
    ];
    for (const [name, errcode] of extended) {
      const error = new Error('database is locked');
      Object.assign(error, { code: 'ERR_SQLITE_ERROR', errcode });
      expect(isBusyError(error), `${name} (errcode ${String(errcode)})`).toBe(true);
    }
  });

  it('does NOT match a sqlite error that is not a lock', () => {
    // errcode 1 (SQLITE_ERROR) shares `code: 'ERR_SQLITE_ERROR'`, which is why reading `code` alone
    // would make the guard fire on every sqlite failure -- and would rewrite "no such table" into a
    // lock-conflict message that sends the caller hunting for a lock that does not exist.
    const store = openStore({ dir: tempDir() });
    try {
      let caught: unknown;
      try {
        store.db.prepare('SELECT 1 FROM no_such_table').get();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { errcode?: number }).errcode).toBe(1);
      expect(isBusyError(caught)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('does not mistake its own StoreBusyError for a driver busy error', () => {
    // It is an ascend error describing a failed OPEN, not a driver error from a failed statement.
    // The CLI treats them differently -- this one already carries its own context and fix.
    expect(isBusyError(new StoreBusyError('/x/ascend.db', 5000))).toBe(false);
  });

  it("does NOT match a lock that is not SQLite's to report", () => {
    // The mask must not become a licence to match anything with a low byte of 5 or 6.
    const wrongCode = new Error('database is locked');
    Object.assign(wrongCode, { code: 'ENOENT', errcode: 5 });
    expect(isBusyError(wrongCode)).toBe(false);

    const wrongType = new Error('database is locked');
    Object.assign(wrongType, { code: 'ERR_SQLITE_ERROR', errcode: '5' });
    expect(isBusyError(wrongType)).toBe(false);
  });

  it('reports a non-Error without claiming to know what it is', () => {
    expect(isBusyError('database is locked')).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError({ errcode: 5 })).toBe(false);
  });
});

describe('a lock conflict AFTER the constructor is reported the same way', () => {
  it("wraps a busy failure raised by the store's own open sequence", () => {
    // The gap this closes is real and was measured, not imagined: under 20-way contention with the
    // busy timeout off, the failures land on BOTH sides of `new DatabaseSync` -- some inside it,
    // the rest on the statements `openStore` runs after it. The first version of the fix wrapped
    // only the constructor, so the second group still exited 1 with the bare `database is locked`
    // string (probe evidence: `raw driver errcode 5` before, `StoreBusyError` after).
    //
    // Deterministic here rather than contended: another connection holds the write lock, and the
    // store is opened with a timeout of zero, so the `meta` write inside `openStore` -- which runs
    // well after the constructor -- is the statement that loses the lock.
    const dir = tempDir();
    const first = openStore({ dir });
    const other = new DatabaseSync(first.file);
    try {
      other.exec('PRAGMA busy_timeout = 0');
      other.exec('BEGIN EXCLUSIVE');

      let caught: unknown;
      try {
        openStore({ dir, busyTimeoutMs: 0, ascendVersion: '0.0.0-test' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(StoreBusyError);
      expect((caught as StoreBusyError).file).toBe(first.file);
      // And NOT a raw driver error: that is the whole point, since the raw one prints as the bare
      // string `database is locked`.
      expect(isBusyError(caught)).toBe(false);
    } finally {
      other.close();
      first.close();
    }
  });
});

describe('the busy error a failed OPEN raises says the retry is safe', () => {
  it('names the file, the wait, and the fact that nothing was opened', () => {
    const error = new StoreBusyError('/p/.ascend/ascend.db', 5000);
    expect(error.name).toBe('StoreBusyError');
    expect(error.file).toBe('/p/.ascend/ascend.db');
    expect(error.waitedMs).toBe(5000);
    expect(error.message).toMatch(/gave up after waiting 5000ms/);
    expect(error.message).toMatch(/was NOT opened/);
    expect(error.message).toMatch(/re-running it is safe/);
  });
});
