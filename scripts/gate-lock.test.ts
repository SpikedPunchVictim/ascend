import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HOLDER_FILE, LOCK_PATH, acquire } from './gate-lock.mjs';

/**
 * One gate at a time across sessions: the mechanism, and the ways it could go wrong.
 *
 * The failure this guards against is not a deadlock -- it is the opposite. Two gates running two
 * suites at once is the load that made a ten-markdown-file commit take 24 min 42 s, so a lock that
 * is *broken too eagerly* re-creates the condition the cut exists to remove, and one that is broken
 * too rarely turns a stolen lock into a commit that never happens. Both directions are pinned here,
 * plus the two ways a lock is left behind: a killed holder, and a holder whose pid the OS has since
 * handed to something else.
 *
 * `acquire` takes an injected `report`, so the messages a human sees during a wait are assertable
 * without driving a subprocess and without capturing stdout.
 */

/** Every directory this file made, so the suite removes exactly those and nothing else. */
const made: string[] = [];

/** Every helper process this file started, so the suite can end exactly those and nothing else. */
const started: number[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-gate-lock-'));
  made.push(dir);
  return dir;
}

afterAll(() => {
  // By their exact recorded paths and pids, never by a wildcard over the shared temp directory.
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // Already finished, which is the ordinary case: each helper exits on its own.
    }
  }
});

/**
 * Hands the lock back after `ms`, from ANOTHER PROCESS.
 *
 * A `setTimeout` in this one cannot do it. `acquire` blocks the event loop on purpose -- a
 * synchronous sleep is what keeps the gate one process rather than a state machine -- and a timer
 * in a blocked thread never fires. Measured 2026-10-13: the first version of this test hung until
 * vitest was killed by hand. A separate process is also the honest shape of what is being tested,
 * where the holder is always another session.
 */
function releaseAfter(dir: string, ms: number): void {
  const lockDir = join(dir, LOCK_PATH);
  const script =
    'setTimeout(() => {' +
    `require('node:fs').rmSync(${JSON.stringify(lockDir)}, { recursive: true, force: true });` +
    `}, ${String(ms)});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  if (child.pid !== undefined) started.push(child.pid);
}

/** Writes a lock held by `pid`, the way a gate that is mid-run would have left it. */
function holdLock(dir: string, pid: number): void {
  const lockDir = join(dir, LOCK_PATH);
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, HOLDER_FILE),
    `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`,
    'utf8',
  );
}

/** A pid that is certainly gone: a process this test started and already reaped. */
function deadPid(): number {
  // The child names itself, and `spawnSync` reaps it before returning, so the number is a process
  // that has certainly exited -- which is the fixture. Reading `child.pid` instead would work and
  // would need a type assertion, because a spawn that failed leaves it undefined at run time while
  // the types say it cannot be.
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  const pid = Number(child.stdout);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`could not obtain a pid to kill, got ${child.stdout}`);
  }
  return pid;
}

/** Ages the lock, and nothing else about it, so only the age rules can fire. */
function age(dir: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(join(dir, LOCK_PATH), when, when);
}

describe('taking the gate lock', () => {
  it('takes it when nobody holds it, and does not wait', () => {
    const dir = tempDir();
    const result = acquire({ root: dir });

    expect(result.ok).toBe(true);
    // Exactly zero, not "small": the wait is accumulated only while a holder is present, so an
    // uncontended run has no elapsed waiting to report at all.
    expect(result.waitedMs).toBe(0);
    expect(result.holder).toBeNull();
    expect(result.broke).toBeNull();
    expect(existsSync(join(dir, LOCK_PATH, HOLDER_FILE))).toBe(true);
  });

  it('waits for a live holder, says whose run it is, and reports how long it waited', () => {
    const dir = tempDir();
    // This process's own pid: alive by construction, so the wait cannot be short-circuited by the
    // dead-holder rule and the test measures the wait rather than the recovery.
    holdLock(dir, process.pid);
    const reported: string[] = [];
    releaseAfter(dir, 500);

    const result = acquire({ root: dir, pollMs: 25, report: (message) => reported.push(message) });

    expect(result.ok).toBe(true);
    expect(result.broke).toBeNull();
    expect(result.holder).toBe(process.pid);
    // A lower bound nothing can make flaky: the release is on a 500 ms timer in a process that was
    // already running when `acquire` was called, so it cannot have fired before then.
    expect(result.waitedMs).toBeGreaterThanOrEqual(400);
    // The person whose commit is now queued behind another session's suite is told whose it is.
    expect(reported.some((message) => message.includes(String(process.pid)))).toBe(true);
  });

  it('breaks a lock whose holder is gone, and says so', () => {
    // A killed gate -- SIGKILL, a closed terminal, a machine that slept -- leaves the lock behind
    // with a pid nothing is running. Without this rule the next commit waits for a run that is
    // never coming, which is a commit that never happens.
    const dir = tempDir();
    const gone = deadPid();
    holdLock(dir, gone);
    // An escape hatch, and every test of an unblocking rule below has one. `acquire` blocks, so a
    // version of it that fails to break a lock it should have broken does not fail this test -- it
    // WAITS, out the whole age ceiling, and takes the mutation run with it. With the lock released
    // from outside after 300 ms, that mutant proceeds and then fails on the assertions, in a
    // fraction of a second. Nothing here can reach the hatch in the unmutated code: the lock is
    // broken within a millisecond of the first attempt.
    releaseAfter(dir, 300);
    const reported: string[] = [];

    const result = acquire({
      root: dir,
      pollMs: 25,
      staleFloorMs: 10 * 60 * 1000,
      report: (message) => reported.push(message),
    });

    expect(result.ok).toBe(true);
    expect(result.broke).toEqual({ reason: 'dead-pid', pid: gone });
    expect(result.waitedMs).toBe(0);
    expect(reported.some((message) => message.includes('gone'))).toBe(true);
  });

  it('breaks a lock held far longer than any run it has seen, without waiting for the pid', () => {
    // The dead-holder rule cannot catch this one: a recycled pid looks alive to `process.kill`, so
    // the age ceiling is the backstop. Age is the only thing that can break it, so the ceiling is
    // scaled off the longest run this checkout has recorded rather than picked by eye. The hatch is
    // the one described above.
    const dir = tempDir();
    holdLock(dir, process.pid);
    age(dir, 4 * 60 * 60 * 1000);
    releaseAfter(dir, 300);

    const result = acquire({
      root: dir,
      pollMs: 25,
      staleFloorMs: 30 * 60 * 1000,
      report: () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.broke?.reason).toBe('aged-out');
    expect(result.broke?.pid).toBe(process.pid);
    expect(result.waitedMs).toBe(0);
  });

  it('does not break a live lock that is merely slow', () => {
    // The mirror of the test above, and the one that matters more: this bead exists BECAUSE runs
    // keep getting longer, so a ceiling pinned tight to the longest recorded run would break a live
    // lock exactly when a run is unusually slow -- two suites at once, the condition being removed.
    const dir = tempDir();
    holdLock(dir, process.pid);
    // Half the floor: old enough to be worth suspecting, far too young to be abandoned.
    age(dir, 15 * 60 * 1000);
    releaseAfter(dir, 300);

    const result = acquire({ root: dir, pollMs: 25, staleFloorMs: 30 * 60 * 1000 });

    expect(result.ok).toBe(true);
    expect(result.broke).toBeNull();
    expect(result.holder).toBe(process.pid);
  });

  it('releases only a lock it still holds', () => {
    // A gate that was broken as stale and then finished would otherwise delete the lock of the gate
    // that replaced it, letting a third run in beside it -- the concurrency this cut exists to end.
    const dir = tempDir();
    const mine = acquire({ root: dir });
    holdLock(dir, process.pid + 1);

    mine.release();

    expect(existsSync(join(dir, LOCK_PATH, HOLDER_FILE))).toBe(true);
  });

  it('hands the lock back when released', () => {
    const dir = tempDir();
    const first = acquire({ root: dir });
    first.release();

    expect(existsSync(join(dir, LOCK_PATH))).toBe(false);
    const second = acquire({ root: dir });
    expect(second.ok).toBe(true);
    second.release();
  });

  it('runs the gate anyway when the lock cannot be created at all', () => {
    // The lock is a cost device, not a correctness device. One that cannot be created must not
    // become a new way for a commit to be refused -- a gate failing for a reason unrelated to the
    // code is the class of defect the gate exists to catch.
    const dir = tempDir();
    mkdirSync(join(dir, '.ascend'), { recursive: true });
    writeFileSync(join(dir, '.ascend', 'gate.lock'), 'not a directory\n', 'utf8');

    const result = acquire({ root: dir, pollMs: 25 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('gate.lock');
    // And a caller that ignores `ok` cannot make it worse: releasing is a no-op, and what was in
    // the way is still there.
    result.release();
    expect(statSync(join(dir, '.ascend', 'gate.lock')).isFile()).toBe(true);
  });
});
