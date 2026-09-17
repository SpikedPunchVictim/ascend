/**
 * Agreement between two raters -- Cohen's kappa, and the two absences it must represent honestly.
 *
 * WHY THIS IS HERE AND NOT ON TOP OF `proportion.ts`. `ARCHITECTURE.md` puts kappa in
 * `packages/analysis` beside the Wilson interval, because both answer one question -- "is this number
 * trustworthy at this n?" -- and the same discipline has to govern both. They are NOT the same
 * statistic and the difference is the reason this module exists rather than a call to `wilson`:
 *
 *   - A proportion is a share of a group. Its uncertainty is binomial, Wilson's interval covers it,
 *     and `proportion.ts` refuses to hand out the point estimate without the interval.
 *   - Kappa is a RATIO OF RATIOS -- agreement above chance, divided by the room above chance. It is
 *     not bounded by a binomial's variance, and its standard error is a different formula (Fleiss)
 *     that has not been validated against any anchor in this repository. So this module reports
 *     kappa, the two numbers it is built from, and n -- and reports NO interval, because an interval
 *     derived from the wrong variance is a wrong answer shaped like a right one. That is the same
 *     judgement `renderCoverage` makes about a census, arrived at the same way.
 *
 * WHAT KAPPA IS FOR. `ARCHITECTURE.md` states it directly: a classification is either reproducible
 * or the model is guessing, and kappa between two schemes -- or two passes of one scheme -- is the
 * direct measurement of which. That second case is why annotations are APPEND-ONLY in the store: a
 * design that let a re-run replace its predecessor would destroy the second pass a moment before it
 * was needed, and nothing would record that it had existed.
 *
 * RAW AGREEMENT IS NOT ENOUGH, which is the whole reason to prefer kappa. Two schemes that both
 * label 90% of entries `unclassified` agree most of the time while measuring nothing, and their
 * `observed` agreement will look excellent. `expected` is what that coincidence is worth, and it is
 * reported beside kappa so a reader can see it: a kappa of 0.2 with an expected of 0.7 is a very
 * different finding from a kappa of 0.2 with an expected of 0.1, and a reader shown only 0.2 could
 * not tell them apart.
 *
 * THE TWO ABSENCES, and neither may be papered over with a number:
 *
 *   1. **No overlap.** Two schemes over disjoint entry sets have no agreement to measure. The
 *      `measure` block is absent entirely rather than zero-valued -- a stated kappa of 0 for an
 *      empty comparison would be the `n = 0` fabrication `proportion.ts` was built to refuse, one
 *      module over.
 *   2. **Expected agreement is exactly 1.** Both raters used one label and it was the same label, so
 *      the denominator `1 - expected` is 0 and kappa is 0/0. This is not a corner case in this
 *      project; it is what a rule matching everything scored against a scheme that labels everything
 *      the same looks like. `kappa` is `null` there. Returning a number would claim perfect
 *      reproducibility from a corpus where nobody disagreed because nobody varied -- which is exactly
 *      backwards, since a degenerate vocabulary is evidence about the SCHEME, not about agreement.
 *      Note it can only arise with `observed` also 1: if expected is 1 the two raters assigned every
 *      entry the same one label, so they agreed everywhere by construction.
 *
 * DUPLICATES ARE REFUSED, NOT RESOLVED. A rater that labelled one entry twice gives the arithmetic no
 * principled choice of which to use, and this repository refuses a conflict between two declarations
 * of one name rather than silently picking a winner (`asc-4if`, and the prose-key rule in
 * `registry.ts`). The store's own constraint is narrower -- one annotation per (entry, scheme,
 * version, pass) -- and this is the corresponding rule for the caller who built the array by hand.
 *
 * WHAT IS NOT COMPUTED, and why it is a reserve rather than an oversight: a standard error or
 * confidence interval for kappa (see above), a permutation control for whether an agreement is
 * distinguishable from chance at this n (the seeded generator that control needs is in `sample.ts`
 * and the control is not yet ported), and the Landau-Landis interpretation band. The band was
 * designed and left out on purpose: "substantial" and "almost perfect" are conventions the
 * literature itself disputes, and printing one would put a categorical claim on a number whose
 * cutoffs are not a measurement. `observed` and `expected` are printed instead, which is what a
 * reader actually needs to judge a kappa.
 *
 * Pure: plain arrays in, plain data out, no `fs`, no clock, no random draw (enforced by `align check`
 * and `purity-enforcement.test.ts`).
 */

import { isSmallGroup } from './proportion.js';

/**
 * A caller asked for an agreement between rater lists that cannot be paired.
 *
 * Thrown for a duplicate label or an empty id/label, never for a merely inconvenient input: two
 * raters who labelled disjoint entry sets have a defined answer (no overlap), and refusing that
 * would push callers to guard the call themselves, which is how the guard gets forgotten.
 */
export class AgreementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgreementError';
  }
}

/** One rater's label for one entry. The id is what pairs the two raters' lists. */
export interface Labelled {
  readonly id: string;
  readonly label: string;
}

/**
 * What each rater did with one label, over the entries both of them labelled.
 *
 * Both counts, because `expected` is built from the PRODUCT of the two marginal shares and a reader
 * auditing a surprising kappa needs to see which side produced it.
 */
export interface LabelMarginal {
  readonly label: string;
  readonly a: number;
  readonly b: number;
}

/**
 * The arithmetic -- present only when there is at least one entry both raters labelled.
 *
 * Absent rather than zero-valued for an empty comparison; see absence 1 in the module comment.
 */
export interface AgreementMeasure {
  /** Entries where both raters used the same label -- the raw count behind `observed`. */
  readonly agreed: number;
  /** `agreed / compared`: how often the two actually agreed, before correcting for chance. */
  readonly observed: number;
  /** How often they would have agreed from their marginals alone. */
  readonly expected: number;
  /** `(observed - expected) / (1 - expected)`, or `null` when the denominator is 0. */
  readonly kappa: number | null;
  /** `compared` is below `MIN_N` -- the same threshold a proportion is judged against. */
  readonly smallGroup: boolean;
}

/** The full picture: what could be paired, what could not, and what the pairing measured. */
export interface Agreement {
  /** Entries both raters labelled. Kappa is computed over these and only these. */
  readonly compared: number;
  /** Entries only the first rater labelled. Excluded from the arithmetic, and reported. */
  readonly onlyA: number;
  /** Entries only the second rater labelled. Same. */
  readonly onlyB: number;
  /** The label vocabulary over the compared entries, sorted. Empty when nothing was compared. */
  readonly labels: readonly string[];
  /** Per-label counts for each rater, sorted by label. Empty when nothing was compared. */
  readonly marginals: readonly LabelMarginal[];
  /** `null` when nothing could be compared, so a caller cannot read a kappa out of an empty join. */
  readonly measure: AgreementMeasure | null;
}

/**
 * One rater's labels, keyed by entry id, with the two inputs that cannot be paired refused.
 *
 * `which` names the rater in the message. A caller reading "labelled entry 'e1' twice" needs to know
 * which of the two lists to go and look at, and "one of the raters" would send them to both.
 */
function index(rater: readonly Labelled[], which: string): Map<string, string> {
  const byId = new Map<string, string>();

  for (const item of rater) {
    if (item.id === '') {
      throw new AgreementError(
        `${which} labelled an entry whose id is empty, so its labels cannot be paired with the other ` +
          `rater's. An annotation always names the entry it is about.`,
      );
    }
    if (item.label === '') {
      throw new AgreementError(
        `${which} gave entry '${item.id}' an empty label. An empty label is a missing value wearing a ` +
          `value's clothes, and counting it as a label would inflate the agreement vocabulary.`,
      );
    }

    const seen = byId.get(item.id);
    if (seen !== undefined) {
      throw new AgreementError(
        `${which} labelled entry '${item.id}' twice ('${seen}' and '${item.label}'), so there is no ` +
          `way to choose between them. One rater gives one label per entry -- if these are two passes, ` +
          `they are two raters and belong in separate lists.`,
      );
    }

    byId.set(item.id, item.label);
  }

  return byId;
}

/**
 * Cohen's kappa between two raters' labels over the entries they both labelled.
 *
 * `a` and `b` are two passes, two schemes, or one of each. Order matters only in that `onlyA` and
 * `onlyB` name which list an unpaired entry came from; kappa itself is symmetric.
 */
export function cohenKappa(a: readonly Labelled[], b: readonly Labelled[]): Agreement {
  const first = index(a, 'the first rater');
  const second = index(b, 'the second rater');

  const pairs: (readonly [string, string])[] = [];
  for (const [id, labelA] of first) {
    const labelB = second.get(id);
    if (labelB !== undefined) pairs.push([labelA, labelB]);
  }

  const counts = new Map<string, { a: number; b: number }>();
  let agreed = 0;

  for (const [labelA, labelB] of pairs) {
    const first = counts.get(labelA) ?? { a: 0, b: 0 };
    first.a += 1;
    counts.set(labelA, first);

    // Both raters used this label, so it is ONE record and its `b` has to be incremented here. The
    // version this replaces incremented `a`, saw the labels matched, and `continue`d -- which was
    // meant to avoid writing the same object twice and instead dropped the second rater's count
    // entirely. Nothing in the hand-computed kappas below could see it: the totals are symmetric
    // enough that it moved the marginals without moving the ratio, and it was the invariant that
    // every marginal must sum to `compared` that caught it.
    if (labelA === labelB) {
      first.b += 1;
      agreed += 1;
      continue;
    }

    const second = counts.get(labelB) ?? { a: 0, b: 0 };
    second.b += 1;
    counts.set(labelB, second);
  }

  const marginals: readonly LabelMarginal[] = [...counts.entries()]
    .map(([label, count]) => ({ label, a: count.a, b: count.b }))
    .sort((x, y) => (x.label < y.label ? -1 : 1));
  const labels = marginals.map((marginal) => marginal.label);

  const compared = pairs.length;
  const onlyA = a.length - compared;
  const onlyB = b.length - compared;

  // No overlap: there is no agreement to measure, so there is no measure. See absence 1.
  if (compared === 0) {
    return { compared, onlyA, onlyB, labels: [], marginals: [], measure: null };
  }

  const observed = agreed / compared;

  // Summed over the union of the two vocabularies -- a label only one rater used contributes a zero
  // for the other side and so contributes nothing, which is correct: it cannot be chance agreement.
  let expected = 0;
  for (const marginal of marginals) {
    expected += (marginal.a / compared) * (marginal.b / compared);
  }

  // `=== 1` exactly rather than a tolerance, and it is exact rather than lucky: both degenerate
  // shares are `n / n`, and IEEE-754 division of equal operands is exactly 1. A near-degenerate pair
  // of marginals gives a product strictly below 1, which is a defined kappa and must not be caught
  // here. See absence 2 for why null is the honest answer rather than 0 or 1.
  const kappa = expected === 1 ? null : (observed - expected) / (1 - expected);

  return {
    compared,
    onlyA,
    onlyB,
    labels,
    marginals,
    measure: { agreed, observed, expected, kappa, smallGroup: isSmallGroup(compared) },
  };
}
