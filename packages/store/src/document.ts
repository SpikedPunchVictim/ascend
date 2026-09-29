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
 * **The whole format now lives here, reader as well as writer.** The output direction
 * (`documentFromRow`, `orderedDocument`) moved first, because the store had become a writer of
 * `type` lines; the input direction (`parseDocument`, `parseDocuments`) followed in the same bead,
 * because the store's corpus reader (`jsonl.ts`) parses `type` lines too and `align` forbids
 * `store -> cli`. The parser validates text a human or a model wrote and refuses unknown keys --
 * it threw the CLI's `refusal` only because it lived there, and `refusal` is exactly
 * `new Error(message)`, so its messages are unchanged here.
 *
 * `packages/cli/src/document.ts` imports all of it back and re-exports it, so every existing
 * importer keeps working unchanged -- the same move `properties.ts` documents for
 * `propertiesOf`/`valueExpr`. `verifyDocumentHash`, `documentSpec` and the serializers stay in the
 * CLI: they are the `types` command's own output path, not part of the corpus format.
 */

import {
  GUIDANCE_FIELDS,
  guidanceProblems,
  PROPERTY_TYPES,
  type PropertySpec,
  type PropertyType,
  type TypeGuidance,
  type TypeSpec,
} from '@ascend/core';
import { describeValue, fieldError, isJsonObject } from './json-fields.js';
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

/**
 * The identity-bearing part of a document: what gets registered and hashed.
 *
 * Prose is deliberately absent. Type-level `description` and `record_when` would be dropped by
 * `definitionShape` anyway, and passing them here as well as in the registration options would be
 * two paths to the same column -- the one that silently wins being whichever the store happens to
 * read last.
 *
 * It lives here rather than in the CLI because three callers need it and all three are below the
 * CLI: `asc types import` and `asc import` register documents, and the derived index replays a
 * `type` line back through `registerType` (E12.2). A second spelling of "the part of a document
 * that is identity" is the class of defect that would make two stores disagree about whether they
 * hold the same definition while both reporting success.
 */
export function documentSpec(document: TypeDocument): TypeSpec {
  return { name: document.name, properties: document.properties };
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

const KNOWN_KEYS = [
  'name',
  'properties',
  'description',
  'record_when',
  ...GUIDANCE_FIELDS,
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
      throw new Error(
        `${source}: ${where} has no such field '${key}'. The fields are: ` +
          `${KNOWN_PROPERTY_KEYS.join(', ')}.`,
      );
    }
  }

  if (typeof raw['name'] !== 'string') fieldError(source, `${where}.name`, 'a string', raw['name']);

  const type = raw['type'];
  if (typeof type !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(type)) {
    throw new Error(
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
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }

  if (!isRecord(raw)) {
    throw new Error(`${source} must be a JSON object holding a type definition, but it is not.`);
  }

  for (const key of Object.keys(raw)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new Error(
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
    throw new Error(
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
    throw new Error(
      `${source}: record_when is '' (empty). The store never stores an empty record_when -- ` +
        `omit the field entirely to leave it unset, or give it real text.`,
    );
  }

  const guidance = parseGuidance(source, raw);

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
    ...guidance,
    ...(prose === undefined ? {} : { prose: prose as Record<string, string> }),
    ...(hash === undefined ? {} : { type_hash: hash }),
  };
}

/**
 * The guidance fields of a raw document, type-checked here and then checked for content by
 * core's `guidanceProblems` -- the same function the store refuses with, so a document cannot
 * pass this and then be refused by the store with a message that names no document.
 */
function parseGuidance(source: string, raw: Record<string, unknown>): TypeGuidance {
  const purpose = raw['purpose'];
  if (purpose !== undefined && typeof purpose !== 'string') {
    fieldError(source, 'purpose', 'a string', purpose);
  }
  const notes = raw['interpretation_notes'];
  if (notes !== undefined && typeof notes !== 'string') {
    fieldError(source, 'interpretation_notes', 'a string', notes);
  }
  const questions = raw['analysis_questions'];
  if (
    questions !== undefined &&
    !(Array.isArray(questions) && questions.every((question) => typeof question === 'string'))
  ) {
    fieldError(source, 'analysis_questions', 'an array of strings', questions);
  }
  const reviewAfter = raw['review_after'];
  if (reviewAfter !== undefined && typeof reviewAfter !== 'number') {
    fieldError(source, 'review_after', 'a number', reviewAfter);
  }

  const guidance: TypeGuidance = {
    ...(purpose === undefined ? {} : { purpose }),
    ...(questions === undefined ? {} : { analysis_questions: questions }),
    ...(notes === undefined ? {} : { interpretation_notes: notes }),
    ...(reviewAfter === undefined ? {} : { review_after: reviewAfter }),
  };

  const problems = guidanceProblems(guidance);
  if (problems.length > 0) throw new Error(`${source}: ${problems.join('; ')}.`);
  return guidance;
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
    throw new Error(
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
