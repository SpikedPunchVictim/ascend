/**
 * Parsing the `asc annotate` operands: `--rule "<label>=<kind>:<query>"` and `--ids "<label>=<id>,<id>"`.
 *
 * ```bash
 * asc annotate --scheme review --rule "bug=sql: evidence_text LIKE '%crash%'"
 * asc annotate --scheme review --rule "docs=fts: install" --rule "bug=sql: …"
 * asc annotate --scheme hand --ids "bug=e1,e7,e9" --ids "docs=e4"
 * ```
 *
 * **Why the label is on the operand.** `ARCHITECTURE.md`'s sketch is `--rule "<sql|fts>"`, which says
 * how a rule is written but not which label it assigns -- and a scheme's vocabulary has to come from
 * somewhere. With one label per invocation, a two-label scheme is two runs, and because a scheme's
 * version is a function of its shape, the second run mints version 2 whose annotations live under a
 * vocabulary version 1's do not share. One invocation has to be able to declare the whole scheme, so
 * a rule carries its own label and `--rule` is repeatable.
 *
 * **The same argument applies to `--ids`, and for a while it did not get it.** One `--ids` list
 * under one `--label` is one pass with one label in it; the second label is a second pass. A scheme
 * keeps every pass, but `asc kappa` reads a rater's LATEST one -- so a hand rater could never carry
 * two classes, and a classification the model proposed could not be measured against a hand-labelled
 * sample across more than one class. That is `asc-3o9`'s whole use case, so the label belongs on the
 * operand here too: `--ids` is repeatable and each occurrence names the label it assigns.
 *
 * **The separator is the first `=`, and that is the house idiom's.** `asc record` already spells a
 * name-value pair `--prop=<name>=<value>` and splits on the FIRST `=` (`entry-document.ts`), so both
 * operands split the same way: the name is the label, and everything after it is the rule body or
 * the id list. `--rule` then splits its remainder on the first `:` rather than the last, which is
 * what lets a query contain colons (`evidence_text LIKE 'a:b'` parses; a label cannot contain `=`,
 * and does not need to).
 *
 * **The refusals are here rather than left to the store, and the reason is which text they quote.**
 * The store's checks guard a spec arriving as JSON from anywhere; these quote the argv fragment the
 * caller typed, because that is the text they have to retype. A malformed `--rule` is a caller who
 * typed the wrong thing, so it is a usage error (exit 2); the store's backstop stays a refusal
 * (exit 1) for the case where the command line is fine and the world is not.
 */

import type { SchemeRule, SchemeRuleKind } from '@ascend/store';
import { usageError } from './errors.js';

/** The rule kinds, in the words `--rule` accepts. Mirrors the store's union, which is the type. */
export const RULE_KINDS: readonly SchemeRuleKind[] = ['sql', 'fts'];

/** What the `--rule` and `--label` flags came to: one vocabulary and one ordered rule list. */
export interface ParsedRules {
  readonly labels: readonly string[];
  readonly rules: readonly SchemeRule[];
}

/** What the `--ids` flags came to: a vocabulary, and one `[entry, label]` pair per id named. */
export interface ParsedAssignments {
  readonly labels: readonly string[];
  readonly pairs: readonly (readonly [string, string])[];
}

const EXAMPLE = "--rule=\"bug=sql: evidence_text LIKE '%crash%''";
const IDS_EXAMPLE = '--ids="bug=e1,e7,e9"';

/**
 * One `--rule` occurrence as a rule, or a usage error naming what is wrong with it.
 *
 * `where` is the whole flag text, quoted back in every message, so a caller with four `--rule`s is
 * told which one is broken instead of being left to count colons.
 */
function parseRule(raw: string): SchemeRule {
  const equals = raw.indexOf('=');
  if (equals <= 0) {
    throw usageError(
      `--rule must be '<label>=<kind>:<query>', but ${JSON.stringify(raw)} has no label and kind ` +
        `separated by '='. Example: ${EXAMPLE}.`,
    );
  }

  const label = raw.slice(0, equals).trim();
  const rest = raw.slice(equals + 1);
  const colon = rest.indexOf(':');

  if (colon < 0) {
    throw usageError(
      `--rule must be '<label>=<kind>:<query>', but ${JSON.stringify(raw)} names no kind -- there ` +
        `is no ':' after the '='. Example: ${EXAMPLE}.`,
    );
  }

  const kind = rest.slice(0, colon).trim();
  // Everything after the first ':', so a query is free to contain colons of its own.
  const query = rest.slice(colon + 1).trim();

  if (!RULE_KINDS.includes(kind as SchemeRuleKind)) {
    throw usageError(
      `--rule names the kind ${JSON.stringify(kind)}, which is not one of ` +
        `${RULE_KINDS.map((known) => `'${known}'`).join(' or ')}. 'sql' is a predicate over an ` +
        `entry, 'fts' is a text query over its evidence text. In ${JSON.stringify(raw)}.`,
    );
  }
  if (query === '') {
    throw usageError(
      `--rule names no query: ${JSON.stringify(raw)} ends after the kind. An empty rule matches ` +
        `nothing, which reads as a rule that ran and found nothing rather than as one that was ` +
        `never written. Example: ${EXAMPLE}.`,
    );
  }

  return { label, kind: kind as SchemeRuleKind, query };
}

/**
 * Every `--rule` as a rule, plus every `--label` as a vocabulary entry no rule assigns.
 *
 * **Duplicate rules are refused rather than deduplicated.** Two identical rules are not one rule
 * written twice: they are one rule and one piece of dead weight, because "first match wins" makes
 * the second unreachable -- it can never assign a label the first did not already assign. Storing
 * it would also put the duplicate in the scheme's hash, so re-running the command would mint a
 * version for a typo. Compared on the PARSED values, so `--rule " bug = sql : x "` is the same rule
 * as `--rule "bug=sql: x"` and is caught.
 */
export function parseRules(raw: readonly string[], declared: readonly string[]): ParsedRules {
  const rules: SchemeRule[] = [];
  const seen = new Set<string>();

  for (const text of raw) {
    const rule = parseRule(text);
    const identity = JSON.stringify([rule.label, rule.kind, rule.query]);

    if (seen.has(identity)) {
      throw usageError(
        `--rule ${JSON.stringify(text)} is the same rule as an earlier one, so it could never ` +
          `assign a label: rules are applied in order and the first match wins, which leaves the ` +
          `second matching exactly what the first already matched. Drop one of them.`,
      );
    }
    seen.add(identity);
    rules.push(rule);
  }

  // A label named by `--label` and by a rule is one label: the vocabulary is a set. Sorted and
  // deduplicated here only so the value reads the same way twice -- `registerScheme` normalizes it
  // again, and the version decision is made against the normalized shape either way.
  const labels = [...new Set([...rules.map((rule) => rule.label), ...declared])].sort();

  return { labels, rules };
}

/** One `--ids` occurrence split into its label and its ids, or a usage error naming what is wrong. */
function parseAssignment(raw: string): { label: string; ids: readonly string[] } {
  const equals = raw.indexOf('=');
  if (equals <= 0) {
    throw usageError(
      `--ids must be '<label>=<id>,<id>', but ${JSON.stringify(raw)} has no label and id list ` +
        `separated by '='. Example: ${IDS_EXAMPLE}.`,
    );
  }

  const label = raw.slice(0, equals).trim();
  const body = raw.slice(equals + 1).trim();

  if (label === '') {
    throw usageError(
      `--ids names an empty label in ${JSON.stringify(raw)}. An entry has to be given a label, and ` +
        `an empty string is a missing value wearing a value's clothes -- the unclassified remainder ` +
        `is what says an entry has no label. Example: ${IDS_EXAMPLE}.`,
    );
  }
  if (body === '') {
    throw usageError(
      `--ids names the label '${label}' and no entry in ${JSON.stringify(raw)}. Drop the operand, ` +
        `or use --label ${label} to declare '${label}' in the scheme's vocabulary without ` +
        `assigning it to anything.`,
    );
  }

  const ids = body.split(',').map((id) => id.trim());

  // An empty element is refused rather than dropped. `--ids "bug=a,,b"` is what an unset shell
  // variable expands to (`--ids "bug=a,$EMPTY,b"`), and dropping it would annotate two entries
  // while reporting that it annotated the three the caller wrote.
  if (ids.some((id) => id === '')) {
    throw usageError(
      `--ids must be a comma-separated list of entry ids with no empty element, and ` +
        `${JSON.stringify(raw)} has one. An empty id is what an unset shell variable expands to, ` +
        `and skipping it would annotate fewer entries than the list names.`,
    );
  }

  return { label, ids };
}

/**
 * Every `--ids` occurrence as a label with the entries it names, in the order given.
 *
 * **Pairs rather than a map, so a repeated entry survives to be refused by name.** Two operands
 * naming one entry (`--ids "bug=e1" --ids "docs=e1"`) is a contradiction rather than a
 * last-one-wins, and the caller has to be told which entry to look at. A map here would lose the
 * first label silently, which is the outcome `recordAnnotations` refuses outright for a pass written
 * through the API.
 *
 * **The duplicate is caught by the command, not left to the store, so that `--dry-run` agrees with
 * the run it previews.** The store's refusal is the backstop and still fires for a pass written
 * through the API -- but a dry run writes nothing, so a check that only ran at write time would let
 * a preview report a census for a pass the real run then refuses. A preview that succeeds where the
 * run fails is the failure mode `--dry-run` exists to prevent.
 */
export function parseAssignments(raw: readonly string[]): ParsedAssignments {
  const pairs: [string, string][] = [];

  for (const text of raw) {
    const { label, ids } = parseAssignment(text);
    for (const id of ids) pairs.push([id, label]);
  }

  // Sorted and deduplicated for the same reason as `parseRules`: the vocabulary is a set, and the
  // value should read the same way twice. `registerScheme` normalizes it again.
  return { labels: [...new Set(pairs.map(([, label]) => label))].sort(), pairs };
}
