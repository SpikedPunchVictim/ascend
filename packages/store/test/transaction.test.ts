import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, withRollback, withTransaction, type Store } from '../src/index.js';

/**
 * `withTransaction` is the commit half of `withRollback` (`db.ts`), and it exists because SQLite's
 * default is autocommit.
 *
 * That is not a detail. `asc record` writing a batch of five entries where the fourth fails
 * validation would, without a transaction, leave the first three **permanently** written -- entries
 * are immutable and cannot be deleted (`recorder.ts`) -- while exiting non-zero and naming one
 * failure. The caller then holds a partial batch it was told failed, and cannot even re-run it,
 * because the ids it would reuse now collide. So the property worth testing is not "it commits";
 * it is "**a failure leaves nothing behind, and the exit code alone tells the whole story**".
 *
 * Both directions are tested, plus the two things that make the two functions one mechanism rather
 * than two: the nesting they share, and the fact that a body sees its own earlier writes. The
 * second is what lets a preview report the outcome the real run would produce; the first is what
 * lets that preview sit inside the caller's transaction instead of beside it.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-txn-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
  }
};

const count = (store: Store, sql: string): number =>
  (store.db.prepare(sql).get() as { n: number }).n;

const rows = (store: Store, table: string): number =>
  count(store, `SELECT COUNT(*) AS n FROM ${table}`);

/** The ids present, in a fixed order, because the order a test asserts should not be the store's. */
const ids = (store: Store): string[] =>
  (store.db.prepare('SELECT id FROM t ORDER BY id').all() as { id: string }[]).map((row) => row.id);

/** A table created for the test, so the transaction is exercised without the recorder in the way. */
const createTable = (store: Store): void => {
  store.db.exec('CREATE TABLE t (id TEXT NOT NULL PRIMARY KEY)');
};

const insert = (store: Store, id: string): void => {
  store.db.prepare('INSERT INTO t (id) VALUES (?)').run(id);
};

describe('withTransaction', () => {
  it('keeps what the body wrote when the body returns', () => {
    withStore((store) => {
      createTable(store);
      withTransaction(store.db, () => {
        insert(store, 'a');
        insert(store, 'b');
      });
      expect(rows(store, 't')).toBe(2);
    });
  });

  it('keeps NOTHING when the body throws, and lets the error through', () => {
    // The property `asc record`'s batch guarantee rests on. A version of this function that
    // committed in a `finally` would pass the test above and fail this one.
    withStore((store) => {
      createTable(store);
      expect(() =>
        withTransaction(store.db, () => {
          insert(store, 'a');
          insert(store, 'b');
          throw new Error('the fourth entry was invalid');
        }),
      ).toThrow('the fourth entry was invalid');
      expect(rows(store, 't')).toBe(0);
    });
  });

  it('leaves no transaction open after a failure, so the next write works', () => {
    // A `finally` that forgot the rollback would leave the handle mid-transaction and the store
    // wedged for every later statement. Measured rather than assumed: the write below would fail
    // with "cannot start a transaction within a transaction" if one were still open.
    withStore((store) => {
      createTable(store);
      expect(() =>
        withTransaction(store.db, () => {
          insert(store, 'a');
          throw new Error('no');
        }),
      ).toThrow('no');

      expect(store.db.isTransaction).toBe(false);
      insert(store, 'after');
      expect(rows(store, 't')).toBe(1);
    });
  });

  it('lets the body see its own earlier writes, which is what makes a batch coherent', () => {
    // The same property `withRollback` needs for `import --dry-run`, and `asc record` needs for a
    // second entry to collide with the first. A per-write transaction would make every write blind
    // to the ones before it, so a duplicate id inside one batch would be accepted.
    withStore((store) => {
      createTable(store);
      expect(() => {
        withTransaction(store.db, () => {
          insert(store, 'same');
          insert(store, 'same');
        });
      }).toThrow();
      expect(rows(store, 't')).toBe(0);
    });
  });

  it('takes the write lock at BEGIN, so a concurrent writer waits instead of breaking the body', () => {
    // B4. The property is about WHEN the lock is taken, and it has an exact failure. With a
    // DEFERRED `BEGIN` the lock is not taken until the body's first write, so the SELECT below --
    // the shape `recordEntry` has, reading before it writes -- establishes a WAL read snapshot that
    // the other connection's commit then invalidates. Our write against that stale snapshot fails
    // with `SQLITE_BUSY_SNAPSHOT`, and SQLite does not consult the busy handler for it at all,
    // because retrying could not help. Measured on the real path with `busy_timeout` 300ms: refused
    // in 1ms. `IMMEDIATE` takes the lock at BEGIN, so the other connection waits where the timeout
    // applies, and the body holds a snapshot nothing can invalidate.
    withStore((store) => {
      createTable(store);

      // A second connection, standing in for the concurrent subagent writer `db.ts`'s own header
      // names as the reason WAL is required in the first place. Raw on purpose: it must not share
      // any of the store's machinery, or it would be testing that machinery against itself.
      const other = new DatabaseSync(store.file);
      other.exec('PRAGMA busy_timeout = 50');
      try {
        withTransaction(store.db, () => {
          // Reading before writing is not a contrivance -- it is what `recordEntry` does, and it is
          // what makes the snapshot exist for a later commit to invalidate.
          store.db.prepare('SELECT id FROM t WHERE id = ?').get('absent');

          // The discriminating assertion, and the only one in this file that separates the two
          // BEGIN modes: with the lock held from BEGIN this write BLOCKS, times out, and throws;
          // against a deferred BEGIN it succeeds outright. Asserted rather than left implicit,
          // because "the other connection was made to wait" IS the fix.
          expect(() => {
            other.prepare('INSERT INTO t (id) VALUES (?)').run('concurrent');
          }).toThrow(/database is locked/);

          insert(store, 'ours');
        });
      } finally {
        other.close();
      }

      expect(count(store, "SELECT COUNT(*) AS n FROM t WHERE id = 'ours'")).toBe(1);
      expect(count(store, "SELECT COUNT(*) AS n FROM t WHERE id = 'concurrent'")).toBe(0);
    });
  });

  it('runs inside a transaction it did not open, and keeps the caller whole', () => {
    // The refusal these two tests used to assert was retired rather than weakened: it argued that
    // neither function may end a transaction that belongs to the caller, and that is true of a
    // second BEGIN/ROLLBACK and false of a savepoint, which ends only its own scope. So the
    // stronger property replaces it -- not "it refuses" but "it nests, and the caller keeps what
    // they wrote".
    //
    // `[ 'after', 'caller', 'nested' ]` is measured, and it corrected this test: the first version
    // asserted the nested id was absent, which is the meaning of a ROLLBACK and not of a COMMIT. A
    // nested COMMIT releases its savepoint into the caller's transaction, so its rows are there and
    // the caller's ending still decides whether they survive -- which is the next test.
    withStore((store) => {
      createTable(store);
      withTransaction(store.db, () => {
        insert(store, 'caller');
        withTransaction(store.db, () => {
          insert(store, 'nested');
        });
        insert(store, 'after');
      });
      expect(ids(store)).toEqual(['after', 'caller', 'nested']);
    });
  });

  it('and so does withRollback, which is how a preview sits inside a real write', () => {
    // b3's exact shape: the write site holds one transaction across the read, the preview and the
    // append, and the preview is `withRollback` inside it (asc-q4p -- the read has to be under the
    // same lock, or two concurrent writers compute the same next version). A preview that ended
    // the caller's transaction would commit or discard the append that follows it.
    withStore((store) => {
      createTable(store);
      withTransaction(store.db, () => {
        withRollback(store.db, () => {
          insert(store, 'previewed');
        });
        insert(store, 'real');
      });
      expect(ids(store)).toEqual(['real']);
    });
  });

  it('lets the caller carry on after a nested body throws, and keeps their own work', () => {
    withStore((store) => {
      createTable(store);
      withTransaction(store.db, () => {
        insert(store, 'caller');
        expect(() =>
          withTransaction(store.db, () => {
            insert(store, 'nested');
            throw new Error('the nested body failed');
          }),
        ).toThrow('the nested body failed');
        insert(store, 'after');
      });
      expect(ids(store)).toEqual(['after', 'caller']);
    });
  });

  it('nests inside a transaction the caller opened by hand, not only inside its own helpers', () => {
    // `inOwnScope` decides by asking whether a transaction is open, not by whether one of these two
    // functions opened it, so a caller who took their own lock gets the same nesting. Worth pinning
    // because it is the property that makes this a rule about the database rather than a protocol
    // the two helpers share privately.
    withStore((store) => {
      createTable(store);
      store.db.exec('BEGIN IMMEDIATE');
      try {
        insert(store, 'caller');
        withRollback(store.db, () => {
          insert(store, 'previewed');
        });
        insert(store, 'after');
        store.db.exec('COMMIT');
      } finally {
        if (store.db.isTransaction) store.db.exec('ROLLBACK');
      }
      expect(ids(store)).toEqual(['after', 'caller']);
    });
  });

  it('does not make a nested commit durable, because the caller still decides that', () => {
    // The property that separates a savepoint from a transaction, and the one thing here that no
    // other test in this file can see. A nested scope that really committed -- i.e. one that opened
    // its own BEGIN and COMMIT -- would pass every test above and leave `nested` behind here, while
    // the exit code said the batch failed. Entries are immutable and cannot be deleted, so that
    // residue would be permanent.
    withStore((store) => {
      createTable(store);
      expect(() =>
        withTransaction(store.db, () => {
          insert(store, 'caller');
          withTransaction(store.db, () => {
            insert(store, 'nested');
          });
          throw new Error('the caller failed after the nested scope returned');
        }),
      ).toThrow('the caller failed after the nested scope returned');
      expect(rows(store, 't')).toBe(0);
    });
  });

  it('does not commit what withRollback discarded, even when the two are used in sequence', () => {
    // The pair used the way a command uses them: a preview, then the real thing. If the rollback
    // had left anything behind, the real run would double it.
    withStore((store) => {
      createTable(store);
      withRollback(store.db, () => {
        insert(store, 'previewed');
      });
      expect(rows(store, 't')).toBe(0);

      withTransaction(store.db, () => {
        insert(store, 'real');
      });
      expect(rows(store, 't')).toBe(1);
    });
  });
});
