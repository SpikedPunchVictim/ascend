import { describe, expect, it } from 'vitest';
import {
  chiSquarePValue,
  distinctiveTerms,
  DistinctiveError,
  type DistinctiveGroup,
} from '../src/index.js';

/**
 * `distinctive.ts` -- the log-odds-with-informative-prior estimator, checked against arithmetic done
 * outside this codebase.
 *
 * WHERE THE EXPECTED VALUES COME FROM. Every number below was evaluated independently from the
 * published formula (Monroe, Colaresi and Quinn 2008, section 3.5) before the assertions were
 * written, on inputs small enough that the intermediate quantities are written out in the comment
 * beside each one. That is the only reason these assertions mean anything: a statistic checked
 * against its own output proves nothing, and this estimator is easy to get subtly wrong -- the
 * prior can be flat instead of informative, the variance can omit a term, the odds can be taken
 * against the group instead of against the rest.
 *
 * THE MOST IMPORTANT TEST HERE IS THE LAST ONE. It is the bead's own claim -- "better than raw
 * TF-IDF at small N" -- reduced to two numbers that disagree: the raw log-odds ratio ranks a term
 * seen twice above a term seen eighty times, and the z-score reverses it. If that test ever goes
 * green with both orderings agreeing, the variance model has stopped doing anything and the module
 * has quietly become TF-IDF with extra steps.
 */

/** A document of `count` copies of `term`, padded to `length` with a filler token. */
function document(term: string, count: number, length: number): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) tokens.push(term);
  while (tokens.length < length) tokens.push('pad');
  return tokens;
}

describe('distinctiveTerms', () => {
  /**
   * Two groups, five tokens each, sharing one term.
   *
   *   A: alpha alpha common | alpha common      -> alpha 3, common 2, tokens 5
   *   B: beta  beta  common | beta  common      -> beta  3, common 2, tokens 5
   *
   * Corpus: 10 tokens; background alpha 3, beta 3, common 4; vocabulary 3, so the default prior
   * (alpha-zero = vocabulary size) is 3.
   */
  const mirrored: DistinctiveGroup[] = [
    {
      name: 'A',
      documents: [
        ['alpha', 'alpha', 'common'],
        ['alpha', 'common'],
      ],
    },
    {
      name: 'B',
      documents: [
        ['beta', 'beta', 'common'],
        ['beta', 'common'],
      ],
    },
  ];

  it('matches the published estimator on a table small enough to check by hand', () => {
    // For `alpha` in group A, with alpha_w = 3 * 3/10 = 0.9:
    //   inside  = (3 + 0.9) / (5 + 3 - 3.9) = 3.9 / 4.1
    //   outside = (0 + 0.9) / (5 + 3 - 0.9) = 0.9 / 7.1
    //   delta   = ln(3.9/4.1) - ln(0.9/7.1)          = 2.0154448791304347
    //   var     = 1/3.9 + 1/0.9 = 1.3675213675213675
    //   z       = delta / sqrt(var)                  = 1.723470541369818
    const report = distinctiveTerms(mirrored, { minDocuments: 2 });
    const a = report.groups.find((group) => group.group === 'A');
    const alpha = a?.terms.find((term) => term.term === 'alpha');

    expect(alpha?.countInGroup).toBe(3);
    expect(alpha?.countElsewhere).toBe(0);
    expect(alpha?.documentsInGroup).toBe(2);
    expect(alpha?.logOddsRatio).toBeCloseTo(2.0154448791304347, 12);
    expect(alpha?.z).toBeCloseTo(1.723470541369818, 12);
    // The two-sided p is the df=1 chi-square tail of z^2 -- the same identity, not a second
    // approximation living beside the first.
    expect(alpha?.p).toBeCloseTo(chiSquarePValue(1.723470541369818 ** 2, 1), 12);
  });

  it('gives a term the groups share a log-odds of exactly zero, with no stopword list', () => {
    // `common` is 2 of 5 tokens in both groups. The odds inside and outside are the same number, so
    // the difference of their logs is exactly 0 -- which is the whole argument for why this method
    // needs no stopword list. A list is a corpus-specific judgement someone has to maintain and get
    // wrong; the estimator makes it unnecessary rather than optional.
    const report = distinctiveTerms(mirrored, { minDocuments: 2 });
    const common = report.groups[0]?.terms.find((term) => term.term === 'common');

    expect(common?.logOddsRatio).toBe(0);
    expect(common?.z).toBe(0);
    expect(common?.p).toBe(1);
  });

  it('is antisymmetric between a two-group split', () => {
    // With two groups, "the rest" of A is exactly B. So `beta` scored inside A must be the exact
    // negative of `beta` scored inside B -- and if it is not, the comparison is not against the
    // complement at all.
    const report = distinctiveTerms(mirrored, { minDocuments: 2, perGroup: 99 });
    const betaInA = report.groups[0]?.terms.find((term) => term.term === 'beta');
    const betaInB = report.groups[1]?.terms.find((term) => term.term === 'beta');

    expect(betaInA?.logOddsRatio).toBeCloseTo(-2.0154448791304347, 12);
    expect(betaInB?.logOddsRatio).toBeCloseTo(2.0154448791304347, 12);
    expect(betaInA?.z).toBeCloseTo(-(betaInB?.z as number), 12);
  });

  it('ranks over-represented terms first, not loudest-in-either-direction', () => {
    const report = distinctiveTerms(mirrored, { minDocuments: 2, perGroup: 99 });
    const terms = report.groups[0]?.terms.map((term) => term.term);

    // alpha (+1.72), common (0), beta (-1.72). Signed, so the term the group AVOIDS sorts last
    // rather than tying with the term it prefers.
    expect(terms).toEqual(['alpha', 'common', 'beta']);
  });

  it('reports the family the q-values were corrected against', () => {
    const report = distinctiveTerms(mirrored, { minDocuments: 2, perGroup: 99 });

    expect(report.vocabulary).toBe(3);
    expect(report.tokens).toBe(10);
    // Three terms scored in each of two groups.
    expect(report.family).toBe(6);
    // `common` sits at p = 1 and cannot be adjusted anywhere but 1.
    const common = report.groups[0]?.terms.find((term) => term.term === 'common');
    expect(common?.pAdjusted).toBe(1);
  });

  it('drops terms below minCount from the vocabulary entirely', () => {
    const withHapax: DistinctiveGroup[] = [
      { name: 'A', documents: [['alpha', 'alpha', 'once']] },
      { name: 'B', documents: [['beta', 'beta', 'twice']] },
    ];

    // Default minCount is 2, so `once` and `twice` never enter the vocabulary or the family.
    const defaulted = distinctiveTerms(withHapax, { minDocuments: 1 });
    expect(defaulted.vocabulary).toBe(2);
    expect(defaulted.family).toBe(4);

    const everything = distinctiveTerms(withHapax, { minDocuments: 1, minCount: 1 });
    expect(everything.vocabulary).toBe(4);
  });

  it('flags a group with too few documents as an anecdote', () => {
    // MIN_N is 20 and each group here has two documents.
    const report = distinctiveTerms(mirrored);
    for (const group of report.groups) expect(group.underpowered).toBe(true);

    const relaxed = distinctiveTerms(mirrored, { minDocuments: 2 });
    for (const group of relaxed.groups) expect(group.underpowered).toBe(false);
  });

  it('shrinks harder toward zero as the prior grows', () => {
    // A larger alpha-zero spends more pseudo-tokens, so every log-odds moves toward zero. This is
    // the knob a caller reaches for when the tail is noisy, and the direction is the contract.
    const light = distinctiveTerms(mirrored, { minDocuments: 2, prior: 1 });
    const heavy = distinctiveTerms(mirrored, { minDocuments: 2, prior: 50 });

    const lightAlpha = light.groups[0]?.terms[0]?.logOddsRatio as number;
    const heavyAlpha = heavy.groups[0]?.terms[0]?.logOddsRatio as number;
    expect(Math.abs(heavyAlpha)).toBeLessThan(Math.abs(lightAlpha));
  });

  it('has nothing to report about a corpus with no vocabulary', () => {
    const empty = distinctiveTerms([
      { name: 'A', documents: [] },
      { name: 'B', documents: [] },
    ]);

    expect(empty.vocabulary).toBe(0);
    expect(empty.family).toBe(0);
    expect(empty.tokens).toBe(0);
    expect(empty.groups).toHaveLength(2);
    expect(empty.groups[0]?.terms).toEqual([]);
  });

  it('refuses inputs that have no comparison in them', () => {
    expect(() => distinctiveTerms([mirrored[0] as DistinctiveGroup])).toThrow(DistinctiveError);
    expect(() => distinctiveTerms([mirrored[0] as DistinctiveGroup])).toThrow(
      /at least two groups/,
    );
    expect(() =>
      distinctiveTerms([
        { name: 'A', documents: [] },
        { name: 'A', documents: [] },
      ]),
    ).toThrow(/duplicate group name/);
    expect(() => distinctiveTerms(mirrored, { minCount: 0 })).toThrow(/minCount/);
    expect(() => distinctiveTerms(mirrored, { perGroup: 0 })).toThrow(/perGroup/);
    expect(() => distinctiveTerms(mirrored, { prior: 0 })).toThrow(/prior/);
  });

  it('is why the ranking is the z-score and not the log-odds ratio', () => {
    // THE BEAD'S CLAIM, REDUCED TO TWO NUMBERS THAT DISAGREE.
    //
    //   `small`: 4 documents, 20 tokens, holding both occurrences of `rare`.
    //   `big`:  40 documents, 200 tokens, holding all eighty occurrences of `freq`.
    //
    // Both terms are exclusive to their group, so by any frequency-ratio measure -- TF-IDF
    // included -- `rare` looks like the more distinctive of the two, and by the raw log-odds it is:
    //
    //   rare in small: alpha_w = 3*2/220   = 0.02727..,  delta = 6.578408212016693,  z = 1.0791537298867153
    //   freq in big:   alpha_w = 3*80/220  = 1.09090..,  delta = 2.5921855330009858, z = 2.689419657432579
    //
    // The raw ratio ranks `rare` 2.5x above `freq`. The z-score reverses it, because two
    // observations constrain an odds ratio hardly at all and eighty constrain it a great deal. That
    // reversal is the entire reason this module divides by a standard error, and this assertion is
    // what would notice if it stopped.
    const small: DistinctiveGroup = {
      name: 'small',
      documents: [
        document('rare', 2, 5),
        document('pad', 0, 5),
        document('pad', 0, 5),
        document('pad', 0, 5),
      ],
    };
    const bigDocuments: string[][] = [];
    for (let i = 0; i < 40; i += 1) bigDocuments.push(document('freq', 2, 5));
    const big: DistinctiveGroup = { name: 'big', documents: bigDocuments };

    const report = distinctiveTerms([small, big], { minDocuments: 2, perGroup: 99 });
    const rare = report.groups[0]?.terms.find((term) => term.term === 'rare');
    const freq = report.groups[1]?.terms.find((term) => term.term === 'freq');

    expect(rare?.logOddsRatio).toBeCloseTo(6.578408212016693, 10);
    expect(freq?.logOddsRatio).toBeCloseTo(2.5921855330009858, 10);
    expect(rare?.z).toBeCloseTo(1.0791537298867153, 10);
    expect(freq?.z).toBeCloseTo(2.689419657432579, 10);

    // The two orderings disagree, and that disagreement is the finding.
    expect(rare?.logOddsRatio).toBeGreaterThan(freq?.logOddsRatio as number);
    expect(rare?.z).toBeLessThan(freq?.z as number);
  });
});
