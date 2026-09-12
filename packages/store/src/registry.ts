/**
 * The type registry: the only place an entry type is registered.
 *
 * The rule this module exists to enforce: **a shape change INSERTS a new version row;
 * it never UPDATEs.** A registered definition is what an entry's properties were
 * validated against, so rewriting one would silently reinterpret every entry already
 * recorded under it -- fold's confound #1, where the schema drifted under the data and
 * nothing recorded that it had. The database enforces it with triggers, but callers
 * must never be *asking* for an update in the first place, which is what this does.
 *
 * Identity is the SHAPE, not the prose. `type_hash` is computed over
 * `definitionShape(spec)` -- the fields a validator actually reads -- so two runs that
 * described the same shape in different words register as the SAME definition, and an
 * entry recorded under either wording attaches to both. The reasoning is in
 * core/src/spec.ts; the consequence here is that registering is IDEMPOTENT: registering
 * an already-known shape writes nothing and reports `unchanged`.
 *
 * Time is injected, never read. `registeredAt` is a parameter for the same reason core
 * takes a clock: a store whose rows carry an ambient timestamp cannot be tested
 * against fixtures, and `asc` has to be reproducible.
 */

import {
  canonicalizeTypeSpec,
  definitionShape,
  diffTypeSpec,
  typeHash,
  type Bump,
  type Rename,
  type SpecChange,
  type TypeSpec,
} from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { refreshTypeViews } from './views.js';

export interface RegisterTypeOptions {
  /**
   * ISO-8601 UTC. Injected -- the registry never reads a clock.
   */
  readonly registeredAt: string;
  /** Prose shown by `asc types brief`. Not part of the identity; editable in place. */
  readonly description?: string;
  readonly recordWhen?: string;
  /** Per-property prose, keyed by canonical property name. Also not identity. */
  readonly prose?: Readonly<Record<string, string>>;
}

export interface RegisteredType {
  readonly name: string;
  readonly version: number;
  /** The major-version family a generated view unions across. */
  readonly major: number;
  readonly typeHash: string;
  /** `unchanged` means this exact shape was already registered; nothing was written. */
  readonly outcome: 'created' | 'unchanged';
  /** `none` when unchanged. Otherwise the worst change against the previous version. */
  readonly bump: Bump;
  readonly changes: readonly SpecChange[];
  /** Names canonicalization rewrote, so callers can tell the user what was changed. */
  readonly renames: readonly Rename[];
  /** Legal but almost certainly a mistake. Never blocks registration. */
  readonly warnings: readonly string[];
}

/** A registered version, as read back out of the store. */
export interface TypeVersionRow {
  readonly name: string;
  readonly version: number;
  readonly major: number;
  readonly typeHash: string;
  readonly spec: TypeSpec;
  readonly description: string | null;
  readonly recordWhen: string | null;
  readonly prose: Readonly<Record<string, string>>;
  readonly status: 'active' | 'deprecated';
  readonly registeredAt: string;
}

interface VersionRowShape {
  name: string;
  version: number;
  major: number;
  type_hash: string;
  spec_json: string;
  description: string | null;
  record_when: string | null;
  prose_json: string | null;
  status: string;
  created_at: string;
}

/**
 * The stored shape of a spec: prose stripped, prose columns kept.
 *
 * This is the single place the split between identity and prose is applied to STORAGE,
 * so `spec_json`, `type_hash` and the prose columns cannot describe different things.
 */
const toStorage = (
  spec: TypeSpec,
  options: RegisterTypeOptions,
): {
  shape: TypeSpec;
  proseJson: string | null;
} => {
  const shape = definitionShape(spec);

  // Per-property prose, keyed by the canonical property name, collected from the spec
  // itself and overridden by anything passed explicitly.
  const prose: Record<string, string> = {};
  for (const property of spec.properties) {
    if (property.description !== undefined) prose[property.name] = property.description;
  }
  for (const [key, value] of Object.entries(options.prose ?? {})) {
    prose[key] = value;
  }

  return {
    shape,
    proseJson: Object.keys(prose).length === 0 ? null : JSON.stringify(prose),
  };
};

/**
 * Register a type definition, or report that this shape is already known.
 *
 * Idempotent on shape. Never updates a registered row's identity -- see the module
 * comment. `asc types deprecate` and prose edits are separate operations, because they
 * are the only changes a registered version permits.
 */
export function registerType(
  db: DatabaseSync,
  spec: TypeSpec,
  options: RegisterTypeOptions,
): RegisteredType {
  const canonical = canonicalizeTypeSpec(spec);
  const { shape, proseJson } = toStorage(canonical.spec, options);
  const hash = typeHash(shape);

  const known = db
    .prepare('SELECT version, major FROM entry_types WHERE name = ? AND type_hash = ?')
    .get(shape.name, hash) as { version: number; major: number } | undefined;

  if (known !== undefined) {
    return {
      name: shape.name,
      version: known.version,
      major: known.major,
      typeHash: hash,
      outcome: 'unchanged',
      bump: 'none',
      changes: [],
      renames: canonical.renames,
      warnings: canonical.warnings,
    };
  }

  const latest = db
    .prepare(
      'SELECT version, major, spec_json FROM entry_types WHERE name = ? ORDER BY version DESC LIMIT 1',
    )
    .get(shape.name) as { version: number; major: number; spec_json: string } | undefined;

  let version = 1;
  let major = 1;
  let bump: Bump = 'major';
  let changes: readonly SpecChange[] = [];

  if (latest !== undefined) {
    // Both sides are already the stored projection: prose-free, canonical, and with the
    // fields that constrain nothing normalized out.
    const previous = JSON.parse(latest.spec_json) as TypeSpec;
    const diff = diffTypeSpec(previous, shape);

    // Verified, not assumed: core's diff classifies every shape difference, and a test
    // enumerates the variations to prove it. If this ever fires, two specs hashed
    // differently while the diff saw no change -- which would mean the hash covers a
    // field the diff does not know about, and the bump below would be a guess.
    if (diff.bump === 'none') {
      throw new Error(
        `type '${shape.name}' hashes differently from version ${String(latest.version)} but the ` +
          `shape comparison found no difference. This is a bug in @ascend/core's diff: ` +
          `definitionShape and diffTypeSpec disagree about what a definition is.`,
      );
    }

    version = latest.version + 1;
    // A major bump starts a new family, which generated views must NOT union across.
    // A minor bump stays in the family. There is no third case: `none` is unreachable
    // above, and `minor`/`major` are the only other members of Bump.
    major = diff.bump === 'major' ? latest.major + 1 : latest.major;
    bump = diff.bump;
    changes = diff.changes;
  }

  // The version row and the views derived from it are one unit. A committed version whose
  // views are missing is a store where `asc query` fails on a type that registered fine, so
  // both go in one transaction. `isTransaction` means a caller's transaction is joined
  // rather than nested into -- SQLite rejects a nested BEGIN outright.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');

  try {
    db.prepare(
      `INSERT INTO entry_types
         (name, version, major, type_hash, spec_json, description, record_when, prose_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      shape.name,
      version,
      major,
      hash,
      JSON.stringify(shape),
      options.description ?? null,
      options.recordWhen ?? null,
      proseJson,
      options.registeredAt,
    );

    // Derived, never authored: the view and index set are a pure function of the registered
    // versions, so they are rebuilt from the registry rather than accumulated.
    refreshTypeViews(db, shape.name);

    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }

  return {
    name: shape.name,
    version,
    major,
    typeHash: hash,
    outcome: 'created',
    bump,
    changes,
    renames: canonical.renames,
    warnings: canonical.warnings,
  };
}

const rowToVersion = (row: VersionRowShape): TypeVersionRow => ({
  name: row.name,
  version: row.version,
  major: row.major,
  typeHash: row.type_hash,
  spec: JSON.parse(row.spec_json) as TypeSpec,
  description: row.description,
  recordWhen: row.record_when,
  prose: row.prose_json === null ? {} : (JSON.parse(row.prose_json) as Record<string, string>),
  status: row.status === 'deprecated' ? 'deprecated' : 'active',
  registeredAt: row.created_at,
});

const SELECT_VERSION = `SELECT name, version, major, type_hash, spec_json, description, record_when,
                                prose_json, status, created_at
                           FROM entry_types`;

/**
 * Every version of a type, oldest first.
 *
 * All of them, not just the latest: a query that unions minor versions needs each
 * version's own property list, since that is what its entries were validated against.
 */
export function typeVersions(db: DatabaseSync, name: string): readonly TypeVersionRow[] {
  const rows = db
    .prepare(`${SELECT_VERSION} WHERE name = ? ORDER BY version ASC`)
    .all(name) as unknown as VersionRowShape[];
  return rows.map(rowToVersion);
}

/**
 * The version of a type, or the latest one when `version` is omitted.
 *
 * Returns undefined rather than throwing: "not registered" is an ordinary answer for
 * `asc types show`, and the caller decides what it means.
 */
export function findType(
  db: DatabaseSync,
  name: string,
  version?: number,
): TypeVersionRow | undefined {
  const row =
    version === undefined
      ? (db.prepare(`${SELECT_VERSION} WHERE name = ? ORDER BY version DESC LIMIT 1`).get(name) as
          VersionRowShape | undefined)
      : (db.prepare(`${SELECT_VERSION} WHERE name = ? AND version = ?`).get(name, version) as
          VersionRowShape | undefined);
  return row === undefined ? undefined : rowToVersion(row);
}

/**
 * Retire a type without deleting or rewriting it.
 *
 * Deprecation is a status change, not a version: entries recorded under a deprecated
 * type remain valid and remain queryable. Deleting or editing them would be the
 * rewrite the whole store is built to prevent.
 */
export function deprecateType(db: DatabaseSync, name: string): number {
  const result = db
    .prepare(
      "UPDATE entry_types SET status = 'deprecated' WHERE name = ? AND status <> 'deprecated'",
    )
    .run(name);
  return Number(result.changes);
}

/**
 * Replace a registered version's prose.
 *
 * The one permitted edit to a registered version, and only because prose is not part
 * of the identity: it changes what the recorder is TOLD, never what a stored value
 * means, so no entry is invalidated and no version is minted. The database trigger
 * permits exactly this and refuses everything else.
 *
 * `undefined` leaves a field alone; `null` clears it. The two are different requests,
 * which is why the parameter is not simply optional-and-truthy.
 */
export function updateTypeProse(
  db: DatabaseSync,
  name: string,
  version: number,
  prose: {
    readonly description?: string | null;
    readonly recordWhen?: string | null;
    readonly propertyProse?: Readonly<Record<string, string>>;
  },
): void {
  const existing = findType(db, name, version);
  if (existing === undefined) {
    throw new Error(`type '${name}' version ${String(version)} is not registered`);
  }

  const nextProse =
    prose.propertyProse === undefined
      ? existing.prose
      : { ...existing.prose, ...prose.propertyProse };

  db.prepare(
    `UPDATE entry_types
        SET description = ?, record_when = ?, prose_json = ?
      WHERE name = ? AND version = ?`,
  ).run(
    prose.description === undefined ? existing.description : prose.description,
    prose.recordWhen === undefined ? existing.recordWhen : prose.recordWhen,
    Object.keys(nextProse).length === 0 ? null : JSON.stringify(nextProse),
    name,
    version,
  );
}
