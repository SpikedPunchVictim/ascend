import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, registerType, withRollback, type Store } from '../src/index.js';

/**
 * `withRollback` exists so a command can compute a real result -- versions, hashes, generated
 * views -- and then throw all of it away. `asc types import --dry-run` is the caller
 * (`packages/cli/src/commands/types/import.ts`), and the property it needs is stronger than
 * "nothing was written": the preview must *see* its own earlier writes, so the second document
 * of a list reports version 2 rather than version 1, and then the whole thing must vanish.
 *
 * That is why it exists at all rather than each registration rolling itself back: a per-write
 * rollback makes the second document blind to the first, and a preview that misdescribes the
 * real run is worse than no preview.
 *
 * So the two things tested here are the two halves of that: the body sees its own writes, and
 * none of them survive. Plus the refusal, because a nested rollback would not undo the *body's*
 * work -- it would undo the caller's, which is the thing transactions exist to prevent.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-rollback-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-12T10:00:00.000Z';

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

const rows = (store: Store): number => count(store, 'SELECT COUNT(*) AS n FROM entry_types');

/**
 * The DDL a per-type registration creates alongside its row.
 *
 * A rollback that left a generated view or its indexes behind would leave a store where
 * `asc query` can read a type the registry does not have -- so "nothing was written" has to
 * mean the schema too, not just the table.
 */
const schemaObjects = (store: Store, name: string): number =>
  count(
    store,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%${name}%' AND type IN ('view','index')`,
  );

const spec = (
  name: string,
  property = 'summary',
): {
  name: string;
  properties: { name: string; type: 'text' }[];
} => ({ name, properties: [{ name: property, type: 'text' }] });

describe('withRollback', () => {
  it('lets the body read its own writes back, then undoes them', () => {
    withStore((store) => {
      const seen: number[] = [];
      withRollback(store.db, () => {
        seen.push(registerType(store.db, spec('reviewed'), { registeredAt: AT }).version);
        // Same name, different shape -- so this is version 2 of that name, and the point is that
        // it *is* 2 rather than 1. The body shares one transaction with the writes it makes, so
        // the second registration sees the first. (Two different names would both be version 1
        // of their own family and would not test this at all.)
        seen.push(
          registerType(store.db, spec('reviewed', 'verdict'), { registeredAt: AT }).version,
        );
      });

      expect(seen).toEqual([1, 2]);
      expect(rows(store)).toBe(0);
    });
  });

  it('undoes generated views and indexes as well as rows', () => {
    withStore((store) => {
      withRollback(store.db, () => {
        registerType(store.db, spec('view_holder'), { registeredAt: AT });
        // Asserted inside the body, so a failure to generate anything is a failure of this
        // test rather than a vacuous pass on the assertion after the rollback.
        expect(schemaObjects(store, 'view_holder')).toBeGreaterThan(0);
      });

      expect(schemaObjects(store, 'view_holder')).toBe(0);
      expect(rows(store)).toBe(0);
    });
  });

  it('leaves nothing behind when the body throws', () => {
    withStore((store) => {
      expect(() => {
        withRollback(store.db, () => {
          registerType(store.db, spec('doomed'), { registeredAt: AT });
          throw new Error('the document after this one was invalid');
        });
      }).toThrow('the document after this one was invalid');

      expect(rows(store)).toBe(0);
      expect(schemaObjects(store, 'doomed')).toBe(0);
      // The connection is usable afterwards -- a rollback that left the transaction open would
      // make every later write on this store fail or, worse, silently join it.
      expect(store.db.isTransaction).toBe(false);
      registerType(store.db, spec('after'), { registeredAt: AT });
      expect(rows(store)).toBe(1);
    });
  });

  it('refuses to run inside a caller-managed transaction', () => {
    withStore((store) => {
      store.db.exec('BEGIN');
      try {
        expect(() => {
          withRollback(store.db, () => {
            /* never reached: the refusal is the point */
          });
        }).toThrow(/caller-managed transaction/);
      } finally {
        store.db.exec('ROLLBACK');
      }

      // And the caller's transaction is still theirs to end: the refusal happened before any
      // `BEGIN`, so it neither nested nor rolled anything back.
      expect(store.db.isTransaction).toBe(false);
      expect(rows(store)).toBe(0);
    });
  });

  it('keeps what the caller already committed', () => {
    withStore((store) => {
      // Not `withRollback`: registered outside it, so it is committed before the preview runs.
      registerType(store.db, spec('kept'), { registeredAt: AT });

      withRollback(store.db, () => {
        registerType(store.db, spec('discarded'), { registeredAt: AT });
        expect(rows(store)).toBe(2);
      });

      // 1, not 0: the rollback undoes its own body and nothing else.
      expect(rows(store)).toBe(1);
      const kept = store.db.prepare('SELECT name FROM entry_types').all() as { name: string }[];
      expect(kept.map((row) => row.name)).toEqual(['kept']);
    });
  });
});
