import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PropertySpec, TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deprecateType,
  findType,
  openStore,
  recordEntry,
  registerType,
  UnusableDefinitionError,
  UnusableProseError,
  typeVersions,
  updateTypeProse,
  withRollback,
  withTransaction,
  type Store,
} from '../src/index.js';

/**
 * The registry's job is to make a shape change a NEW ROW, never an UPDATE, and to
 * decide what counts as the same definition. These run against a real file store,
 * because the immutability they rest on is enforced by database triggers that an
 * in-memory stand-in would not exercise identically.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-registry-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';
const LATER = '2026-09-11T11:00:00.000Z';

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
  }
};

const spec = (extra: readonly PropertySpec[] = []): TypeSpec => ({
  name: 'review_completed',
  properties: [{ name: 'count', type: 'integer' }, { name: 'summary', type: 'text' }, ...extra],
});

/** Every version row, so a test can assert that nothing was written. */
const rowCount = (store: Store): number =>
  (store.db.prepare('SELECT COUNT(*) AS n FROM entry_types').get() as { n: number }).n;

describe('registering a type', () => {
  it('creates version 1 in major family 1', () => {
    withStore((store) => {
      const result = registerType(store.db, spec(), { registeredAt: AT });
      expect(result.outcome).toBe('created');
      expect(result.version).toBe(1);
      expect(result.major).toBe(1);
      expect(result.bump).toBe('major');
      expect(result.typeHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('previews a registration without writing it, and reports the same thing', () => {
    withStore((store) => {
      const planned = registerType(store.db, spec(), { registeredAt: AT, dryRun: true });

      // The report must be the one a real registration would have produced, or the preview
      // is of a different operation than the one the caller is deciding about. Comparing
      // against an actual registration on a SEPARATE store is the only way to assert that
      // without the first registration having already changed the answer.
      expect(rowCount(store)).toBe(0);
      expect(findType(store.db, 'review_completed')).toBeUndefined();

      const real = registerType(store.db, spec(), { registeredAt: AT });
      expect(planned).toEqual(real);
    });
  });

  it('leaves no view or index behind -- a dry run rolls back DDL too', () => {
    withStore((store) => {
      const views = (): number =>
        (
          store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view'").get() as {
            n: number;
          }
        ).n;

      const before = views();
      registerType(store.db, spec(), { registeredAt: AT, dryRun: true });

      // The registration generates a per-type view and expression indexes. If the preview
      // rolled back the row but not the DDL, the store would carry a view for a type it
      // does not have -- a state `asc query` would then fail on.
      expect(views()).toBe(before);
    });
  });

  it('refuses a dry run inside a caller-managed transaction', () => {
    withStore((store) => {
      store.db.exec('BEGIN');
      try {
        // It cannot keep its promise there: the writes would be the caller's to commit, so
        // returning a preview while leaving the write in place is the one outcome a dry run
        // must never produce. Refusing is checked before any work is done.
        expect(() => registerType(store.db, spec(), { registeredAt: AT, dryRun: true })).toThrow(
          /cannot dry-run inside a caller-managed transaction/,
        );
      } finally {
        store.db.exec('ROLLBACK');
      }
    });
  });

  it('a preview of a change reports the bump a change would produce', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });

      // Removing a property is the change a preview is most useful for: it is a major bump,
      // and seeing that before writing is the whole point of `--dry-run` on `asc types define`.
      const planned = registerType(
        store.db,
        { name: 'review_completed', properties: [{ name: 'summary', type: 'text' }] },
        { registeredAt: LATER, dryRun: true },
      );

      expect(planned.outcome).toBe('created');
      expect(planned.bump).toBe('major');
      expect(planned.version).toBe(2);
      expect(rowCount(store)).toBe(1);
    });
  });

  it('stores the canonical name and reports what it rewrote', () => {
    // EV-drift measured that this is the failure mode, not a formatting preference:
    // snake_case and camelCase arrived interchangeably across real model runs.
    withStore((store) => {
      const result = registerType(
        store.db,
        { name: 'Review Completed', properties: [{ name: 'parseJSONBody', type: 'boolean' }] },
        { registeredAt: AT },
      );
      expect(result.name).toBe('review_completed');
      expect(result.renames).toEqual([
        { from: 'Review Completed', to: 'review_completed' },
        { from: 'parseJSONBody', to: 'parse_json_body' },
      ]);
      expect(findType(store.db, 'review_completed')?.spec.properties[0]?.name).toBe(
        'parse_json_body',
      );
    });
  });

  it('is idempotent -- the same shape writes nothing the second time', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const before = rowCount(store);

      const again = registerType(store.db, spec(), { registeredAt: LATER });

      expect(again.outcome).toBe('unchanged');
      expect(again.version).toBe(1);
      expect(again.bump).toBe('none');
      expect(again.changes).toEqual([]);
      expect(rowCount(store)).toBe(before);
    });
  });

  it('reports the same definition for a reordered property list', () => {
    // Property order is an authoring artifact. Two runs listing the same fields in a
    // different order are the same definition, not a new version.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const reversed: TypeSpec = {
        name: 'review_completed',
        properties: [...spec().properties].reverse(),
      };
      const result = registerType(store.db, reversed, { registeredAt: LATER });
      expect(result.outcome).toBe('unchanged');
      expect(rowCount(store)).toBe(1);
    });
  });
});

/**
 * asc-odh: the version read and the version insert are one decision, so they are one
 * transaction -- and a transaction that begins AFTER the read does not make them atomic.
 *
 * The race itself is not observable from a single-process unit test: with one connection there is
 * no second writer to invalidate the read. It was measured instead with two processes driving this
 * function from a shared wall-clock barrier (`/tmp/probe-race.mjs`): **10 trials, 10 UNIQUE
 * collisions** with the BEGIN below the reads; **20 trials, 0** with it above. What these tests
 * cover is the other half of the restructure -- the transaction now spans the whole body, so every
 * exit from it has to give the lock back, and the paths that must NOT commit must not commit.
 * Stated rather than implied: the read's placement inside the lock is verified by the probe and by
 * reading the function, not by anything below.
 */
describe('the transaction registerType opens spans its whole body', () => {
  /** Fails if the handle still has a transaction open, which is what a leaked lock looks like. */
  const assertNoOpenTransaction = (store: Store): void => {
    expect(store.db.isTransaction).toBe(false);
    // The property is not trusted on its own: a nested BEGIN is an error, so this succeeds only if
    // the transaction really is closed. An open one here would silently adopt the caller's next
    // statement -- and would turn their own BEGIN into a nested one.
    store.db.exec('BEGIN');
    store.db.exec('ROLLBACK');
  };

  it('releases the lock after creating a version', () => {
    withStore((store) => {
      const result = registerType(store.db, spec(), { registeredAt: AT });
      expect(result.outcome).toBe('created');
      assertNoOpenTransaction(store);
    });
  });

  it('releases the lock on the unchanged path, which now takes one', () => {
    // The cost this restructure accepted, paid in the one place a caller could notice it: an
    // idempotent re-registration used to touch no lock at all, and now takes the write lock because
    // the BEGIN sits above the idempotence check rather than below it. Taking it is safe only
    // because the early return gives it back.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const again = registerType(store.db, spec(), { registeredAt: LATER });

      expect(again.outcome).toBe('unchanged');
      expect(again.version).toBe(1);
      assertNoOpenTransaction(store);
    });
  });

  it('releases the lock after a preview', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, dryRun: true });
      expect(rowCount(store)).toBe(0);
      assertNoOpenTransaction(store);
    });
  });

  it("joins a caller's transaction instead of committing it", () => {
    withStore((store) => {
      withTransaction(store.db, () => {
        registerType(store.db, spec(), { registeredAt: AT });
        // Still open, because it is the caller's to end. A `COMMIT` here would be registerType
        // deciding the fate of work it did not open.
        expect(store.db.isTransaction).toBe(true);
      });
      expect(store.db.isTransaction).toBe(false);
      expect(rowCount(store)).toBe(1);
    });
  });

  it("a caller's ROLLBACK takes the registration with it", () => {
    // The strongest form of the previous test, and the one a wrong `ownsTransaction` cannot pass:
    // if registerType committed its own work, the row would survive the caller's rollback. This is
    // why `finish` is conditional rather than a bare `db.exec(statement)`.
    withStore((store) => {
      withRollback(store.db, () => {
        registerType(store.db, spec(), { registeredAt: AT });
        expect(rowCount(store)).toBe(1);
      });
      expect(rowCount(store)).toBe(0);
      expect(store.db.isTransaction).toBe(false);
    });
  });

  it("a failure inside a caller's transaction is theirs to unwind, not ours", () => {
    // Found by mutation, not by imagination: replacing the catch's `ownsTransaction` with a bare
    // `!ended` survived the rest of this suite, because every other failure test uses a store where
    // registerType owns the transaction. That mutation is not cosmetic -- a callee that rolls back a
    // transaction it merely joined discards work the caller did BEFORE calling it, and the caller
    // then commits an empty transaction believing otherwise.
    let stored = '';
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      stored = (
        store.db
          .prepare("SELECT spec_json FROM entry_types WHERE name = 'review_completed'")
          .get() as { spec_json: string }
      ).spec_json;
    });

    withStore((store) => {
      store.db
        .prepare(
          `INSERT INTO entry_types
             (name, version, major, type_hash, spec_json, description, record_when, prose_json, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, '{}', ?)`,
        )
        .run('review_completed', 1, 1, 'not-the-hash-this-spec-produces', stored, AT);

      withTransaction(store.db, () => {
        // The caller's own work, done before the callee fails.
        registerType(store.db, { name: 'audit_finished', properties: [] }, { registeredAt: AT });

        let threw = false;
        try {
          registerType(store.db, spec(), { registeredAt: LATER });
        } catch {
          threw = true;
          // Caught and swallowed, so this transaction commits. Still open at this moment: ending it
          // here would be the callee deciding the fate of the caller's earlier registration.
          expect(store.db.isTransaction).toBe(true);
        }
        expect(threw).toBe(true);
      });

      // And the caller's work is really there, which is what a stray rollback destroys.
      expect(findType(store.db, 'audit_finished')).toBeDefined();
    });
  });

  it('rolls back, and holds no lock, when the registration fails partway', () => {
    // The one throw reachable from inside the transaction. It is a corruption guard ("hashes
    // differently but the shapes match"), so the only way to arrive at it is a store whose
    // `type_hash` disagrees with the `spec_json` beside it. Nothing in the public API can build that
    // state -- the identity trigger refuses the UPDATE -- so it is built with an INSERT, the one
    // mutation the triggers do not intercept.
    let stored = '';
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      stored = (
        store.db
          .prepare("SELECT spec_json FROM entry_types WHERE name = 'review_completed'")
          .get() as { spec_json: string }
      ).spec_json;
    });

    withStore((store) => {
      store.db
        .prepare(
          `INSERT INTO entry_types
             (name, version, major, type_hash, spec_json, description, record_when, prose_json, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, '{}', ?)`,
        )
        .run('review_completed', 1, 1, 'not-the-hash-this-spec-produces', stored, AT);

      expect(() => registerType(store.db, spec(), { registeredAt: LATER })).toThrow(
        /hashes differently/,
      );

      // Before the restructure this throw escaped with the transaction still open, because it was
      // raised above the BEGIN and the BEGIN never ran. Now it is raised inside, and unwinds.
      assertNoOpenTransaction(store);
      // The failed registration wrote nothing: the bogus row is the only one there.
      expect(rowCount(store)).toBe(1);
    });
  });
});

describe('prose is not part of the definition', () => {
  /**
   * The load-bearing identity decision. Prose is guidance shown to the recorder; it
   * changes no stored value, so rewording it must not mint a version, must not change
   * type_hash, and must not detach a single recorded entry.
   */
  it('registers the same shape under different wording as UNCHANGED', () => {
    withStore((store) => {
      const first = registerType(store.db, spec(), {
        registeredAt: AT,
        description: 'a review finished',
        recordWhen: 'when a code review completes',
      });
      const second = registerType(store.db, spec(), {
        registeredAt: LATER,
        description: 'totally different words',
        recordWhen: 'reworded entirely',
      });

      expect(second.outcome).toBe('unchanged');
      expect(second.typeHash).toBe(first.typeHash);
      expect(rowCount(store)).toBe(1);
    });
  });

  it('produces one definition from two runs that described it differently', () => {
    // The consequence that matters: entries recorded under either wording attach to
    // the same definition, so a query unions comparable values instead of silently
    // splitting one type in two.
    withStore((store) => {
      const first = registerType(
        store.db,
        {
          name: 'review_completed',
          description: 'run one wording',
          properties: [{ name: 'count', type: 'integer', description: 'run one field prose' }],
        },
        { registeredAt: AT },
      );
      const second = registerType(
        store.db,
        {
          name: 'review_completed',
          description: 'run two wording',
          properties: [{ name: 'count', type: 'integer', description: 'run two field prose' }],
        },
        { registeredAt: LATER },
      );

      expect(second.typeHash).toBe(first.typeHash);
      expect(second.version).toBe(first.version);
      expect(rowCount(store)).toBe(1);
    });
  });

  it('keeps per-property prose, which is stored beside the shape rather than in it', () => {
    withStore((store) => {
      registerType(store.db, spec(), {
        registeredAt: AT,
        prose: { count: 'how many findings' },
      });
      const row = findType(store.db, 'review_completed');
      expect(row?.prose).toEqual({ count: 'how many findings' });
      // ...and the stored spec is the shape, with no prose inside it.
      expect(JSON.stringify(row?.spec)).not.toContain('how many findings');
    });
  });

  it('lets prose be rewritten in place without touching identity', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, recordWhen: 'original' });
      const before = findType(store.db, 'review_completed');

      updateTypeProse(store.db, 'review_completed', 1, { recordWhen: 'improved' });

      const after = findType(store.db, 'review_completed');
      expect(after?.recordWhen).toBe('improved');
      expect(after?.typeHash).toBe(before?.typeHash);
      expect(after?.spec).toEqual(before?.spec);
      // No new version: prose is not a shape change.
      expect(rowCount(store)).toBe(1);
    });
  });

  it('leaves an omitted prose field alone and clears an explicit null', () => {
    // `undefined` means "no change", `null` means "remove it". Collapsing them would
    // make clearing a description impossible.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, description: 'keep me', recordWhen: 'x' });
      updateTypeProse(store.db, 'review_completed', 1, { recordWhen: null });
      const row = findType(store.db, 'review_completed');
      expect(row?.description).toBe('keep me');
      expect(row?.recordWhen).toBeNull();
    });
  });

  it('refuses to update prose for a version that is not registered', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(() => {
        updateTypeProse(store.db, 'review_completed', 7, { description: 'x' });
      }).toThrow(/not registered/);
    });
  });
});

describe("a prose key must name a property, under the store's own spelling", () => {
  /**
   * `RegisterTypeOptions.prose` is documented as *"keyed by canonical property name"*, and both
   * writers used to copy the caller's keys verbatim. The consequence was not a wrong value but a
   * LOST one: the map held `reviewKind` beside `review_kind`, and every reader looks the prose up
   * by the declared, canonical name, so the row held guidance nothing could show (asc-bcv.15, F3).
   */
  const reviewSpec = (): TypeSpec => ({
    name: 'review_completed',
    properties: [
      { name: 'review_kind', type: 'text' },
      { name: 'rounds', type: 'integer' },
    ],
  });

  it('stores a key the caller spelled differently under the property it names', () => {
    withStore((store) => {
      registerType(store.db, reviewSpec(), {
        registeredAt: AT,
        prose: { reviewKind: 'the verdict that was reached' },
      });

      // `toEqual` on the whole map, not on the one lookup: the defect stored BOTH keys, and an
      // assertion for `review_kind` alone passes against a map that also holds `reviewKind`.
      expect(findType(store.db, 'review_completed')?.prose).toEqual({
        review_kind: 'the verdict that was reached',
      });
    });
  });

  it('refuses a key that names no property, listing the ones that exist, and writes nothing', () => {
    withStore((store) => {
      let thrown: unknown;
      try {
        registerType(store.db, reviewSpec(), {
          registeredAt: AT,
          prose: { verdict: 'not a declared property' },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnusableProseError);
      const message = (thrown as Error).message;
      expect(message).toContain("prose key 'verdict'");
      expect(message).toContain("'review_kind'");
      expect(message).toContain("'rounds'");
      // Refused before the transaction, so there is no row and no version to point at.
      expect(rowCount(store)).toBe(0);
      expect(findType(store.db, 'review_completed')).toBeUndefined();
    });
  });

  it('refuses a key that is BOTH misspelled and names nothing', () => {
    // The shape the defect actually took: `reviewKind` prose for a type that does not declare it.
    // A refusal that fired only on keys already spelled the store's way would let this through and
    // store it verbatim -- invisible to every reader, which is the whole finding. Found by a
    // surviving mutation, not by inspection: the first version of the test above used `verdict`,
    // which is already canonical, so it could not tell the two rules apart.
    withStore((store) => {
      expect(() => {
        registerType(store.db, reviewSpec(), {
          registeredAt: AT,
          prose: { verdictKind: 'neither declared nor spelled the way the store spells it' },
        });
      }).toThrow(UnusableProseError);
      expect(rowCount(store)).toBe(0);
    });
  });

  it('refuses two keys that fold to the same property, rather than picking one', () => {
    // There is no principled winner between `review_kind: 'a'` and `reviewKind: 'b'`, and
    // choosing silently is the resolution this repository refuses everywhere else.
    withStore((store) => {
      let thrown: unknown;
      try {
        registerType(store.db, reviewSpec(), {
          registeredAt: AT,
          prose: { review_kind: 'a', reviewKind: 'b' },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnusableProseError);
      expect((thrown as Error).message).toContain("'review_kind' and 'reviewKind'");
      expect(rowCount(store)).toBe(0);
    });
  });

  it('refuses an undeclared key on the prose UPDATE path too, and leaves the stored prose alone', () => {
    // The second writer, and the one reachable WITHOUT a shape change -- `asc types define` of an
    // already-known shape goes through here. A fix applied only to registration would leave this
    // half storing the key verbatim.
    withStore((store) => {
      registerType(store.db, reviewSpec(), {
        registeredAt: AT,
        prose: { review_kind: 'original' },
      });

      expect(() => {
        updateTypeProse(store.db, 'review_completed', 1, {
          propertyProse: { verdict: 'nope' },
        });
      }).toThrow(UnusableProseError);

      const row = findType(store.db, 'review_completed');
      expect(row?.prose).toEqual({ review_kind: 'original' });
      // The whole statement was refused, so the other fields it carried were refused with it.
      expect(row?.recordWhen).toBeNull();
    });
  });

  it('folds an update key to the stored spelling rather than adding a second one', () => {
    withStore((store) => {
      registerType(store.db, reviewSpec(), {
        registeredAt: AT,
        prose: { review_kind: 'original' },
      });

      updateTypeProse(store.db, 'review_completed', 1, {
        propertyProse: { reviewKind: 'reworded' },
      });

      expect(findType(store.db, 'review_completed')?.prose).toEqual({ review_kind: 'reworded' });
    });
  });
});

describe('a shape change is a new version, never an edit', () => {
  it('adds an optional property as a minor bump inside the same major', () => {
    // Backward compatible: every old entry still satisfies the definition, so a view
    // may union the two versions.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(store.db, spec([{ name: 'reviewer', type: 'string' }]), {
        registeredAt: LATER,
      });

      expect(result.outcome).toBe('created');
      expect(result.version).toBe(2);
      expect(result.major).toBe(1);
      expect(result.bump).toBe('minor');
      expect(result.changes.map((c) => c.kind)).toEqual(['property_added']);
    });
  });

  it('retypes a property as a major bump, starting a new family', () => {
    // Not an error, and not unionable either: `count` going integer -> duration
    // reinterprets every stored value without changing it.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'count', type: 'duration', unit: 'ms' },
            { name: 'summary', type: 'text' },
          ],
        },
        { registeredAt: LATER },
      );

      expect(result.version).toBe(2);
      expect(result.major).toBe(2);
      expect(result.bump).toBe('major');
      expect(result.changes.map((c) => c.kind)).toContain('property_retyped');
    });
  });

  it('keeps the major family across a minor after a major', () => {
    // Version 3 follows a major bump at version 2, so a view for major 2 must cover
    // versions 2 and 3 -- and must not reach back to version 1.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      registerType(
        store.db,
        { name: 'review_completed', properties: [{ name: 'count', type: 'duration', unit: 'ms' }] },
        { registeredAt: LATER },
      );
      const third = registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'count', type: 'duration', unit: 'ms' },
            { name: 'reviewer', type: 'string' },
          ],
        },
        { registeredAt: LATER },
      );

      expect(third.version).toBe(3);
      expect(third.major).toBe(2);
      expect(third.bump).toBe('minor');
      expect(typeVersions(store.db, 'review_completed').map((v) => v.major)).toEqual([1, 2, 2]);
    });
  });

  it('removing a property is major, because old entries have nowhere to land', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(
        store.db,
        { name: 'review_completed', properties: [{ name: 'count', type: 'integer' }] },
        { registeredAt: LATER },
      );
      expect(result.bump).toBe('major');
      expect(result.major).toBe(2);
      expect(result.changes.map((c) => c.kind)).toContain('property_removed');
    });
  });

  it('making a property required is major, and reports it as required', () => {
    // Major because old entries recorded before this have no DECISION for it -- and
    // "required" means a decision, not a value, so an explicit N/A would satisfy it.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'count', type: 'integer', required: true },
            { name: 'summary', type: 'text' },
          ],
        },
        { registeredAt: LATER },
      );
      expect(result.bump).toBe('major');
      expect(result.changes.map((c) => c.kind)).toEqual(['became_required']);
    });
  });

  it('adding an enum value is minor; removing one is major', () => {
    // Asymmetric on purpose: old rows holding a removed value are no longer legal
    // under the new definition, so they cannot be unioned.
    const withOutcome = (values: string[]): TypeSpec => ({
      name: 'review_completed',
      properties: [{ name: 'outcome', type: 'enum', enum_values: values }],
    });

    withStore((store) => {
      registerType(store.db, withOutcome(['approved', 'deferred']), { registeredAt: AT });

      const added = registerType(store.db, withOutcome(['approved', 'deferred', 'rejected']), {
        registeredAt: LATER,
      });
      expect(added.bump).toBe('minor');
      expect(added.major).toBe(1);

      const removed = registerType(store.db, withOutcome(['approved']), { registeredAt: LATER });
      expect(removed.bump).toBe('major');
      expect(removed.major).toBe(2);
      expect(removed.changes.map((c) => c.kind)).toContain('enum_value_removed');
    });
  });

  it('re-registering an earlier shape returns that version, without minting one', () => {
    // A rollback: v1's shape is registered again after v2. It resolves to v1, because
    // v1 IS this definition -- same hash, so entries validate identically. Minting a v3
    // with v1's hash would make `type_hash` stop identifying a version, which is what
    // the composite foreign key and `asc types import` both lean on.
    withStore((store) => {
      const first = registerType(store.db, spec(), { registeredAt: AT });
      registerType(store.db, spec([{ name: 'reviewer', type: 'string' }]), { registeredAt: LATER });

      const rolledBack = registerType(store.db, spec(), { registeredAt: LATER });

      expect(rolledBack.outcome).toBe('unchanged');
      expect(rolledBack.version).toBe(first.version);
      expect(rolledBack.typeHash).toBe(first.typeHash);
      expect(rolledBack.bump).toBe('none');
      expect(rowCount(store)).toBe(2);
    });
  });

  it('treats required:false and an omitted required as the same shape', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'count', type: 'integer', required: false },
            { name: 'summary', type: 'text' },
          ],
        },
        { registeredAt: LATER },
      );
      expect(result.outcome).toBe('unchanged');
      expect(rowCount(store)).toBe(1);
    });
  });

  it('ignores enum_values on a non-enum, where they constrain nothing', () => {
    // canonicalizeProperty already warns about this. Splitting one definition in two
    // over it would turn a warning into silent drift.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'count', type: 'integer' },
            { name: 'summary', type: 'text', enum_values: ['a', 'b'] },
          ],
        },
        { registeredAt: LATER },
      );
      expect(result.outcome).toBe('unchanged');
      expect(rowCount(store)).toBe(1);
    });
  });
});

describe('a registered version cannot be rewritten', () => {
  it('refuses a direct UPDATE of the stored shape', () => {
    // The database is the enforcement of record, not the convention above.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(() =>
        store.db
          .prepare(
            'UPDATE entry_types SET spec_json = \'{"name":"review_completed"}\' WHERE name = \'review_completed\'',
          )
          .run(),
      ).toThrow(/identity is immutable/);
      expect(() =>
        store.db
          .prepare("UPDATE entry_types SET version = 99 WHERE name = 'review_completed'")
          .run(),
      ).toThrow(/identity is immutable/);
      expect(() =>
        store.db.prepare("UPDATE entry_types SET major = 5 WHERE name = 'review_completed'").run(),
      ).toThrow(/identity is immutable/);
    });
  });

  it('refuses to delete a version', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(() =>
        store.db.prepare("DELETE FROM entry_types WHERE name = 'review_completed'").run(),
      ).toThrow(/cannot be deleted/);
    });
  });
});

describe('reading types back', () => {
  it('returns the latest version when none is named', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      registerType(store.db, spec([{ name: 'reviewer', type: 'string' }]), { registeredAt: LATER });

      expect(findType(store.db, 'review_completed')?.version).toBe(2);
      expect(findType(store.db, 'review_completed', 1)?.version).toBe(1);
    });
  });

  it('returns undefined for a type that was never registered', () => {
    // Not an error: `asc types show` reports it, and the recorder turns it into a
    // message naming what IS registered.
    withStore((store) => {
      expect(findType(store.db, 'never_defined')).toBeUndefined();
      expect(typeVersions(store.db, 'never_defined')).toEqual([]);
    });
  });

  it('returns every version oldest first, because each one has its own entries', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      registerType(store.db, spec([{ name: 'reviewer', type: 'string' }]), { registeredAt: LATER });

      const versions = typeVersions(store.db, 'review_completed');
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[0]?.spec.properties.map((p) => p.name)).toEqual(['count', 'summary']);
      expect(versions[1]?.spec.properties.map((p) => p.name)).toEqual([
        'count',
        'reviewer',
        'summary',
      ]);
    });
  });
});

describe('the lookup path accepts any spelling that canonicalizes to a registered name (asc-pw2)', () => {
  // registerType stores the CANONICAL name (canonicalizeTypeSpec, spec.ts): a type authored as
  // `reviewKind` is on disk as `review_kind`. Before this fix, findType/typeVersions/deprecateType
  // matched the caller's raw string exactly, so the type was invisible under the very spelling it
  // was defined with -- reproduced at the CLI level as `asc types show reviewKind` reporting
  // 'no type named reviewKind' immediately after `types define {name: reviewKind}` created it.
  const camelSpec: TypeSpec = {
    name: 'reviewKind',
    properties: [{ name: 'outcome', type: 'string' }],
  };

  it('findType answers to the spelling the type was authored with', () => {
    withStore((store) => {
      registerType(store.db, camelSpec, { registeredAt: AT });

      expect(findType(store.db, 'review_kind')?.name).toBe('review_kind');
      expect(findType(store.db, 'reviewKind')?.name).toBe('review_kind');
      expect(findType(store.db, 'review-kind')?.name).toBe('review_kind');
    });
  });

  it('typeVersions answers to the spelling the type was authored with', () => {
    withStore((store) => {
      registerType(store.db, camelSpec, { registeredAt: AT });

      expect(typeVersions(store.db, 'reviewKind').map((v) => v.name)).toEqual(['review_kind']);
    });
  });

  it('deprecateType answers to the spelling the type was authored with', () => {
    withStore((store) => {
      registerType(store.db, camelSpec, { registeredAt: AT });

      expect(deprecateType(store.db, 'reviewKind')).toBe(1);
      expect(findType(store.db, 'review_kind')?.status).toBe('deprecated');
    });
  });
});

describe('a name the generated view has claimed is refused, not projected', () => {
  // asc-865.1. The defect this closes was measured on this exact path: with a property named
  // `source`, SQLite built the view with columns `source` (the envelope) and `source:1` (the
  // property), and `SELECT source FROM v_note_v1` returned 'self'. Refusing at define time is
  // the only place the fix is cheap -- at query time the same mistake reads as a finding.

  it('refuses an envelope column name, and writes nothing at all', () => {
    withStore((store) => {
      expect(() =>
        registerType(
          store.db,
          { name: 'note', properties: [{ name: 'source', type: 'string' }] },
          { registeredAt: AT },
        ),
      ).toThrow(UnusableDefinitionError);

      expect(rowCount(store)).toBe(0);
      expect(findType(store.db, 'note')).toBeUndefined();
      const views = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
        .all() as unknown as { name: string }[];
      expect(views).toEqual([]);
    });
  });

  it('carries the reason and the rename, so the caller has nothing to look up', () => {
    withStore((store) => {
      let thrown: unknown;
      try {
        registerType(
          store.db,
          { name: 'note', properties: [{ name: 'workflow', type: 'string' }] },
          { registeredAt: AT },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnusableDefinitionError);
      const reserved = thrown as UnusableDefinitionError;
      expect(reserved.typeName).toBe('note');
      expect(reserved.problems).toHaveLength(1);
      expect(reserved.message).toContain("'workflow_value'");
    });
  });

  it('refuses the state-column suffix even when the property it would collide with is absent', () => {
    // The collision needs two properties to be visible: `error_state` beside `error`. The rule
    // fires anyway, because a version arrives on its own -- admitting `error_state` in version 1
    // would leave a family that version 2 could never extend with `error`, and a registered
    // definition is immutable, so the family would be stuck rather than wrong.
    withStore((store) => {
      expect(() =>
        registerType(
          store.db,
          { name: 'note', properties: [{ name: 'error_state', type: 'string' }] },
          { registeredAt: AT },
        ),
      ).toThrow(/state of property 'error'/);
    });
  });

  it('refuses a reserved name added by a later version of a registered type', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });

      expect(() =>
        registerType(store.db, spec([{ name: 'actor', type: 'string' }]), { registeredAt: LATER }),
      ).toThrow(UnusableDefinitionError);

      // The registered version is untouched, and no view was rebuilt around the refused one.
      expect(rowCount(store)).toBe(1);
      expect(typeVersions(store.db, 'review_completed').map((v) => v.version)).toEqual([1]);
    });
  });

  it('is a REFUSAL, not a warning -- the caller is told, and the spec is not silently renamed', () => {
    withStore((store) => {
      // The near-miss must still register: `ascend_version` and `schema_version` are columns of
      // `entries` that no view projects, so reserving them would refuse a harmless name.
      const result = registerType(
        store.db,
        {
          name: 'note',
          properties: [
            { name: 'ascend_version', type: 'string' },
            { name: 'schema_version', type: 'integer' },
            { name: 'state', type: 'string' },
          ],
        },
        { registeredAt: AT },
      );

      expect(result.outcome).toBe('created');
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('a name that canonicalizes to empty is refused, not registered', () => {
  // asc-0w9, and the second test below is the strongest evidence in this file.
  //
  // Measured before the fix, in a real store: the empty name registered with exit 0, `views.ts`
  // built `json_extract(properties_json, '$.')` into an index ON `entries`, and SQLite then
  // evaluated that expression for EVERY insert -- so recording an unrelated, healthy type failed
  // with `bad JSON path: '$.'`. `types list` and `types brief` still exited 0, so the store looked
  // fine; entries are immutable and types cannot be deleted, so there was no repair at all.
  //
  // The defect is asserted through the write path rather than by inspecting the spec, because the
  // spec being wrong is only interesting for what it does to `entries`.

  it('refuses an empty property name, and leaves nothing behind', () => {
    withStore((store) => {
      expect(() =>
        registerType(
          store.db,
          { name: 'emptyname', properties: [{ name: '', type: 'text' }] },
          { registeredAt: AT },
        ),
      ).toThrow(UnusableDefinitionError);

      expect(rowCount(store)).toBe(0);
      // The index is the mechanism, so it is what this asserts: an expression index over an empty
      // JSON path is refused before it exists, rather than created and then complained about.
      const badPath = store.db
        .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%$.%'")
        .all() as unknown as { name: string }[];
      expect(badPath).toEqual([]);
    });
  });

  it('leaves the store able to record an UNRELATED type, which is what the defect destroyed', () => {
    withStore((store) => {
      expect(() =>
        registerType(
          store.db,
          { name: 'emptyname', properties: [{ name: '', type: 'text' }] },
          { registeredAt: AT },
        ),
      ).toThrow(UnusableDefinitionError);

      // The regression proper. With the empty name registered, this line threw
      // `bad JSON path: '$.'` -- for a type that has nothing to do with the broken one.
      registerType(store.db, spec(), { registeredAt: AT });
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed' },
        { id: 'e1', recordedAt: AT, ascendVersion: '0.0.0' },
      );

      expect(entry.typeName).toBe('review_completed');
    });
  });

  it('refuses an empty type name with a message a caller can act on, not a raw CHECK', () => {
    withStore((store) => {
      let thrown: unknown;
      try {
        registerType(
          store.db,
          { name: '', properties: [{ name: 'count', type: 'integer' }] },
          { registeredAt: AT },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnusableDefinitionError);
      const refused = thrown as UnusableDefinitionError;
      expect(refused.message).toContain("type name '' canonicalizes to empty");
      // There is no type name to quote here, so the header must not try: the alternative reads
      // "problem(s) make '' unusable", a sentence about nothing.
      expect(refused.message).toContain('make this definition unusable');
      expect(rowCount(store)).toBe(0);
    });
  });
});

describe('two properties that are one name are refused, not silently thinned to one', () => {
  // asc-4if. Measured on the real binary before the fix, this exact document exited 0, registered
  // ONE property, kept the NUMBER, and dropped the author's text declaration. `asc types show`
  // then printed only the survivor, so the store's own record contradicted the document that had
  // been submitted -- and nothing said a declaration had been discarded. A stored shape that
  // disagrees with the submitted document is the false-green class, so this is a refusal now.

  it('refuses a mixed-type collision, so the LAST declaration cannot silently win', () => {
    withStore((store) => {
      expect(() =>
        registerType(
          store.db,
          {
            name: 'rc',
            properties: [
              { name: 'review_kind', type: 'text' },
              { name: 'reviewKind', type: 'number' },
            ],
          },
          { registeredAt: AT },
        ),
      ).toThrow(UnusableDefinitionError);

      // No row and no view, so there is no surviving shape left to disagree with the document.
      // The view is the assertion that matters: it is what would have carried the winning type
      // out to `entries`.
      expect(rowCount(store)).toBe(0);
      expect(findType(store.db, 'rc')).toBeUndefined();
      const views = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
        .all() as unknown as { name: string }[];
      expect(views).toEqual([]);
    });
  });

  it('tells the author that two of their declarations were one name, naming both spellings', () => {
    withStore((store) => {
      let thrown: unknown;
      try {
        registerType(
          store.db,
          {
            name: 'rc',
            properties: [
              { name: 'review_kind', type: 'text' },
              { name: 'reviewKind', type: 'number' },
            ],
          },
          { registeredAt: AT },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnusableDefinitionError);
      const refused = thrown as UnusableDefinitionError;
      // Both spellings, because the fold that made them one name is exactly what is invisible to
      // the person who typed only one of them.
      expect(refused.message).toContain("'review_kind'");
      expect(refused.message).toContain("'reviewKind'");
      expect(refused.message).toContain('Rename one of them');
      expect(rowCount(store)).toBe(0);
    });
  });
});

describe('deprecation is a status, not a version', () => {
  it('marks the type deprecated without adding a version', () => {
    // Entries recorded under a deprecated type stay valid and stay queryable. Deleting
    // or rewriting them is the thing the whole store exists to prevent.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const changed = deprecateType(store.db, 'review_completed');

      expect(changed).toBe(1);
      expect(findType(store.db, 'review_completed')?.status).toBe('deprecated');
      expect(rowCount(store)).toBe(1);
    });
  });

  it('is idempotent -- deprecating twice changes one row, not two', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(deprecateType(store.db, 'review_completed')).toBe(1);
      expect(deprecateType(store.db, 'review_completed')).toBe(0);
    });
  });

  it('deprecates only the named type', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      registerType(store.db, { name: 'review_started', properties: [] }, { registeredAt: AT });

      deprecateType(store.db, 'review_completed');

      expect(findType(store.db, 'review_completed')?.status).toBe('deprecated');
      expect(findType(store.db, 'review_started')?.status).toBe('active');
    });
  });

  it('reports zero for a type that is not registered, rather than throwing', () => {
    withStore((store) => {
      expect(deprecateType(store.db, 'never_defined')).toBe(0);
    });
  });

  it('asc-9bd: a shape change to a deprecated type keeps the new version deprecated', () => {
    // Reproduces the bead's own repro exactly: define, deprecate, then change the shape.
    // Before the fix, the new-version INSERT never named a `status` column, so it took the
    // DDL's bare `DEFAULT 'active'` regardless of what the type being versioned was -- the
    // status this asserts is the whole bug, not merely that a version was minted.
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      deprecateType(store.db, 'review_completed');
      expect(findType(store.db, 'review_completed')?.status).toBe('deprecated');

      const result = registerType(store.db, spec([{ name: 'extra', type: 'string' }]), {
        registeredAt: LATER,
      });

      expect(result.outcome).toBe('created');
      expect(result.version).toBe(2);
      const after = findType(store.db, 'review_completed');
      expect(after?.version).toBe(2);
      expect(after?.status).toBe('deprecated');
      // Every version of the family stays deprecated, not just the latest -- there is only one
      // `status` per name in this schema, and v1 must not now disagree with v2 about it.
      expect(typeVersions(store.db, 'review_completed').map((v) => v.status)).toEqual([
        'deprecated',
        'deprecated',
      ]);
    });
  });

  it('asc-9bd: says so, rather than leaving the reactivation-that-did-not-happen undiscoverable', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      deprecateType(store.db, 'review_completed');

      const result = registerType(store.db, spec([{ name: 'extra', type: 'string' }]), {
        registeredAt: LATER,
      });

      expect(result.warnings.some((warning) => warning.includes('deprecated'))).toBe(true);
    });
  });

  it('asc-9bd: a shape change to an ACTIVE type is unaffected -- stays active as before', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      const result = registerType(store.db, spec([{ name: 'extra', type: 'string' }]), {
        registeredAt: LATER,
      });

      expect(findType(store.db, 'review_completed')?.status).toBe('active');
      expect(result.warnings.some((warning) => warning.includes('deprecated'))).toBe(false);
    });
  });
});

describe('updateTypeProse opens its own transaction around the read and the write (asc-vnn)', () => {
  /**
   * `updateTypeProse` used to read `existing`, merge in JS, and issue a bare UPDATE with no
   * `BEGIN IMMEDIATE` -- a read-modify-write with no lock spanning the two, which is the class
   * of race `registerType`'s own transaction restructure (this file, above) closed for
   * registration. These tests assert the transaction-join CONTRACT the fix adds -- the same
   * contract `registerType` is tested against just above -- not a genuine cross-process race:
   * the bead this closes says plainly that a same-process simulation would not exercise the
   * real lock/snapshot behaviour honestly, and no test here claims to.
   */
  const assertNoOpenTransaction = (store: Store): void => {
    expect(store.db.isTransaction).toBe(false);
    store.db.exec('BEGIN');
    store.db.exec('ROLLBACK');
  };

  it('releases the lock after updating prose', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      updateTypeProse(store.db, 'review_completed', 1, { description: 'edited' });
      assertNoOpenTransaction(store);
    });
  });

  it('releases the lock even when the update is refused', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(() => {
        updateTypeProse(store.db, 'review_completed', 1, { propertyProse: { nope: 'x' } });
      }).toThrow(UnusableProseError);
      assertNoOpenTransaction(store);
    });
  });

  it("joins a caller's transaction instead of committing it", () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      withTransaction(store.db, () => {
        updateTypeProse(store.db, 'review_completed', 1, { description: 'joined' });
        // Still open -- ending it here would be updateTypeProse deciding the fate of a
        // transaction it did not open.
        expect(store.db.isTransaction).toBe(true);
      });
      expect(store.db.isTransaction).toBe(false);
      expect(findType(store.db, 'review_completed')?.description).toBe('joined');
    });
  });

  it("a caller's ROLLBACK takes the prose update with it", () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, description: 'original' });
      withRollback(store.db, () => {
        updateTypeProse(store.db, 'review_completed', 1, { description: 'rolled back' });
        expect(findType(store.db, 'review_completed')?.description).toBe('rolled back');
      });
      expect(findType(store.db, 'review_completed')?.description).toBe('original');
      expect(store.db.isTransaction).toBe(false);
    });
  });
});

describe('guidance (asc-bli.3): stored beside the shape, never inside it', () => {
  const GUIDANCE = {
    purpose: 'why reviews are recorded',
    analysis_questions: ['which kinds of review find the most?'],
    interpretation_notes: 'count is findings, not comments',
    review_after: 20,
  } as const;

  it('stores guidance given at registration and reads it back', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, guidance: GUIDANCE });
      expect(findType(store.db, 'review_completed', 1)?.guidance).toEqual(GUIDANCE);
    });
  });

  it('reads back as an empty object, not null, when none was declared', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT });
      expect(findType(store.db, 'review_completed', 1)?.guidance).toEqual({});
      expect(
        store.db.prepare('SELECT guidance_json FROM entry_types').get()?.['guidance_json'],
      ).toBeNull();
    });
  });

  it('does not reach the hash: the same shape with different guidance is unchanged, not a version', () => {
    // The load-bearing regression test from asc-bli.2. If guidance ever leaked into
    // definitionShape, this is the test that says so.
    withStore((store) => {
      const first = registerType(store.db, spec(), { registeredAt: AT, guidance: GUIDANCE });
      const again = registerType(store.db, spec(), {
        registeredAt: LATER,
        guidance: { ...GUIDANCE, purpose: 'a different reason entirely' },
      });

      expect(again.outcome).toBe('unchanged');
      expect(again.version).toBe(1);
      expect(again.typeHash).toBe(first.typeHash);
      expect(rowCount(store)).toBe(1);
    });
  });

  it('refuses unusable guidance at registration and writes nothing', () => {
    withStore((store) => {
      expect(() =>
        registerType(store.db, spec(), { registeredAt: AT, guidance: { review_after: 0 } }),
      ).toThrow(UnusableProseError);
      expect(rowCount(store)).toBe(0);
    });
  });

  it('updates guidance field by field: an omitted field is kept, null clears one', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, guidance: GUIDANCE });
      const hashBefore = findType(store.db, 'review_completed', 1)?.typeHash;

      updateTypeProse(store.db, 'review_completed', 1, {
        guidance: { purpose: 'edited', review_after: null },
      });

      const row = findType(store.db, 'review_completed', 1);
      expect(row?.guidance).toEqual({
        purpose: 'edited',
        analysis_questions: GUIDANCE.analysis_questions,
        interpretation_notes: GUIDANCE.interpretation_notes,
      });
      expect(row?.typeHash).toBe(hashBefore);
      expect(rowCount(store)).toBe(1);
    });
  });

  it('stores NULL again once every field has been cleared', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, guidance: { purpose: 'p' } });
      updateTypeProse(store.db, 'review_completed', 1, { guidance: { purpose: null } });
      expect(
        store.db.prepare('SELECT guidance_json FROM entry_types').get()?.['guidance_json'],
      ).toBeNull();
    });
  });

  it('refuses unusable guidance on update and leaves the stored guidance alone', () => {
    withStore((store) => {
      registerType(store.db, spec(), { registeredAt: AT, guidance: GUIDANCE });
      expect(() => {
        updateTypeProse(store.db, 'review_completed', 1, { guidance: { analysis_questions: [] } });
      }).toThrow(UnusableProseError);
      expect(findType(store.db, 'review_completed', 1)?.guidance).toEqual(GUIDANCE);
    });
  });
});
