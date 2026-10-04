import { describe, expect, it } from 'vitest';
import { clusterDesign, ClusterDesignError, type ClusterDesign } from '../src/index.js';

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
