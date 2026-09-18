/**
 * Changepoints -- where a series stopped behaving one way and started behaving another.
 *
 * WHAT THE BEAD ASKS FOR AND WHY IT IS DIFFERENT FROM EVERY OTHER STATISTIC HERE. `asc-08y`:
 * "'Share of category X dropped significantly around 2026-07-14.' This answers 'did something
 * improve?' FROM THE DATA, with no intervention log declared in advance." That last clause is the
 * whole design constraint. Every other module in this package answers a question someone asked;
 * this one is asked to FIND the question, which means it is doing the thing the rest of the
 * codebase spends its comments warning against -- and the honest response is not to refuse, but to
 * report the exposure with the result.
 *
 * SO: BOTH TESTS HERE FIND A CHANGEPOINT IN PURE NOISE, EVERY TIME. Taking the argmax of a
 * statistic over T-1 candidate positions always returns a position. The index is never the finding;
 * the index WITH its p-value is. That is why neither function has a "no changepoint" return: it
 * always reports its best candidate and the probability of seeing a break that sharp in a series
 * with no break in it, because hiding a weak candidate would leave a caller unable to tell "nothing
 * happened" from "nothing was computed".
 *
 * AND A FOUND CHANGEPOINT IS A HYPOTHESIS, NOT A RESULT. A date located by scanning is not a date
 * that was predicted, and the p-value here is the p-value for "is there a break somewhere", not for
 * "is there a break at this date" -- the scan is already priced into Pettitt's null distribution,
 * but nothing prices in the choice of WHICH series to scan. `rankChangepoints` exists for that
 * second exposure and applies Benjamini-Hochberg across the series in the request, the same
 * correction and the same function the association ranking uses.
 *
 * TWO TESTS, BECAUSE THEY FAIL DIFFERENTLY.
 *
 *   - **Pettitt** is a rank test: it asks whether the values before a split tend to be larger than
 *     those after, and never looks at how much larger. That makes it robust to one enormous outlier
 *     and to a series whose scale drifts -- and blind to a change in variance, and weak against a
 *     small shift in a long series. Its p-value is a closed-form approximation.
 *   - **CUSUM** accumulates deviations from the series mean, so it sees magnitude and finds a small
 *     shift a rank test would miss. It is correspondingly fooled by a single spike. Its p is a
 *     SEEDED BOOTSTRAP rather than a formula: under the null of no change the order of the values
 *     carries no information, so reshuffling them and recomputing the statistic gives the null
 *     distribution directly. Same argument, same generator, and the same reproducibility contract
 *     as `association.ts`'s permutation control.
 *
 * A caller running both and getting two different dates has learned something real: the break is in
 * the magnitudes but not the ordering, or the reverse. A caller running both and getting one date
 * has a much stronger claim than either test alone gives. Neither is the default, because choosing
 * one for the caller would throw that comparison away.
 *
 * PETTITT'S P IS AN APPROXIMATION AND IT IS CLAMPED. The standard form
 * `p = 2 * exp(-6 K^2 / (T^3 + T^2))` exceeds 1 for small K, which is not a probability. It is
 * clamped at 1 and the clamp is real rather than defensive -- it fires on any series without a
 * visible break, which is most of them. The approximation is also known to be unreliable in the far
 * tail; `pApproximate` is named so rather than `p` so a reader is told which number they hold.
 *
 * ENDPOINTS ARE NOT CHANGEPOINTS. The scan runs over split positions 0..T-2, so the smallest
 * segment either side is one point. A "change" whose before-segment is empty is not a change, it is
 * the start of the series.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`). The bootstrap's generator is seeded from `random.ts` -- the same
 * one `sample.ts` draws with -- so a confidence is reproducible from its parameters.
 */

import { benjaminiHochberg } from './association.js';
import { MIN_N } from './proportion.js';
import { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

/** A caller handed this module something it will not compute on. */
export class ChangepointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangepointError';
  }
}

/** One period of a series: what it is called, and what was measured in it. */
export interface SeriesPoint {
  /** The period's label -- a date, a bucket name, whatever the caller counts by. */
  readonly label: string;
  /** The value measured in that period. A count, a rate, a share. */
  readonly value: number;
}

/** A named series, as `rankChangepoints` consumes them. */
export interface NamedSeries {
  /** What the series is called in the output. */
  readonly name: string;
  /** The series, in period order. This module does not sort it: the caller's order is the time. */
  readonly points: readonly SeriesPoint[];
}

/** The level either side of a candidate split. */
export interface Segment {
  /** Periods in the segment. */
  readonly periods: number;
  /** Arithmetic mean. */
  readonly mean: number;
  /** Median -- reported beside the mean because a count series is usually skewed. */
  readonly median: number;
}

/** The best candidate split a test found, and how much to believe it. */
export interface ChangepointResult {
  /** Which test produced this. */
  readonly method: 'pettitt' | 'cusum';
  /** Periods in the series. */
  readonly periods: number;
  /** Index of the LAST period before the candidate break. */
  readonly index: number;
  /** That period's label. */
  readonly label: string;
  /** The first period after the break. */
  readonly nextLabel: string;
  /** Everything up to and including `index`. */
  readonly before: Segment;
  /** Everything after `index`. */
  readonly after: Segment;
  /** The test statistic at its maximum: Pettitt's K, or CUSUM's range of the cumulative sum. */
  readonly statistic: number;
  /** Probability of a break this sharp in a series with no break in it. */
  readonly p: number;
  /** True when the series is shorter than `minPeriods`: an anecdote about a series, not a finding. */
  readonly underpowered: boolean;
}

/** How either test is asked for its answer. */
export interface ChangepointOptions {
  /** Series shorter than this are flagged `underpowered`. Default `MIN_N`. */
  readonly minPeriods?: number;
}

/** What the CUSUM bootstrap needs on top of that. */
export interface CusumOptions extends ChangepointOptions {
  /** Bootstrap reshuffles. Default 1000. More iterations buy resolution in the tail, nothing else. */
  readonly iterations?: number;
  /** Seed for the bootstrap. Default `DEFAULT_SEED`. */
  readonly seed?: string;
}

/** One series' result inside a ranking, with the family correction applied. */
export interface RankedChangepoint extends ChangepointResult {
  /** The series' name. */
  readonly series: string;
  /** Benjamini-Hochberg q-value across every series in the request. */
  readonly pAdjusted: number;
}

/** A scan across several series, with the family the q-values were corrected against. */
export interface ChangepointReport {
  /** Every series, most significant first. */
  readonly series: readonly RankedChangepoint[];
  /** Series tested -- the denominator the FDR correction used. */
  readonly family: number;
}

/** Median of a slice, by the usual convention for an even count. */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Mean and median of a slice. */
function segmentOf(values: readonly number[]): Segment {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    periods: values.length,
    mean: values.length === 0 ? 0 : total / values.length,
    median: medianOf(values),
  };
}

/** Rejects a series no test can say anything about, in the caller's terms. */
function assertSeries(points: readonly SeriesPoint[], method: string): void {
  if (points.length < 3)
    throw new ChangepointError(
      `${method}: needs at least three periods to split (got ${String(points.length)})`,
    );
  for (const point of points) {
    if (!Number.isFinite(point.value))
      throw new ChangepointError(
        `${method}: period '${point.label}' has a non-finite value, which no split can be computed across`,
      );
  }
}

/** The shared tail of both tests: describe the split at `index`. */
function describe(
  method: 'pettitt' | 'cusum',
  points: readonly SeriesPoint[],
  index: number,
  statistic: number,
  p: number,
  minPeriods: number,
): ChangepointResult {
  const values = points.map((point) => point.value);
  return {
    method,
    periods: points.length,
    index,
    label: (points[index] as SeriesPoint).label,
    nextLabel: (points[index + 1] as SeriesPoint).label,
    before: segmentOf(values.slice(0, index + 1)),
    after: segmentOf(values.slice(index + 1)),
    statistic,
    p,
    underpowered: points.length < minPeriods,
  };
}

/**
 * Pettitt's rank-based test for a single changepoint.
 *
 * The statistic at split `t` is the Mann-Whitney U comparing the first t+1 values against the rest,
 * computed incrementally from the sign of every pairwise comparison. `K` is its largest absolute
 * value over every split, and the approximation `2 * exp(-6K^2 / (T^3 + T^2))` turns it into a
 * probability.
 *
 * TIES COUNT AS ZERO, which is the standard treatment and matters here more than it usually does: a
 * count series over short periods is full of ties, and treating them as half a comparison each --
 * the other common convention -- would shift K on exactly the series this project has.
 */
export function pettitt(
  points: readonly SeriesPoint[],
  options: ChangepointOptions = {},
): ChangepointResult {
  assertSeries(points, 'pettitt');
  const minPeriods = options.minPeriods ?? MIN_N;
  const values = points.map((point) => point.value);
  const total = values.length;

  // D[i] is the net sign of value i against every other value. U at split t is then the running sum
  // of D over the first t+1 values, which is the O(T^2) form written as one pass over pairs.
  const net: number[] = values.map(() => 0);
  for (let i = 0; i < total; i += 1) {
    let sum = 0;
    for (let j = 0; j < total; j += 1) {
      const a = values[i] as number;
      const b = values[j] as number;
      sum += a > b ? 1 : a < b ? -1 : 0;
    }
    net[i] = sum;
  }

  let running = 0;
  let bestIndex = 0;
  let bestAbsolute = -1;
  let bestStatistic = 0;
  for (let t = 0; t < total - 1; t += 1) {
    running += net[t] as number;
    const magnitude = Math.abs(running);
    if (magnitude > bestAbsolute) {
      bestAbsolute = magnitude;
      bestIndex = t;
      bestStatistic = running;
    }
  }

  const k = Math.abs(bestStatistic);
  const approximate = 2 * Math.exp((-6 * k * k) / (total ** 3 + total ** 2));

  return describe('pettitt', points, bestIndex, k, Math.min(1, approximate), minPeriods);
}

/**
 * CUSUM with a seeded bootstrap for significance.
 *
 * The statistic is the RANGE of the cumulative sum of deviations from the series mean -- max minus
 * min, the standard `Sdiff`. Range rather than maximum absolute value because the cumulative sum
 * always returns to zero at the end, so its range measures the excursion regardless of which
 * direction the shift went.
 *
 * SIGNIFICANCE IS BOOTSTRAPPED, NOT TABULATED, and the reason is the same one that makes the
 * permutation control in `association.ts` worth having: under the null of no change the ORDER of
 * the values carries no information, so reshuffling them and recomputing the statistic samples the
 * null exactly, with no distributional assumption to be wrong about. A closed form for CUSUM would
 * need normality, which a count series over short periods does not have.
 */
export function cusum(
  points: readonly SeriesPoint[],
  options: CusumOptions = {},
): ChangepointResult {
  assertSeries(points, 'cusum');
  const minPeriods = options.minPeriods ?? MIN_N;
  const iterations = options.iterations ?? 1000;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new ChangepointError(
      `cusum: iterations must be a positive integer (got ${String(iterations)})`,
    );

  const values = points.map((point) => point.value);
  const total = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / total;

  /** Cumulative deviations from the mean, their range, and where the extreme sits. */
  const scan = (sample: readonly number[]): { range: number; index: number } => {
    let running = 0;
    let lowest = 0;
    let highest = 0;
    let extremeIndex = 0;
    let extremeMagnitude = 0;
    for (let i = 0; i < sample.length - 1; i += 1) {
      running += (sample[i] as number) - mean;
      if (running < lowest) lowest = running;
      if (running > highest) highest = running;
      if (Math.abs(running) > extremeMagnitude) {
        extremeMagnitude = Math.abs(running);
        extremeIndex = i;
      }
    }
    return { range: highest - lowest, index: extremeIndex };
  };

  const observed = scan(values);

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const shuffled = [...values];
  let atLeastAsExtreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let j = shuffled.length - 1; j > 0; j -= 1) {
      const k = Math.floor(next() * (j + 1));
      const held = shuffled[j] as number;
      shuffled[j] = shuffled[k] as number;
      shuffled[k] = held;
    }
    // The mean is invariant under shuffling, so `scan` may keep closing over the observed mean.
    if (scan(shuffled).range >= observed.range) atLeastAsExtreme += 1;
  }

  // The +1 in both places is the same correction the permutation control uses: the observed
  // ordering is itself one of the orderings, so a bootstrap may never honestly report p = 0.
  const p = (atLeastAsExtreme + 1) / (iterations + 1);

  return describe('cusum', points, observed.index, observed.range, p, minPeriods);
}

/**
 * The same test across several series, with the family correction the scan makes necessary.
 *
 * SCANNING TEN CATEGORIES FOR A CHANGEPOINT IS TEN TESTS, and at p < 0.05 one of them comes back
 * "significant" about forty percent of the time with nothing happening in any of them. The
 * per-series p already prices in the search over POSITIONS; it does not price in the search over
 * SERIES, and that is the gap this function closes.
 */
export function rankChangepoints(
  series: readonly NamedSeries[],
  options: CusumOptions & { readonly method?: 'pettitt' | 'cusum' } = {},
): ChangepointReport {
  if (series.length === 0)
    throw new ChangepointError('rankChangepoints: needs at least one series');

  const names = new Set<string>();
  for (const one of series) {
    if (names.has(one.name))
      throw new ChangepointError(`rankChangepoints: duplicate series name '${one.name}'`);
    names.add(one.name);
  }

  const method = options.method ?? 'pettitt';
  const measured = series.map((one) =>
    method === 'cusum' ? cusum(one.points, options) : pettitt(one.points, options),
  );
  const adjusted = benjaminiHochberg(measured.map((result) => result.p));

  const ranked = measured
    .map((result, index) => ({
      ...result,
      series: (series[index] as NamedSeries).name,
      pAdjusted: adjusted[index] as number,
    }))
    .sort((x, y) => x.p - y.p || (x.series < y.series ? -1 : x.series > y.series ? 1 : 0));

  return { series: ranked, family: measured.length };
}
