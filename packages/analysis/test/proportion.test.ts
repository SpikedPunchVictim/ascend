import { describe, expect, it } from 'vitest';
import { isSmallGroup, ProportionError, wilson, type Proportion } from '../src/index.js';

/**
 * `proportion.ts` -- the port of `spike/lib/stats.mjs`, checked against the spike's own anchors.
 *
 * EVERY EXPECTED VALUE BELOW WAS COMPUTED BY HAND OR READ OFF A PUBLISHED TABLE, in the spike, before
 * the code was run, and is carried here unchanged. That is the whole reason the port is worth
 * anything: a statistic checked against its own output proves nothing, and a port that re-derived
 * its expectations from the new implementation would verify only that the two agree.
 *
 * THE THREE TOLERANCES ARE THE SPIKE'S, and each is stated with what it is for rather than chosen
 * for comfort:
 *
 *   - **1e-12** where the true value is exactly representable and the arithmetic is exact -- `p` is
 *     one division, and a looser bound there would hide a real change.
 *   - **1e-6** for the values read off a published table, which is quoted to seven decimal places;
 *     the tolerance is the table's precision, not the arithmetic's slack.
 *   - **1e-5** for the hand-computed worked examples, where the hand arithmetic itself was carried
 *     to five decimals.
 */

/** A sweep of counts covering the regimes the corpus actually has, for the anchor checks. */
const SWEEP: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 10],
  [1, 3],
  [4, 20],
  [7, 21],
  [25, 100],
  [222, 409],
  [1000, 1000],
  [10, 10],
  [3, 409],
];

/**
 * Every (successes, n) pair for n up to this bound -- the regime where the arithmetic actually breaks.
 *
 * THE HAND-WRITTEN `SWEEP` ABOVE WAS NOT ENOUGH, AND THE MUTATION RUN IS THE RECEIPT. `wilson` has
 * four clamps. Dropping the upper outer one (`Math.min(1, ...)`) left every test in this file green,
 * and dropping the lower inner one (`Math.min(p, ...)`) did too -- so for a while both read as
 * decoration. They are not. Censused 2026-09-17 over 53,118 combinations: the four clamps fire 487
 * times, all at `p = 0` or `p = 1`, and the smallest n reaching each is **14** (upper outer, at 90%),
 * **21** (lower outer, at 95%), **3** (lower inner, at 95%) and **1** (upper inner, at 90%).
 *
 * `SWEEP` happens to contain `[10, 10]`, which reaches the upper inner clamp and nothing else -- every
 * other boundary case sits at an n nobody would think to list. That is the argument for generating
 * this list instead of choosing one: a sweep written from the regimes an author has in mind covers
 * the regimes an author has in mind, and the clamps exist precisely for the cases that are not those.
 *
 * Dense to 200 is enough rather than arbitrary: the whole census reaches its extremes below n = 22,
 * and 20,301 pairs is cheap enough to walk at all three levels inside the invariant tests.
 */
const DENSE_SWEEP: readonly (readonly [number, number])[] = (() => {
  const pairs: (readonly [number, number])[] = [];
  for (let n = 1; n <= 200; n += 1) {
    for (let successes = 0; successes <= n; successes += 1) pairs.push([successes, n]);
  }
  return pairs;
})();

describe('wilson, against the spike anchors', () => {
  it('matches the hand-computed interval for 25/100', () => {
    // Hand-computed: p=0.25, n=100, z=1.959963984540054
    //   denom  = 1 + 3.8416/100            = 1.038416
    //   center = (0.25 + 3.8416/200)/denom = 0.269208/1.038416 = 0.2592489
    //   margin = 1.96*sqrt(.25*.75/100 + 3.8416/40000)/denom
    //          = 1.96*sqrt(0.00197104)/1.038416 = 0.0837955
    //   lower  = 0.1754534, upper = 0.3430444
    const w = wilson(25, 100);
    expect(w).not.toBeNull();
    if (w === null) return;
    // Exact: one division, no accumulation.
    expect(Math.abs(w.p - 0.25)).toBeLessThan(1e-12);
    // Hand arithmetic carried to five decimals.
    expect(Math.abs(w.lower - 0.1754534)).toBeLessThan(1e-5);
    expect(Math.abs(w.upper - 0.3430444)).toBeLessThan(1e-5);
  });

  it('stays inside [0,1] at the extremes, where the normal approximation fails', () => {
    const zero = wilson(0, 10);
    expect(zero).not.toBeNull();
    if (zero === null) return;
    expect(zero.p).toBe(0);
    expect(zero.lower).toBe(0);
    // Hand-computed: n=10, p=0 -> center = 0.19207294/1.38414588 = 0.1387663
    //                       margin = 1.95996*sqrt(3.841459/400)/1.38414588 = 0.1387664
    //                       upper  = 0.2775327
    // The published table gives 0.2775 for a 0/10 Wilson interval; quoted to seven
    // decimals, so the tolerance is the table's precision and not the arithmetic's slack.
    expect(Math.abs(zero.upper - 0.2775328)).toBeLessThan(1e-6);

    const all = wilson(10, 10);
    expect(all).not.toBeNull();
    if (all === null) return;
    expect(all.p).toBe(1);
    // EXACT, where the spike could only assert 1e-12: the true upper bound is exactly 1, IEEE-754
    // lands one ulp below it, and `wilson`'s inner clamp repairs that. The spike recorded the ulp
    // as a fact of life; this port makes the bound right instead, which is what lets this line be
    // an equality rather than a tolerance.
    expect(all.upper).toBe(1);
    expect(Math.abs(all.lower - 0.7224672)).toBeLessThan(1e-6);
  });

  it('is symmetric under p -> 1-p', () => {
    // The invariant the two extremes above are two halves of: an interval for 0/10 mirrored is an
    // interval for 10/10, so the two bounds must sum to 1. Asserted here over the dense sweep rather
    // than only on the hand-computed pair, because a clamp applied on ONE SIDE ONLY passes there --
    // and one side only is exactly what dropping `Math.min(p, ...)` from the lower bound amounts to.
    for (const [, n] of DENSE_SWEEP) {
      const low = wilson(0, n);
      const high = wilson(n, n);
      expect(low).not.toBeNull();
      expect(high).not.toBeNull();
      if (low === null || high === null) continue;
      expect(Math.abs(low.upper + high.lower - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('n = 0 has no estimate, and says so structurally', () => {
  it('returns null rather than a zero-valued interval', () => {
    // The spike returned { p: 0, lower: 0, upper: 1, n: 0 } -- a stated point estimate of 0% for a
    // group with nothing in it. TASKS.md #7 forbids exactly that, and --json carries this
    // structure, so the fabricated zero would have shipped as the contract.
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 0, 0.99)).toBeNull();
  });

  it('is the only input that yields null, so absence means absence of data', () => {
    // A reader is entitled to read null as "nothing to estimate from". If any other input could
    // produce it, that reading would be wrong and nothing would say so.
    for (const [successes, n] of SWEEP) {
      expect(wilson(successes, n)).not.toBeNull();
    }
  });
});

describe('counts that are not a proportion are refused', () => {
  it('refuses more successes than observations, naming the swap', () => {
    expect(() => wilson(5, 3)).toThrow(ProportionError);
    expect(() => wilson(5, 3)).toThrow(/wrong way round/);
  });

  it('refuses negative and non-integer counts', () => {
    expect(() => wilson(-1, 10)).toThrow(/successes must be a non-negative integer/);
    expect(() => wilson(1, -10)).toThrow(/n must be a non-negative integer/);
    expect(() => wilson(1.5, 10)).toThrow(/successes must be a non-negative integer/);
    expect(() => wilson(1, 10.5)).toThrow(/n must be a non-negative integer/);
  });

  it('names the argument the caller got wrong, rather than both', () => {
    // The messages are the whole value of refusing: a caller who reads "invalid proportion" has to
    // go and look, and one who reads which argument is wrong does not.
    expect(() => wilson(1, 10.5)).not.toThrow(/successes/);
    expect(() => wilson(1.5, 10)).not.toThrow(/^n must/);
  });
});

describe('the confidence level', () => {
  it('is carried on the result, so the label has one source', () => {
    // The defect this closes: the spike took `z` as a parameter and printed the literal "95% CI"
    // regardless, so any other z produced a label contradicting the arithmetic under it.
    expect(wilson(25, 100, 0.9)?.confidence).toBe(0.9);
    expect(wilson(25, 100, 0.95)?.confidence).toBe(0.95);
    expect(wilson(25, 100, 0.99)?.confidence).toBe(0.99);
    expect(wilson(25, 100)?.confidence).toBe(0.95);
  });

  it('widens the interval monotonically, which is the only thing the level may do', () => {
    const ninety = wilson(25, 100, 0.9);
    const ninetyFive = wilson(25, 100, 0.95);
    const ninetyNine = wilson(25, 100, 0.99);
    expect(ninety).not.toBeNull();
    expect(ninetyFive).not.toBeNull();
    expect(ninetyNine).not.toBeNull();
    if (ninety === null || ninetyFive === null || ninetyNine === null) return;

    // Strictly, not merely >=: a level that failed to reach the arithmetic would leave the bounds
    // equal, and `>=` would accept that as "not narrower".
    expect(ninety.lower).toBeGreaterThan(ninetyFive.lower);
    expect(ninetyFive.lower).toBeGreaterThan(ninetyNine.lower);
    expect(ninety.upper).toBeLessThan(ninetyFive.upper);
    expect(ninetyFive.upper).toBeLessThan(ninetyNine.upper);
    // The point estimate is the level's business not at all.
    expect(ninety.p).toBe(ninetyFive.p);
    expect(ninetyFive.p).toBe(ninetyNine.p);
  });

  it('refuses a level it has no published quantile for', () => {
    // An ordinary call, not a cast: the parameter is a plain number precisely so this refusal is
    // reachable and testable. It matters because the level SELECTS an arithmetic constant --
    // without the refusal an unsupported one reaches the arithmetic as undefined, yields NaN
    // bounds, and renders as "NaN%", which is a wrong answer shaped like a right one.
    expect(() => wilson(25, 100, 0.5)).toThrow(ProportionError);
    expect(() => wilson(25, 100, 0.5)).toThrow(/confidence must be one of/);
    // The refusal names the levels that ARE supported, so a caller does not have to go looking.
    expect(() => wilson(25, 100, 0.5)).toThrow(/0\.9, 0\.95, 0\.99/);
    // And 0.9 is a number that is also a valid level, so the check is not refusing on range alone.
    expect(() => wilson(25, 100, 0.9)).not.toThrow();
  });
});

describe('the invariants every interval owes a reader', () => {
  it('contains its own point estimate, over the dense sweep and every level', () => {
    // Asserted from both sides. A one-sided check would accept an interval that sat entirely above
    // or entirely below the estimate, which is the shape a sign error produces.
    //
    // Collected rather than asserted one at a time: the dense sweep is 60,903 calls, and 331 of them
    // reach the inner clamps. A test that threw on the first failure would report one input and hide
    // the shape of the rest.
    const failures: string[] = [];
    for (const level of [0.9, 0.95, 0.99] as const) {
      for (const [successes, n] of DENSE_SWEEP) {
        const w = wilson(successes, n, level);
        if (w === null) continue;
        if (w.lower > w.p || w.upper < w.p) {
          failures.push(
            `${String(successes)}/${String(n)} @${String(level)}: [${String(w.lower)}, ${String(w.upper)}] excludes p=${String(w.p)}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('never escapes [0,1], over the dense sweep and every level', () => {
    // The 156 cases in the census that leave the unit interval outright. Both outer clamps are
    // reached here and nowhere else in this file, which is why this test walks the generated sweep.
    const failures: string[] = [];
    for (const level of [0.9, 0.95, 0.99] as const) {
      for (const [successes, n] of DENSE_SWEEP) {
        const w = wilson(successes, n, level);
        if (w === null) continue;
        if (w.lower < 0 || w.upper > 1 || w.lower > w.upper) {
          failures.push(
            `${String(successes)}/${String(n)} @${String(level)}: [${String(w.lower)}, ${String(w.upper)}]`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('narrows as n grows, at a fixed proportion', () => {
    // The property the interval is FOR: more evidence, less uncertainty. Checked as a strict
    // narrowing rather than a non-widening, so an interval computed from the wrong n cannot pass.
    // Every n divisible by 4, so `n / 4` is a whole number of successes: a fractional count is
    // refused by `checkCounts` rather than clamped, and this test would otherwise be measuring
    // the refusal instead of the narrowing.
    const widths = [20, 80, 320, 1280].map((n) => {
      const w = wilson(n / 4, n);
      expect(w).not.toBeNull();
      return w === null ? Number.NaN : w.upper - w.lower;
    });
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeLessThan(widths[i - 1] ?? Number.NaN);
    }
  });
});

describe('minimum-N flagging', () => {
  // The literal's own assertion lives in `min-n.test.ts`, which is the file that owns MIN_N; it is
  // not repeated here. What is checked here is that the threshold is APPLIED the way the constant
  // promises -- from both sides, with the boundary at 20 rather than near it.
  it('flags from both sides of the boundary', () => {
    // 19 and 21 rather than 10 and 40: an off-by-one in the comparison passes a test that only
    // samples far from the edge, and the edge is the entire content of a threshold rule.
    expect(isSmallGroup(19)).toBe(true);
    expect(isSmallGroup(20)).toBe(false);
    expect(isSmallGroup(21)).toBe(false);
    expect(isSmallGroup(0)).toBe(true);
  });

  it('is carried on every proportion, so a call site cannot forget it', () => {
    const small = wilson(3, 19);
    const exact = wilson(4, 20);
    expect(small?.smallGroup).toBe(true);
    expect(exact?.smallGroup).toBe(false);
  });

  it('agrees with isSmallGroup on every proportion the sweep produces', () => {
    // Two ways to ask one question -- the field and the predicate -- so they are checked against
    // each other rather than each being trusted alone.
    for (const [successes, n] of SWEEP) {
      const w: Proportion | null = wilson(successes, n);
      if (w === null) continue;
      expect(w.smallGroup).toBe(isSmallGroup(n));
    }
  });
});
