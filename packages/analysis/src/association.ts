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
 * FIVE WAYS THAT GOES WRONG, AND WHAT IS DONE ABOUT EACH.
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
 *   4. **THE STRONGEST PAIR CAN BE A TAUTOLOGY, AND IT SURVIVES EVERY CONTROL ABOVE.** A pair of
 *      properties that name the same thing -- a project and its repo, a timestamp and the weekday
 *      derived from it -- scores a large V, a tiny p, and a mutual information larger than anything
 *      else in the request, because it IS the same fact stated twice. Worse, it survives the shuffled
 *      control for the wrong reason: shuffling destroys the identity, the association goes with it,
 *      and "the finding disappeared under shuffling" is exactly what a FALSE association looks like,
 *      so the control confirms it. `functionalDependence` measures how nearly one column maps onto
 *      the other, and pairs at or above `DEFINITIONAL_AT` are suppressed from the ranking and
 *      disclosed by name rather than silently dropped.
 *
 *   5. **A TIME-DERIVED DIMENSION MANUFACTURES ASSOCIATIONS THE SHUFFLE CANNOT SEE.** A temporal
 *      label is a function of the block it came from, so a corpus with one dominant day produces a
 *      weekday association that is real in the marginals and spurious as a pairing -- and shuffling
 *      cannot see it, because the marginal concentration survives the shuffle intact. `permutationNull`
 *      holds both marginals fixed, which is the wrong thing to hold: the question is whether the
 *      concentration is explained by the BLOCK structure, and `blockPermutationNull` answers it by
 *      holding the blocks fixed and permuting only the labels.
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
  /**
   * True when this column's values came from a timestamp -- a date, a weekday, a month.
   *
   * DECLARED BY THE CALLER, NEVER SNIFFED. Only the caller knows that a value was derived from a time
   * (`2026-09-03` and `Thursday` look like any other two strings), and a module that guessed from the
   * text would be right often enough to be believed and wrong often enough to matter. The flag does
   * one thing: it is what makes a pair eligible for `blockPermutationNull`, because only a
   * block-derived column has a block-to-label pairing that can be permuted.
   */
  readonly temporal?: boolean;
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
  /**
   * One block id per item -- a day, a session, whatever the temporal column was derived from.
   *
   * When supplied, every pair that contains a `temporal` column also gets `pBlocked`, the empirical p
   * from permuting the temporal labels AMONG these blocks. The blocks are the rows of the question
   * "is this pairing over time, or is it the block structure?", and the corpus this exists for is a
   * 409-row one where a single day contributes 143 of the rows.
   */
  readonly blocks?: readonly (string | null)[];
  /** Block-control iterations. Default 0 -- off. Only meaningful alongside `blocks`. */
  readonly blockPermutations?: number;
}

/** A pair removed from the ranking because it was the same fact stated twice. */
export interface SuppressedPair {
  /** The first column's name. */
  readonly a: string;
  /** The second column's name. */
  readonly b: string;
  /** The coefficient that put it over `DEFINITIONAL_AT`. */
  readonly determinism: number;
  /** Rows the suppressed pair was measured on. */
  readonly n: number;
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
  /**
   * How nearly each column determines the other, in both directions.
   *
   * Reported on EVERY pair, including the ones the ranking keeps: a pair at 0.49 and a pair at 0.05
   * are both "not definitional" and are not remotely the same finding, so the coefficient has to be
   * readable rather than replaced by the verdict. This is the number a reader argues with when the
   * threshold suppresses something they believe.
   */
  readonly dependence: FunctionalDependence;
  /** Benjamini-Hochberg q-value across every pair in the same request. */
  readonly pAdjusted: number;
  /** True when `n` is below `minN`: an anecdote about a pair, not an estimate. */
  readonly underpowered: boolean;
  /** Empirical p from the permutation control, present only when `permutations > 0`. */
  readonly pPermuted?: number;
  /** Empirical p from the block control, present only when `blocks` and `blockPermutations` are set. */
  readonly pBlocked?: number;
}

/** The ranking, with the family size the correction was computed against. */
export interface AssociationReport {
  /** Every pair that survived, ordered by `cramersVCorrected` descending. */
  readonly pairs: readonly PairAssociation[];
  /** Pairs the FDR correction was computed over -- the pairs that survived, not every pair tested. */
  readonly family: number;
  /** Items each column was measured over, before any exclusion. */
  readonly items: number;
  /**
   * Pairs removed as definitional, with the coefficient that removed them.
   *
   * NOTHING IS HIDDEN. A suppressed pair is the strongest thing in many requests -- it is the same
   * fact twice, so it scores highest -- and a ranking that silently dropped it would be
   * indistinguishable from one over a corpus that never had it. The disclosure is the whole reason
   * suppression is defensible: a reader can see that `project x repo` was removed and at 0.828, and
   * disagree. The same rule the store keeps for struck records.
   */
  readonly suppressed: readonly SuppressedPair[];
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
 * One cell's observed count.
 *
 * `counts` is keyed by `cellKey`, and `CELL_SEPARATOR` is private to this module -- so a `Crosstab`
 * handed to any other package carries a field nothing outside here can read. That is the defect
 * this accessor closes, and `asc stats --correlate` is what surfaced it: printing the table a
 * chi-square was computed from is the ordinary thing a caller wants next, and doing it required
 * either re-exporting the separator (making the encoding part of the contract) or counting the
 * pairs a second time in the CLI (two counters that can disagree about one table).
 *
 * An absent key is an observed zero rather than an unknown, which is the one case where `0` is the
 * honest answer and not `TASKS.md` #7's forbidden fill-in: `crosstab` saw every row, so a
 * combination it did not record is a combination that did not occur.
 */
export function cell(table: Crosstab, row: string, col: string): number {
  return table.counts.get(cellKey(row, col)) ?? 0;
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
 * Determinism at or above which a pair is DEFINITIONAL -- one property restating the other -- rather
 * than a finding about the corpus.
 *
 * WHY THIS EXISTS (asc-fwpe; `docs/evidence/EV-patterns.md`, Amendment 2026-10-05).
 * `docs/evidence/EV-patterns.md` reports `project x repo`
 * as the corpus's strongest association -- V ~ 0.76, surviving the shuffled control. It is the same
 * fact twice: a project identifier and its repo name are near-copies. Shuffling cannot see that,
 * because shuffling destroys the identity and the association goes with it; the finding "survives"
 * for the wrong reason. A reader who is shown it has been handed a tautology dressed as a discovery.
 *
 * THE VALUE IS JUSTIFIED BY A MEASURED GAP, NOT CHOSEN. Measuring `U = 1 - H(Y|X)/H(Y)` in both
 * directions across all ten `tool-denial` pairs in the checked-in corpus (N=409, 2026-10-05) gives:
 *
 *     project x repo              0.828    <- the tautology
 *     -- a 2.1x gap --
 *     denial_kind x project        0.389
 *     the seven others             0.123 - 0.365
 *
 * So 0.5 sits inside a gap that exists in the data, which is the only thing that distinguishes a
 * threshold from a taste. STRICTLY functional dependency would not work here and this is the part
 * worth keeping: `project -> repo` is not a function (align has `main` and `fix`; grizzly-wip has
 * three) and neither is `repo -> project` (`main` spans five projects), so a strict test fires on
 * NOTHING -- it would suppress no tautology and pass review while reporting one as the top finding.
 *
 * WHAT IT COSTS, STATED PLAINLY. The gap is 0.389-0.828 on one 409-row corpus from one user on one
 * machine; another corpus may not have a gap at all. Two things bound the damage: every pair reports
 * its own coefficient, so a near-miss is visible and arguable, and suppression is disclosed by name
 * rather than silent (see `AssociationReport.suppressed`). The threshold is a fixed constant rather
 * than an option because a per-request knob would make two runs incomparable, and a reader could not
 * tell a suppressed finding from one that was never there.
 */
export const DEFINITIONAL_AT = 0.5;

/** How nearly one of two columns determines the other -- the uncertainty coefficient, both ways. */
export interface FunctionalDependence {
  /** Share of `b`'s entropy that knowing `a` removes: `MI / H(b)`, in [0,1]. */
  readonly aToB: number;
  /** Share of `a`'s entropy that knowing `b` removes: `MI / H(a)`, in [0,1]. */
  readonly bToA: number;
  /** The larger of the two. A pair is definitional if EITHER direction is a near-map. */
  readonly determinism: number;
  /** `determinism >= DEFINITIONAL_AT`. */
  readonly definitional: boolean;
}

/**
 * How nearly each column determines the other, and whether that makes the pair definitional.
 *
 * BOTH DIRECTIONS ARE REPORTED, AND THEY ARE NOT AVERAGED. `a -> b` and `b -> a` answer different
 * questions and the asymmetric case is the common one: in the corpus, `denial_kind -> project` is
 * 0.389 while `project -> denial_kind` is 0.123. A symmetric summary would report 0.256 and hide that
 * one of the two is three times the other -- and it is the larger that decides definitionality,
 * because a pair is a tautology if either side restates the other.
 *
 * THIS IS NOT SYMMETRIC UNCERTAINTY, and the difference is the point. `uncertainty` (2*MI/(H(a)+H(b)))
 * is a property of the PAIR; `determinism` is a property of a DIRECTION. A pair can score modest
 * uncertainty while one direction is a near-perfect map, which is exactly the `project x repo` shape.
 *
 * No new entropy arithmetic: `mutualInformation` already returns `bits`, `entropyA` and `entropyB`,
 * and `U(a->b) = bits / entropyB` exactly. A second entropy function here would be a second thing
 * that has to agree with the first.
 */
export function functionalDependence(table: Crosstab): FunctionalDependence {
  const { bits, entropyA, entropyB } = mutualInformation(table);

  // A column with one level has H = 0, so the ratio is 0/0. `Math.min(1, ...)` is not cosmetic
  // either: MI <= min(H(a), H(b)) mathematically, but the two are computed by different sums, so a
  // perfect map can land an ulp above 1 and report a determinism no probability supports.
  const aToB = entropyB > 0 ? Math.min(1, bits / entropyB) : 0;
  const bToA = entropyA > 0 ? Math.min(1, bits / entropyA) : 0;
  const determinism = Math.max(aToB, bToA);

  return { aToB, bToA, determinism, definitional: determinism >= DEFINITIONAL_AT };
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
 * WHAT IT CANNOT SEE: A MARGINAL ARTEFACT AND A DEFINITIONAL PAIR, ONLY THE FIRST. The question this
 * answers is "could these marginals ALONE manufacture this chi-square?". It is not "is this one
 * fact recorded twice?" -- that is `functionalDependence`, and no shuffle can reach it. A
 * definitional pair IS strongly associated, so this control reports it correctly and reads as the
 * strongest possible signal while being, as evidence, the wrong instrument. MEASURED on the live
 * store (`asc-jpka`, `spike/jpka-permutation-cost.mjs`): `project x branch` carries determinism
 * 0.876 and is SUPPRESSED as DEFINITIONAL by `asc stats tool_denial --assoc`, and the same columns
 * return p = 0.0002 -- this control's floor at 5,000 iterations -- with a null whose maximum is
 * 1391 against an observed 5828. The association is real; it is the INFERENCE that is out of reach.
 * `rankAssociations` applies the definitional test before the family correction, so the two are not
 * competing verdicts to be reconciled: read them as a pair and never one instead of the other.
 *
 * THERE ARE THREE CONTROLS AND THEY ANSWER THREE DIFFERENT QUESTIONS -- this one: are the marginals
 * enough? `blockPermutationNull`: is the block structure enough? `functionalDependence`: is this
 * one fact twice? A pair can come out clean on any one of them, and a reader who ran a single
 * control has a verdict about a single failure mode.
 *
 * REPRODUCIBLE FROM ITS PARAMETERS AND ITS INPUT ORDER, and only from both. The RNG is seeded from
 * `random.ts`, but Fisher-Yates below walks the array it is GIVEN, so the same multiset in a
 * different order draws different permutations and reports a different p. Measured on the live
 * `project x tool_name` columns at 400 iterations and the shipped seed: 0.209476 read from the files
 * in append order, 0.184539 in the order the command reads them (`ORDER BY recorded_at, id`).
 * Neither is wrong -- any fixed order gives a valid Monte Carlo estimate -- but a published p that
 * omits its row order cannot be re-derived, which is a different failure from being wrong and is
 * harder to notice.
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

  return nullFrom(stats, iterations);
}

/**
 * Summarise a set of null statistics into the shape every permutation control returns.
 *
 * EXTRACTED SO THE TWO CONTROLS CANNOT DRIFT APART (asc-fwpe). `blockPermutationNull` needs the same
 * three quantiles and the same p-value, and the p-value's `+1` correction is the part of this module
 * most worth not having two copies of: it is what stops a permutation test reporting `p = 0`, and a
 * second copy that dropped the `+1` would still return a plausible-looking number. One function, so
 * the correction holds for both by construction rather than by review.
 */
function nullFrom(stats: number[], iterations: number): PermutationNull {
  stats.sort((x, y) => x - y);
  const at = (q: number): number =>
    stats[Math.min(stats.length - 1, Math.floor(q * stats.length))] as number;

  // THE MEDIAN IS WRITTEN OUT RATHER THAN TAKEN FROM `at(0.5)`, and the reason is that the two are
  // not the same statistic on an even count (bug-hunt F1). `at(0.5)` is `stats[floor(0.5 * n)]`,
  // which on an even count is the UPPER of the two middle values; the usual convention -- and the
  // one `cluster.ts:663-669` and `changepoint.ts:152` both implement, the latter saying so in its
  // own comment -- is their AVERAGE. Both modules return this under the name `median`, both are
  // shuffled nulls built the same way, and they are read side by side in the same report, where
  // two different numbers under one name is indistinguishable from a bug in either. Measured on a
  // four-value sample the two conventions differ in the fourth decimal: 0.11705625295804874
  // against 0.11704712354972514.
  //
  // `at` keeps its own convention for `p95` below, where the quantile is the point and there is no
  // sibling reporting the same name.
  //
  // This aligns the convention; it does not yet remove the duplication. Three copies of this
  // two-line rule now exist (`cluster.ts`, `changepoint.ts`, here), which is the shape this
  // function's own docblock says it exists to prevent for the p-value. Extracting one `medianOf`
  // into a shared module is a separate change with its own blast radius; filed rather than folded
  // in here.
  const middle = Math.floor(stats.length / 2);
  const median =
    stats.length % 2 === 1
      ? (stats[middle] as number)
      : ((stats[middle - 1] as number) + (stats[middle] as number)) / 2;

  return {
    iterations,
    median,
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
 * The null a TIME STRUCTURE manufactures: permute the temporal labels among blocks, holding every
 * block's rows, its size and its other column fixed.
 *
 * WHAT QUESTION THIS ANSWERS, AND WHY `permutationNull` CANNOT ASK IT. `permutationNull` shuffles the
 * labels of ONE column freely, so it destroys the association being tested. That makes it blind in a
 * specific and load-bearing direction: a temporal label is a FUNCTION of the block it came from --
 * every entry in a day has that day's weekday -- so a corpus in which one day dominates manufactures
 * a weekday association that is REAL in the marginals and SPURIOUS as an association. Shuffling
 * cannot see this, because the marginal concentration survives the shuffle: it is the *pairing* with
 * time that is false, and shuffling removes everything rather than just the pairing.
 *
 * MEASURED, on the checked-in corpus (`tool-denial`, N=409, 35 days, 2026-09-03 alone contributing
 * 143 of them). Permuting weekday labels among days collapses the weekday pairs, and in three of the
 * four the observed statistic sits BELOW the null median:
 *
 *     project x weekday        observed 327.60   null median 398.41   p 0.9432
 *     repo x weekday           observed 348.07   null median 439.89   p 0.9594
 *     denial_kind x weekday    observed 185.50   null median 195.39   p 0.6225
 *     tool_name x weekday      observed  95.88   null median  85.68   p 0.2667
 *
 * THE TWELVE NUMBERS IN THIS TABLE ARE CORRECTED (2026-10-05, asc-h7nq). This comment published a
 * provisional table -- 310.58 / 355.55 / 0.8594, 329.28 / 399.01 / 0.9078, 181.71 / 190.86 / 0.6053,
 * 85.34 / 75.19 / 0.2685 -- that `IMPLEMENTATION_PLAN.md:4377` records as WRONG and superseded,
 * because none of those four observed statistics could be reproduced from `spike/corpus.db` by any
 * `weekday` derivation or column choice tried. Every value above is what
 * `node spike/spike-controls.mjs` prints today, and the four observed statistics agree exactly with
 * the published table in `docs/evidence/EV-patterns.md`. **The correction reached the plan and not
 * this comment**, so until now the module's own documented evidence disagreed with its own
 * regenerable measurement -- which is `dogfood/0065`.
 *
 * `EV-patterns.md` reported "Thursday 41.1%" as a finding and named this control as the way to test
 * it. The weekday pairs do not survive it -- `tool_name x weekday` is the exception at p 0.2667,
 * above any conventional level, and it is the one pairing whose observed value sits ABOVE the null
 * median. So the day structure -- not the weekday -- is what the first three pairings are shaped by,
 * and the fourth is explained by neither.
 *
 * THIS NULL IS DELIBERATELY NOT MARGINAL-PRESERVING, AND THAT IS THE POINT. It holds `other` and the
 * block structure EXACTLY as observed and destroys only the block-to-temporal pairing. The question
 * is "is this concentration explained by the block structure, or is it in the pairing?", and a
 * marginals-preserving null would hold the very thing under test. `permutationNull` answers the
 * other question -- "could these marginals alone manufacture this?" -- and both are worth asking.
 *
 * THE BLOCK MUST REFINE THE LABEL: each block must carry exactly one temporal value. That is the
 * honest precondition (a day has one weekday; an hour does not have one day), and it is refused
 * rather than repaired, because a block whose rows disagree has no one label to permute and
 * resampling one would be inventing a corpus. A caller who wants to test an hourly label must block
 * by hour, not by day -- and the error says so.
 *
 * `temporal` is the block-derived column and `other` is the one being tested against it. The two are
 * NOT interchangeable: only `temporal`'s block assignment is permuted, so swapping them asks a
 * different question and gets a different null.
 */
export function blockPermutationNull(
  temporal: readonly string[],
  other: readonly string[],
  blocks: readonly (string | null)[],
  options: { readonly iterations?: number; readonly seed?: string } = {},
): PermutationNull {
  const iterations = options.iterations ?? 500;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new AssociationError(
      `blockPermutationNull: iterations must be a positive integer (got ${String(iterations)})`,
    );
  if (temporal.length !== other.length || temporal.length !== blocks.length)
    throw new AssociationError(
      `blockPermutationNull: temporal, other and blocks must be the same length (got ${String(
        temporal.length,
      )}, ${String(other.length)} and ${String(blocks.length)})`,
    );
  if (temporal.length === 0)
    throw new AssociationError('blockPermutationNull: needs at least one row (got 0)');

  // Blocks in first-appearance order, so the null depends on the data and not on how the caller
  // happened to sort its rows.
  const blockOrder: string[] = [];
  const labelOf = new Map<string, string>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === null || block === undefined)
      throw new AssociationError(
        `blockPermutationNull: row ${String(index)} has no block, and a row with no block cannot be given another block's label`,
      );
    const label = temporal[index] as string;
    const seen = labelOf.get(block);
    if (seen === undefined) {
      labelOf.set(block, label);
      blockOrder.push(block);
    } else if (seen !== label)
      throw new AssociationError(
        `blockPermutationNull: block "${block}" carries two temporal values ("${seen}" and "${label}"), so there is no one label to permute -- block by a finer grain than the label`,
      );
  }

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const shuffled = blockOrder.map((block) => labelOf.get(block) as string);
  const assigned = new Map<string, string>();
  const permuted: string[] = new Array<string>(temporal.length);
  const stats: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    // Fisher-Yates over the BLOCKS' labels. Blocks sharing a label may swap freely, which is the
    // mechanism that matters: it is how two days come to share one weekday and merge into a single
    // row of the table, and merging is what moves the statistic.
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      const held = shuffled[j] as string;
      shuffled[j] = shuffled[k] as string;
      shuffled[k] = held;
    }
    for (let index = 0; index < blockOrder.length; index += 1)
      assigned.set(blockOrder[index] as string, shuffled[index] as string);
    for (let index = 0; index < temporal.length; index += 1)
      permuted[index] = assigned.get(blocks[index] as string) as string;
    stats.push(chiSquare(crosstab(permuted, other)).chi2);
  }

  return nullFrom(stats, iterations);
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
  const blockPermutations = options.blockPermutations ?? 0;
  const seed = options.seed ?? DEFAULT_SEED;

  // Blocks are validated ONCE, up front, rather than per pair. A missing block is a caller error
  // about the whole request -- some entry is not in any block -- and a control that silently fell
  // through to "no pBlocked" for every pair would read as "the control ran and found nothing".
  const blocks = options.blocks;
  if (blocks !== undefined) {
    if (blocks.length !== items)
      throw new AssociationError(
        `rankAssociations: blocks has ${String(blocks.length)} entries, expected ${String(items)}`,
      );
    for (let row = 0; row < blocks.length; row += 1) {
      if (blocks[row] === null)
        throw new AssociationError(
          `rankAssociations: item ${String(row)} has no block, so the block control cannot place it in time`,
        );
    }
  }

  type Measured = Omit<PairAssociation, 'pAdjusted'>;
  const measured: Measured[] = [];

  for (let i = 0; i < columns.length; i += 1) {
    for (let j = i + 1; j < columns.length; j += 1) {
      const left = columns[i] as AssociationColumn;
      const right = columns[j] as AssociationColumn;

      const a: string[] = [];
      const b: string[] = [];
      const pairBlocks: string[] = [];
      for (let row = 0; row < items; row += 1) {
        const x = left.values[row] ?? null;
        const y = right.values[row] ?? null;
        if ((x === null || y === null) && !keepAbsent) continue;
        a.push(x ?? ABSENT_LEVEL);
        b.push(y ?? ABSENT_LEVEL);
        // Only the rows that survived, so the blocks stay aligned with `a` and `b` rather than with
        // the caller's original item order -- the two differ exactly when a row was dropped.
        pairBlocks.push(blocks?.[row] as string);
      }

      const table = crosstab(a, b);
      const test = chiSquare(table);
      const info = mutualInformation(table);
      const dependence = functionalDependence(table);
      const pPermuted =
        permutations > 0 && table.n > 0
          ? permutationNull(a, b, { iterations: permutations, seed }).pValue(test.chi2)
          : undefined;

      // Which of the two is the block-derived one. Only the caller has declared this, and only one
      // direction is permutable, so the pair is asked about the column that carries the declaration.
      // When both are temporal the first decides, which is arbitrary but stated and stable -- two
      // different nulls from one request would be worse than an arbitrary but reproducible choice.
      const temporal = left.temporal === true ? left : right.temporal === true ? right : undefined;
      const pBlocked =
        blockPermutations > 0 && blocks !== undefined && temporal !== undefined && table.n > 0
          ? blockPermutationNull(temporal === left ? a : b, temporal === left ? b : a, pairBlocks, {
              iterations: blockPermutations,
              seed,
            }).pValue(test.chi2)
          : undefined;

      measured.push({
        ...test,
        a: left.name,
        b: right.name,
        excluded: items - table.n,
        mutualInformation: info.bits,
        uncertainty: info.uncertainty,
        dependence,
        underpowered: table.n < minN,
        // `exactOptionalPropertyTypes` is on, so the key is OMITTED rather than set to undefined.
        // That is the same three-state discipline the rest of the store keeps: "no control was run"
        // and "the control returned nothing" are different facts and must not serialise alike.
        ...(pPermuted === undefined ? {} : { pPermuted }),
        ...(pBlocked === undefined ? {} : { pBlocked }),
      });
    }
  }

  // SUPPRESSION HAPPENS BEFORE THE FDR CORRECTION, and the order is a decision rather than an
  // implementation detail. A definitional pair cannot be a false discovery -- it is not a discovery
  // at all -- so leaving it in the family would raise the q-value of every real pair in the request
  // to pay for a test nobody should have run. The pairs that reach `benjaminiHochberg` are the ones
  // whose p-values are being asked to mean something.
  const suppressed: SuppressedPair[] = [];
  const surviving = measured.filter((pair) => {
    if (!pair.dependence.definitional) return true;
    suppressed.push({
      a: pair.a,
      b: pair.b,
      determinism: pair.dependence.determinism,
      n: pair.n,
    });
    return false;
  });

  const adjusted = benjaminiHochberg(surviving.map((pair) => pair.p));
  const pairs = surviving
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

  return { pairs, family: surviving.length, items, suppressed };
}
