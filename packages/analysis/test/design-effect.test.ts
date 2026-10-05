import { describe, expect, it } from 'vitest';
import {
  clusterDesign,
  clusterDesignFromGroups,
  ClusterDesignError,
  type ClusterDesign,
} from '../src/index.js';

/**
 * `design-effect.ts` -- the effective sample size for entries that are not independent (asc-0hys).
 *
 * EVERY EXPECTED VALUE BELOW WAS COMPUTED BY HAND, from the one-way ANOVA estimator
 * `rho = (MSB - MSW) / (MSB + (m0 - 1) MSW)` with `m0 = (N - sum(m_i^2)/N) / (k - 1)` and
 * `deff = 1 + (sum(m_i^2)/N - 1) rho`, and the derivations are written beside each case so a reader
 * can check the arithmetic rather than the implementation's agreement with itself. A correction
 * checked against its own output proves nothing.
 *
 * The three cases that matter are not the ones with a middling rho. They are the two DEGENERATE ends
 * -- an outcome independent of its cluster (rho = 0, nothing may be corrected) and an outcome that is
 * constant within every cluster (rho = 1, the most that can be corrected) -- and the case where rho
 * CANNOT be estimated at all, because that is the one where a plausible-looking number would be an
 * invented one. A single session of a hundred entries has an effective N of 1 by the bound, and the
 * design has to say so rather than quietly reporting the hundred.
 */

/** Cluster keys for an outcome list: `n` repeats of one key, or one key per entry. */
function keys(spec: readonly number[]): string[] {
  return spec.flatMap((size, index) => Array.from({ length: size }, () => `c${String(index)}`));
}

/** The outcomes of `[1,1],[1,0],...`: flat, one per entry, in cluster order. */
function outcomes(groups: readonly (readonly number[])[]): number[] {
  return groups.flat();
}

/** A design over groups of a stated size, e.g. `design([[1, 1], [1, 0]])`. */
function design(groups: readonly (readonly number[])[]): ClusterDesign {
  return clusterDesign(outcomes(groups), keys(groups.map((group) => group.length)));
}

describe('clusterDesign: the intraclass correlation', () => {
  it('corrects nothing when the outcome is independent of the cluster', () => {
    // [1,1] [1,1] [1,0]: N=6, k=3, S=5, sum(m^2)=12, A=4.5
    //   MSB = (4.5 - 25/6)/2 = 1/6 ;  MSW = (5 - 4.5)/3 = 1/6   -> identical, so rho = 0 exactly.
    const d = design([
      [1, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(d.rhoSource).toBe('estimated');
    expect(d.rho).toBeCloseTo(0, 12);
    expect(d.designEffect).toBeCloseTo(1, 12);
    expect(d.effectiveN).toBeCloseTo(6, 12);
  });

  it('reports a partial correlation, shrunk by the size factor', () => {
    // [1,1] [1,0] [0,0] [0,1]: N=8, k=4, S=4, sum(m^2)=16, A=3
    //   MSB = (3 - 2)/3 = 1/3 ;  MSW = (4 - 3)/4 = 1/4 ;  m0 = (8 - 2)/3 = 2
    //   rho = (1/12)/(1/3 + 1/4) = 1/7 ;  deff = 1 + (16/8 - 1)(1/7) = 8/7 ;  n_eff = 7
    const d = design([
      [1, 1],
      [1, 0],
      [0, 0],
      [0, 1],
    ]);
    expect(d.rho).toBeCloseTo(1 / 7, 12);
    expect(d.designEffect).toBeCloseTo(8 / 7, 12);
    expect(d.effectiveN).toBeCloseTo(7, 12);
  });

  it('reaches the bound when the outcome never varies inside a cluster', () => {
    // [1,1,1] [0,0,0]: N=6, k=2, S=3, sum(m^2)=18, A=3
    //   MSB = (3 - 1.5)/1 = 1.5 ;  MSW = (3 - 3)/4 = 0 ;  m0 = 3
    //   rho = 1.5/1.5 = 1 ;  deff = 1 + (3 - 1) = 3 ;  n_eff = 2 = k
    // ESTIMATED, not assumed: the data has the within-cluster degrees of freedom and says so.
    const d = design([
      [1, 1, 1],
      [0, 0, 0],
    ]);
    expect(d.rhoSource).toBe('estimated');
    expect(d.rho).toBeCloseTo(1, 12);
    expect(d.designEffect).toBeCloseTo(3, 12);
    expect(d.effectiveN).toBeCloseTo(2, 12);
  });
});

describe('clusterDesign: where rho cannot be estimated', () => {
  it('collapses one session to one observation, and says the correlation was assumed', () => {
    // The bead's own case. With k=1 there is no within-cluster degrees of freedom, so no data can
    // say how much sessions differ -- and the only defensible correction is the conservative bound,
    // which is exactly "the effective N is at most the number of clusters". 20 entries from one
    // session therefore carry ONE observation's worth of information about between-session
    // variation. Reporting 20 here is the pseudoreplication this bead exists to name.
    const d = clusterDesign(
      [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
      Array.from({ length: 10 }, () => 'only-session'),
    );
    expect(d.rhoSource).toBe('assumed-perfect');
    expect(d.clusters).toBe(1);
    expect(d.rho).toBe(1);
    expect(d.designEffect).toBeCloseTo(10, 12);
    expect(d.effectiveN).toBeCloseTo(1, 12);
  });

  it('leaves one-entry-per-cluster uncorrected, whatever the outcomes', () => {
    // k = n: every cluster is a singleton, so sum(m^2)/N = 1 and deff = 1 for ANY rho. rho is
    // reported as inapplicable rather than estimated from zero degrees of freedom.
    const d = design([[1], [0], [1], [1], [0]]);
    expect(d.rhoSource).toBe('inapplicable');
    expect(d.designEffect).toBeCloseTo(1, 12);
    expect(d.effectiveN).toBeCloseTo(5, 12);
  });

  it('clamps a negative estimate to no correction rather than shrinking the interval', () => {
    // [1,0] [1,0]: MSB = (1 - 4/4)/1 = 0 ;  MSW = (2 - 1)/2 = 0.5  -> the estimator is exactly -1.
    // Unclamped, deff = 1 + (2 - 1)(-1) = 0 and the interval would be computed at n_eff = infinity:
    // precision invented by a subtraction, which is worse than no correction at all.
    const d = design([
      [1, 0],
      [1, 0],
    ]);
    expect(d.rhoSource).toBe('estimated');
    expect(d.rho).toBe(0);
    expect(d.designEffect).toBeCloseTo(1, 12);
    expect(d.effectiveN).toBeCloseTo(4, 12);
  });

  it('reports the largest cluster, so the skew behind the correction is visible', () => {
    // 70% of this store's tool_denial rows sit on one calendar day; a correction whose reason is
    // invisible is one a reader has to take on trust.
    const d = design([[1, 1, 1, 1, 1, 1, 1], [1], [0], [1]]);
    expect(d.n).toBe(10);
    expect(d.clusters).toBe(4);
    expect(d.largestCluster).toBe(7);
  });
});

describe('clusterDesign: the invariants', () => {
  const CASES: readonly (readonly (readonly number[])[])[] = [
    [[1, 1, 1, 1, 1, 1, 1], [1], [0], [1]],
    [
      [1, 1],
      [1, 1],
      [1, 0],
    ],
    [
      [1, 1, 1],
      [0, 0, 0],
    ],
    [
      [1, 0],
      [1, 0],
    ],
    [[1], [0], [1]],
    [[0, 0, 0, 0, 0]],
  ];

  it('never reports a design effect below 1, an effective N above N, or one above the clusters', () => {
    // deff < 1 would SHRINK the interval -- invented precision, the opposite of the point. And
    // n_eff > clusters would claim to learn more about between-cluster variation than the number of
    // clusters can carry (Cauchy-Schwarz: N^2 / sum(m_i^2) <= k, with equality iff the m_i are equal).
    for (const groups of CASES) {
      const d = design(groups);
      const label = JSON.stringify(groups);
      expect(d.designEffect, label).toBeGreaterThanOrEqual(1);
      expect(d.effectiveN, label).toBeLessThanOrEqual(d.n);
      expect(d.effectiveN, label).toBeGreaterThan(0);
      if (d.rho === 1) expect(d.effectiveN, label).toBeLessThanOrEqual(d.clusters + 1e-9);
    }
  });
});

describe('clusterDesign: refusals', () => {
  it('refuses outcomes and clusters of different lengths', () => {
    // Silently pairing them by index would drop entries or read undefined, and a dropped entry is a
    // denominator that quietly disagrees with the numerator above it.
    expect(() => clusterDesign([1, 0], ['a'])).toThrow(ClusterDesignError);
    expect(() => clusterDesign([1, 0], ['a'])).toThrow(/length/u);
  });

  it('refuses an outcome that is not 0 or 1', () => {
    // The estimator is the one for a BINARY outcome. Feeding it a count would produce a rho that is
    // not the intraclass correlation of anything a reader could name.
    expect(() => clusterDesign([1, 2], ['a', 'b'])).toThrow(/0 or 1/u);
    expect(() => clusterDesign([1, 0.5], ['a', 'b'])).toThrow(ClusterDesignError);
  });

  it('refuses an empty sample rather than reporting a zero design', () => {
    expect(() => clusterDesign([], [])).toThrow(/empty|no observations/u);
  });
});

/**
 * `clusterDesignFromGroups` -- the same estimator, over the shape a GROUP BY actually produces.
 *
 * WHY THE GROUPED FORM IS THE PRIMITIVE. `clusterDesign` takes one element per OBSERVATION, which is
 * a shape no store can hand back: SQL aggregates, so what comes out of a query is `(m_i, s_i)` per
 * cluster and never the observations themselves. Expanding counts back into arrays in the caller
 * would re-do the aggregation the query just did, and would add a place to get a length wrong.
 *
 * The anchors below are stated directly in group form and derived by hand, so a reader checks the
 * arithmetic rather than the implementation's agreement with itself -- and the delegation from
 * `clusterDesign` is checked separately, so a wrong delegation cannot hide behind a shared bug.
 */
describe('clusterDesignFromGroups', () => {
  it('is the intraclass correlation, computed straight from (size, successes)', () => {
    // Two clusters of 2, the first all-success and the second all-failure: N=4, k=2, S=2, A = 4/2 + 0
    // = 2, sum(m^2) = 8, so the size factor is 8/4 = 2.
    //   MSB = (2 - 4/4)/1 = 1 ;  MSW = (2 - 2)/2 = 0 ;  m0 = (4 - 8/4)/1 = 2
    //   rho = (1 - 0)/(1 + (2-1)*0) = 1 ;  deff = 1 + (2-1)*1 = 2 ;  n_eff = 2 = k.
    const d = clusterDesignFromGroups([
      { size: 2, successes: 2 },
      { size: 2, successes: 0 },
    ]);
    expect(d.rho).toBe(1);
    expect(d.rhoSource).toBe('estimated');
    expect(d.designEffect).toBe(2);
    expect(d.effectiveN).toBe(2);
    expect(d.clusters).toBe(2);
  });

  it('reproduces the fraction case the observation form is already anchored on', () => {
    // [1,1] [1,0] [0,0] [0,1] as groups: N=8, k=4, S=4, A = 2 + 1/2 + 0 + 1/2 = 3, sum(m^2) = 16.
    //   MSB = (3 - 16/8)/3 = 1/3 ;  MSW = (4 - 3)/4 = 1/4 ;  m0 = (8 - 2)/3 = 2
    //   rho = (1/3 - 1/4)/(1/3 + 1/4) = (1/12)/(7/12) = 1/7 ;  deff = 1 + (2-1)/7 = 8/7.
    const d = clusterDesignFromGroups([
      { size: 2, successes: 2 },
      { size: 2, successes: 1 },
      { size: 2, successes: 0 },
      { size: 2, successes: 1 },
    ]);
    expect(d.rho).toBeCloseTo(1 / 7, 12);
    expect(d.designEffect).toBeCloseTo(8 / 7, 12);
    expect(d.effectiveN).toBeCloseTo(7, 12);
  });

  it('corrects nothing when every cluster is a singleton, whatever its outcomes', () => {
    // The size factor is sum(m^2)/N = 3/3 = 1, so deff is 1 for ANY rho -- and rho carries no
    // information here, which `rhoSource` says rather than dressing a zero-degree-of-freedom
    // quantity as a measurement.
    const d = clusterDesignFromGroups([
      { size: 1, successes: 1 },
      { size: 1, successes: 0 },
      { size: 1, successes: 1 },
    ]);
    expect(d.rhoSource).toBe('inapplicable');
    expect(d.designEffect).toBe(1);
    expect(d.effectiveN).toBe(3);
  });

  it('falls back to the conservative bound for a single cluster', () => {
    // No within-cluster degrees of freedom, so rho is not estimable -- and the bound is the answer:
    // deff = sum(m^2)/N = 25/5 = 5, so five observations from one cluster are worth ONE.
    const d = clusterDesignFromGroups([{ size: 5, successes: 2 }]);
    expect(d.rhoSource).toBe('assumed-perfect');
    expect(d.rho).toBe(1);
    expect(d.designEffect).toBe(5);
    expect(d.effectiveN).toBe(1);
  });

  it('clamps a negative estimate, which would otherwise invent precision', () => {
    // N=8, k=4, S=2, A = 1/2 + 0 + 0 + 1/2 = 1, sum(m^2) = 16.
    //   MSB = (1 - 4/8)/3 = 1/6 ;  MSW = (2 - 1)/4 = 1/4 ;  m0 = (8 - 2)/3 = 2
    //   raw rho = (1/6 - 1/4)/(1/6 + 1/4) = -1/5, clamped to 0.
    // An unclamped rho below zero SHRINKS the interval: precision invented out of a subtraction.
    const d = clusterDesignFromGroups([
      { size: 2, successes: 1 },
      { size: 2, successes: 0 },
      { size: 2, successes: 0 },
      { size: 2, successes: 1 },
    ]);
    expect(d.rho).toBe(0);
    expect(d.designEffect).toBe(1);
    expect(d.effectiveN).toBe(8);
  });

  it('assumes the bound for a constant outcome, which the estimator cannot measure', () => {
    // Every observation the same value, so S = N and A = sum(m^2/m) = N: both mean squares are
    // exactly 0 and the ratio is 0/0. The estimator has nothing to say -- but "nothing to say"
    // must not be reported as "no correction applies", which at 3 sessions of 20 would print an
    // interval computed at N=60 for what is at most 3 observations' worth of evidence.
    const d = clusterDesignFromGroups([
      { size: 20, successes: 0 },
      { size: 20, successes: 0 },
      { size: 20, successes: 0 },
    ]);
    expect(d.rhoSource).toBe('assumed-perfect');
    expect(d.rho).toBe(1);
    expect(d.designEffect).toBe(20);
    expect(d.effectiveN).toBe(3);
  });

  it('treats all-successes exactly as it treats all-failures', () => {
    // The constant case has two arms and they are the same case: an outcome that never varies.
    // Only testing the zero arm would pass with a branch written for `totalOnes === 0`.
    const zeros = clusterDesignFromGroups([
      { size: 20, successes: 0 },
      { size: 20, successes: 0 },
      { size: 20, successes: 0 },
    ]);
    const ones = clusterDesignFromGroups([
      { size: 20, successes: 20 },
      { size: 20, successes: 20 },
      { size: 20, successes: 20 },
    ]);
    expect(ones).toEqual(zeros);
  });

  it('still estimates when only ONE cluster is constant', () => {
    // The boundary the branch must not overreach. A cluster with no successes is not a constant
    // outcome: A = 4/2 = 2, so MSB = (2 - 4/6)/2 = 2/3 while MSW = (2 - 2)/3 = 0, and the
    // denominator is 2/3 rather than 0 -- the estimator runs and finds real clustering.
    const d = clusterDesignFromGroups([
      { size: 2, successes: 2 },
      { size: 2, successes: 0 },
      { size: 2, successes: 0 },
    ]);
    expect(d.rhoSource).toBe('estimated');
    expect(d.rho).toBe(1);
    expect(d.designEffect).toBe(2);
    expect(d.effectiveN).toBe(3);
  });

  it('agrees with the observation form on every case, so the delegation is not a second estimator', () => {
    // The delegation is the point: two arithmetic paths would be two surfaces that can disagree.
    // This checks the OTHER direction from `clusterDesign`'s own tests -- same answer, different input
    // shape -- which is what would catch a delegation that dropped or double-counted a group.
    const cases: readonly (readonly (readonly number[])[])[] = [
      [
        [1, 1],
        [1, 0],
        [0, 0],
        [0, 1],
      ],
      [
        [1, 1, 1],
        [0, 0, 0],
      ],
      [[1], [0], [1], [0], [1]],
      [
        [1, 1],
        [1, 1],
        [1, 0],
      ],
      [[0, 0, 0, 1], [1, 1, 0, 0], [1]],
    ];
    for (const groups of cases) {
      const label = JSON.stringify(groups);
      const grouped = clusterDesignFromGroups(
        groups.map((group) => ({
          size: group.length,
          successes: group.reduce((sum, outcome) => sum + outcome, 0),
        })),
      );
      const observed = design(groups);
      expect(grouped.rho, label).toBeCloseTo(observed.rho, 12);
      expect(grouped.designEffect, label).toBeCloseTo(observed.designEffect, 12);
      expect(grouped.effectiveN, label).toBeCloseTo(observed.effectiveN, 12);
      expect(grouped.rhoSource, label).toBe(observed.rhoSource);
      expect(grouped.largestCluster, label).toBe(observed.largestCluster);
    }
  });
});

describe('clusterDesignFromGroups: refusals', () => {
  it('refuses a group that holds more successes than observations', () => {
    // successes > size is not a rounding question: it is a numerator above its own denominator, and
    // repaired silently it would widen the interval for a reason no reader could name.
    expect(() => clusterDesignFromGroups([{ size: 2, successes: 3 }])).toThrow(ClusterDesignError);
    expect(() => clusterDesignFromGroups([{ size: 2, successes: 3 }])).toThrow(/successes/u);
  });

  it('refuses a negative or non-integer size or success count', () => {
    expect(() => clusterDesignFromGroups([{ size: 0, successes: 0 }])).toThrow(ClusterDesignError);
    expect(() => clusterDesignFromGroups([{ size: -1, successes: 0 }])).toThrow(ClusterDesignError);
    expect(() => clusterDesignFromGroups([{ size: 1.5, successes: 0 }])).toThrow(
      ClusterDesignError,
    );
    expect(() => clusterDesignFromGroups([{ size: 2, successes: -1 }])).toThrow(ClusterDesignError);
  });

  it('refuses an empty group list rather than reporting a zero design', () => {
    expect(() => clusterDesignFromGroups([])).toThrow(/no observations|empty/u);
  });
});
