import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TypeSpec } from '@ascend/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AliasInUseError,
  attachStore,
  databaseNames,
  detachStore,
  foldDatabaseName,
  NewerSchemaError,
  NotAnAscendStoreError,
  openStore,
  recordEntry,
  registerType,
  SCHEMA_VERSION,
  StaleStoreError,
  STORE_DIR,
  STORE_FILE,
  userVersion,
} from '../src/index.js';

/**
 * The read-only open, and what it is for.
 *
 * **This is the guarantee `Bash(asc query:*)` as a `settings.json` allowlist entry depends on**, so
 * it is asserted against real SQLite rather than described: a write through a read-only handle is
 * refused, and it stays refused through an `ATTACH`, which is how `asc query --across` still reads
 * other projects. Both directions are checked, because a test that only proved reads work would
 * pass just as well against a writable handle.
 *
 * Every claim about a file is read back from the FILE -- through a fresh connection, or from the
 * directory listing -- rather than inferred from a call returning. `openStore` can be handed the
 * wrong flags and still return a perfectly usable handle, so "it did not throw" is not evidence
 * that nothing was written.
 *
 * Fixtures go through `recordEntry`, the one write path, rather than through a hand-written INSERT.
 * A hand-built row would duplicate the column list, and a schema change would then leave these
 * tests failing for a reason that has nothing to do with read-only connections.
 *
 * Error classes are asserted by TYPE and by the fields they carry, not by message text: messages
 * are for a person, and a test matching a phrase breaks when the phrasing improves.
 */

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-readonly-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const AT = '2026-09-12T09:00:00.000Z';

const SPEC: TypeSpec = {
  name: 'probe',
  properties: [{ name: 'note', type: 'text' }],
};

/**
 * A migrated store in its own directory, holding `count` recorded entries.
 *
 * The returned path is the PROJECT directory, and the store's `dir` is the `.ascend` inside it --
 * `openStore` takes the store's own directory, and `openProject` is what joins `STORE_DIR` on. The
 * distinction is the whole reason `storeFile` exists below rather than being written at each call.
 */
function populated(count = 0): string {
  const dir = scratch();
  const store = openStore({ dir: join(dir, STORE_DIR), ascendVersion: 'test' });
  registerType(store.db, SPEC, { registeredAt: AT });
  for (let index = 0; index < count; index++) {
    recordEntry(
      store.db,
      { type: 'probe', properties: { note: `kept-${String(index)}` } },
      { id: `e${String(index)}`, recordedAt: AT, ascendVersion: 'test' },
    );
  }
  store.close();
  return dir;
}

const storeDir = (project: string): string => join(project, STORE_DIR);

const storeFile = (project: string): string => join(storeDir(project), STORE_FILE);

/**
 * Read one row from the file through a connection that is not the one under test.
 *
 * `Record<string, unknown>` rather than a type parameter: the column wanted differs per call site,
 * and a generic appearing once per signature buys nothing (`no-unnecessary-type-parameters` says so,
 * correctly). Assertions below read the field and check it, which is the whole job.
 */
function readFromFile(file: string, sql: string): Record<string, unknown> {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare(sql).get() as Record<string, unknown>;
  db.close();
  return row;
}

/** A fresh connection's view of one entry's `evidence_text`, which no fixture ever sets. */
const evidenceIn = (file: string): unknown =>
  readFromFile(file, 'SELECT evidence_text FROM entries LIMIT 1')['evidence_text'];

/** The message from a call that must throw -- or the absence of one, reported rather than hidden. */
const refusalOf = (body: () => unknown): string => {
  try {
    body();
  } catch (error) {
    // Read as a property rather than assumed to be an Error: something other than an Error being
    // thrown is a real (and reportable) outcome, and a helper that crashed on it would hide that.
    return (error as { message?: string } | null)?.message ?? `(threw ${typeof error})`;
  }
  return '(no throw)';
};

/** Run `body` and hand back whatever it threw, so a test can assert on the error itself. */
const capture = (body: () => unknown): unknown => {
  try {
    body();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('opening a store read-only', () => {
  it('refuses a write, so the handle cannot mutate the file', () => {
    const dir = populated(1);
    const store = openStore({ dir: storeDir(dir), readOnly: true });

    const message = refusalOf(() => {
      store.db.exec("UPDATE entries SET evidence_text = 'changed'");
    });
    store.close();

    expect(message).toContain('readonly');
    // Read back through a SECOND connection: the point is that the file is unchanged, not that the
    // handle reported an error.
    expect(evidenceIn(storeFile(dir))).toBeNull();
  });

  it('does not create the directory it was pointed at', () => {
    const parent = scratch();
    const missing = join(parent, 'not-created');

    expect(
      refusalOf(() => {
        openStore({ dir: missing, readOnly: true }).close();
      }),
    ).not.toBe('(no throw)');
    // The refusal itself is allowed to be an unhelpful "unable to open database file"; what is
    // asserted is the ABSENCE. A mistyped `--across` path that left a directory behind would be
    // found by the next glob the caller ran, and read as a project with no entries.
    expect(readdirSync(parent)).toEqual([]);
  });

  it('does not record the ascend version, because that row is a write', () => {
    const dir = populated();
    const before = readFromFile(
      storeFile(dir),
      "SELECT value FROM meta WHERE key = 'created_by_ascend_version'",
    )['value'];

    const store = openStore({
      dir: storeDir(dir),
      readOnly: true,
      ascendVersion: 'should-not-appear',
    });
    const after = store.db
      .prepare("SELECT value FROM meta WHERE key = 'created_by_ascend_version'")
      .get() as { value: string };
    store.close();

    // Asserted against the ORIGINAL, not merely against "something is there": the writable open
    // already inserted a row, so a read-only open that overwrote it would pass a weaker check.
    expect(before).toBe('test');
    expect(after.value).toBe('test');
  });

  it('reads a WAL store a writable open already created, and still verifies its pragmas', () => {
    const dir = populated(1);
    // `openStore` throws `PragmaError` from `verifyPragmas` if the read-back does not hold, so
    // reaching these assertions proves the WAL check passed on a handle that never SET the pragma.
    const store = openStore({ dir: storeDir(dir), readOnly: true });
    const journal = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const version = userVersion(store.db);
    store.close();

    expect(journal.journal_mode.toLowerCase()).toBe('wal');
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('refuses a store that is behind this build, and names the command that fixes it', () => {
    const dir = populated();
    // Back to an unmigrated file, so the read-only open finds a store with no tables.
    const raw = new DatabaseSync(storeFile(dir));
    raw.exec('PRAGMA user_version = 0');
    raw.close();

    const thrown = capture(() => openStore({ dir: storeDir(dir), readOnly: true }));

    expect(thrown).toBeInstanceOf(StaleStoreError);
    const stale = thrown as StaleStoreError;
    expect(stale.storeVersion).toBe(0);
    expect(stale.buildVersion).toBe(SCHEMA_VERSION);
    expect(stale.file).toBe(storeFile(dir));
    // The fix is a DIFFERENT command rather than a newer ascend, which is why this is deliberately
    // not a `NewerSchemaError`. Asserted, because sending the user to upgrade would waste their time.
    expect(stale.message).toContain('asc init');
  });

  it('refuses a store that is AHEAD this build, which is the guard migrate used to own', () => {
    // asc-bcv.9 (B5). The ahead check lived at the top of `migrate`, so the read-only path -- which
    // skips `migrate` -- skipped the refusal too, and this is the path `asc query` uses. Driven
    // through the real CLI in the report's evidence: exit 0 against a v99 store, printing `0`.
    const dir = populated();
    const raw = new DatabaseSync(storeFile(dir));
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const thrown = capture(() => openStore({ dir: storeDir(dir), readOnly: true }));

    expect(thrown).toBeInstanceOf(NewerSchemaError);
    const newer = thrown as NewerSchemaError;
    expect(newer.storeVersion).toBe(99);
    expect(newer.buildVersion).toBe(SCHEMA_VERSION);
    // And it names the fix, which for a store from the future is a NEWER ascend -- the opposite
    // advice to `StaleStoreError`'s, and the reason the two are different classes.
    expect(newer.message).toContain('Upgrade ascend');
  });

  it('refuses an ahead store when the open merely declines to migrate, which is a third path', () => {
    // The arm the bead did not name, found by asking what ELSE skips `migrate` (/tmp/probe-b5.mjs).
    // `asc init --dry-run` against an existing store opens exactly like this, so the guard has to
    // sit outside `migrate` rather than being repeated at each skip site.
    const dir = populated();
    const raw = new DatabaseSync(storeFile(dir));
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const thrown = capture(() => openStore({ dir: storeDir(dir), migrate: false }));

    expect(thrown).toBeInstanceOf(NewerSchemaError);
    expect((thrown as NewerSchemaError).storeVersion).toBe(99);
  });

  it('does not call an in-memory store stale, because it has no history to be behind', () => {
    const store = openStore({ dir: ':memory:', readOnly: true });
    // `no such table` is the CORRECT answer to a query against an empty in-memory store: it proves
    // the open succeeded and that nothing was migrated into it on the way.
    const message = refusalOf(() => store.db.prepare('SELECT count(*) FROM entries').get());
    store.close();

    expect(message).toContain('no such table');
  });

  it('still refuses writes when the store is in memory', () => {
    const store = openStore({ dir: ':memory:', readOnly: true });
    const message = refusalOf(() => {
      store.db.exec('CREATE TABLE t (x)');
    });
    store.close();

    expect(message).toContain('readonly');
  });
});

describe('attaching another project', () => {
  it('refuses a path with no file, before anything is attached', () => {
    const dir = populated(1);
    const store = openStore({ dir: storeDir(dir), readOnly: true });
    const absent = join(scratch(), 'nope', STORE_DIR, STORE_FILE);

    const thrown = capture(() => attachStore(store.db, { label: 'nope', file: absent }, 'nope'));
    const names = [...databaseNames(store.db)];
    store.close();

    expect(thrown).toBeInstanceOf(NotAnAscendStoreError);
    // Nothing was attached, so a caller's SQL cannot silently read the empty database SQLite would
    // have created at that path. The two names that are listed are the ones every connection answers
    // to whatever is attached -- `temp` included, which is why this is not `['main']`: it was, until
    // a project directory named `temp` was handed the alias `temp` and SQLite refused the ATTACH
    // (`PRAGMA database_list` does not report `temp`, but SQLite reserves the name anyway).
    expect(names).toEqual(['main', 'temp']);
  });

  it('attaches under the name the caller chose and reports the resolved path', () => {
    const local = populated(1);
    const other = populated(2);
    const store = openStore({ dir: storeDir(local), readOnly: true });

    const attachment = attachStore(store.db, { label: other, file: storeFile(other) }, 'neighbour');
    const count = store.db.prepare('SELECT count(*) AS n FROM neighbour.entries').get() as {
      n: number;
    };
    const names = [...databaseNames(store.db)];
    detachStore(store.db, 'neighbour');
    const after = [...databaseNames(store.db)];
    store.close();

    // The resolved path, not the one passed in -- and on macOS those differ, because `tmpdir()` is a
    // symlink under `/var` pointing at `/private/var`. That difference is the FEATURE: it is what
    // makes two spellings of one store recognisable as one store, so the assertion expects the
    // resolved form rather than the argument. On a filesystem with no symlinks the two coincide and
    // this still holds, which is why the test does not branch on the platform.
    expect(attachment).toEqual({
      label: other,
      alias: 'neighbour',
      file: realpathSync(storeFile(other)),
    });
    expect(count.n).toBe(2);
    expect(names).toEqual(['main', 'neighbour', 'temp']);
    // Detached, so the alias is gone and the reserved names are what is left.
    expect(after).toEqual(['main', 'temp']);
  });

  it('refuses a name the connection already answers to', () => {
    const dir = populated();
    const store = openStore({ dir: storeDir(dir), readOnly: true });
    const source = { label: dir, file: storeFile(dir) };
    attachStore(store.db, source, 'twice');

    const repeated = capture(() => attachStore(store.db, source, 'twice'));
    // Also refused for `main`, which the caller never attached but the connection already has --
    // so a shadowed name is caught before the caller's SQL can read someone else's project.
    const shadowing = capture(() => attachStore(store.db, source, 'main'));
    detachStore(store.db, 'twice');
    store.close();

    expect(repeated).toBeInstanceOf(AliasInUseError);
    expect((repeated as AliasInUseError).alias).toBe('twice');
    expect(shadowing).toBeInstanceOf(AliasInUseError);
  });

  it('refuses every spelling of `temp`, which the pragma never reports', () => {
    // The defect this pins, measured first at the driver: a fresh connection's `PRAGMA database_list`
    // reports `main` alone, yet `ATTACH ... AS temp` is refused with `database temp is already in
    // use` -- SQLite reserves `temp` whether or not anything has been created there. So a guard built
    // on the pragma alone let `temp` through, and `asc query --across` on a directory named `temp`
    // died with that raw driver message instead of attaching the project.
    const dir = populated();
    const store = openStore({ dir: storeDir(dir), readOnly: true });
    const source = { label: dir, file: storeFile(dir) };

    const refused = ['temp', 'Temp', 'TEMP'].map((alias) =>
      capture(() => attachStore(store.db, source, alias)),
    );
    store.close();

    for (const thrown of refused) expect(thrown).toBeInstanceOf(AliasInUseError);
  });

  it('folds case when it decides a name is taken, the way SQLite does', () => {
    // SQLite compares database names with `sqlite3_stricmp`, which folds ASCII letters only --
    // measured: with only `main` present, `AS Main` and `AS MAIN` are both refused. A case-sensitive
    // JavaScript guard misses that, so the mismatch surfaces as SQLite's own message rather than as
    // the `AliasInUseError` that names the project and the alias.
    const dir = populated();
    const store = openStore({ dir: storeDir(dir), readOnly: true });
    const source = { label: dir, file: storeFile(dir) };
    attachStore(store.db, source, 'Neighbour');

    const shadowing = capture(() => attachStore(store.db, source, 'neighbour'));
    const reserved = capture(() => attachStore(store.db, source, 'MAIN'));
    detachStore(store.db, 'Neighbour');
    store.close();

    expect(shadowing).toBeInstanceOf(AliasInUseError);
    expect(reserved).toBeInstanceOf(AliasInUseError);
  });

  it('folds the same way for every name, so the two guards cannot disagree', () => {
    // `foldDatabaseName` is exported for `asc query --across`, which keeps its own set of names to
    // allocate from. If it folded differently from `attachStore`, the CLI would hand out a name this
    // function then refuses -- a correct refusal for a name the CLI should never have chosen.
    expect(foldDatabaseName('Temp')).toBe(foldDatabaseName('temp'));
    expect(foldDatabaseName('main')).toBe('main');
    // and it is idempotent, so folding a name that came out of `databaseNames` changes nothing
    expect(foldDatabaseName(foldDatabaseName('MaIn'))).toBe(foldDatabaseName('MaIn'));
  });

  it('cannot write to the attached project either', () => {
    const local = populated(0);
    const other = populated(1);
    const store = openStore({ dir: storeDir(local), readOnly: true });
    attachStore(store.db, { label: other, file: storeFile(other) }, 'neighbour');

    const message = refusalOf(() => {
      store.db.exec('DELETE FROM neighbour.entries');
    });
    store.close();

    expect(message).toContain('readonly');
    const surviving = readFromFile(storeFile(other), 'SELECT count(*) AS n FROM entries');
    expect(surviving['n']).toBe(1);
  });
});
