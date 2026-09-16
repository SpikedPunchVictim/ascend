import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ForeignStoreError, STORE_FILE, StaleStoreError, openStore } from '../src/index.js';

/**
 * asc-63v: a file ascend did not create is not silently adopted and migrated.
 *
 * Measured before the fix, by driving the real binary: put any SQLite file at
 * `<proj>/.ascend/ascend.db`, run `asc types list`, and it exited **0**, printed an empty table, and
 * left the file carrying ascend's full schema alongside the caller's. A read-shaped command wrote
 * DDL into a file ascend had never seen, and said nothing.
 *
 * **The assertion that matters most here is that the file is UNCHANGED**, and it is checked against
 * the bytes rather than against a verdict from the code under test. A refusal that still wrote would
 * pass every message assertion in this file, and the harm the bead reports is the write -- so the
 * byte comparison is the one that would have caught it.
 *
 * These drive `openStore` directly rather than through the CLI because the guard is in the store's
 * open path and every command inherits it; `foreign-cli.test.ts` drives the real binary to prove the
 * commands actually reach it.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-foreign-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A project directory holding a store file ascend did not create, with the named tables in it. */
const foreign = (...tables: readonly string[]): { readonly dir: string; readonly file: string } => {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, STORE_FILE);
  const db = new DatabaseSync(file);
  try {
    for (const table of tables) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  } finally {
    db.close();
  }
  return { dir, file };
};

/** The tables SQLite reports for a file, read through a connection that is not `openStore`'s. */
const tablesIn = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as unknown as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
};

const versionOf = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

/** The thrown error from an open that was expected to refuse, so the caller can inspect it. */
const refusal = (open: () => unknown): Error => {
  try {
    open();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the open was expected to refuse and did not');
};

describe('a file ascend did not create is refused, not adopted', () => {
  it('refuses a database holding the caller’s own tables', () => {
    const { dir } = foreign('mine');

    const error = refusal(() => openStore({ dir }));

    expect(error).toBeInstanceOf(ForeignStoreError);
    // Context: which file, named as the caller would recognise it.
    expect(error.message).toContain(STORE_FILE);
    // Problem: what is in it, and that it is not ascend's.
    expect(error.message).toContain('not an ascend store');
    expect(error.message).toContain('mine');
    // Fix: a next step.
    expect(error.message).toMatch(/Move that file aside/);
    expect(error.message).toContain('asc init');
  });

  it('leaves the refused file exactly as it was, which is the harm the bead reports', () => {
    // The whole point. A message assertion above would pass on an implementation that refused AND
    // migrated -- and migrating is what the bead measured: `asc types list` exited 0 leaving the
    // foreign file carrying entries, entry_types, the FTS index and ascend's views.
    const { dir, file } = foreign('mine', 'other');
    const before = readFileSync(file);
    const sizeBefore = statSync(file).size;

    refusal(() => openStore({ dir }));

    expect(tablesIn(file)).toEqual(['mine', 'other']);
    expect(versionOf(file)).toBe(0);
    expect(statSync(file).size).toBe(sizeBefore);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses on a read-only open too, with the foreign message rather than the stale one', () => {
    // The worst arm before the fix. A read-only open skips migration, so a foreign file reached
    // `StaleStoreError` -- which tells the caller ascend expects a newer schema and to run another
    // command to bring it up to date. That is a false statement about a file no ascend ever wrote,
    // and it is the message `asc query` would have shown.
    const { dir } = foreign('mine');

    const error = refusal(() => openStore({ dir, readOnly: true }));

    expect(error).toBeInstanceOf(ForeignStoreError);
    expect(error).not.toBeInstanceOf(StaleStoreError);
    expect(error.message).not.toMatch(/expects|up to date/);
  });

  it('refuses on a migrate:false open too, so a dry run cannot report it as usable', () => {
    // `asc init --dry-run` over an existing store opens exactly this way (init.ts). A guard that
    // skipped this path would let the dry run report a plan for adopting someone else's file.
    const { dir } = foreign('mine');

    expect(() => openStore({ dir, migrate: false })).toThrow(ForeignStoreError);
  });

  it('refuses a file from the future as foreign, because no ascend wrote it', () => {
    // Ordering, asserted rather than commented. Both guards could claim this file, and the other
    // one's message says a NEWER ASCEND WROTE THIS STORE -- which for a foreign file is simply
    // false. The more fundamental fact is that the file is not ascend's, so it speaks first.
    const { dir, file } = foreign('mine');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();

    const error = refusal(() => openStore({ dir }));

    expect(error).toBeInstanceOf(ForeignStoreError);
    expect(error).not.toBeInstanceOf(StaleStoreError);
  });

  it('still refuses a genuine store from the future as a store from the future', () => {
    // The refutation of the ordering above: moving the foreign check first must not swallow the
    // case `assertNotAhead` exists for. A REAL ascend store at 99 carries the marker, so it passes
    // the foreign check and meets the version guard exactly as before.
    const dir = tempDir();
    const store = openStore({ dir });
    store.close();
    const db = new DatabaseSync(join(dir, STORE_FILE));
    db.exec('PRAGMA user_version = 99');
    db.close();

    const error = refusal(() => openStore({ dir }));

    expect(error).not.toBeInstanceOf(ForeignStoreError);
    expect(error.message).toContain('99');
  });

  it('refuses a file that has one of ascend’s table names but not the others', () => {
    // Why the marker is three names and not one. `meta` on its own is a name plenty of applications
    // use, and a file that happened to have one would be adopted -- the same defect, narrower. This
    // file is the case that a single-name marker would wave through.
    const { dir } = foreign('meta');

    expect(() => openStore({ dir })).toThrow(ForeignStoreError);
  });

  it('does not count SQLite’s own bookkeeping as the caller’s tables', () => {
    // `AUTOINCREMENT` makes SQLite create `sqlite_sequence`, which lives in `sqlite_master` like any
    // other table. Counting it would put a name the caller never wrote into their own message --
    // "it holds 1 table(s) of its own (sqlite_sequence)" -- and would make a number they can check
    // against their own file wrong.
    const dir = tempDir();
    const file = join(dir, STORE_FILE);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE mine (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    db.close();
    // The bookkeeping table is really there, so the filter is asserted against a file that has one
    // rather than against a fixture that assumes it.
    expect(tablesIn(file)).toContain('sqlite_sequence');

    const error = refusal(() => openStore({ dir }));

    expect(error.message).toContain('1 table(s)');
    expect(error.message).toContain('mine');
    expect(error.message).not.toContain('sqlite_sequence');
  });

  it('caps how many of the file’s tables it names', () => {
    // A file with two hundred tables must not put all of them in one message. Enough to recognise
    // the file, not an inventory of it.
    const { dir } = foreign('a', 'b', 'c', 'd', 'e');

    const error = refusal(() => openStore({ dir }));

    expect(error.message).toContain('5 table(s)');
    expect(error.message).toContain('and 2 more');
  });
});

describe('what the guard must NOT refuse', () => {
  it('opens a path that does not exist yet, and creates the store there', () => {
    // The ordinary first open, which every `asc init` takes. The guard reads what the file
    // CONTAINS rather than whether it exists, so this is the case that proves it is not an
    // over-broad "the file was already there" check.
    const dir = tempDir();

    const store = openStore({ dir });

    expect(existsSync(join(dir, STORE_FILE))).toBe(true);
    expect(tablesIn(join(dir, STORE_FILE))).toContain('entries');
    store.close();
  });

  it('opens a file that exists and is empty', () => {
    // A zero-byte file reports no tables, which is indistinguishable from a fresh one -- and there
    // is nothing in it to protect, so it is adopted. Stated in `db.ts` as a limitation rather than
    // papered over.
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, STORE_FILE);
    const empty = new DatabaseSync(file);
    empty.close();

    const store = openStore({ dir });

    expect(tablesIn(file)).toContain('entries');
    store.close();
  });

  it('reopens a store ascend created, which is every ordinary second command', () => {
    const dir = tempDir();
    openStore({ dir }).close();

    const store = openStore({ dir });

    expect(tablesIn(join(dir, STORE_FILE))).toContain('entries');
    store.close();
  });

  it('opens and reopens a store read-only', () => {
    const dir = tempDir();
    openStore({ dir }).close();

    const store = openStore({ dir, readOnly: true });

    expect(store.file).toBe(join(dir, STORE_FILE));
    store.close();
  });

  it('does not apply to an in-memory store, which has no file to protect', () => {
    // Read through the store's OWN handle, not through `tablesIn(store.file)`: `store.file` is
    // `:memory:`, and a second `new DatabaseSync(':memory:')` is a different empty database rather
    // than a second view of this one. Asserting through a fresh connection here would be asserting
    // on nothing.
    const store = openStore({ dir: ':memory:' });

    const found = (
      store.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'`)
        .all() as unknown as { name: string }[]
    ).map((row) => row.name);
    expect(found).toEqual(['entries']);
    store.close();
  });

  it('opens a store that has something extra in it alongside ascend’s tables', () => {
    // The marker is "has ascend's tables", not "has ONLY ascend's tables". A caller who adds their
    // own table to a store they own is not the case this guard is about, and refusing them would
    // be the guard reaching past its purpose.
    const dir = tempDir();
    openStore({ dir }).close();
    const db = new DatabaseSync(join(dir, STORE_FILE));
    db.exec('CREATE TABLE mine (id INTEGER PRIMARY KEY)');
    db.close();

    const store = openStore({ dir });

    expect(tablesIn(join(dir, STORE_FILE))).toContain('mine');
    store.close();
  });
});
