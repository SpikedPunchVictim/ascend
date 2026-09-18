/**
 * Association between two categorical properties -- and, the point of the module, a RANKING that
 * says which of many pairs is worth a human's attention.
 *
 * WHY A RANKING IS THE DELIVERABLE. Ten properties make forty-five pairs, and a reader cannot look
 * at forty-five crosstabs. The bead (`asc-0tw`) states the job as "this says which 5 are worth
 * looking at", which makes the ORDER the product and the individual statistic a means to it. That
 * reframing is what most of the decisions below fall out of: a statistic that is fine for judging
 * one table in isolation can still produce a ranking that is mostly artefact.
 *
 * THREE WAYS THAT GOES WRONG, AND WHAT IS DONE ABOUT EACH.
 *
 *   1. **Ranking by p-value ranks by sample size.** Chi-square grows linearly with n at a fixed
 *      effect, so on a corpus of 1,790 entries a trivial association is p < 1e-9 and sorts above an
 *      interesting one measured on 200 rows. Worse, the strongest pairs saturate: a dozen pairs all
 *      report `p = 0` after underflow and the ranking among them is noise. So THE RANK IS BY EFFECT
 *      SIZE, and the p-value is reported beside it as the "could this be nothing?" check it
 *      actually is.
 *
 *   2. **Cramer's V is biased upward, by an amount that grows with the number of categories.** Two
 *      INDEPENDENT columns with eight levels each score a higher raw V than two independent columns
 *      with two levels each -- so a raw-V ranking systematically promotes whichever properties have
 *      the most values, which is a fact about the schema and not about the corpus. Bergsma's bias
 *      correction (2013) subtracts the expected value of phi-square under independence and shrinks
 *      the table dimensions to match; `cramersV` (raw) and `cramersVCorrected` are BOTH reported,
 *      and the ranking uses the corrected one. Keeping both is deliberate: the gap between them is
 *      how much of the raw number was an artefact, and hiding it would make the correction
 *      unfalsifiable.
 *
 *   3. **Forty-five tests at p < 0.05 produce two or three "findings" from pure noise.** This is
 *      not a hypothetical: it is the arithmetic of the bead's own example. Every pair therefore
 *      carries `pAdjusted`, a Benjamini-Hochberg false-discovery-rate q-value computed across the
 *      WHOLE family of pairs in the request. The family is the set the caller asked for, which is
 *      why correction happens in `rankAssociations` and not in `chiSquare` -- a single table has no
 *      family, and a function that corrected one in isolation would be inventing the denominator.
 *
 * THE ASYMPTOTIC P-VALUE HAS A VALIDITY CONDITION AND IT IS REPORTED, NOT ASSUMED. Pearson's
 * chi-square approximates a distribution the statistic only converges to as expected cell counts
 * grow. Cochran's rule -- no expected count below 1, and at most 20% of cells below 5 -- is
 * evaluated per table and returned as `asymptoticValid`, with the two counts behind it. Sparse
 * tables are common here (a ten-level property crossed with another ten-level property on 200 rows
 * has 100 cells and averages two per cell), so this condition would fail often and silently. It
 * fails loudly instead: `chiSquarePValue` is still computed, because refusing to return a number
 * the caller can see is worse than returning one the caller is told to distrust, but a pair whose
 * `asymptoticValid` is false has an unreliable p and `permutationNull` is the way to get a real one.
 *
 * MUTUAL INFORMATION IS REPORTED, IN BITS, AND IT IS NOT THE RANK. MI answers a different and
 * genuinely useful question -- "how many bits of one property does the other tell me?" -- and it is
 * scale-free in a way V is not. It is not the ranking key because it is biased upward by the same
 * mechanism as V, more severely, and the standard corrections for it are estimator-dependent in a
 * way this module has no anchors for. `uncertainty` (symmetric uncertainty, 2*MI/(H(a)+H(b))) is
 * the normalised form, in [0,1], for readers who want MI on a comparable scale.
 *
 * ABSENCE IS A DECISION THE CALLER MAKES. ascend's three-state property model means a value can be
 * genuinely absent, and the two defensible treatments answer different questions. Excluding those
 * rows (`absent: 'exclude'`, the default) asks "among entries that have both, are they related?".
 * Keeping absence as its own level (`absent: 'level'`) asks "are these two properties present
 * together?", which on this corpus is largely a question about entry TYPE -- properties belonging
 * to one type are absent in lockstep everywhere else, and that shows up as an overwhelming
 * association that is true, uninteresting, and drowns everything else. Neither is right in general,
 * so neither is chosen here; `n` and `excluded` are reported so the shrinkage from the default is
 * visible rather than inferred.
 *
 * PORTED, NOT WRITTEN. `crosstab`, `chiSquare`, `chiSquarePValue` and `permutationNull` come from
 * `spike/lib/stats.mjs`, which validated them against published chi-square table values
 * (chi2 = 3.841458820694124 at df=1 gives p = 0.05; 5.991464547107979 at df=2; 12.591587243743977
 * at df=6) and hand-computed worked examples. Those anchors are carried unchanged into
 * `test/association.test.ts`. The bias correction, the FDR control, the Cochran check, the mutual
 * information and the ranking are new, and each arrived with its own hand-computed anchor for the
 * same reason: a statistic checked against its own output proves nothing.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`). The only randomness is the permutation control's, and its
 * generator is seeded from `random.ts` -- the same one `sample.ts` draws with, so one store has one
 * notion of a seed.
 */

import { MIN_N } from './proportion.js';
import { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

/** A caller handed this module something it will not compute on. */
export class AssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssociationError';
  }
}

/**
 * The separator joining a row key to a column key inside `Crosstab.counts`.
 *
 * NUL, because it is the one byte a property value cannot contain -- any printable separator could
 * appear inside a real value and silently merge two distinct cells into one.
 */
const CELL_SEPARATOR = '\u0000';

/**
 * The level an absent value becomes under `absent: 'level'`.
 *
 * NUL-prefixed for the same reason, and here the reason is load-bearing rather than tidy: a real
 * property value spelled `absent` must not collide with ascend's "there is no value" state, because
 * collapsing those two is exactly the three-state distinction the type system is configured to
 * protect (`exactOptionalPropertyTypes`, `tsconfig.base.json`).
 */
const ABSENT_LEVEL = '\u0000absent';

/**
 * A contingency table over two categorical vectors.
 *
 * `counts` is keyed by row and column joined with `CELL_SEPARATOR`. An absent key means an observed
 * count of zero -- a table over ten-by-ten sparse categories is mostly zeros, and materialising
 * them would cost more than the table.
 */
export interface Crosstab {
  /** Distinct values of the first vector, ascending. */
  readonly rowKeys: readonly string[];
  /** Distinct values of the second vector, ascending. */
  readonly colKeys: readonly string[];
  /** Cell counts, keyed by row and column joined with NUL. */
  readonly counts: ReadonlyMap<string, number>;
  /** Row marginals. */
  readonly rowTotals: ReadonlyMap<string, number>;
  /** Column marginals. */
  readonly colTotals: ReadonlyMap<string, number>;
  /** Rows tabulated. */
  readonly n: number;
}

/** What a chi-square test of independence yields, including the reasons to doubt it. */
export interface ChiSquareResult {
  /** Pearson's chi-square statistic. */
  readonly chi2: number;
  /** Degrees of freedom, `(rows - 1) * (cols - 1)`. */
  readonly df: number;
  /** Upper-tail probability under independence. Trust it only if `asymptoticValid`. */
  readonly p: number;
  /** Cramer's V, uncorrected. Comparable only between tables of the same shape. */
  readonly cramersV: number;
  /** Cramer's V with Bergsma's bias correction. The number the ranking sorts on. */
  readonly cramersVCorrected: number;
  /** Rows tabulated. */
  readonly n: number;
  /** Cells in the table, `rows * cols`. */
  readonly cells: number;
  /** The smallest expected count in any cell. */
  readonly minExpected: number;
  /** Cells whose expected count is below 5. */
  readonly cellsBelowFive: number;
  /** Cochran's rule: `minExpected >= 1` and `cellsBelowFive` at most 20% of `cells`. */
  readonly asymptoticValid: boolean;
}

/** What one vector tells you about the other, in bits. */
export interface MutualInformationResult {
  /** Mutual information, in bits. Zero under exact independence. */
  readonly bits: number;
  /** Entropy of the first vector, in bits. */
  readonly entropyA: number;
  /** Entropy of the second vector, in bits. */
  readonly entropyB: number;
  /** Symmetric uncertainty, `2 * bits / (entropyA + entropyB)`, in [0,1]. */
  readonly uncertainty: number;
}

/** One named categorical column, as `rankAssociations` consumes them. */
export interface AssociationColumn {
  /** What the column is called in the output. */
  readonly name: string;
  /** One opaque key per item, or `null` where the item has no value for this property. */
  readonly values: readonly (string | null)[];
}

/** How `rankAssociations` is asked for its ranking. */
export interface AssociationOptions {
  /** `exclude` (default) drops rows missing either value; `level` makes absence its own category. */
  readonly absent?: 'exclude' | 'level';
  /** Pairs with fewer usable rows than this are flagged `underpowered`. Default `MIN_N`. */
  readonly minN?: number;
  /** Permutation iterations for the empirical p. Default 0 -- off, because it costs n*iterations. */
  readonly permutations?: number;
  /** Seed for the permutation control. Default `DEFAULT_SEED`. */
  readonly seed?: string;
}

/** One pair of properties, measured. */
export interface PairAssociation extends ChiSquareResult {
  /** The first column's name. */
  readonly a: string;
  /** The second column's name. */
  readonly b: string;
  /** Rows dropped because one of the two values was absent. */
  readonly excluded: number;
  /** Mutual information between the two, in bits. */
  readonly mutualInformation: number;
  /** Symmetric uncertainty, in [0,1]. */
  readonly uncertainty: number;
  /** Benjamini-Hochberg q-value across every pair in the same request. */
  readonly pAdjusted: number;
  /** True when `n` is below `minN`: an anecdote about a pair, not an estimate. */
  readonly underpowered: boolean;
  /** Empirical p from the permutation control, present only when `permutations > 0`. */
  readonly pPermuted?: number;
}

/** The ranking, with the family size the correction was computed against. */
export interface AssociationReport {
  /** Every pair, ordered by `cramersVCorrected` descending. */
  readonly pairs: readonly PairAssociation[];
  /** Pairs tested -- the denominator the FDR correction used. */
  readonly family: number;
  /** Items each column was measured over, before any exclusion. */
  readonly items: number;
}

/** The permutation control's null distribution. */
export interface PermutationNull {
  /** Shuffles performed. */
  readonly iterations: number;
  /** Median chi-square under the null. */
  readonly median: number;
  /** 95th percentile chi-square under the null. */
  readonly p95: number;
  /** Largest chi-square any shuffle produced. */
  readonly max: number;
  /** Fraction of shuffles at least as extreme as `observed`, with the +1 correction. */
  pValue(observed: number): number;
}

/**
 * Log-gamma (Lanczos approximation), the workhorse for the chi-square tail.
 *
 * FOUR CONSTANTS ARE SPELLED DIFFERENTLY FROM THE SPIKE AND THE PUBLISHED TABLE, and every one of
 * them is the SAME DOUBLE -- a spelling change, not an arithmetic one. Recorded rather than left
 * for a reader to trip over while diffing against Numerical Recipes:
 *
 *   `0.1208650973866179e-2` -> `1.208650973866179e-3`   (leading-zero form carries 19 digits)
 *   `-0.5395239384953e-5`   -> `-5.395239384953e-6`     (same)
 *   `-86.50532032941677`    -> `-86.50532032941678`     (the shortest form that round-trips)
 *   `2.5066282746310005`    -> `2.5066282746310007`     (same)
 *
 * `no-loss-of-precision` refuses a literal whose decimal text does not round-trip through the
 * nearest double, which the original four do not. Each replacement was checked to parse to a
 * bit-identical value before it was made; the rule is exactly right to insist, because a literal
 * that does not round-trip is one whose written value and actual value differ.
 */
function logGamma(x: number): number {
  const g = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    1.208650973866179e-3, -5.395239384953e-6,
  ] as const;
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += (g[j] as number) / y;
  }
  return -tmp + Math.log((2.5066282746310007 * ser) / x);
}

/**
 * Regularized lower incomplete gamma P(a, x).
 *
 * Series below the crossover and continued fraction above it -- the standard split, because each
 * form converges badly in the other's range.
 */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;

  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 500; n += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }

  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Upper tail probability of the chi-square distribution: P(X^2 > x). */
export function chiSquarePValue(chi2: number, df: number): number {
  if (df <= 0) return 1;
  if (chi2 <= 0) return 1;
  return 1 - gammaP(df / 2, chi2 / 2);
}

/** The NUL-joined cell key. */
function cellKey(row: string, col: string): string {
  return `${row}${CELL_SEPARATOR}${col}`;
}

/**
 * Contingency table from two aligned label vectors.
 *
 * Refuses vectors of different lengths rather than tabulating the overlap: a length mismatch means
 * the caller's two columns are not about the same items, and silently truncating to the shorter one
 * would produce a table that looks fine and means nothing.
 */
export function crosstab(a: readonly string[], b: readonly string[]): Crosstab {
  if (a.length !== b.length)
    throw new AssociationError(
      `crosstab: vectors must be the same length (got ${String(a.length)} and ${String(b.length)})`,
    );

  const counts = new Map<string, number>();
  const rowTotals = new Map<string, number>();
  const colTotals = new Map<string, number>();

  for (let i = 0; i < a.length; i += 1) {
    const row = a[i] as string;
    const col = b[i] as string;
    const key = cellKey(row, col);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    rowTotals.set(row, (rowTotals.get(row) ?? 0) + 1);
    colTotals.set(col, (colTotals.get(col) ?? 0) + 1);
  }

  return {
    rowKeys: [...rowTotals.keys()].sort(),
    colKeys: [...colTotals.keys()].sort(),
    counts,
    rowTotals,
    colTotals,
    n: a.length,
  };
}

/**
 * Pearson's chi-square, Cramer's V raw and corrected, and the validity of the p-value.
 *
 * A table with no rows, or with only one row or one column, has no association to measure: df is 0
 * and everything is reported as zero with `p = 1`. That is the honest answer -- there is no
 * uncertainty about a variable that does not vary -- rather than an error, because a ranking over
 * many pairs will legitimately contain constant columns and should show them as uninformative
 * instead of failing.
 */
export function chiSquare(table: Crosstab): ChiSquareResult {
  const { rowKeys, colKeys, counts, rowTotals, colTotals, n } = table;
  const rows = rowKeys.length;
  const cols = colKeys.length;
  const cells = rows * cols;

  if (n === 0 || rows < 2 || cols < 2)
    return {
      chi2: 0,
      df: 0,
      p: 1,
      cramersV: 0,
      cramersVCorrected: 0,
      n,
      cells,
      minExpected: 0,
      cellsBelowFive: cells,
      asymptoticValid: false,
    };

  let chi2 = 0;
  let minExpected = Number.POSITIVE_INFINITY;
  let cellsBelowFive = 0;

  for (const r of rowKeys) {
    for (const c of colKeys) {
      const observed = counts.get(cellKey(r, c)) ?? 0;
      const expected = ((rowTotals.get(r) as number) * (colTotals.get(c) as number)) / n;
      if (expected < minExpected) minExpected = expected;
      if (expected < 5) cellsBelowFive += 1;
      if (expected > 0) chi2 += (observed - expected) ** 2 / expected;
    }
  }

  const df = (rows - 1) * (cols - 1);
  const k = Math.min(rows, cols);
  const phi2 = chi2 / n;
  const cramersV = Math.sqrt(phi2 / (k - 1));

  // Bergsma (2013): subtract phi-square's expectation under independence, and shrink the table
  // dimensions by the same reasoning, before taking the ratio. Both numerator and denominator are
  // floored -- the correction can overshoot on a table already at independence, and a negative
  // under the square root would be NaN where the honest answer is "no effect". With n = 1 the
  // corrections divide by zero, which is why `kCorrected > 0` gates the whole expression rather
  // than just the square root.
  const phi2Corrected = Math.max(0, phi2 - df / (n - 1));
  const rowsCorrected = rows - (rows - 1) ** 2 / (n - 1);
  const colsCorrected = cols - (cols - 1) ** 2 / (n - 1);
  const kCorrected = Math.min(rowsCorrected, colsCorrected) - 1;
  const cramersVCorrected =
    Number.isFinite(kCorrected) && kCorrected > 0 ? Math.sqrt(phi2Corrected / kCorrected) : 0;

  return {
    chi2,
    df,
    p: chiSquarePValue(chi2, df),
    cramersV,
    cramersVCorrected,
    n,
    cells,
    minExpected,
    cellsBelowFive,
    asymptoticValid: minExpected >= 1 && cellsBelowFive <= 0.2 * cells,
  };
}

/** Shannon entropy in bits of a marginal count map. */
function entropy(totals: ReadonlyMap<string, number>, n: number): number {
  let h = 0;
  for (const count of totals.values()) {
    if (count === 0) continue;
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Mutual information in bits, with the entropies it is a fraction of.
 *
 * Reported alongside chi-square rather than instead of it because the two disagree usefully: MI is
 * insensitive to sample size where chi-square is proportional to it, so a pair with a large chi2
 * and a near-zero MI is a real but tiny effect measured on a lot of rows -- exactly the case a
 * p-value ranking puts at the top and a reader should put near the bottom.
 */
export function mutualInformation(table: Crosstab): MutualInformationResult {
  const { rowKeys, colKeys, counts, rowTotals, colTotals, n } = table;
  if (n === 0) return { bits: 0, entropyA: 0, entropyB: 0, uncertainty: 0 };

  let bits = 0;
  for (const r of rowKeys) {
    for (const c of colKeys) {
      const observed = counts.get(cellKey(r, c)) ?? 0;
      if (observed === 0) continue;
      const pxy = observed / n;
      const px = (rowTotals.get(r) as number) / n;
      const py = (colTotals.get(c) as number) / n;
      bits += pxy * Math.log2(pxy / (px * py));
    }
  }

  const entropyA = entropy(rowTotals, n);
  const entropyB = entropy(colTotals, n);
  const denominator = entropyA + entropyB;

  // Floating-point error can push an exactly-independent table a hair below zero, and a negative
  // mutual information is not a thing. Clamped rather than left to surprise a reader.
  const clamped = Math.max(0, bits);

  return {
    bits: clamped,
    entropyA,
    entropyB,
    uncertainty: denominator > 0 ? Math.min(1, (2 * clamped) / denominator) : 0,
  };
}

/**
 * Permutation control: the chi-square distribution obtainable when `b`'s labels are shuffled.
 *
 * WHAT IT IS FOR. The asymptotic p-value is an approximation with a validity condition
 * (`asymptoticValid`), and on a sparse table it fails in the anti-conservative direction -- it
 * reports significance that is not there. The permutation null has no such condition: it holds both
 * sets of marginals fixed and asks how much chi-square those marginals alone can manufacture. If
 * the observed statistic sits inside that distribution, the "pattern" is an artefact of the
 * marginal counts rather than evidence of association.
 *
 * The RNG is seeded from `random.ts`, so a control is reproducible from its parameters -- the same
 * contract every other number in this package is held to.
 */
export function permutationNull(
  a: readonly string[],
  b: readonly string[],
  options: { readonly iterations?: number; readonly seed?: string } = {},
): PermutationNull {
  const iterations = options.iterations ?? 500;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new AssociationError(
      `permutationNull: iterations must be a positive integer (got ${String(iterations)})`,
    );

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const shuffled = [...b];
  const stats: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    // Fisher-Yates, using the injected deterministic generator. The array is shuffled in place and
    // carried between iterations: each iteration is a fresh permutation of the previous one, which
    // is as uniform as restarting from the original and costs one less copy per iteration.
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      const held = shuffled[j] as string;
      shuffled[j] = shuffled[k] as string;
      shuffled[k] = held;
    }
    stats.push(chiSquare(crosstab(a, shuffled)).chi2);
  }

  stats.sort((x, y) => x - y);
  const at = (q: number): number =>
    stats[Math.min(stats.length - 1, Math.floor(q * stats.length))] as number;

  return {
    iterations,
    median: at(0.5),
    p95: at(0.95),
    max: stats[stats.length - 1] as number,
    pValue(observed: number): number {
      const ge = stats.filter((s) => s >= observed).length;
      // The +1 in both places is the standard correction, and it is the reason this function can be
      // trusted at the extreme: a permutation test may never honestly report p = 0, because the
      // observed arrangement is itself one of the arrangements it is being compared against.
      return (ge + 1) / (iterations + 1);
    },
  };
}

/**
 * Benjamini-Hochberg step-up q-values, returned in the input order.
 *
 * Chosen over Bonferroni because the question here is triage, not confirmation: the caller wants
 * the five pairs worth opening, and controlling the expected FRACTION of those five that are noise
 * is the right guarantee. Bonferroni controls the probability of ANY false positive across the
 * family, which at 45 tests is so conservative that a real, moderate association on a few hundred
 * rows would be suppressed -- trading the error this module exists to prevent for its opposite.
 *
 * EXPORTED BECAUSE IT IS TESTABLE ON ITS OWN. The correction is the part of this module most likely
 * to be silently wrong -- the step-up direction and the monotonicity clamp are both easy to get
 * backwards, and neither mistake changes the shape of the output. So it is checked directly against
 * hand-computed q-values rather than inferred from a ranking that would look plausible either way.
 *
 * THERE IS NO CLAMP TO 1 IN THE LOOP, AND THAT IS NOT AN OMISSION. `running` starts at 1 and only
 * ever decreases, so it is itself the cap; a `Math.min(1, ...)` inside the loop would be a line that
 * can never fire, and an unreachable guard reads to the next author as evidence of a case that
 * exists. The initialisation is the guard, stated here so it is not "simplified" away later.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];

  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m).fill(1);
  let running = 1;

  // Step UP -- from the largest p downward -- so the running minimum enforces monotonicity: a
  // q-value may never exceed that of a larger p-value.
  for (let rank = m; rank >= 1; rank -= 1) {
    const entry = order[rank - 1] as { p: number; index: number };
    running = Math.min(running, (m / rank) * entry.p);
    adjusted[entry.index] = running;
  }

  return adjusted;
}

/**
 * Every pair of columns, measured and ranked by corrected effect size.
 *
 * THE CALL BOUNDARY IS LOAD-BEARING. The family for the FDR correction is every pair in THIS call,
 * so asking about ten columns and asking twice about five are different questions with different
 * q-values. That is a property of multiple-comparison control rather than a quirk of this
 * implementation, and `family` is reported so a reader can see which question was asked instead of
 * having to reconstruct it from the number of rows.
 */
export function rankAssociations(
  columns: readonly AssociationColumn[],
  options: AssociationOptions = {},
): AssociationReport {
  if (columns.length < 2)
    throw new AssociationError(
      `rankAssociations: needs at least two columns (got ${String(columns.length)})`,
    );

  const items = columns[0]?.values.length ?? 0;
  const seen = new Set<string>();
  for (const column of columns) {
    if (column.values.length !== items)
      throw new AssociationError(
        `rankAssociations: column '${column.name}' has ${String(column.values.length)} values, expected ${String(items)}`,
      );
    if (seen.has(column.name))
      throw new AssociationError(`rankAssociations: duplicate column name '${column.name}'`);
    seen.add(column.name);
  }

  const keepAbsent = options.absent === 'level';
  const minN = options.minN ?? MIN_N;
  const permutations = options.permutations ?? 0;
  const seed = options.seed ?? DEFAULT_SEED;

  type Measured = Omit<PairAssociation, 'pAdjusted'>;
  const measured: Measured[] = [];

  for (let i = 0; i < columns.length; i += 1) {
    for (let j = i + 1; j < columns.length; j += 1) {
      const left = columns[i] as AssociationColumn;
      const right = columns[j] as AssociationColumn;

      const a: string[] = [];
      const b: string[] = [];
      for (let row = 0; row < items; row += 1) {
        const x = left.values[row] ?? null;
        const y = right.values[row] ?? null;
        if ((x === null || y === null) && !keepAbsent) continue;
        a.push(x ?? ABSENT_LEVEL);
        b.push(y ?? ABSENT_LEVEL);
      }

      const table = crosstab(a, b);
      const test = chiSquare(table);
      const info = mutualInformation(table);
      const pPermuted =
        permutations > 0 && table.n > 0
          ? permutationNull(a, b, { iterations: permutations, seed }).pValue(test.chi2)
          : undefined;

      measured.push({
        ...test,
        a: left.name,
        b: right.name,
        excluded: items - table.n,
        mutualInformation: info.bits,
        uncertainty: info.uncertainty,
        underpowered: table.n < minN,
        // `exactOptionalPropertyTypes` is on, so the key is OMITTED rather than set to undefined.
        // That is the same three-state discipline the rest of the store keeps: "no control was run"
        // and "the control returned nothing" are different facts and must not serialise alike.
        ...(pPermuted === undefined ? {} : { pPermuted }),
      });
    }
  }

  const adjusted = benjaminiHochberg(measured.map((pair) => pair.p));
  const pairs = measured
    .map((pair, index) => ({ ...pair, pAdjusted: adjusted[index] as number }))
    // Effect size first, p as the tie-break, then the names -- so a ranking is fully determined and
    // two runs over one corpus produce the same order rather than the same set in a new arrangement.
    .sort(
      (x, y) =>
        y.cramersVCorrected - x.cramersVCorrected ||
        x.p - y.p ||
        (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
        (x.b < y.b ? -1 : x.b > y.b ? 1 : 0),
    );

  return { pairs, family: measured.length, items };
}
