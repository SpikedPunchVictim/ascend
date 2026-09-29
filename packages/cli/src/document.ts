/**
 * The type document: one format, used by `define`, `export` and `import`.
 *
 * There is exactly one shape so that a round-trip is the identity and there is no second
 * format to keep in step -- `asc types export x | asc types import -` must reproduce what it
 * started from, and the only way to be confident of that is to have nothing to convert
 * between.
 *
 * ```jsonc
 * {
 *   "name": "review_completed",
 *   "properties": [{ "name": "review_kind", "type": "enum", "enum_values": ["approved"] }],
 *   "description":  "prose about the type",          // not identity
 *   "record_when":  "prose telling a model when",     // not identity
 *   "purpose":      "why this type exists",           // guidance (asc-bli): not identity
 *   "analysis_questions":   ["what to ask of it"],     // guidance
 *   "interpretation_notes": "how to read it",          // guidance
 *   "review_after": 20,                                // guidance: an intention, never a gate
 *   "prose":        { "review_kind": "per-property" },// not identity
 *   "type_hash":    "…64 hex…"                        // checked on import, never trusted
 * }
 * ```
 *
 * **The spec fields are core's `TypeSpec` verbatim** (`name`, `properties`, and the first two
 * prose fields), so this format is the spec plus two keys rather than a parallel vocabulary
 * that could drift from it. Prose and identity are separated exactly as the store separates
 * them: `definitionShape` drops every prose field before hashing, which is what makes
 * re-registering a definition under different wording an `unchanged` outcome rather than a
 * new version.
 *
 * **`type_hash` is carried, and it is not decoration.** `type_hash` is a pure function of the
 * canonical shape -- `specHash` in the store, which `import` calls to recompute it -- so a
 * matching hash is not what *makes* two repos comparable; it is the evidence that the
 * document survived the trip intact. A definition that lost a field in transit would
 * otherwise register cleanly in the target repo under a *different* hash, and the two
 * corpora would quietly stop being comparable. So: recompute, compare, refuse on mismatch.
 * A document without `type_hash` is accepted -- a hand-written definition has nothing to
 * check against, and inventing a check there would only reject valid input.
 *
 * **Unknown keys are refused rather than ignored.** A document is written by hand or by a
 * model, and `recordWhen` where the field is `record_when` is the likely mistake. Ignoring
 * it would store the definition with no trigger prose while reporting success -- the silent
 * no-op this project treats as severity-zero. The error names the offending key and lists
 * the ones that exist.
 */

import {
  documentFromRow,
  documentGuidance,
  documentSpec,
  orderedDocument,
  parseDocument,
  parseDocuments,
  specHash,
  type TypeDocument,
} from '@ascend/store';

/**
 * Re-exported so every existing importer of these from `./document.js` keeps working unchanged.
 *
 * The whole format -- output AND input -- lives in `@ascend/store` now (`asc-i5tj`). The output
 * direction (`documentFromRow`, `orderedDocument`) moved first, because the store had become a
 * writer of `type` lines; `parseDocument`/`parseDocuments` followed, because the store's corpus
 * reader parses `type` lines too and `align` forbids `store -> cli`. That module carries the full
 * rationale.
 */
export {
  documentFromRow,
  documentGuidance,
  documentSpec,
  orderedDocument,
  parseDocument,
  parseDocuments,
};
export type { TypeDocument };

/**
 * Check the document's claimed identity against what its contents actually hash to.
 *
 * Throws with both hashes, because the useful question is *which* two definitions are being
 * confused -- a caller who sees only "mismatch" has to guess whether they edited the file or
 * are importing the wrong one.
 */
export function verifyDocumentHash(document: TypeDocument, source: string): void {
  if (document.type_hash === undefined) return;

  const computed = specHash(documentSpec(document));
  if (computed === document.type_hash) return;

  throw new Error(
    `${source} claims type_hash ${document.type_hash} but its contents hash to ${computed}. ` +
      `The document does not describe the definition it says it does, so importing it would ` +
      `register a definition under the wrong identity. Re-export the type rather than editing ` +
      `the document by hand.`,
  );
}

/**
 * Serialize a document, with a stable key order.
 *
 * Compact rather than indented: this is written to stdout in a pipeline, and `jq .` is one
 * keystroke away for a human reading a file. Key order is fixed so that exporting the same
 * registry twice produces identical bytes -- which is what makes a diff of two exports mean
 * something.
 */
export function serializeDocument(document: TypeDocument): string {
  return JSON.stringify(orderedDocument(document));
}

/**
 * Serialize a list of documents, oldest version first.
 *
 * An array even for one document, so that `asc types export x | asc types import -` and
 * `asc types export | asc types import -` are the same shape and `import` needs no mode. The
 * order is the caller's to fix and is not sorted here: `export` writes versions in the order
 * they must be registered, and reordering them would change the version numbers `import`
 * reproduces.
 */
export function serializeDocuments(documents: readonly TypeDocument[]): string {
  return JSON.stringify(documents.map(orderedDocument));
}
