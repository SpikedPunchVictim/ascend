/**
 * Opening a store: the pragmas, and the verification that they actually took.
 *
 * Every pragma set here is load-bearing, and two of them can fail SILENTLY in ways
 * that would make the store's guarantees false:
 *
 *   - `foreign_keys` defaults to OFF, and it is per CONNECTION, not per database. If
 *     it does not take, the composite key that makes schema drift impossible simply
 *     stops existing -- every entry could reference a definition that is not there,
 *     and nothing would report it.
 *   - `journal_mode` is persisted in the file, but not every filesystem supports
 *     WAL. If it silently stays `delete`, concurrent subagent writes hit
 *     "database is locked" instead of serialising.
 *
 * So both are READ BACK and checked. An invariant that is merely requested is not an
 * invariant; this project has already shipped one false green from exactly that gap
 * (docs/evidence/EV-hooks.md).
 */
import { DatabaseSync } from 'node:sqlite';
import { type MigrationResult } from './schema.js';
/** The per-project store directory name. Gitignored; never committed. */
export declare const STORE_DIR = ".ascend";
/** The store file, inside STORE_DIR. */
export declare const STORE_FILE = "ascend.db";
/** Milliseconds a writer waits for a lock before giving up. */
export declare const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export interface OpenOptions {
    /** The `.ascend` directory. Created if missing. */
    readonly dir: string;
    readonly busyTimeoutMs?: number;
    /** Run pending migrations on open. Default true. */
    readonly migrate?: boolean;
    /** Recorded in `meta` on first open, for `asc doctor` to report. */
    readonly ascendVersion?: string;
}
export interface Store {
    readonly db: DatabaseSync;
    readonly dir: string;
    readonly file: string;
    readonly migrations: MigrationResult;
    close(): void;
}
/** Thrown when a required pragma did not take effect. */
export declare class PragmaError extends Error {
    constructor(pragma: string, expected: string, actual: string, why: string);
}
/**
 * Read back the pragmas that carry a guarantee, and throw if any did not take.
 *
 * Exported so its FAILURE path is testable. A verification whose alarm has never
 * been shown to sound is indistinguishable from one that cannot sound, and this is
 * the check standing between the store and two silent-corruption modes.
 *
 * In-memory stores skip the WAL check only: WAL is not applicable to them, so
 * demanding it would be a false alarm rather than a finding.
 */
export declare function verifyPragmas(db: DatabaseSync, options: {
    readonly inMemory: boolean;
}): void;
/**
 * Open (creating if needed) the store in `dir`, apply pragmas, migrate, and verify.
 */
export declare function openStore(options: OpenOptions): Store;
//# sourceMappingURL=db.d.ts.map