/**
 * The corpus stream: one JSON object per line, in the order `type`, `entry`, `scheme`,
 * `annotation`.
 *
 * `asc-brt`. The store is per-project and gitignored, so `asc export` is the only thing that
 * carries a corpus out of a working copy. `asc types export` moves DEFINITIONS between projects
 * and says nothing about entries; this is the corpus itself -- and, since `asc-6u5`, the whole
 * corpus, hand labels and kappa passes included, not only what a trigger cannot protect.
 *
 * ```jsonl
 * {"kind":"type","name":"decision","properties":[…],"type_hash":"…"}
 * {"kind":"entry","id":"…","type_name":"decision","type_version":1,"type_hash":"…", …}
 * {"kind":"scheme","name":"risk","version":1,"created_at":"…","spec":{"labels":[…],"rules":[…]},"scheme_hash":"…"}
 * {"kind":"annotation","id":"…","entry_id":"…","scheme":"risk","scheme_version":1,"label":"high", …}
 * ```
 *
 * **JSONL rather than one big array, and the reason is the failure mode.** A corpus is the thing
 * you read after something went wrong, and an array is all-or-nothing: one truncated byte at the
 * end and no parser will hand you the entries before it. A line stream is read up to the damage.
 * It also streams in both directions -- `asc export | asc import -` never holds the corpus in
 * memory twice -- and appends, so a caller can concatenate two exports.
 *
 * **The order is a contract, not a preference.** `annotations` carries `FOREIGN KEY (entry_id)
 * REFERENCES entries (id)` and `FOREIGN KEY (scheme, scheme_version) REFERENCES
 * annotation_schemes (name, version)` (`schema.ts`), so an annotation line has to reach `import`
 * after both the entry it labels and the scheme it was labelled under, or the write fails on a
 * foreign key it never gets a chance to explain. `type`, `entry`, `scheme`, `annotation` is the
 * one order that satisfies both constraints at once.
 *
 * **The definitions are required, not optional -- and that now covers schemes too.** An entry's
 * `type_hash` points at a type version, so a corpus restored without its definitions cannot
 * render its own views: every generated view and every `asc query` needs the spec the entries
 * were validated against. An annotation's `(scheme, scheme_version)` is the same kind of pointer
 * into `annotation_schemes`, for the same reason: `asc kappa` and `schemeCensus` both need the
 * rule an annotation was produced under, not only the label it left behind. `export` therefore
 * always writes definitions before the rows that depend on them, and `import` refuses to restore
 * either kind of row whose definition is not in the file.
 *
 * **`type_hash`, `type_version`, and now `scheme_hash` are carried and CHECKED, never trusted.**
 * `type_hash` is a pure function of the canonical shape (`specHash`), so a matching hash is
 * evidence the definition survived the trip rather than something that makes two corpora
 * comparable -- which is exactly the argument `document.ts` makes for the same field, and the
 * check is `registerDocument`'s. An entry's `type_version` is corroborating evidence of the same
 * kind: `import` resolves the version by HASH and refuses if the file claims a different number,
 * because the two disagreeing means the file is describing an entry that was not recorded against
 * the definition it names. `scheme_hash` is `schemeHash` (`@ascend/store`) applied to the exact
 * same argument: a scheme line's `spec` is what `import` recomputes the hash from, and a claimed
 * `scheme_hash` that disagrees is refused rather than trusted, by `verifySchemeLine`.
 *
 * **`recorded_at` and `id` are restored verbatim, and so is everything else in the row.** That is
 * the whole point: a restored corpus is the same corpus, not a re-recording of it. The one column
 * that cannot be restored is `entry_types.registered_at`, which `registerType` takes from the
 * caller -- a type's registration timestamp becomes the moment of the import. An entry's
 * `ascend_version` and `schema_version` ARE restored, so the file's record of which build wrote
 * each row survives even though the definitions' does not.
 *
 * **An annotation line restores as part of a PASS, not as an independent row.**
 * `recordAnnotations` stamps `created_at` and `created_by` onto every row of one call
 * (`annotations.ts:655-669`), and `RecordedAnnotations`'s own doc calls `(scheme, schemeVersion,
 * createdAt)` the pass identity that `asc kappa` compares. So `import` groups the stream's
 * annotation lines by that identity (`created_by` travels with it, since two passes can share a
 * timestamp only in theory and never in the same group) and issues one `recordAnnotations` call
 * per group, passing the group's own `created_at`/`created_by` back in as the context that call
 * takes. Restoring row by row instead would stamp every annotation with the import's own clock
 * and collapse every pass a scheme ever ran into one -- the corpus would still contain every
 * label, and `asc kappa` would still run without error, but it would be comparing a scheme against
 * itself. A row count cannot see that defect; only the count of DISTINCT pass identities can.
 *
 * **Backward and forward compatibility.** Neither `scheme` nor `annotation` lines are required:
 * an export written before `asc-6u5` has neither, and it restores exactly as it always did --
 * `refuseUnrestorable` only requires a scheme for an annotation that is actually present, the same
 * way it only requires a type for an entry that is. A newer stream fed to an OLDER binary is not
 * handled by any code here: that binary's `parseCorpus` does not know the two new kinds and
 * refuses the first `scheme` or `annotation` line it meets, which is the correct outcome and does
 * not need a compatibility shim -- an old binary restoring a new corpus silently and dropping the
 * annotations would be this exact bead recurring one release later.
 */

import {
  annotationLine,
  ENTRY_SOURCES,
  entryLine,
  orderedLine,
  schemeHash,
  schemeLine,
  serializeCorpus,
  specHash,
  typeLine,
  type AnnotationLine,
  type CorpusLine,
  type EntryLine,
  type EntrySource,
  type SchemeLine,
  type SchemeRule,
  type SchemeRuleKind,
  type SchemeSpec,
  type TypeLine,
} from '@ascend/store';
import { parseDocument } from './document.js';
import { refusal } from './errors.js';
import { describeValue, fieldError, isJsonObject } from './json-fields.js';

/**
 * Re-exported so every existing importer -- `export.ts`, `import.ts`, `redact.ts`, `secrets.ts` --
 * keeps working unchanged.
 *
 * The four line kinds, their constructors, `orderedLine` and `serializeCorpus` moved to
 * `@ascend/store` in `asc-i5tj`, because the store now writes these bytes itself and `align`
 * forbids `store -> cli`. Only the output half moved: the parsers below stay here, because they
 * read text a human may have written and throw this package's `refusal`. `ParsedLine` stays with
 * them, since it is the coordinate a parse failure is reported at. That module carries the full
 * rationale.
 */
export { annotationLine, entryLine, orderedLine, schemeLine, serializeCorpus, typeLine };
export type { AnnotationLine, CorpusLine, EntryLine, SchemeLine, TypeLine };

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
      throw refusal(
        `${where} has no such field '${key}'. The fields are: ${ENTRY_KEYS.join(', ')}. ` +
          `Fields are not ignored when unrecognised, so that a misspelt one cannot be dropped in silence.`,
      );
    }
  }

  const source = requiredText(where, raw, 'source');
  if (!(ENTRY_SOURCES as readonly string[]).includes(source)) {
    throw refusal(
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
      throw refusal(
        `${where}.${field} has no such field '${key}'. The fields are: ${SCHEME_RULE_KEYS.join(', ')}.`,
      );
    }
  }

  const label = raw['label'];
  if (typeof label !== 'string') fieldError(where, `${field}.label`, 'a string', label);

  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(SCHEME_RULE_KINDS as readonly string[]).includes(kind)) {
    throw refusal(
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
      throw refusal(
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
      throw refusal(
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
      throw refusal(
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
export function parseCorpus(text: string, source: string): readonly ParsedLine[] {
  const lines: ParsedLine[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    const where = `${source} line ${String(index + 1)}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw refusal(
        `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    if (!isJsonObject(parsed)) {
      throw refusal(`${where} must be a JSON object, but it is ${describeValue(parsed)}.`);
    }

    const kind = parsed['kind'];
    if (kind === 'type') {
      // The `kind` key is removed before the document parser sees it, so that a corpus line and a
      // type document are parsed by ONE function with one key allowlist -- a second parser is a
      // second answer to "is this definition valid", and the two would drift.
      lines.push({
        where,
        line: { kind: 'type', document: parseDocument(JSON.stringify(withoutKind(parsed)), where) },
      });
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
      lines.push({ where, line: parseAnnotationLine(where, parsed) });
      continue;
    }

    // An OLDER binary reaches this branch on a stream this bead's export now writes, for a
    // `scheme` or `annotation` line it has never heard of -- and refusing here, naming a kind it
    // does not recognise, is the correct outcome rather than a gap: silently restoring only the
    // kinds it knows would be this exact defect (asc-6u5) recurring one release later, on the
    // binary that cannot yet be fixed.
    throw refusal(
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
    throw refusal(
      `${where} is a type definition with no type_hash, and a corpus line always carries one. ` +
        `Export it again rather than editing the file by hand.`,
    );
  }

  const computed = specHash({ name: line.document.name, properties: line.document.properties });
  if (computed !== claimed) {
    throw refusal(
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
    throw refusal(
      `${where} claims scheme_hash ${line.scheme_hash} but its contents hash to ${computed}. The ` +
        `scheme is not the one the corpus says it is, so importing it would register the ` +
        `annotations' scheme under the wrong identity.`,
    );
  }
}
