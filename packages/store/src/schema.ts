/**
 * The SQLite schema, its migrations, and the versioning that guards them.
 *
 * Two properties are enforced HERE, in the database, rather than trusted to callers:
 *
 * 1. **Records are immutable.** Entries in full, and the SHAPE of a registered type
 *    version, cannot be rewritten. That is the product's central claim -- "entries are
 *    recorded without interpretation, and analysis is deferred" -- and a claim only a
 *    convention protects is one an UPDATE can quietly break. Triggers make it a hard
 *    error. The one deliberate exception is type PROSE (`description`, `record_when`):
 *    see the trigger comment below.
 *
 * 2. **A recorded entry cannot reference a definition that does not exist.** The
 *    composite foreign key on `(type_name, type_version, type_hash)` means an entry
 *    can only ever be attached to a definition whose identity EXACTLY matches. This
 *    is fold's confound #1 -- schema drifting under the data with nothing recording
 *    it -- made structurally impossible rather than merely detected.
 *
 * No empty-string sentinels: "unknown" is NULL, never `''`. SQLite treats `''` as a
 * real value, so an empty string in a foreign key or a filter matches and compares
 * as though it meant something (the `<project-E>` issues.parent_id trap). Every optional
 * text column carries a CHECK rejecting `''` for that reason.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const INITIAL = `
-- ---------------------------------------------------------------------------
-- Registered type definitions. The SHAPE is immutable: a new shape is a new row,
-- never an UPDATE. status (via "asc types deprecate") and the prose columns may
-- change; spec_json and type_hash may not. Prose is excluded from the identity on
-- purpose -- it guides the recorder, it does not describe the shape a stored value is
-- validated against, so rewording it must not invalidate a single entry.
-- ---------------------------------------------------------------------------
CREATE TABLE entry_types (
  name        TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  major       INTEGER NOT NULL,
  type_hash   TEXT    NOT NULL,
  spec_json   TEXT    NOT NULL,
  description TEXT,
  record_when TEXT,
  prose_json  TEXT,
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  TEXT    NOT NULL,

  PRIMARY KEY (name, version),

  -- Redundant against the primary key, and load-bearing anyway: it is the parent
  -- index the entries foreign key resolves against, which is what lets that key
  -- carry type_hash and so make drift impossible.
  UNIQUE (name, version, type_hash),

  CHECK (name <> ''),
  CHECK (version >= 1),
  CHECK (major >= 1),
  CHECK (type_hash <> ''),
  -- The spec is a declarative JSON document, never source. Storing zod source and
  -- eval-ing it would be arbitrary code execution, and unhashable (ARCHITECTURE.md).
  --
  -- It holds the SHAPE ONLY -- name and properties, with no prose at any level. That
  -- is exactly the input to type_hash (core's definitionShape), so the frozen column
  -- and the hashed value cannot describe different things.
  CHECK (json_valid(spec_json)),
  CHECK (json_type(spec_json) = 'object'),
  -- Per-property prose, keyed by property name. Outside spec_json on purpose: prose
  -- is not part of the identity, so a wording edit is an UPDATE here and mints no
  -- version (see the trigger below).
  CHECK (prose_json IS NULL OR json_valid(prose_json)),
  CHECK (prose_json IS NULL OR json_type(prose_json) = 'object'),
  CHECK (status IN ('active', 'deprecated')),
  CHECK (description IS NULL OR description <> ''),
  CHECK (record_when IS NULL OR record_when <> '')
);

-- The generated per-type views are per MAJOR, unioning the minor versions inside it
-- (ARCHITECTURE.md, "Versioning policy"). This is what that query resolves against.
CREATE INDEX idx_entry_types_major ON entry_types (name, major);

-- The SHAPE is immutable; the PROSE is not. spec_json and type_hash carry the
-- definition an entry's properties are validated against, so freezing them is the
-- whole point. description and record_when are guidance shown to the recorder --
-- improving that wording changes no stored value and invalidates no entry, so it is
-- an update, not a new version. This is why those two have their own columns
-- (ARCHITECTURE.md, "Storage") rather than living inside spec_json.
--
-- major is frozen with the shape even though it is not part of type_hash, because
-- it is what a generated view unions across: mutating it would silently merge two
-- incompatible families (or split one), and the view would then return a plausible
-- wrong answer over precisely the version boundary this column exists to draw. It is
-- derived from the bump and never edited afterwards -- a later version, not an UPDATE.
CREATE TRIGGER entry_types_identity_is_immutable
BEFORE UPDATE ON entry_types
WHEN OLD.name        <> NEW.name
  OR OLD.version     <> NEW.version
  OR OLD.major       <> NEW.major
  OR OLD.type_hash   <> NEW.type_hash
  OR OLD.spec_json   <> NEW.spec_json
  OR OLD.created_at  <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'entry_types identity is immutable: register a new version instead of updating one. Only status, description and record_when may change.');
END;

CREATE TRIGGER entry_types_cannot_be_deleted
BEFORE DELETE ON entry_types
BEGIN
  SELECT RAISE(ABORT, 'entry_types is immutable: a registered version cannot be deleted. Use status = deprecated.');
END;

-- ---------------------------------------------------------------------------
-- Entries. IMMUTABLE, in full. Invalidation is a reserved annotation scheme, not
-- an edit: the whole product depends on a recorded entry meaning the same thing
-- forever, so "this measured the wrong thing" is new information ABOUT a record,
-- never a change TO it.
-- ---------------------------------------------------------------------------
CREATE TABLE entries (
  id              TEXT    NOT NULL PRIMARY KEY,
  type_name       TEXT    NOT NULL,
  type_version    INTEGER NOT NULL,
  type_hash       TEXT    NOT NULL,
  recorded_at     TEXT    NOT NULL,
  run_id          TEXT,
  workflow        TEXT,
  actor           TEXT,
  source          TEXT    NOT NULL,
  cwd             TEXT,
  repo            TEXT,
  git_sha         TEXT,
  branch          TEXT,
  properties_json TEXT    NOT NULL DEFAULT '{}',
  na_json         TEXT    NOT NULL DEFAULT '[]',
  evidence_text   TEXT,
  ascend_version  TEXT    NOT NULL,
  schema_version  INTEGER NOT NULL,

  -- One constraint, three columns. An entry is attached to a definition only if
  -- the name, the version AND the hash all match a registered row.
  FOREIGN KEY (type_name, type_version, type_hash)
    REFERENCES entry_types (name, version, type_hash),

  CHECK (id <> ''),
  CHECK (recorded_at <> ''),
  CHECK (source IN ('self', 'derived:claude-code')),
  CHECK (ascend_version <> ''),
  CHECK (schema_version >= 1),

  -- Both documents are JSON of a specific shape, checked on write.
  CHECK (json_valid(properties_json)),
  CHECK (json_type(properties_json) = 'object'),
  CHECK (json_valid(na_json)),
  CHECK (json_type(na_json) = 'array'),

  -- No empty-string sentinels.
  CHECK (run_id         IS NULL OR run_id         <> ''),
  CHECK (workflow       IS NULL OR workflow       <> ''),
  CHECK (actor          IS NULL OR actor          <> ''),
  CHECK (cwd            IS NULL OR cwd            <> ''),
  CHECK (repo           IS NULL OR repo           <> ''),
  CHECK (git_sha        IS NULL OR git_sha        <> ''),
  CHECK (branch         IS NULL OR branch         <> ''),
  CHECK (evidence_text  IS NULL OR evidence_text  <> '')
);

CREATE TRIGGER entries_are_immutable
BEFORE UPDATE ON entries
BEGIN
  SELECT RAISE(ABORT, 'entries are immutable: invalidation is an annotation scheme, not an edit.');
END;

CREATE TRIGGER entries_cannot_be_deleted
BEFORE DELETE ON entries
BEGIN
  SELECT RAISE(ABORT, 'entries are immutable: an entry cannot be deleted once recorded.');
END;

-- Ledger-shaped indexes. The PER-TYPE composite expression indexes are not here:
-- they are emitted by the registry at type-registration time, per property, because
-- only then is the property set known (EV-storage.md).
CREATE INDEX idx_entries_type_time ON entries (type_name, recorded_at);
CREATE INDEX idx_entries_time      ON entries (recorded_at);
CREATE INDEX idx_entries_run       ON entries (run_id) WHERE run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Annotation schemes and annotations. Annotations are ADDITIVE (a later pass
-- labels existing entries) so, unlike entries, they are not immutable.
-- ---------------------------------------------------------------------------
CREATE TABLE annotation_schemes (
  name       TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  spec_json  TEXT    NOT NULL,
  created_at TEXT    NOT NULL,

  PRIMARY KEY (name, version),
  CHECK (name <> ''),
  CHECK (version >= 1),
  CHECK (json_valid(spec_json)),
  CHECK (json_type(spec_json) = 'object')
);

CREATE TABLE annotations (
  id             TEXT    NOT NULL PRIMARY KEY,
  entry_id       TEXT    NOT NULL,
  scheme         TEXT    NOT NULL,
  scheme_version INTEGER NOT NULL,
  label          TEXT    NOT NULL,
  value_json     TEXT,
  confidence     REAL,
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT    NOT NULL,

  FOREIGN KEY (entry_id) REFERENCES entries (id),
  FOREIGN KEY (scheme, scheme_version) REFERENCES annotation_schemes (name, version),

  CHECK (id <> ''),
  CHECK (label <> ''),
  CHECK (created_at <> ''),
  CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  CHECK (value_json  IS NULL OR json_valid(value_json)),
  CHECK (note         IS NULL OR note         <> ''),
  CHECK (created_by   IS NULL OR created_by   <> '')
);

CREATE INDEX idx_annotations_entry  ON annotations (entry_id);
CREATE INDEX idx_annotations_scheme ON annotations (scheme, label);

-- ---------------------------------------------------------------------------
-- Store-level key/value. Holds what belongs to the STORE rather than to a row --
-- which ascend version created it, and anything doctor needs to report later.
-- ---------------------------------------------------------------------------
CREATE TABLE meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  CHECK (key <> '')
);
`;

/**
 * FTS5 over `evidence_text` (EV-fts.md).
 *
 * **The tokenizer is `trigram`, and it was chosen on measurement, not inherited.** EV-fts ran a
 * three-arm bake-off on 40,000 real documents: `unicode61` and `porter` fail to retrieve a single
 * correct document for 40% of partial-token queries (coverage 60%), where `trigram` gets 100%.
 * A search that silently returns NOTHING is indistinguishable from "no such entry exists", which
 * is the worst available failure for an agent-facing query. The 5.2x index size and 13x build time
 * are real and were accepted; at ascend's scale both are negligible.
 *
 * **Why a standalone FTS table and not `content='entries'`.** Two reasons, in order:
 *
 * 1. `entries.id` is TEXT, so `entries` has only an IMPLICIT rowid -- and an external-content FTS
 *    table must key on `content_rowid`, which SQLite documents as something VACUUM "may change"
 *    for tables with no explicit INTEGER PRIMARY KEY. If that ever happened the index would keep
 *    resolving to the WRONG entry, silently, with no error -- the plausible-wrong-answer class the
 *    whole store is built to prevent. Measured before deciding: four scenarios (delete a middle
 *    third, delete the first half, delete everything, no writes) followed by VACUUM, and the
 *    surviving rowids were STABLE in all four. So this is a documented caveat that did not
 *    reproduce, not a demonstrated defect -- but the guarantee it would need is absent, and the
 *    cost of avoiding it entirely is one duplicated text column.
 * 2. `entry_id` is stored explicitly, so the join key is a column ascend owns rather than an
 *    internal storage detail. It also keeps the snippet source and the index in one place.
 *
 * **No UPDATE or DELETE trigger, and that is not an omission.** `entries` is immutable -- the
 * triggers in migration 1 refuse both operations outright -- so INSERT is the only event that can
 * desynchronise the index and the only one that needs handling. mast fought an expensive
 * delete-scan here (`fts-delete-guard.test.ts`: 91.7% of the write phase, growing with exponent
 * 2.35) and needed a per-file rowid block to make it affordable (`fts-rowid-block.test.ts`).
 * **That entire class of problem does not exist for ascend**, and none of that machinery is
 * ported. FTS5's `xBestIndex` will not consume an equality constraint on a non-rowid column, so
 * any such delete would be a full scan -- the right response is to not have one.
 *
 * **`evidence_text` is column 0 on purpose.** `snippet()` and `bm25()` address columns by index,
 * and `entry_id` is UNINDEXED, so it contributes nothing to the rank.
 *
 * **The backfill is load-bearing.** Entries recorded before this migration already exist, and an
 * index built only from future inserts would make every one of them unsearchable with no error
 * anywhere -- the silent-zero-result failure EV-fts measured as worse than a crash. The INSERT
 * ... SELECT below is what prevents it, and the migration test asserts a pre-migration entry is
 * findable afterwards.
 */
const FTS = `
CREATE VIRTUAL TABLE entries_fts USING fts5(
  evidence_text,
  entry_id UNINDEXED,
  tokenize = 'trigram'
);

-- Entries that predate this migration. Without this they are invisible to search and nothing
-- reports it -- the silent-zero failure mode, arriving through the migration path instead of
-- through the query path.
INSERT INTO entries_fts (evidence_text, entry_id)
  SELECT evidence_text, id FROM entries WHERE evidence_text IS NOT NULL;

CREATE TRIGGER entries_fts_on_insert
AFTER INSERT ON entries
WHEN NEW.evidence_text IS NOT NULL
BEGIN
  INSERT INTO entries_fts (evidence_text, entry_id) VALUES (NEW.evidence_text, NEW.id);
END;
`;

/**
 * Every migration, in order.
 *
 * Append-only FROM THE FIRST RELEASE ON: an existing entry is never edited, because a
 * store in the field has already run it, records that version as applied, and would
 * never re-run a changed one -- so an edit would reach new stores only, and the two
 * populations would diverge with nothing reporting it.
 *
 * That reason does not hold yet, and the boundary is worth stating rather than
 * assuming. ascend has never been released; no store has ever existed outside a test's
 * temp directory, and none is committed (`.ascend/` is gitignored). So the initial
 * schema is still fixed IN PLACE, and migration 1 carries a `major` immutability check
 * that was added after it first ran. A patch migration here would leave permanent
 * residue describing a defect no user ever had -- and would spend a version number that
 * a real schema change should get. Once ascend ships, this stops being true and the
 * rule becomes absolute.
 *
 * Migration 2 is a genuine schema change, so it is a genuine new migration rather than
 * an edit to migration 1 -- which is also what makes it the first exercise of the
 * migration path, and the reason its test opens a version-1 store and migrates it.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sql: INITIAL },
  { version: 2, name: 'full-text search over evidence_text', sql: FTS },
];

/** The schema version this build of ascend writes. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/** The store's own schema version, from SQLite's `user_version` pragma. */
export function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/** Thrown when a store was written by a newer ascend than this one. */
export class NewerSchemaError extends Error {
  constructor(
    readonly storeVersion: number,
    readonly buildVersion: number,
  ) {
    super(
      `this store is at schema version ${String(storeVersion)} but this build of ascend only knows ` +
        `up to ${String(buildVersion)}. Opening it could corrupt data written by a newer ascend. ` +
        `Upgrade ascend, or point it at a different project.`,
    );
    this.name = 'NewerSchemaError';
  }
}

/**
 * Apply every migration this store has not yet run.
 *
 * Each migration runs in its own transaction together with the `user_version` bump,
 * so a failure part-way leaves the store exactly where it was rather than half
 * migrated. `PRAGMA user_version` is transactional -- verified, not assumed -- which
 * is what makes that atomic.
 *
 * Idempotent: running it against a current store applies nothing.
 *
 * `migrations` is injectable so the rollback path can be tested with a deliberately
 * failing migration. Production always uses the default.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const from = userVersion(db);
  const target = migrations.reduce((highest, m) => Math.max(highest, m.version), 0);

  if (from > target) throw new NewerSchemaError(from, target);

  const pending = migrations
    .filter((migration) => migration.version > from)
    .sort((left, right) => left.version - right.version);

  const applied: string[] = [];

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `migration ${String(migration.version)} (${migration.name}) failed and was rolled back: ${detail}`,
      );
    }
    applied.push(migration.name);
  }

  return { from, to: target, applied };
}
