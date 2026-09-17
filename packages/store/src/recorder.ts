/**
 * The single entry write path.
 *
 * **This is the only module in ascend that INSERTs into `entries`.** Nothing else may,
 * and that is enforced rather than intended: a test scans the package's source and fails
 * if a second `INSERT INTO entries` appears anywhere (test/recorder.test.ts, "exactly one
 * write path").
 * The discipline is align's one-recorder rule, and the reason it is worth a test is
 * that a second write path is invisible until the two disagree -- one of them adds a
 * field, or validates differently, and the corpus quietly contains two shapes of record
 * that no query can tell apart.
 *
 * The envelope is built HERE, and the type identity is resolved HERE, from the store.
 * A caller names a type and offers values; it cannot supply a `type_version` or a
 * `type_hash`. That is deliberate: those three columns are one foreign key, and letting
 * a caller pass them independently is exactly how an entry ends up claiming a definition
 * whose shape it does not have. The caller supplies intent; the
 * recorder supplies identity.
 *
 * Time and identifiers are INJECTED, never read. `id`, `recordedAt`, `runId` and the
 * provenance fields all arrive in the context, so this module contains no `Date.now()` and
 * no `randomUUID()` -- tested, not asserted, by the same source scan. The command boundary
 * mints them; the store only records what it was handed.
 *
 * Validation is NOT re-implemented here. `@ascend/core`'s `validateEntry` owns the
 * three-state model and the required-means-a-decision rule, and it is pure, so it can be
 * exercised against hand-written fixtures with no database in the way. The recorder's job
 * is only to refuse to persist what did not validate.
 */

import {
  canonicalJson,
  canonicalName,
  validateEntry,
  type EntryInput,
  type PropertyState,
  type TypeSpec,
  type ValidationIssue,
} from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './schema.js';

/** Where an entry came from. Mirrors the `source` CHECK constraint. */
export const ENTRY_SOURCES = ['self', 'derived:claude-code'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** What a recorder asks for: a type, and what it observed. */
export interface RecordRequest {
  readonly type: string;
  /** Defaults to the latest registered version. Named explicitly only to pin one. */
  readonly version?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly na?: readonly string[];
}

/**
 * Everything about the recording that is not the observation.
 *
 * `id` and `recordedAt` are required and have no defaults: a default would mean this
 * module reading a clock or drawing randomness, which is the thing it must not do.
 */
export interface RecordContext {
  readonly id: string;
  /** ISO-8601 UTC, ending in `Z`. See `requireUtcTimestamp` for why that is enforced. */
  readonly recordedAt: string;
  /** The ascend build that wrote this row, e.g. from package.json. Not read here. */
  readonly ascendVersion: string;
  readonly source?: EntrySource;
  /** Defaults to this build's schema version. Present so `asc import` can preserve one. */
  readonly schemaVersion?: number;
  readonly runId?: string;
  readonly workflow?: string;
  readonly actor?: string;
  readonly cwd?: string;
  readonly repo?: string;
  readonly gitSha?: string;
  readonly branch?: string;
  readonly evidenceText?: string;
}

/** A recorded entry, as written and as read back. */
export interface RecordedEntry {
  readonly id: string;
  readonly typeName: string;
  readonly typeVersion: number;
  readonly typeHash: string;
  readonly recordedAt: string;
  readonly source: EntrySource;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly na: readonly string[];
  /**
   * Derivable from the entry plus its definition, and returned anyway because every
   * consumer that reports a ratio needs all three states at once -- recomputing it at
   * each call site is how one of them eventually forgets `not_measured`.
   */
  readonly states: Readonly<Record<string, PropertyState>>;
  readonly runId: string | null;
  readonly workflow: string | null;
  readonly actor: string | null;
  readonly cwd: string | null;
  readonly repo: string | null;
  readonly gitSha: string | null;
  readonly branch: string | null;
  readonly evidenceText: string | null;
  readonly ascendVersion: string;
  readonly schemaVersion: number;
}

export interface RecordResult {
  readonly entry: RecordedEntry;
  /** Legal but almost certainly unintended. The row WAS written. */
  readonly warnings: readonly ValidationIssue[];
}

/** Thrown when the named type, or the named version of it, is not registered. */
export class UnknownTypeError extends Error {
  constructor(
    readonly typeName: string,
    readonly version: number | undefined,
    registered: readonly string[],
  ) {
    const wanted =
      version === undefined ? `'${typeName}'` : `'${typeName}' version ${String(version)}`;
    super(
      `no entry type ${wanted} is registered in this store. ` +
        (registered.length === 0
          ? `No types are registered yet. Define one with 'asc types define'.`
          : `Registered types: ${registered.join(', ')}.`) +
        ` An entry cannot reference a definition that does not exist -- that is the drift ` +
        `the store exists to prevent.`,
    );
    this.name = 'UnknownTypeError';
  }
}

/**
 * Thrown when the values offered do not satisfy the type definition.
 *
 * Carries the issues rather than only a rendered message, so a caller can print them
 * however it likes -- and the message already contains the fixes, because a recorder
 * that has to ask what went wrong costs a round trip that a self-correcting one does not.
 */
export class EntryRejectedError extends Error {
  constructor(
    readonly typeName: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(
      `${String(issues.length)} problem(s) with this ${typeName} entry, so nothing was recorded:\n` +
        issues.map((issue) => `  ${issue.field}: ${issue.problem}\n    ${issue.fix}`).join('\n'),
    );
    this.name = 'EntryRejectedError';
  }
}

/** Thrown when an entry with this id already exists. */
export class DuplicateEntryError extends Error {
  constructor(readonly id: string) {
    super(
      `an entry with id '${id}' already exists. Entries are immutable and cannot be ` +
        `overwritten or deleted, so this recording was refused rather than silently ` +
        `dropped. Use a new id.`,
    );
    this.name = 'DuplicateEntryError';
  }
}

/**
 * Every optional text field, and the reason `''` is refused rather than coerced to NULL.
 *
 * SQLite treats `''` as a real value: it compares, matches and joins like one. So an
 * empty `cwd` is not "unknown", it is a cwd that equals the empty string, and every
 * query that later asks "how many entries have no cwd?" gets a plausible wrong answer.
 * Accepting `''` and storing NULL would be worse, because it would hide the caller's
 * bug instead of reporting it.
 */
const OPTIONAL_TEXT_FIELDS = [
  'runId',
  'workflow',
  'actor',
  'cwd',
  'repo',
  'gitSha',
  'branch',
  'evidenceText',
] as const;

/**
 * `recorded_at` must be UTC, written with a literal `Z`.
 *
 * Enforced because the column is TEXT and every time-ordered query compares it
 * lexically: `2026-09-11T10:00:00+02:00` is a later instant than `2026-09-11T09:00:00Z`
 * but sorts BEFORE it. Allowing offsets would mean the ledger's chronological order
 * silently depends on which zone each recorder happened to be in. One canonical form,
 * chosen at the boundary, and the store does not rewrite the value it was handed.
 */
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requireUtcTimestamp(field: string, value: string): void {
  if (!UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(
      `${field} must be an ISO-8601 UTC timestamp ending in 'Z' (e.g. 2026-09-11T10:00:00.000Z), ` +
        `got ${JSON.stringify(value)}. Offsets and local times are refused because recorded_at is ` +
        `compared as text, so a mixed-zone ledger would not sort chronologically.`,
    );
  }
}

function requireNonEmpty(field: string, value: string): void {
  if (value === '') {
    throw new TypeError(
      `${field} is empty. An empty string is a real value in SQLite, not "unknown" -- ` +
        `omit the field instead so it is stored as NULL.`,
    );
  }
}

/** The registered type names, for the error message that tells a caller what exists. */
function registeredTypes(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare('SELECT DISTINCT name FROM entry_types ORDER BY name ASC')
    .all() as unknown as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Record one entry. The only way an entry is ever written.
 *
 * Refuses rather than persists on: an unknown type, a version that is not registered,
 * values that do not satisfy the definition, a duplicate id, an empty required field,
 * or a non-UTC timestamp. Every one of those is a hard error and none of them writes a
 * row -- an entry that is half-right is worse than no entry, because it reads as data.
 *
 * Returns warnings alongside the entry. Warnings never block: they mark things that are
 * legal and almost certainly unintended (an undeclared property, every property N/A, a
 * deprecated type), and the entry was written.
 */
export function recordEntry(
  db: DatabaseSync,
  request: RecordRequest,
  context: RecordContext,
): RecordResult {
  requireNonEmpty('id', context.id);
  requireUtcTimestamp('recordedAt', context.recordedAt);
  requireNonEmpty('ascendVersion', context.ascendVersion);

  for (const field of OPTIONAL_TEXT_FIELDS) {
    const value = context[field];
    if (value !== undefined) requireNonEmpty(field, value);
  }

  const type = findRegisteredType(db, request.type, request.version);

  const input: EntryInput = {
    ...(request.properties === undefined ? {} : { properties: request.properties }),
    ...(request.na === undefined ? {} : { na: request.na }),
  };
  const validated = validateEntry(type.spec, input);

  if (!validated.ok) throw new EntryRejectedError(type.name, validated.errors);

  const existing = db.prepare('SELECT id FROM entries WHERE id = ?').get(context.id);
  if (existing !== undefined) throw new DuplicateEntryError(context.id);

  const schemaVersion = context.schemaVersion ?? SCHEMA_VERSION;
  const source = context.source ?? 'self';

  db.prepare(
    `INSERT INTO entries
       (id, type_name, type_version, type_hash, recorded_at, run_id, workflow, actor, source,
        cwd, repo, git_sha, branch, properties_json, na_json, evidence_text,
        ascend_version, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    context.id,
    type.name,
    type.version,
    type.typeHash,
    context.recordedAt,
    context.runId ?? null,
    context.workflow ?? null,
    context.actor ?? null,
    source,
    context.cwd ?? null,
    context.repo ?? null,
    context.gitSha ?? null,
    context.branch ?? null,
    // Canonically serialized: keys sorted. The stored bytes are then a function of the
    // observation alone, so `asc export` output is stable run to run and a test can
    // assert on the row rather than on however the caller happened to order its object.
    canonicalJson(validated.properties),
    canonicalJson([...validated.na].sort()),
    context.evidenceText ?? null,
    context.ascendVersion,
    schemaVersion,
  );

  const warnings: ValidationIssue[] = [...validated.warnings];
  if (type.status === 'deprecated') {
    // Recorded, not refused: the type is still valid and the entry is still true. But a
    // recorder reaching for a retired type is usually working from a stale brief.
    warnings.push({
      field: 'type',
      problem: `${type.name} is deprecated`,
      fix: `The entry was recorded and remains valid. Prefer a current type if one fits.`,
    });
  }

  return {
    entry: {
      id: context.id,
      typeName: type.name,
      typeVersion: type.version,
      typeHash: type.typeHash,
      recordedAt: context.recordedAt,
      source,
      properties: validated.properties,
      na: validated.na,
      states: validated.states,
      runId: context.runId ?? null,
      workflow: context.workflow ?? null,
      actor: context.actor ?? null,
      cwd: context.cwd ?? null,
      repo: context.repo ?? null,
      gitSha: context.gitSha ?? null,
      branch: context.branch ?? null,
      evidenceText: context.evidenceText ?? null,
      ascendVersion: context.ascendVersion,
      schemaVersion,
    },
    warnings,
  };
}

/**
 * The registered version to record against: the named one, or the latest.
 *
 * `name` is canonicalized before the lookup (asc-pw2): `registerType` (registry.ts) stores
 * `canonicalizeTypeSpec(spec).spec.name`, so a type authored as `reviewKind` is on disk as
 * `review_kind`. This is the one write path (module comment above), so a caller naming the
 * type back under the spelling it was authored with -- the spelling `asc record` is most
 * likely to be handed -- was refused here even though `canonicalName` makes the row
 * findable. The ERROR still names the caller's raw spelling, not the canonical one: a typo
 * that matches nothing should be echoed back as typed, not silently refolded into a
 * near-miss the caller never wrote.
 */
function findRegisteredType(
  db: DatabaseSync,
  name: string,
  version: number | undefined,
): { name: string; version: number; typeHash: string; spec: TypeSpec; status: string } {
  const canonical = canonicalName(name);
  const row =
    version === undefined
      ? (db
          .prepare(
            'SELECT name, version, type_hash, spec_json, status FROM entry_types WHERE name = ? ORDER BY version DESC LIMIT 1',
          )
          .get(canonical) as TypeRow | undefined)
      : (db
          .prepare(
            'SELECT name, version, type_hash, spec_json, status FROM entry_types WHERE name = ? AND version = ?',
          )
          .get(canonical, version) as TypeRow | undefined);

  if (row === undefined) throw new UnknownTypeError(name, version, registeredTypes(db));

  return {
    name: row.name,
    version: row.version,
    typeHash: row.type_hash,
    spec: JSON.parse(row.spec_json) as TypeSpec,
    status: row.status,
  };
}

interface TypeRow {
  name: string;
  version: number;
  type_hash: string;
  spec_json: string;
  status: string;
}

interface EntryRow {
  id: string;
  type_name: string;
  type_version: number;
  type_hash: string;
  recorded_at: string;
  run_id: string | null;
  workflow: string | null;
  actor: string | null;
  source: string;
  cwd: string | null;
  repo: string | null;
  git_sha: string | null;
  branch: string | null;
  properties_json: string;
  na_json: string;
  evidence_text: string | null;
  ascend_version: string;
  schema_version: number;
}

/**
 * One entry by id, as it was written, or undefined.
 *
 * `states` is recomputed against the definition THIS ENTRY names -- not against the
 * type's latest version. An entry's states are a property of the definition it was
 * recorded against, so deriving them from whatever the type looks like today would
 * report three-state ratios for a shape the values never had.
 */
export function findEntry(db: DatabaseSync, id: string): RecordedEntry | undefined {
  const row = db
    .prepare(
      `SELECT id, type_name, type_version, type_hash, recorded_at, run_id, workflow, actor, source,
              cwd, repo, git_sha, branch, properties_json, na_json, evidence_text,
              ascend_version, schema_version
         FROM entries WHERE id = ?`,
    )
    .get(id) as EntryRow | undefined;

  if (row === undefined) return undefined;

  const type = db
    .prepare('SELECT spec_json FROM entry_types WHERE name = ? AND version = ?')
    .get(row.type_name, row.type_version) as { spec_json: string } | undefined;

  const properties = JSON.parse(row.properties_json) as Record<string, unknown>;
  const na = JSON.parse(row.na_json) as string[];

  // The definition is guaranteed present by the composite foreign key, so a missing one
  // means the key is not enforcing and the store is not the store it claims to be.
  if (type === undefined) {
    throw new Error(
      `entry '${row.id}' references ${row.type_name} version ${String(row.type_version)}, which is ` +
        `not registered. The composite foreign key should have made this impossible.`,
    );
  }

  const spec = JSON.parse(type.spec_json) as TypeSpec;

  // Derived by the same function that enforced it on write, so read and write cannot
  // disagree about what a state means. This also makes the read a self-check: the
  // foreign key guarantees the row names a real definition, but not that the row
  // SATISFIES it, and a row that violates its own definition is an integrity failure
  // worth hearing about rather than quietly reporting as data.
  const validated = validateEntry(spec, { properties, na });
  if (!validated.ok) {
    throw new Error(
      `entry '${row.id}' does not satisfy ${row.type_name} version ${String(row.type_version)}, the ` +
        `definition it names:\n` +
        validated.errors.map((issue) => `  ${issue.field}: ${issue.problem}`).join('\n'),
    );
  }

  return {
    id: row.id,
    typeName: row.type_name,
    typeVersion: row.type_version,
    typeHash: row.type_hash,
    recordedAt: row.recorded_at,
    source: row.source === 'derived:claude-code' ? 'derived:claude-code' : 'self',
    properties,
    na,
    states: validated.states,
    runId: row.run_id,
    workflow: row.workflow,
    actor: row.actor,
    cwd: row.cwd,
    repo: row.repo,
    gitSha: row.git_sha,
    branch: row.branch,
    evidenceText: row.evidence_text,
    ascendVersion: row.ascend_version,
    schemaVersion: row.schema_version,
  };
}
