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
import { migrate, SCHEMA_VERSION, userVersion, type MigrationResult } from './schema.js';

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
  /**
   * Open the database read-only, for a command that must not write.
   *
   * This is a stronger promise than `migrate: false`, and the difference is the point.
   * `migrate: false` merely declines to migrate; the handle is still writable, so any
   * statement a caller runs can still change the file. `readOnly: true` asks SQLite for
   * a handle that **cannot** write, which is what makes `Bash(asc query:*)` a
   * defensible settings.json allowlist entry: the permission is granted because the
   * command has been shown unable to mutate, not because it was asked not to.
   *
   * Measured, including across `ATTACH` (which matters, since the same command attaches
   * other projects): a write to an attached database through a read-only connection is
   * refused with `attempt to write a readonly database` and the target file is unchanged.
   * `ATTACH` itself still works, so `--across` is unaffected.
   *
   * Three writes are therefore skipped, and each is skipped for a measured reason rather
   * than defensively: the directory is not created, `PRAGMA journal_mode = WAL` is not
   * issued (it is a write to the database header -- refused read-only, and unnecessary,
   * because `verifyPragmas` still confirms an already-WAL store reads back as `wal`), and
   * the `meta` version row is not inserted. Migrations cannot run at all, so a store that
   * is behind is refused rather than queried -- see `StaleStoreError`.
   */
  readonly readOnly?: boolean;
}

/**
 * Thrown when a read-only open finds a store that has not been migrated yet.
 *
 * A read-only handle cannot migrate, so the honest options were to query a store whose
 * tables may not exist -- failing later with `no such table`, naming nothing about why --
 * or to refuse up front and name the fix. This refuses up front.
 *
 * It is deliberately a different error from `NewerSchemaError`: one is a store from the
 * future, the other from the past, and the fix differs. Telling a user to upgrade ascend
 * when they need to run any *other* ascend command would send them the wrong way.
 */
export class StaleStoreError extends Error {
  constructor(
    readonly file: string,
    readonly storeVersion: number,
    readonly buildVersion: number,
  ) {
    super(
      `${file} is at schema version ${String(storeVersion)} and this build of ascend expects ` +
        `${String(buildVersion)}. A read-only connection cannot migrate it, and the command that ` +
        `opened it does not write. Run any other ascend command in that project (or 'asc init') to ` +
        `bring it up to date, then retry.`,
    );
    this.name = 'StaleStoreError';
  }
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
  const { dir, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS, readOnly = false } = options;
  const inMemory = dir === ':memory:';
  const file = inMemory ? ':memory:' : join(dir, STORE_FILE);

  // A read-only open must not create the thing it is opening: a mistyped path would
  // otherwise leave a directory behind, which is the same failure `union.ts` refuses
  // before attaching for.
  if (!inMemory && !readOnly) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});

  try {
    // Outside any transaction: journal_mode cannot be changed inside one.
    //
    // Skipped read-only -- measured: it is a write to the database header, so a read-only
    // handle gets `attempt to write a readonly database`. Skipping it cannot let a non-WAL
    // store through, because `verifyPragmas` below reads the setting back and still refuses
    // anything that is not `wal`; a store that is already WAL reports `wal` on a read-only
    // handle (measured against a real store, not assumed).
    if (!inMemory && !readOnly) db.exec('PRAGMA journal_mode = WAL');
    // WAL with synchronous=NORMAL is the standard pairing: durable across process
    // crashes, which is the failure this store actually faces.
    //
    // These three are connection settings rather than file writes, and all three were
    // measured to be settable on a read-only handle -- so `foreign_keys` is still enforced
    // for a read-only caller instead of being silently off.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    db.exec('PRAGMA foreign_keys = ON');

    verifyPragmas(db, { inMemory });

    const before = userVersion(db);

    // Refused rather than opened: a read-only handle cannot migrate, and querying a store
    // whose tables predate this build would fail later with `no such table`, naming nothing
    // about why. Checked before `migrate` for that reason -- `migrate` would throw its own
    // error about a store it is not allowed to touch, which says less.
    //
    // In-memory is exempt, and that is not a softening of the rule. An in-memory database has no
    // file and no history: it starts at `user_version` 0 every time because nothing has ever been
    // migrated into it, so "behind" is not a state it can be in. Applying the check there would
    // refuse the one store that is *already* exactly what the caller gets -- an empty database with
    // no schema -- on the grounds that it has no schema.
    if (readOnly && !inMemory && before < SCHEMA_VERSION) {
      throw new StaleStoreError(file, before, SCHEMA_VERSION);
    }

    const migrations =
      options.migrate === false || readOnly
        ? { from: before, to: before, applied: [] }
        : migrate(db);

    if (options.ascendVersion !== undefined && !readOnly) {
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
  return inOwnTransaction(db, 'withRollback', 'ROLLBACK', body);
}

/**
 * Run `body` inside a transaction that is committed on success and rolled back on failure.
 *
 * The batching primitive, and it exists because SQLite's default is autocommit: without a
 * transaction, `asc record` recording five entries where the fourth fails validation leaves the
 * first three **committed** and exits non-zero, so the caller has a partial batch it was told
 * failed. Entries are immutable and cannot be deleted (`recorder.ts`), so that residue is
 * permanent -- the caller cannot even re-run the batch, because the ids it would reuse now
 * collide. All-or-nothing is the only shape that leaves the store in a state the caller can
 * reason about from the exit code alone.
 *
 * The counterpart of `withRollback`, sharing its nesting guard for the reason stated there: a
 * transaction this function did not open is one it cannot COMMIT on the caller's behalf without
 * changing when the caller's own work becomes durable.
 *
 * `BEGIN IMMEDIATE`, not `BEGIN`, and the comment here used to argue the opposite: *"this is a
 * writer, but the lock is taken by the first write inside `body` regardless, and the store is
 * opened with a busy timeout precisely so a concurrent writer waits rather than fails."* Measured,
 * that is false, and it is false in the one scenario it names. A **deferred** `BEGIN` takes no
 * lock, so the first read inside `body` -- and `recordEntry` reads before it writes -- establishes
 * a WAL read snapshot. If another connection commits after that snapshot, our first write cannot be
 * applied to a stale snapshot, and SQLite returns `SQLITE_BUSY_SNAPSHOT` **without consulting the
 * busy handler at all**, because retrying could not help. The timeout is not consulted, not
 * ignored: waiting is categorically the wrong response, so nothing asks.
 *
 * Measured on the real path, two connections, `busy_timeout` 300ms: the transaction failed in
 * **1ms** with "database is locked". Concurrent subagent writers are the exact scenario `db.ts`'s
 * own header names as the reason WAL is required, and it was the scenario that failed.
 *
 * `IMMEDIATE` takes the write lock at `BEGIN`, so there is no snapshot to invalidate: a concurrent
 * writer blocks *there*, where the busy timeout applies, and waits. That moves when a concurrent
 * writer waits rather than whether it fails -- which is the point, and the only change to the
 * caller's contract.
 */
export function withTransaction<T>(db: DatabaseSync, body: () => T): T {
  return inOwnTransaction(db, 'withTransaction', 'COMMIT', body);
}

/**
 * Open a transaction, run `body`, and end it with `ending`.
 *
 * The shared half of the two functions above, extracted so the nesting guard and the
 * "a rollback in `finally` still happens when `body` throws" behaviour cannot drift between
 * them -- two copies of a rule with one owner is how the owner stops being one.
 *
 * The `finally` is what makes a throw safe: on the COMMIT path it issues ROLLBACK against a
 * transaction whose body failed, which is the correct end for it, and the original error
 * propagates because `finally` does not swallow.
 */
function inOwnTransaction<T>(
  db: DatabaseSync,
  caller: string,
  ending: 'COMMIT' | 'ROLLBACK',
  body: () => T,
): T {
  if (hasOpenTransaction(db)) {
    throw new Error(
      `${caller} cannot run inside a caller-managed transaction: it would ` +
        `${ending === 'COMMIT' ? 'also commit' : 'roll back'} work that is not its own, so ` +
        `nothing here could guarantee the caller keeps what they wrote.`,
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec(ending);
    return result;
  } finally {
    // Only reachable with the transaction still open -- i.e. `body` threw, or `COMMIT`
    // itself failed. On the happy path `ending` has already closed it.
    if (hasOpenTransaction(db)) db.exec('ROLLBACK');
  }
}

/**
 * Whether a transaction is open on this handle, read outside `inOwnTransaction`'s body.
 *
 * **This is a function rather than an inline `db.isTransaction` for a measured reason, not for
 * style.** `@types/node` declares the property `readonly isTransaction: boolean`, so TypeScript
 * narrows it to `false` after the guard above and then KEEPS that narrowing across
 * `db.exec('BEGIN')` -- it cannot see that a method call changed it. Inlined, the rollback below
 * reads as a condition whose value is "always falsy" (eslint's `no-unnecessary-condition` says so
 * verbatim), which is a stale narrowing and not the state of the database. A property read inside
 * a function body is out of that narrowing's reach, so this returns the current value.
 *
 * The branch is load-bearing, and that was measured rather than argued: removing the rollback
 * makes `transaction.test.ts`'s "keeps NOTHING when the body throws" fail (the mutation harness
 * reports it CAUGHT). So the lint error was the false signal here, and the fix is to make the code
 * say what it means rather than to suppress the rule.
 */
function hasOpenTransaction(db: DatabaseSync): boolean {
  return db.isTransaction;
}
