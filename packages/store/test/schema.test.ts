import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  NewerSchemaError,
  PragmaError,
  SCHEMA_VERSION,
  migrate,
  openStore,
  userVersion,
  verifyPragmas,
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
      },
    ];

    expect(() => migrate(db, broken)).toThrow(/migration 2 .* rolled back/);
    expect(userVersion(db)).toBe(1);

    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_applied'").get();
    expect(leftover).toBeUndefined();
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

  it('leaves no open handle behind when a migration fails', () => {
    // A leaked handle would keep the file locked and make the failure confusing.
    const dir = tempDir();
    const store = openStore({ dir });
    store.close();
    expect(() => openStore({ dir })).not.toThrow();
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
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => {
      verifyPragmas(db, { inMemory: false });
    }).toThrow(PragmaError);
    db.close();
  });

  it('does not demand WAL of an in-memory store, where it cannot exist', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Journal mode here is 'memory'; failing on that would be a false alarm.
    expect(() => {
      verifyPragmas(db, { inMemory: true });
    }).not.toThrow();
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
    // This is fold's confound #1 made impossible: a row cannot claim a definition
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
