import { describe, expect, it } from 'vitest';
import {
  AssociationError,
  benjaminiHochberg,
  chiSquare,
  chiSquarePValue,
  crosstab,
  mulberry32,
  mutualInformation,
  permutationNull,
  rankAssociations,
  seedOf,
  type AssociationColumn,
} from '../src/index.js';

/**
 * `association.ts` -- the port of `spike/lib/stats.mjs`'s chi-square leg, plus the ranking the bead
 * (`asc-0tw`) actually asked for.
 *
 * WHERE EACH EXPECTED VALUE COMES FROM, because the distinction decides what a green test proves:
 *
 *   - **Published table values** for the chi-square tail. Carried unchanged from the spike, which
 *     read them off a standard table before any code ran.
 *   - **Hand arithmetic, written out above each assertion**, for Cramer's V, the Bergsma
 *     correction, the mutual information and the Benjamini-Hochberg q-values. Every one is small
 *     enough to do on paper, which is the only reason it is worth asserting: a statistic checked
 *     against its own output proves nothing.
 *   - **An independent derivation** for the two df=1 p-values that are not on a table:
 *     P(X^2 > x) at df=1 is 2*(1 - Phi(sqrt(x))), evaluated through `erf` outside this codebase.
 *     0.8 gives 0.37109336952269767 and 4.0 gives 0.04550026389635842.
 *
 * TOLERANCES ARE STATED WITH WHAT THEY ARE FOR, following `proportion.test.ts`:
 *
 *   - **exact** where the arithmetic is exact in binary -- chi2 of 4 from four cells of 1, an
 *     entropy of exactly 1 bit -- because a looser bound there would hide a real change.
 *   - **1e-12** for hand arithmetic over dyadic rationals, where the only error is the final square
 *     root or logarithm.
 *   - **1e-6** for the published table values, whose precision is the table's, not the code's.
 */

/** The cell-key separator, built rather than written so no literal NUL sits in this file. */
const NUL = String.fromCharCode(0);

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

describe('chiSquarePValue', () => {
  it('is 1 where there is nothing to test', () => {
    expect(chiSquarePValue(0, 1)).toBe(1);
    expect(chiSquarePValue(5, 0)).toBe(1);
    expect(chiSquarePValue(-1, 1)).toBe(1);
  });

  it('matches the published table at the canonical 0.05 points', () => {
    // The spike's three anchors, read off a standard chi-square table before any code existed.
    expect(chiSquarePValue(3.841458820694124, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(5.991464547107979, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(12.591587243743977, 6)).toBeCloseTo(0.05, 6);
  });

  it('matches an independent derivation through the normal CDF at df=1', () => {
    // P(X^2 > x) at df = 1 is 2*(1 - Phi(sqrt(x))). Evaluated with erf outside this codebase.
    expect(chiSquarePValue(0.8, 1)).toBeCloseTo(0.37109336952269767, 12);
    expect(chiSquarePValue(4, 1)).toBeCloseTo(0.04550026389635842, 12);
  });
});

describe('crosstab', () => {
  it('tabulates cells and both marginals', () => {
    const [a, b] = vectorsFrom([
      ['x', 'p', 3],
      ['x', 'q', 1],
      ['y', 'q', 2],
    ]);
    const table = crosstab(a, b);

    expect(table.n).toBe(6);
    expect(table.rowKeys).toEqual(['x', 'y']);
    expect(table.colKeys).toEqual(['p', 'q']);
    expect(table.rowTotals.get('x')).toBe(4);
    expect(table.colTotals.get('q')).toBe(3);
    expect(table.counts.get(`x${NUL}p`)).toBe(3);
    // Zero cells are absent rather than stored: a sparse table is mostly zeros.
    expect(table.counts.get(`y${NUL}p`)).toBeUndefined();
  });

  it('refuses vectors of different lengths rather than tabulating the overlap', () => {
    expect(() => crosstab(['a', 'b'], ['a'])).toThrow(AssociationError);
    expect(() => crosstab(['a', 'b'], ['a'])).toThrow(/same length/);
  });
});

describe('chiSquare', () => {
  it('scores a perfect 2x2 association at V = 1, corrected and uncorrected', () => {
    // [[2,0],[0,2]] on n = 4: every expected count is 1, so chi2 = 4 * (1^2 / 1) = 4, df = 1.
    // Raw V     = sqrt((4/4) / 1) = 1.
    // Corrected: phi2 = 1, df/(n-1) = 1/3, so phi2~ = 2/3; rows~ = cols~ = 2 - 1/3 = 5/3,
    //            k~ = 5/3 - 1 = 2/3; V~ = sqrt((2/3)/(2/3)) = 1. A perfect association survives the
    //            correction intact, which is the property that makes the correction safe to rank on.
    const [a, b] = vectorsFrom([
      ['0', '0', 2],
      ['1', '1', 2],
    ]);
    const result = chiSquare(crosstab(a, b));

    expect(result.chi2).toBe(4);
    expect(result.df).toBe(1);
    expect(result.cramersV).toBe(1);
    expect(result.cramersVCorrected).toBeCloseTo(1, 12);
    expect(result.p).toBeCloseTo(0.04550026389635842, 12);
  });

  it('scores exact independence at zero', () => {
    const [a, b] = vectorsFrom([
      ['0', '0', 1],
      ['0', '1', 1],
      ['1', '0', 1],
      ['1', '1', 1],
    ]);
    const result = chiSquare(crosstab(a, b));

    expect(result.chi2).toBe(0);
    expect(result.cramersV).toBe(0);
    expect(result.cramersVCorrected).toBe(0);
    expect(result.p).toBe(1);
  });

  it('reports a variable that does not vary as uninformative rather than failing', () => {
    // A ranking over many pairs will legitimately contain a constant column. df = 0 there, and the
    // honest answer is "no association measurable", not an exception that kills the whole report.
    const constant = chiSquare(crosstab(['a', 'a', 'a'], ['p', 'q', 'p']));
    expect(constant.df).toBe(0);
    expect(constant.chi2).toBe(0);
    expect(constant.p).toBe(1);
    expect(constant.asymptoticValid).toBe(false);

    const empty = chiSquare(crosstab([], []));
    expect(empty.n).toBe(0);
    expect(empty.cramersVCorrected).toBe(0);
  });

  it('corrects away an effect that raw V would have reported as 0.2', () => {
    // [[6,4],[4,6]] on n = 20. All marginals are 10, so every expected count is 5 and
    //   chi2 = 4 * (1^2 / 5) = 0.8,  phi2 = 0.04,  raw V = sqrt(0.04) = 0.2.
    // The correction subtracts phi2's expectation under independence, df/(n-1) = 1/19 = 0.05263,
    // which exceeds phi2. So phi2~ floors at 0 and the corrected V is exactly 0: the raw 0.2 was
    // entirely what an independent table of this shape produces by chance at this n.
    const [a, b] = vectorsFrom([
      ['x', 'p', 6],
      ['x', 'q', 4],
      ['y', 'p', 4],
      ['y', 'q', 6],
    ]);
    const result = chiSquare(crosstab(a, b));

    expect(result.chi2).toBeCloseTo(0.8, 12);
    expect(result.cramersV).toBeCloseTo(0.2, 12);
    expect(result.cramersVCorrected).toBe(0);
    // And the p-value alone would not have said so out loud: 0.371 reads as "not significant", but
    // a reader scanning effect sizes would still have seen 0.2 and wondered about it.
    expect(result.p).toBeCloseTo(0.37109336952269767, 12);
  });

  it('reports Cochran validity with the two counts behind it', () => {
    // Every expected count is exactly 5, which is not below 5.
    const dense = chiSquare(
      crosstab(
        ...vectorsFrom([
          ['x', 'p', 6],
          ['x', 'q', 4],
          ['y', 'p', 4],
          ['y', 'q', 6],
        ]),
      ),
    );
    expect(dense.cells).toBe(4);
    expect(dense.minExpected).toBeCloseTo(5, 12);
    expect(dense.cellsBelowFive).toBe(0);
    expect(dense.asymptoticValid).toBe(true);

    // A 3x3 on nine rows: every expected count is 1. Cochran's rule fails on both clauses at once,
    // and the p-value is still computed -- a number the caller is told to distrust beats no number.
    const sparse = chiSquare(
      crosstab(
        ['x', 'x', 'x', 'y', 'y', 'y', 'z', 'z', 'z'],
        ['p', 'q', 'r', 'p', 'q', 'r', 'p', 'q', 'r'],
      ),
    );
    expect(sparse.cells).toBe(9);
    expect(sparse.minExpected).toBeCloseTo(1, 12);
    expect(sparse.cellsBelowFive).toBe(9);
    expect(sparse.asymptoticValid).toBe(false);
    expect(sparse.p).toBe(1);
  });

  it('is the reason the ranking sorts on the corrected V and not the raw one', () => {
    // THE ARTEFACT THE CORRECTION EXISTS FOR, shown rather than asserted in prose. Two pairs of
    // columns, all four drawn INDEPENDENTLY from the same seeded generator over the same 400 items;
    // one pair has eight levels per column, the other two. There is nothing to find in either, so a
    // ranking that puts one above the other is ranking on the schema rather than on the corpus.
    const next = mulberry32(seedOf('bias-demo'));
    const pick = (levels: number): string => `v${String(Math.floor(next() * levels))}`;
    const wideA: string[] = [];
    const wideB: string[] = [];
    const narrowA: string[] = [];
    const narrowB: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      wideA.push(pick(8));
      wideB.push(pick(8));
      narrowA.push(pick(2));
      narrowB.push(pick(2));
    }

    const wide = chiSquare(crosstab(wideA, wideB));
    const narrow = chiSquare(crosstab(narrowA, narrowB));

    // Raw V ranks the eight-level pair well above the two-level pair though neither has any
    // association at all: E[chi2] = df under independence, and df is 49 against 1.
    expect(wide.cramersV).toBeGreaterThan(narrow.cramersV * 2);
    // Corrected, both are at or near zero and the ordering artefact is gone.
    expect(wide.cramersVCorrected).toBeLessThan(0.05);
    expect(narrow.cramersVCorrected).toBeLessThan(0.05);
  });
});

describe('mutualInformation', () => {
  it('is one bit when two balanced binary columns determine each other', () => {
    // p(0,0) = p(1,1) = 1/2 and p(x) = p(y) = 1/2, so
    //   MI = 2 * (1/2) * log2((1/2)/(1/4)) = 1 bit,  H(a) = H(b) = 1,  U = 2*1/(1+1) = 1.
    const [a, b] = vectorsFrom([
      ['0', '0', 2],
      ['1', '1', 2],
    ]);
    const info = mutualInformation(crosstab(a, b));

    expect(info.bits).toBeCloseTo(1, 12);
    expect(info.entropyA).toBeCloseTo(1, 12);
    expect(info.entropyB).toBeCloseTo(1, 12);
    expect(info.uncertainty).toBeCloseTo(1, 12);
  });

  it('is zero under exact independence, and never negative', () => {
    const info = mutualInformation(crosstab(['0', '0', '1', '1'], ['0', '1', '0', '1']));
    expect(info.bits).toBe(0);
    expect(info.uncertainty).toBe(0);
  });

  it('normalises an asymmetric pair against both entropies', () => {
    // Cells (x,p) = 2, (x,q) = 2, (y,r) = 4 on n = 8. `b` determines `a`; `a` does not determine `b`.
    //   H(a) = 1 bit                        (4/8, 4/8)
    //   H(b) = 2*(1/4)*2 + (1/2)*1 = 1.5    (2/8, 2/8, 4/8)
    //   MI   = 1/4*log2(.25/.125) * 2 + 1/2*log2(.5/.25) = 1/4 + 1/4 + 1/2 = 1 bit, which equals
    //          H(a) exactly, as it must when one side is fully determined by the other.
    //   U    = 2*1/(1 + 1.5) = 0.8
    const [a, b] = vectorsFrom([
      ['x', 'p', 2],
      ['x', 'q', 2],
      ['y', 'r', 4],
    ]);
    const info = mutualInformation(crosstab(a, b));

    expect(info.bits).toBeCloseTo(1, 12);
    expect(info.entropyA).toBeCloseTo(1, 12);
    expect(info.entropyB).toBeCloseTo(1.5, 12);
    expect(info.uncertainty).toBeCloseTo(0.8, 12);
  });

  it('has nothing to say about an empty table', () => {
    const info = mutualInformation(crosstab([], []));
    expect(info.bits).toBe(0);
    expect(info.uncertainty).toBe(0);
  });
});

describe('benjaminiHochberg', () => {
  it('turns the textbook borderline family into a flat 0.05', () => {
    // m = 5, p = 0.01 .. 0.05.  q(i) = (m/i) * p(i) = 5*0.01, 2.5*0.02, 1.667*0.03, 1.25*0.04,
    // 1*0.05 -- 0.05 at every rank. The family sits exactly on the line.
    const q = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05]);
    for (const value of q) expect(value).toBeCloseTo(0.05, 12);
  });

  it('returns q-values in the input order, not in rank order', () => {
    // m = 3, p = [0.001, 0.9, 0.5].  Ranked: 0.001 (1), 0.5 (2), 0.9 (3).
    //   rank 3: 3/3 * 0.9   = 0.9
    //   rank 2: 3/2 * 0.5   = 0.75
    //   rank 1: 3/1 * 0.001 = 0.003
    // Back in input order: [0.003, 0.9, 0.75].
    const q = benjaminiHochberg([0.001, 0.9, 0.5]);
    expect(q[0]).toBeCloseTo(0.003, 12);
    expect(q[1]).toBeCloseTo(0.9, 12);
    expect(q[2]).toBeCloseTo(0.75, 12);
  });

  it('is monotone: a smaller p never gets a larger q', () => {
    // m = 2, p = [0.04, 0.045].  Raw: rank 1 gives 2*0.04 = 0.08, rank 2 gives 1*0.045 = 0.045.
    // Unclamped that would hand the SMALLER p the LARGER q. The step-up running minimum pulls the
    // first down to 0.045, and this assertion is the only thing here that would notice if the loop
    // ran in the other direction.
    const q = benjaminiHochberg([0.04, 0.045]);
    expect(q[0]).toBeCloseTo(0.045, 12);
    expect(q[1]).toBeCloseTo(0.045, 12);
  });

  it('never exceeds 1, because the running minimum starts there', () => {
    // 4/1 * 0.6 = 2.4 unclamped, and the largest p is its own q at rank m.
    const q = benjaminiHochberg([0.6, 0.7, 0.8, 0.95]);
    for (const value of q) expect(value).toBeLessThanOrEqual(1);
    expect(q[3]).toBeCloseTo(0.95, 12);
  });

  it('has nothing to adjust in an empty family', () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe('permutationNull', () => {
  const a = ['x', 'x', 'x', 'x', 'y', 'y', 'y', 'y', 'x', 'x', 'y', 'y'];
  const b = ['p', 'p', 'p', 'p', 'q', 'q', 'q', 'q', 'p', 'p', 'q', 'q'];

  /** Sixty items over 3x3 categories, with a real but partial association. */
  const wideA: string[] = [];
  const wideB: string[] = [];
  for (let i = 0; i < 60; i += 1) {
    wideA.push(`r${String(i % 3)}`);
    wideB.push(`c${String((i % 3 === 0 ? i : i + 1) % 3)}`);
  }

  it('puts a real association outside the null it manufactures', () => {
    const observed = chiSquare(crosstab(a, b)).chi2;
    const control = permutationNull(a, b, { iterations: 300, seed: 'control' });

    expect(observed).toBeGreaterThan(control.p95);
    // `max`, not `p95`, is where this stops being a strict inequality, and the reason is the whole
    // point of the control: with twelve items and 6/6 marginals a shuffle CAN land on the observed
    // arrangement exactly, so the strongest possible association still only ties the null's maximum.
    // A test demanding a strict beat here would be demanding something the statistic cannot deliver.
    expect(observed).toBeGreaterThanOrEqual(control.max);
    expect(control.iterations).toBe(300);
  });

  it('is reproducible from its seed, and varies with it', () => {
    const first = permutationNull(wideA, wideB, { iterations: 200, seed: 'one' });
    const again = permutationNull(wideA, wideB, { iterations: 200, seed: 'one' });
    const other = permutationNull(wideA, wideB, { iterations: 200, seed: 'two' });

    expect(first.p95).toBe(again.p95);
    expect(first.median).toBe(again.median);
    expect(first.max).toBe(again.max);
    // Not a claim about seeds in general -- a spot check that THIS pair differs, so a generator that
    // had quietly stopped depending on its seed would be caught here.
    //
    // IT IS THE MAXIMUM AND NOT THE MEDIAN, and the reason is worth keeping: chi-square over a 3x3
    // table on sixty rows takes very few distinct values near the middle of its null, so seeds 'one'
    // and 'two' agree on the median (1.0499999999999998) while disagreeing on the maximum (10.05
    // against 11.85). A median assertion would have passed for the wrong reason on a third seed and
    // failed for the wrong reason here; the tail is where two draws actually have room to differ.
    expect(other.max).not.toBe(first.max);
  });

  it('never reports p = 0, because the observed arrangement is one of the arrangements', () => {
    const control = permutationNull(a, b, { iterations: 100, seed: 'floor' });
    expect(control.pValue(Number.POSITIVE_INFINITY)).toBeCloseTo(1 / 101, 12);
    expect(control.pValue(0)).toBe(1);
  });

  it('refuses an iteration count it cannot draw', () => {
    expect(() => permutationNull(a, b, { iterations: 0 })).toThrow(AssociationError);
    expect(() => permutationNull(a, b, { iterations: 1.5 })).toThrow(/positive integer/);
  });
});

describe('rankAssociations', () => {
  /** Three columns over twelve items: `left` and `mirror` agree exactly, `noise` alternates. */
  const columns: AssociationColumn[] = [
    { name: 'left', values: ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'a', 'a', 'b', 'b'] },
    { name: 'mirror', values: ['p', 'p', 'p', 'p', 'q', 'q', 'q', 'q', 'p', 'p', 'q', 'q'] },
    { name: 'noise', values: ['m', 'n', 'm', 'n', 'm', 'n', 'm', 'n', 'm', 'n', 'm', 'n'] },
  ];

  it('puts the real association first and reports the family it corrected against', () => {
    const report = rankAssociations(columns);

    expect(report.family).toBe(3);
    expect(report.items).toBe(12);
    expect(report.pairs).toHaveLength(3);

    const top = report.pairs[0];
    expect(top?.a).toBe('left');
    expect(top?.b).toBe('mirror');
    expect(top?.cramersV).toBe(1);
    // `left` and `mirror` are the same partition, so each tells the other exactly one bit.
    expect(top?.mutualInformation).toBeCloseTo(1, 12);
    expect(top?.uncertainty).toBeCloseTo(1, 12);
  });

  it('holds left against noise at no effect at all', () => {
    const report = rankAssociations(columns);
    const pair = report.pairs.find((entry) => entry.a === 'left' && entry.b === 'noise');

    // Three of each `noise` level inside each `left` level: exactly independent by construction.
    expect(pair?.chi2).toBeCloseTo(0, 12);
    expect(pair?.cramersVCorrected).toBe(0);
    expect(pair?.pAdjusted).toBe(1);
  });

  it('counts rows it dropped, and offers absence as a level instead', () => {
    const withGaps: AssociationColumn[] = [
      { name: 'x', values: ['a', 'a', null, 'b', 'b', null] },
      { name: 'y', values: ['p', 'p', 'q', 'q', null, 'q'] },
    ];

    const excluded = rankAssociations(withGaps);
    expect(excluded.items).toBe(6);
    // Rows 2, 4 and 5 (zero-based) are missing one side or the other.
    expect(excluded.pairs[0]?.n).toBe(3);
    expect(excluded.pairs[0]?.excluded).toBe(3);

    const asLevel = rankAssociations(withGaps, { absent: 'level' });
    expect(asLevel.pairs[0]?.n).toBe(6);
    expect(asLevel.pairs[0]?.excluded).toBe(0);
  });

  it('flags a pair measured on too few rows as an anecdote', () => {
    const report = rankAssociations(columns);
    // MIN_N is 20 and there are 12 items, so every pair here is under it.
    for (const pair of report.pairs) expect(pair.underpowered).toBe(true);

    const relaxed = rankAssociations(columns, { minN: 5 });
    for (const pair of relaxed.pairs) expect(pair.underpowered).toBe(false);
  });

  it('omits the permutation p entirely rather than reporting it as undefined', () => {
    const without = rankAssociations(columns);
    expect('pPermuted' in (without.pairs[0] as object)).toBe(false);

    const controlled = rankAssociations(columns, { permutations: 100, seed: 'ranked' });
    // The top pair is a perfect association, so no shuffle can match it: the floor, 1/(100+1).
    expect(controlled.pairs[0]?.pPermuted).toBeCloseTo(1 / 101, 12);
  });

  it('is fully ordered, so two runs over one corpus agree', () => {
    const first = rankAssociations(columns);
    const again = rankAssociations(columns);
    expect(first.pairs.map((pair) => `${pair.a}:${pair.b}`)).toEqual(
      again.pairs.map((pair) => `${pair.a}:${pair.b}`),
    );
  });

  it('refuses inputs that would produce a table meaning nothing', () => {
    expect(() => rankAssociations([columns[0] as AssociationColumn])).toThrow(
      /at least two columns/,
    );
    expect(() =>
      rankAssociations([
        { name: 'x', values: ['a', 'b'] },
        { name: 'y', values: ['p'] },
      ]),
    ).toThrow(/expected 2/);
    expect(() =>
      rankAssociations([
        { name: 'x', values: ['a'] },
        { name: 'x', values: ['p'] },
      ]),
    ).toThrow(/duplicate column name/);
  });
});
