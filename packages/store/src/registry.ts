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
  canonicalName,
  canonicalizeTypeSpec,
  confusableNames,
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
  /**
   * Do the whole registration, then discard it.
   *
   * Not a simulation and not a separate code path: the validation, the bump diff and the
   * view/index generation all run for real, inside a transaction that is rolled back
   * instead of committed. A caller gets the same `RegisteredType` it would have got, and
   * the store is left byte-for-byte as it was -- which is the only kind of preview worth
   * offering, since a preview computed by a second implementation is a preview of *that*
   * implementation.
   */
  readonly dryRun?: boolean;
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

/**
 * Thrown when canonicalization produced a reason a definition cannot be USED, however it is spelled.
 *
 * Nothing is written: the version row, its indexes and its view are all refused together, so a
 * store never holds a definition whose view cannot be built faithfully. See `reservedPropertyName`
 * in `@ascend/core` for why the reserved names are taken.
 *
 * Named for the whole class rather than for the reserved-name case that first needed it (asc-0w9):
 * `ReservedPropertyNameError` was accurate while a reserved collision was the only way to get here,
 * and stopped being accurate the moment an empty name was refused too. The header says "problem(s)"
 * for the same reason -- a name that canonicalizes to empty is a problem with the NAME, not with a
 * projection, and `type name '' canonicalizes to empty` is not a sentence about a property.
 */
export class UnusableDefinitionError extends Error {
  constructor(
    readonly typeName: string,
    readonly problems: readonly string[],
  ) {
    // An empty type name cannot be quoted into "in '...'", and it is exactly the case this
    // sentence would otherwise render as a blank.
    const subject = typeName === '' ? 'this definition' : `'${typeName}'`;
    super(
      `${String(problems.length)} problem(s) make ${subject} unusable, so nothing was registered:\n` +
        problems.map((problem) => `  ${problem}`).join('\n'),
    );
    this.name = 'UnusableDefinitionError';
  }
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
/**
 * The identity of a definition: its canonical shape, hashed.
 *
 * Exported because identity must have exactly ONE definition in the codebase. `asc types
 * import` has to check that a definition moved between projects still hashes to what the
 * document says it does, and a CLI that recomputed this itself would be a second
 * implementation of the thing the check exists to protect -- the two would agree until the
 * day one of them was changed, and the disagreement would look like drifted data rather
 * than like a bug here.
 *
 * Takes a RAW spec, canonicalizing internally, because that is what a caller has: the
 * canonical form is an implementation detail of registration, not something a document or
 * a caller is expected to hold.
 */
export function specHash(spec: TypeSpec): string {
  return typeHash(definitionShape(canonicalizeTypeSpec(spec).spec));
}

const toStorage = (
  spec: TypeSpec,
  options: RegisterTypeOptions,
): {
  shape: TypeSpec;
  proseJson: string | null;
} => {
  const shape = definitionShape(spec);

  // Per-property prose, keyed by the canonical property name, collected from the spec
  // itself and overridden by anything passed explicitly. A null-prototype map for the same
  // reason as `state.ts`'s `validateEntry`: the keys are user-controlled names.
  const prose = Object.create(null) as Record<string, string>;
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
 * Every name this store has already seen: the type names, and every property name ever defined.
 *
 * Property names are read out of `spec_json` rather than from a projection, and from **every
 * version**, because the vocabulary is "names this store has used" -- a property that only ever
 * appeared in v1 is still a name a caller may be about to reinvent under a different spelling, and
 * that is the drift this serves. A projection would have to be kept in step with the spec shape;
 * reading the stored spec cannot drift from it.
 *
 * Cost is one row per registered version, which is small by construction (types are defined by
 * hand or by a model at define time, not per entry). Measured against the 4 starter types: 8 rows,
 * and the whole check does not register on a define that already writes a row and builds a view.
 */
export function registeredNames(db: DatabaseSync): {
  readonly types: readonly string[];
  readonly properties: readonly string[];
} {
  const types = (
    db.prepare('SELECT DISTINCT name FROM entry_types ORDER BY name').all() as {
      name: string;
    }[]
  ).map((row) => row.name);

  const properties = new Set<string>();
  const rows = db.prepare('SELECT spec_json FROM entry_types').all() as { spec_json: string }[];
  for (const row of rows) {
    const spec = JSON.parse(row.spec_json) as { properties?: { name?: unknown }[] };
    for (const property of spec.properties ?? []) {
      if (typeof property.name === 'string') properties.add(property.name);
    }
  }

  return { types, properties: [...properties].sort() };
}

/**
 * What a definition reuses from the registry, and what is new that a caller may not have meant.
 *
 * **All warnings, never refusals, and that is the measurement's decision rather than a preference.**
 * `EV-drift` measured that two independent definitions of the *same* concept agree on **0.300** of
 * their property names (intersection/union **0.091**, 4 of 44 names shared by all five authors).
 * A refusal threshold above that figure refuses legitimate new work; one below it admits everything.
 * At a 0.300 signal, similarity cannot separate "same concept, new name" from "different concept",
 * so nothing here blocks. See `core/src/names.ts` for why the check carries no threshold at all.
 *
 * A name is reported only when it shares a whole token with a registered one -- a certain relation,
 * so nothing has to be tuned. Properties that are already registered are NOT reported: reusing a
 * registered name is the outcome `EV-drift` asked for, and warning about it would be warning about
 * success.
 *
 * **The type-name half is skipped when the name is already registered, and that is not an
 * optimization.** `registerType` returns `created` for a new VERSION of a known type as well as for
 * a first version, so without this gate every future version bump of `code_review` would re-print
 * "shares 'review' with 'code_review_note'" -- a true sentence, delivered on each bump, until the
 * author learned to ignore the whole channel. A warning that is always present carries no
 * information. "Is this name already registered?" is a certain relation like token sharing, so
 * there is still no number to pick: if the name is registered, this is not a second name for a
 * concept, which is the only thing this half is for. The property half is naturally immune -- a
 * property already registered is skipped above -- and a genuinely new property on a new version is
 * still reported, which is the case that matters.
 */
function vocabularyNotes(db: DatabaseSync, spec: TypeSpec): readonly string[] {
  const known = registeredNames(db);
  const notes: string[] = [];

  const name = canonicalName(spec.name);
  const isNewName = !known.types.some((registered) => canonicalName(registered) === name);
  const types = isNewName ? confusableNames(spec.name, known.types) : [];
  if (types.length > 0) {
    notes.push(
      `the type name '${spec.name}' shares ${describeShared(types)} with registered ` +
        `${types.length === 1 ? 'type' : 'types'} ${listNames(types)}. If this is the same ` +
        `concept, register it as a new version of that type -- a second name for one concept is ` +
        `the drift EV-drift measured at 0.091 property-name agreement.`,
    );
  }

  const registered = new Set(known.properties.map((name) => canonicalName(name)));
  for (const property of spec.properties) {
    if (registered.has(canonicalName(property.name))) continue;

    const matches = confusableNames(property.name, known.properties);
    if (matches.length === 0) continue;

    notes.push(
      `the property '${property.name}' is new here and shares ${describeShared(matches)} with ` +
        `${matches.length === 1 ? 'the registered name' : 'registered names'} ` +
        `${listNames(matches)}. Reuse the registered name if it means the same thing.`,
    );
  }

  return notes;
}

/**
 * How many candidate names a single note prints before summarising the rest.
 *
 * A number chosen for readability and said so: this text is read by a person deciding whether two
 * names mean one thing, and a list of a dozen is one they will skim. Three real names is enough to
 * recognise the collision.
 */
const SHOWN = 3;

/**
 * The candidate names, quoted so a name containing punctuation reads correctly.
 *
 * Truncation is REPORTED rather than silent. `confusableNames` returns every match, and the first
 * version of this message listed the first three as though they were all of them -- so a name
 * overlapping six registered ones produced a sentence naming three, which a reader takes as complete.
 * That is a message that understates what was found, and the count it withholds is exactly the part
 * that would tell the author how crowded the vocabulary already is.
 *
 * `'a'`, `'a' and 'b'`, `'a', 'b' and 'c'`, `'a', 'b', 'c' and 4 more` -- the comma is dropped for two
 * because `'a', and 'b'` reads worse than the conjunction alone.
 */
const listNames = (matches: readonly { readonly name: string }[]): string => {
  const shown = matches.slice(0, SHOWN).map((match) => `'${match.name}'`);
  const rest = matches.length - shown.length;

  const list =
    shown.length <= 2
      ? shown.join(' and ')
      : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`;
  return rest === 0 ? list : `${list}, and ${String(rest)} more`;
};

/** `'review'` or `'review' and 'code'` -- the shared tokens, spelled out for the message. */
const describeShared = (matches: readonly { readonly shared: readonly string[] }[]): string =>
  [...new Set(matches.flatMap((match) => match.shared))]
    .sort()
    .map((token) => `'${token}'`)
    .join(' and ');

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

  // Checked before anything else. A dry run promises that the store is left unchanged, and
  // inside a caller's transaction that promise cannot be kept: the writes would be the
  // caller's to commit or roll back, so `registerType` could return a preview and still have
  // written the thing it previewed. Refusing is the only honest answer -- and it is checked
  // here rather than at the rollback because a caller should learn this before their own
  // transaction has done any work.
  if (options.dryRun === true && db.isTransaction) {
    throw new Error(
      'registerType cannot dry-run inside a caller-managed transaction: the writes would be ' +
        "the caller's to commit, so nothing here could guarantee the store is left unchanged.",
    );
  }

  // Refused before anything else, including the idempotence check: a spec whose view cannot be
  // built must not be reported as `unchanged` either, or a store that already holds such a
  // definition would look like it had accepted this one.
  if (canonical.errors.length > 0) {
    throw new UnusableDefinitionError(canonical.spec.name, canonical.errors);
  }

  const { shape, proseJson } = toStorage(canonical.spec, options);
  const hash = specHash(shape);

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

  // Computed BEFORE the insert, and that ordering is load-bearing rather than tidy. The check reads
  // the registered vocabulary out of `entry_types`; run after the insert, this spec's own
  // properties would already be in that set, every one of them would be skipped as "already
  // registered", and the property half would be silently inert -- a check that reports nothing
  // while appearing to have run. Read before, it answers the question it exists for: what did the
  // registry hold when this definition was proposed?
  const notes = vocabularyNotes(db, shape);

  // The version row and the views derived from it are one unit. A committed version whose
  // views are missing is a store where `asc query` fails on a type that registered fine, so
  // both go in one transaction. `isTransaction` means a caller's transaction is joined
  // rather than nested into -- SQLite rejects a nested BEGIN outright.
  //
  // `IMMEDIATE`, matching the store's own `withTransaction` (B4). What that buys here is narrower
  // than it first looks, and the narrowness is written down because the alternative was a comment
  // claiming more than the code does. Every version read above -- `known`, `latest`, and
  // `vocabularyNotes` -- happens BEFORE this line, outside any transaction, so this does NOT close
  // the check-then-act race between them and the INSERT below: two concurrent registrations can
  // still both compute version N, and the loser still fails on the `(name, version)` UNIQUE
  // constraint. Closing that needs the BEGIN moved above the reads, the `unchanged` early return
  // turned into a COMMIT, and a rollback on the `diff.bump === 'none'` throw -- one transaction
  // around the whole body, which is a restructure rather than a transaction mode (asc-odh).
  //
  // What IMMEDIATE does close is the snapshot window inside the INSERT itself: the statement
  // probes the unique index before it writes, and under a deferred BEGIN that probe is what
  // establishes the read snapshot, so a concurrent commit landing after it would fail the insert
  // with `SQLITE_BUSY_SNAPSHOT` -- which no busy timeout can wait out. See `db.ts`'s
  // `withTransaction` for the mechanism and the measurement.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');

  // This function's own record of whether it has already ended the transaction, cleared only
  // after the statement that ends it returned. Not a re-read of `db.isTransaction`: `exec`
  // changes that property, which TypeScript's flow analysis does not model, so through the
  // `ownsTransaction` alias above it reads as permanently `false` -- a guard that looks dead
  // while guarding the thing it exists for.
  let ended = false;

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

    // A dry run still runs all of the above -- that is what makes it a preview of this
    // registration rather than of a description of it -- and then throws the work away.
    // `ownsTransaction` is necessarily true for a dry run: the guard at the top of this
    // function refuses one that would join a caller's transaction.
    if (options.dryRun === true) {
      db.exec('ROLLBACK');
      ended = true;
    } else if (ownsTransaction) {
      db.exec('COMMIT');
      ended = true;
    }
  } catch (error) {
    // `ended` as well as `ownsTransaction`, so a rollback that has already run -- the dry-run
    // path's, when the rollback of a rollback is what failed -- is not attempted twice.
    // Rolling back a transaction that is no longer open is its own error, and it would mask
    // the one being reported. Set after the statement rather than before, so a rollback that
    // itself threw still gets cleaned up by this path.
    if (ownsTransaction && !ended) db.exec('ROLLBACK');
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
    warnings: [...canonical.warnings, ...notes],
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
 * One type, summarised: enough for `asc types list` and for the checks `asc doctor` runs
 * (a type registered but never recorded is the "dead rule" signal that tool reports).
 *
 * A summary rather than a `TypeVersionRow` per type, because the two callers want the
 * LATEST version of each type plus counts, and building that from `typeVersions` would
 * mean N+1 queries and every full spec crossing the boundary to be counted.
 */
export interface TypeSummary {
  readonly name: string;
  readonly latestVersion: number;
  /** The version's major family -- the boundary its generated view unions within. */
  readonly major: number;
  readonly versionCount: number;
  readonly typeHash: string;
  readonly status: 'active' | 'deprecated';
  readonly propertyCount: number;
  /**
   * Entries recorded against ANY version of this type.
   *
   * Any version, not just the latest, because this is the denominator of "is this type
   * used at all" -- a type whose only entries are on v1 is used, and reporting 0 by
   * counting only the latest version's rows would file it as dead.
   */
  readonly entryCount: number;
  readonly description: string | null;
  readonly recordWhen: string | null;
}

interface SummaryRowShape {
  name: string;
  latest_version: number;
  major: number;
  type_hash: string;
  status: string;
  description: string | null;
  record_when: string | null;
  property_count: number;
  version_count: number;
  entry_count: number;
}

/**
 * Every registered type, alphabetically, deprecated ones included.
 *
 * Deprecated types are NOT filtered out here. A list that silently hides them is how a
 * project forgets it ever defined one, and `status` is right there for a caller that
 * wants to filter. `asc types list` decides how to show them; this reports what is
 * registered.
 */
export function listTypes(db: DatabaseSync): readonly TypeSummary[] {
  const rows = db
    .prepare(
      // The latest version of each name, its version count, and its entry count -- one
      // statement, so the three cannot be read at three different moments.
      //
      // `property_count` is counted in SQL rather than by parsing spec_json here: it is
      // the only thing this function needs from the spec, and shipping every full
      // definition across the boundary to call `.length` on one array would make a summary
      // cost what a full read costs.
      `SELECT t.name, t.version AS latest_version, t.major, t.type_hash, t.status,
              t.description, t.record_when,
              json_array_length(t.spec_json, '$.properties') AS property_count,
              v.version_count, COALESCE(e.entry_count, 0) AS entry_count
         FROM entry_types AS t
         JOIN (SELECT name, MAX(version) AS max_version, COUNT(*) AS version_count
                 FROM entry_types GROUP BY name) AS v
           ON v.name = t.name AND v.max_version = t.version
         LEFT JOIN (SELECT type_name, COUNT(*) AS entry_count
                      FROM entries GROUP BY type_name) AS e
           ON e.type_name = t.name
        ORDER BY t.name ASC`,
    )
    .all() as unknown as SummaryRowShape[];

  return rows.map((row) => ({
    name: row.name,
    latestVersion: row.latest_version,
    major: row.major,
    versionCount: row.version_count,
    typeHash: row.type_hash,
    status: row.status === 'deprecated' ? 'deprecated' : 'active',
    // No `Number(...)` coercion: node:sqlite hands back a plain `number` for both
    // `COUNT(*)` and `json_array_length`, and it never substitutes a bigint. Measured --
    // an integer past `Number.MAX_SAFE_INTEGER` raises
    // `RangeError: Value is too large to be represented as a JavaScript number` rather
    // than arriving as one. So a coercion here would be dead code that reads like a
    // guard, which is worse than no guard: the next reader would believe bigints are
    // handled and stop looking.
    propertyCount: row.property_count,
    entryCount: row.entry_count,
    description: row.description,
    recordWhen: row.record_when,
  }));
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
