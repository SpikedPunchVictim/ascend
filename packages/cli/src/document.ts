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

import { PROPERTY_TYPES, type PropertySpec, type PropertyType, type TypeSpec } from '@ascend/core';
import { specHash, type TypeVersionRow } from '@ascend/store';
import { refusal } from './errors.js';
import { describeValue, fieldError, isJsonObject } from './json-fields.js';

export interface TypeDocument {
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

const KNOWN_KEYS = [
  'name',
  'properties',
  'description',
  'record_when',
  'prose',
  'type_hash',
] as const;
const KNOWN_PROPERTY_KEYS = [
  'name',
  'type',
  'required',
  'enum_values',
  'unit',
  'description',
] as const;

/** A JSON object, as opposed to a JSON array or any scalar. */
const isRecord = isJsonObject;

function parseProperty(source: string, index: number, raw: unknown): PropertySpec {
  const where = `properties[${String(index)}]`;
  if (!isRecord(raw)) fieldError(source, where, 'an object', raw);

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_PROPERTY_KEYS as readonly string[]).includes(key)) {
      throw refusal(
        `${source}: ${where} has no such field '${key}'. The fields are: ` +
          `${KNOWN_PROPERTY_KEYS.join(', ')}.`,
      );
    }
  }

  if (typeof raw['name'] !== 'string') fieldError(source, `${where}.name`, 'a string', raw['name']);

  const type = raw['type'];
  if (typeof type !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(type)) {
    throw refusal(
      `${source}: ${where}.type must be one of ${PROPERTY_TYPES.join(', ')}, ` +
        `but it is ${describeValue(type)}.`,
    );
  }

  const required = raw['required'];
  if (required !== undefined && typeof required !== 'boolean') {
    fieldError(source, `${where}.required`, 'a boolean', required);
  }

  const unit = raw['unit'];
  if (unit !== undefined && typeof unit !== 'string') {
    fieldError(source, `${where}.unit`, 'a string', unit);
  }

  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') {
    fieldError(source, `${where}.description`, 'a string', description);
  }

  const enumValues = raw['enum_values'];
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.some((value) => typeof value !== 'string')) {
      fieldError(source, `${where}.enum_values`, 'an array of strings', enumValues);
    }
  }

  // Built field by field rather than spread, because `exactOptionalPropertyTypes` is on and
  // an explicit `undefined` is a different type from an absent key. A spread of raw JSON
  // would carry every key it saw, including ones that should be absent.
  return {
    name: raw['name'],
    type: type as PropertyType,
    ...(required === true ? { required: true } : {}),
    ...(enumValues === undefined ? {} : { enum_values: enumValues as string[] }),
    ...(unit === undefined ? {} : { unit }),
    ...(description === undefined ? {} : { description }),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

/**
 * Parse one document.
 *
 * `source` names where the text came from (a path, or `standard input`) so every error can
 * say which document it is about -- with `import` reading a list, "which one?" is the first
 * thing a caller needs to know.
 */
export function parseDocument(text: string, source: string): TypeDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw refusal(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  if (!isRecord(raw)) {
    throw refusal(`${source} must be a JSON object holding a type definition, but it is not.`);
  }

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw refusal(
        `${source} has no such field '${key}'. The fields are: ${KNOWN_KEYS.join(', ')}. ` +
          `Fields are not ignored when unrecognised, so that a misspelt one cannot be dropped in silence.`,
      );
    }
  }

  if (typeof raw['name'] !== 'string') fieldError(source, 'name', 'a string', raw['name']);

  const properties = raw['properties'];
  if (!Array.isArray(properties)) fieldError(source, 'properties', 'an array', properties);

  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string') {
    fieldError(source, 'description', 'a string', description);
  }
  // Refused here rather than left to the database (asc-zrx). `schema.ts`'s `entry_types` table
  // carries `CHECK (description IS NULL OR description <> '')`, and until this guard existed
  // nothing upstream re-checked it: an empty string passed every parse and validation check in
  // this file and reached the store, which refused it with SQLite's own CHECK-constraint text --
  // naming a table and a column, not a document. Matched to the CHECK's own rule: `undefined`
  // (the key omitted) is still the way to leave the field unset; `''` is refused the same as any
  // other malformed field, with a message that says which document and what to do about it.
  if (description === '') {
    throw refusal(
      `${source}: description is '' (empty). The store never stores an empty description -- ` +
        `omit the field entirely to leave it unset, or give it real text.`,
    );
  }

  const recordWhen = raw['record_when'];
  if (recordWhen !== undefined && typeof recordWhen !== 'string') {
    fieldError(source, 'record_when', 'a string', recordWhen);
  }
  // Same CHECK, same reasoning, the other column it guards.
  if (recordWhen === '') {
    throw refusal(
      `${source}: record_when is '' (empty). The store never stores an empty record_when -- ` +
        `omit the field entirely to leave it unset, or give it real text.`,
    );
  }

  const prose = raw['prose'];
  if (prose !== undefined && !isPlainObject(prose)) {
    fieldError(source, 'prose', 'an object of strings, keyed by property name', prose);
  }

  const hash = raw['type_hash'];
  if (hash !== undefined && typeof hash !== 'string') {
    fieldError(source, 'type_hash', 'a string', hash);
  }

  return {
    name: raw['name'],
    properties: properties.map((property, index) => parseProperty(source, index, property)),
    ...(description === undefined ? {} : { description }),
    ...(recordWhen === undefined ? {} : { record_when: recordWhen }),
    ...(prose === undefined ? {} : { prose: prose as Record<string, string> }),
    ...(hash === undefined ? {} : { type_hash: hash }),
  };
}

/**
 * Parse a document, or a list of them.
 *
 * `export` writes a list, and accepting a single document too costs nothing and saves a
 * caller from having to know which they have -- `asc types export x > one.json` produces a
 * one-element list, while a hand-written definition is usually a bare object.
 */
export function parseDocuments(text: string, source: string): readonly TypeDocument[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw refusal(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  if (Array.isArray(raw)) {
    return raw.map((item, index) =>
      parseDocument(JSON.stringify(item), `${source} [${String(index)}]`),
    );
  }
  return [parseDocument(text, source)];
}

/**
 * The identity-bearing part of a document: what gets registered and hashed.
 *
 * Prose is deliberately absent. Type-level `description` and `record_when` would be dropped
 * by `definitionShape` anyway, and passing them here as well as in the registration options
 * would be two paths to the same column -- the one that silently wins being whichever the
 * store happens to read last.
 */
export function documentSpec(document: TypeDocument): TypeSpec {
  return { name: document.name, properties: document.properties };
}

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
    ...(document.prose === undefined ? {} : { prose: document.prose }),
    ...(document.type_hash === undefined ? {} : { type_hash: document.type_hash }),
  };
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
