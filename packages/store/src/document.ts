/**
 * The output half of a type document: a row from the registry, to a document, to a plain object
 * with a fixed key order.
 *
 * **Why this is here and not in the CLI, where it was written.** A registered type has to be
 * written down in two places -- `asc types export` (a definition moving between projects) and the
 * `type` line of a corpus stream -- and both must produce the same bytes for the same row, because
 * the corpus's own header makes identical bytes the thing that gives a diff of two exports a
 * meaning. `documentFromRow` and `orderedDocument` are what fix those bytes. They lived in
 * `packages/cli/src/document.ts` because the CLI was the only writer; `asc-i5tj` makes the store
 * itself a writer, and `align` forbids `store -> cli` (`arch.no-cycles`, and the layering rules
 * that keep the CLI the one interface), so the store cannot reach back for them. Moving them
 * forward is the only direction that compiles.
 *
 * **Only the OUTPUT direction moved.** `parseDocument`, `verifyDocumentHash` and the rest of the
 * input path stay in the CLI: they validate text a human or a model wrote, refuse unknown keys, and
 * throw the CLI's `refusal` type -- none of which a writer needs, and all of which would drag the
 * CLI's error machinery into the store. What moved is the four pieces that turn a TRUSTED row into
 * bytes, which is why nothing here validates anything: `TypeVersionRow` has already been through
 * the registry.
 *
 * `packages/cli/src/document.ts` imports all four back and re-exports them, so every existing
 * importer keeps working unchanged -- the same move `properties.ts` documents for
 * `propertiesOf`/`valueExpr`.
 */

import type { PropertySpec, TypeGuidance } from '@ascend/core';
import type { TypeVersionRow } from './registry.js';

/**
 * The guidance fields sit at the top level beside `record_when`, rather than nested under a
 * `guidance` key, because they are the same kind of thing -- prose about the type that is not
 * its identity -- and a document already spells that kind of thing flat.
 */
export interface TypeDocument extends TypeGuidance {
  readonly name: string;
  readonly properties: readonly PropertySpec[];
  /** Type-level prose. Not part of identity; editable in place. */
  readonly description?: string;
  /** Prose telling a model when to record this type. Surfaced by `asc types brief`. */
  readonly record_when?: string;
  /** Per-property prose, keyed by property name. Not part of identity. */
  readonly prose?: Readonly<Record<string, string>>;
  /** The identity this document claims. Recomputed and checked on import. */
  readonly type_hash?: string;
}

/** Only the guidance fields of a document, in document order, for the store. */
export function documentGuidance(document: TypeDocument): TypeGuidance {
  return {
    ...(document.purpose === undefined ? {} : { purpose: document.purpose }),
    ...(document.analysis_questions === undefined
      ? {}
      : { analysis_questions: document.analysis_questions }),
    ...(document.interpretation_notes === undefined
      ? {}
      : { interpretation_notes: document.interpretation_notes }),
    ...(document.review_after === undefined ? {} : { review_after: document.review_after }),
  };
}

/**
 * The document describing a registered version.
 *
 * `spec` is the stored shape, already canonical, so an export is canonical by construction.
 * Prose is read from the columns and the prose column rather than from the spec, because
 * that is where the store keeps it.
 */
export function documentFromRow(row: TypeVersionRow): TypeDocument {
  return {
    name: row.name,
    properties: row.spec.properties,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.recordWhen === null ? {} : { record_when: row.recordWhen }),
    ...row.guidance,
    ...(Object.keys(row.prose).length === 0 ? {} : { prose: row.prose }),
    type_hash: row.typeHash,
  };
}

/**
 * A document as a plain object, with a fixed key order.
 *
 * Separate from serializing so that a single document and a list of them are built by the same
 * function -- `export` writes a list, and a list whose elements were ordered by a second
 * implementation is a list that could disagree with the documents it is made of.
 */
export function orderedDocument(document: TypeDocument): Record<string, unknown> {
  return {
    name: document.name,
    properties: document.properties,
    ...(document.description === undefined ? {} : { description: document.description }),
    ...(document.record_when === undefined ? {} : { record_when: document.record_when }),
    ...documentGuidance(document),
    ...(document.prose === undefined ? {} : { prose: document.prose }),
    ...(document.type_hash === undefined ? {} : { type_hash: document.type_hash }),
  };
}
