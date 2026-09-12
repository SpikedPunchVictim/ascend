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
export declare const MIGRATIONS: readonly Migration[];
/** The schema version this build of ascend writes. */
export declare const SCHEMA_VERSION: number;
/** The store's own schema version, from SQLite's `user_version` pragma. */
export declare function userVersion(db: DatabaseSync): number;
export interface MigrationResult {
    readonly from: number;
    readonly to: number;
    readonly applied: readonly string[];
}
/** Thrown when a store was written by a newer ascend than this one. */
export declare class NewerSchemaError extends Error {
    readonly storeVersion: number;
    readonly buildVersion: number;
    constructor(storeVersion: number, buildVersion: number);
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
export declare function migrate(db: DatabaseSync, migrations?: readonly Migration[]): MigrationResult;
//# sourceMappingURL=schema.d.ts.map