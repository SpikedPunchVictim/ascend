/**
 * Back-testing -- grading a proposed RULE against a hand-labelled GROUND TRUTH.
 *
 * WHY THIS IS NOT `agreement.ts` WEARING A NEW NAME. Cohen's kappa is symmetric: it has no notion
 * of which rater is right, only of how often two raters land on the same answer, corrected for the
 * agreement chance alone would produce. Back-testing is not that question. `asc-3o9`'s premise is
 * that a hand-labelled sample IS the truth for the entries it covers, and a rule is a predictor
 * being graded against it -- precision (of what the rule claimed, how much was right) and recall
 * (of what is actually true, how much the rule found) are both asymmetric in exactly the way kappa
 * refuses to be. Calling `cohenKappa(ruleLabels, handLabels)` and reading its `observed` as
 * "accuracy" would silently launder that asymmetry away: `agreement.ts`'s own module comment says
 * kappa reports NO interval and NO ground truth, on purpose, and grading a predictor is a different
 * statistic built on the same idea of "compare two labelled sets by entry id".
 *
 * WHY PER-LABEL, NOT ONE NUMBER. A scheme's rules are one predictor with several classes, and a
 * rule that nails `bug` while missing every `docs` is a different finding from the reverse --
 * collapsing to a single accuracy would average the two into a number that describes neither.
 * `agreement.ts`'s per-label marginals establish the same idea for kappa; this module reports
 * precision and recall per label instead, because those -- not a shared marginal count -- are what
 * a rule's author needs to know to fix the rule.
 *
 * THE STATISTICAL HONESTY RULE THIS MODULE EXISTS TO ENFORCE: a hand-labelled sample is small by
 * construction (that is the whole premise of back-testing -- hand-labelling the whole corpus would
 * make the rule pointless), so every precision and every recall is a `Proportion` from
 * `wilson()`, never a bare ratio. A caller that divides `truePositives` by `predicted` itself and
 * prints the quotient has exactly reproduced the defect `proportion.ts` exists to prevent: a
 * precision of 1.00 computed from 3 items printed with the same confidence as one computed from
 * 300. `wilson()` returns `null` when the denominator is 0 (see `proportion.ts`, departure 2), and
 * this module passes that `null` straight through rather than coercing it to a number -- a label the
 * rule never predicted has no precision to report, and a label the hand truth never used has no
 * recall to report. Both are omissions, not zeros.
 *
 * WHAT COUNTS AS THE UNIVERSE. Only the entries the ground truth labels -- `truth`'s ids -- because
 * precision and recall are both conditioned on knowing the right answer, and there is no right
 * answer for an entry the hand-labelled pass never covered. A `predicted` label for an entry outside
 * that universe is silently uninformative here (it contributes to neither precision nor recall for
 * any label) rather than refused, because the caller's own scope decision -- which entries the rule
 * was even run over -- is allowed to be wider than the hand sample without that being an error.
 *
 * DUPLICATES ARE REFUSED, NOT RESOLVED, for the reason `agreement.ts` gives: neither list has a
 * principled way to choose between two labels claimed for one entry, and picking one silently would
 * make the arithmetic depend on an arbitrary choice this module never states.
 *
 * Pure: plain arrays in, plain data out, no `fs`, no clock, no random draw (enforced by
 * `align check` and `purity-enforcement.test.ts`).
 */

import type { Labelled } from './agreement.js';
import { wilson, type Proportion } from './proportion.js';

/**
 * A caller asked for a back-test between lists that cannot be paired.
 *
 * Thrown for a duplicate id or an empty id/label within one list, in the same shape
 * `AgreementError` is -- see that class for why this is a refusal rather than a silent pick.
 */
export class BacktestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BacktestError';
  }
}

/**
 * One label's grade: how often the rule was right when it claimed this label (precision), and how
 * much of the hand truth for this label the rule actually found (recall).
 *
 * `predicted` and `actual` are the two denominators -- precision's and recall's -- reported
 * alongside the proportions built from them, so a reader can see `n` without unwrapping a `null`
 * proportion to find it. `truePositives` is the numerator both proportions share.
 */
export interface BacktestLabelMeasure {
  readonly label: string;
  /** Entries in the universe where the rule assigned `label`. Precision's denominator. */
  readonly predicted: number;
  /** Entries in the universe where the hand truth assigned `label`. Recall's denominator. */
  readonly actual: number;
  /** Entries where both the rule and the hand truth assigned `label`. The shared numerator. */
  readonly truePositives: number;
  /**
   * Entry ids the rule assigned `label` that the hand truth assigned something else.
   *
   * A caller reading only `predicted - truePositives` learns a count; this is the count NAMED, so a
   * rule's author can go look at the specific entries the rule got wrong rather than re-deriving
   * which ones from a number.
   */
  readonly falsePositives: readonly string[];
  /** Entry ids the hand truth assigned `label` that the rule missed (assigned something else, or nothing). */
  readonly falseNegatives: readonly string[];
  /** `wilson(truePositives, predicted)`, or `null` when the rule never predicted this label. */
  readonly precision: Proportion | null;
  /** `wilson(truePositives, actual)`, or `null` when the hand truth never used this label. */
  readonly recall: Proportion | null;
}

/** The full back-test: the universe it was measured over, and the grade for every label seen. */
export interface BacktestReport {
  /** Entries in the hand-labelled ground truth. Every measure's `predicted`/`actual` sums into this. */
  readonly compared: number;
  /**
   * Every label the rule predicted or the hand truth used, over the compared entries -- sorted, and
   * empty only when `compared` is 0.
   */
  readonly labels: readonly string[];
  readonly measures: readonly BacktestLabelMeasure[];
}

/**
 * One list's labels, keyed by entry id, with the two inputs that cannot be paired refused.
 *
 * A close copy of `agreement.ts`'s `index`, kept separate rather than shared: the two modules
 * report different errors for the same shape of mistake (`BacktestError` here, `AgreementError`
 * there), and importing one internal across the module boundary for four lines of validation would
 * couple their error identities together for no reader's benefit.
 */
function index(rater: readonly Labelled[], which: string): Map<string, string> {
  const byId = new Map<string, string>();

  for (const item of rater) {
    if (item.id === '') {
      throw new BacktestError(
        `${which} has an entry whose id is empty, so it cannot be paired with the other list's. ` +
          `An annotation always names the entry it is about.`,
      );
    }
    if (item.label === '') {
      throw new BacktestError(
        `${which} gives entry '${item.id}' an empty label. An empty label is a missing value ` +
          `wearing a value's clothes, and counting it as a label would inflate the vocabulary being ` +
          `graded.`,
      );
    }

    const seen = byId.get(item.id);
    if (seen !== undefined) {
      throw new BacktestError(
        `${which} names entry '${item.id}' twice ('${seen}' and '${item.label}'), so there is no ` +
          `way to choose which label it actually has. One label per entry per list -- two passes of ` +
          `one scheme are two lists, not one.`,
      );
    }

    byId.set(item.id, item.label);
  }

  return byId;
}

/**
 * Grade `predicted` (a rule's output) against `truth` (a hand-labelled ground truth), per label.
 *
 * `compared` is `truth`'s size, not the union with `predicted`: see the module comment on what
 * counts as the universe. An entry the rule predicted outside that universe changes no measure.
 */
export function backtest(
  predicted: readonly Labelled[],
  truth: readonly Labelled[],
): BacktestReport {
  const predictedById = index(predicted, "the rule's predictions");
  const truthById = index(truth, 'the hand-labelled ground truth');

  const compared = truthById.size;
  if (compared === 0) {
    return { compared: 0, labels: [], measures: [] };
  }

  const labels = new Set<string>();
  for (const label of truthById.values()) labels.add(label);
  for (const [id, label] of predictedById) {
    if (truthById.has(id)) labels.add(label);
  }

  const sortedLabels = [...labels].sort();

  const measures = sortedLabels.map((label): BacktestLabelMeasure => {
    let truePositives = 0;
    let predictedCount = 0;
    let actualCount = 0;
    const falsePositives: string[] = [];
    const falseNegatives: string[] = [];

    for (const [id, actualLabel] of truthById) {
      const predictedLabel = predictedById.get(id);
      const isActual = actualLabel === label;
      const isPredicted = predictedLabel === label;

      if (isActual) actualCount += 1;
      if (isPredicted) predictedCount += 1;

      if (isActual && isPredicted) {
        truePositives += 1;
      } else if (isPredicted) {
        falsePositives.push(id);
      } else if (isActual) {
        falseNegatives.push(id);
      }
    }

    return {
      label,
      predicted: predictedCount,
      actual: actualCount,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: wilson(truePositives, predictedCount),
      recall: wilson(truePositives, actualCount),
    };
  });

  return { compared, labels: sortedLabels, measures };
}
