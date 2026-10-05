/**
 * The effective sample size for observations that are not independent (asc-0hys).
 *
 * WHY THIS EXISTS. Every significance claim ascend reports -- a Wilson interval, a chi-square tail, a
 * permutation p -- assumes the observations are independent draws. They are not. A Claude Code
 * session contributes many entries, a single working day contributes many sessions, and one sprint
 * on this corpus put 534 of 760 `tool_denial` rows on one calendar day. Treating those rows as
 * independent inflates N and shrinks every interval and every p-value, in the direction that makes a
 * finding look stronger. This module computes the correction and reports it, so a number quoted as
 * the basis of a claim can carry the N it was actually computed at.
 *
 * THE ESTIMATOR IS THE STANDARD ONE, because inventing a second one is how two surfaces come to
 * disagree. For a binary outcome and a caller-supplied partition into clusters, the one-way ANOVA
 * intraclass correlation:
 *
 *     MSB = (A - S^2/N) / (k - 1)          A = sum_i (s_i^2 / m_i)   (s_i = ones in cluster i)
 *     MSW = (S - A) / (N - k)              S = total ones
 *     m0  = (N - sum_i m_i^2 / N) / (k - 1)
 *     rho = (MSB - MSW) / (MSB + (m0 - 1) MSW)
 *     deff = 1 + (sum_i m_i^2 / N - 1) rho
 *
 * `rho` is clamped to [0, 1]. The estimator can go slightly negative on real data, and a negative
 * rho would SHRINK the interval -- precision invented out of a subtraction, which is the class of
 * wrong answer this whole project treats as severity-zero.
 *
 * THE CLUSTER KEY IS THE CALLER'S, ALWAYS. `packages/analysis` is pure and harness-neutral: the
 * strings `session_id`, `agent_id` and `session` appear nowhere in this package, and they must not.
 * The keys here are opaque labels with no meaning to this module, exactly like `AssociationColumn.name`
 * and `NamedSeries.name`. Which partition is the right one is a question about the DATA, not about
 * the arithmetic -- and the answer differs: measured on this store, a calendar-day key clusters
 * `tool_denial` far harder than a session key does (70% of its rows on one day). So the caller
 * decides, and this module never guesses.
 *
 * NOT `cluster.ts`. That module is lexical clustering -- TF-IDF, agglomerative linkage, silhouette.
 * This is a variance correction with no similarity metric anywhere in it, and the two share a word
 * and nothing else, which is why they do not share a file.
 *
 * WHERE rho CANNOT BE ESTIMATED, THE CONSERVATIVE BOUND IS USED AND NAMED AS SUCH. `rho` needs the
 * within-cluster mean square, which needs `k >= 2` and `N > k`. A single session offers neither, and
 * no data can say how much sessions differ when there is one session. The only defensible answer is
 * the bound `N^2 / sum_i m_i^2`, which is `rho = 1` -- and it is the statement "you cannot learn more
 * about between-session variation than the number of sessions" (Cauchy-Schwarz: the bound is at most
 * `k`). A hundred entries from one session therefore carry ONE observation's worth of information,
 * and `rhoSource` says `'assumed-perfect'` so a reader can tell an assumption from a measurement.
 * Reporting the hundred would be precisely the pseudoreplication this bead was filed against.
 *
 * LIMITATION, STATED PLAINLY. The estimator is the one for a BINARY outcome, so `clusterDesign`
 * refuses anything but 0 and 1 rather than producing a rho that is not the intraclass correlation of
 * anything a reader could name. A count-valued outcome needs a different variance model and is not
 * in scope here.
 *
 * This file is pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `packages/core/test/purity-enforcement.test.ts`).
 */

/** How the `rho` in a design was arrived at, so an assumption is never read as a measurement. */
export type RhoSource =
  /** Estimated from the data: at least two clusters and at least one within-cluster degree of freedom. */
  | 'estimated'
  /**
   * NOT ESTIMABLE, so the conservative bound `rho = 1` was assumed instead of measured.
   *
   * Two routes reach it, and both are 0/0 rather than a measurement: one cluster (no
   * within-cluster degrees of freedom at all), and a CONSTANT outcome (every observation the same
   * value, so both mean squares are exactly 0 and there is no variation to estimate from). They
   * share this value because they share the conclusion -- the arithmetic ran out and the bound is
   * the only defensible answer -- and a second spelling of one fact is how two surfaces come to
   * disagree.
   */
  | 'assumed-perfect'
  /** Every cluster is a singleton, so the correction is 1 for any rho and rho carries no information. */
  | 'inapplicable';

/**
 * A caller asked for a design the arithmetic cannot produce.
 *
 * Thrown rather than repaired, in the style of `ProportionError` and `SampleSizeError`. Pairing two
 * lists of different lengths by index would silently drop observations or read `undefined`, and a
 * dropped observation is a denominator that quietly disagrees with the numerator above it -- a wrong
 * answer shaped exactly like a right one.
 */
export class ClusterDesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterDesignError';
  }
}

/**
 * The correction, and the numbers it was computed from.
 *
 * Every field is present on every instance: there is deliberately no state in which `effectiveN`
 * exists and the `rho` behind it does not, because an effective N with no visible derivation is a
 * number a reader has to take on trust.
 */
export interface ClusterDesign {
  /** The number of observations, independent or not. The denominator a raw count would use. */
  readonly n: number;
  /** The number of distinct cluster keys. The ceiling on `effectiveN` when `rho = 1`. */
  readonly clusters: number;
  /** The size of the largest cluster, so the skew behind the correction is visible. */
  readonly largestCluster: number;
  /**
   * The intraclass correlation actually used, in [0, 1].
   *
   * Read it together with `rhoSource`: `0` under `'inapplicable'` is a statement that clustering
   * cannot matter for this sample, not a measurement that the outcome is independent of its cluster.
   */
  readonly rho: number;
  readonly rhoSource: RhoSource;
  /** The variance inflation, never below 1. A design effect below 1 is arithmetic that cannot be right. */
  readonly designEffect: number;
  /**
   * `n / designEffect`, never above `n`.
   *
   * THIS IS THE N A SIGNIFICANCE CLAIM MUST BE COMPUTED AT. `smallGroup` is judged on it, because a
   * group of 142 findings drawn from 5 reviews carries 4 observations' worth of information and
   * printing the 142 as a large sample is the error this module exists to prevent.
   */
  readonly effectiveN: number;
}

/**
 * One cluster's contribution, in the shape a `GROUP BY` returns.
 *
 * This is the primitive's input rather than the observation list because SQL aggregates: what comes
 * out of a query is `(size, successes)` per cluster and never the observations themselves. An
 * observation-shaped API would force every store caller to expand counts back into arrays it just
 * aggregated, and would add a place to get a length wrong for no arithmetic gain.
 */
export interface ClusterGroup {
  /** How many observations the cluster holds. A positive integer. */
  readonly size: number;
  /** How many of them are successes -- the `1` outcome. An integer in `[0, size]`. */
  readonly successes: number;
}

/**
 * The clustering correction for one binary outcome over one caller-chosen partition.
 *
 * `outcomes[i]` and `clusters[i]` describe the same observation, so the two must be the same length
 * and in the same order. `outcomes` is 0 or 1 and nothing else; `clusters` are opaque labels whose
 * meaning is the caller's -- this module compares them for equality and never interprets them.
 *
 * This counts the clusters and then DELEGATES, so there is exactly one arithmetic path. Keeping a
 * second copy of the estimator for the grouped entry point is how two surfaces come to disagree.
 */
export function clusterDesign(
  outcomes: readonly number[],
  clusters: readonly string[],
): ClusterDesign {
  if (outcomes.length !== clusters.length) {
    throw new ClusterDesignError(
      `outcomes (${String(outcomes.length)}) and clusters (${String(clusters.length)}) must be the ` +
        `same length and in the same order: they describe the same observations.`,
    );
  }
  outcomes.forEach((value, index) => {
    if (value !== 0 && value !== 1) {
      throw new ClusterDesignError(
        `outcome ${String(index)} is ${String(value)}; this estimator is the one for a binary ` +
          `outcome, so every outcome must be 0 or 1.`,
      );
    }
  });

  // One pass: each cluster's size and its ones. The keys are compared for equality and then dropped
  // -- the arithmetic below needs only the counts, and taking the labels no further keeps the
  // estimator's input in exactly the shape `clusterDesignFromGroups` accepts.
  const groups = new Map<string, { size: number; ones: number }>();
  for (let index = 0; index < outcomes.length; index += 1) {
    const key = clusters[index] ?? '';
    const group = groups.get(key) ?? { size: 0, ones: 0 };
    group.size += 1;
    group.ones += outcomes[index] ?? 0;
    groups.set(key, group);
  }

  return clusterDesignFromGroups(
    [...groups.values()].map((group) => ({ size: group.size, successes: group.ones })),
  );
}

/**
 * The same estimator over `(size, successes)` per cluster -- the form a `GROUP BY` produces, and so
 * the form every store caller has. `clusterDesign` delegates here; this is the primitive.
 *
 * The refusals are the reason this is a public entry point and not a helper. A `successes` above its
 * own `size` is a numerator above its denominator, and one repaired silently would widen an interval
 * for a reason no reader could name; a non-integer or non-positive size is a count that never came
 * from a `COUNT(*)` and so means the caller has lost track of what it is describing.
 */
export function clusterDesignFromGroups(groups: readonly ClusterGroup[]): ClusterDesign {
  groups.forEach((group, index) => {
    if (!Number.isInteger(group.size) || group.size <= 0) {
      throw new ClusterDesignError(
        `group ${String(index)} has size ${String(group.size)}; a cluster's size is a COUNT(*) of ` +
          `observations, so it must be a positive integer.`,
      );
    }
    if (!Number.isInteger(group.successes) || group.successes < 0 || group.successes > group.size) {
      throw new ClusterDesignError(
        `group ${String(index)} has ${String(group.successes)} successes in a cluster of ` +
          `${String(group.size)}; successes must be a whole number between 0 and the size, or the ` +
          `numerator and the denominator describe different populations.`,
      );
    }
  });

  const k = groups.length;
  if (k === 0) {
    throw new ClusterDesignError(
      'There are no observations to design over. An empty sample has no effective N, and 0 would ' +
        'read as a measured absence rather than as an absent measurement.',
    );
  }

  let n = 0;
  let totalOnes = 0;
  let sumSquaresOfSizes = 0;
  let between = 0;
  let largestCluster = 0;
  for (const { size, successes } of groups) {
    n += size;
    totalOnes += successes;
    sumSquaresOfSizes += size * size;
    between += (successes * successes) / size;
    if (size > largestCluster) largestCluster = size;
  }

  // sum_i m_i^2 / N: 1 when every cluster is a singleton, N when there is one cluster of N.
  const sizeFactor = sumSquaresOfSizes / n;

  let rho: number;
  let rhoSource: RhoSource;
  if (k < 2) {
    // No within-cluster degrees of freedom. The bound is the answer, and it is an assumption.
    rho = 1;
    rhoSource = 'assumed-perfect';
  } else if (n === k) {
    // Every cluster a singleton: sizeFactor is 1, so the correction is 1 for any rho. Reporting an
    // estimated rho here would dress a quantity with zero degrees of freedom as a measurement.
    rho = 0;
    rhoSource = 'inapplicable';
  } else {
    const meanSquareBetween = (between - (totalOnes * totalOnes) / n) / (k - 1);
    const meanSquareWithin = (totalOnes - between) / (n - k);
    const adjustedSize = (n - sizeFactor) / (k - 1);
    const denominator = meanSquareBetween + (adjustedSize - 1) * meanSquareWithin;
    if (denominator === 0) {
      // A CONSTANT OUTCOME, AND THE RATIO IS 0/0. When every observation carries the same value --
      // none of a property's entries measured, or all of them -- both mean squares are exactly 0,
      // so there is no within-cluster variation to compare against between-cluster variation and
      // the estimator has nothing to say. This is the SECOND route to a non-estimable rho, and it
      // is not the one-cluster case above: measured 2026-10-04 on `tool_denial` clustered by
      // `session_id`, 24 of 71 corrected rows land here -- every zero-count state row and every
      // value no entry took. (`rhoSource === 'assumed-perfect'` with `clusters >= 2` is exactly
      // this set, which is how it is counted; the one-cluster route on the same map is 0 rows.)
      //
      // The two available answers are 0 and the bound, and 0 is the one that must not be given.
      // `rho = 0` reads as "the correction does not apply", which at 764 entries over 40 clusters
      // states an independence nobody measured -- and it is the ANTICONSERVATIVE direction: it
      // prints `0.0% (95% CI 0.0-0.5%)` where the bound gives `0.0% (95% CI 0.0-27.1%)` for the
      // same count. A zero can also never be told from an estimated one, whereas the bound comes
      // with `rhoSource` saying `'assumed-perfect'`: an assumption, named as one.
      //
      // The counts here are a reading of a LIVE store (this repo's own), so they move as entries
      // are recorded; the ratio and the direction do not.
      rho = 1;
      rhoSource = 'assumed-perfect';
    } else {
      const raw = (meanSquareBetween - meanSquareWithin) / denominator;
      rho = Math.min(1, Math.max(0, raw));
      rhoSource = 'estimated';
    }
  }

  const designEffect = 1 + (sizeFactor - 1) * rho;
  return {
    n,
    clusters: k,
    largestCluster,
    rho,
    rhoSource,
    designEffect,
    effectiveN: n / designEffect,
  };
}
