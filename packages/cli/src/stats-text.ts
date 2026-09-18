/**
 * What `asc stats` reads out of an entry -- ONE definition of "the text", and one of "the values".
 *
 * Three of `asc stats`'s modes are text instruments (`--cluster`, `--distinctive`, `--duplicates`)
 * and three are categorical ones (`--assoc`, `--correlate`, `--rules`). Each group needs the same
 * answer to "what part of an entry is the input", and the answer lives here rather than in the
 * command, so two modes cannot quietly read two different corpora and report incomparable numbers
 * about the same type.
 *
 * **THE PROSE SURFACE IS `evidence_text` PLUS EVERY PROPERTY DECLARED `text`. Not every property
 * that happens to hold a string.** This is the most consequential line in the file and it is a
 * measurement, not a preference. `docs/evidence/EV-20.md` fed a text instrument the string-valued
 * properties of `tool_denial` -- `tool_name`, `denial_kind`, `project`, all declared `string` and
 * all categorical -- and measured the result:
 *
 * ```
 * threshold  groups  pairsInGroups  falsePairs  falseMergeRate  largest
 * 0.40           2         157642      114131        0.723989      562
 * ```
 *
 * 562 of 564 entries collapsed into one group, 72% of its pairs wrong. A categorical value is a
 * label, and Jaccard or TF-IDF over a bag of three labels measures nothing but how many labels two
 * entries happen to share. The type system already draws this line -- `text` means prose and
 * `string` means a value -- so this reads the line the schema already drew instead of guessing from
 * the data.
 *
 * The cost is named rather than smoothed over: the starter `note` type declares its `text` property
 * as `string`, so `asc stats note --cluster` reads only `evidence_text` and not the note's body.
 * That is a modelling slip in the starter type and the remedy is to declare it `text`, not to
 * widen the rule here until the slip is invisible.
 *
 * **THE CATEGORICAL SURFACE IS EVERY PROPERTY DECLARED `string` OR `enum`**, which is the mirror of
 * the same rule. Numbers, timestamps, durations, refs and JSON are left out: a crosstab of a
 * timestamp against anything has one row per entry and a Cramér's V of 1, which is a definition
 * restated as a finding.
 *
 * **THE TOKENIZER IS THE DULLEST ONE AVAILABLE, and that is deliberate.** Lowercase, split on any
 * run of non-alphanumerics. No stemmer, no stopword list, no language assumption. This corpus is
 * half identifiers, bead ids, commit shas and command names; a stemmer trained on English would
 * mangle `entryIds` and `--prop`, and a stopword list is a claim about a language this text is only
 * half written in. `cluster.ts` removes the words every document shares by IDF instead, which is
 * measured from the corpus rather than asserted about it.
 */

import type { PropertySpec, TypeSpec } from '@ascend/core';
import type { RecordedEntry } from '@ascend/store';

/** One document for a text instrument. */
export interface TextDocument {
  readonly id: string;
  readonly tokens: readonly string[];
}

/** How much of a type's corpus a text instrument can actually see. */
export interface TextCoverage {
  /** Entries of the type. */
  readonly entries: number;
  /** Entries with at least one token on the prose surface. */
  readonly withText: number;
  /** The properties that were read, beside `evidence_text`. */
  readonly properties: readonly string[];
}

/** Lowercase, split on any run of non-alphanumerics. See the header for why it is this dull. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Properties declared `text`: the prose ones. */
export function proseProperties(spec: TypeSpec): readonly string[] {
  return spec.properties
    .filter((property: PropertySpec) => property.type === 'text')
    .map((property) => property.name);
}

/** Properties declared `timestamp`: the ones a time axis can be read from. */
export function timestampProperties(spec: TypeSpec): readonly string[] {
  return spec.properties
    .filter((property: PropertySpec) => property.type === 'timestamp')
    .map((property) => property.name);
}

/** Properties declared `string` or `enum`: the categorical ones. */
export function categoricalProperties(spec: TypeSpec): readonly string[] {
  return spec.properties
    .filter((property: PropertySpec) => property.type === 'string' || property.type === 'enum')
    .map((property) => property.name);
}

/** An entry's prose: `evidence_text`, then each `text` property, in declaration order. */
export function proseOf(entry: RecordedEntry, prose: readonly string[]): string {
  const parts: string[] = [];
  const evidence = entry.evidenceText;
  if (evidence !== null && evidence.trim().length > 0) parts.push(evidence.trim());
  for (const name of prose) {
    const value = entry.properties[name];
    if (typeof value === 'string' && value.trim().length > 0) parts.push(value.trim());
  }
  return parts.join('\n');
}

/**
 * The text corpus for a type, and the coverage that says how much of the type it is.
 *
 * Entries with no prose are LEFT OUT, and counted. They are not documents with nothing in them:
 * `neardup.ts` refuses to merge empty documents for the same reason, and a clustering handed 1,698
 * empty vectors would report one enormous cluster of silence as its largest finding. The count
 * travels with the corpus so the caller is told what fraction of the type the answer describes.
 */
export function textCorpus(
  entries: readonly RecordedEntry[],
  spec: TypeSpec,
): { readonly documents: readonly TextDocument[]; readonly coverage: TextCoverage } {
  const prose = proseProperties(spec);
  const documents: TextDocument[] = [];
  for (const entry of entries) {
    const tokens = tokenize(proseOf(entry, prose));
    if (tokens.length > 0) documents.push({ id: entry.id, tokens });
  }
  return {
    documents,
    coverage: { entries: entries.length, withText: documents.length, properties: prose },
  };
}

/**
 * An entry's categorical values as `name=value` items, for a transaction miner.
 *
 * The property NAME is carried into the item because `rules.ts` mines a flat set: without it,
 * `project=ascend` and `runner=ascend` would be one item, and a rule joining them would be a rule
 * about a coincidence of spelling.
 */
export function categoricalItems(entry: RecordedEntry, names: readonly string[]): string[] {
  const items: string[] = [];
  for (const name of names) {
    const value = entry.properties[name];
    if (typeof value === 'string' && value.length > 0) items.push(`${name}=${value}`);
  }
  return items;
}

/**
 * A property's column of values, with an entry that did not measure it carried as `null`.
 *
 * `null` rather than a skipped row, because `crosstab` needs both columns the same length and
 * aligned by entry -- and because "nobody looked" is a level worth seeing in a crosstab. Dropping
 * those rows would silently restrict every pair to the entries that measured BOTH properties, which
 * is a different population per pair and makes the ranking incomparable across pairs.
 */
export function valueColumn(
  entries: readonly RecordedEntry[],
  name: string,
): readonly (string | null)[] {
  return entries.map((entry) => {
    const value = entry.properties[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

/** The name of the entry's own recording time, usable wherever a `timestamp` property is. */
export const RECORDED_AT = 'recorded_at';

/**
 * A column of ISO timestamps for a time axis, with an entry that has none carried as `null`.
 *
 * `RECORDED_AT` reads the entry's own `recorded_at`; any other name reads a property declared
 * `timestamp`. Both spellings are here rather than in the caller because the choice between them is
 * the whole question `--at` exists to ask, and a command that read one of them inline would be
 * making that choice silently.
 *
 * **`recorded_at` is the WRONG axis for most of this store, and that is measured rather than
 * suspected.** 1,702 of 1,797 entries (94.7%) -- every `context_compaction`, `skill_activation`,
 * `tool_denial`, `user_correction` and `verification_run` -- share one `recorded_at` instant,
 * `2026-09-17T22:37:40.736Z`, because `asc ingest claude-code` derived them all in one run. Their
 * real clock is the `occurred_at` each of those five types declares. See `dogfood/0006`.
 */
export function timeColumn(
  entries: readonly RecordedEntry[],
  name: string,
): readonly (string | null)[] {
  if (name === RECORDED_AT) return entries.map((entry) => entry.recordedAt);
  return entries.map((entry) => {
    const value = entry.properties[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}
