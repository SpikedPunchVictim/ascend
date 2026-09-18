import { describe, expect, it } from 'vitest';
import { associationRules, mulberry32, RuleError, seedOf } from '../src/index.js';

/**
 * `rules.ts` -- FP-growth, and the three filters that decide whether its output is readable.
 *
 * TWO KINDS OF TEST LIVE HERE, and the distinction is the point.
 *
 *   - **Hand-computed anchors** on a twelve-pattern corpus whose every support is written out in
 *     the comment beside the assertion. These check the arithmetic: supports, confidences, Wilson
 *     bounds, lift, and which rules the productivity filter drops.
 *   - **A differential test against a brute-force miner written in this file**, on pseudo-random
 *     transactions from the package's own seeded generator. This checks the TREE. FP-growth is a
 *     hundred and fifty lines of prefix tree, conditional pattern bases and recursion, and a subtle
 *     error in it produces supports that are slightly wrong rather than obviously wrong -- the kind
 *     of defect no hand-written example finds. The brute-force counter is deliberately stupid:
 *     enumerate every subset of every transaction and count. It is too slow for real use and cannot
 *     be wrong.
 *
 * Every Wilson bound below was evaluated independently from the published formula before the
 * assertions were written, not read back off `wilson`.
 */

/** `count` copies of one transaction. */
function repeat(items: readonly string[], count: number): string[][] {
  return Array.from({ length: count }, () => [...items]);
}

/**
 * Every itemset up to `maxSize` occurring at least `minSupport` times, counted by enumeration.
 *
 * Deliberately the slowest possible implementation: this exists to be obviously correct, not fast.
 */
function bruteForce(
  transactions: readonly (readonly string[])[],
  minSupport: number,
  maxSize: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const transaction of transactions) {
    const items = [...new Set(transaction)].sort();
    const subsets: string[][] = [[]];
    for (const item of items) {
      const grown = subsets.map((subset) => [...subset, item]);
      for (const subset of grown) if (subset.length <= maxSize) subsets.push(subset);
    }
    for (const subset of subsets) {
      if (subset.length === 0 || subset.length > maxSize) continue;
      const key = subset.join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of [...counts]) if (count < minSupport) counts.delete(key);
  return counts;
}

/**
 * The corpus the anchors are computed on: 240 transactions over four items.
 *
 *   120 x {a,b,c}   60 x {a,b}   40 x {a,c}   20 x {d}
 *
 * Supports: a 220, b 180, c 160, d 20; ab 180, ac 160, bc 120, abc 120.
 * Base rates: a 220/240 = 0.9167, b 180/240 = 0.75, c 160/240 = 0.6667.
 */
const CORPUS: string[][] = [
  ...repeat(['a', 'b', 'c'], 120),
  ...repeat(['a', 'b'], 60),
  ...repeat(['a', 'c'], 40),
  ...repeat(['d'], 20),
];

describe('associationRules', () => {
  it('counts the itemsets a hand census says are there', () => {
    const report = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });
    const support = (items: string) =>
      report.itemsets.find((set) => set.items.join('') === items)?.support;

    expect(report.transactions).toBe(240);
    expect(support('a')).toBe(220);
    expect(support('b')).toBe(180);
    expect(support('c')).toBe(160);
    expect(support('ab')).toBe(180);
    expect(support('ac')).toBe(160);
    expect(support('bc')).toBe(120);
    expect(support('abc')).toBe(120);
    // `d` occurs 20 times, below the threshold, so it never enters the tree at all.
    expect(support('d')).toBeUndefined();
  });

  it('attaches an interval to every confidence, never a bare ratio', () => {
    const report = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });
    const rule = report.rules.find(
      (entry) => entry.antecedent.join('') === 'a' && entry.consequent === 'b',
    );

    // a -> b: 180 of 220 = 0.8181818..., and the Wilson 95% lower bound is 0.7619003785559527.
    expect(rule?.confidence?.p).toBeCloseTo(180 / 220, 12);
    expect(rule?.confidence?.n).toBe(220);
    expect(rule?.confidence?.successes).toBe(180);
    expect(rule?.confidence?.lower).toBeCloseTo(0.7619003785559527, 10);
    expect(rule?.confidence?.confidence).toBe(0.95);
  });

  it('calls a rule informative only when its lower bound clears the base rate', () => {
    const report = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });
    const find = (antecedent: string, consequent: string) =>
      report.rules.find(
        (entry) => entry.antecedent.join('') === antecedent && entry.consequent === consequent,
      );

    // b -> a is 180/180, a flawless rule by confidence. Its lower bound is 0.9791045020783868 and
    // `a` occurs in 0.9167 of all transactions anyway, so it clears -- but only just, and a
    // confidence of 100% was never the reason.
    expect(find('b', 'a')?.confidence?.p).toBe(1);
    expect(find('b', 'a')?.confidence?.lower).toBeCloseTo(0.9791045020783868, 10);
    expect(find('b', 'a')?.informative).toBe(true);

    // c -> b sits EXACTLY on the base rate: 120/160 = 0.75 and `b` occurs in 180/240 = 0.75. Lift
    // is exactly 1 and the rule says nothing at all, though 75% reads like a finding.
    expect(find('c', 'b')?.confidence?.p).toBe(0.75);
    expect(find('c', 'b')?.baseRate).toBe(0.75);
    expect(find('c', 'b')?.lift).toBeCloseTo(1, 12);
    expect(find('c', 'b')?.confidence?.lower).toBeCloseTo(0.6775763046904398, 10);
    expect(find('c', 'b')?.informative).toBe(false);

    // a -> c is the near miss that shows the test is the LOWER bound and not the point estimate:
    // 160/220 = 0.7273 against a base rate of 0.6667 looks like a lift of 1.09, but the interval
    // reaches down to 0.6648988862552683, just under the base rate.
    expect(find('a', 'c')?.lift).toBeGreaterThan(1);
    expect(find('a', 'c')?.confidence?.lower).toBeCloseTo(0.6648988862552683, 10);
    expect(find('a', 'c')?.informative).toBe(false);
  });

  it('drops the AND-rules that add nothing to their shorter parents', () => {
    const report = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });

    // All three two-item antecedents are unproductive here, and each for its own reason:
    //   {a,b} -> c at 120/180 = 0.667 loses to {a} -> c at 160/220 = 0.727
    //   {a,c} -> b at 120/160 = 0.750 loses to {a} -> b at 180/220 = 0.818
    //   {b,c} -> a at 120/120 = 1.000 TIES {b} -> a at 180/180 = 1.000, and a tie is not an
    //     improvement: it is the parent's finding with a decoration attached.
    expect(report.unproductive).toBe(3);
    for (const rule of report.rules) expect(rule.antecedent).toHaveLength(1);
  });

  it('keeps an AND-rule that does earn its extra item', () => {
    // 60 x {x,y,z}, 60 x {x,y}, 60 x {x,z}, 60 x {x}.
    //   {x}     -> z : 120/240 = 0.50
    //   {x,y}   -> z :  60/120 = 0.50   -- no improvement, dropped
    //   {y}     -> z :  60/120 = 0.50
    // Now make z depend on y AND x jointly instead:
    const joint: string[][] = [
      ...repeat(['x', 'y', 'z'], 100),
      ...repeat(['x', 'y'], 20),
      ...repeat(['x', 'z'], 30),
      ...repeat(['x'], 90),
      ...repeat(['y', 'z'], 30),
      ...repeat(['y'], 90),
    ];
    // Supports: x 240, y 240, z 160, xy 120, xz 130, yz 130, xyz 100. Total 360.
    //   {x}   -> z : 130/240 = 0.5417
    //   {y}   -> z : 130/240 = 0.5417
    //   {x,y} -> z : 100/120 = 0.8333  -- beats both parents, so it survives.
    const report = associationRules(joint, { minSupport: 100, minConfidence: 0.5 });
    const compound = report.rules.find(
      (rule) => rule.antecedent.join('') === 'xy' && rule.consequent === 'z',
    );

    expect(compound?.support).toBe(100);
    expect(compound?.antecedentSupport).toBe(120);
    expect(compound?.confidence?.p).toBeCloseTo(100 / 120, 12);
    expect(compound?.informative).toBe(true);
  });

  it('flags a rule resting on too few transactions', () => {
    const thin: string[][] = [...repeat(['p', 'q'], 8), ...repeat(['p'], 4)];
    const report = associationRules(thin, { minSupport: 5, minConfidence: 0, minN: 20 });
    const rule = report.rules.find((entry) => entry.consequent === 'q');

    expect(rule?.support).toBe(8);
    expect(rule?.underpowered).toBe(true);
    // And the proportion carries the same judgement independently, from `MIN_N`.
    expect(rule?.confidence?.smallGroup).toBe(true);
  });

  it('agrees with a brute-force census on pseudo-random transactions', () => {
    // THE TEST THAT CHECKS THE TREE RATHER THAN THE ARITHMETIC. Six hundred transactions over eight
    // items, drawn from the package's own seeded generator so the case is fixed, then every itemset
    // up to size three counted by enumeration. FP-growth must find exactly the same sets with
    // exactly the same supports -- not a subset, not a superset.
    const next = mulberry32(seedOf('fp-growth-differential'));
    const transactions: string[][] = [];
    for (let i = 0; i < 600; i += 1) {
      const items: string[] = [];
      for (let item = 0; item < 8; item += 1) {
        // Item 0 is common, item 7 is rare -- a skewed vocabulary, which is what a real corpus has
        // and what makes the frequency ordering inside the tree do any work.
        if (next() < 0.6 - item * 0.06) items.push(`i${String(item)}`);
      }
      transactions.push(items);
    }

    const minSupport = 40;
    const expected = bruteForce(transactions, minSupport, 3);
    const report = associationRules(transactions, { minSupport, maxItemsetSize: 3 });
    const actual = new Map(report.itemsets.map((set) => [set.items.join('|'), set.support]));

    expect(actual.size).toBeGreaterThan(20);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, support] of expected) expect(actual.get(key)).toBe(support);
  });

  it('is deterministic, so two runs over one store agree', () => {
    const first = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });
    const again = associationRules(CORPUS, { minSupport: 100, minConfidence: 0 });

    expect(first.rules.map((rule) => `${rule.antecedent.join('')}=>${rule.consequent}`)).toEqual(
      again.rules.map((rule) => `${rule.antecedent.join('')}=>${rule.consequent}`),
    );
    expect(first.itemsets).toEqual(again.itemsets);
  });

  it('counts a repeated item once, because an item is a fact and not a tally', () => {
    const doubled: string[][] = [...repeat(['a', 'a', 'b'], 30), ...repeat(['b'], 10)];
    const report = associationRules(doubled, { minSupport: 10, minConfidence: 0 });
    const a = report.itemsets.find((set) => set.items.join('') === 'a');

    expect(a?.support).toBe(30);
    expect(report.transactions).toBe(40);
  });

  it('has nothing to mine in a corpus below the threshold', () => {
    const report = associationRules(
      [
        ['a', 'b'],
        ['a', 'b'],
      ],
      { minSupport: 20 },
    );
    expect(report.itemsets).toEqual([]);
    expect(report.rules).toEqual([]);
    expect(report.minSupport).toBe(20);
  });

  it('refuses options that would make a rule impossible or meaningless', () => {
    expect(() => associationRules(CORPUS, { minSupport: 0 })).toThrow(RuleError);
    expect(() => associationRules(CORPUS, { maxItemsetSize: 1 })).toThrow(/at least 2/);
    expect(() => associationRules(CORPUS, { minConfidence: 1.5 })).toThrow(/probability/);
  });
});
