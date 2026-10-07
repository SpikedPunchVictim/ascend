import { describe, expect, it } from 'vitest';
import {
  AssociationError,
  DEFINITIONAL_AT,
  blockPermutationNull,
  chiSquare,
  crosstab,
  functionalDependence,
  mutualInformation,
} from '../src/index.js';

/**
 * The two controls `docs/evidence/EV-patterns.md:126-138` names as required additions to E7.
 *
 * WHY THIS FILE EXISTS AT ALL, in EV-patterns' own words (`:151-153`): *"the two controls proposed
 * above are untested designs, not measured remedies."* A control nobody has measured is a claim, so
 * every number below is anchored rather than eyeballed.
 *
 * WHERE EACH EXPECTED VALUE COMES FROM, following `association.test.ts`:
 *
 *   - **Hand arithmetic, written out above each assertion.** Every table here is small enough to do
 *     on paper, which is the only reason it is worth asserting: a statistic checked against its own
 *     output proves nothing.
 *   - **One measured anchor from the real corpus** (`spike/corpus.db`, `tool-denial`, N=409):
 *     `project x repo` at determinism 0.828 and the next pair down at 0.389. Those two numbers are
 *     the entire justification for where the threshold sits, so they are pinned here rather than
 *     left in a document that a future edit could drift away from.
 *
 * TOLERANCES: `toBe` where the arithmetic is exact in binary (a perfect map is exactly 1), and
 * `toBeCloseTo(x, 12)` for hand arithmetic over logarithms, where the only error is the final `log2`.
 */

/** A table given cell by cell, expanded into the two aligned vectors `crosstab` consumes. */
function vectorsFrom(cells: readonly (readonly [string, string, number])[]): [string[], string[]] {
  const a: string[] = [];
  const b: string[] = [];
  for (const [row, col, count] of cells) {
    for (let i = 0; i < count; i += 1) {
      a.push(row);
      b.push(col);
    }
  }
  return [a, b];
}

describe('DEFINITIONAL_AT', () => {
  it('sits inside the gap the real corpus measured, not on either side of it', () => {
    // The corpus (tool-denial, N=409) puts project x repo at 0.828 and the NEXT pair down at 0.389.
    // The threshold's whole claim to being justified rather than chosen is that it falls between
    // them: below 0.828 it would ship the tautology it exists to suppress, above 0.389 it would
    // start eating real findings. Both directions asserted, because only one of them is the failure
    // a reader expects.
    expect(DEFINITIONAL_AT).toBeLessThan(0.828);
    expect(DEFINITIONAL_AT).toBeGreaterThan(0.389);
  });
});

describe('functionalDependence', () => {
  it('is exactly 1 in both directions for a strict one-to-one map', () => {
    // a1 -> b1 x3, a2 -> b2 x2. Each row's column is a function of its row and vice versa, so each
    // variable accounts for ALL of the other's entropy.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 3],
        ['a2', 'b2', 2],
      ]),
    );
    const result = functionalDependence(table);
    expect(result.aToB).toBe(1);
    expect(result.bToA).toBe(1);
    expect(result.determinism).toBe(1);
    expect(result.definitional).toBe(true);
  });

  it('reports a near-map as definitional, and carries the coefficient that says how near', () => {
    // a1 -> b1 x8, b2 x2;  a2 -> b2 x2, b3 x8.   n = 20.
    //   H(b): 8/20, 4/20, 8/20 -> -(0.4*log2 0.4 + 0.2*log2 0.2 + 0.4*log2 0.4) = 1.5219280948873623
    //   H(a): 10/20, 10/20    -> 1
    //   MI  : (0.4)log2(0.4/0.2) + (0.1)log2(0.1/0.1) + (0.1)log2(0.1/0.1) + (0.4)log2(0.4/0.2)
    //       = 0.4 + 0 + 0 + 0.4 = 0.8
    // so knowing a removes 0.8/1.5219280948873623 = 0.5256493... of b's uncertainty, and knowing b
    // removes 0.8/1 = 0.8 of a's. The pair is definitional on the STRONGER of the two.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 8],
        ['a1', 'b2', 2],
        ['a2', 'b2', 2],
        ['a2', 'b3', 8],
      ]),
    );
    const result = functionalDependence(table);
    expect(result.aToB).toBeCloseTo(0.5256493, 6);
    expect(result.bToA).toBe(0.8);
    expect(result.determinism).toBe(0.8);
    expect(result.definitional).toBe(true);
  });

  it('does not call a weak association definitional -- the arm that decides what ships', () => {
    // a1b1 6, a1b2 4, a2b1 4, a2b2 6.  n = 20, both marginals 10/10 -> H(a) = H(b) = 1.
    //   MI = 0.3*log2(0.3/0.25) + 0.2*log2(0.2/0.25) + 0.2*log2(0.2/0.25) + 0.3*log2(0.3/0.25)
    //      = 2*(0.3*0.2630344) + 2*(0.2*-0.3219281) = 0.15782064 - 0.12877124 = 0.0290494
    // so both directions are 0.029..., well under the threshold. This is the assertion that fails
    // if `DEFINITIONAL_AT` is ever set by taste rather than by the measured gap.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 6],
        ['a1', 'b2', 4],
        ['a2', 'b1', 4],
        ['a2', 'b2', 6],
      ]),
    );
    const result = functionalDependence(table);
    expect(result.aToB).toBeCloseTo(0.0290494, 6);
    expect(result.bToA).toBeCloseTo(0.0290494, 6);
    expect(result.determinism).toBeLessThan(DEFINITIONAL_AT);
    expect(result.definitional).toBe(false);
  });

  it('reports a one-directional dependency as an asymmetry rather than averaging it away', () => {
    // a1 -> b1 x5, a2 -> b1 x5, a3 -> b2 x5.  n = 15.
    //   H(a): 5/15 three ways = log2(3)                     = 1.5849625007211562
    //   H(b): 10/15, 5/15 -> -(2/3*log2 2/3 + 1/3*log2 1/3) = 0.9182958340544896
    //   MI  : 2*(1/3)log2((1/3)/(2/9)) + (1/3)log2((1/3)/(1/9))
    //       = 2*(1/3)log2(1.5) + (1/3)log2(3) = 0.3899754 + 0.5283208 = 0.9182962
    // a determines b completely (every a value has one b); b does not determine a, because b1 is
    // shared by two a values. A single averaged number would hide exactly the case that matters.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 5],
        ['a2', 'b1', 5],
        ['a3', 'b2', 5],
      ]),
    );
    const result = functionalDependence(table);
    expect(result.aToB).toBeCloseTo(1, 12);
    expect(result.bToA).toBeCloseTo(0.5793802, 6);
    expect(result.definitional).toBe(true);
  });

  it('returns 0 rather than NaN when a column carries no entropy at all', () => {
    // A constant column has H = 0, so the ratio is 0/0. `rankAssociations` never reaches this case
    // (a constant column gives df = 0 and is skipped), but the function is exported, so it must not
    // hand a caller a NaN that would compare false against every threshold and silently pass.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 3],
        ['a1', 'b2', 2],
      ]),
    );
    const result = functionalDependence(table);
    expect(result.aToB).toBe(0);
    expect(result.bToA).toBe(0);
    expect(result.definitional).toBe(false);
  });

  it('agrees with mutualInformation, because it is that arithmetic and no other', () => {
    // The coefficient is definitionally MI/H, so a divergence here means the module has grown a
    // second notion of entropy -- the duplication the shared predicate exists to prevent.
    const table = crosstab(
      ...vectorsFrom([
        ['a1', 'b1', 8],
        ['a1', 'b2', 2],
        ['a2', 'b2', 2],
        ['a2', 'b3', 8],
      ]),
    );
    const info = mutualInformation(table);
    expect(functionalDependence(table).aToB).toBeCloseTo(info.bits / info.entropyB, 12);
    expect(functionalDependence(table).bToA).toBeCloseTo(info.bits / info.entropyA, 12);
  });
});

/**
 * The block control. Every fixture below is small enough to enumerate the permutation by hand, which
 * is the point: the null's whole claim is about a distribution of arrangements, and a test that only
 * checks it returns a number would pass on a shuffle that did nothing.
 *
 * The fixtures are built from `(block, temporal label, other value, count)` rows so the block
 * structure is visible in the test rather than implied by an index arithmetic.
 */
function blockedRows(cells: readonly (readonly [string, string, string, number])[]): {
  temporal: string[];
  other: string[];
  blocks: string[];
} {
  const temporal: string[] = [];
  const other: string[] = [];
  const blocks: string[] = [];
  for (const [block, label, value, count] of cells) {
    for (let i = 0; i < count; i += 1) {
      temporal.push(label);
      other.push(value);
      blocks.push(block);
    }
  }
  return { temporal, other, blocks };
}

/**
 * FOUR DAYS, THREE DISTINCT TEMPORAL LABELS, AND AN OBSERVED STATISTIC OF EXACTLY ZERO.
 *
 * `D2` and `D4` share `Thu`, so the label multiset `{Thu, Thu, Tue, Wed}` admits 12 arrangements and
 * some of them MERGE two days into one row of the table. Merging is what moves the statistic -- with
 * four distinct labels every arrangement is a relabelling of rows, and chi-square is invariant under
 * that. This is why the corpus's 35 days over 7 weekdays has a null at all.
 *
 * The day profiles are chosen so the observed arrangement is one of the LOW outcomes, which is what
 * the corpus actually looks like: `project x weekday` observes 327.60 against a null median of
 * 398.41. Mirroring that shape rather than contriving a high observed value is the difference between
 * testing the control and testing an arithmetic. (Corrected 2026-10-05, asc-h7nq: this line read
 * `310.58` / `355.55`, from the provisional table `IMPLEMENTATION_PLAN.md:4377` records as WRONG.
 * These are the values `node spike/spike-controls.mjs` prints. See `dogfood/0065`.)
 */
const CONFOUND = blockedRows([
  ['D1', 'Tue', 'P', 4],
  ['D1', 'Tue', 'Q', 4],
  ['D2', 'Thu', 'P', 2],
  ['D3', 'Wed', 'P', 1],
  ['D3', 'Wed', 'Q', 1],
  ['D4', 'Thu', 'Q', 2],
]);

/**
 * EIGHT DAYS, AND A PAIRING THAT IS GENUINELY UNUSUAL. `D7` is the only all-`P` day and `D8` the
 * only all-`Q` day, and the observed arrangement labels exactly those two as `Tue` and `Wed` while
 * the six bland days are `Thu`. Label multiset `{Thu x6, Tue, Wed}` gives 8!/(6!1!1!) = 56
 * arrangements, of which only 2 (the observed one and its `Tue`/`Wed` mirror) reach the observed
 * statistic -- so the true p is 2/56 = 0.0357 and the observed sits above the null's 95th percentile.
 */
const REAL_ASSOCIATION = blockedRows([
  ['D1', 'Thu', 'P', 1],
  ['D1', 'Thu', 'Q', 1],
  ['D2', 'Thu', 'P', 1],
  ['D2', 'Thu', 'Q', 1],
  ['D3', 'Thu', 'P', 1],
  ['D3', 'Thu', 'Q', 1],
  ['D4', 'Thu', 'P', 1],
  ['D4', 'Thu', 'Q', 1],
  ['D5', 'Thu', 'P', 1],
  ['D5', 'Thu', 'Q', 1],
  ['D6', 'Thu', 'P', 1],
  ['D6', 'Thu', 'Q', 1],
  ['D7', 'Tue', 'P', 4],
  ['D8', 'Wed', 'Q', 4],
]);

describe('blockPermutationNull', () => {
  it('collapses an association the day structure alone manufactures', () => {
    // The observed table, by hand: Thu = D2+D4 = (2P,2Q); Tue = D1 = (4P,4Q); Wed = D3 = (1P,1Q).
    // Marginals P = 2+4+1 = 7 and Q = 7 over n = 14, and every expected count equals its observed
    // one -- Thu-P 4*7/14 = 2, Tue-P 8*7/14 = 4, Wed-P 2*7/14 = 1 -- so chi2 is exactly 0, not
    // merely small. A day structure that manufactures a weekday association is exactly this: each
    // weekday's share of `other` matches the corpus's overall share.
    const observed = chiSquare(crosstab(CONFOUND.temporal, CONFOUND.other)).chi2;
    expect(observed).toBe(0);

    const control = blockPermutationNull(CONFOUND.temporal, CONFOUND.other, CONFOUND.blocks, {
      iterations: 500,
      seed: 'confound',
    });

    // The 12 arrangements that the shuffle draws from land at 0 (x2), 2.4 (x4), 3.0 (x4) and 4.0
    // (x2) -- so more than five sixths of the mass is ABOVE the observed value, and the observed
    // arrangement is among the null's least extreme. This is the corpus's shape exactly
    // (`project x weekday`: 327.60 observed, 398.41 null median), and it is the finding the control
    // exists to produce: the weekday is not what the corpus is shaped by, the day structure is.
    expect(control.median).toBeGreaterThan(observed);
    expect(control.pValue(observed)).toBe(1);
  });

  it('leaves a real association standing, and reports the arm that says so', () => {
    // Thu = D1..D6 = (6P,6Q); Tue = D7 = (4P); Wed = D8 = (4Q). n = 20, P = 10, Q = 10.
    //   expected Thu-P = 12*10/20 = 6, Tue-P = 4*10/20 = 2, Wed-Q = 4*10/20 = 2
    //   chi2 = 0 + 0 + (4-2)^2/2 + (0-2)^2/2 + (0-2)^2/2 + (4-2)^2/2 = 8, exactly.
    // Only 2 of the 56 arrangements reach it, so a control that returned "not significant" here
    // would be suppressing every temporal finding rather than the confounded ones. The bead's
    // standing instruction is to report the losing arm's numbers too; this is that arm.
    const observed = chiSquare(crosstab(REAL_ASSOCIATION.temporal, REAL_ASSOCIATION.other)).chi2;
    expect(observed).toBe(8);

    const control = blockPermutationNull(
      REAL_ASSOCIATION.temporal,
      REAL_ASSOCIATION.other,
      REAL_ASSOCIATION.blocks,
      { iterations: 4000, seed: 'real' },
    );
    expect(observed).toBeGreaterThan(control.p95);
    expect(control.pValue(observed)).toBeLessThan(0.05);
  });

  it('actually moves the statistic -- the guard against a shuffle that does nothing', () => {
    // A `pValue` and a median are both satisfiable by a null that never permuted anything: shuffling
    // nothing gives the observed statistic every iteration, and on a fixture whose observed value is
    // unremarkable that reads as a perfectly good "collapses" result. The spread is what
    // distinguishes them, and this fixture's spread is large because two of its four days merge
    // under a relabelling.
    const control = blockPermutationNull(CONFOUND.temporal, CONFOUND.other, CONFOUND.blocks, {
      iterations: 500,
      seed: 'confound',
    });
    expect(control.max).toBeGreaterThan(control.median);
    expect(control.p95).toBeGreaterThan(control.median);
  });

  it('returns the observed statistic unchanged when there is only one block to permute', () => {
    // One block means one arrangement, so every iteration reproduces the observed table. Asserted
    // because the honest answer here is "the null is degenerate" and NOT "the finding survives":
    // the table has a single row, df = 0, and the statistic is 0 by definition, not by measurement.
    // A caller who reaches this has blocked at the grain of the label itself and there is no test
    // left to run.
    const single = blockedRows([
      ['D1', 'Thu', 'P', 2],
      ['D1', 'Thu', 'Q', 2],
    ]);
    const observed = chiSquare(crosstab(single.temporal, single.other)).chi2;
    const control = blockPermutationNull(single.temporal, single.other, single.blocks, {
      iterations: 200,
      seed: 'single',
    });
    expect(control.median).toBe(observed);
    expect(control.p95).toBe(observed);
    expect(control.max).toBe(observed);
  });

  it('is reproducible from its seed, and varies with it', () => {
    // THE FIXTURE HERE IS CHOSEN BY MEASUREMENT, NOT BY PREFERENCE, because two coarser ones failed
    // this arm before it. Both earlier attempts had a null whose outcome space collapses onto a
    // handful of achievable statistics, and the TOP of that set is reached often enough that every
    // seed hits it within 200 draws -- measured: the four-value confound fixture returned `4` for
    // both seeds, and an eight-block/five-label fixture returned `7.384615384615385` for both. The
    // mutation this arm exists to catch (a generator that stopped depending on its seed) would have
    // passed on either. Twenty-four ONE-ROW blocks over three labels give 24!/(12!6!6!) ~ 2.8e9
    // arrangements and a statistic that varies thinly across them, so the sample maximum is a draw
    // from the tail rather than a constant.
    const sparseLabels: string[] = [];
    const sparseOther: string[] = [];
    const sparseBlocks: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      sparseBlocks.push(`B${String(i)}`);
      sparseLabels.push(i < 12 ? 'Mon' : i < 18 ? 'Tue' : 'Wed');
      sparseOther.push(`v${String((i * 7) % 5)}`);
    }

    const first = blockPermutationNull(sparseLabels, sparseOther, sparseBlocks, {
      iterations: 200,
      seed: 'one',
    });
    const again = blockPermutationNull(sparseLabels, sparseOther, sparseBlocks, {
      iterations: 200,
      seed: 'one',
    });
    const other = blockPermutationNull(sparseLabels, sparseOther, sparseBlocks, {
      iterations: 200,
      seed: 'two',
    });

    expect(first.median).toBe(again.median);
    expect(first.p95).toBe(again.p95);
    expect(first.max).toBe(again.max);
    // The tail, not the median -- the same reasoning as `permutationNull`'s own seed test. A median
    // sits where the outcomes are dense and two seeds land on it together; the maximum is where two
    // draws actually have room to differ.
    expect(other.max).not.toBe(first.max);
  });

  it('refuses a block that does not refine the temporal label', () => {
    // An hour label blocked by day: one day holds many hours, so there is no single label to move.
    // Refused rather than repaired, because resampling one would mean inventing rows. The message
    // names the block and both values, so the caller learns the grain to block at.
    const rows = blockedRows([
      ['D1', '09', 'P', 2],
      ['D1', '10', 'Q', 2],
    ]);
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, rows.blocks, { iterations: 10 }),
    ).toThrow(/carries two temporal values/);
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, rows.blocks, { iterations: 10 }),
    ).toThrow(/finer grain/);
  });

  it('refuses the inputs it cannot permute rather than returning a plausible null', () => {
    const rows = blockedRows([
      ['D1', 'Thu', 'P', 2],
      ['D2', 'Tue', 'Q', 2],
    ]);
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, [rows.blocks[0] as string]),
    ).toThrow(AssociationError);
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, [] as readonly (string | null)[]),
    ).toThrow(/same length/);
    expect(() => blockPermutationNull([], [], [])).toThrow(/at least one row/);
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, rows.blocks, { iterations: 1.5 }),
    ).toThrow(/positive integer/);
  });

  it('refuses a row with no block, because it has no label to be given', () => {
    // A `null` block is an entry nobody can place in time. It cannot be dropped (that would change
    // the corpus being tested) and it cannot be grouped (that would invent a block), so it is
    // refused by name and index.
    const rows = blockedRows([
      ['D1', 'Thu', 'P', 2],
      ['D2', 'Tue', 'Q', 2],
    ]);
    const withHole: (string | null)[] = [...rows.blocks];
    withHole[1] = null;
    expect(() =>
      blockPermutationNull(rows.temporal, rows.other, withHole, { iterations: 10 }),
    ).toThrow(/row 1 has no block/);
  });
});
