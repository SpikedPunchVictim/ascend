/**
 * Comparing a name about to be defined against names the registry already holds.
 *
 * **Why this exists, in numbers.** `EV-drift` asked five independent authors to define ONE type from
 * ONE brief, with the bounded property vocabulary available. The result: **44 distinct property
 * names, of which 4 were shared by all five** -- intersection/union **0.091**, mean pairwise Jaccard
 * **0.300**, and **three authors writing snake_case against two writing camelCase**. One type name,
 * one brief, and the same concept named four ways.
 *
 * **Why it WARNS and never refuses.** The same measurement is what decides that, and it decides it
 * against the obvious design. Two independent definitions of the *same* concept agree on 0.300 of
 * their property names. So a refusal threshold high enough to be meaningful would sit *above* the
 * same-concept score and refuse legitimate work; one low enough to admit same-concept definitions
 * would admit everything. A similarity gate cannot separate "same concept, new name" from "different
 * concept" at a 0.300 signal. What genuinely can be refused needs no threshold at all, and is
 * already refused elsewhere: a name colliding with a reserved envelope column (`spec.ts`), and two
 * properties canonicalizing to one name inside a single spec.
 *
 * **So the mechanism here carries no threshold, by construction.** A name is reported when it shares
 * a whole token with a known name -- `review_kind` against `kind`, `code_review` against
 * `review_completed`. Token sharing is a *certain* relation: it is either true or it is not, so
 * there is no floor to pick, and therefore no number to invent. `EV-drift`'s remedy was "a shared
 * property vocabulary ... matched against before registration"; this is that match, ranked by how
 * much is shared, with the reason printed so a caller can judge it instead of guessing why.
 *
 * The camelCase/snake_case half of the drift is already handled before this module sees anything:
 * `canonicalName` folds both to `lower_snake`, so `reviewKind` and `review_kind` are one name here,
 * not two confusable ones.
 *
 * Pure: no `fs`, no clock, no database. The registry supplies the candidate names; this ranks them.
 */

import { canonicalName } from './spec.js';

/** A known name that shares at least one whole token with the name being defined. */
export interface ConfusableName {
  /** The registered name, spelled as the registry holds it. */
  readonly name: string;
  /**
   * The tokens both names have, sorted and deduplicated.
   *
   * Carried rather than omitted because it is the *reason*: `'review_kind' shares 'review'` is a
   * claim a caller can check in one second, while a bare score is a number they must take on faith.
   */
  readonly shared: readonly string[];
}

/**
 * The whole tokens of a name, after canonical folding.
 *
 * Folded first, and that order matters: tokenizing raw would make `reviewKind` one token and
 * `review_kind` two, which is precisely the drift this module exists to catch. Measured against
 * `canonicalName`: `reviewKind` and `review_kind` both tokenize to `['review', 'kind']`.
 */
export function nameTokens(name: string): readonly string[] {
  return canonicalName(name)
    .split('_')
    .filter((token) => token.length > 0);
}

/**
 * Known names sharing at least one token with `name`, most-shared first.
 *
 * A name equal to `name` after canonical folding is skipped: an exact match is not a confusion, it
 * is the same name, and the caller learns about that separately (`registerType` reports it as
 * `unchanged` or as the next version). Reporting it here would bury the real signals under a match
 * that means the opposite of what this function is for.
 *
 * Ordered by shared-token count, then by name, so the output is stable across runs -- a warning list
 * that reorders itself is one a caller cannot diff between two invocations.
 *
 * **The corpus is walked in canonical-then-spelling order, not in the order it arrived.** Two
 * spellings of one name (`findings_count` and `findingsCount`) both fold to the same canonical
 * name, so the dedup below keeps whichever it reaches first -- which would make the reported
 * spelling, and with it the whole result, a function of the caller's array order. The registry
 * currently sorts its names, so this is not reachable today; it is done here because that means the
 * stability promised above rests on a contract nothing enforces. Sorting here costs one pass over
 * a list that is tens of entries at the very most, and makes the promise unconditional.
 *
 * **And the comparison is code-unit, not `localeCompare`.** `localeCompare` with no locale argument
 * collates by the runtime's default locale, so the same name set would order differently under a
 * different `LANG` -- stability that holds on one machine and quietly stops holding on another is
 * the ambient-state problem, not stability. Code-unit order is the same everywhere. It is only used
 * to break ties between names already equal after folding, so nothing user-visible depends on the
 * alphabet it produces.
 *
 * **Every match is returned, and how many to print is the caller's decision.** An earlier version
 * took a `limit` and sliced here. That made the one caller that formats a message unable to tell
 * "there are exactly three" from "there are three and I was not shown the rest", so the warning said
 * "shares 'stage' with registered types a, b, c" when the truth was six -- a message that understates
 * what it found, which is the reporting defect this project treats as most serious. A matcher
 * returns what it found; a presenter decides how much of it to print and says when it truncated.
 * Measured cost of not capping here: the whole real corpus is 44 names, and the widest match set it
 * produces is 6.
 */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function confusableNames(name: string, known: readonly string[]): readonly ConfusableName[] {
  const mine = new Set(nameTokens(name));
  // An early exit, NOT a guard: with an empty token set every candidate's shared set is empty and
  // is skipped below anyway, so removing this line changes nothing observable -- verified, not
  // assumed (`confusableNames('---', ['stage'])` returns `[]` either way). Kept because it also
  // skips the sort of the whole corpus for a name that cannot match anything, and stated plainly so
  // it is not mistaken for a check that is holding a defect back.
  if (mine.size === 0) return [];

  const self = canonicalName(name);
  const seen = new Set<string>();
  const matches: ConfusableName[] = [];

  const candidates = [...known].sort(
    (a, b) => byCodeUnit(canonicalName(a), canonicalName(b)) || byCodeUnit(a, b),
  );

  for (const candidate of candidates) {
    const canonical = canonicalName(candidate);
    if (canonical === self || seen.has(canonical)) continue;
    seen.add(canonical);

    const shared = [...new Set(nameTokens(candidate).filter((token) => mine.has(token)))].sort();
    if (shared.length === 0) continue;

    matches.push({ name: candidate, shared });
  }

  return matches.sort((a, b) => b.shared.length - a.shared.length || byCodeUnit(a.name, b.name));
}
