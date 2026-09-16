/**
 * The corpus stream: one JSON object per line, every type version then every entry.
 *
 * `asc-brt`. The store is per-project and gitignored, so `asc export` is the only thing that
 * carries a corpus out of a working copy. `asc types export` moves DEFINITIONS between projects
 * and says nothing about entries; this is the corpus itself.
 *
 * ```jsonl
 * {"kind":"type","name":"decision","properties":[…],"type_hash":"…"}
 * {"kind":"entry","id":"…","type_name":"decision","type_version":1,"type_hash":"…", …}
 * ```
 *
 * **JSONL rather than one big array, and the reason is the failure mode.** A corpus is the thing
 * you read after something went wrong, and an array is all-or-nothing: one truncated byte at the
 * end and no parser will hand you the entries before it. A line stream is read up to the damage.
 * It also streams in both directions -- `asc export | asc import -` never holds the corpus in
 * memory twice -- and appends, so a caller can concatenate two exports.
 *
 * **The definitions are required, not optional.** An entry's `type_hash` points at a type version,
 * so a corpus restored without its definitions cannot render its own views: every generated view
 * and every `asc query` needs the spec the entries were validated against. `export` therefore
 * always writes the definitions first, and `import` refuses to restore entries whose definitions
 * are not in the file.
 *
 * **`type_hash` and `type_version` are carried and CHECKED, never trusted.** `type_hash` is a pure
 * function of the canonical shape (`specHash`), so a matching hash is evidence the definition
 * survived the trip rather than something that makes two corpora comparable -- which is exactly
 * the argument `document.ts` makes for the same field, and the check is `registerDocument`'s. An
 * entry's `type_version` is corroborating evidence of the same kind: `import` resolves the version
 * by HASH and refuses if the file claims a different number, because the two disagreeing means the
 * file is describing an entry that was not recorded against the definition it names.
 *
 * **`recorded_at` and `id` are restored verbatim, and so is everything else in the row.** That is
 * the whole point: a restored corpus is the same corpus, not a re-recording of it. The one column
 * that cannot be restored is `entry_types.registered_at`, which `registerType` takes from the
 * caller -- a type's registration timestamp becomes the moment of the import. An entry's
 * `ascend_version` and `schema_version` ARE restored, so the file's record of which build wrote
 * each row survives even though the definitions' does not.
 */

import {
  ENTRY_SOURCES,
  specHash,
  type EntrySource,
  type RecordedEntry,
  type TypeVersionRow,
} from '@ascend/store';
import { documentFromRow, orderedDocument, parseDocument, type TypeDocument } from './document.js';
import { refusal } from './errors.js';
import { describeValue, fieldError, isJsonObject } from './json-fields.js';

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

export type CorpusLine = TypeLine | EntryLine;

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
 * A line as a plain object, with a fixed key order.
 *
 * Fixed so that exporting the same corpus twice produces identical bytes, which is what makes a
 * diff of two exports mean something -- the same argument `document.ts` makes for its own ordering,
 * and the reason a restored corpus can be compared with the original at all.
 */
export function orderedLine(line: CorpusLine): Record<string, unknown> {
  if (line.kind === 'type') return { kind: 'type', ...orderedDocument(line.document) };

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

/**
 * The corpus as a JSONL document: one line per line, and NO trailing newline.
 *
 * The terminator is the writer's job, which is the convention every renderer in this package
 * follows -- `types export`'s default output is asserted as `'[]\n'` in its suite, so the renderer
 * produces `'[]'` and `this.log` supplies the newline. Matching it is what makes the output a file
 * with exactly one newline per line.
 *
 * **This was got wrong first, in a way worth recording.** This function wrote its own trailing
 * newline *and* the command handed the result to `this.log`, so every export ended with a blank
 * line -- measured: a 42-line corpus produced `wc -l` 43. An empty corpus was worse, because
 * `log('')` writes a newline rather than nothing, so the stream that this function renders as zero
 * bytes reached stdout as one blank line: precisely the "blank line waiting for whoever reads it
 * next" the paragraph above is about. The command now returns this through `emitText`, which skips
 * an empty rendering, and this function writes no terminator of its own.
 *
 * The round trip never depended on either half -- `parseCorpus` skips blank lines, and both sides
 * of the trip run this same code -- which is exactly why the defect survived the byte-identical
 * comparison in `corpus.test.ts` and had to be found by reading `wc -l`.
 */
export function serializeCorpus(lines: readonly CorpusLine[]): string {
  return lines.map((line) => JSON.stringify(orderedLine(line))).join('\n');
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

    throw refusal(
      `${where}.kind is ${describeValue(kind)}, but a corpus line is either "type" or "entry".`,
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
