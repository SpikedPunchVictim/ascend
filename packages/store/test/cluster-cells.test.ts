import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clusterCells,
  ClusterCellsError,
  openStore,
  profileType,
  recordEntry,
  recordInvalidation,
  registerType,
  type ClusterCells,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * `clusterCells` -- the per-cluster counts behind `asc explore --cluster` (asc-0hys).
 *
 * The defect this module can have is not a crash. It is cells that sum to a number the profile does
 * not agree with: the correction would then be computed at a denominator the row above it never
 * reported, which is the failure `wilson` refuses outright (Stage 2). So the load-bearing test here
 * is the AGREEMENT one -- every property's cells, summed, against `profileType`'s own `states` --
 * and it is written against the profile rather than against a hand-count so that the two read paths
 * are compared to each other rather than each to my arithmetic.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-cluster-cells-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-10-04T10:00:00.000Z';

const SPEC: TypeSpec = {
  name: 'tool_denial',
  properties: [
    { name: 'tool_name', type: 'string' },
    { name: 'session_id', type: 'string' },
    { name: 'denial_kind', type: 'enum', enum_values: ['blocked', 'unavailable'] },
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

/** Record one entry and return nothing -- the id is the only thing the fixtures vary. */
const record = (
  store: Store,
  id: string,
  properties: Readonly<Record<string, unknown>>,
  na?: readonly string[],
): void => {
  recordEntry(
    store.db,
    { type: 'tool_denial', properties, ...(na === undefined ? {} : { na }) },
    context(id),
  );
};

/**
 * A fixture with a shape chosen so every arm of the state model is reachable AND the clusters are
 * uneven -- the whole point is that a session contributes several entries, so a fixture where every
 * cluster is a singleton would make the correction look like it works when it can only ever be 1.
 *
 *   s1: Bash/blocked, Bash/blocked, Write/unavailable     (3 entries)
 *   s2: Bash/unavailable, Edit (denial_kind n/a)          (2 entries)
 *   s3: Bash/blocked, Write/blocked, Write/unavailable    (3 entries)
 *   s4: Read only (tool_name declared, not measured)
 *
 * N = 9. `denial_kind` is declared by version 1, so `not_declared` is unreachable here -- reachable
 * only across versions, which the agreement test also covers by profiling rather than by counting.
 */
const fixture = (body: (store: Store) => void): void => {
  withStore((store) => {
    record(store, 'a', { tool_name: 'Bash', session_id: 's1', denial_kind: 'blocked' });
    record(store, 'b', { tool_name: 'Bash', session_id: 's1', denial_kind: 'blocked' });
    record(store, 'c', { tool_name: 'Write', session_id: 's1', denial_kind: 'unavailable' });
    record(store, 'd', { tool_name: 'Bash', session_id: 's2', denial_kind: 'unavailable' });
    record(store, 'e', { tool_name: 'Edit', session_id: 's2' }, ['denial_kind']);
    record(store, 'f', { tool_name: 'Bash', session_id: 's3', denial_kind: 'blocked' });
    record(store, 'g', { tool_name: 'Write', session_id: 's3', denial_kind: 'blocked' });
    record(store, 'h', { tool_name: 'Write', session_id: 's3', denial_kind: 'unavailable' });
    record(store, 'i', { session_id: 's4' });
    body(store);
  });
};

/** The cells for one property, as `[state, value, cluster, count]`, sorted so order is not a test. */
const cellsOf = (cells: ClusterCells, property: string): string[] =>
  cells.properties
    .filter((cell) => cell.property === property)
    .map(
      (cell) => `${cell.state}|${String(cell.value)}|${String(cell.cluster)}|${String(cell.count)}`,
    )
    .sort();

describe('clusterCells: the cells agree with the profile they will correct', () => {
  it('sums to the profile state tallies, over every property', () => {
    // THE test of this module. The design a row is corrected with is `n`-checked by `wilson`, so
    // cells that disagree with `profileType` do not produce a wrong interval -- they produce a
    // refusal. That makes this a guard on the SHAPE of the data, not on the arithmetic, and it is
    // why it is written against `profileType` rather than against a hand count.
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      const profile = profileType(store.db, 'tool_denial');
      expect(cells).toBeDefined();
      expect(profile).toBeDefined();
      if (cells === undefined || profile === undefined) return;

      for (const property of profile.properties) {
        const byState = new Map<string, number>();
        for (const cell of cells.properties) {
          if (cell.property !== property.name) continue;
          byState.set(cell.state, (byState.get(cell.state) ?? 0) + cell.count);
        }
        expect(
          {
            measured: byState.get('measured') ?? 0,
            not_applicable: byState.get('not_applicable') ?? 0,
            not_measured: byState.get('not_measured') ?? 0,
            not_declared: byState.get('not_declared') ?? 0,
          },
          property.name,
        ).toEqual(property.states);
      }
    });
  });

  it('counts every entry of the scope exactly once, per property', () => {
    // `not_declared` is a share of the type's TOTAL, so the four states must partition the scope.
    // A cell set that dropped a state would leave an interval computed over a smaller population
    // than the row it corrects.
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      expect(cells).toBeDefined();
      if (cells === undefined) return;
      for (const property of ['tool_name', 'session_id', 'denial_kind']) {
        const total = cells.properties
          .filter((cell) => cell.property === property)
          .reduce((sum, cell) => sum + cell.count, 0);
        expect(total, property).toBe(9);
      }
    });
  });

  it('splits each state across clusters rather than reporting it whole', () => {
    // A "correction" that returned one cluster per type would pass every sum above and correct
    // nothing. `tool_name=Write` is the cell that catches it: 3 entries, in s1 (1) and s3 (2).
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      expect(cells).toBeDefined();
      if (cells === undefined) return;
      expect(cellsOf(cells, 'tool_name')).toEqual(
        [
          'measured|Bash|s1|2',
          'measured|Bash|s2|1',
          'measured|Bash|s3|1',
          'measured|Write|s1|1',
          'measured|Write|s3|2',
          'measured|Edit|s2|1',
          'not_measured|null|s4|1',
        ].sort(),
      );
    });
  });
});

describe('clusterCells: the states a value can be in', () => {
  it('reports a not-measured entry as its own state, not as a missing value of a real one', () => {
    // `Edit` is not a value of `tool_name` -- it is an entry that never got one. Merging the two
    // would make a top-value row's population larger than the measured count the row reports.
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      if (cells === undefined) throw new Error('expected cells');
      const notMeasured = cells.properties.filter(
        (cell) => cell.property === 'tool_name' && cell.state === 'not_measured',
      );
      expect(notMeasured).toEqual([
        { property: 'tool_name', state: 'not_measured', value: null, cluster: 's4', count: 1 },
      ]);
    });
  });

  it('keeps not_applicable apart from not_measured', () => {
    // `entry e` declined `denial_kind` by NAME (na), which is a different fact from never being
    // asked. The two are both "no value" and neither is a value.
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      if (cells === undefined) throw new Error('expected cells');
      const na = cells.properties.filter(
        (cell) => cell.property === 'denial_kind' && cell.state === 'not_applicable',
      );
      expect(na).toEqual([
        { property: 'denial_kind', state: 'not_applicable', value: null, cluster: 's2', count: 1 },
      ]);
    });
  });
});

describe('clusterCells: an entry in no cluster', () => {
  it('surfaces a null cluster key as a null cluster, never dropped and never bucketed', () => {
    // Dropping it would make the design's `n` smaller than the row's `n` silently; bucketing it
    // into a `(none)` cluster would lower the size factor and so NARROW the interval -- invented
    // precision, the direction this whole correction exists to move against. The caller refuses.
    withStore((store) => {
      record(store, 'a', { tool_name: 'Bash', session_id: 's1' });
      record(store, 'b', { tool_name: 'Bash' });
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      if (cells === undefined) throw new Error('expected cells');
      // Every property has one, not just `tool_name`: entry 'b' has no `session_id`, so it is in
      // no cluster for the purposes of ANY row -- including, visibly, the `session_id` row itself.
      expect(
        cells.properties
          .filter((cell) => cell.cluster === null)
          .map(
            (cell) => `${cell.property}|${cell.state}|${String(cell.value)}|${String(cell.count)}`,
          )
          .sort(),
      ).toEqual(
        [
          'denial_kind|not_measured|null|1',
          'session_id|not_measured|null|1',
          'tool_name|measured|Bash|1',
        ].sort(),
      );
      // The entry is still counted: it is in the population, it is just in no cluster.
      const total = cells.properties
        .filter((cell) => cell.property === 'tool_name')
        .reduce((sum, cell) => sum + cell.count, 0);
      expect(total).toBe(2);
    });
  });
});

describe('clusterCells: the invalidations, including the ones that are not invalidations', () => {
  it("reports the entries with no label, which are the aggregate row's population", () => {
    // `invalidatedCounts` drops these rows (`WHERE label IS NOT NULL`) because a count of labelled
    // entries is all it needs. Here they ARE the denominator: the aggregate row's share is of the
    // whole type, so the unlabelled entries have to be countable from the same cells.
    fixture((store) => {
      recordInvalidation(store.db, {
        entryId: 'a',
        label: 'wrong_subject',
        reason: 'recorded about the wrong session entirely',
        createdAt: AT,
      });
      const cells = clusterCells(store.db, 'tool_denial', 'session_id');
      if (cells === undefined) throw new Error('expected cells');
      expect(
        cells.invalidations
          .map((cell) => `${String(cell.label)}|${String(cell.cluster)}|${String(cell.count)}`)
          .sort(),
      ).toEqual(['null|s1|2', 'null|s2|2', 'null|s3|3', 'null|s4|1', 'wrong_subject|s1|1'].sort());
      // The labelled cells are a subset of the population cells -- summed they give 1 of 9, which
      // is the `invalidated` row the profile reports.
      const labelled = cells.invalidations
        .filter((cell) => cell.label !== null)
        .reduce((sum, cell) => sum + cell.count, 0);
      expect(labelled).toBe(1);
      expect(profileType(store.db, 'tool_denial')?.invalidated.count).toBe(1);
    });
  });
});

describe('clusterCells: the scope', () => {
  it('narrows with the same filter the profile narrows with', () => {
    // `--filter` and `--cluster` compose in `explore`, so the cells have to describe the FILTERED
    // population -- a correction computed over the unfiltered one would be the wrong N entirely.
    fixture((store) => {
      const cells = clusterCells(store.db, 'tool_denial', 'session_id', {
        filter: `tool_name = 'Bash'`,
      });
      if (cells === undefined) throw new Error('expected cells');
      expect(cellsOf(cells, 'tool_name')).toEqual(
        ['measured|Bash|s1|2', 'measured|Bash|s2|1', 'measured|Bash|s3|1'].sort(),
      );
      const profile = profileType(store.db, 'tool_denial', { filter: `tool_name = 'Bash'` });
      // Four Bash entries: two in `s1`, one each in `s2` and `s3`. The fifth candidate (`s4`) has
      // no `tool_name` at all, and `tool_name = 'Bash'` is NULL for it -- so it is excluded, and no
      // `not_measured` cell survives the filter.
      expect(profile?.count).toBe(4);
      expect(
        cells.properties
          .filter((cell) => cell.property === 'tool_name')
          .reduce((sum, cell) => sum + cell.count, 0),
      ).toBe(4);
    });
  });

  it('narrows with --struck as well, and keeps the struck row visible in the cells', () => {
    fixture((store) => {
      recordInvalidation(store.db, {
        entryId: 'a',
        label: 'wrong_subject',
        reason: 'recorded about the wrong session entirely',
        createdAt: AT,
      });
      const cells = clusterCells(store.db, 'tool_denial', 'session_id', { struck: true });
      if (cells === undefined) throw new Error('expected cells');
      expect(
        cells.properties
          .filter((cell) => cell.property === 'tool_name')
          .reduce((sum, cell) => sum + cell.count, 0),
      ).toBe(1);
      expect(cellsOf(cells, 'tool_name')).toEqual(['measured|Bash|s1|1']);
    });
  });
});

describe('clusterCells: refusals', () => {
  it('returns undefined for a type nobody registered', () => {
    withStore((store) => {
      expect(clusterCells(store.db, 'never_defined', 'session_id')).toBeUndefined();
    });
  });

  it('refuses a property the type does not declare, naming it and the ones it has', () => {
    // An empty cell set would be indistinguishable from "the filter excluded everything", and a
    // design over no observations reports deff = 1 -- "no correction needed" for a question that
    // was never asked.
    fixture((store) => {
      expect(() => clusterCells(store.db, 'tool_denial', 'sessions')).toThrow(ClusterCellsError);
      expect(() => clusterCells(store.db, 'tool_denial', 'sessions')).toThrow(
        /'sessions' is not a property of 'tool_denial'/u,
      );
      expect(() => clusterCells(store.db, 'tool_denial', 'sessions')).toThrow(
        /Declared properties: denial_kind, session_id, tool_name/u,
      );
    });
  });

  /**
   * The mirror of the refusal above, and the half that was missing: a spelling that canonicalizes to
   * a declared property IS that property.
   *
   * A property is STORED canonically -- `registry.ts` folds `toolName` to `tool_name` on the way in
   * -- so a caller who spells it the way the type was authored is naming the same property, and
   * refusing them refuses them for the store's own choice of spelling. `crosstab.ts` (`--group-by`)
   * and `profile.ts` both canonicalize the same name and always accepted it; `clusterCells` did not,
   * which made one string an error in `--cluster` and a key in `--group-by` on the same type.
   */
  it('accepts a property under a spelling that canonicalizes to a declared one (bug-hunt #8)', () => {
    fixture((store) => {
      const canonical = clusterCells(store.db, 'tool_denial', 'tool_name');
      const authored = clusterCells(store.db, 'tool_denial', 'toolName');
      expect(authored).toBeDefined();
      expect(authored).toEqual(canonical);
    });
  });

  it('refuses an envelope column as a cluster key, because it is not a declared property', () => {
    // `run_id` is on every generated view and is a perfectly reasonable thing to cluster by, but it
    // is not a property of the TYPE. The refusal is the honest answer until someone asks for it by
    // name: a key this module accepted without the type declaring it would be a key no profile of
    // that type could ever agree with.
    fixture((store) => {
      expect(() => clusterCells(store.db, 'tool_denial', 'run_id')).toThrow(ClusterCellsError);
    });
  });
});
