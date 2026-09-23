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
 *    is the schema-drift confound -- schema drifting under the data with nothing recording
 *    it -- made structurally impossible rather than merely detected.
 *
 * No empty-string sentinels: "unknown" is NULL, never `''`. SQLite treats `''` as a
 * real value, so an empty string in a foreign key or a filter matches and compares
 * as though it meant something -- a column that also holds a foreign key then has
 * rows pointing at a "parent" that is the absence of one. Every optional text column
 * carries a CHECK rejecting `''` for that reason.
 */

import type { DatabaseSync } from 'node:sqlite';
import { refreshTypeViews } from './views.js';

/**
 * What a `SqlMigration` leaves in the file as proof it ran: a new `sqlite_master` name, or a new
 * column on an existing table. See `SqlMigration.marker`.
 */
type Marker = string | { readonly table: string; readonly column: string };

/**
 * A migration whose body is a fixed SQL string.
 *
 * This is the ordinary case: `CREATE TABLE`, `CREATE VIRTUAL TABLE`, and friends are the same
 * text on every store, because they do not depend on anything the store itself holds.
 */
interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /**
   * One name this migration's DDL adds to `sqlite_master` that no earlier migration adds --
   * proof, read from the file itself, that this migration ran, independent of what the
   * `user_version` ledger claims. See `LedgerMismatchError`: the ledger is one integer with no
   * content check, so it is one wrong write away from disagreeing with the tables it describes
   * (asc-u11), and this is what lets `migrate` tell "genuinely pending" from "the ledger is
   * wrong" before it runs DDL against an object that already exists.
   *
   * **Required here, and nowhere else.** The check this field powers protects DDL that is NOT
   * idempotent -- `CREATE TABLE entries` fails outright on a table that already exists, so
   * `migrate` has to know, before running it, whether the failure it is about to risk would mean
   * "this genuinely has not run" or "the ledger lied". A `marker` is how it knows. See
   * `ProceduralMigration` for the arm that has no such field, and why it needs none.
   *
   * **A name, or a column.** Most migrations create a new `sqlite_master` name, and that name is
   * the marker. An `ALTER TABLE ... ADD COLUMN` creates no name at all, yet it is just as
   * non-idempotent -- a second run fails with `duplicate column name` (probed, node v24.18.0 /
   * SQLite 3.53.4) -- so it needs the same protection, and the column itself is the evidence:
   * `pragma_table_info` reads it back from the file exactly as `sqlite_master` reads a name.
   * Migration 5 (asc-bli.1) is the first such migration; decision entry `150897fe` records why
   * this was chosen over a decorative companion object or a procedural arm.
   */
  readonly marker: Marker;
  /**
   * Never present on an `sql` migration -- see `Migration`'s own doc for why this field has to
   * exist at all, typed as `never`, rather than being left off `SqlMigration` and trusted to
   * TypeScript's structural typing.
   */
  readonly run?: never;
}

/**
 * A migration whose body is a function run against the open handle, for a rebuild that cannot be
 * static SQL because its content depends on what the STORE holds (asc-5ed).
 *
 * Migration 3 is the first of these: it rebuilds every registered type's views, and the view
 * body is generated per type from `entry_types` -- there is no fixed string to write down that
 * would be correct for every store, because two stores can have registered different types.
 *
 * **No `marker`, and that is not an oversight -- it is the reason this arm exists as a separate
 * type rather than as an optional field on `SqlMigration`.** `marker` exists to protect DDL that
 * is NOT idempotent, so that running it a second time fails loudly (`CREATE TABLE` on a table
 * that exists) instead of doing nothing. A view rebuild is `DROP VIEW IF EXISTS` followed by
 * `CREATE VIEW`, and creates no `sqlite_master` name that did not already exist under the same
 * name after its FIRST run -- so running it twice, or ten times, leaves the store in exactly the
 * state one run would have. There is no "already ran, and running again would fail" state for
 * `migrate` to distinguish from "the ledger is wrong", because there is no failure mode the check
 * exists to prevent. Giving this arm a `marker` field anyway -- naming some view that already
 * exists, say -- would not add protection; it would make `markerPresent` find a real object that
 * proves nothing about whether THIS migration ran, and fire `LedgerMismatchError` over a
 * disagreement that was never a problem. So `run` migrations skip that check entirely (see
 * `migrate`, the `typeof migration.sql === 'string'` branch), and the type system is what keeps a future
 * migration from carrying both fields and quietly assuming the check still applies to it.
 *
 * **Must not manage its own transaction.** `migrate` already wraps every migration -- this one
 * included -- in `BEGIN IMMEDIATE` / `COMMIT`, with `user_version` bumped inside the same
 * transaction so a crash mid-migration leaves the store exactly where it started. A `run` that
 * issued its own `BEGIN`, `COMMIT`, or `ROLLBACK` would either fail outright (SQLite refuses a
 * nested `BEGIN`) or, worse, commit early and leave the version bump to land in a transaction of
 * its own -- reopening exactly the non-atomicity `migrate`'s own `BEGIN IMMEDIATE` comment exists
 * to close.
 */
interface ProceduralMigration {
  readonly version: number;
  readonly name: string;
  readonly run: (db: DatabaseSync) => void;
  /**
   * Never present on a `run` migration -- see `Migration`'s own doc for why this field has to
   * exist at all, typed as `never`, rather than being left off `ProceduralMigration` and trusted
   * to TypeScript's structural typing.
   */
  readonly sql?: never;
  /** Same reasoning as `sql` above: a procedural migration has no marker to carry (see
   *  `SqlMigration.marker`'s doc for why), and this is what makes writing one a type error rather
   *  than a silently-ignored field. */
  readonly marker?: never;
}

/**
 * One migration, as either a fixed SQL string or a procedure -- never both, never neither.
 *
 * A discriminated union rather than two optional fields (`sql?`, `run?`) on one interface, so
 * that "a migration must carry exactly one" is a compile error on the wrong shape rather than a
 * runtime check `migrate` would have to remember to perform.
 *
 * **The `run?: never` / `sql?: never` / `marker?: never` fields on each interface are not
 * decoration -- they are the entire enforcement, and a plain `SqlMigration | ProceduralMigration`
 * union without them does NOT reject an object carrying both arms.** Verified directly (not
 * assumed): TypeScript's excess-property check on a fresh object literal assigned to a union
 * treats a property as "known", and so exempt from the excess-property error, as soon as it
 * appears on ANY member of the union -- so `{ ...every SqlMigration field, run: () => {} }`
 * satisfies `SqlMigration` structurally (all of its required fields are present; the extra `run`
 * is "known" because `ProceduralMigration` has one) and passed `tsc --strict` with no error at
 * all in a standalone probe. Only once each interface also declares the OTHER arm's fields as
 * `never` does that same literal fail -- `run: () => {}` is no longer assignable to `run?: never`
 * -- which is what makes "carries both" a genuine type error instead of a union that happens to
 * look discriminated. `neither` was never the problem: TypeScript already refuses an object
 * missing a required field of every member.
 */
export type Migration = SqlMigration | ProceduralMigration;

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
 * Rebuild every registered type's views (migration 3, asc-5ed).
 *
 * **Why this cannot be a `sql` migration.** `refreshTypeViews` (views.ts) generates each view's
 * body from that type's declared properties, read out of `entry_types` -- the SQL is a function
 * of what THIS store has registered, not a fixed string shared by every store. There is no
 * single `CREATE VIEW ...` text to write down here that would be correct for a store with four
 * types and also for one with none.
 *
 * **One generator, called, not copied.** The view SQL itself -- the envelope columns, the
 * `invalidated` projection, the per-property `_state` columns -- stays defined in exactly one
 * place (`views.ts`). Reimplementing any of it here would create a second definition that could
 * drift from the first, which is precisely the schema-drift confound this package exists to rule
 * out, just relocated into its own migration code.
 *
 * **The type list comes from `entry_types` directly, not from `@ascend/store`'s registry
 * module.** `entry_types` *is* the registry -- the table `registerType` (registry.ts) writes and
 * `registeredNames` reads back -- so querying it here asks the registry's own question without
 * adding an import edge beyond the one already checked: `schema.ts -> views.ts` introduces no
 * cycle (`views.ts` imports only `@ascend/core`, `./sql.js` and `node:sqlite`), and this keeps it
 * that way rather than also reaching into `registry.ts`.
 *
 * **Clean no-op on a store with zero registered types**, deliberately: `DISTINCT name` over an
 * empty `entry_types` returns zero rows, the loop below does not execute, and nothing throws. A
 * brand-new store migrating 1 -> 3 has no types yet -- that is the ordinary case, not an edge
 * case, since every store starts empty and only gains types afterwards.
 *
 * **Idempotent, like `refreshTypeViews` itself.** Running this migration is `DROP VIEW IF EXISTS`
 * followed by `CREATE VIEW`, for each type, which leaves the store in the same state whether it
 * runs once or a hundred times -- see `ProceduralMigration`'s doc for why that is exactly what
 * lets this migration skip the `marker` / `markerPresent` check the `sql` arm requires.
 *
 * **Runs inside `migrate`'s own transaction.** No `BEGIN`, `COMMIT`, or `ROLLBACK` here -- see
 * `ProceduralMigration`.
 */
function rebuildAllTypeViews(db: DatabaseSync): void {
  const rows = db.prepare('SELECT DISTINCT name FROM entry_types ORDER BY name').all() as {
    name: string;
  }[];

  for (const { name } of rows) {
    refreshTypeViews(db, name);
  }
}

/**
 * The cursor `asc ingest claude-code` uses to skip a transcript file it has already read in
 * full (asc-4dm.4, migration 4).
 *
 * **Why a stored table and not something derived from `entries`.** Measured 2026-09-22 on the
 * real corpus: 977 `.jsonl` files on disk, and only 33 distinct `session_id`s have ever produced
 * an entry in this store. Deriving "already ingested" from `entries` could therefore skip at
 * most 33 of 977 files and would still read the other 944 on every run -- it would not touch the
 * cost this migration exists to remove. A fact about the FILE (its `mtime` and `size` the last
 * time it was fully read) is not recoverable from the entries it produced, so it has to be its
 * own row.
 *
 * **`path` is the primary key and it is the absolute transcript path**, not a session id: two
 * different roots (`--root` pointed elsewhere, or a corpus moved) can hold a file the OS calls
 * the same session, and this table must not conflate them.
 *
 * **This table can only make a run FASTER, never wrong.** Nothing here is read except to decide
 * whether to skip a whole file, and idempotency at `entries` (this file's own header comment,
 * point 2) does not depend on this table at all -- delete every row here, or open a store that
 * predates this migration, and `asc ingest claude-code` degrades to reading every file, exactly
 * as it always did. A missing, stale, or wrong row costs time, never correctness.
 *
 * No empty-string sentinels, matching the rest of this schema: `path` and `ingested_at` are
 * `NOT NULL` with a `CHECK` against `''` rather than allowing it to sit there meaning nothing.
 * `mtime_ms` and `size` are `CHECK (... >= 0)` for the same reason a negative byte count or
 * timestamp would be a value with no honest reading.
 */
const INGEST_CURSOR = `
CREATE TABLE ingest_cursor (
  path        TEXT    NOT NULL PRIMARY KEY,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  ingested_at TEXT    NOT NULL,

  CHECK (path <> ''),
  CHECK (mtime_ms >= 0),
  CHECK (size >= 0),
  CHECK (ingested_at <> '')
);
`;

/**
 * A type's guidance (asc-bli.1, migration 5): why it exists, what to ask of it, how to read it,
 * and `review_after` -- the entry count at which someone declared they meant to look at it.
 *
 * **One JSON column, not a table.** Guidance is one-to-one with a registered version and is only
 * ever read with it; a separate table would add a join and a question this store would then have
 * to answer (can guidance outlive or predate its version?) for no gain.
 *
 * **Mutable by construction, and outside the identity on purpose.** `entry_types_identity_is_immutable`
 * fires only on the identity columns it names, so this column can change the way `prose_json`
 * does; and `definitionShape` (core) projects only name and properties into `type_hash`, so no
 * guidance edit can mint a version. The CHECK is the same object-shape guard `prose_json` has --
 * the fields inside are validated where the spec is parsed (core), not re-validated in SQL.
 *
 * Existing rows read NULL, which means "no guidance declared", never "empty guidance".
 */
const GUIDANCE = `
ALTER TABLE entry_types ADD COLUMN guidance_json TEXT
  CHECK (guidance_json IS NULL OR (json_valid(guidance_json) AND json_type(guidance_json) = 'object'));
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
 *
 * Migration 3 is the first PROCEDURAL one (`rebuildAllTypeViews` below), and it exists to reach
 * stores that migrations 1 and 2 cannot touch retroactively: `refreshTypeViews` (views.ts) is
 * called at type-REGISTRATION time, not at open time, so a column it started projecting after a
 * store's types were already registered (`invalidatedColumnSql`, asc-88m) never reaches that
 * store's views on its own. Measured on this project's own store (asc-5ed): 13 views, 0 with the
 * column, and `SELECT invalidated FROM v_tool_denial_v1` failing with `no such column:
 * invalidated` -- a silent gap in the documented read path ("a reader who wants live rows only
 * writes WHERE invalidated IS NULL", views.ts) rather than a loud one. Routing the fix through a
 * migration is what turns that silence into `StaleStoreError` on a read-only open: a store behind
 * `SCHEMA_VERSION` is refused, by machinery `db.ts` already has, with a message naming the exact
 * repair, instead of quietly serving a view that predates the column it is supposed to carry.
 */
export const MIGRATIONS: readonly Migration[] = [
  // 'entry_types' is one of the three names STORE_MARKER_TABLES (db.ts) already treats as proof
  // a file is an ascend store; reused here as proof migration 1 specifically has run.
  { version: 1, name: 'initial schema', sql: INITIAL, marker: 'entry_types' },
  { version: 2, name: 'full-text search over evidence_text', sql: FTS, marker: 'entries_fts' },
  {
    version: 3,
    name: 'rebuild per-type views to carry the invalidated column',
    run: rebuildAllTypeViews,
  },
  {
    version: 4,
    name: 'ingest cursor for incremental claude-code ingest (asc-4dm.4)',
    sql: INGEST_CURSOR,
    marker: 'ingest_cursor',
  },
  {
    version: 5,
    name: 'guidance prose and review_after on entry_types (asc-bli.1)',
    sql: GUIDANCE,
    marker: { table: 'entry_types', column: 'guidance_json' },
  },
];

/** The schema version this build of ascend writes. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/**
 * The highest migration version whose application can be CONFIRMED from `sqlite_master` content
 * alone -- i.e. the highest version among migrations that carry a `marker` (`SqlMigration`).
 *
 * Derived with the same `reduce` shape as `SCHEMA_VERSION`, over the same `MIGRATIONS` list, so
 * the two can never drift out of sync by a hand edit to one and not the other; this is never
 * hardcoded.
 *
 * **Why this can differ from `SCHEMA_VERSION`, and why that is correct rather than a bug.** A
 * procedural migration (`ProceduralMigration`) creates no `sqlite_master` name of its own -- that
 * is exactly why it carries no `marker` (see that interface's doc) -- so `inferAppliedVersion`
 * cannot read its having run off the schema, and does not try to (it skips these entries rather
 * than guessing). `LedgerMismatchError`'s repair command is worded from `inferAppliedVersion`'s
 * answer, so it can only ever name a version up to this one, never `SCHEMA_VERSION` itself, for as
 * long as the highest migration is procedural. See `LedgerMismatchError`'s own doc for why naming
 * this number instead of `SCHEMA_VERSION` is still a complete repair.
 */
export const HIGHEST_MARKED_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) =>
    typeof migration.sql === 'string' ? Math.max(highest, migration.version) : highest,
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
 * Refuse a store written by a newer ascend; return normally otherwise.
 *
 * **Extracted from `migrate` because the guard was reachable only through it** (`asc-bcv.9`, B5).
 * The check lived at the top of `migrate`'s body, so an open that skipped `migrate` skipped the
 * refusal as well -- and there are two ways to skip it. Measured (`/tmp/probe-b5.mjs`, a real store
 * with `user_version` set to 99):
 *
 *   `openStore({ dir })`                    :: `NewerSchemaError`  -- the guard fires
 *   `openStore({ dir, readOnly: true })`    :: SUCCEEDED           -- the arm the bead named
 *   `openStore({ dir, migrate: false })`    :: SUCCEEDED           -- a third arm, not named
 *   and through the real CLI, `asc query`   :: exit 0, prints `0`   -- a future store, queried
 *
 * So the rule is not "read-only opens are unguarded", it is **"any open that does not migrate is
 * unguarded"**, and the fix is to make the guard independent of `migrate` rather than to repeat it
 * at each skip site. Both callers call this one function, so the two cannot drift.
 */
export function assertNotAhead(observed: number, target: number = SCHEMA_VERSION): void {
  if (observed > target) throw new NewerSchemaError(observed, target);
}

function markerPresent(db: DatabaseSync, marker: Marker): boolean {
  if (typeof marker === 'string') {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(marker) !== undefined;
  }
  return (
    db
      .prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?')
      .get(marker.table, marker.column) !== undefined
  );
}

/**
 * The highest migration whose own marker is already present in the file, determined from
 * `sqlite_master` rather than from `user_version`.
 *
 * Used only to word `LedgerMismatchError`'s repair command -- never to decide what `migrate`
 * itself does. Content agreeing with a candidate version is strong evidence that version ran,
 * but it is evidence, not proof (a hand-restored table would look the same), so it names the
 * number for an operator to confirm and apply rather than applying it here.
 *
 * **A procedural migration (`ProceduralMigration`) has no `marker`, so it is skipped rather than
 * checked.** It creates no new `sqlite_master` name, so there is no content-based question to ask
 * of it at all -- neither "did it run" nor "did the ledger lie about it" has an answer this
 * function could read from the schema. Skipping it (rather than treating a missing marker as a
 * break, the way an `sql` migration's absent object would be) is also the only choice that keeps
 * this loop meaningful: `LedgerMismatchError` -- the one thing this function's answer feeds -- can
 * only be thrown for an `sql` migration in the first place (`migrate` skips the `markerPresent`
 * check for `run` migrations entirely), so a procedural step never being able to move `inferred`
 * costs this function nothing it was ever asked to report.
 */
function inferAppliedVersion(db: DatabaseSync, migrations: readonly Migration[]): number {
  let inferred = 0;
  for (const migration of [...migrations].sort((left, right) => left.version - right.version)) {
    if (typeof migration.sql !== 'string') continue;
    if (!markerPresent(db, migration.marker)) break;
    inferred = migration.version;
  }
  return inferred;
}

/**
 * Thrown when `user_version` says a migration has not run, but the object that migration
 * creates is already in the file (asc-u11).
 *
 * The ledger is one unsigned integer with no content check, so it is one wrong write away from
 * disagreeing with the tables it is supposed to describe -- a backup that did not carry `PRAGMA
 * user_version`, a copy through a tool that rewrites the header, a hand edit. When that happens,
 * `migrate` would otherwise trust the wrong number, attempt a migration that already ran, and
 * fail on the object's own CREATE -- rolled back cleanly, but naming whichever migration the
 * ledger happens to point at rather than the actual problem (measured: reset to 0, the first
 * failure is migration 1's "entry_types already exists", not the "entries_fts already exists"
 * asc-63v had predicted -- the message depends on the damage, not on the store). Worse, that
 * failure repeats identically on every subsequent command, because nothing about running it
 * again changes the ledger: a store in this state was permanently unopenable before this class
 * existed, which is the half of asc-u11 that matters most.
 *
 * **Why this refuses instead of repairing the ledger itself.** `inferAppliedVersion` already
 * computes the right number from the same `sqlite_master` read `assertNotForeign` (db.ts) uses
 * to decide whether a file is ascend's at all. But writing that number automatically, on an
 * ordinary open, would mean every future command silently corrects a store's ledger whenever the
 * two disagree -- and "the ledger disagrees with the content" is also what a genuinely damaged
 * store looks like from here (a hand-edited row, a partially restored table). Content-derived
 * agreement is strong evidence, not proof, and a silent auto-repair cannot tell those two cases
 * apart; an operator who has actually looked at the schema can. So this throws and states the
 * exact command instead of running it -- one `PRAGMA` write, via a tool ascend never invokes on
 * the operator's behalf, so there is no way to trigger it by accident.
 *
 * **The repair command names the highest MARKED version (`HIGHEST_MARKED_VERSION`'s ceiling),
 * never `SCHEMA_VERSION` directly, whenever the schema's tail is procedural.** `inferredVersion`
 * comes from `inferAppliedVersion`, which can only confirm a version from schema content, and a
 * procedural migration (asc-5ed's view rebuild is the first) leaves no content to confirm. Naming
 * a lower, confirmable number is still a COMPLETE repair rather than a partial one: the very next
 * `migrate` call, right after the operator's `PRAGMA` write, walks forward from that number and
 * re-runs every migration after it -- including the procedural ones, which are idempotent by
 * construction (`ProceduralMigration`'s doc) and so cost nothing to repeat. The gap between the
 * named version and `SCHEMA_VERSION` closes itself on that next open; it is never left open.
 */
export class LedgerMismatchError extends Error {
  constructor(
    readonly ledgerVersion: number,
    readonly inferredVersion: number,
    file?: string,
  ) {
    const target = file ?? "this store's database file (<project>/.ascend/ascend.db)";
    super(
      `this store's user_version ledger says ${String(ledgerVersion)}, but its tables already ` +
        `match migration ${String(inferredVersion)} -- ascend will not guess which one is right, ` +
        `so migration refuses rather than run DDL against objects that already exist. If you have ` +
        `confirmed this store's schema really does match migration ${String(inferredVersion)} (for ` +
        `example, it was restored from a backup that did not carry the pragma), repair the ledger ` +
        `directly and re-run: sqlite3 ${target} "PRAGMA user_version = ${String(inferredVersion)}"`,
    );
    this.name = 'LedgerMismatchError';
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
 * Idempotent: running it against a current store applies nothing, and running it against a
 * store whose ledger UNDERSTATES its content (asc-u11) refuses with `LedgerMismatchError`
 * instead of failing on the DDL -- deterministically the same refusal every time, rather than
 * "whichever migration the ledger happens to point at".
 *
 * `migrations` is injectable so the rollback path can be tested with a deliberately
 * failing migration. Production always uses the default. `file` is used only to word
 * `LedgerMismatchError`'s repair command; omit it (as the in-memory tests do) to get a generic
 * placeholder instead of a path that does not exist.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  file?: string,
): MigrationResult {
  const observed = userVersion(db);
  const target = migrations.reduce((highest, m) => Math.max(highest, m.version), 0);

  assertNotAhead(observed, target);

  const pending = migrations
    .filter((migration) => migration.version > observed)
    .sort((left, right) => left.version - right.version);

  const applied: string[] = [];
  let from = observed;
  let firstRead = true;

  for (const migration of pending) {
    // `IMMEDIATE`, matching the store's own `withTransaction` (B4). The window this closes is
    // narrow, and it is not zero: the migration body is one `db.exec` of DDL, and `CREATE ...`
    // reads `sqlite_master` before it writes -- so under a deferred BEGIN that read is what
    // establishes the read snapshot, and a concurrent writer committing after it would fail the
    // migration with `SQLITE_BUSY_SNAPSHOT`, which no busy timeout can wait out. Taking the write
    // lock at the BEGIN instead moves such a writer's wait to where the timeout applies.
    db.exec('BEGIN IMMEDIATE');
    try {
      // The version is read INSIDE the lock, and that is the whole of this fix. `observed` above was
      // read with no lock held at all, so a second process opening this same store can have run this
      // very migration in the meantime -- and acting on the stale reading is not a harmless repeat,
      // because the DDL is not idempotent: `CREATE TABLE entries` fails on a table that exists.
      //
      // Measured through the real CLI rather than imagined (`/tmp/probe-odh-cli.mjs`: two
      // `asc types define` processes released from a shared wall-clock barrier against one new
      // project): **14 of 20 runs failed**, every one of them this way, with
      // `migration 1 (initial schema) failed and was rolled back: table ... already exists`. The
      // BEGIN IMMEDIATE above was already there and did not help, because the read it had to cover
      // happened before it -- the mistake recorded as `begin-immediate-does-not-cover-a-pre-read`,
      // and the same one as asc-odh, one level up. The unlocked read above is kept only as a
      // shortcut, so a store that is already current still takes no lock; the loop it gates may
      // start work, but this read is what decides whether any is done.
      const current = userVersion(db);
      if (firstRead) {
        // Reported as the version this call started applying from. Re-reading it here rather than
        // reusing `observed` is what keeps it true when another process migrated first.
        from = current;
        firstRead = false;
      }

      // Another process got here first. Its work is committed and this migration is exactly what it
      // did, so there is nothing left to do -- and `applied` must not claim otherwise.
      if (current >= migration.version) {
        db.exec('COMMIT');
        continue;
      }

      if (typeof migration.sql === 'string') {
        // The re-read above still says this migration is pending, so a well-behaved concurrent
        // migration is ruled out -- one always bumps `user_version` and creates its marker in the
        // same commit, so `current >= migration.version` above would have caught it instead. An
        // object that exists anyway means the LEDGER is wrong, not that we lost a race (asc-u11):
        // check before running DDL that would otherwise fail on the object's own CREATE and blame
        // whichever migration the ledger happened to point at.
        if (markerPresent(db, migration.marker)) {
          throw new LedgerMismatchError(current, inferAppliedVersion(db, migrations), file);
        }

        db.exec(migration.sql);
      } else {
        // No `markerPresent` check here, and deliberately: that check exists to protect DDL that
        // is not idempotent, and `migration.run` is (`ProceduralMigration`'s doc). Running it
        // against a ledger that understates reality does the same work a second time and leaves
        // the store exactly where a correct ledger would have -- there is no object it could find
        // that would mean anything different from "this migration is safe to run right now",
        // which is already true unconditionally for this arm.
        migration.run(db);
      }

      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      if (error instanceof LedgerMismatchError) {
        // Not a DDL failure -- the migration was never attempted, so this is the same
        // isTransaction guard below (asc-k3b) rather than a second implementation of it: nothing
        // above has closed the transaction on its own, but checking is the point of that fix, and
        // assuming it here would undo it.
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }

      const detail = error instanceof Error ? error.message : String(error);

      // The `isTransaction` guard `registerType` uses (registry.ts) for the same reason: some
      // failures inside the try block above -- a busy-snapshot error, an interrupt -- end the
      // transaction themselves before this catch runs. An unconditional ROLLBACK here would
      // then throw its own 'cannot rollback - no transaction is active', and THAT error is what
      // would propagate, replacing the migration failure the operator actually needs to read.
      // The data is not at risk either way: a transaction that ended on its own already
      // discarded the half-applied DDL, which is what ROLLBACK would have done anyway.
      if (db.isTransaction) {
        db.exec('ROLLBACK');
        throw new Error(
          `migration ${String(migration.version)} (${migration.name}) failed and was rolled back: ${detail}`,
        );
      }
      throw new Error(
        `migration ${String(migration.version)} (${migration.name}) failed (transaction already ` +
          `closed, so there was nothing left to roll back): ${detail}`,
      );
    }
    applied.push(migration.name);
  }

  return { from, to: target, applied };
}
