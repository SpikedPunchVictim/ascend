import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PropertySpec, TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deprecateType,
  findType,
  openStore,
  registerType,
  typeVersions,
  updateTypeProse,
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
});
