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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, userVersion, type MigrationResult } from './schema.js';

/** The per-project store directory name. Gitignored; never committed. */
export const STORE_DIR = '.ascend';

/** The store file, inside STORE_DIR. */
export const STORE_FILE = 'ascend.db';

/** Milliseconds a writer waits for a lock before giving up. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

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
export class PragmaError extends Error {
  constructor(pragma: string, expected: string, actual: string, why: string) {
    super(
      `${pragma} is '${actual}', expected '${expected}'. ${why} ` +
        `Refusing to open the store rather than run without the guarantee it provides.`,
    );
    this.name = 'PragmaError';
  }
}

const readSetting = (db: DatabaseSync, pragma: string): string => {
  // `PRAGMA x` returns one row whose single column is named `x`.
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  if (value === undefined) return '(no result)';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();

  // Every pragma this reads is a scalar. Reaching here means the shape is not what
  // the check assumes, and the failure mode of guessing is exactly the one this
  // function exists to prevent: `String(value)` on an object yields '[object
  // Object]', which is a non-empty string that would compare as a wrong-but-
  // plausible setting instead of reporting that nothing was read.
  throw new TypeError(
    `PRAGMA ${pragma} returned a ${typeof value}, expected a scalar. The pragma check cannot ` +
      `interpret this, and must not pretend it read a setting.`,
  );
};

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
export function verifyPragmas(db: DatabaseSync, options: { readonly inMemory: boolean }): void {
  if (!options.inMemory) {
    const journal = readSetting(db, 'journal_mode').toLowerCase();
    if (journal !== 'wal') {
      throw new PragmaError(
        'journal_mode',
        'wal',
        journal,
        'WAL is what lets concurrent subagent writers serialise instead of failing with "database is locked".',
      );
    }
  }

  const foreignKeys = readSetting(db, 'foreign_keys');
  if (foreignKeys !== '1') {
    throw new PragmaError(
      'foreign_keys',
      '1',
      foreignKeys,
      'Without it an entry can reference a type definition that does not exist, which is the schema drift the composite key exists to prevent.',
    );
  }
}

/**
 * Open (creating if needed) the store in `dir`, apply pragmas, migrate, and verify.
 */
export function openStore(options: OpenOptions): Store {
  const { dir, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = options;
  const inMemory = dir === ':memory:';
  const file = inMemory ? ':memory:' : join(dir, STORE_FILE);

  if (!inMemory) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file);

  try {
    // Outside any transaction: journal_mode cannot be changed inside one.
    if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
    // WAL with synchronous=NORMAL is the standard pairing: durable across process
    // crashes, which is the failure this store actually faces.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    db.exec('PRAGMA foreign_keys = ON');

    verifyPragmas(db, { inMemory });

    const before = userVersion(db);
    const migrations =
      options.migrate === false ? { from: before, to: before, applied: [] } : migrate(db);

    if (options.ascendVersion !== undefined) {
      db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
        'created_by_ascend_version',
        options.ascendVersion,
      );
    }

    return {
      db,
      dir,
      file,
      migrations,
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    // Never leave a half-open handle behind on a failed open.
    db.close();
    throw error;
  }
}

/**
 * Run `body` inside a transaction that is always rolled back.
 *
 * The preview primitive: everything in `body` really runs -- validation, the version bump, view
 * and index generation -- and then the whole thing is discarded. A preview computed by a second
 * implementation would be a preview of *that* implementation, so the only preview worth offering
 * is the work itself, undone.
 *
 * **One transaction, not one per call.** Per-call rollback (`registerType`'s own `dryRun`) is
 * right for a single write and wrong for a sequence: a preview of registering three documents
 * would have each one rolled back before the next, so the second would compute its version as
 * though the first had never happened -- and `import --dry-run` would report version 1 twice
 * where the real run produces 1 then 2. A preview that misdescribes what the real run does is
 * worse than no preview. Owning the transaction here is what lets the sequence see itself.
 *
 * **Refuses to run inside an existing transaction**, for the same reason `registerType`'s
 * `dryRun` does: a ROLLBACK this function did not open would discard work that belongs to the
 * caller, and nothing here could promise otherwise.
 *
 * If `body` throws, the rollback still happens and the original error propagates. A rollback
 * that itself fails would replace that error -- unavoidable in a `finally`, and noted rather
 * than hidden.
 */
export function withRollback<T>(db: DatabaseSync, body: () => T): T {
  if (db.isTransaction) {
    throw new Error(
      'withRollback cannot run inside a caller-managed transaction: it would roll back work ' +
        'that is not its own, so nothing here could guarantee the caller keeps what they wrote.',
    );
  }

  db.exec('BEGIN');
  try {
    return body();
  } finally {
    db.exec('ROLLBACK');
  }
}
