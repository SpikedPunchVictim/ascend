/**
 * Opening a store: the pragmas, and the verification that they actually took.
 *
 * Every setting made here is load-bearing, and three of them can fail SILENTLY in ways
 * that would make the store's guarantees false:
 *
 *   - `foreign_keys` defaults to OFF, and it is per CONNECTION, not per database. If
 *     it does not take, the composite key that makes schema drift impossible simply
 *     stops existing -- every entry could reference a definition that is not there,
 *     and nothing would report it.
 *   - `journal_mode` is persisted in the file, but not every filesystem supports
 *     WAL. If it silently stays `delete`, concurrent subagent writes hit
 *     "database is locked" instead of serialising.
 *   - `busy_timeout` defaults to ZERO, so a connection that does not get it waits for
 *     nothing and refuses instantly. It is set through the CONSTRUCTOR rather than by a
 *     pragma, because the lock that refuses us is taken by the constructor's own WAL
 *     open -- measured: 6 of 240 concurrent opens failed, every one of them at
 *     `new DatabaseSync(...)`, before any pragma had run (asc-51t).
 *
 * So all three are READ BACK and checked. An invariant that is merely requested is not an
 * invariant; this project has already shipped one false green from exactly that gap
 * (docs/evidence/EV-hooks.md).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertNotAhead,
  migrate,
  SCHEMA_VERSION,
  userVersion,
  type MigrationResult,
} from './schema.js';

/** The per-project store directory name. Gitignored; never committed. */
export const STORE_DIR = '.ascend';

/** The store file, inside STORE_DIR. */
export const STORE_FILE = 'ascend.db';

/** Milliseconds a writer waits for a lock before giving up. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * SQLite's PRIMARY result codes for "another connection holds the lock".
 *
 * `SQLITE_BUSY` (5) is a lock held by another CONNECTION. `SQLITE_LOCKED` (6) is a lock held by
 * another STATEMENT on the same connection. Both mean "try again later", which is why both are
 * treated the same here.
 *
 * These are the primary codes. What `node:sqlite` actually reports is often an EXTENDED code --
 * `SQLITE_BUSY | (n << 8)` -- so the check below masks down to the low byte rather than comparing
 * against these directly. See `isBusyError`.
 */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** The low byte of a result code, which is the primary code; the high bits are the extension. */
const PRIMARY_CODE_MASK = 0xff;

/**
 * Whether a thrown thing is SQLite refusing because another connection holds a lock.
 *
 * **Duck-typed on `errcode`, and that is a measured decision rather than a shortcut.** `node:sqlite`
 * has no error class to test against: measured on a real lock conflict, it throws a plain `Error`
 * whose own properties are exactly `{ code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is
 * locked' }` -- `constructor.name` is `'Error'` and there is no `SQLiteError` export. An
 * `instanceof` check would therefore be **false for every real busy error**, which is the shape of
 * guard that never fires and reports nothing.
 *
 * **The mask is not defensive; it was measured, and the first version of this function was wrong
 * without it.** The probe that mutation-tests this fix (`/tmp/probe-51t-real.mjs`) runs the real
 * `openStore` concurrently 300 times with the busy timeout turned off, and of the 12 failures it
 * produced, **3 carried errcode 261 -- `SQLITE_BUSY_RECOVERY`, which is `SQLITE_BUSY` with the
 * recovery extension set.** An `=== SQLITE_BUSY` comparison misses those, so a quarter of real lock
 * conflicts would have gone unrecognised and surfaced as the bare `database is locked` string this
 * whole change exists to remove. The same applies to `SQLITE_BUSY_SNAPSHOT` (517, the code B4's
 * transaction comment names) and to the extended `SQLITE_LOCKED` codes.
 *
 * Exported because two layers need the same answer about the same error: this module, to turn it
 * into `StoreBusyError`, and the CLI's error boundary, to turn it into something a person can act
 * on. Two copies of the predicate would agree until the day one changed.
 */
export function isBusyError(error: unknown): boolean {
  const primary = sqlitePrimaryCode(error);
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

/**
 * The SQLite PRIMARY result code behind a thrown thing, or `undefined` if it is not a driver error.
 *
 * **This is the one place ascend asks "which SQLite code is this", and it exists because there were
 * three.** `isBusyError` masks the extended codes down to the primary one, and the CLI had written
 * the same mask out twice more -- once in `errors.ts`'s busy branch (via `isBusyError`, correctly)
 * and once inline in `commands/query.ts`, to recognise a read-only connection. Three copies of a
 * constant agree until the day one of them changes, and the failure that produces is a guard that
 * stops firing while still reporting green, which is the class this project treats as severity-zero.
 *
 * Extended codes are the reason the mask is not decoration: measured, a real lock conflict reported
 * **261** (`SQLITE_BUSY_RECOVERY`) and an extended `SQLITE_BUSY` is `5 | (n << 8)` -- so an `===`
 * against 5 misses it. Callers that want "is this the primary code N" compare the value this
 * returns; they must not compare `errcode` itself.
 *
 * `undefined` rather than `0` for "not a driver error", because `0` is `SQLITE_OK` -- a real code
 * that means the opposite of what a caller testing truthiness would read into it.
 */
export function sqlitePrimaryCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, errcode } = error as { readonly code?: unknown; readonly errcode?: unknown };
  if (code !== 'ERR_SQLITE_ERROR') return undefined;
  if (typeof errcode !== 'number') return undefined;
  return errcode & PRIMARY_CODE_MASK;
}

/**
 * Thrown when a store could not be OPENED because another process holds its lock.
 *
 * asc-51t: the message SQLite gives is the bare string `database is locked`, which is none of
 * context, problem or fix (`cli-best-practices` rule 8) -- and the command that prints it exits 1,
 * so a caller cannot tell it apart from "no such type". Two things this adds that matter more than
 * the wording:
 *
 * 1. **It says the command did NOT run.** A busy open reads nothing and writes nothing, so a
 *    retry is unambiguously safe. Without that, a caller has to guess whether a half-applied write
 *    is sitting in the store.
 * 2. **It says contention is expected**, not a fault: several subagents recording into one store is
 *    the scenario `db.ts`'s WAL requirement exists for.
 *
 * **It reports no duration, and that is the fix, not an omission.** The first version took the
 * configured busy timeout and reported it as the wait -- "gave up after waiting 5000ms" -- for an
 * open that had in fact been refused in **1ms**. Measured (`/tmp/probe-wait.mjs`: 8 concurrent opens
 * x 25 rounds against one fresh store, recording the elapsed time of every failure):
 *
 *   `busyTimeoutMs: 5000`  :: 200 opens, 2 failed, after **0ms and 1ms**
 *   `busyTimeoutMs: 60000` :: 200 opens, 2 failed, after **1ms and 2ms**
 *
 * Raising the timeout twelvefold changed nothing, so that number was not a duration anything spent:
 * it told an operator their store had been contended for five seconds -- or a minute, had they raised
 * the timeout, which is exactly what such a message invites -- when the lock had been refused
 * instantly. "Omitted, never fabricated" applies to a duration the same way it applies to any other
 * measurement. Reporting the real elapsed time instead is not available either, because
 * `packages/store` may not read a clock: `recorder.test.ts` scans every module in `src` for
 * `Date.now`, `new Date`, `Math.random`, `randomUUID`, `performance.now` and `hrtime`, and adding
 * one to measure this failed that guard -- the guard working, not an obstacle to route around.
 *
 * **It names no step either, and the second half of that is a measurement too.** The proposed
 * replacement for the duration was a `BusyStep` label: this class took one of two strings, one per
 * wrap site (the `new DatabaseSync` constructor, and the statements after it). It was written,
 * tested, and then measured, and the split turns out not to exist in practice:
 *
 *   * 640 concurrent opens of fresh stores at `busyTimeoutMs: 0` produced **66 failures, all at the
 *     post-constructor site**; a smaller run (192 opens) produced 25 more, also all
 *     post-constructor. **91 of 91.**
 *   * Six shapes built to make the CONSTRUCTOR itself lose a lock -- a plain, a WAL and a
 *     hot-WAL database each under a peer's `BEGIN EXCLUSIVE`, plus read-only opens of the first
 *     two -- all let the constructor succeed (`/tmp/probe-ctor.mjs`).
 *   * Consequently, mutating the constructor's label changed nothing any test or probe could
 *     observe. A label no observation can distinguish is noise, and one of the two was an
 *     unverifiable claim in a user-facing message -- the same defect class as the duration.
 *
 * So there is one message, true whichever site loses the lock. Both wraps stay: asc-51t's point is
 * that a raw driver error must not escape from either, and that part was never in question. If a
 * real environment is ever seen failing at the constructor, the label can come back -- and
 * `/tmp/probe-step.mjs` is the probe that would show it, since it counts the site rather than
 * asserting one.
 */
export class StoreBusyError extends Error {
  constructor(readonly file: string) {
    super(
      `${file} is locked by another process, and this one could not open it. ` +
        `The store was NOT opened, so the command read nothing and wrote nothing -- re-running it ` +
        `is safe. Several ascend processes sharing one store is expected; retry once the other one ` +
        `has finished.`,
    );
    this.name = 'StoreBusyError';
  }
}

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
   *
   * A store that is **ahead** is refused here too, and on every open rather than only this
   * one -- see `assertNotAhead` and `openStore`'s call site (`asc-bcv.9`, B5).
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

/**
 * Thrown when the file at the store path already holds a database that ascend did not create.
 *
 * asc-63v, measured by driving the real binary: put any SQLite file at `<proj>/.ascend/ascend.db`
 * -- one holding a single table of the caller's own -- and `asc types list` exited **0**, printed an
 * empty table, and left the file carrying ascend's full schema alongside theirs. A read-shaped
 * command silently adopted and migrated a foreign database, and the caller could not tell "this
 * project has no types" from "I just created a store inside someone else's file".
 *
 * The precedent is already in this package: `--across` refuses the same situation before attaching,
 * on the grounds that "treating an unreadable project as empty would report a fragment of the corpus
 * as the whole of it". The project's own open had no equivalent check. This is that check.
 *
 * **The refusal happens before any migration, not during one**, and that is the whole point: a
 * foreign file whose table names happen to collide is already refused later, by the migration runner
 * ("table entries already exists", exit 1, foreign data intact) -- but a foreign file whose names do
 * NOT collide was not refused at all. Guarding on what the file IS rather than on what the DDL
 * collides with is what covers both.
 */
export class ForeignStoreError extends Error {
  constructor(
    readonly file: string,
    readonly tables: readonly string[],
  ) {
    // The sample is capped: a file with two hundred tables would otherwise put all of them in a
    // message, and the caller needs enough to recognise the file, not an inventory of it.
    const shown = tables.slice(0, 3).join(', ');
    const rest = tables.length > 3 ? ` and ${String(tables.length - 3)} more` : '';
    super(
      `${file} is a SQLite database, and it is not an ascend store: it holds ${String(
        tables.length,
      )} table(s) of its own (${shown}${rest}) and is missing ascend's. ascend would have added its ` +
        `own schema to it, which means writing to a file ascend did not create, so this is refused ` +
        `before anything is migrated. Move that file aside and re-run -- 'asc init' creates a store ` +
        `in a directory that has none -- or point ascend at the project you meant.`,
    );
    this.name = 'ForeignStoreError';
  }
}

export interface Store {
  readonly db: DatabaseSync;
  readonly dir: string;
  readonly file: string;
  readonly migrations: MigrationResult;
  close(): void;
}

/**
 * Open the SQLite handle, with the busy timeout already in effect.
 *
 * **The timeout goes to the CONSTRUCTOR, not to a `PRAGMA busy_timeout`, and the difference is the
 * whole of asc-51t.** Opening a WAL database is not a passive act: the connection must read the
 * `-shm` index and recover it if another process left it dirty, and that work happens inside
 * `new DatabaseSync(...)` -- before this module's next line is reached, so before any pragma can
 * set a timeout. A pragma that runs afterwards cannot retroactively help it.
 *
 * Measured against the SHIPPED function, 20 concurrent opens x 15 rounds on a real store
 * (`/tmp/probe-51t-real.mjs`). Three arms, and the third is the one that matters -- the same code
 * with the timeout switched off, which is the mutation that shows the constructor option is the
 * mechanism and not a coincidence:
 *
 *   pre-fix sequence, hand-transcribed :: 300 opens, 13 failed -- `errcode` 5 and **261**
 *                                         (`SQLITE_BUSY_RECOVERY`)
 *   `openStore`, as shipped             :: 300 opens, **0 failed**
 *   `openStore` with `busyTimeoutMs: 0` :: 300 opens, 13 failed -- same codes
 *
 * **Where those failures land is settled, and it is not the constructor.** That probe sorted errors
 * by KIND (`raw driver errcode N` vs `StoreBusyError`), which cannot name a site, and an earlier
 * reading of it attributed some failures to `new DatabaseSync` itself. Measured directly instead
 * (`/tmp/probe-step.mjs`, which parses the site out of the message): **832 concurrent opens of fresh
 * stores, 91 failures, 91 at the statements after the constructor and 0 at it**, and six shapes built
 * to make the constructor lose a lock -- plain, WAL and hot-WAL databases each under a peer's
 * `BEGIN EXCLUSIVE`, plus read-only opens -- all let it succeed (`/tmp/probe-ctor.mjs`). The
 * constructor must still be wrapped, because a failure there would otherwise escape as the bare
 * string that asc-51t is about; it is not where the observed failures are.
 *
 * This also overturns the cause recorded when the finding was filed. The bead inferred the pragma
 * *ordering* (`journal_mode` running before `busy_timeout`) and rated that inference explicitly as
 * "suggestive at n=3, not proof"; the failures are on the open path, ahead of the pragmas, which is
 * why reordering the pragmas alone would not have fixed it.
 *
 * A busy failure here -- and anywhere else in the open -- becomes `StoreBusyError` rather than
 * propagating SQLite's bare string; see `asStoreBusy`.
 */
function openHandle(
  file: string,
  options: {
    readonly readOnly: boolean;
    readonly busyTimeoutMs: number;
  },
): DatabaseSync {
  try {
    return new DatabaseSync(file, {
      ...(options.readOnly ? { readOnly: true } : {}),
      timeout: options.busyTimeoutMs,
    });
  } catch (error) {
    return asStoreBusy(error, file);
  }
}

/**
 * Turn a lock conflict into `StoreBusyError`; rethrow anything else untouched.
 *
 * Called from **two** places, and the second one is not belt-and-braces. The first version of this
 * fix wrapped only the constructor, and under contention a second group of failures -- the ones on
 * the statements that follow it -- still exited 1 with the bare `database is locked` string that
 * asc-51t is about. Measured since: that second group is where **all** of them are (91 of 91 across
 * 832 concurrent opens; see `StoreBusyError`). Both sites keep their wrap.
 */
const asStoreBusy = (error: unknown, file: string): never => {
  if (isBusyError(error)) throw new StoreBusyError(file);
  throw error;
};

/**
 * Wait for the exclusive access the switch needs, using a statement the busy handler DOES cover.
 *
 * asc-9zd, and this is the whole trick. The switch needs exclusive access to the database -- no other
 * connection at all, a reader included -- and `PRAGMA journal_mode` does not reliably wait for it.
 * Measured both ways (`/tmp/probe-9zd-wait.mjs`, timeout 300ms, a peer holding a real lock):
 *
 *   peer holds SHARED (a reader)   :: `BEGIN IMMEDIATE` SUCCEEDED 0ms -- too weak, takes only RESERVED
 *                                     `BEGIN EXCLUSIVE` waited **343ms**, then busy
 *                                     `PRAGMA journal_mode = WAL` waited **360ms**, then busy
 *   peer holds RESERVED (a writer) :: `BEGIN IMMEDIATE` waited **352ms**, then busy
 *                                     `BEGIN EXCLUSIVE` waited **356ms**, then busy
 *                                     `PRAGMA journal_mode = WAL` **refused at 0ms**
 *
 * So the pragma is the one statement here that is *not* dependably governed -- in the writer arm it
 * refused without consulting the handler at all, which is the arm the real race produces (two
 * processes both switching a fresh store, whose failures return in 0-2ms at `busyTimeoutMs` 5000 and
 * at 60000 alike). `BEGIN EXCLUSIVE` is governed in **both** arms, so it is the wait that can be
 * relied on to spend the caller's timeout.
 *
 * **EXCLUSIVE rather than IMMEDIATE, and the reason is a principle rather than a failure.** The two
 * are not distinguishable by outcome here: in the reader arm the pragma is itself governed, so an
 * IMMEDIATE wait that returns instantly is still followed by the pragma spending the timeout, and the
 * caller sees the same `StoreBusyError` after roughly the same wait (measured; a mutation swapping
 * one for the other survives the suite, and is recorded in the harness as a limitation rather than
 * papered over). What EXCLUSIVE buys is that the wait takes the lock the switch needs, so a wait that
 * SUCCEEDS is followed by a switch that succeeds -- instead of by a second wait inside the pragma.
 * The reader arm is why the stronger lock is the correct one to name: a reader blocks the switch and
 * `BEGIN IMMEDIATE` does not conflict with a reader at all.
 *
 * **Why a wait and not a retry loop.** The first version of this fix spun on the pragma itself, up to
 * a fixed number of attempts, and both halves of that were wrong, both measured. A failed attempt
 * costs ~5us against a sleeping peer and ~20us against another process, so an attempt count is not a
 * time budget on any machine; and the bound read off one contention run (183 attempts) was 3,300
 * attempts short of what a peer holding its lock for a mere 10ms needed (`/tmp/probe-9zd-worker.mjs`).
 * Waiting replaces both: the budget is the caller's own `busyTimeoutMs`, the same one every other
 * statement in the store already spends, and no number has to be invented. A spin also burns a core;
 * this does not.
 */
const waitForExclusiveLock = (db: DatabaseSync): void => {
  db.exec('BEGIN EXCLUSIVE');
  db.exec('ROLLBACK');
};

/**
 * Switch the store to WAL, waiting out a lock conflict -- because SQLite will not wait for this one.
 *
 * asc-9zd. A brand-new store opened by two processes at once failed **~14%** of the time (50 opens, 7
 * failed; the pre-migrated arm 0 of 50, through the real CLI), and raising the busy timeout twelvefold
 * changed nothing. That is this function's reason to exist: the switch is attempted once, and if it
 * loses, the wait happens on `waitForExclusiveLock` and the switch is attempted once more.
 *
 * The second attempt's failure is not swallowed -- it propagates to `openStore`'s catch and becomes
 * the honest `StoreBusyError`, after the caller has waited the timeout they asked for. So the cost of
 * a genuinely held lock is one `busyTimeoutMs`, which is what the rest of the store charges, rather
 * than the instant refusal this statement used to give. Swallowing it instead would open the store
 * NON-WAL and leave it to `verifyPragmas` to refuse -- a PragmaError about a setting, for what is
 * really a lock conflict, after every concurrent writer has already been promised serialisation the
 * store does not have.
 *
 * **The site was located before the fix was designed, not assumed** (`/tmp/probe-9zd-step.mjs`:
 * openStore's own sequence, labelled, two processes against one fresh directory). Of 60 opens, 18 lost
 * the lock at this statement. A further 12 were reported by that probe as a `CREATE TABLE` collision
 * and are **the probe's own artifact**: it reproduced the sequence without `migrate`'s re-read of
 * `user_version` inside the lock, which asc-zjy fixed. Recorded because the wrong half of that result
 * would otherwise have been designed for.
 *
 * Only a busy failure is waited out and retried. A `readonly database` failure is not a lock, and is
 * rethrown by the first attempt rather than reported as contention.
 */
function setJournalModeWal(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA journal_mode = WAL');
    return;
  } catch (error) {
    if (!isBusyError(error)) throw error;
  }

  waitForExclusiveLock(db);
  db.exec('PRAGMA journal_mode = WAL');
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

const readSetting = (db: DatabaseSync, pragma: string, column = pragma): string => {
  // `PRAGMA x` returns one row whose single column is USUALLY named `x` -- but not always, which is
  // why the column is a parameter. Measured across every pragma this module reads: `journal_mode`
  // -> `journal_mode`, `foreign_keys` -> `foreign_keys`, `synchronous` -> `synchronous`,
  // `user_version` -> `user_version`, and **`busy_timeout` -> `timeout`**, the one that does not
  // follow the pattern.
  //
  // Worth stating because of how that one fails. Reading `row['busy_timeout']` on the busy pragma
  // yields `undefined`, i.e. `(no result)` -- a non-empty string, so the comparison against the
  // expected value still fails and the alarm still sounds. A read-back check that reports a
  // mismatch for the wrong reason is easy to misread as a working check, and the wrong fix (loosen
  // the comparison) would have disarmed it entirely.
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[column];
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
 * Read back the settings that carry a guarantee, and throw if any did not take.
 *
 * Exported so its FAILURE path is testable. A verification whose alarm has never
 * been shown to sound is indistinguishable from one that cannot sound, and this is
 * the check standing between the store and two silent-corruption modes.
 *
 * In-memory stores skip the WAL check only: WAL is not applicable to them, so
 * demanding it would be a false alarm rather than a finding.
 *
 * `busyTimeoutMs` is required rather than optional, because an optional check is one a caller can
 * forget -- and the default it would fall back on is **zero**, which is the value that made asc-51t
 * possible in the first place. A caller must state what it asked for so the read-back has something
 * to disagree with.
 */
export function verifyPragmas(
  db: DatabaseSync,
  options: { readonly inMemory: boolean; readonly busyTimeoutMs: number },
): void {
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

  // The third setting, and the newest: asc-51t. It is set by the CONSTRUCTOR (see `openHandle`),
  // which is the only place it CAN be set early enough to cover the lock the constructor's own WAL
  // open takes -- and that is where 6 of 240 concurrent opens were measured to fail. Reading it
  // back is what makes "the constructor option was honoured" a checked fact rather than an
  // assumption about this Node version's `node:sqlite`.
  //
  // The result column is `timeout`, not `busy_timeout` -- see `readSetting`.
  // The fourth setting: asc-byn guard #1. It is a read-back rather than a one-time `exec` because the
  // pragma IS the guard -- `entries_cannot_be_deleted` does not fire for REPLACE's implicit delete
  // without it, so a version of Node that ignored this statement would silently reopen the hole
  // rather than fail. Same reasoning as `foreign_keys` above, and the same reason this project treats
  // a check that cannot be shown to fire as no check at all.
  const recursiveTriggers = readSetting(db, 'recursive_triggers');
  if (recursiveTriggers !== '1') {
    throw new PragmaError(
      'recursive_triggers',
      '1',
      recursiveTriggers,
      'Without it SQLite does not fire delete triggers for the DELETE that `INSERT OR REPLACE` performs, so an entry could be rewritten in place while the immutability triggers stay silent. asc-byn, measured.',
    );
  }

  const timeout = readSetting(db, 'busy_timeout', 'timeout');
  if (timeout !== String(options.busyTimeoutMs)) {
    throw new PragmaError(
      'busy_timeout',
      String(options.busyTimeoutMs),
      timeout,
      'A timeout of ' +
        `${timeout}ms means a lock conflict refuses immediately instead of waiting, which is the failure concurrent subagent writers hit.`,
    );
  }
}

/**
 * The tables every ascend store has, and the marker that says a file is one.
 *
 * All three arrive together, in migration 1 (`INITIAL`), so a file that has any one of them has all
 * three -- and a file that has none of them has never been migrated by any released ascend. There
 * have only ever been two migrations and both are additive, so no ascend store exists that is
 * missing one of these.
 *
 * **Three names rather than one, deliberately.** `meta` alone would be a weak marker: plenty of
 * applications have a table called `meta`, and a foreign file that happened to have one would be
 * adopted -- which is the defect this guard exists to remove, not a narrower version of it. A file
 * with all three of these names and no ascend behind it is not a case worth designing for.
 */
const STORE_MARKER_TABLES = ['meta', 'entries', 'entry_types'] as const;

/**
 * The tables a file holds that SQLite did not create, which is what "already has something in it"
 * means.
 *
 * `name NOT LIKE 'sqlite_%'` because SQLite's own bookkeeping -- `sqlite_sequence` for any
 * AUTOINCREMENT table, `sqlite_stat1` -- is not the caller's content and must not be what makes a
 * file look foreign.
 */
function userTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);
}

/**
 * Refuse a file that already holds a database ascend did not create, before it is migrated.
 *
 * asc-63v. Runs on every open of a real file -- writable, read-only, and `migrate: false` alike --
 * because "this is not our file" is true regardless of what the caller meant to do with it, and
 * because the read-only path is where the current behaviour is worst: it skips migration entirely,
 * so a foreign file met by `asc query` produced `StaleStoreError`, whose message says ascend expects
 * a newer schema and to run another command to bring it up to date. That is a false statement about
 * a file no ascend ever wrote.
 *
 * **An empty file is not a foreign file.** A path that does not exist, or holds zero bytes, reports
 * no tables at all -- which is the ordinary first-open case, and the one every `asc init` takes. The
 * check is on what the file CONTAINS, not on whether it exists, so there is no separate
 * "does it exist" branch to get wrong.
 *
 * **Stated limitation, not a silent one:** a file that holds a SQLite header and no tables at all
 * (an empty database someone made with the `sqlite3` shell, say) is indistinguishable from a fresh
 * one by any means available here, and is adopted. Nothing is lost in that case -- there is nothing
 * in the file -- which is why it is accepted rather than refused on a heuristic.
 */
function assertNotForeign(db: DatabaseSync, file: string, inMemory: boolean): void {
  // An in-memory database has no file, so there is no one else's data to protect. Exempt rather
  // than checked, because it would report zero tables and pass anyway -- a branch that cannot
  // change an outcome is not worth the reader's attention.
  if (inMemory) return;

  const found = userTables(db);
  if (found.length === 0) return;
  if (STORE_MARKER_TABLES.every((table) => found.includes(table))) return;

  throw new ForeignStoreError(file, found);
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

  const db = openHandle(file, { readOnly, busyTimeoutMs });

  try {
    // **The first statement of the open, before anything writes so much as a header byte.**
    //
    // Where this sits is the whole guard, and it took three measurements to get right. Written after
    // `verifyPragmas`, the read-only arm failed with `PragmaError: journal_mode is 'delete'` -- a
    // foreign file is not WAL, a read-only open cannot switch it, and the read-back refused before
    // anything asked whether the file was ours. Written after `setJournalModeWal` (the next line),
    // the file was still MODIFIED: the journal-mode switch writes to the database header, so the
    // refusal arrived after ascend had already changed someone else's file -- the same harm the bead
    // reports, one statement smaller. The byte-identity assertion in `foreign.test.ts` is what
    // caught that, which is why it compares bytes rather than trusting the refusal.
    //
    // Reading `sqlite_master` needs no pragma, no journal mode and no schema, so it can speak first
    // on every path. Before `assertNotAhead` for the same reason: that guard's message says a NEWER
    // ASCEND WROTE THIS STORE, which for a file no ascend ever touched is simply false. A store that
    // IS ascend's is unaffected either way -- it carries the marker, so it passes here and meets
    // every guard below exactly as before.
    assertNotForeign(db, file, inMemory);

    // Outside any transaction: journal_mode cannot be changed inside one.
    //
    // Skipped read-only -- measured: it is a write to the database header, so a read-only
    // handle gets `attempt to write a readonly database`. Skipping it cannot let a non-WAL
    // store through, because `verifyPragmas` below reads the setting back and still refuses
    // anything that is not `wal`; a store that is already WAL reports `wal` on a read-only
    // handle (measured against a real store, not assumed).
    //
    // It is also the statement that cannot be waited for: the switch itself is the last of asc-9zd's
    // failures, and SQLite refuses it without consulting the busy handler at all. Hence the retry
    // inside `setJournalModeWal` rather than a longer `busyTimeoutMs`, which was measured to change
    // nothing.
    if (!inMemory && !readOnly) setJournalModeWal(db);
    // WAL with synchronous=NORMAL is the standard pairing: durable across process
    // crashes, which is the failure this store actually faces.
    //
    // Both are connection settings rather than file writes, and both were measured to be
    // settable on a read-only handle -- so `foreign_keys` is still enforced for a read-only
    // caller instead of being silently off.
    //
    // `busy_timeout` is deliberately NOT here. It is set by `openHandle`, at construction,
    // because this line is already too late: the lock a concurrent open loses to is taken by
    // the constructor itself, before this function's first statement runs (asc-51t, measured).
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    // asc-byn guard #1, and this pragma IS the guard. SQLite fires delete triggers for the DELETE
    // that `INSERT OR REPLACE` performs only when recursive triggers are on -- and they are off by
    // default. So with the default, `entries_cannot_be_deleted` stays silent while REPLACE rewrites a
    // recorded entry in place: measured on a real store, an entry's `properties_json` went
    // ORIGINAL -> TAMPERED through `INSERT OR REPLACE`, past a BEFORE UPDATE trigger and a BEFORE
    // DELETE trigger that both exist to stop exactly that. With this line the same statement is
    // refused by the trigger that was already there.
    //
    // **Measured, both arms, on real stores** (`/tmp/probe-byn.mjs`):
    //
    //   recursive_triggers OFF :: REPLACE SUCCEEDED, verdict TAMPERED, and entries_fts matched BOTH
    //                             'ORIGINAL' and 'TAMPERED' -- the stale row the AFTER INSERT trigger
    //                             adds without any delete trigger to clean it up
    //   recursive_triggers ON  :: refused, "entries are immutable: an entry cannot be deleted once
    //                             recorded", verdict ORIGINAL, fts 'TAMPERED' 0
    //
    // That second row is why this is a pragma and not a new trigger: it needs no migration, so it
    // protects stores that already exist, and the guard it activates is one that already ships.
    //
    // **The global-semantics risk the bead warned about, checked rather than waved away.** Turning
    // recursion on also lets a trigger fire from its own action. No trigger in this schema writes to
    // its own table -- `entries_are_immutable` and `entries_cannot_be_deleted` raise without writing,
    // the two `entry_types` triggers likewise, and `entries_fts_on_insert` writes to `entries_fts` --
    // so there is nothing here for recursion to reach. That is a property of today's DDL, which is
    // why the read-back below is the part that matters: a silently-dropped pragma would reopen the
    // hole without a sound.
    //
    // Settable on a read-only handle like the two above, and it needs to be: a read-only caller
    // cannot write through this hole anyway, but the setting is per connection and the read-back
    // demands it uniformly.
    db.exec('PRAGMA recursive_triggers = ON');

    verifyPragmas(db, { inMemory, busyTimeoutMs });

    const before = userVersion(db);

    // A store from the future is refused on EVERY open, not only on the one that migrates
    // (asc-bcv.9, B5). The guard used to live inside `migrate`, which the read-only path and the
    // `migrate: false` path both skip -- so `asc query`, the command whose read-only-ness is what
    // makes it a defensible allowlist entry, would read a store written by a newer ascend and
    // report whatever the running build made of it. Measured (`/tmp/probe-b5.mjs`): writable threw,
    // read-only and `migrate: false` both succeeded, and `asc query` exited 0 on a v99 store.
    //
    // Unconditional rather than `!inMemory`, because an in-memory database starts at `user_version`
    // 0 every time -- 0 is never ahead, so the exemption would be a branch that cannot change an
    // outcome. One rule for every open is the point of moving it here.
    assertNotAhead(before, SCHEMA_VERSION);

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
        : // `file` is passed through so a `LedgerMismatchError` (asc-u11) can name the exact
          // repair command against the exact path, rather than a placeholder.
          migrate(db, undefined, file);

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
    // And a lock conflict anywhere in the open -- the pragmas above, or the migration below --
    // becomes the same actionable error as a conflict at the constructor. This is the site that
    // actually fires: 91 of 91 measured failures landed here.
    return asStoreBusy(error, file);
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
