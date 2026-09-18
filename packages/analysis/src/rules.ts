/**
 * Association rules -- the cross-property patterns nobody thought to query.
 *
 * THE BEAD'S OWN EXAMPLE IS THE SPECIFICATION: "stage=implementation AND category=async-handling ->
 * severity=high, 78%, support 42". Three things in that sentence carry the design.
 *
 * FIRST, "78%" IS A PROPORTION, AND THIS PROJECT HAS A RULE ABOUT PROPORTIONS. `ARCHITECTURE.md`'s
 * honesty section, and `proportion.ts` after it, require that every share of a group that is
 * EVIDENCE ABOUT A POPULATION leaves this codebase with a Wilson interval and its n attached, and
 * that a group under `MIN_N` is named an anecdote rather than printed as a seductive percentage. A
 * rule's confidence is exactly that kind of proportion -- 78% of 42 is 33 entries, and the interval
 * on it runs from roughly 63% to 88%. So `confidence` here is a `Proportion`, not a number: there
 * is no way to read the confidence off this result without also being handed the interval. That is
 * the same mistake `asc-5x7` found in `asc explore`, and this is the module where it would have
 * been easiest to repeat.
 *
 * SECOND, CONFIDENCE ALONE IS A TRAP, AND IT IS THE TRAP THIS WHOLE TECHNIQUE IS FAMOUS FOR. If
 * `severity=high` holds for 80% of all entries, then EVERY rule ending in it has about 80%
 * confidence, and a list sorted by confidence is a list of the most common consequent, dressed up.
 * So every rule also carries `lift` -- confidence divided by the consequent's base rate -- and, more
 * usefully than lift, the `informative` flag: true only when the Wilson LOWER BOUND of the
 * confidence exceeds the consequent's base rate. That is a conservative test of "this rule beats
 * knowing nothing", it uses the interval that is already being computed, and unlike a bare lift
 * above 1 it cannot be produced by a handful of rows.
 *
 * THIRD, "AND" INVITES A RULE THAT ADDS NOTHING. If `stage=implementation -> severity=high` already
 * holds at 78%, then `stage=implementation AND category=async-handling -> severity=high` at 78% is
 * the same finding with a decoration attached, and a miner that reports both floods the output with
 * variations of one pattern. Only PRODUCTIVE rules survive: a rule is kept when its confidence
 * beats every immediate sub-rule's -- the same consequent, one antecedent item removed -- by at
 * least `minImprovement`. This is the filter that decides whether the output is readable.
 *
 * CONSEQUENTS ARE A SINGLE ITEM, deliberately. A rule with a compound consequent is two findings a
 * reader has to decompose by hand, and its confidence is the confidence of neither. The bead's
 * example has one, every readable rule has one, and allowing more would multiply the output by the
 * size of the powerset for no gain in what can be understood.
 *
 * WHY FP-GROWTH AND NOT APRIORI. The bead names it, and the reason holds: Apriori generates
 * candidate itemsets and then tests them, which on a wide transaction -- ten properties per entry --
 * means generating a great many candidates that do not exist in the data. FP-growth builds a prefix
 * tree of the transactions themselves and mines it recursively, so it only ever visits itemsets
 * that occur. The tree is built with items ordered by descending frequency, ties broken by name, so
 * the tree and therefore the whole output are DETERMINISTIC -- two runs over one store agree, which
 * is this store's contract and not a convenience.
 *
 * ITEMS ARE OPAQUE STRINGS, the same convention `sample.ts` set. This module groups by them, counts
 * them and sorts them, and never interprets them. `stage=implementation` is a string here; the
 * knowledge that it is a property and a value belongs to whoever built it.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`). Nothing here draws a random number, so there is no seed.
 */

import { MIN_N, wilson, type Proportion } from './proportion.js';

/** A caller handed this module something it will not mine. */
export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

/** The separator joining items into an itemset key. NUL, the one byte an item cannot contain. */
const ITEM_SEPARATOR = '\u0000';

/** One frequent itemset and how often it occurred. */
export interface FrequentItemset {
  /** The items, ascending. */
  readonly items: readonly string[];
  /** Transactions containing all of them. */
  readonly support: number;
}

/** One rule: an antecedent, a single-item consequent, and every reason to doubt it. */
export interface AssociationRule {
  /** The left-hand side, ascending. */
  readonly antecedent: readonly string[];
  /** The right-hand side. Always one item. */
  readonly consequent: string;
  /** Transactions containing the antecedent AND the consequent. The "support 42" of the example. */
  readonly support: number;
  /** Transactions containing the antecedent, whether or not the consequent followed. */
  readonly antecedentSupport: number;
  /**
   * Confidence as a proportion with its interval, never as a bare ratio.
   *
   * `null` only where `antecedentSupport` is zero, which the miner cannot produce -- the type says
   * so because `wilson` refuses to invent an estimate for an empty group, and threading that
   * honesty through rather than defeating it with a cast is the point.
   */
  readonly confidence: Proportion | null;
  /** The consequent's share of all transactions -- what the rule has to beat. */
  readonly baseRate: number;
  /** Confidence over base rate. Above 1 means the antecedent helps; it does not mean it helps much. */
  readonly lift: number;
  /** True when the confidence interval's LOWER bound clears the base rate. */
  readonly informative: boolean;
  /** True when `support` is under `minN`: an anecdote about a rule, not an estimate. */
  readonly underpowered: boolean;
}

/** How the miner is asked for its rules. */
export interface RuleOptions {
  /** Minimum transactions an itemset must occur in. Default 20 (`MIN_N`). */
  readonly minSupport?: number;
  /** Largest itemset to mine, antecedent plus consequent. Default 3. */
  readonly maxItemsetSize?: number;
  /** Minimum confidence for a rule to be reported at all. Default 0.5. */
  readonly minConfidence?: number;
  /** How much a rule must beat its best sub-rule by to be kept. Default 0 -- strictly better. */
  readonly minImprovement?: number;
  /** Support below this flags a rule `underpowered`. Default `MIN_N`. */
  readonly minN?: number;
  /** Confidence level for the interval on every rule's confidence. Default 0.95. */
  readonly confidence?: 0.9 | 0.95 | 0.99;
}

/** The rules, with what they were mined from. */
export interface RuleReport {
  /** Rules that survived every filter, most informative first. */
  readonly rules: readonly AssociationRule[];
  /** Frequent itemsets found, of every size. */
  readonly itemsets: readonly FrequentItemset[];
  /** Transactions mined. */
  readonly transactions: number;
  /** The support threshold actually used. */
  readonly minSupport: number;
  /** Rules dropped for adding nothing to a shorter rule with the same consequent. */
  readonly unproductive: number;
}

/** A node of the FP-tree. */
interface FPNode {
  readonly item: string;
  count: number;
  readonly parent: FPNode | null;
  readonly children: Map<string, FPNode>;
  /** The next node for the same item, threading the header table through the tree. */
  next: FPNode | null;
}

/** One item's entry in the header table. */
interface HeaderEntry {
  count: number;
  head: FPNode | null;
  tail: FPNode | null;
}

/** A fresh root, which holds no item of its own. */
function newTree(): FPNode {
  return { item: '', count: 0, parent: null, children: new Map(), next: null };
}

/** Insert one already-ordered transaction into the tree, threading the header table. */
function insert(
  root: FPNode,
  items: readonly string[],
  count: number,
  header: Map<string, HeaderEntry>,
): void {
  let node = root;
  for (const item of items) {
    let child = node.children.get(item);
    if (child === undefined) {
      child = { item, count: 0, parent: node, children: new Map(), next: null };
      node.children.set(item, child);
      const entry = header.get(item) as HeaderEntry;
      if (entry.tail === null) entry.head = child;
      else entry.tail.next = child;
      entry.tail = child;
    }
    child.count += count;
    node = child;
  }
}

/**
 * Order items by descending frequency, ties by name ascending.
 *
 * The tie-break is not cosmetic. FP-growth's tree shape depends on this order, and so does which of
 * two equally-supported itemsets is found first; without a total order the output would vary with
 * `Map` iteration order and two runs over one store could disagree.
 */
function orderOf(counts: ReadonlyMap<string, number>, minSupport: number): string[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= minSupport)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([item]) => item);
}

/** Build a tree from transactions already reduced to frequent items. */
function build(
  transactions: readonly (readonly [readonly string[], number])[],
  counts: ReadonlyMap<string, number>,
  minSupport: number,
): { root: FPNode; header: Map<string, HeaderEntry>; order: string[] } {
  const order = orderOf(counts, minSupport);
  const rank = new Map(order.map((item, index) => [item, index]));
  const header = new Map<string, HeaderEntry>(
    order.map((item) => [item, { count: counts.get(item) as number, head: null, tail: null }]),
  );
  const root = newTree();

  for (const [items, count] of transactions) {
    const kept = items
      .filter((item) => rank.has(item))
      .sort((a, b) => (rank.get(a) as number) - (rank.get(b) as number));
    if (kept.length > 0) insert(root, kept, count, header);
  }

  return { root, header, order };
}

/**
 * Mine the tree recursively, accumulating itemset supports.
 *
 * The header table is walked from the LEAST frequent item upward, which is what makes the
 * conditional trees small: mining the rarest suffix first leaves the largest possible prefix to
 * condition on.
 */
function mine(
  header: Map<string, HeaderEntry>,
  order: readonly string[],
  suffix: readonly string[],
  maxItemsetSize: number,
  minSupport: number,
  out: Map<string, number>,
): void {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const item = order[index] as string;
    const entry = header.get(item) as HeaderEntry;
    if (entry.count < minSupport) continue;

    const itemset = [...suffix, item].sort();
    out.set(itemset.join(ITEM_SEPARATOR), entry.count);
    if (itemset.length >= maxItemsetSize) continue;

    // The conditional pattern base: every path from the root to a node holding this item, weighted
    // by that node's count.
    const conditional: [readonly string[], number][] = [];
    const conditionalCounts = new Map<string, number>();
    for (let node = entry.head; node !== null; node = node.next) {
      const path: string[] = [];
      for (let up = node.parent; up !== null && up.parent !== null; up = up.parent)
        path.push(up.item);
      if (path.length === 0) continue;
      path.reverse();
      conditional.push([path, node.count]);
      for (const ancestor of path)
        conditionalCounts.set(ancestor, (conditionalCounts.get(ancestor) ?? 0) + node.count);
    }
    if (conditional.length === 0) continue;

    const sub = build(conditional, conditionalCounts, minSupport);
    if (sub.order.length > 0) mine(sub.header, sub.order, itemset, maxItemsetSize, minSupport, out);
  }
}

/**
 * Frequent itemsets and the rules over them.
 *
 * `minSupport` defaults to `MIN_N` rather than to a fraction of the corpus, and that is a judgement
 * worth stating: a rule resting on fewer than twenty transactions is an anecdote whatever fraction
 * of the corpus twenty happens to be, and a fractional default would silently become an anecdote
 * threshold on a small store and an unreachable one on a large store.
 */
export function associationRules(
  transactions: readonly (readonly string[])[],
  options: RuleOptions = {},
): RuleReport {
  const minSupport = options.minSupport ?? MIN_N;
  const maxItemsetSize = options.maxItemsetSize ?? 3;
  const minConfidence = options.minConfidence ?? 0.5;
  const minImprovement = options.minImprovement ?? 0;
  const minN = options.minN ?? MIN_N;
  const level = options.confidence ?? 0.95;

  if (minSupport < 1) throw new RuleError('associationRules: minSupport must be at least 1');
  if (maxItemsetSize < 2)
    throw new RuleError('associationRules: maxItemsetSize must be at least 2 for a rule to exist');
  if (minConfidence < 0 || minConfidence > 1)
    throw new RuleError('associationRules: minConfidence must be a probability');

  const total = transactions.length;

  // Duplicate items inside one transaction are collapsed. An item is a fact about a transaction --
  // `stage=implementation` is true or it is not -- and counting it twice would inflate its support
  // without any itemset containing it twice, which is the kind of error that shows up only as a
  // number that is slightly too large.
  const deduplicated = transactions.map(
    (items) => [[...new Set(items)].sort(), 1] as [readonly string[], number],
  );

  const counts = new Map<string, number>();
  for (const [items] of deduplicated)
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);

  const supports = new Map<string, number>();
  const { header, order } = build(deduplicated, counts, minSupport);
  if (order.length > 0) mine(header, order, [], maxItemsetSize, minSupport, supports);

  const itemsets: FrequentItemset[] = [...supports.entries()]
    .map(([key, support]) => ({ items: key.split(ITEM_SEPARATOR), support }))
    .sort(
      (a, b) =>
        b.support - a.support ||
        a.items.length - b.items.length ||
        (a.items.join() < b.items.join() ? -1 : 1),
    );

  const supportOf = (items: readonly string[]): number =>
    supports.get([...items].sort().join(ITEM_SEPARATOR)) ?? 0;

  const rules: AssociationRule[] = [];
  let unproductive = 0;

  for (const itemset of itemsets) {
    if (itemset.items.length < 2) continue;

    for (const consequent of itemset.items) {
      const antecedent = itemset.items.filter((item) => item !== consequent);
      const antecedentSupport = supportOf(antecedent);
      if (antecedentSupport === 0) continue;

      const ratio = itemset.support / antecedentSupport;
      if (ratio < minConfidence) continue;

      // PRODUCTIVE ONLY. Every immediate sub-rule -- same consequent, one antecedent item dropped --
      // must be beaten. A rule that merely matches its parent is the parent's finding with a
      // decoration attached, and reporting both is how this technique produces unreadable output.
      let beatsParents = true;
      if (antecedent.length > 1) {
        for (const dropped of antecedent) {
          const shorter = antecedent.filter((item) => item !== dropped);
          const shorterAntecedent = supportOf(shorter);
          if (shorterAntecedent === 0) continue;
          const parentRatio = supportOf([...shorter, consequent]) / shorterAntecedent;
          if (ratio - parentRatio <= minImprovement) {
            beatsParents = false;
            break;
          }
        }
      }
      if (!beatsParents) {
        unproductive += 1;
        continue;
      }

      const baseRate = total === 0 ? 0 : (counts.get(consequent) ?? 0) / total;
      const proportion = wilson(itemset.support, antecedentSupport, level);

      rules.push({
        antecedent,
        consequent,
        support: itemset.support,
        antecedentSupport,
        confidence: proportion,
        baseRate,
        lift: baseRate === 0 ? 0 : ratio / baseRate,
        informative: proportion !== null && proportion.lower > baseRate,
        underpowered: itemset.support < minN,
      });
    }
  }

  // Ranked by how far the rule's confidence provably clears the base rate -- the lower bound, not
  // the point estimate. A rule resting on twenty-two transactions has a wide interval and sinks;
  // one resting on four hundred with the same headline percentage rises. Sorting on the point
  // estimate or on lift would put them the other way round.
  rules.sort(
    (a, b) =>
      (b.confidence?.lower ?? 0) - b.baseRate - ((a.confidence?.lower ?? 0) - a.baseRate) ||
      b.support - a.support ||
      (a.antecedent.join() < b.antecedent.join() ? -1 : 1) ||
      (a.consequent < b.consequent ? -1 : 1),
  );

  return { rules, itemsets, transactions: total, minSupport, unproductive };
}
