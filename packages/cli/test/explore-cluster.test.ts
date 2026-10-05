import type { ClusterCells } from '@ascend/store';
import { describe, expect, it } from 'vitest';
import { ClusterDesignsError, designsFromCells } from '../src/explore-cluster.js';

/**
 * `designsFromCells` -- the cell-to-design assembly behind `asc explore --cluster` (asc-0hys).
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. The ESTIMATOR is pinned by hand-computed anchors in
 * `packages/analysis/test/design-effect.test.ts`; re-deriving `rho` here would be a second copy of
 * arithmetic already checked, and would pass whenever both copies were wrong together. What is
 * unpinned -- and what a wrong answer here would silently produce -- is the MAPPING: which cells of
 * a property become a row's POPULATION and which become its SUCCESSES. A row corrected over the
 * wrong population is not a crash; it is an interval computed at a denominator the row above it
 * never printed.
 *
 * SO EVERY ANCHOR BELOW IS HAND-DERIVED FROM THE CELLS, on paper, from the estimator's own
 * definitions -- not read off the implementation. The fixture is six entries in three sessions:
 *
 *   s1: Bash, Bash                 (2 entries, both measured Bash)
 *   s2: Write, Write               (2 entries, both measured Write)
 *   s3: not_measured, n/a, undeclared (3 entries, the three non-measured states)
 *
 * N = 7, measured = 4, declared = 6, not_declared = 1. `wrong_subject` strikes both of s1.
 */

/** Six entries, three sessions, every state of the model reachable -- see the file comment. */
const CELLS: ClusterCells = {
  properties: [
    { property: 'tool_name', state: 'measured', value: 'Bash', cluster: 's1', count: 2 },
    { property: 'tool_name', state: 'measured', value: 'Write', cluster: 's2', count: 2 },
    { property: 'tool_name', state: 'not_measured', value: null, cluster: 's3', count: 1 },
    { property: 'tool_name', state: 'not_applicable', value: null, cluster: 's3', count: 1 },
    { property: 'tool_name', state: 'not_declared', value: null, cluster: 's3', count: 1 },
  ],
  invalidations: [
    { label: 'wrong_subject', cluster: 's1', count: 2 },
    { label: null, cluster: 's2', count: 2 },
    { label: null, cluster: 's3', count: 3 },
  ],
};

const designs = designsFromCells(CELLS, 'session_id');

/**
 * A float expected to within IEEE-754 noise, as a plain `number`.
 *
 * `expect.closeTo` is the matcher to reach for -- the estimator's `rho` is a ratio of two mean
 * squares, so a value that is 0 on paper can land on 8.3e-17, and equality would fail a correct
 * implementation. But it is typed `any`, and lint refuses an `any` assigned into a literal, so this
 * narrows it once here rather than at each of the four call sites.
 */
const near = (value: number): number => expect.closeTo(value, 12) as number;

/** Every field of a design, so a test that passes is a test that read all of them. */
const shape = (design: ReturnType<typeof designs.state>): unknown =>
  design === undefined
    ? undefined
    : {
        n: design.n,
        clusters: design.clusters,
        largestCluster: design.largestCluster,
        rho: design.rho,
        rhoSource: design.rhoSource,
        designEffect: design.designEffect,
        effectiveN: design.effectiveN,
      };

describe('designsFromCells: the invalidated rows are corrected over the whole type', () => {
  it('corrects the aggregate row over every entry, at the sessions the labels fall in', () => {
    // Population: all 7 entries -- s1 2, s2 2, s3 3. Successes: s1 2, s2 0, s3 0 (S = 2).
    // A = 2^2/2 = 2; MSB = (2 - 4/7)/2 = 5/7; MSW = (2 - 2)/4 = 0; sizeFactor = 17/7.
    // MSW = 0 with a non-zero MSB is rho = 1 exactly -- every invalidation is in one session and
    // the estimator sees no within-session variation at all. deff = 17/7, n_eff = 7/(17/7) = 49/17.
    const design = designs.invalidated(7);
    expect(shape(design)).toEqual({
      n: 7,
      clusters: 3,
      largestCluster: 3,
      rho: 1,
      rhoSource: 'estimated',
      designEffect: near(17 / 7),
      effectiveN: near(49 / 17),
    });
  });

  it('corrects one label row over the same population the aggregate row used', () => {
    // `invalidated` and `invalidated.<label>` are both shares of the TYPE (`invalidatedRow`'s own
    // comment), so a per-label design over any other population would make the two rows
    // incomparable -- the one thing those rows exist to be.
    expect(designs.label('wrong_subject', 7)).toEqual(designs.invalidated(7));
  });
});

describe('designsFromCells: a state row is corrected over the population its own n names', () => {
  it('uses `declared` for the three states that are shares of it', () => {
    // Population: declared -- measured (s1 2, s2 2) + n/a (s3 1) + not_measured (s3 1) = s1 2,
    // s2 2, s3 2. Successes for `measured`: s1 2, s2 2, s3 0 (S = 4). A = 4; MSB = (4 - 16/6)/2 =
    // 2/3; MSW = 0; sizeFactor = 2; rho = 1; deff = 2; n_eff = 3.
    // N = 6 and NOT 7: the `not_declared` entry is not part of a `measured` share's population.
    expect(shape(designs.state('tool_name', 'measured', 6))).toEqual({
      n: 6,
      clusters: 3,
      largestCluster: 2,
      rho: 1,
      rhoSource: 'estimated',
      designEffect: 2,
      effectiveN: 3,
    });
  });

  it('uses the type total for `not_declared`, which is a share of the type', () => {
    // Population: all 7 (s1 2, s2 2, s3 3). Successes: 1, in s3. A = 1/3; MSB = 2/21; MSW = 1/6.
    // MSB < MSW, so the raw estimate is -3/13 -- the clamp fires, and deff is exactly 1. A test
    // that only ever saw rho = 1 would not notice the clamp being dropped.
    expect(shape(designs.state('tool_name', 'not_declared', 7))).toEqual({
      n: 7,
      clusters: 3,
      largestCluster: 3,
      rho: near(0),
      rhoSource: 'estimated',
      designEffect: 1,
      effectiveN: 7,
    });
  });

  it('reports a genuinely independent outcome as uncorrected, not as a small correction', () => {
    // `not_applicable`: population declared (s1 2, s2 2, s3 2); successes s3 1. A = 1/2;
    // MSB = (1/2 - 1/6)/2 = 1/6; MSW = (1 - 1/2)/3 = 1/6. MSB == MSW, so rho is 0 EXACTLY and the
    // design effect is 1 -- an outcome that is independent of its session must not be "corrected".
    expect(shape(designs.state('tool_name', 'not_applicable', 6))).toEqual({
      n: 6,
      clusters: 3,
      largestCluster: 2,
      rho: near(0),
      rhoSource: 'estimated',
      designEffect: 1,
      effectiveN: 6,
    });
  });
});

describe('designsFromCells: a top-value row is corrected over `measured`, and no wider', () => {
  it("narrows the population to the measured cells, which is the row's own denominator", () => {
    // `propertyTopRows` divides by `property.states.measured`, so the population is the 4 measured
    // entries: s1 2, s2 2. Bash is both of s1's (S = 2), so A = 2, MSB = (2 - 1)/1 = 1, MSW = 0,
    // rho = 1, sizeFactor = 2, deff = 2, n_eff = 2.
    // A design over all 7 would carry `n = 7` and `wilson` would refuse the pair outright -- which
    // is the check that makes this row's population impossible to get quietly wrong.
    expect(shape(designs.value('tool_name', 'Bash', 4))).toEqual({
      n: 4,
      clusters: 2,
      largestCluster: 2,
      rho: 1,
      rhoSource: 'estimated',
      designEffect: 2,
      effectiveN: 2,
    });
  });

  it('gives two values of one property the same population but their own successes', () => {
    // Write is the mirror of Bash here, so the numbers coincide -- the point is that the LOOKUP is
    // per value, and a single design reused for every top row would pass a test written around one.
    expect(shape(designs.value('tool_name', 'Write', 4))).toEqual(
      shape(designs.value('tool_name', 'Bash', 4)),
    );
  });
});

describe('designsFromCells: a `--group-by` cell is corrected over every entry', () => {
  it('counts the whole group population, non-measured states included', () => {
    // `cellRow` divides by `result.total`, which counts every entry -- and a group cell can be a
    // STATE (`not_measured`) rather than a value. So this population is the same 7 as the
    // invalidated row's, and the successes follow the cell's own key.
    expect(shape(designs.groupKey('tool_name', 'Bash', 7))).toEqual(shape(designs.invalidated(7)));
    expect(shape(designs.groupKey('tool_name', 'not_measured', 7))).toEqual(
      shape(designs.state('tool_name', 'not_declared', 7)),
    );
  });
});

describe('designsFromCells: refusals', () => {
  it('refuses an entry in no cluster, naming the property and how many entries it is', () => {
    // Bucketing these into a `(none)` cluster would LOWER the size factor and so narrow the
    // interval -- invented precision, the direction this whole correction moves against. Letting
    // them go uncounted gives a design whose `n` is smaller than the row's `n`, which `wilson`
    // refuses with a message about populations. Both are worse than saying what is wrong.
    const unclustered: ClusterCells = {
      ...CELLS,
      invalidations: [
        { label: null, cluster: 's1', count: 2 },
        { label: null, cluster: null, count: 1 },
      ],
    };
    expect(() => designsFromCells(unclustered, 'session_id')).toThrow(ClusterDesignsError);
    expect(() => designsFromCells(unclustered, 'session_id')).toThrow(
      /'session_id'.*1 of this type's entries/u,
    );
  });

  it('refuses a lookup miss when the row it would correct has a population', () => {
    // THE TEST THAT KEEPS THIS FROM FAILING SILENTLY. A miss returns `undefined`, `wilson` accepts
    // `undefined` as "no design", and the row prints an UNcorrected interval under a flag that
    // promised it was corrected -- a wrong answer shaped exactly like a right one. A miss on an
    // empty population is legitimate (there is no design over nothing, and `wilson` returns null
    // for it anyway), so the population is what separates the two.
    expect(designs.value('tool_name', 'never_seen', 0)).toBeUndefined();
    expect(() => designs.value('tool_name', 'never_seen', 4)).toThrow(ClusterDesignsError);
    expect(() => designs.state('verdict', 'measured', 99)).toThrow(/reports a population of 99/u);
  });

  it('corrects nothing for a population with no observations, rather than reporting deff 1', () => {
    // An empty cells set is what a `--filter` that matched nothing produces. A design built over it
    // would either throw or report `deff = 1` -- "no correction needed" for a question never asked.
    const empty: ClusterCells = { properties: [], invalidations: [] };
    const none = designsFromCells(empty, 'session_id');
    expect(none.invalidated(0)).toBeUndefined();
    expect(none.state('tool_name', 'measured', 0)).toBeUndefined();
  });
});
