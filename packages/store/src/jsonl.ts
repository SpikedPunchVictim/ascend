/**
 * The JSONL record stream's output half: the four line kinds, their canonical key order, and
 * serialization.
 *
 * **Why this is here and not in the CLI, where it was written.** These are the bytes the store
 * writes to disk. Until `asc-i5tj` the only thing that produced them was `asc export`, so they
 * lived in `packages/cli/src/corpus.ts` -- and the CLI is not allowed to be the definition of a
 * format the store owns, because the store cannot reach back for it: `align` forbids `store -> cli`
 * (`arch.no-cycles`, plus the rules that keep the CLI the one interface). The alternative was to
 * re-implement the line shapes here, which is the second-format defect `asc-i5tj` names -- two
 * definitions that agree on the day they are written and drift on the first field anyone adds.
 *
 * **Only the OUTPUT half moved.** `parseCorpus`, `verifyTypeLine`, `verifySchemeLine` and the
 * per-line validators stay in the CLI: they read text a human or a model may have written or
 * hand-edited, refuse unknown fields, and throw the CLI's `refusal`. None of that is needed to
 * write a line from a row the registry has already validated, and all of it would drag the CLI's
 * error machinery in. `ParsedLine` stays with the parsers for the same reason -- it is the
 * coordinate a parse failure is reported at.
 *
 * What moved is exactly the part that turns a TRUSTED row into bytes, which is why nothing here
 * validates anything.
 *
 * `packages/cli/src/corpus.ts` imports all of it back and re-exports it, so every existing
 * importer (`export.ts`, `import.ts`, `redact.ts`, `secrets.ts`) keeps working unchanged -- the
 * same move `document.ts` and `properties.ts` document.
 */

import {
  schemeHash,
  type AnnotationRow,
  type SchemeSpec,
  type SchemeSummary,
} from './annotations.js';
import { documentFromRow, orderedDocument, type TypeDocument } from './document.js';
import type { EntrySource, RecordedEntry } from './recorder.js';
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
      spec: line.spec,
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
