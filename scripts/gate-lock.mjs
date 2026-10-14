/**
 * One gate at a time, across sessions.
 *
 * WHY THIS EXISTS. `asc-09wx.14`'s second cut. Two Claude sessions committing in one checkout run
 * two suites at once, and the cost is not additive: the suite is CPU-bound and already the whole of
 * the gate's cost, so the second run doubles the load the first one is timing under. That is the
 * condition the bead was filed from -- a ten-markdown-file commit still inside the gate after
 * 24 min 42 s while other work loaded the machine. Serialising is worth more than either run.
 *
 * THE SECOND GATE WAITS. It does not fail the commit. A lock that refuses a commit because another
 * session is gating makes one session's work the reason another's cannot land, and the person
 * hitting it has no way to fix it but to wait anyway -- the same wait, with a red on it. Waiting
 * prints whose run it is waiting on, so the person can see that the delay has a cause and a
 * plausible end.
 *
 * A LOCK IS LEFT BEHIND IN TWO WAYS, and both are handled:
 *
 *   1. The holder is gone. A SIGKILL, a closed terminal, a machine that slept. `process.kill(pid, 0)`
 *      says so, and the lock is broken immediately -- no waiting for a run that is not coming.
 *   2. The holder's pid has been handed to something else. Then the pid looks alive and rule 1
 *      cannot fire. The backstop is age, and the age ceiling is scaled off the longest run this
 *      checkout has recorded rather than picked by eye, so it grows as runs do.
 *
 * The multiplier on that ceiling is deliberately generous and is NOT a budget: nothing is graded
 * against it and no run is expected to approach it. It is the backstop for the rare case, so the
 * error that would cost more -- breaking a lock whose gate is merely slow, and running two suites
 * again -- is the one it is tuned away from. Rule 1 is what recovers every ordinary stale lock.
 *
 * THE LOCK IS A COST DEVICE, NOT A CORRECTNESS DEVICE. If it cannot be created at all -- `.ascend`
 * unwritable, something else sitting at the path -- `acquire` returns `ok: false` and the caller is
 * expected to run the gate anyway. A gate that refused a commit because it could not write a lock
 * file would be failing for a reason that has nothing to do with the code, which is the class of
 * defect the gate exists to catch. The failure is reported; it is not obeyed.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOG_PATH } from './gate-log.mjs';

/** Relative to the repository root, beside the gate's run record. Named in `.gitignore`. */
export const LOCK_PATH = '.ascend/gate.lock';

/** The file that names the holder, inside the lock directory. */
export const HOLDER_FILE = 'holder.json';

/** How long a waiting gate sleeps between attempts. */
export const POLL_MS = 1000;

/**
 * The floor under the age ceiling, for a checkout whose log is empty or missing. Not a budget: it
 * is the smallest number that is obviously longer than a gate run, so that a fresh clone -- one
 * that has recorded nothing to scale from -- still has a backstop.
 */
export const STALE_FLOOR_MS = 30 * 60 * 1000;

/** How many of the longest recorded runs a lock may outlive before it is called abandoned. */
export const STALE_MARGIN = 4;

/**
 * @typedef {object} AcquireResult
 * @property {boolean} ok Whether the lock was taken. `false` means run the gate anyway.
 * @property {number} waitedMs Time spent waiting for another holder, in ms. Never inside a step.
 * @property {number | null} holder The pid waited on, or `null` if there was no wait.
 * @property {{ reason: 'dead-pid' | 'aged-out', pid: number | null } | null} broke
 *   The lock this acquisition broke first, if any.
 * @property {string} [error] Why the lock could not be taken at all.
 * @property {() => void} release Removes the lock if this process still holds it. Never throws.
 */

/**
 * @param {unknown} error
 * @returns {string | null}
 */
function codeOf(error) {
  if (!(error instanceof Error) || !('code' in error)) return null;
  const { code } = /** @type {{ code?: unknown }} */ (error);
  return typeof code === 'string' ? code : null;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a pid is running. `EPERM` counts as running: it means something is there that this
 * process is not allowed to signal, and "something is there" is the safe reading when the question
 * is whether to start a second suite.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/**
 * Whether a parsed value is a plain object. `JSON.parse` returns `any`, so nothing it produces is
 * readable until something proves otherwise; this is that proof.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Who holds the lock, or `null` if that cannot be read -- a holder file not yet written, a torn
 * write, a directory someone else has already removed. `null` is not evidence of no holder; the
 * caller treats it as "ask again", and only age can break it.
 *
 * @param {string} lockDir
 * @returns {{ pid: number, at: string | null } | null}
 */
function holderOf(lockDir) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(lockDir, HOLDER_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { pid, at } = parsed;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, at: typeof at === 'string' ? at : null };
}

/**
 * The age past which a lock is abandoned, derived from the longest run this checkout has recorded.
 * A run's row carries `total_ms` as the sum of its steps, so this is pure work with no waiting in
 * it -- which is exactly the quantity the ceiling is a bound on.
 *
 * @param {string} root
 * @param {number} floorMs
 * @param {number} margin
 * @returns {number}
 */
export function staleCeilingMs(root, floorMs = STALE_FLOOR_MS, margin = STALE_MARGIN) {
  let longest = 0;
  try {
    for (const line of readFileSync(join(root, LOG_PATH), 'utf8').split('\n')) {
      if (line === '') continue;
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn final line: a run writing its row while this one read it. Skipping it costs
        // nothing, because the next completed run's row supersedes it.
        continue;
      }
      if (!isRecord(parsed)) continue;
      const total = parsed['total_ms'];
      if (typeof total === 'number' && total > longest) longest = total;
    }
  } catch {
    // No log yet. The floor alone, which is the state every fresh clone is in.
  }
  return Math.max(floorMs, longest * margin);
}

/**
 * Sleeps without spinning. `Atomics.wait` on a zero-valued slot is Node's synchronous sleep; a
 * polling loop built on `Date.now()` would burn a core that the suite being waited for needs.
 *
 * @param {number} ms
 * @returns {void}
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Takes the gate lock, waiting for whoever holds it.
 *
 * @param {object} [options]
 * @param {string} [options.root] Repository root; the lock lives under it.
 * @param {number} [options.pollMs]
 * @param {number} [options.staleFloorMs]
 * @param {number} [options.staleMargin]
 * @param {(message: string) => void} [options.report] Where the wait is described, for a human.
 * @returns {AcquireResult}
 */
export function acquire({
  root = process.cwd(),
  pollMs = POLL_MS,
  staleFloorMs = STALE_FLOOR_MS,
  staleMargin = STALE_MARGIN,
  report = () => undefined,
} = {}) {
  const lockDir = join(root, LOCK_PATH);
  const holderFile = join(lockDir, HOLDER_FILE);
  try {
    // `.ascend` holds the record tree, so it exists in this checkout -- but a checkout where it did
    // not would fail every gate with `ENOENT` on a path the caller never named. Same reasoning, and
    // the same one-liner, as `gate-log.mjs`'s write.
    mkdirSync(dirname(lockDir), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      waitedMs: 0,
      holder: null,
      broke: null,
      error: messageOf(error),
      release: () => undefined,
    };
  }
  /** @type {bigint | null} */
  let waitedSince = null;
  /** @type {number | null} */
  let holder = null;
  /** @type {AcquireResult['broke']} */
  let broke = null;

  for (;;) {
    let created = false;
    try {
      // `mkdir` and not `open`: creating a directory is atomic and fails with `EEXIST` when it is
      // already there, which is the whole test. Nothing is created-then-checked.
      mkdirSync(lockDir);
      created = true;
      writeFileSync(
        holderFile,
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
        'utf8',
      );
      const waited = waitedSince === null ? 0 : Number(process.hrtime.bigint() - waitedSince);
      return {
        ok: true,
        waitedMs: Math.round(waited / 1e6),
        holder,
        broke,
        release: () => {
          releaseLock(lockDir, holderFile, report);
        },
      };
    } catch (error) {
      if (created) {
        // We own the directory and could not say who we are. Leaving it would look to the next run
        // exactly like a holder that cannot be named, so take it back down.
        rmSync(lockDir, { recursive: true, force: true });
        return {
          ok: false,
          waitedMs: 0,
          holder,
          broke,
          error: messageOf(error),
          release: () => undefined,
        };
      }
      if (codeOf(error) !== 'EEXIST') {
        return {
          ok: false,
          waitedMs: 0,
          holder,
          broke,
          error: messageOf(error),
          release: () => undefined,
        };
      }
    }

    /** @type {{ ageMs: number, isDir: boolean }} */
    let existing;
    try {
      const stats = statSync(lockDir);
      existing = { ageMs: Date.now() - stats.mtimeMs, isDir: stats.isDirectory() };
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue; // Released between the two calls. Take it now.
      return {
        ok: false,
        waitedMs: 0,
        holder,
        broke,
        error: messageOf(error),
        release: () => undefined,
      };
    }
    if (!existing.isDir) {
      // Something that is not a lock is sitting at the path. Waiting on it would wait forever, so
      // this is a failure to report rather than a lock to wait for -- and the caller runs anyway.
      return {
        ok: false,
        waitedMs: 0,
        holder,
        broke,
        error: `${lockDir} exists and is not a directory`,
        release: () => undefined,
      };
    }

    const current = holderOf(lockDir);
    /** @type {'dead-pid' | 'aged-out' | null} */
    let reason = null;
    if (current !== null && !pidAlive(current.pid)) reason = 'dead-pid';
    else if (existing.ageMs > staleCeilingMs(root, staleFloorMs, staleMargin)) reason = 'aged-out';

    if (reason !== null) {
      const who = current === null ? 'an unnamed holder' : `pid ${String(current.pid)}`;
      const why =
        reason === 'dead-pid'
          ? `is gone, so the run it held is over`
          : `has held the lock for ${String(Math.round(existing.ageMs / 1000))} s, longer than any run recorded here`;
      report(`the gate lock held by ${who} ${why} -- breaking it`);
      rmSync(lockDir, { recursive: true, force: true });
      broke = { reason, pid: current === null ? null : current.pid };
      continue;
    }

    if (waitedSince === null) {
      waitedSince = process.hrtime.bigint();
      holder = current === null ? null : current.pid;
      const who = current === null ? 'another gate run' : `pid ${String(current.pid)}`;
      const since =
        current?.at === null || current?.at === undefined ? '' : `, since ${current.at}`;
      report(`${who} holds the gate lock${since} -- waiting for it to finish`);
    }
    sleepMs(pollMs);
  }
}

/**
 * Removes the lock, if it is still the one this process took. A gate that was broken as stale and
 * then finished would otherwise remove the lock of the gate that replaced it, and a third run would
 * start beside that one -- the concurrency this module exists to end. Never throws: releasing
 * happens in a `finally`, where a throw would replace the gate's own verdict.
 *
 * @param {string} lockDir
 * @param {string} holderFile
 * @param {(message: string) => void} report
 * @returns {void}
 */
function releaseLock(lockDir, holderFile, report) {
  const current = holderOf(lockDir);
  if (current === null || current.pid !== process.pid) {
    report(`not releasing the gate lock: it is no longer held by this run`);
    return;
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    // Reported and ignored, for the reason above: an unremovable lock is recovered by the age
    // ceiling, and a commit is not worth losing over it.
    report(`could not remove the gate lock: ${messageOf(error)}`);
  }
}
