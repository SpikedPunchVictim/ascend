import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openStore,
  PredicateError,
  recordEntry,
  registerType,
  typeFilterScope,
  UnknownTypeError,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * `typeFilterScope` -- the projection `explore --filter`, `pageEntries`'s `filter` option, and
 * `groupEntries`'s `filter` option all run a caller's predicate against, with declared properties
 * as bare columns instead of `json_extract(properties_json, '$.<name>')`.
 *
 * The defect this closes was not a crash, it was `asc explore` disagreeing with itself: a caller
 * could type `--group-by flag` and get a bare name, then type `--filter "flag = true"` for the
 * same property and be told `no such column: flag`. Every test here runs the built statement
 * against a real store rather than only inspecting the returned SQL text, because that is the only
 * way the defect was visible in the first place.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-type-filter-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

const SPEC: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'flagged', type: 'boolean' },
    { name: 'reviewer', type: 'string' },
  ],
};

const context = (id: string, overrides: Partial<RecordContext> = {}): RecordContext => ({
  id,
  recordedAt: AT,
  ascendVersion: '0.0.0',
  ...overrides,
});

const withStore = <T>(body: (store: Store) => T, specs: readonly TypeSpec[] = [SPEC]): T => {
  const store = openStore({ dir: tempDir() });
  try {
    for (const spec of specs) registerType(store.db, spec, { registeredAt: AT });
    return body(store);
  } finally {
    store.close();
  }
};

/** Run a `typeFilterScope` statement and return the ids it matched, sorted for a stable assertion. */
const ids = (store: Store, scope: string): readonly string[] =>
  (store.db.prepare(scope).all() as { id: string }[]).map((row) => row.id).sort();

describe('typeFilterScope: declared properties as bare columns', () => {
  it('matches a boolean property by bare name, true and false separately', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { flagged: true } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { flagged: false } }, context('e2'));

      expect(ids(store, typeFilterScope(store.db, SPEC.name, 'flagged = true'))).toStrictEqual([
        'e1',
      ]);
      expect(ids(store, typeFilterScope(store.db, SPEC.name, 'flagged = false'))).toStrictEqual([
        'e2',
      ]);
    });
  });

  it('matches an enum property by bare name', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { outcome: 'approved' } },
        context('e1'),
      );
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { outcome: 'rejected' } },
        context('e2'),
      );

      expect(
        ids(store, typeFilterScope(store.db, SPEC.name, "outcome = 'approved'")),
      ).toStrictEqual(['e1']);
    });
  });

  it('matches a string property by bare name', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'amy' } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'bob' } }, context('e2'));

      expect(ids(store, typeFilterScope(store.db, SPEC.name, "reviewer = 'amy'"))).toStrictEqual([
        'e1',
      ]);
    });
  });

  it('still compares an envelope column bare, unaffected by the property projection', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e1', { cwd: '/a' }));
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e2', { cwd: '/b' }));

      expect(ids(store, typeFilterScope(store.db, SPEC.name, "cwd = '/a'"))).toStrictEqual(['e1']);
      expect(
        ids(store, typeFilterScope(store.db, SPEC.name, `type_name = '${SPEC.name}'`)),
      ).toStrictEqual(['e1', 'e2']);
    });
  });

  /**
   * The asc-5x7 shape again: `second_look` is declared only in v2. `json_extract` of an absent
   * path is NULL on the v1 row exactly as it would be for a genuinely unmeasured v2 row -- this
   * test only asserts the half of that which is testable through a filter (a NULL never equals
   * `true`), not that the two are distinguishable through one. They are not, and that is the
   * point `typeFilterScope`'s own file comment makes: a filter is a row selector, and it is
   * `groupEntries`/`entryStates` that still tell the two states apart.
   */
  it('a property declared only in v2 does not match a v1 row', () => {
    const v2: TypeSpec = {
      name: SPEC.name,
      properties: [...SPEC.properties, { name: 'second_look', type: 'boolean' }],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e-v1'));

      registerType(store.db, v2, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { second_look: true } },
        context('e-v2'),
      );

      expect(ids(store, typeFilterScope(store.db, SPEC.name, 'second_look = true'))).toStrictEqual([
        'e-v2',
      ]);
    } finally {
      store.close();
    }
  });

  it('refuses a filter that smuggles in a second statement', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e1'));

      expect(() => typeFilterScope(store.db, SPEC.name, '1=1); DELETE FROM entries; --')).toThrow(
        PredicateError,
      );
    });
  });

  it('refuses a type nobody registered', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(() => typeFilterScope(store.db, 'nope', '1=1')).toThrow(UnknownTypeError);
    } finally {
      store.close();
    }
  });
});
