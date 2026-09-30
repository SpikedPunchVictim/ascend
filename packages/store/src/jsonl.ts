/**
 * The JSONL record stream's whole format: the four line kinds, their canonical key order,
 * serialization, and the parsers that read them back.
 *
 * **Why this is here and not in the CLI, where it was written.** These are the bytes the store
 * writes to disk, and the bytes it must read back. Until `asc-i5tj` the only thing that produced
 * them was `asc export`, so they lived in `packages/cli/src/corpus.ts` -- and the CLI is not
 * allowed to be the definition of a format the store owns, because the store cannot reach back for
 * it: `align` forbids `store -> cli` (`arch.no-cycles`, plus the rules that keep the CLI the one
 * interface). The alternative was to re-implement the line shapes here, which is the second-format
 * defect `asc-i5tj` names -- two definitions that agree on the day they are written and drift on
 * the first field anyone adds.
 *
 * **The OUTPUT half moved first, then the reader followed.** `documentFromRow`, `orderedLine` and
 * `serializeCorpus` turned a TRUSTED row into bytes and moved when the store became a writer;
 * `parseCorpus`, `verifyTypeLine`, `verifySchemeLine` and the per-line validators followed, because
 * the store's own read layer parses the same lines and could not reach into the CLI for them. The
 * parsers read text a human or a model may have written or hand-edited and refuse unknown fields;
 * they threw the CLI's `refusal` only because they lived there, and `refusal` is exactly
 * `new Error(message)` (`errors.ts`), so they throw a plain `Error` here with byte-identical
 * messages. `ParsedLine` came with them -- it is the coordinate a parse failure is reported at.
 *
 * `packages/cli/src/corpus.ts` imports all of it back and re-exports it, so every existing
 * importer (`export.ts`, `import.ts`, `redact.ts`, `secrets.ts`) keeps working unchanged -- the
 * same move `document.ts` and `properties.ts` document.
 */

import {
  RESERVED_SCHEME,
  schemeHash,
  type AnnotationRow,
  type SchemeRule,
  type SchemeRuleKind,
  type SchemeSpec,
  type SchemeSummary,
} from './annotations.js';
import { documentFromRow, orderedDocument, parseDocument, type TypeDocument } from './document.js';
import { describeValue, fieldError, isJsonObject } from './json-fields.js';
import { ENTRY_SOURCES, type EntrySource, type RecordedEntry } from './recorder.js';
import { specHash } from './registry.js';
import type { TypeVersionRow } from './registry.js';

/** A type version, as a line. `kind` first so a reader can dispatch on the line's first bytes. */
export interface TypeLine {
  readonly kind: 'type';
  readonly document: TypeDocument;
}

/**
 * An entry, as a line: every column of the row, spelled the way the store spells it.
 *
 * Snake case because these are column names and the file is a dump of columns; `import` maps them
 * back to `RecordContext`'s camelCase field by field, which is where the difference belongs.
 */
export interface EntryLine {
  readonly kind: 'entry';
  readonly id: string;
  readonly type_name: string;
  readonly type_version: number;
  readonly type_hash: string;
  readonly recorded_at: string;
  readonly source: EntrySource;
  readonly run_id: string | null;
  readonly workflow: string | null;
  readonly actor: string | null;
  readonly cwd: string | null;
  readonly repo: string | null;
  readonly git_sha: string | null;
  readonly branch: string | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly na: readonly string[];
  readonly evidence_text: string | null;
  readonly ascend_version: string;
  readonly schema_version: number;
}

/**
 * A scheme version, as a line. Mirrors `TypeLine`: `kind` first, and the identity-bearing hash
 * carried alongside the shape rather than trusted to be recomputable without it.
 *
 * `annotation_schemes` has no hash column of its own -- `schemeHash` is computed on demand, both
 * at registration and here at export -- so `scheme_hash` is not a stored value being forwarded,
 * it is this line's own claim about the `spec` sitting next to it, exactly as `verifySchemeLine`
 * checks it.
 */
export interface SchemeLine {
  readonly kind: 'scheme';
  readonly name: string;
  readonly version: number;
  readonly created_at: string;
  readonly spec: SchemeSpec;
  readonly scheme_hash: string;
}

/**
 * One stored annotation, as a line: every column of the row, snake_case, for the reason
 * `EntryLine`'s doc gives -- these are column names and the file is a dump of columns.
 *
 * `scheme` and `scheme_version` travel on every row rather than being left to the group the row
 * sits in, because a line is the unit `parseCorpus` reports a coordinate for and the unit
 * `ENTRY_KEYS`-style validation checks in isolation -- a row that depended on lines around it to
 * mean something would not be a self-describing line. `import` still restores a whole PASS at
 * once (see the corpus module doc); these two fields are what it groups the stream's annotation
 * lines BY, not a value it derives after grouping.
 *
 * `value`, `confidence`, `note` and `created_by` are all nullable columns and none of them is
 * optional at the type level, the same choice `EntryLine` makes for `run_id`, `workflow` and the
 * rest: an absent key and an explicit `null` are treated as the same "not recorded" on the way in
 * (`optionalText`), and the line always carries the key on the way out (`orderedLine`).
 */
export interface AnnotationLine {
  readonly kind: 'annotation';
  readonly id: string;
  readonly entry_id: string;
  readonly scheme: string;
  readonly scheme_version: number;
  readonly label: string;
  /**
   * Any JSON value the annotation carried. **ABSENT when it carried none, never `null`.**
   *
   * `value_json` is a nullable JSON column, so `null` is a value an annotation can legitimately
   * hold -- `recordAnnotations` writes the four bytes `null` for it and reads it back as `null`,
   * while an annotation with no value at all reads back as `undefined` (`annotations.ts`, where
   * the row maps `value_json === null` to `undefined`). Spelling absence as `null` HERE would
   * merge those two into one line and the restore could not tell them apart again: this module's
   * own header states the rule -- omit absent values, never write a sentinel -- and ARCHITECTURE.md
   * says why a corpus that loses the distinction never gets it back.
   *
   * Measured 2026-09-19 on this project's store: 747 of 747 annotations have `value_json IS NULL`
   * and none holds a JSON `null`, and `asc annotate` has no surface that writes a value at all. So
   * this is a distinction nothing exercises today -- which is the reason to get it right now, while
   * the only cost is choosing the spelling, rather than after a corpus has been written that needs
   * it.
   */
  readonly value?: unknown;
  readonly confidence: number | null;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

export type CorpusLine = TypeLine | EntryLine | SchemeLine | AnnotationLine;

/** One registered version as a line. Prose rides along, exactly as it does in a type document. */
export function typeLine(row: TypeVersionRow): TypeLine {
  return { kind: 'type', document: documentFromRow(row) };
}

/** One recorded entry as a line. */
export function entryLine(entry: RecordedEntry): EntryLine {
  return {
    kind: 'entry',
    id: entry.id,
    type_name: entry.typeName,
    type_version: entry.typeVersion,
    type_hash: entry.typeHash,
    recorded_at: entry.recordedAt,
    source: entry.source,
    run_id: entry.runId,
    workflow: entry.workflow,
    actor: entry.actor,
    cwd: entry.cwd,
    repo: entry.repo,
    git_sha: entry.gitSha,
    branch: entry.branch,
    properties: entry.properties,
    na: entry.na,
    evidence_text: entry.evidenceText,
    ascend_version: entry.ascendVersion,
    schema_version: entry.schemaVersion,
  };
}

/**
 * One registered scheme version as a line.
 *
 * `scheme_hash` is computed here, from the spec this same call is about to carry, rather than
 * read from a stored column -- `annotation_schemes` has none. That makes the hash trivially
 * correct at export time; the check it exists for (`verifySchemeLine`) matters on the way back
 * in, against a file that may have been hand-edited since.
 */
export function schemeLine(summary: SchemeSummary): SchemeLine {
  return {
    kind: 'scheme',
    name: summary.name,
    version: summary.version,
    created_at: summary.createdAt,
    spec: summary.spec,
    scheme_hash: schemeHash(summary.spec),
  };
}

/**
 * One stored annotation as a line.
 *
 * `scheme` and `schemeVersion` are the caller's, not the row's -- `AnnotationRow` is read through
 * `annotationRows`, which is always called for one `(scheme, version)` pair and so never returns
 * either as a column. Passing them in here is what keeps that one row self-describing once it is a
 * line of its own (see `AnnotationLine`'s doc).
 */
export function annotationLine(
  row: AnnotationRow,
  scheme: string,
  schemeVersion: number,
): AnnotationLine {
  return {
    kind: 'annotation',
    id: row.id,
    entry_id: row.entryId,
    scheme,
    scheme_version: schemeVersion,
    label: row.label,
    // Omitted, not nulled -- see `AnnotationLine.value`. `JSON.stringify` drops an absent key, so
    // this is also what keeps the serialized line free of a `"value":null` that would read back as
    // a value the annotation never had.
    ...(row.value === undefined ? {} : { value: row.value }),
    confidence: row.confidence,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

/**
 * A line as a plain object, with a fixed key order.
 *
 * Fixed so that exporting the same corpus twice produces identical bytes, which is what makes a
 * diff of two exports mean something -- the same argument `document.ts` makes for its own ordering,
 * and the reason a restored corpus can be compared with the original at all.
 */
export function orderedLine(line: CorpusLine): Record<string, unknown> {
  if (line.kind === 'type') return { kind: 'type', ...orderedDocument(line.document) };

  if (line.kind === 'entry') {
    return {
      kind: 'entry',
      id: line.id,
      type_name: line.type_name,
      type_version: line.type_version,
      type_hash: line.type_hash,
      recorded_at: line.recorded_at,
      source: line.source,
      run_id: line.run_id,
      workflow: line.workflow,
      actor: line.actor,
      cwd: line.cwd,
      repo: line.repo,
      git_sha: line.git_sha,
      branch: line.branch,
      properties: line.properties,
      na: line.na,
      evidence_text: line.evidence_text,
      ascend_version: line.ascend_version,
      schema_version: line.schema_version,
    };
  }

  if (line.kind === 'scheme') {
    return {
      kind: 'scheme',
      name: line.name,
      version: line.version,
      created_at: line.created_at,
      spec: orderedSpec(line.spec),
      scheme_hash: line.scheme_hash,
    };
  }

  return {
    kind: 'annotation',
    id: line.id,
    entry_id: line.entry_id,
    scheme: line.scheme,
    scheme_version: line.scheme_version,
    label: line.label,
    ...(line.value === undefined ? {} : { value: line.value }),
    confidence: line.confidence,
    note: line.note,
    created_by: line.created_by,
    created_at: line.created_at,
  };
}

/**
 * A scheme's spec in canonical order, its NESTED rules included.
 *
 * **The nesting is why this exists, and it was found by a migration refusing to run.** `orderedLine`
 * fixes the order of a line's own fields, and for every other kind the fields it passes through come
 * from `JSON.parse` on both sides of a round trip -- so the writer's spelling and the reader's agree
 * on nested order by construction. A scheme's `spec` is the exception: the store hands back
 * `spec_json` exactly as it was registered, while `parseSchemeRule` REBUILDS each rule from named
 * fields in its own order (`{ label, kind, query }`, the order `SCHEME_RULE_KEYS` lists them in). Two
 * spellings of one scheme therefore serialized differently, which is not a cosmetic difference here:
 * `migrateStoreToTree` compares the store's lines against the tree's as canonical text.
 *
 * Measured on this repository's own store: 10,386 line(s) written, 10,386 read, and
 * *"3 missing and 3 that should not be there"* -- the 3 schemes that carry a rule (`by_kind`,
 * `layer`, `rule-denial`), the 4 rule-less ones agreeing exactly. The migration refused and archived
 * nothing, which is the right answer from a guard and a dead end for a cutover. See `dogfood/0040`.
 *
 * So the rule order is pinned HERE, in the one definition of a line's canonical bytes, rather than
 * left to whatever each side happens to build. `{ kind, label, query }` is the order the store's own
 * `spec_json` already holds, so **no bytes on disk change**: the reader is brought to the writer and
 * not the other way round. `labels` needs no ordering because it is an array of strings.
 */
function orderedSpec(spec: SchemeSpec): Record<string, unknown> {
  return {
    labels: spec.labels,
    rules: spec.rules.map((rule) => ({ kind: rule.kind, label: rule.label, query: rule.query })),
  };
}

/**
 * The corpus as a JSONL document: one line per line, and NO trailing newline.
 *
 * The terminator is the writer's job, which is the convention every renderer in the CLI follows --
 * `types export`'s default output is asserted as `'[]\n'` in its suite, so the renderer produces
 * `'[]'` and `this.log` supplies the newline. Matching it is what makes the output a file with
 * exactly one newline per line.
 *
 * **This was got wrong first, in a way worth recording.** This function wrote its own trailing
 * newline *and* the command handed the result to `this.log`, so every export ended with a blank
 * line -- measured: a 42-line corpus produced `wc -l` 43. An empty corpus was worse, because
 * `log('')` writes a newline rather than nothing, so the stream that this function renders as zero
 * bytes reached stdout as one blank line: precisely the "blank line waiting for whoever reads it
 * next" the corpus module's header is about. The command now returns this through `emitText`,
 * which skips an empty rendering, and this function writes no terminator of its own.
 *
 * The round trip never depended on either half -- `parseCorpus` skips blank lines, and both sides
 * of the trip run this same code -- which is exactly why the defect survived the byte-identical
 * comparison in `corpus.test.ts` and had to be found by reading `wc -l`.
 */
export function serializeCorpus(lines: readonly CorpusLine[]): string {
  return lines.map((line) => JSON.stringify(orderedLine(line))).join('\n');
}

/**
 * A line and where it came from.
 *
 * The coordinate travels WITH the line rather than being recomputed by each caller, and that is a
 * fix rather than a tidy-up. `import` used to number its entries by their index in the array it had
 * already filtered them into, so an entry on line 6 of a six-line stream was reported as `line 1` --
 * measured against the real binary. A coordinate that is wrong is worse than none: the one thing
 * the line number is for is being jumped to.
 */
export interface ParsedLine {
  /** `source` plus this line's 1-based number in it. The coordinate every message uses. */
  readonly where: string;
  readonly line: CorpusLine;
}

const ENTRY_KEYS = [
  'kind',
  'id',
  'type_name',
  'type_version',
  'type_hash',
  'recorded_at',
  'source',
  'run_id',
  'workflow',
  'actor',
  'cwd',
  'repo',
  'git_sha',
  'branch',
  'properties',
  'na',
  'evidence_text',
  'ascend_version',
  'schema_version',
] as const;

/** A nullable string column: absent and `null` mean the same thing, and both mean "not recorded". */
function optionalText(where: string, raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fieldError(where, key, 'a string or null', value);
  return value;
}

function requiredText(where: string, raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') fieldError(where, key, 'a string', value);
  return value;
}

function requiredWholeNumber(where: string, raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fieldError(where, key, 'a whole number', value);
  }
  return value;
}

/** A nullable number column, the same "absent and `null` mean the same thing" rule as `optionalText`. */
function optionalNumber(where: string, raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') fieldError(where, key, 'a number or null', value);
  return value;
}

/**
 * A corpus line without its `kind`, for the parser that has never heard of one.
 *
 * A copy rather than a destructuring rest. `const { kind: _kind, ...document } = parsed` is the
 * obvious spelling and it was this file's first, but the discarded binding is an unused variable
 * under this repo's lint config, which sets no `argsIgnorePattern` -- and the alternative is an
 * `eslint-disable`, of which the repository has exactly zero and means to keep zero.
 */
function withoutKind(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'kind'));
}

/** One entry line, with every field checked. `where` is the line's coordinate in its source. */
function parseEntryLine(where: string, raw: Record<string, unknown>): EntryLine {
  for (const key of Object.keys(raw)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where} has no such field '${key}'. The fields are: ${ENTRY_KEYS.join(', ')}. ` +
          `Fields are not ignored when unrecognised, so that a misspelt one cannot be dropped in silence.`,
      );
    }
  }

  const source = requiredText(where, raw, 'source');
  if (!(ENTRY_SOURCES as readonly string[]).includes(source)) {
    throw new Error(
      `${where}.source is ${describeValue(source)}, but an entry's source must be one of ` +
        `${ENTRY_SOURCES.join(', ')}.`,
    );
  }

  const properties = raw['properties'];
  if (properties !== undefined && !isJsonObject(properties)) {
    fieldError(where, 'properties', 'a JSON object of property names to values', properties);
  }

  const na = raw['na'];
  if (na !== undefined) {
    if (!Array.isArray(na) || na.some((name) => typeof name !== 'string')) {
      fieldError(where, 'na', 'an array of property names', na);
    }
  }

  const evidence = optionalText(where, raw, 'evidence_text');

  return {
    kind: 'entry',
    id: requiredText(where, raw, 'id'),
    type_name: requiredText(where, raw, 'type_name'),
    type_version: requiredWholeNumber(where, raw, 'type_version'),
    type_hash: requiredText(where, raw, 'type_hash'),
    recorded_at: requiredText(where, raw, 'recorded_at'),
    source: source as EntrySource,
    run_id: optionalText(where, raw, 'run_id'),
    workflow: optionalText(where, raw, 'workflow'),
    actor: optionalText(where, raw, 'actor'),
    cwd: optionalText(where, raw, 'cwd'),
    repo: optionalText(where, raw, 'repo'),
    git_sha: optionalText(where, raw, 'git_sha'),
    branch: optionalText(where, raw, 'branch'),
    properties: properties ?? {},
    na: (na ?? []) as string[],
    evidence_text: evidence,
    ascend_version: requiredText(where, raw, 'ascend_version'),
    schema_version: requiredWholeNumber(where, raw, 'schema_version'),
  };
}

const SCHEME_KEYS = ['kind', 'name', 'version', 'created_at', 'spec', 'scheme_hash'] as const;
const SCHEME_SPEC_KEYS = ['labels', 'rules'] as const;
const SCHEME_RULE_KEYS = ['label', 'kind', 'query'] as const;
const SCHEME_RULE_KINDS: readonly SchemeRuleKind[] = ['sql', 'fts'];

/**
 * One rule of a scheme's spec, checked only down to the shape `SchemeRule` requires.
 *
 * The deeper checks -- an empty query, a label outside the scheme's own vocabulary, an `fts` query
 * with no indexable term -- are `normalizeSpec`'s (`annotations.ts`), run again by `registerScheme`
 * on the way in. Duplicating them here would be a second place those rules could drift from the
 * store's; this function's job is only to make sure `registerScheme` receives the shape it expects
 * rather than `undefined`s from a field that was missing.
 */
function parseSchemeRule(where: string, index: number, raw: unknown): SchemeRule {
  const field = `spec.rules[${String(index)}]`;
  if (!isJsonObject(raw)) fieldError(where, field, 'an object', raw);

  for (const key of Object.keys(raw)) {
    if (!(SCHEME_RULE_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where}.${field} has no such field '${key}'. The fields are: ${SCHEME_RULE_KEYS.join(', ')}.`,
      );
    }
  }

  const label = raw['label'];
  if (typeof label !== 'string') fieldError(where, `${field}.label`, 'a string', label);

  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(SCHEME_RULE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `${where}.${field}.kind must be one of ${SCHEME_RULE_KINDS.join(', ')}, but it is ` +
        `${describeValue(kind)}.`,
    );
  }

  const query = raw['query'];
  if (typeof query !== 'string') fieldError(where, `${field}.query`, 'a string', query);

  return { label, kind: kind as SchemeRuleKind, query };
}

/** A scheme's `spec` field: `labels` and `rules`, checked down to the shape `SchemeSpec` requires. */
function parseSchemeSpec(where: string, raw: unknown): SchemeSpec {
  if (!isJsonObject(raw)) fieldError(where, 'spec', 'an object', raw);

  for (const key of Object.keys(raw)) {
    if (!(SCHEME_SPEC_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where}.spec has no such field '${key}'. The fields are: ${SCHEME_SPEC_KEYS.join(', ')}.`,
      );
    }
  }

  const labels = raw['labels'];
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    fieldError(where, 'spec.labels', 'an array of strings', labels);
  }

  const rules = raw['rules'];
  if (!Array.isArray(rules)) fieldError(where, 'spec.rules', 'an array', rules);

  return {
    labels: labels as string[],
    rules: rules.map((rule, index) => parseSchemeRule(where, index, rule)),
  };
}

/** One scheme version, with every field checked. `where` is the line's coordinate in its source. */
function parseSchemeLine(where: string, raw: Record<string, unknown>): SchemeLine {
  for (const key of Object.keys(raw)) {
    if (!(SCHEME_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where} has no such field '${key}'. The fields are: ${SCHEME_KEYS.join(', ')}. ` +
          `Fields are not ignored when unrecognised, so that a misspelt one cannot be dropped in silence.`,
      );
    }
  }

  return {
    kind: 'scheme',
    name: requiredText(where, raw, 'name'),
    version: requiredWholeNumber(where, raw, 'version'),
    created_at: requiredText(where, raw, 'created_at'),
    spec: parseSchemeSpec(where, raw['spec']),
    scheme_hash: requiredText(where, raw, 'scheme_hash'),
  };
}

const ANNOTATION_KEYS = [
  'kind',
  'id',
  'entry_id',
  'scheme',
  'scheme_version',
  'label',
  'value',
  'confidence',
  'note',
  'created_by',
  'created_at',
] as const;

/** One annotation, with every field checked. `where` is the line's coordinate in its source. */
function parseAnnotationLine(where: string, raw: Record<string, unknown>): AnnotationLine {
  for (const key of Object.keys(raw)) {
    if (!(ANNOTATION_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where} has no such field '${key}'. The fields are: ${ANNOTATION_KEYS.join(', ')}. ` +
          `Fields are not ignored when unrecognised, so that a misspelt one cannot be dropped in silence.`,
      );
    }
  }

  // Any JSON value is legal here -- `AnnotationInput.value` in the store is untyped for the same
  // reason -- and a value that arrived through `JSON.parse` cannot hold anything `canonicalJson`
  // would refuse (`undefined`, a function, a symbol), so there is nothing further to check.
  const value = raw['value'];

  return {
    kind: 'annotation',
    id: requiredText(where, raw, 'id'),
    entry_id: requiredText(where, raw, 'entry_id'),
    scheme: requiredText(where, raw, 'scheme'),
    scheme_version: requiredWholeNumber(where, raw, 'scheme_version'),
    label: requiredText(where, raw, 'label'),
    // `in` rather than `!== undefined`: JSON cannot express `undefined`, so a present key is a
    // present value even when that value is `null`, and that is exactly the pair being kept apart.
    ...('value' in raw ? { value } : {}),
    confidence: optionalNumber(where, raw, 'confidence'),
    note: optionalText(where, raw, 'note'),
    created_by: optionalText(where, raw, 'created_by'),
    created_at: requiredText(where, raw, 'created_at'),
  };
}

/**
 * An invalidation states a reason, and this is the one gate that can hold that for every writer.
 *
 * `asc-4wx6`. `recordInvalidation` (`annotations.ts`) refuses a reason that is empty or all
 * whitespace, and `INVALIDATION_SCHEME_SPEC` gives the scheme no rules, so that refusal is the only
 * thing standing between a strike and a bare label. It is one writer of two. `asc import` restores
 * the reserved scheme through `recordAnnotations`, whose only note gate is the EMPTY STRING --
 * so an ABSENT reason became SQL NULL and a whitespace-only one was stored verbatim, both with
 * `asc import` exiting 0, and `listInvalidations` then cast that column to `string` and read back a
 * `null` its own type said was impossible.
 *
 * **Refused here rather than in `recordAnnotations`, because the parser is the door every path
 * already goes through.** `asc import` parses the file; `asc index build` parses the tree; a
 * hand-edit is read by the next one of either. One rule, all three writers, and no second place to
 * teach. `recordAnnotations` is also the wrong shape for it: a note is required for exactly one
 * scheme, and that function is general over all of them -- its caller passing a scheme would make
 * the requirement a parameter, and a parameter can be passed wrongly. This sits beside the `type`
 * branch's version refusal above, which is the same shape for the same reason: a line a tree written
 * earlier cannot satisfy, refused at the one place all readers share.
 *
 * **The message names a HAND EDIT, because nothing automated can repair this.** A version can be
 * assigned from line order, which is why that refusal names `asc store rewrite` -- but a missing
 * reason is not reconstructible from anything in the tree, and `asc store rewrite` inherits this
 * refusal (it reads through this same parser with only the version rule relaxed), so it can never
 * get past the line to fix it. Stamping a placeholder reason on would be a missing value wearing a
 * value's clothes, which is the exact thing `INVALIDATION_SCHEME_SPEC`'s empty rule set refuses. The
 * only honest repair is a person reading the entry and saying why it stopped counting.
 */
function requireInvalidationReason(where: string, line: AnnotationLine): void {
  if (line.scheme !== RESERVED_SCHEME) return;
  // `optionalText` collapses an absent key and a JSON `null` to the same `null`, so one condition
  // covers both shapes an export can carry. Trimming matches `recordInvalidation`'s own test, so the
  // parser and the writer agree on what "a reason" means rather than each having a definition.
  if (line.note !== null && line.note.trim() !== '') return;

  throw new Error(
    `${where} is an '${RESERVED_SCHEME}' annotation with no reason. Invalidation is the store's ` +
      `only durable claim about why an entry stopped counting, so a strike whose reason is absent ` +
      `(or only whitespace) is a silent, unexplained demotion -- the thing the scheme exists to ` +
      `prevent. No automated pass can supply it: there is nothing in the tree a missing reason ` +
      `could be reconstructed from, and \`asc store rewrite\` reads through this same refusal, so ` +
      `the line has to be repaired by hand. Give the annotation a 'note' saying why the entry ` +
      `stopped counting, or remove the line and re-record the strike with \`asc invalidate\` so the ` +
      `reason is taken from the person who knows it.`,
  );
}

/**
 * Parse a corpus stream.
 *
 * Blank lines are skipped rather than refused: a file that ends with a newline has one, and a
 * caller who appended two exports has one between them. Any other line must parse -- a stream is
 * read up to the damage, and silently skipping a line that does not parse would restore a corpus
 * that is short by exactly the entries nobody noticed.
 *
 * The line NUMBER is the coordinate in every message. It is the one a caller can act on: an editor
 * jumps to it, and `sed -n '42p'` shows the line that failed, neither of which a document index
 * gives. It is counted over the text as it was SPLIT -- blank lines included -- so it is the number
 * the caller's editor shows, and it is handed back with the line rather than left for a caller to
 * reconstruct from an array it has filtered (`ParsedLine`).
 */
/**
 * How strict the corpus parser is about a rule a tree written earlier cannot satisfy.
 *
 * Exactly one rule, and exactly one caller: `rewriteTree` (`rewrite.ts`) upgrades a tree written
 * before a type line carried its own `version`, and it has to READ such a tree to do it. The
 * alternative was a second, hand-written parser in the rewrite, which is a second answer to "is
 * this line valid" -- the thing this file exists to prevent. So the parser stays the only parser and
 * the one difference is named here, at the one call site that asks for it.
 *
 * `readRecordTree` passes nothing, so every ordinary reader is strict.
 */
export interface CorpusParseOptions {
  /**
   * Read a `type` line that states no `version`.
   *
   * A tree written before `asc-i5tj.6` holds those, and they cannot be refused by a reader whose
   * whole job is to upgrade them. Nothing else is relaxed: the document still goes through
   * `parseDocument`'s full key allowlist and validation.
   */
  readonly allowVersionlessTypeLines?: boolean;
}

export function parseCorpus(
  text: string,
  source: string,
  options: CorpusParseOptions = {},
): readonly ParsedLine[] {
  const lines: ParsedLine[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    const where = `${source} line ${String(index + 1)}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(
        `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    if (!isJsonObject(parsed)) {
      throw new Error(`${where} must be a JSON object, but it is ${describeValue(parsed)}.`);
    }

    const kind = parsed['kind'];
    if (kind === 'type') {
      // The `kind` key is removed before the document parser sees it, so that a corpus line and a
      // type document are parsed by ONE function with one key allowlist -- a second parser is a
      // second answer to "is this definition valid", and the two would drift.
      const document = parseDocument(JSON.stringify(withoutKind(parsed)), where);
      // A stored registration knows its own number, so the line states it -- which is what stops
      // the number from being read off the line's POSITION. `merge=union` reorders lines without
      // asking and no code can prevent it, so before this field existed two clones could number
      // the same content differently (asc-i5tj.6). This is the same rule `parseSchemeLine` already
      // enforced for a scheme (`requiredWholeNumber` above): the asymmetry was the defect.
      //
      // Refused rather than defaulted, deliberately. `parseDocument` accepts an absent version
      // because `types define` registers a definition its author has not numbered yet -- but a
      // corpus line is never that. A fallback to line order would be the very rule being retired,
      // and it would retire it only for the trees that happened to be written after this change.
      if (document.version === undefined && options.allowVersionlessTypeLines !== true) {
        throw new Error(
          `${where} is a type definition with no version, and a corpus line always states one. ` +
            `Run \`asc store rewrite\` once to upgrade this tree; it assigns each line the version ` +
            `line order gives it today, which is the rule this field replaces.`,
        );
      }
      lines.push({ where, line: { kind: 'type', document } });
      continue;
    }
    if (kind === 'entry') {
      lines.push({ where, line: parseEntryLine(where, parsed) });
      continue;
    }
    if (kind === 'scheme') {
      lines.push({ where, line: parseSchemeLine(where, parsed) });
      continue;
    }
    if (kind === 'annotation') {
      const line = parseAnnotationLine(where, parsed);
      // The one scheme a corpus line must carry a reason for; every other scheme's note is
      // optional and stays that way. The rule and its reasoning are on the function.
      requireInvalidationReason(where, line);
      lines.push({ where, line });
      continue;
    }

    // An OLDER binary reaches this branch on a stream this bead's export now writes, for a
    // `scheme` or `annotation` line it has never heard of -- and refusing here, naming a kind it
    // does not recognise, is the correct outcome rather than a gap: silently restoring only the
    // kinds it knows would be this exact defect (asc-6u5) recurring one release later, on the
    // binary that cannot yet be fixed.
    throw new Error(
      `${where}.kind is ${describeValue(kind)}, but a corpus line is one of "type", "entry", ` +
        `"scheme", or "annotation".`,
    );
  }

  return lines;
}

/**
 * The hash a type line claims, recomputed from its contents.
 *
 * Throws with both hashes, because the useful question is *which* two definitions are being
 * confused -- the same message `document.ts` writes for the same check, and deliberately separate
 * from it only because a corpus line has one more key than a document does.
 */
export function verifyTypeLine(line: TypeLine, where: string): void {
  const claimed = line.document.type_hash;
  if (claimed === undefined) {
    // A document without a hash is accepted by `types import` -- a hand-written definition has
    // nothing to check against. A corpus line is never hand-written, so its absence is a finding.
    throw new Error(
      `${where} is a type definition with no type_hash, and a corpus line always carries one. ` +
        `Export it again rather than editing the file by hand.`,
    );
  }

  const computed = specHash({ name: line.document.name, properties: line.document.properties });
  if (computed !== claimed) {
    throw new Error(
      `${where} claims type_hash ${claimed} but its contents hash to ${computed}. The definition ` +
        `is not the one the corpus says it is, so importing it would register the entries' ` +
        `definition under the wrong identity.`,
    );
  }
}

/**
 * The hash a scheme line claims, recomputed from its contents.
 *
 * Unlike `verifyTypeLine`, `scheme_hash` is not optional on `SchemeLine` -- `annotation_schemes`
 * has no hash column to have gone missing from in the first place, so there is no "hand-written,
 * nothing to check against" case here the way there is for a type document. Every scheme line
 * this module produces carries one, so a line with none has already failed `parseSchemeLine`'s
 * own required-field check before this is ever called.
 *
 * Throws with both hashes, for the same reason `verifyTypeLine` does: the useful question is
 * *which* two schemes are being confused, not merely that they disagree.
 */
export function verifySchemeLine(line: SchemeLine, where: string): void {
  const computed = schemeHash(line.spec);
  if (computed !== line.scheme_hash) {
    throw new Error(
      `${where} claims scheme_hash ${line.scheme_hash} but its contents hash to ${computed}. The ` +
        `scheme is not the one the corpus says it is, so importing it would register the ` +
        `annotations' scheme under the wrong identity.`,
    );
  }
}
