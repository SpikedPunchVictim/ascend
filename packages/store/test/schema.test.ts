import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HIGHEST_MARKED_VERSION,
  LedgerMismatchError,
  MIGRATIONS,
  NewerSchemaError,
  PragmaError,
  SCHEMA_VERSION,
  StaleStoreError,
  STORE_FILE,
  migrate,
  openStore,
  userVersion,
  verifyPragmas,
  viewName,
  type Migration,
} from '../src/index.js';

/**
 * These run against a REAL file store rather than `:memory:`, because the two
 * guarantees the store rests on -- WAL and the composite foreign key -- do not exist
 * in memory. Testing the pragmas against an in-memory database would prove nothing
 * about the thing that ships.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-store-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  // Literal paths, listed -- not a glob over a shared temp directory.
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A registered definition, so entries have something legal to reference. */
const register = (db: DatabaseSync, version = 1, hash = 'hash_v1'): void => {
  db.prepare(
    `INSERT INTO entry_types (name, version, major, type_hash, spec_json, created_at)
     VALUES ('review_completed', ?, 1, ?, '{"name":"review_completed","properties":[]}', '2026-09-11T10:00:00Z')`,
  ).run(version, hash);
};

const insertEntry = (db: DatabaseSync, id: string, version = 1, hash = 'hash_v1'): void => {
  db.prepare(
    `INSERT INTO entries (id, type_name, type_version, type_hash, recorded_at, source, ascend_version, schema_version)
     VALUES (?, 'review_completed', ?, ?, '2026-09-11T10:00:00Z', 'self', '0.0.0', 1)`,
  ).run(id, version, hash);
};

describe('migration', () => {
  it('creates the schema and records its version', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(userVersion(store.db)).toBe(SCHEMA_VERSION);
      expect(store.migrations.from).toBe(0);
      expect(store.migrations.applied).toEqual(MIGRATIONS.map((m) => m.name));
    } finally {
      store.close();
    }
  });

  it('is idempotent -- reopening applies nothing', () => {
    const dir = tempDir();
    const first = openStore({ dir });
    first.close();

    const second = openStore({ dir });
    try {
      expect(second.migrations.applied).toEqual([]);
      expect(second.migrations.from).toBe(SCHEMA_VERSION);
      expect(userVersion(second.db)).toBe(SCHEMA_VERSION);
    } finally {
      second.close();
    }
  });

  it('rolls back a failing migration completely, leaving the version untouched', () => {
    // The atomicity claim, tested rather than asserted: a half-applied migration
    // would leave a store that neither version describes.
    const db = new DatabaseSync(':memory:');
    const broken: Migration[] = [
      MIGRATIONS[0] as Migration,
      {
        version: 2,
        name: 'deliberately broken',
        sql: 'CREATE TABLE half_applied (x TEXT); THIS IS NOT SQL;',
        marker: 'half_applied',
      },
    ];

    expect(() => migrate(db, broken)).toThrow(/migration 2 .* rolled back/);
    expect(userVersion(db)).toBe(1);

    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_applied'").get();
    expect(leftover).toBeUndefined();
    db.close();
  });

  it('reports the migration error, not a rollback error, when the failure already closed the transaction (asc-k3b)', () => {
    // Measured directly against node:sqlite (':memory:', BEGIN IMMEDIATE then
    // `db.exec('ROLLBACK; SELECT no_such_column;')`): the ROLLBACK statement ends the
    // transaction, the next statement in the same `exec` then fails, and `db.isTransaction`
    // is already `false` by the time the catch runs. A migration whose SQL runs ROLLBACK
    // itself before failing reproduces exactly that sequence, and is the only way to end the
    // transaction from inside a single `db.exec(migration.sql)` call.
    //
    // Before this fix, `migrate`'s catch issued ROLLBACK unconditionally and node:sqlite threw
    // 'cannot rollback - no transaction is active' -- which propagated INSTEAD of the migration
    // error below, so the operator saw a transaction-state message with no mention of
    // `no_such_column` at all.
    const db = new DatabaseSync(':memory:');
    const broken: Migration[] = [
      MIGRATIONS[0] as Migration,
      {
        version: 2,
        name: 'closes its own transaction before failing',
        sql: 'ROLLBACK; SELECT no_such_column;',
        marker: 'never_created',
      },
    ];

    expect(() => migrate(db, broken)).toThrow(/migration 2 .* no_such_column/);
    // And not the masking error the unconditional ROLLBACK used to produce.
    expect(() => migrate(db, broken)).not.toThrow(/no transaction is active/);
    db.close();
  });

  it('refuses with a repair command instead of failing on the DDL when the ledger is reset (asc-u11)', () => {
    // The bead's own reproduction: a store whose user_version was reset to 0 by something other
    // than ascend (a backup that did not carry the pragma, a copy that rewrote the header). Before
    // this fix, the file was permanently unopenable -- migrate would run migration 1's DDL against
    // tables that already exist, fail with SQLite's own "entry_types already exists", and every
    // later command would hit the exact same failure because nothing about running it again
    // changes the wrong ledger.
    const dir = tempDir();
    const store = openStore({ dir });
    register(store.db);
    insertEntry(store.db, 'e1');
    store.db.exec('PRAGMA user_version = 0');
    store.close();

    let caught: unknown;
    try {
      openStore({ dir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LedgerMismatchError);
    const err = caught as LedgerMismatchError;
    expect(err.ledgerVersion).toBe(0);
    // Not SCHEMA_VERSION: migration 3 is procedural and creates no sqlite_master name of its
    // own, so `inferAppliedVersion` cannot confirm it from content -- only the highest MARKED
    // (sql) migration is nameable here. See `HIGHEST_MARKED_VERSION`'s doc.
    expect(err.inferredVersion).toBe(HIGHEST_MARKED_VERSION);
    const dbFile = join(dir, STORE_FILE);
    expect(err.message).toContain(dbFile);
    expect(err.message).toContain(`PRAGMA user_version = ${String(HIGHEST_MARKED_VERSION)}`);

    // The refusal touched nothing: the file's content and its (wrong) ledger are exactly as they
    // were before the failed open -- not a "fix" of its own, and not further damage either.
    const verify = new DatabaseSync(dbFile);
    try {
      expect(userVersion(verify)).toBe(0);
      expect(verify.prepare('SELECT COUNT(*) AS n FROM entries').get()?.['n']).toBe(1);
    } finally {
      verify.close();
    }

    // The repair path this error names, run literally: one PRAGMA write, through a tool ascend
    // never invokes on the operator's behalf, so it cannot happen except on purpose.
    const repair = new DatabaseSync(dbFile);
    repair.exec(`PRAGMA user_version = ${String(HIGHEST_MARKED_VERSION)}`);
    repair.close();

    const repaired = openStore({ dir });
    try {
      // The repair set the ledger to the highest CONFIRMABLE version, not to SCHEMA_VERSION, so
      // reopening still has real work left: every migration after HIGHEST_MARKED_VERSION is
      // procedural and idempotent, so re-running it here is harmless -- this is the "gap closes
      // itself" `LedgerMismatchError` documents, exercised rather than assumed.
      expect(repaired.migrations.applied).toEqual(
        MIGRATIONS.filter((m) => m.version > HIGHEST_MARKED_VERSION).map((m) => m.name),
      );
      expect(userVersion(repaired.db)).toBe(SCHEMA_VERSION);
      expect(repaired.db.prepare("SELECT id FROM entries WHERE id = 'e1'").get()).toBeDefined();
    } finally {
      repaired.close();
    }
  });

  it('names the correct target when the ledger understates by more than one migration', () => {
    const dir = tempDir();
    const store = openStore({ dir });
    store.db.exec('PRAGMA user_version = 1');
    store.close();

    let caught: unknown;
    try {
      openStore({ dir });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LedgerMismatchError);
    const err = caught as LedgerMismatchError;
    expect(err.ledgerVersion).toBe(1);
    expect(err.inferredVersion).toBe(HIGHEST_MARKED_VERSION);
  });

  it('names the file in the repair command when migrate is given one, and a placeholder otherwise', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db, MIGRATIONS);
    db.exec('PRAGMA user_version = 0');

    expect(() => migrate(db, MIGRATIONS, '/example/project/.ascend/ascend.db')).toThrow(
      `sqlite3 /example/project/.ascend/ascend.db "PRAGMA user_version = ${String(HIGHEST_MARKED_VERSION)}"`,
    );
    expect(() => migrate(db, MIGRATIONS)).toThrow(/this store's database file/);
    db.close();
  });

  it('refuses to open a store written by a newer ascend', () => {
    // Opening it would mean operating on a schema this build does not understand --
    // and writing rows under it.
    const dir = tempDir();
    const store = openStore({ dir });
    store.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 5)}`);
    store.close();

    expect(() => openStore({ dir })).toThrow(NewerSchemaError);
  });

  it('refuses on its own, so a caller that reaches migrate without that open is still guarded', () => {
    // asc-bcv.9 (B5). `assertNotAhead` was extracted from this function so that the opens which SKIP
    // `migrate` -- read-only, and `migrate: false` -- are guarded too. That extraction quietly turned
    // this call site into a second line of defence the test above no longer reaches, because
    // `openStore` now refuses before `migrate` is entered. Without this test, deleting the call from
    // `migrate` would break nothing, and `openStore({ migrate: false })` hands a caller a handle they
    // can then migrate a store from the future with.
    const dir = tempDir();
    const store = openStore({ dir });
    store.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 5)}`);
    const db = store.db;

    expect(() => migrate(db, MIGRATIONS)).toThrow(NewerSchemaError);
    // And it refused rather than quietly succeeding: a store ahead of this build has no pending
    // migrations, so the unguarded path applies nothing and returns -- the failure mode that made
    // the CLI report `0` for a store it could not read.
    expect(userVersion(db)).toBe(SCHEMA_VERSION + 5);
    store.close();
  });

  it('leaves no open handle behind when a migration fails', () => {
    // A leaked handle would keep the file locked and make the failure confusing.
    const dir = tempDir();
    const store = openStore({ dir });
    store.close();
    expect(() => openStore({ dir })).not.toThrow();
  });
});

describe('migration 3 -- rebuilding stale per-type views (asc-5ed)', () => {
  /**
   * A store on disk at schema version 2 (migrations 1 and 2 only) with one registered type and a
   * hand-built view in the PRE-asc-88m shape -- no `invalidated` column. This is what asc-5ed
   * measured on every store that predates that column: `refreshTypeViews` only regenerates a
   * type's view at REGISTRATION time, so a type registered before the column existed keeps a view
   * that predates it, forever, with nothing to re-trigger a rebuild until this migration.
   *
   * The view body here is deliberately not the real one `refreshTypeViews` would have built --
   * only its ABSENCE of `invalidated` matters for this fixture, and building the real pre-88m
   * shape would mean vendoring an old version of the generator just to delete one line from it.
   */
  const buildPreMigration3Store = (dir: string): string => {
    const file = join(dir, STORE_FILE);
    const db = new DatabaseSync(file);
    try {
      // Bring the file to the schema version asc-88m's column landed into, before migration 3
      // (this fix) existed at all.
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version < 3),
        file,
      );

      db.exec(
        `INSERT INTO entry_types (name, version, major, type_hash, spec_json, created_at)
         VALUES ('review_completed', 1, 1, 'hash_v1', '{"name":"review_completed","properties":[]}', '2026-09-11T10:00:00Z')`,
      );

      db.exec(
        `CREATE VIEW ${viewName('review_completed', 1)} AS
           SELECT id, type_name, recorded_at FROM entries WHERE type_name = 'review_completed'`,
      );
    } finally {
      db.close();
    }

    // Normalize the file to WAL, the way every real store is (`openStore` always switches a
    // writable, on-disk store to WAL) -- `migrate: false` so this pass touches pragmas only and
    // leaves the version-2 content this fixture just built untouched.
    openStore({ dir, migrate: false }).close();

    return file;
  };

  it('a read-only open refuses a store still at schema version 2, naming the repair', () => {
    const dir = tempDir();
    buildPreMigration3Store(dir);

    let caught: unknown;
    try {
      openStore({ dir, readOnly: true });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleStoreError);
    const err = caught as StaleStoreError;
    expect(err.storeVersion).toBe(2);
    expect(err.buildVersion).toBe(SCHEMA_VERSION);
    expect(err.message).toContain(join(dir, STORE_FILE));

    // The refusal is real, not cosmetic: the file is untouched, still at version 2.
    const verify = new DatabaseSync(join(dir, STORE_FILE));
    try {
      expect(userVersion(verify)).toBe(2);
    } finally {
      verify.close();
    }
  });

  it('a writable open migrates the store and the view gains the invalidated column', () => {
    const dir = tempDir();
    buildPreMigration3Store(dir);

    // Before: the pre-asc-88m shape, queried the same way asc-5ed measured the real store --
    // the column is simply not there.
    const before = new DatabaseSync(join(dir, STORE_FILE));
    try {
      expect(() =>
        before.prepare(`SELECT invalidated FROM ${viewName('review_completed', 1)}`).all(),
      ).toThrow(/no such column: invalidated/);
    } finally {
      before.close();
    }

    const store = openStore({ dir });
    try {
      expect(store.migrations.applied).toContain(
        'rebuild per-type views to carry the invalidated column',
      );
      expect(userVersion(store.db)).toBe(SCHEMA_VERSION);

      // After: the same query that failed above now succeeds -- the column exists, and (nothing
      // in this fixture was ever invalidated) reads back NULL rather than throwing.
      const rows = store.db
        .prepare(`SELECT invalidated FROM ${viewName('review_completed', 1)}`)
        .all() as { invalidated: string | null }[];
      expect(rows).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('is a clean no-op on a store with zero registered types', () => {
    // Decision 6: a brand-new store migrating 1 -> 3 has no types in the registry at all -- the
    // ordinary case, since every store starts empty. `entry_types` here genuinely has zero rows,
    // unlike the fixture above.
    const dir = tempDir();
    const file = join(dir, STORE_FILE);
    const db = new DatabaseSync(file);
    try {
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version < 3),
        file,
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM entry_types').get()?.['n']).toBe(0);
    } finally {
      db.close();
    }

    let store: ReturnType<typeof openStore> | undefined;
    expect(() => {
      store = openStore({ dir });
    }).not.toThrow();
    if (store === undefined) throw new Error('expected openStore to have succeeded above');
    try {
      expect(userVersion(store.db)).toBe(SCHEMA_VERSION);
    } finally {
      store.close();
    }
  });

  it('is idempotent -- running the rebuild a second time, directly, changes nothing', () => {
    const dir = tempDir();
    buildPreMigration3Store(dir);

    const first = openStore({ dir });
    const firstDefinition = first.db
      .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(viewName('review_completed', 1)) as { sql: string };
    first.close();

    // The ordinary idempotency test above ('is idempotent -- reopening applies nothing') proves
    // `migrate` itself skips a current store. This proves the narrower claim asc-5ed needs:
    // forcing migration 3's own procedure to run a second time, directly, is harmless -- exactly
    // the property `ProceduralMigration`'s doc rests the missing `marker` check on.
    const migration3 = MIGRATIONS.find((m) => m.version === 3);
    // `typeof migration3.run === 'function'`, not `'run' in migration3`: both `Migration` arms
    // DECLARE a `run` key (`ProceduralMigration.run` on one side, `SqlMigration.run?: never` on
    // the other, added so the union rejects an object literal carrying both arms -- see
    // `Migration`'s own doc), so `in` sees the key on every member and does not narrow the union
    // at all. Checking the VALUE's type discriminates correctly, the same way `migrate` and
    // `inferAppliedVersion` (schema.ts) check `typeof migration.sql === 'string'` rather than
    // `'sql' in migration`.
    if (migration3 === undefined || typeof migration3.run !== 'function') {
      throw new Error('expected migration 3 to be a procedural migration');
    }

    const second = new DatabaseSync(join(dir, STORE_FILE));
    try {
      expect(() => {
        migration3.run(second);
      }).not.toThrow();

      const secondDefinition = second
        .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
        .get(viewName('review_completed', 1)) as { sql: string };
      expect(secondDefinition.sql).toBe(firstDefinition.sql);
    } finally {
      second.close();
    }
  });
});

describe('migration 4 -- ingest_cursor for incremental claude-code ingest (asc-4dm.4)', () => {
  /** A store on disk that has run migrations 1-3 only, i.e. one from before `ingest_cursor` existed. */
  const buildPreMigration4Store = (dir: string): string => {
    const file = join(dir, STORE_FILE);
    const db = new DatabaseSync(file);
    try {
      migrate(
        db,
        MIGRATIONS.filter((m) => m.version < 4),
        file,
      );
    } finally {
      db.close();
    }
    // Normalize to WAL like every real store, without touching the version-3 content just built.
    openStore({ dir, migrate: false }).close();
    return file;
  };

  it('FAILS without the migration: a version-3 store has no ingest_cursor table at all', () => {
    // This is the test that pins the defect this migration fixes -- run against the store as it
    // stood one migration earlier, it demonstrates the table genuinely does not exist yet, the
    // same shape as migration 3's own "before" assertion.
    const dir = tempDir();
    const file = buildPreMigration4Store(dir);

    const before = new DatabaseSync(file);
    try {
      expect(userVersion(before)).toBe(3);
      expect(() => before.prepare('SELECT * FROM ingest_cursor').all()).toThrow(
        /no such table: ingest_cursor/,
      );
    } finally {
      before.close();
    }
  });

  it('a writable open migrates the store and ingest_cursor becomes queryable', () => {
    const dir = tempDir();
    buildPreMigration4Store(dir);

    const store = openStore({ dir });
    try {
      expect(store.migrations.applied).toContain(
        'ingest cursor for incremental claude-code ingest (asc-4dm.4)',
      );
      expect(userVersion(store.db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

      // The same query that failed above now succeeds, and starts empty.
      expect(store.db.prepare('SELECT * FROM ingest_cursor').all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('is a clean no-op on a brand-new store: it is created empty, not backfilled from anything', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(userVersion(store.db)).toBe(SCHEMA_VERSION);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_cursor').get()?.['n']).toBe(0);
    } finally {
      store.close();
    }
  });

  it('enforces its own constraints: no empty path, no negative mtime_ms or size', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at) VALUES ('', 1, 1, '2026-09-22T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at) VALUES ('/a', -1, 1, '2026-09-22T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });
});

describe('the Migration union enforces "sql xor run" at compile time (asc-5ed)', () => {
  it('documents the compile-time assertion and how it is checked', () => {
    // `Migration` is `SqlMigration | ProceduralMigration`. Verified directly, not assumed, that a
    // bare two-interface union does NOT by itself reject an object carrying both arms:
    // TypeScript's excess-property check on a fresh object literal treats a property as "known"
    // -- and so exempt from the excess-property error -- as soon as it appears on ANY member of
    // the union. A standalone probe (`tsc --strict --noEmit`) confirmed
    // `{ version, name, sql, marker, run }` type-checked with NO error against a bare
    // `SqlMigration | ProceduralMigration`, because it satisfies `SqlMigration` structurally and
    // `run` is "known" (it belongs to the sibling member).
    //
    // That is why `SqlMigration` and `ProceduralMigration` (schema.ts) each also declare the
    // OTHER arm's fields as `?: never`. With those in place, the same literal fails: `run` is no
    // longer assignable to `run?: never`, and a `sql`-and-`marker`-only literal is no longer
    // assignable to `ProceduralMigration`'s `sql?: never; marker?: never`. That is what the
    // `@ts-expect-error` lines immediately below assert.
    //
    // Neither `tsc -b` nor `vitest run` checks this: `tsc -b` builds only `packages/*/src/**`
    // (this package's tsconfig `include` is `src/**/*.ts`), and Vitest transpiles test files with
    // esbuild without type-checking them at all -- a `@ts-expect-error` here is inert under
    // `vitest run` and would not fail the suite even if the assertion were wrong. The check that
    // actually exercises this file's types is `tsc -p tsconfig.eslint.json`, the types-only
    // project `pnpm typecheck` runs specifically to cover `packages/*/test/**` (see that file's
    // own doc comment). Run directly: `npx tsc -p tsconfig.eslint.json` -- a passing run means
    // every `@ts-expect-error` below found the error it expects, no more and no fewer.
    //
    // @ts-expect-error -- a Migration cannot carry both `sql` and `run`.
    const both: Migration = {
      version: 99,
      name: 'invalid: both arms',
      sql: 'SELECT 1',
      marker: 'm',
      run: () => {
        /* unreachable: this literal must not compile */
      },
    };
    // @ts-expect-error -- a Migration must carry one of `sql` or `run`; neither is not a Migration.
    const neither: Migration = { version: 99, name: 'invalid: neither arm' };

    // Used only so the unused-variable lint rule has nothing to flag; the two assignments above,
    // and whether `tsc` accepts or rejects them, are the entire assertion.
    expect([both, neither]).toHaveLength(2);
  });
});

describe('pragmas are verified, not assumed', () => {
  it('turns WAL on for a file-backed store', () => {
    const store = openStore({ dir: tempDir() });
    try {
      const row = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      // `-wal`/`-shm` files appearing alongside is the observable side effect.
      expect(row.journal_mode.toLowerCase()).toBe('wal');
    } finally {
      store.close();
    }
  });

  it('turns the foreign key constraint on', () => {
    const store = openStore({ dir: tempDir() });
    try {
      const row = store.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    } finally {
      store.close();
    }
  });

  it('SOUNDS THE ALARM when the foreign key pragma did not take', () => {
    // The failure path of the check itself. If this ever stops throwing, the store
    // has two silent-corruption modes and nothing would report either.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA recursive_triggers = ON');
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => {
      verifyPragmas(db, { inMemory: false, busyTimeoutMs: 0 });
    }).toThrow(PragmaError);
    db.close();
  });

  it('does not demand WAL of an in-memory store, where it cannot exist', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    // Journal mode here is 'memory'; failing on that would be a false alarm.
    expect(() => {
      verifyPragmas(db, { inMemory: true, busyTimeoutMs: 0 });
    }).not.toThrow();
    db.close();
  });

  it('SOUNDS THE ALARM when the busy timeout did not take', () => {
    // The third setting that fails silently, and the one that was missing until asc-51t.
    // A bare handle has a timeout of ZERO, so asking for 5000 must not read back as
    // anything else -- and a store that opened without its timeout refuses instantly
    // under contention instead of waiting, which is the whole defect.
    //
    // Every OTHER setting is satisfied first, so the alarm this asserts is the one it names. The
    // first version of this test left them at their defaults, and adding the fourth setting made it
    // fail on `recursive_triggers` instead -- a test that goes red for the wrong reason is one that
    // would hide the setting it is supposed to be watching.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = ON');
    expect(() => {
      verifyPragmas(db, { inMemory: true, busyTimeoutMs: 5000 });
    }).toThrow(/busy_timeout/);
    db.close();
  });

  it('SOUNDS THE ALARM when recursive triggers did not take, which is asc-byn', () => {
    // The fourth setting, and the only one whose absence is a HOLE in another guard rather than a
    // behaviour change: without it, `entries_cannot_be_deleted` silently does not fire for the DELETE
    // that `INSERT OR REPLACE` performs, so an entry can be rewritten while the immutability triggers
    // watch. Measured (`/tmp/probe-byn.mjs`): with the pragma off, REPLACE SUCCEEDED and an entry's
    // properties_json went ORIGINAL -> TAMPERED.
    //
    // So this is the check that has to be shown to fire, per this project's own rule -- a pragma
    // whose read-back cannot sound is indistinguishable from one that is not checked at all.
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA recursive_triggers = OFF');
    expect(() => {
      verifyPragmas(db, { inMemory: true, busyTimeoutMs: 0 });
    }).toThrow(/recursive_triggers/);
    db.close();
  });
});

describe('an entry cannot reference a definition that is not there', () => {
  it('accepts an entry whose name, version AND hash all match', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() => {
        insertEntry(store.db, 'e1');
      }).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('REJECTS an entry carrying the wrong type_hash', () => {
    // This is the schema-drift confound made impossible: a row cannot claim a definition
    // whose shape it does not have.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() => {
        insertEntry(store.db, 'e1', 1, 'a_different_hash');
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      store.close();
    }
  });

  it('rejects an entry naming a version that was never registered', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db, 1, 'hash_v1');
      expect(() => {
        insertEntry(store.db, 'e1', 2, 'hash_v1');
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      store.close();
    }
  });
});

describe('records are immutable', () => {
  it('refuses to UPDATE an entry', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      insertEntry(store.db, 'e1');
      expect(() =>
        store.db.prepare("UPDATE entries SET evidence_text = 'rewritten' WHERE id = 'e1'").run(),
      ).toThrow(/entries are immutable/);
    } finally {
      store.close();
    }
  });

  it('refuses to DELETE an entry', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      insertEntry(store.db, 'e1');
      expect(() => store.db.prepare("DELETE FROM entries WHERE id = 'e1'").run()).toThrow(
        /cannot be deleted/,
      );
    } finally {
      store.close();
    }
  });

  it('refuses INSERT OR REPLACE, which is the same rewrite wearing a different verb', () => {
    // asc-byn guard #1. The two tests above are what made this one easy to miss: they prove the
    // triggers work, and they are both bypassed by REPLACE. SQLite fires delete triggers for the
    // DELETE that REPLACE performs only when recursive triggers are ON, and they are OFF by default,
    // so `entries_cannot_be_deleted` stayed silent while the row was rewritten in place.
    //
    // Measured on a real store before the fix (`/tmp/probe-byn.mjs`): the statement SUCCEEDED, an
    // entry's `properties_json` went ORIGINAL -> TAMPERED, and `entries_fts` matched BOTH strings,
    // because the AFTER INSERT trigger appended without any delete trigger cleaning up after it.
    //
    // This test is the one that would go red if `PRAGMA recursive_triggers = ON` were dropped from
    // `openStore`, which is why it is written against the store's own handle rather than a
    // hand-opened one.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      insertEntry(store.db, 'e1');

      // The pragma itself, read back rather than assumed to have taken.
      // The result column is `recursive_triggers`, as with the pragma itself -- one of the few that
      // keeps its own name (`busy_timeout` is the exception, and it reports as `timeout`).
      expect(store.db.prepare('PRAGMA recursive_triggers').get()?.['recursive_triggers']).toBe(1);

      expect(() => {
        store.db.exec(`INSERT OR REPLACE INTO entries
          SELECT id, type_name, type_version, type_hash, recorded_at, run_id, workflow, actor, source,
                 cwd, repo, git_sha, branch, '{"verdict":"TAMPERED"}', na_json, 'TAMPERED EVIDENCE',
                 ascend_version, schema_version
          FROM entries WHERE id = 'e1'`);
      }).toThrow(/entries are immutable|cannot be deleted/);

      // And the row is untouched -- the refusal is not a partial write.
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE id = 'e1'").get()?.['n'],
      ).toBe(1);
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM entries_fts WHERE entries_fts MATCH 'TAMPERED'")
          .get()?.['n'],
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  it('refuses REPLACE INTO, the other spelling of the same statement', () => {
    // `REPLACE INTO entries ...` is `INSERT OR REPLACE` with the verb moved. Same implicit delete,
    // same requirement on recursive triggers -- checked separately because a guard that covers one
    // spelling and not the other is the shape of the scan this bead's second half was about.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      insertEntry(store.db, 'e1');
      expect(() => {
        store.db.exec(`REPLACE INTO entries
          SELECT id, type_name, type_version, type_hash, recorded_at, run_id, workflow, actor, source,
                 cwd, repo, git_sha, branch, '{"verdict":"TAMPERED"}', na_json, 'TAMPERED EVIDENCE',
                 ascend_version, schema_version
          FROM entries WHERE id = 'e1'`);
      }).toThrow(/entries are immutable|cannot be deleted/);
    } finally {
      store.close();
    }
  });

  it('refuses to change a registered definition', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() =>
        store.db
          .prepare("UPDATE entry_types SET type_hash = 'other' WHERE name = 'review_completed'")
          .run(),
      ).toThrow(/entry_types identity is immutable/);
      expect(() =>
        store.db
          .prepare("UPDATE entry_types SET spec_json = '{}' WHERE name = 'review_completed'")
          .run(),
      ).toThrow(/entry_types identity is immutable/);
      // Reordering the properties IS a spec_json change, and must be refused even
      // though it declares the same set: the canonical form is the identity, so a
      // different spelling is a different definition.
      expect(() =>
        store.db
          .prepare(
            `UPDATE entry_types SET spec_json = '{"properties":[],"name":"review_completed"}' WHERE name = 'review_completed'`,
          )
          .run(),
      ).toThrow(/entry_types identity is immutable/);
      // `major` is not part of type_hash, and is frozen anyway: it is the boundary a
      // generated view unions within, so moving it silently merges two incompatible
      // families or splits one. Found by the registry suite asserting it, not by
      // reading the schema -- the trigger's WHEN list had simply omitted the column.
      expect(() =>
        store.db.prepare("UPDATE entry_types SET major = 2 WHERE name = 'review_completed'").run(),
      ).toThrow(/entry_types identity is immutable/);
    } finally {
      store.close();
    }
  });

  it('allows status and prose to change, but nothing else', () => {
    // The whole table is not frozen. Retiring a type is a legitimate transition, and
    // so is improving the wording that tells a recorder when to record -- neither
    // changes the shape a stored value was validated against, so neither may
    // invalidate an entry or mint a version. Anything that DOES change the shape is
    // refused by the test above.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      store.db
        .prepare(
          `UPDATE entry_types
             SET status = 'deprecated',
                 description = 'a review finished',
                 record_when = 'when a code review completes'
           WHERE name = 'review_completed'`,
        )
        .run();
      const row = store.db
        .prepare(
          "SELECT status, description, record_when FROM entry_types WHERE name = 'review_completed'",
        )
        .get() as { status: string; description: string; record_when: string };
      expect(row.status).toBe('deprecated');
      expect(row.description).toBe('a review finished');
      expect(row.record_when).toBe('when a code review completes');
    } finally {
      store.close();
    }
  });

  it('keeps the identity columns intact through a prose edit', () => {
    // The point of allowing a prose update is that it is INVISIBLE to entries. If
    // the trigger let type_hash drift while permitting prose, every entry already
    // recorded under this version would fail its foreign key.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      const before = store.db
        .prepare("SELECT type_hash, spec_json FROM entry_types WHERE name = 'review_completed'")
        .get() as { type_hash: string; spec_json: string };

      store.db
        .prepare("UPDATE entry_types SET record_when = 'reworded' WHERE name = 'review_completed'")
        .run();

      const after = store.db
        .prepare("SELECT type_hash, spec_json FROM entry_types WHERE name = 'review_completed'")
        .get() as { type_hash: string; spec_json: string };
      expect(after.type_hash).toBe(before.type_hash);
      expect(after.spec_json).toBe(before.spec_json);

      // And an entry recorded before the edit still attaches.
      expect(() => {
        insertEntry(store.db, 'e1');
      }).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('refuses to delete a registered definition', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() =>
        store.db.prepare("DELETE FROM entry_types WHERE name = 'review_completed'").run(),
      ).toThrow(/cannot be deleted/);
    } finally {
      store.close();
    }
  });
});

describe('no empty-string sentinels', () => {
  it('rejects an empty string where unknown should be NULL', () => {
    // SQLite treats '' as a real value, so it compares, matches and joins as though
    // it meant something. The trap this schema is written to avoid.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      for (const column of [
        'run_id',
        'cwd',
        'repo',
        'git_sha',
        'branch',
        'evidence_text',
        'actor',
      ]) {
        expect(
          () =>
            store.db
              .prepare(
                `INSERT INTO entries (id, type_name, type_version, type_hash, recorded_at, source, ascend_version, schema_version, ${column})
                 VALUES (?, 'review_completed', 1, 'hash_v1', '2026-09-11T10:00:00Z', 'self', '0.0.0', 1, '')`,
              )
              .run(`e_${column}`),
          `${column} should reject ''`,
        ).toThrow(/CHECK constraint failed/);
      }
    } finally {
      store.close();
    }
  });

  it('accepts NULL for the same columns', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() => {
        insertEntry(store.db, 'e1');
      }).not.toThrow();
      const row = store.db.prepare("SELECT run_id, cwd FROM entries WHERE id = 'e1'").get() as {
        run_id: string | null;
        cwd: string | null;
      };
      expect(row.run_id).toBeNull();
      expect(row.cwd).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('the three-state columns are JSON of the right shape', () => {
  it('rejects malformed JSON', () => {
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO entries (id, type_name, type_version, type_hash, recorded_at, source, ascend_version, schema_version, properties_json)
             VALUES ('e1','review_completed',1,'hash_v1','2026-09-11T10:00:00Z','self','0.0.0',1,'{not json')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it('rejects an array where the properties OBJECT belongs, and vice versa', () => {
    // Swapping the two would put a measured value where N/A is read from, which is
    // the three-state confusion the product exists to remove.
    const store = openStore({ dir: tempDir() });
    try {
      register(store.db);
      const bad = (properties: string, na: string): unknown =>
        store.db
          .prepare(
            `INSERT INTO entries (id, type_name, type_version, type_hash, recorded_at, source, ascend_version, schema_version, properties_json, na_json)
             VALUES ('e1','review_completed',1,'hash_v1','2026-09-11T10:00:00Z','self','0.0.0',1,?,?)`,
          )
          .run(properties, na);

      expect(() => bad('[]', '[]')).toThrow(/CHECK constraint failed/);
      expect(() => bad('{}', '{}')).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });
});

describe('the store directory', () => {
  it('is created when it does not exist', () => {
    const dir = join(tempDir(), 'nested', 'deeper');
    const store = openStore({ dir });
    try {
      expect(statSync(dir).isDirectory()).toBe(true);
    } finally {
      store.close();
    }
  });
});
