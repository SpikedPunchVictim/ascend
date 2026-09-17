import { describe, expect, it } from 'vitest';
import { AgreementError, cohenKappa, type Agreement, type Labelled } from '../src/index.js';

/**
 * `agreement.ts` -- Cohen's kappa, checked against hand-computed values.
 *
 * EVERY EXPECTED NUMBER BELOW WAS COMPUTED BY HAND FROM THE CONFUSION MATRIX, not read off the
 * implementation. That is the only kind of check that means anything here: kappa is a ratio of
 * ratios, and a fixture whose expectation was derived from the code would verify only that the code
 * agrees with itself. The arithmetic is shown in the comment above each anchor so a reader can
 * redo it rather than trust it.
 *
 * FIXTURES ARE BUILT FROM ONE STRING PER RATER, one character per entry, ids `e1`, `e2`, ... in
 * order. That keeps a 50-entry matrix readable and, more importantly, keeps the two raters' lists
 * index-aligned by construction -- a fixture where entry 7 is y for the first rater and n for the
 * second is written that way rather than assembled by hand in two places.
 *
 * THE FOUR ANCHORS ARE THE FOUR REGIMES OF KAPPA, because a statistic that is only tested where it
 * looks good is a statistic that has not been tested: exact agreement, agreement at chance (kappa
 * exactly 0), agreement WORSE than chance (kappa exactly -1), and a three-label matrix where nothing
 * is round.
 */

/** A rater's labels, one per entry: `'yyn'` is entry 1 = y, entry 2 = y, entry 3 = n. */
const rater = (labels: string): readonly Labelled[] =>
  Array.from(labels, (label, position) => ({ id: `e${String(position + 1)}`, label }));

/** Kappa for two label strings, so each test reads as the matrix it is. */
const kappaOf = (a: string, b: string): Agreement => cohenKappa(rater(a), rater(b));

describe('kappa, against hand-computed matrices', () => {
  it('reproduces 0.4 on the 2x2 confusion matrix', () => {
    // 50 entries. Both raters mark the first 20 y; the first rater marks 21-25 y and 26-50 n; the
    // second marks 21-25 n, 26-35 y and 36-50 n. So the matrix is [[20, 5], [10, 15]].
    //   observed = (20 + 15) / 50 = 0.7
    //   marginals: A y=25 n=25, B y=30 n=20
    //   expected = 0.5*0.6 + 0.5*0.4  = 0.5
    //   kappa    = (0.7 - 0.5) / (1 - 0.5) = 0.4
    const kappa = kappaOf(
      'y'.repeat(25) + 'n'.repeat(25),
      'y'.repeat(20) + 'n'.repeat(5) + 'y'.repeat(10) + 'n'.repeat(15),
    );

    expect(kappa.compared).toBe(50);
    expect(kappa.measure?.agreed).toBe(35);
    // Both of these ARE exact: 35/50 and 0.3 + 0.2 both land on their doubles, and an equality is
    // the right assertion for each.
    expect(kappa.measure?.observed).toBe(0.7);
    expect(kappa.measure?.expected).toBe(0.5);
    // Kappa is NOT exact, and the tolerance is derived rather than chosen. MEASURED: 0.7's nearest
    // double is 0.69999999999999995559, so (observed - expected) evaluates to 0.19999999999999996
    // and the ratio to 0.3999999999999999 -- one ulp below 0.4, with every step of the hand
    // arithmetic exact. Asserting equality here was my first version and it FAILED, which is the
    // correct outcome: a claim of exactness in a comment is not a measurement.
    expect(Math.abs((kappa.measure?.kappa ?? Number.NaN) - 0.4)).toBeLessThan(1e-15);
  });

  it('reports kappa 0 when the raters agree exactly as often as chance predicts', () => {
    // 20 entries, both raters balanced 10 y / 10 n. The second rater's y's sit on 1-5 and 11-15, so
    // they agree on 5 of the first rater's 10 y's and 5 of the 10 n's.
    //   observed = 10 / 20 = 0.5, expected = 0.25 + 0.25 = 0.5, kappa = 0
    // This is the anchor that matters most for reading the number: raw agreement of 50% sounds like
    // something, and kappa says it is worth nothing without correcting for the marginals.
    const kappa = kappaOf(
      'y'.repeat(10) + 'n'.repeat(10),
      'y'.repeat(5) + 'n'.repeat(5) + 'y'.repeat(5) + 'n'.repeat(5),
    );

    expect(kappa.measure?.observed).toBe(0.5);
    expect(kappa.measure?.expected).toBe(0.5);
    expect(kappa.measure?.kappa).toBe(0);
  });

  it('reports kappa -1 when the raters are exactly inverted', () => {
    // The second rater's list is the first's reversed by label: no entry agrees.
    //   observed = 0, expected = 0.5, kappa = -0.5 / 0.5 = -1
    // A negative kappa is a real finding -- the scheme is systematically disagreeing with the other
    // one -- and a sign error in the corrected-for-chance formula is invisible without this case.
    const kappa = kappaOf('y'.repeat(10) + 'n'.repeat(10), 'n'.repeat(10) + 'y'.repeat(10));

    expect(kappa.measure?.observed).toBe(0);
    expect(kappa.measure?.kappa).toBe(-1);
  });

  it('corrects for chance using BOTH marginals, on an asymmetric matrix', () => {
    // The anchor that pins `expected` as the product of the two raters' shares rather than one
    // rater's squared. 10 entries: the first rater marks 8 x / 2 y, the second 5 x / 5 y, and they
    // agree on the first five x's and the last two y's.
    //   observed = 7/10 = 0.7
    //   expected = (8/10)(5/10) + (2/10)(5/10) = 0.4 + 0.1 = 0.5
    //   kappa    = (0.7 - 0.5) / (1 - 0.5) = 0.4
    // A one-rater `expected` would give 0.64 + 0.04 = 0.68 and a kappa of 0.0625 -- a number fifteen
    // times smaller, and every symmetric fixture in this file would still pass.
    const kappa = kappaOf('xxxxxxxxyy', 'xxxxxyyyyy');

    expect(kappa.marginals).toEqual([
      { label: 'x', a: 8, b: 5 },
      { label: 'y', a: 2, b: 5 },
    ]);
    expect(kappa.measure?.observed).toBe(0.7);
    expect(kappa.measure?.expected).toBe(0.5);
    expect(Math.abs((kappa.measure?.kappa ?? Number.NaN) - 0.4)).toBeLessThan(1e-15);
  });

  it('reproduces 8/11 on a three-label matrix', () => {
    // 12 entries, three labels, and the raters share their marginals (A x=6 y=4 z=2, B the same) with
    // a diagonal-heavy matrix [[5, 1, 0], [1, 3, 0], [0, 0, 2]].
    //   observed = (5 + 3 + 2) / 12                     = 10/12
    //   expected = (1/2)^2 + (1/3)^2 + (1/6)^2          = 14/36
    //   kappa    = (30/36 - 14/36) / (22/36)            = 16/22 = 8/11
    // Hand-computed as an exact rational because a three-label expectation is where a wrong
    // vocabulary (say, only the labels both raters used) stops being a rounding difference and
    // starts being a different number.
    //
    // The second rater is `xxxxxyxyyyzz`: x on 1-5 and 7, y on 6 and 8-10, z on 11-12, which gives it
    // the same marginals as the first (x=6, y=4, z=2) and the matrix above.
    const kappa = kappaOf('xxxxxxyyyyzz', 'xxxxxyxyyyzz');

    expect(kappa.compared).toBe(12);
    expect(kappa.measure?.agreed).toBe(10);
    expect(kappa.labels).toEqual(['x', 'y', 'z']);
    expect(Math.abs((kappa.measure?.expected ?? Number.NaN) - 14 / 36)).toBeLessThan(1e-12);
    expect(Math.abs((kappa.measure?.kappa ?? Number.NaN) - 8 / 11)).toBeLessThan(1e-12);
  });
});

describe('the two absences kappa has to represent rather than fill in', () => {
  it('has no measure at all when the raters labelled disjoint entries', () => {
    // Two schemes over different slices of the corpus. There is no agreement to measure, so there is
    // no measure -- not a zero, which would claim they never agreed.
    const kappa = cohenKappa(
      [
        { id: 'e1', label: 'x' },
        { id: 'e2', label: 'y' },
      ],
      [
        { id: 'e3', label: 'x' },
        { id: 'e4', label: 'x' },
      ],
    );

    expect(kappa.compared).toBe(0);
    expect(kappa.measure).toBeNull();
    // The exclusion is counted, not swallowed: 2 entries went unpaired on each side.
    expect(kappa.onlyA).toBe(2);
    expect(kappa.onlyB).toBe(2);
    // And no vocabulary is invented for an empty comparison.
    expect(kappa.labels).toEqual([]);
    expect(kappa.marginals).toEqual([]);
  });

  it('has no measure when both lists are empty, which is the same absence', () => {
    const kappa = cohenKappa([], []);

    expect(kappa.compared).toBe(0);
    expect(kappa.onlyA).toBe(0);
    expect(kappa.onlyB).toBe(0);
    expect(kappa.measure).toBeNull();
  });

  it('reports null kappa, not 1, when expected agreement is exactly 1', () => {
    // Both raters used one label and it was the same label. `1 - expected` is 0, so kappa is 0/0.
    // Returning 1 would claim perfect reproducibility from a corpus where nobody disagreed because
    // nobody varied -- and in this project that is an ordinary outcome, not a corner case: it is a
    // rule that matches everything scored against a scheme that labels everything the same.
    const kappa = kappaOf('xxxxx', 'xxxxx');

    expect(kappa.measure?.observed).toBe(1);
    expect(kappa.measure?.expected).toBe(1);
    expect(kappa.measure?.kappa).toBeNull();
    // The raw agreement is still reported, so a reader can see WHY there is no kappa rather than
    // being handed a bare null.
    expect(kappa.measure?.agreed).toBe(5);
  });

  it('does not mistake a merely lopsided matrix for that absence', () => {
    // The boundary the `=== 1` comparison sits on. 9 of 10 entries are x and the remaining entry is
    // y for both raters, so the marginals are identical and heavily skewed but NOT degenerate:
    // expected is 0.82, kappa is defined, and a tolerance where there should be an equality would
    // quietly null it.
    const kappa = kappaOf('xxxxxxxxxy', 'xxxxxxxxxy');

    expect(kappa.measure?.expected).toBeCloseTo(0.82, 12);
    expect(kappa.measure?.kappa).not.toBeNull();
    // observed = 1, so kappa = (1 - 0.82) / 0.18 = 1 exactly. A degenerate-vocabulary scheme and a
    // perfectly-agreeing lopsided one produce the SAME observed agreement and different kappas,
    // which is the distinction this pair of tests exists to hold.
    expect(kappa.measure?.kappa).toBeCloseTo(1, 12);
  });

  it('only ever reports a null kappa when the agreement was also total', () => {
    // The claim in the module comment, checked rather than asserted: expected can only reach 1 when
    // both raters used one label, so observed is necessarily 1 too. If some input could produce a
    // null kappa with observed below 1, the null would be hiding a real disagreement.
    const fixtures: readonly (readonly [string, string])[] = [
      ['xxxxx', 'xxxxx'],
      ['yyn', 'yny'],
      ['xxx', 'yyy'],
      ['xxxyy', 'xxxyy'],
      ['y'.repeat(20) + 'n'.repeat(20), 'y'.repeat(20) + 'n'.repeat(20)],
    ];

    for (const [a, b] of fixtures) {
      const kappa = kappaOf(a, b);
      if (kappa.measure === null || kappa.measure.kappa !== null) continue;
      expect(kappa.measure.observed).toBe(1);
      expect(kappa.measure.expected).toBe(1);
    }
  });
});

describe('what could not be paired is reported, not dropped', () => {
  it('counts the entries only one rater labelled and excludes them from the arithmetic', () => {
    // The second rater labelled one extra entry. It cannot contribute to agreement -- the first rater
    // said nothing about it -- and a kappa computed over it would be inventing an opinion for them.
    const kappa = cohenKappa(
      [
        { id: 'e1', label: 'y' },
        { id: 'e2', label: 'n' },
      ],
      [
        { id: 'e1', label: 'y' },
        { id: 'e2', label: 'n' },
        { id: 'e3', label: 'y' },
      ],
    );

    expect(kappa.compared).toBe(2);
    expect(kappa.onlyA).toBe(0);
    expect(kappa.onlyB).toBe(1);
    expect(kappa.measure?.agreed).toBe(2);
    expect(kappa.measure?.observed).toBe(1);
  });

  it('counts the entries only the FIRST rater labelled, and excludes them from the arithmetic', () => {
    // The mirror of the case above, and it is not redundant: it is the only fixture in this file where
    // the first rater's list is longer than the join, which is what makes `observed`'s denominator
    // observable. A mutation run caught exactly that -- with every unpaired entry on the second
    // rater's side, `agreed / a.length` is indistinguishable from `agreed / compared` and dividing by
    // the wrong list passed every assertion here.
    //   compared = 2 (e1, e2), onlyA = 1 (e3), onlyB = 0
    //   agreed = 1 (e1)                        -> observed = 1/2 = 0.5
    //   marginals over the compared entries: y a=1 b=2, n a=1 b=0
    //   expected = (1/2)(2/2) + (1/2)(0/2) = 0.5 -> kappa = 0
    const kappa = cohenKappa(
      [
        { id: 'e1', label: 'y' },
        { id: 'e2', label: 'n' },
        { id: 'e3', label: 'y' },
      ],
      [
        { id: 'e1', label: 'y' },
        { id: 'e2', label: 'y' },
      ],
    );

    expect(kappa.compared).toBe(2);
    expect(kappa.onlyA).toBe(1);
    expect(kappa.onlyB).toBe(0);
    expect(kappa.measure?.agreed).toBe(1);
    expect(kappa.measure?.observed).toBe(0.5);
    expect(kappa.measure?.expected).toBe(0.5);
    expect(kappa.measure?.kappa).toBe(0);
    // e3 was labelled only by the first rater, so it contributes to no marginal: the counts are over
    // the compared entries, and a vocabulary that picked it up would be built from one rater's opinion.
    expect(kappa.marginals).toEqual([
      { label: 'n', a: 1, b: 0 },
      { label: 'y', a: 1, b: 2 },
    ]);
  });

  it('pairs by entry id, not by position', () => {
    // The two lists are in opposite orders. A positional implementation would score this as total
    // disagreement; the ids say it is total agreement.
    const kappa = cohenKappa(
      [
        { id: 'e1', label: 'x' },
        { id: 'e2', label: 'y' },
      ],
      [
        { id: 'e2', label: 'y' },
        { id: 'e1', label: 'x' },
      ],
    );

    expect(kappa.measure?.agreed).toBe(2);
    expect(kappa.measure?.observed).toBe(1);
  });
});

describe('a label list that cannot be paired is refused', () => {
  it('refuses an entry labelled twice, naming which rater did it', () => {
    // Not resolved to one of the two labels: there is no principled winner, which is the same rule
    // the registry applies to two prose keys that fold to one property.
    expect(() =>
      cohenKappa(
        [
          { id: 'e1', label: 'x' },
          { id: 'e1', label: 'y' },
        ],
        [{ id: 'e1', label: 'x' }],
      ),
    ).toThrow(AgreementError);
    expect(() =>
      cohenKappa(
        [
          { id: 'e1', label: 'x' },
          { id: 'e1', label: 'y' },
        ],
        [{ id: 'e1', label: 'x' }],
      ),
    ).toThrow(/the first rater/);
    // The message carries both labels, so a reader can see what the conflict was.
    expect(() =>
      cohenKappa(
        [
          { id: 'e1', label: 'x' },
          { id: 'e1', label: 'y' },
        ],
        [{ id: 'e1', label: 'x' }],
      ),
    ).toThrow(/'x' and 'y'/);
  });

  it('refuses a duplicate from the second rater too, not only the first', () => {
    expect(() =>
      cohenKappa(
        [{ id: 'e1', label: 'x' }],
        [
          { id: 'e1', label: 'x' },
          { id: 'e1', label: 'x' },
        ],
      ),
    ).toThrow(/the second rater/);
  });

  it('refuses an empty label, which is a missing value wearing the clothes of one', () => {
    // Counting '' as a label would let 40 unlabelled entries look like a vocabulary of one, and
    // inflate the agreement of a scheme that simply failed on them.
    expect(() => cohenKappa([{ id: 'e1', label: '' }], [{ id: 'e1', label: 'x' }])).toThrow(
      /empty label/,
    );
  });

  it('refuses an entry with no id, which could not be paired at all', () => {
    expect(() => cohenKappa([{ id: '', label: 'x' }], [{ id: '', label: 'x' }])).toThrow(
      /id is empty/,
    );
  });

  it('accepts two empty lists, because that is no overlap rather than a bad input', () => {
    // The line between the refusals above and this one: refusing is for a list that cannot be
    // interpreted, not for a comparison that has no answer. Two empty passes are an answer.
    expect(() => cohenKappa([], [])).not.toThrow();
  });
});

describe('the invariants a reader leans on', () => {
  /** Fixtures used for the invariance checks, where the hand-computed values do not matter. */
  const FIXTURES: readonly (readonly [string, string])[] = [
    ['xxxxxxyyyyzz', 'xxxxxyxyyyzz'],
    [
      'y'.repeat(25) + 'n'.repeat(25),
      'y'.repeat(20) + 'n'.repeat(5) + 'y'.repeat(10) + 'n'.repeat(15),
    ],
    ['xyzzyx', 'zyxxyz'],
    ['aaaabb', 'aaaabb'],
    ['ab', 'ba'],
  ];

  it('is symmetric: swapping the raters swaps only the unpaired counts', () => {
    // Kappa is a property of the pair, not of who was first. A sign or index error in the marginals
    // would show up here and nowhere else, because most fixtures with similar marginals hide it.
    for (const [a, b] of FIXTURES) {
      const forward = kappaOf(a, b);
      const backward = kappaOf(b, a);

      expect(backward.compared).toBe(forward.compared);
      expect(backward.onlyA).toBe(forward.onlyB);
      expect(backward.onlyB).toBe(forward.onlyA);
      expect(backward.measure?.observed).toBe(forward.measure?.observed);
      expect(backward.measure?.expected).toBe(forward.measure?.expected);
      expect(backward.measure?.kappa).toBe(forward.measure?.kappa);
    }
  });

  it('depends on the pairs, not on the order they were given in', () => {
    // The store returns rows in whatever order its query produced, so an implementation that folded
    // the marginals in input order could pass every anchor above and still be unstable in use.
    for (const [a, b] of FIXTURES) {
      const forward = cohenKappa(rater(a), rater(b));
      const reversed = cohenKappa(rater(a).slice().reverse(), rater(b).slice().reverse());

      expect(reversed.measure?.kappa).toBe(forward.measure?.kappa);
      expect(reversed.marginals).toEqual(forward.marginals);
      expect(reversed.labels).toEqual(forward.labels);
    }
  });

  it('builds marginals that account for every compared entry, on both sides', () => {
    // Where the expected-agreement term comes from: each rater's per-label counts must sum to the
    // number of compared entries, or `expected` is computed from a distribution that is not the one
    // the raters produced.
    for (const [a, b] of FIXTURES) {
      const kappa = kappaOf(a, b);
      const sumA = kappa.marginals.reduce((total, marginal) => total + marginal.a, 0);
      const sumB = kappa.marginals.reduce((total, marginal) => total + marginal.b, 0);

      expect(sumA).toBe(kappa.compared);
      expect(sumB).toBe(kappa.compared);
    }
  });

  it('carries a label only one rater used, with a zero on the other side', () => {
    // A label the second rater never used still has to appear, because it is part of the vocabulary
    // `expected` is computed over -- dropping it would silently renormalize the marginals.
    const kappa = kappaOf('xxyy', 'xxzz');

    expect(kappa.labels).toEqual(['x', 'y', 'z']);
    expect(kappa.marginals).toEqual([
      { label: 'x', a: 2, b: 2 },
      { label: 'y', a: 2, b: 0 },
      { label: 'z', a: 0, b: 2 },
    ]);
  });

  it('sorts labels, so two runs of one comparison cannot disagree about order', () => {
    expect(kappaOf('zyx', 'zyx').labels).toEqual(['x', 'y', 'z']);
    // Sorted by code point, which is what the string comparison is for; a locale-aware sort would
    // order the same bytes differently on a different machine.
    expect(kappaOf('bBaA', 'bBaA').labels).toEqual(['A', 'B', 'a', 'b']);
  });

  it('flags a small comparison with the same threshold a proportion uses', () => {
    // Both statistics answer "is this number trustworthy at this n", so both are judged by one
    // threshold -- 19 is an anecdote and 20 is not, from both sides, as in proportion.test.ts. The
    // comparison here runs over entries both raters labelled, so a 19-entry fixture compares 19.
    expect(kappaOf('x'.repeat(19), 'x'.repeat(19)).measure?.smallGroup).toBe(true);
    expect(kappaOf('x'.repeat(20), 'x'.repeat(20)).measure?.smallGroup).toBe(false);
    expect(kappaOf('xyy', 'xyy').measure?.smallGroup).toBe(true);
  });
});
