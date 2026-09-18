import { describe, expect, it } from 'vitest';
import {
  ChangepointError,
  cusum,
  pettitt,
  rankChangepoints,
  type SeriesPoint,
} from '../src/index.js';

/**
 * `changepoint.ts` -- Pettitt and CUSUM, checked against arithmetic done outside this codebase.
 *
 * WHERE THE EXPECTED VALUES COME FROM. Pettitt's statistic on a clean step is small enough to
 * evaluate by hand and the working is written out beside each assertion; its p-value comes from the
 * published approximation `2 * exp(-6K^2 / (T^3 + T^2))`, evaluated separately before the
 * assertions were written. CUSUM's statistic is likewise hand-computable; its p is a bootstrap and
 * is therefore asserted as a reproducible value and a range, never as a figure read back off the
 * implementation.
 *
 * THE TEST THAT MATTERS MOST IS "finds a break in a series that has none". Both of these tests take
 * an argmax over T-1 positions, so both ALWAYS return a position -- on noise, on a flat line, on
 * anything. If that test ever stops asserting a high p-value, the module has started manufacturing
 * findings and nothing else here would notice.
 */

/** A series of plain values, labelled `t0`, `t1`, ... */
function series(values: readonly number[]): SeriesPoint[] {
  return values.map((value, index) => ({ label: `t${String(index)}`, value }));
}

/** `count` copies of `value`. */
function run(value: number, count: number): number[] {
  return Array.from({ length: count }, () => value);
}

describe('pettitt', () => {
  it('finds a clean step exactly at the step, with the published p', () => {
    // [1,1,1,1,5,5,5,5], T = 8.
    //   Each 1 scores sgn against every value: 0*4 + (-1)*4 = -4.  Each 5 scores +4.
    //   U runs -4, -8, -12, -16, -12, -8, -4 over splits 0..6, so K = 16 at index 3.
    //   p = 2 * exp(-6 * 256 / (512 + 64)) = 0.13896690244560309
    const result = pettitt(series([...run(1, 4), ...run(5, 4)]), { minPeriods: 8 });

    expect(result.index).toBe(3);
    expect(result.label).toBe('t3');
    expect(result.nextLabel).toBe('t4');
    expect(result.statistic).toBe(16);
    expect(result.p).toBeCloseTo(0.13896690244560309, 12);
    // AND IT IS NOT SIGNIFICANT. A perfect step in eight periods does not clear 0.05, which is the
    // honest answer and the reason the p travels with the index everywhere in this module.
    expect(result.p).toBeGreaterThan(0.05);
  });

  it('clears significance once the same step has enough periods behind it', () => {
    // [1]*10 + [5]*10, T = 20. Each 1 scores -10, each 5 scores +10, so K = 100 at index 9.
    //   p = 2 * exp(-6 * 10000 / (8000 + 400)) = 0.0015809806462399323
    const result = pettitt(series([...run(1, 10), ...run(5, 10)]));

    expect(result.index).toBe(9);
    expect(result.statistic).toBe(100);
    expect(result.p).toBeCloseTo(0.0015809806462399323, 12);
    expect(result.underpowered).toBe(false);
  });

  it('reports the level either side, by mean and by median', () => {
    const result = pettitt(series([1, 1, 1, 1, 5, 5, 5, 9]), { minPeriods: 8 });

    expect(result.before.periods).toBe(4);
    expect(result.before.mean).toBe(1);
    expect(result.before.median).toBe(1);
    expect(result.after.periods).toBe(4);
    // Mean 6, median 5: the single 9 moves one and not the other, which is why both are reported.
    expect(result.after.mean).toBe(6);
    expect(result.after.median).toBe(5);
  });

  it('finds a break in a series that has none, and says so in the p-value', () => {
    // A flat line has no break anywhere. The argmax still returns an index -- it always does -- and
    // K is 0, so the approximation gives 2 * exp(0) = 2, clamped to 1.
    const flat = pettitt(series(run(3, 12)), { minPeriods: 12 });
    expect(flat.statistic).toBe(0);
    expect(flat.p).toBe(1);

    // A sawtooth has structure but no LEVEL shift, and Pettitt correctly declines to find one.
    const sawtooth = pettitt(series([1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5]), { minPeriods: 12 });
    expect(sawtooth.p).toBe(1);
  });

  it('is unmoved by one enormous outlier, which is what a rank test is for', () => {
    // The 900 is a hundred times every other value. A mean-based test would put the break beside it;
    // a rank test sees one value out of order and nothing more.
    const withSpike = pettitt(series([1, 1, 1, 900, 1, 1, 1, 1, 1, 1, 1, 1]), { minPeriods: 12 });
    expect(withSpike.p).toBeGreaterThan(0.5);
  });

  it('flags a series too short to conclude anything from', () => {
    // MIN_N is 20 and this series has 8 periods.
    expect(pettitt(series([...run(1, 4), ...run(5, 4)])).underpowered).toBe(true);
  });

  it('refuses a series it cannot split', () => {
    expect(() => pettitt(series([1, 2]))).toThrow(ChangepointError);
    expect(() => pettitt(series([1, 2]))).toThrow(/at least three periods/);
    expect(() => pettitt(series([1, Number.NaN, 3]))).toThrow(/non-finite/);
  });
});

describe('cusum', () => {
  it('finds a clean step exactly at the step, with the hand-computed range', () => {
    // [1,1,1,1,5,5,5,5] has mean 3, so deviations are -2 four times then +2 four times and the
    // cumulative sum runs -2, -4, -6, -8, -6, -4, -2. Lowest -8, highest 0 (the sum starts there),
    // so the range is 8 and the extreme sits at index 3.
    const result = cusum(series([...run(1, 4), ...run(5, 4)]), {
      minPeriods: 8,
      iterations: 500,
      seed: 'step',
    });

    expect(result.index).toBe(3);
    expect(result.statistic).toBe(8);

    // AND THE BOOTSTRAP IS CHECKED AGAINST THE EXACT NULL, not against itself. Four 1s and four 5s
    // arrange 70 ways; enumerating all of them outside this codebase, 8 reach a range of 8 or more,
    // so the exact p is 8/70 = 0.11428571428571428. The bootstrap at 500 draws should sit beside it,
    // a little high because the (k+1)/(n+1) correction biases upward by construction.
    //
    // The enumeration is also the correction to a guess that was wrong and would have passed for the
    // wrong reason: only TWO of the 70 arrangements are fully sorted, so 2/70 = 0.029 looks like the
    // answer and is not. A run such as [5,1,1,1,1,5,5,5] never sorts and still reaches range 8. An
    // assertion written from that guess would have failed here and been "fixed" by loosening it.
    expect(result.p).toBeGreaterThan(0.11428571428571428 - 0.03);
    expect(result.p).toBeLessThan(0.11428571428571428 + 0.03);
  });

  it('is reproducible from its seed', () => {
    const points = series([...run(1, 6), ...run(4, 6)]);
    const first = cusum(points, { minPeriods: 12, iterations: 300, seed: 'same' });
    const again = cusum(points, { minPeriods: 12, iterations: 300, seed: 'same' });

    expect(first.p).toBe(again.p);
    expect(first.index).toBe(again.index);
  });

  it('never reports p = 0, because the observed ordering is one of the orderings', () => {
    // An overwhelming step: no shuffle of 200 will beat it, so the bootstrap floors at 1/(n+1).
    const result = cusum(series([...run(1, 15), ...run(100, 15)]), {
      iterations: 200,
      seed: 'floor',
    });
    expect(result.p).toBeCloseTo(1 / 201, 12);
  });

  it('finds a break in a series that has none, and says so in the p-value', () => {
    const flat = cusum(series(run(3, 12)), { minPeriods: 12, iterations: 200, seed: 'flat' });
    expect(flat.statistic).toBe(0);
    // Every shuffle of a flat series ties the observed range, so every one counts as at least as
    // extreme: the bootstrap returns 1 rather than a small number, which is the right answer.
    expect(flat.p).toBe(1);

    const sawtooth = cusum(series([1, 5, 1, 5, 1, 5, 1, 5, 1, 5, 1, 5]), {
      minPeriods: 12,
      iterations: 300,
      seed: 'saw',
    });
    expect(sawtooth.p).toBeGreaterThan(0.5);
  });

  it('sees a magnitude shift that the rank test scores as weaker', () => {
    // Eight periods at 10, then eight at 11 -- a shift a rank test scores as a clean separation and
    // therefore as significant, but whose MAGNITUDE is tiny. The point of running both is that they
    // are measuring different things; this asserts they can be compared at all on one series.
    const points = series([...run(10, 8), ...run(11, 8)]);
    const ranked = pettitt(points, { minPeriods: 16 });
    const magnitude = cusum(points, { minPeriods: 16, iterations: 300, seed: 'small-shift' });

    expect(ranked.index).toBe(7);
    expect(magnitude.index).toBe(7);
    // Both agree on WHERE. That agreement is the strong claim; either alone is weaker.
    expect(ranked.p).toBeLessThan(0.05);
    expect(magnitude.p).toBeLessThan(0.05);
  });

  it('refuses an iteration count it cannot bootstrap', () => {
    expect(() => cusum(series([1, 2, 3]), { iterations: 0 })).toThrow(/positive integer/);
  });
});

describe('rankChangepoints', () => {
  const quiet = series(run(3, 12));
  const broken = series([...run(1, 6), ...run(9, 6)]);

  it('orders by significance and reports the family it corrected against', () => {
    const report = rankChangepoints(
      [
        { name: 'quiet', points: quiet },
        { name: 'broken', points: broken },
      ],
      { minPeriods: 12 },
    );

    expect(report.family).toBe(2);
    expect(report.series[0]?.series).toBe('broken');
    expect(report.series[1]?.series).toBe('quiet');
    expect(report.series[1]?.p).toBe(1);
  });

  it('prices in the search over series, which the per-series p does not', () => {
    // Ten flat series: nothing happened in any of them, and the q-values must say so. The
    // per-series p already prices in the search over POSITIONS; this is the other exposure.
    const flat = Array.from({ length: 10 }, (_, index) => ({
      name: `flat${String(index)}`,
      points: quiet,
    }));
    const report = rankChangepoints(flat, { minPeriods: 12 });

    expect(report.family).toBe(10);
    for (const entry of report.series) expect(entry.pAdjusted).toBe(1);
  });

  it('runs whichever test it was asked for', () => {
    const viaCusum = rankChangepoints([{ name: 'broken', points: broken }], {
      method: 'cusum',
      minPeriods: 12,
      iterations: 200,
      seed: 'ranked',
    });
    expect(viaCusum.series[0]?.method).toBe('cusum');

    const viaPettitt = rankChangepoints([{ name: 'broken', points: broken }], { minPeriods: 12 });
    expect(viaPettitt.series[0]?.method).toBe('pettitt');
  });

  it('refuses a scan with nothing in it', () => {
    expect(() => rankChangepoints([])).toThrow(/at least one series/);
    expect(() =>
      rankChangepoints([
        { name: 'a', points: quiet },
        { name: 'a', points: quiet },
      ]),
    ).toThrow(/duplicate series name/);
  });
});
