import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  entryStates,
  groupEntries,
  GroupKeyCountError,
  GroupTopKError,
  openStore,
  PredicateError,
  recordEntry,
  registerType,
  TOP_K,
  UngroupablePropertyError,
  UnknownGroupKeyError,
  UnknownTypeError,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * `groupEntries` -- a contingency table over one or two declared properties.
 *
 * The failure this module can have is not a crash: it is a table that looks like a real
 * crosstab and answers a different question than the one asked. Three things are worth reading
 * closely, mirroring `profile.test.ts`'s own three:
 *
 *   1. **`covered` sums to what `cells` actually holds, and equals `total` unless a `topK` cap
 *      withheld something.** An entry with no measured value for a key is a CELL, not a drop.
 *   2. **`topK` is chosen per axis from marginal counts, not from cell counts.** A value common
 *      overall but spread thin against the other axis must survive, and a value rare overall but
 *      clustered into one big cell must not win on that cell's size alone.
 *   3. **A boolean group key reads `true`/`false`.** `asc-6wn`'s defect (SQLite's own `0`/`1`
 *      leaking past `renderDeclaredValue`) has one call site fixed and one newly added here.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-crosstab-'));
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
    { name: 'findings', type: 'integer' },
    { name: 'notes', type: 'text' },
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

describe('groupEntries: which properties can be grouped', () => {
  it('refuses a range property, naming it, its declared type, and its summary', () => {
    withStore((store) => {
      let caught: unknown;
      try {
        groupEntries(store.db, { type: SPEC.name, keys: ['findings'] });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UngroupablePropertyError);
      const error = caught as UngroupablePropertyError;
      expect(error.property).toBe('findings');
      expect(error.declaredType).toBe('integer');
      expect(error.summary).toBe('range');
    });
  });

  it('refuses a cardinality property', () => {
    withStore((store) => {
      expect(() => groupEntries(store.db, { type: SPEC.name, keys: ['notes'] })).toThrow(
        UngroupablePropertyError,
      );
    });
  });

  it('refuses a key naming no declared property', () => {
    withStore((store) => {
      let caught: unknown;
      try {
        groupEntries(store.db, { type: SPEC.name, keys: ['not_a_property'] });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UnknownGroupKeyError);
      expect((caught as UnknownGroupKeyError).property).toBe('not_a_property');
    });
  });

  it('accepts enum, boolean, string and ref -- the four summaryFor(top) types', () => {
    const spec: TypeSpec = {
      name: 'four_top_types',
      properties: [
        { name: 'e', type: 'enum', enum_values: ['a', 'b'] },
        { name: 'b', type: 'boolean' },
        { name: 's', type: 'string' },
        { name: 'r', type: 'ref' },
      ],
    };
    withStore(
      (store) => {
        recordEntry(
          store.db,
          { type: spec.name, properties: { e: 'a', b: true, s: 'x', r: 'other:1' } },
          context('e1'),
        );
        for (const key of ['e', 'b', 's', 'r']) {
          expect(() => groupEntries(store.db, { type: spec.name, keys: [key] })).not.toThrow();
        }
      },
      [spec],
    );
  });
});

describe('groupEntries: an unregistered type', () => {
  it('throws UnknownTypeError -- there is no falsy GroupResult to report it with', () => {
    withStore((store) => {
      expect(() => groupEntries(store.db, { type: 'never_defined', keys: ['outcome'] })).toThrow(
        UnknownTypeError,
      );
    });
  });
});

describe('groupEntries: request shape validation', () => {
  it.each([0, 3])('refuses %i keys', (count) => {
    withStore((store) => {
      let caught: unknown;
      try {
        groupEntries(store.db, { type: SPEC.name, keys: Array(count).fill('outcome') as string[] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GroupKeyCountError);
      expect((caught as GroupKeyCountError).count).toBe(count);
    });
  });

  it.each([0, -1, 1.5])('refuses a topK of %s', (topK) => {
    withStore((store) => {
      expect(() => groupEntries(store.db, { type: SPEC.name, keys: ['outcome'], topK })).toThrow(
        GroupTopKError,
      );
    });
  });
});

describe('groupEntries: a boolean key renders true/false, not 0/1 (asc-6wn)', () => {
  it('groups a boolean property by its rendered value', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { flagged: true } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { flagged: true } }, context('e2'));
      recordEntry(store.db, { type: SPEC.name, properties: { flagged: false } }, context('e3'));

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['flagged'] });

      expect(result.cells).toStrictEqual([
        { values: [{ value: 'true', state: 'measured' }], count: 2 },
        { values: [{ value: 'false', state: 'measured' }], count: 1 },
      ]);
      expect(result.total).toBe(3);
      expect(result.covered).toBe(3);
    });
  });
});

describe('groupEntries: every entry lands in exactly one cell', () => {
  it('groups an entry with no measured value under its state, value null, and covers it', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'amy' } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, na: ['reviewer'] }, context('e2'));
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e3'));

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer'] });

      expect(result.total).toBe(3);
      // Nothing was withheld (distinct 3 <= default TOP_K), so covered is the whole population --
      // the measured entry, the explicit N/A, and the never-measured one all appear in a cell.
      expect(result.covered).toBe(3);
      expect(result.cells).toStrictEqual([
        { values: [{ value: 'amy', state: 'measured' }], count: 1 },
        { values: [{ value: null, state: 'not_applicable' }], count: 1 },
        { values: [{ value: null, state: 'not_measured' }], count: 1 },
      ]);
    });
  });

  /**
   * `not_declared` and `not_measured` stay SEPARATE cells, on purpose (overruling an earlier
   * draft of this store layer, which collapsed them).
   *
   * From inside one entry the two look identical -- no decision was ever recorded -- but a group
   * key is read across a population, and across a population they name different populations:
   * `not_measured` is a row the question was askable of and nobody answered, `not_declared` is a
   * row the question was not askable of at all. This is the exact shape `asc-5x7` measured as a
   * real defect: a property declared only in v2, with far more v1 entries than v2 ones, folded to
   * one `not_measured` bucket reads as "nobody measures this" when most of those rows could not
   * have. The fixture below is that shape (five v1 entries outnumbering the v2 ones) specifically
   * so this test fails if `not_declared` and `not_measured` are ever folded back together.
   */
  it('keeps not_declared and not_measured as separate cells, in the asc-5x7 shape', () => {
    const v2: TypeSpec = {
      name: SPEC.name,
      properties: [...SPEC.properties, { name: 'second_look', type: 'boolean' }],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      // v1 does not declare `second_look` at all -- `not_declared` at the SQL layer -- and
      // outnumbers the v2 entries below, the asc-5x7 shape: collapsing here is where a reader
      // would wrongly conclude "nobody measures this".
      for (let i = 0; i < 5; i += 1) {
        recordEntry(store.db, { type: SPEC.name, properties: {} }, context(`e-v1-${String(i)}`));
      }

      registerType(store.db, v2, { registeredAt: AT });
      // v2 declares it; these entries are recorded against v2 (the latest version), and this one
      // is genuinely `not_measured`: the question WAS askable of it, and nobody answered.
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e-v2-unset'));
      recordEntry(store.db, { type: SPEC.name, na: ['second_look'] }, context('e-v2-na'));
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { second_look: true } },
        context('e-v2-true'),
      );
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { second_look: false } },
        context('e-v2-false'),
      );

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['second_look'] });

      expect(result.total).toBe(9);
      expect(result.covered).toBe(9);
      // Five distinct (value, state) pairs, not four: `not_declared` and `not_measured` count
      // separately, exactly the count `profileType`'s own `StateCounts` would report for this
      // property (asc-6wn's "asc explore disagreeing with itself" defect, avoided here).
      expect(result.axes).toStrictEqual([{ key: 'second_look', distinct: 5, kept: 5 }]);
      // Descending by count (the five `not_declared` v1 rows are the largest bucket), then
      // ascending by rendered value, with the three null-valued buckets sorted after every real
      // value and, between themselves, by state name.
      expect(result.cells).toStrictEqual([
        { values: [{ value: null, state: 'not_declared' }], count: 5 },
        { values: [{ value: 'false', state: 'measured' }], count: 1 },
        { values: [{ value: 'true', state: 'measured' }], count: 1 },
        { values: [{ value: null, state: 'not_applicable' }], count: 1 },
        { values: [{ value: null, state: 'not_measured' }], count: 1 },
      ]);
    } finally {
      store.close();
    }
  });
});

/**
 * `entryStates` -- the composition `asc explore --select` calls instead of reading
 * `RecordedEntry.states` itself.
 *
 * The one fact worth testing directly, because it is the whole reason this function exists: every
 * requested property has a key for every entry, and `not_declared` is one of the VALUES a key can
 * hold, never a key that is simply missing. The asc-5x7 fixture is reused from the `groupEntries`
 * test above -- the same v1/v2 shape, this time read entry-by-entry instead of as a population
 * tally.
 */
describe('entryStates: a four-state answer per property, per entry', () => {
  const v2: TypeSpec = {
    name: SPEC.name,
    properties: [...SPEC.properties, { name: 'second_look', type: 'boolean' }],
  };

  it('answers not_declared for a v1 entry and the right three-state answer for v2 entries', () => {
    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      // v1 never declared `second_look` -- this entry cannot answer the question at all, and
      // `RecordedEntry.states` for it has no 'second_look' key (asc-5x7's confirmed shape).
      const v1 = recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e-v1')).entry;

      registerType(store.db, v2, { registeredAt: AT });
      const v2Unset = recordEntry(
        store.db,
        { type: SPEC.name, properties: {} },
        context('e-v2-unset'),
      ).entry;
      const v2Na = recordEntry(
        store.db,
        { type: SPEC.name, na: ['second_look'] },
        context('e-v2-na'),
      ).entry;
      const v2True = recordEntry(
        store.db,
        { type: SPEC.name, properties: { second_look: true } },
        context('e-v2-true'),
      ).entry;

      const result = entryStates(store.db, SPEC.name, [v1, v2Unset, v2Na, v2True], ['second_look']);

      // `toEqual`, not `toStrictEqual`: each record is built with `Object.create(null)` (the same
      // choice `validateEntry`'s own `states` makes, and for the same reason -- a property named
      // `__proto__` or `hasOwnProperty` must still resolve as an own key), so it has no
      // `Object.prototype` for `toStrictEqual`'s prototype check to match against a `{}` literal.
      expect(result).toEqual([
        { second_look: 'not_declared' },
        { second_look: 'not_measured' },
        { second_look: 'not_applicable' },
        { second_look: 'measured' },
      ]);
    } finally {
      store.close();
    }
  });

  it('every requested property has a key for every entry, even ones the entry never declared', () => {
    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      const v1 = recordEntry(
        store.db,
        { type: SPEC.name, properties: { reviewer: 'amy' } },
        context('e-v1'),
      ).entry;
      registerType(store.db, v2, { registeredAt: AT });

      const result = entryStates(store.db, SPEC.name, [v1], ['reviewer', 'second_look']);

      // The whole contract in one assertion: both keys are present, `reviewer` measured (v1
      // declares it) and `second_look` not_declared (v1 does not) -- never a missing key for
      // either, regardless of which version the entry itself was recorded against.
      expect(result).toEqual([{ reviewer: 'measured', second_look: 'not_declared' }]);
      expect(Object.hasOwn(result[0] as object, 'reviewer')).toBe(true);
      expect(Object.hasOwn(result[0] as object, 'second_look')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('refuses a property name no registered version declares', () => {
    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      const v1 = recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e-v1')).entry;

      expect(() => entryStates(store.db, SPEC.name, [v1], ['not_a_property'])).toThrow(
        UnknownGroupKeyError,
      );
    } finally {
      store.close();
    }
  });
});

describe('groupEntries: topK withholds per axis, chosen by marginal counts', () => {
  it('reports distinct, kept and a shrunken covered when a single key exceeds topK', () => {
    withStore((store) => {
      ['a', 'b', 'c', 'd', 'e'].forEach((reviewer, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer } },
          context(`e${String(index)}`),
        );
      });

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer'], topK: 2 });

      expect(result.total).toBe(5);
      expect(result.axes).toStrictEqual([{ key: 'reviewer', distinct: 5, kept: 2 }]);
      expect(result.cells).toHaveLength(2);
      // Every value occurs once, so the tie is broken by ascending value: 'a' and 'b' survive.
      expect(result.cells.map((cell) => cell.values[0]?.value)).toStrictEqual(['a', 'b']);
      expect(result.covered).toBe(2);
    });
  });

  it('defaults topK to TOP_K when the caller does not name one', () => {
    withStore((store) => {
      const reviewers = Array.from({ length: TOP_K + 2 }, (_, index) => `r${String(index)}`);
      reviewers.forEach((reviewer, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer } },
          context(`e${String(index)}`),
        );
      });

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer'] });

      expect(result.axes).toStrictEqual([{ key: 'reviewer', distinct: TOP_K + 2, kept: TOP_K }]);
      expect(result.cells).toHaveLength(TOP_K);
    });
  });

  /**
   * The decision this whole rule exists to protect (asc-56k decision 5): 'amy' occurs 5 times
   * overall, spread across two outcomes (3 + 2), so no single (amy, outcome) cell reaches 4.
   * 'bob' occurs only 4 times overall, but all 4 land in one cell. Picking `topK: 1` by CELL size
   * would keep 'bob' (its one cell of 4 beats amy's largest cell of 3); picking by MARGINAL count
   * -- what this function does -- keeps 'amy' (5 > 4) instead, and 'bob' does not appear in any
   * cell at all.
   */
  it('keeps the marginally common value even when every one of its cells is smaller', () => {
    withStore((store) => {
      let id = 0;
      const record = (reviewer: string, outcome: string): void => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer, outcome } },
          context(`e${String(id)}`),
        );
        id += 1;
      };

      for (let i = 0; i < 3; i += 1) record('amy', 'approved');
      for (let i = 0; i < 2; i += 1) record('amy', 'rejected');
      for (let i = 0; i < 4; i += 1) record('bob', 'approved');

      const result = groupEntries(store.db, {
        type: SPEC.name,
        keys: ['reviewer', 'outcome'],
        topK: 1,
      });

      expect(result.axes).toStrictEqual([
        { key: 'reviewer', distinct: 2, kept: 1 },
        { key: 'outcome', distinct: 2, kept: 1 },
      ]);
      expect(result.total).toBe(9);
      // Only the (amy, approved) cell survives both axes' caps; 'bob' is gone even though its own
      // cell (4) was the single largest cell in the whole table.
      expect(result.cells).toStrictEqual([
        {
          values: [
            { value: 'amy', state: 'measured' },
            { value: 'approved', state: 'measured' },
          ],
          count: 3,
        },
      ]);
      expect(result.covered).toBe(3);
    });
  });
});

describe('groupEntries: a two-key joint table', () => {
  it('orders cells the same way a single-key table is ordered: count desc, then value asc', () => {
    withStore((store) => {
      let id = 0;
      const record = (reviewer: string, outcome: string): void => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer, outcome } },
          context(`e${String(id)}`),
        );
        id += 1;
      };

      record('amy', 'approved');
      record('amy', 'approved');
      record('amy', 'rejected');
      record('bob', 'rejected');

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer', 'outcome'] });

      expect(result.total).toBe(4);
      expect(result.covered).toBe(4);
      expect(result.cells).toStrictEqual([
        {
          values: [
            { value: 'amy', state: 'measured' },
            { value: 'approved', state: 'measured' },
          ],
          count: 2,
        },
        {
          values: [
            { value: 'amy', state: 'measured' },
            { value: 'rejected', state: 'measured' },
          ],
          count: 1,
        },
        {
          values: [
            { value: 'bob', state: 'measured' },
            { value: 'rejected', state: 'measured' },
          ],
          count: 1,
        },
      ]);
    });
  });

  it('reports values in the order the caller named the keys', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { reviewer: 'amy', outcome: 'approved' } },
        context('e1'),
      );

      const forward = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer', 'outcome'] });
      const reversed = groupEntries(store.db, { type: SPEC.name, keys: ['outcome', 'reviewer'] });

      expect(forward.cells[0]?.values.map((v) => v.value)).toStrictEqual(['amy', 'approved']);
      expect(reversed.cells[0]?.values.map((v) => v.value)).toStrictEqual(['approved', 'amy']);
    });
  });
});

describe('groupEntries: filter narrows the population (asc-56k)', () => {
  it('counts and groups only the entries the filter admits', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { reviewer: 'amy' } },
        context('e1', { cwd: '/proj-a' }),
      );
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { reviewer: 'amy' } },
        context('e2', { cwd: '/proj-b' }),
      );
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { reviewer: 'bob' } },
        context('e3', { cwd: '/proj-a' }),
      );

      const result = groupEntries(store.db, {
        type: SPEC.name,
        keys: ['reviewer'],
        filter: "cwd = '/proj-a'",
      });

      expect(result.total).toBe(2);
      expect(result.covered).toBe(2);
      // The type's FULL population (3), not the filtered `total` (2) -- `unfiltered` is the
      // denominator that tells "the filter excluded some rows" apart from "there is nothing here".
      expect(result.unfiltered).toBe(3);
      expect(result.cells).toStrictEqual([
        { values: [{ value: 'amy', state: 'measured' }], count: 1 },
        { values: [{ value: 'bob', state: 'measured' }], count: 1 },
      ]);
    });
  });

  it('reports unfiltered equal to total when there is no filter', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'amy' } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'bob' } }, context('e2'));

      const result = groupEntries(store.db, { type: SPEC.name, keys: ['reviewer'] });

      expect(result.total).toBe(2);
      expect(result.unfiltered).toBe(2);
    });
  });

  /**
   * The case `unfiltered` exists for, pinned directly: a filter that matches nothing renders
   * `total: 0` identically whether the corpus is empty or the predicate excluded every row.
   * `unfiltered` is the only thing in the result that tells the two apart, so this test fails if
   * it is ever computed FROM the filtered query (which would also be 0) instead of from the type's
   * own population.
   */
  it('reports the real population when the filter matches zero rows', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'amy' } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'bob' } }, context('e2'));

      const result = groupEntries(store.db, {
        type: SPEC.name,
        keys: ['reviewer'],
        filter: "reviewer = 'nobody'",
      });

      expect(result.total).toBe(0);
      expect(result.covered).toBe(0);
      expect(result.unfiltered).toBe(2);
      expect(result.cells).toStrictEqual([]);
    });
  });

  it('refuses a filter that smuggles in a second statement, through wrapPredicate', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { reviewer: 'amy' } }, context('e1'));

      expect(() =>
        groupEntries(store.db, {
          type: SPEC.name,
          keys: ['reviewer'],
          filter: "cwd = 'x'; DROP TABLE entries; --",
        }),
      ).toThrow(PredicateError);
    });
  });
});
