import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stepEnv } from './gate-env.mjs';
import { HOLDER_FILE, LOCK_PATH, POLL_MS } from './gate-lock.mjs';
import { ALIGN_STEP, STEPS, scopeFor, skippedFor, stepsFor } from './gate.mjs';

/**
 * The gate runner's decisions, held to the standard the gate holds everything else to.
 *
 * `scripts/gate.mjs` is the thing that decides whether a commit is allowed, and `asc-09wx.14`
 * turns it into something that also decides what it can SKIP. A skip rule that fails open is the
 * worst defect this repository can have: it is a green verdict nobody earned, and `dogfood/0061`
 * is the record of exactly that shape costing a real regression. So the corners tested here are
 * not the happy paths; they are the specific ways this runner could report a green it did not
 * earn -- a step it never ran, a status it never captured, a log it could not write.
 *
 * Two layers, deliberately. The pure layer imports `stepsFor` and asserts the run's SHAPE without
 * spawning anything. The second layer drives the real file as a subprocess in a throwaway
 * directory with `pnpm` and `node` stubbed on `PATH` -- the technique
 * `packages/cli/test/dev-hooks.test.ts` uses -- so a test never runs the real suite, never needs
 * this checkout's index to be in a particular state, and never appends to the real gate log.
 */

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));
const DUPLICATE_IDS = fileURLToPath(new URL('./gate-duplicate-ids.mjs', import.meta.url));

/** One step's outcome inside a run's row. */
interface StepRow {
  readonly label: string;
  readonly ms: number;
  readonly status: number;
}

/** One gate run's row, as `scripts/gate-log.mjs` writes it. */
interface RunRow {
  readonly v: number;
  readonly at: string;
  readonly head: string | null;
  /**
   * What this run READ, as opposed to what the checkout pointed at (`asc-rzhr`). `head` is the right
   * answer to "which checkout was this?" and the wrong answer to "what did that verdict cover?" --
   * under a `but` commit the two are different commits. `null` in a directory that is not a
   * repository, which is most of this file's fixtures.
   */
  readonly tree?: string | null;
  readonly work?: string | null;
  readonly staged: { readonly count: number; readonly top: Record<string, number> } | null;
  readonly steps: readonly StepRow[];
  readonly total_ms: number;
  /**
   * The gate's own clock across the step loop and the lock release that closes it. The only
   * reading in this row that shares a window with `total_ms`, so `total_ms <= wall_ms` is a
   * statement about the gate's accounting rather than about how busy the machine is.
   */
  readonly wall_ms: number;
  /** Time spent queueing behind another session's gate. Never part of any step's `ms`. */
  readonly waited_ms: number;
  /** Which stale-lock rule fired, if this run had to break one. */
  readonly broke_lock: string | null;
  readonly outcome: string;
  readonly blocked_at: string | null;
  readonly loadavg: readonly number[];
  /** Which path this run took: `inert`, `tests` or `full`. */
  readonly scope?: string;
  /** Steps this run deliberately did not run, with the reason each was left out. */
  readonly skipped?: readonly { readonly step: string; readonly why: string }[];
}

interface Stubs {
  /** What the stubbed `pnpm` exits with, for every `pnpm` step. */
  readonly pnpmExit?: number;
  /** What the stubbed `node` exits with for the store-guard invocation. */
  readonly storeExit?: number;
  /** What the stubbed `node` exits with for the test-count check. */
  readonly countExit?: number;
  /**
   * Leaves `pnpm` off `PATH` entirely, so a step's command cannot be started at all. `PATH` is
   * then the stub directory alone -- the real `pnpm` would otherwise satisfy the lookup and the
   * test would silently become a test of the real formatter.
   */
  readonly noPnpm?: boolean;
  /**
   * Seconds the stubbed `pnpm` sleeps before exiting, so a step's duration can be held to a
   * GUARANTEED lower bound. `sleep` cannot return early, so an assertion of the form "this step
   * took at least this long" is one that never flakes -- unlike a threshold picked to be "about
   * right", which is the shape of every timing test that later fails under load.
   */
  readonly pnpmSleep?: string;
  /** Extra environment for the run, e.g. `ASCEND_PRECOMMIT_FULL`. */
  readonly env?: Record<string, string>;
  /**
   * Makes the stubbed `pnpm` print its own arguments and the scope variable it was handed. The one
   * thing a pure assertion cannot check is the WIRE: `stepsFor` can say a step carries an argument
   * and an environment, and only a real run can show they arrived.
   */
  readonly pnpmEcho?: boolean;
  /**
   * Runs against the run directory after the sandbox is built and before the gate starts, so a test
   * can leave something in the gate's way -- a lock another session is holding, most of all.
   */
  readonly prepare?: (dir: string) => void;
}

/**
 * How long the contended test holds the lock: past the gate's first poll, so the first attempt that
 * can succeed is the second one and the wait is a whole poll interval at least.
 */
const HOLD_MS = POLL_MS + 500;

/**
 * How long the dead-holder test's safety net waits before removing the lock it left.
 *
 * IT MUST OUTLAST THE GATE'S OWN BOOT, and that is a measured constraint rather than a margin picked
 * by eye. The net exists so that a gate which FAILED to break the stale lock waits a bounded time and
 * then goes red on its assertions, instead of hanging -- a mutation run cannot afford a killer that
 * hangs. But the net is another `node` process with its own boot, so a short timer races the gate's:
 * this was 100 ms until 2026-10-13, and under load the child's timer fired before the gate's
 * `acquire` ran, the lock was gone, the gate took it clean and the row said `broke_lock: null` --
 * a false red against code that was correct. Past one poll, the gate has certainly arrived and the
 * net can only be reached by a gate that is genuinely stuck in the wait loop.
 */
const STALE_RELEASE_MS = POLL_MS + 1000;

/**
 * The slack allowed between the gate's summed step durations and its own clock across the loop.
 * It is not a load allowance and does not grow with the machine: the seven step durations are each
 * rounded to a millisecond, worth at most 3.5 ms in total, and everything else inside the window
 * (each step's `[pre-commit] …` line, the lock release) is inside `wall_ms` and outside `total_ms`,
 * which leans the difference the safe way.
 */
const LOOP_SLACK_MS = 50;

/**
 * The seven labels a person sees today, in order. Literal, not `STEPS.map(…)`: these strings are a
 * contract asserted by `packages/cli/test/dev-hooks.test.ts`, so writing them out catches a reorder
 * or a rename that an assertion against the same array could not. The tests below then slice it,
 * which is how "the cut removed exactly this much" is stated without a second copy of the list.
 */
const WHOLE_RUN = [
  'format:check',
  'typecheck',
  'store verify --staged',
  'duplicate entry ids',
  'lint',
  'test',
  'test count',
];

/** Every directory this file made, so the suite can remove exactly those and nothing else. */
const made: string[] = [];

/** Every helper process this file started, so the suite can end exactly those and nothing else. */
const started: number[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

/** Writes the gate lock held by `pid`, the way a session that is mid-gate would have left it. */
function holdLock(dir: string, pid: number): void {
  mkdirSync(join(dir, LOCK_PATH), { recursive: true });
  writeFileSync(
    join(dir, LOCK_PATH, HOLDER_FILE),
    `${JSON.stringify({ pid, at: new Date().toISOString() })}\n`,
    'utf8',
  );
}

/** Ages the lock, and nothing else about it, so only the age rules can fire. */
function age(dir: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(join(dir, LOCK_PATH), when, when);
}

/**
 * Hands the lock back after `ms`, from ANOTHER PROCESS: the gate sleeps synchronously while it
 * waits, so a timer in this process would never fire and the test would hang. The pid used is this
 * process's, which is alive, so the wait cannot be short-circuited by the dead-holder rule.
 */
function releaseAfter(dir: string, ms: number): void {
  const script =
    'setTimeout(() => {' +
    `require('node:fs').rmSync(${JSON.stringify(join(dir, LOCK_PATH))}, { recursive: true, force: true });` +
    `}, ${String(ms)});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  if (child.pid !== undefined) started.push(child.pid);
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

/**
 * Writes the stubs into a fresh directory and returns both it and the run directory. The stub
 * directory is a SIBLING of the run directory, not a child: the "what kind of files are staged"
 * test runs `git add -A` in the run directory, and stubs living inside it were staged along with
 * the fixture (measured: a three-file fixture reported five).
 *
 * `node` is stubbed for the same reason `pnpm` is: left real, the store guard would run against
 * THIS checkout's index and the run's control flow would become a test of whatever happens to be
 * staged today.
 *
 * The duplicate-id check is the one `node` invocation that is NOT answered by a stub: it is run for
 * real, by absolute path, because the fixture has no `scripts/` of its own and a stubbed answer
 * would make the step a label with nothing behind it. It reads the index of the repository it is run
 * in. A run directory that a test has staged into is one, and is read; any other is not, and the check
 * is pointed at an empty repository instead (with no repository it exits 2, "nothing was compared").
 * The run directory is not made a repository for every test: a repository there switches on the
 * gate's tree memo, which is a different control flow from the one most of these tests are about.
 */
function sandbox(stubs: Stubs): { dir: string; bin: string } {
  const dir = tempDir('asc-gate-unit-');
  const bin = tempDir('asc-gate-bin-');
  // A repository with nothing staged, for the duplicate-id check to read when the run directory is not
  // one. See the note on `sandbox` for why the run directory is not simply made a repository.
  const emptyRepo = join(bin, 'empty-repo');
  mkdirSync(emptyRepo);
  execFileSync('git', ['init', '-q'], { cwd: emptyRepo, stdio: 'ignore' });

  if (!stubs.noPnpm) {
    const fakePnpm = join(bin, 'pnpm');
    writeFileSync(
      fakePnpm,
      '#!/bin/sh\n' +
        (stubs.pnpmEcho === true
          ? 'echo "pnpm-stub: $* [ASCEND_TEST_SCOPE=$ASCEND_TEST_SCOPE]"\n'
          : '') +
        (stubs.pnpmSleep === undefined ? '' : `sleep ${stubs.pnpmSleep}\n`) +
        `exit ${String(stubs.pnpmExit ?? 0)}\n`,
      'utf8',
    );
    chmodSync(fakePnpm, 0o755);
  }

  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      `  *packages/cli/dist/bin.js*) exit ${String(stubs.storeExit ?? 0)} ;;\n` +
      `  *scripts/test-baseline.mjs*) exit ${String(stubs.countExit ?? 0)} ;;\n` +
      `  *scripts/gate-duplicate-ids.mjs*)\n` +
      `    git rev-parse --git-dir >/dev/null 2>&1 || cd ${JSON.stringify(emptyRepo)}\n` +
      `    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(DUPLICATE_IDS)} ;;\n` +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    'utf8',
  );
  chmodSync(fakeNode, 0o755);

  return { dir, bin };
}

/** The environment a stubbed run needs: the stubs first, then (usually) the real `PATH`. */
function runEnv(bin: string, noPnpm: boolean, extra: Record<string, string> = {}) {
  const prelude = noPnpm ? bin : `${bin}:${process.env['PATH'] ?? ''}`;
  // `stepEnv` and not `{ ...process.env, ... }`, so the gate under test is run in the mode THIS FILE
  // chose rather than in whatever mode the process that started the suite was in. It is the same
  // function the runner uses for the steps it spawns (`scripts/gate-env.mjs`), because it is the same
  // problem: an ambient `ASCEND_GATE_HOOK` or `ASCEND_PRECOMMIT_FULL` reaching a gate that nobody told
  // to be in that mode. Measured 2026-10-14, with the two variables the pre-push hook exports exported
  // by hand, this file's own suite went 14 red out of 32 -- a false red with nothing wrong in the tree.
  //
  // `ASCEND_TEST_SCOPE` is cleared for the same reason, and it is not in the control list because a step
  // states its own: a suite started with `ASCEND_TEST_SCOPE=subset` (as the owner runs this file) would
  // otherwise hand `subset` to every stubbed check and fail the wire test that asserts they got nothing.
  return stepEnv(process.env, { ASCEND_TEST_SCOPE: '', ...extra, PATH: prelude });
}

/**
 * Turns a sandbox into a commit: a fresh repository, the named files written and STAGED. The paths
 * are repo-relative, as `git diff --cached --name-only` prints them, because that output is the
 * scope's input -- a test that staged through some other route would be asserting about a staged
 * set the gate never sees.
 */
function stageIn(dir: string, files: readonly string[]): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  for (const path of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'fixture\n', 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
}

function runGate(
  stubs: Stubs = {},
  /** Written and staged before the gate starts, so a run has something to derive a scope from. */
  stage?: readonly string[],
): {
  status: number | null;
  output: string;
  dir: string;
  /** Wall clock around the whole gate process, in ms. The ceiling for `total_ms`. */
  elapsed: number;
  log: readonly RunRow[];
} {
  const { dir, bin } = sandbox(stubs);
  if (stage !== undefined) stageIn(dir, stage);
  stubs.prepare?.(dir);
  const started = performance.now();
  const result = spawnSync(process.execPath, [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: runEnv(bin, stubs.noPnpm ?? false, stubs.env),
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    dir,
    elapsed: performance.now() - started,
    log: readLog(dir),
  };
}

function readLog(dir: string): readonly RunRow[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.ascend', 'gate-runs.jsonl'), 'utf8');
  } catch {
    // No file is a real state (a run that could not write one), not a test failure.
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RunRow);
}

describe('the shape of a run', () => {
  it('runs the fast path by default, in the order a reader sees', () => {
    expect(stepsFor({}).map((step) => step.label)).toEqual(WHOLE_RUN);
  });

  it('adds align check, and only aligns, under ASCEND_PRECOMMIT_FULL', () => {
    const fast = stepsFor({});
    const full = stepsFor({ ASCEND_PRECOMMIT_FULL: '1' });

    expect(full).toHaveLength(fast.length + 1);
    expect(full.slice(0, fast.length)).toEqual(fast);
    expect(full.at(-1)?.label).toBe('align check');
    expect(ALIGN_STEP.args).toEqual(['check']);
  });

  it('does not treat any other value of ASCEND_PRECOMMIT_FULL as full', () => {
    // `isSet` is an equality test, not a truthiness test. `ASCEND_PRECOMMIT_FULL=0` is the
    // documented way to say "fast", and a truthiness bug would read it as "full".
    expect(stepsFor({ ASCEND_PRECOMMIT_FULL: '0' })).toHaveLength(7);
    expect(stepsFor({ ASCEND_PRECOMMIT_FULL: '' })).toHaveLength(7);
  });

  it('names every step command, so none is a label with nothing behind it', () => {
    for (const step of STEPS) {
      expect(step.command).not.toBe('');
      expect(step.args.length).toBeGreaterThan(0);
    }
  });
});

describe('the scope a run takes', () => {
  it('runs the checks but not the suite when nothing staged is read by a test', () => {
    // The five checks stay, and that is not an oversight: `store verify --staged` validates exactly
    // the staged JSONL this case is about, and it is cheap next to the suite it replaces.
    const scope = scopeFor({}, ['.ascend/entries/note-1a2b/0001.jsonl']);
    expect(scope.kind).toBe('inert');
    expect(stepsFor({}, scope).map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 5));
  });

  it('swaps the suite for the packages the staged paths reach, and drops the baseline check', () => {
    const steps = stepsFor({}, scopeFor({}, ['packages/store/src/pages.ts']));
    const subset = steps.at(-1);

    expect(steps.map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 6));
    expect(subset?.command).toBe('pnpm');
    expect(subset?.args).toEqual([
      'exec',
      'vitest',
      'run',
      'packages/cli/test',
      'packages/core/test',
      'packages/store/test',
    ]);
    // `ASCEND_TEST_SCOPE` is what stops `vitest.test-count.ts` overwriting `.testcount/scan.json`
    // with a subset, which would make the baseline check report a breach on every commit.
    expect(subset?.env).toEqual({ ASCEND_TEST_SCOPE: 'subset' });
  });

  it('states the full scope on the suite step rather than leaving it to be inherited', () => {
    // The other direction of the same variable, and the one that was measured the hard way. A full
    // run that set nothing would read as full only while nothing above it had set `subset` -- and the
    // gate's subset step exports that to every process below it, so a gate nested inside a subset run
    // would run the whole suite while telling the reporter it was narrowed. The scan would not be
    // written, and the baseline check would compare some earlier run's scan. Stated explicitly, the
    // step says which run it is whatever it inherited.
    const suite = stepsFor({}, scopeFor({}, ['package.json'])).find(
      (step) => step.label === 'test',
    );

    expect(suite?.args).toEqual(['test']);
    expect(suite?.env).toEqual({ ASCEND_TEST_SCOPE: '' });
  });

  it('prints the subset under the label the full suite uses, so the label contract holds', () => {
    // `dev-hooks.test.ts` asserts on these strings. A subset with its own label would be a new
    // string in the contract for no gain: both steps are "the tests this commit runs".
    const subset = stepsFor({}, scopeFor({}, ['packages/analysis/src/rules.ts'])).at(-1);
    expect(subset?.label).toBe(STEPS.find((step) => step.label === 'test')?.label);
  });

  it('does not narrow the check steps, which take no scope', () => {
    for (const step of stepsFor({}, scopeFor({}, ['packages/store/src/pages.ts'])).slice(0, 5)) {
      expect(step.env).toBeUndefined();
    }
  });

  it('names what the run did not do, per scope', () => {
    // A skip that leaves no trace is indistinguishable from a check that was never wired, and
    // `dogfood/0061` is the record of that shape costing a real regression.
    expect(skippedFor({ kind: 'full', why: 'nothing to cut' })).toEqual([]);
    expect(skippedFor({ kind: 'inert', paths: [] }).map((entry) => entry.step)).toEqual([
      'test',
      'test count',
    ]);
    expect(
      skippedFor({ kind: 'tests', packages: [], files: [] }).map((entry) => entry.step),
    ).toEqual(['test count']);
    for (const entry of skippedFor({ kind: 'tests', packages: [], files: [] })) {
      expect(entry.why).not.toBe('');
    }
  });

  it('takes no cut at all when the environment asks for the whole thing', () => {
    const paths = ['.ascend/entries/note-1a2b/0001.jsonl'];

    // Two names for the same request, deliberately: `ASCEND_PRECOMMIT_FULL` is the umbrella a
    // person sets (it also adds `align check`), and `ASCEND_GATE_SCOPE=full` is the narrow one a
    // FIXTURE sets when it needs today's control flow without reaching the real `align` binary.
    expect(scopeFor({ ASCEND_GATE_SCOPE: 'full' }, paths).kind).toBe('full');
    expect(scopeFor({ ASCEND_PRECOMMIT_FULL: '1' }, paths).kind).toBe('full');

    // Equalities, not truthiness tests: neither variable is a flag with a "set" meaning.
    expect(scopeFor({ ASCEND_GATE_SCOPE: 'FULL' }, paths).kind).toBe('inert');
    expect(scopeFor({ ASCEND_GATE_SCOPE: '1' }, paths).kind).toBe('inert');
    expect(scopeFor({ ASCEND_PRECOMMIT_FULL: '0' }, paths).kind).toBe('inert');
  });

  it('cannot cut anything under ASCEND_PRECOMMIT_FULL, whatever is staged', () => {
    // The two variables cannot disagree, because the umbrella implies the narrow one. If they could,
    // the escape hatch would be a hatch that leaves some cuts closed.
    const env = { ASCEND_PRECOMMIT_FULL: '1' };
    for (const paths of [
      [],
      ['.ascend/entries/note-1a2b/0001.jsonl'],
      ['packages/core/src/cursor.ts'],
    ]) {
      expect(scopeFor(env, paths).kind, paths.join(',')).toBe('full');
    }
    expect(stepsFor(env).map((step) => step.label)).toEqual([...WHOLE_RUN, 'align check']);
  });

  it('runs everything when the staged set could not be read at all', () => {
    // `null` is "nobody knows", which is not the same as "nothing staged" -- and it is not a cut.
    expect(scopeFor({}, null)).toEqual({ kind: 'full', why: 'the staged set could not be read' });
  });

  it('derives the scope from the paths it is handed, never from the environment alone', () => {
    expect(scopeFor({}, []).kind).toBe('full');
    expect(scopeFor({}, ['CLAUDE.md']).kind).toBe('full');
    expect(scopeFor({}, ['packages/core/src/cursor.ts']).kind).toBe('tests');
    expect(scopeFor({}, ['.beads/interactions.jsonl']).kind).toBe('inert');
  });
});

describe('driving the real gate', () => {
  it('stops at the first failing step, and does not run the ones after it', () => {
    // Formatting is the first step, so a failure there is the cheapest possible red. A runner
    // that ran the suite anyway would report the same status and cost minutes to say it.
    const { status, output, log } = runGate({ pnpmExit: 1 });

    expect(status).toBe(1);
    expect(output).toContain('[pre-commit] format:check');
    expect(output).not.toContain('[pre-commit] typecheck');
    expect(log[0]?.steps.map((step) => step.label)).toEqual(['format:check']);
  });

  it('records one timed row per step, and the run outcome', () => {
    const { status, log } = runGate();

    expect(status).toBe(0);
    const row = log[0];
    expect(row?.outcome).toBe('ok');
    expect(row?.blocked_at).toBeNull();
    expect(row?.v).toBe(1);
    expect(row?.steps.map((step) => step.label)).toEqual(WHOLE_RUN);
    for (const step of row?.steps ?? []) {
      expect(step.status).toBe(0);
      expect(step.ms).toBeGreaterThanOrEqual(0);
    }
    // The total is the sum of the parts, so a step's cost cannot go missing between them.
    expect(row?.total_ms).toBe((row?.steps ?? []).reduce((sum, step) => sum + step.ms, 0));
  });

  it('records the two trees the run read, so a verdict can be matched to a commit', () => {
    // `asc-rzhr`: without these fields the log could not answer "was this commit gated?", because
    // `head` names the checkout and a `but commit` never advances it. On a clean checkout the two
    // are the same tree; they are recorded separately because the steps read two different things.
    const { status, dir, log } = runGate({}, ['README.md']);
    expect(status).toBe(0);
    const row = log[0];
    expect(row?.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.work).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.tree).toBe(row?.work);
    expect(row?.work).toBe(
      execFileSync('git', ['write-tree'], { cwd: dir, encoding: 'utf8' }).trim(),
    );
  });

  it('records no tree when it records no row, so a fixture run pays for neither', () => {
    const { status, dir, log } = runGate({ env: { ASCEND_GATE_NO_RECORD: '1' } }, ['README.md']);
    expect(status).toBe(0);
    expect(log).toEqual([]);
    expect(existsSync(join(dir, '.ascend', 'gate-runs.jsonl'))).toBe(false);
  });

  it('refuses before any step when core.hooksPath is absolute and inside the repository', () => {
    // `asc-1h3u`: the measured value that turns every hook off after a rename, with no error
    // anywhere -- it used to be caught only by a suite-wide test, twice inside a pre-push gate.
    const { status, log, output } = runGate(
      {
        prepare: (runDir) => {
          mkdirSync(join(runDir, '.beads', 'hooks'), { recursive: true });
          execFileSync('git', ['config', 'core.hooksPath', join(runDir, '.beads', 'hooks')], {
            cwd: runDir,
            stdio: 'ignore',
          });
        },
      },
      ['README.md'],
    );

    expect(status).toBe(2);
    expect(output).toContain('is absolute and inside the repo');
    expect(output).toContain('git config core.hooksPath .beads/hooks');
    const row = log[0];
    expect(row?.outcome).toBe('blocked');
    expect(row?.blocked_at).toBe('core.hooksPath');
    expect(row?.steps).toEqual([]);
    // It read nothing, so it claims nothing: a preflight refusal covers no commit.
    expect(row?.tree).toBeNull();
    expect(row?.work).toBeNull();
  });

  it("blocks with the failing step's own status, not a generic one", () => {
    // The store guard exits 2 for "an input was missing", which is a different fact from 1
    // ("compared and breached"). Collapsing both to 1 loses the distinction the guard exists
    // to make -- the same reasoning the hook carries for its own exit codes.
    const { status, log } = runGate({ storeExit: 2 });

    expect(status).toBe(2);
    expect(log[0]?.blocked_at).toBe('store verify --staged');
    expect(log[0]?.outcome).toBe('blocked');
  });

  it('blocks on a staged record tree that holds one entry id twice, and passes a clean one', () => {
    const entry = (recordedAt: string): string =>
      `${JSON.stringify({ kind: 'entry', id: 'dup-1', recorded_at: recordedAt })}\n`;
    const stageRecords = (dir: string, text: string): void => {
      mkdirSync(join(dir, '.ascend', 'entries'), { recursive: true });
      writeFileSync(join(dir, '.ascend', 'entries', 'note.jsonl'), text, 'utf8');
      execFileSync('git', ['add', '.ascend/entries/note.jsonl'], { cwd: dir, stdio: 'ignore' });
    };

    // `[]` stages nothing of its own and makes the run directory a repository, which `prepare` then
    // stages the records into.
    const clean = runGate(
      {
        prepare: (dir) => {
          stageRecords(dir, entry('2026-10-14T00:00:00Z'));
        },
      },
      [],
    );
    expect(clean.status).toBe(0);
    expect(clean.log[0]?.blocked_at).toBeNull();

    const duplicated = runGate(
      {
        prepare: (dir) => {
          stageRecords(dir, entry('2026-10-14T00:00:00Z') + entry('2026-10-14T00:00:01Z'));
        },
      },
      [],
    );
    expect(duplicated.status).toBe(1);
    expect(duplicated.log[0]?.blocked_at).toBe('duplicate entry ids');
    expect(duplicated.log[0]?.steps.at(-1)?.status).toBe(1);
    expect(duplicated.output).toContain('dup-1');
  });

  it('records a blocked run, so the log is not only a log of successes', () => {
    const { log } = runGate({ countExit: 1 });

    expect(log).toHaveLength(1);
    expect(log[0]?.blocked_at).toBe('test count');
    expect(log[0]?.steps.at(-1)?.status).toBe(1);
  });

  it('fails the gate when a step cannot be started at all', () => {
    // Fail closed. `asc-9flv`'s rule: a guard that cannot find its own binary must not read like
    // a guard that looked and found nothing. A missing `pnpm` is 127 here, as a shell would
    // report it -- and the gate blocks rather than skipping the step it could not run.
    const { status, output, log } = runGate({ noPnpm: true });

    expect(status).toBe(127);
    expect(output).toContain('could not run');
    expect(log[0]?.outcome).toBe('blocked');
  });

  it('reaches align check only in full mode', () => {
    const fast = runGate();
    expect(fast.output).not.toContain('[pre-commit] align check');

    // `align` is not stubbed, so in a throwaway directory it cannot be started and the run
    // blocks -- which is itself the assertion that the step was reached.
    const full = runGate({ env: { ASCEND_PRECOMMIT_FULL: '1' } });
    expect(full.output).toContain('[pre-commit] align check');
  });

  it('does not change its verdict when the run record cannot be written', () => {
    // The instrumentation must never be able to break the gate. A measurement that can turn a
    // green gate red is a worse version of the defect the gate exists to prevent, so the write
    // is best-effort and its failure is reported without being obeyed.
    const { dir, bin } = sandbox({});
    // `.ascend` as a FILE, not a directory, so `mkdirSync` cannot succeed.
    writeFileSync(join(dir, '.ascend'), 'not a directory\n', 'utf8');

    const result = spawnSync(process.execPath, [GATE], {
      cwd: dir,
      encoding: 'utf8',
      env: runEnv(bin, false),
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('could not record this run');
  });

  it('does not change its verdict when the memo cannot be written, in a repository', () => {
    // `asc-s3xx`: the same failure with the memo ACTIVE. The test above only covers a run directory
    // that is not a repository, where the memo is off and nothing is written -- and the cleanup path
    // after a failed write threw ENOTDIR from its own lstat, which no test could see.
    const { dir, bin } = sandbox({});
    stageIn(dir, ['README.md']);
    writeFileSync(join(dir, '.ascend'), 'not a directory\n', 'utf8');

    const result = spawnSync(process.execPath, [GATE], {
      cwd: dir,
      encoding: 'utf8',
      env: runEnv(bin, false),
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'could not remember that this tree passed',
    );
  });

  it('times each step on its own, so a duration cannot be a total wearing a step name', () => {
    // `asc-09wx.14` exists because nobody could say what a commit cost. A row of durations is
    // only worth recording if each one belongs to its own step, and the two ways that can go
    // wrong are opposite: a duration that is always zero records nothing, and a duration that
    // is the running total credits every step with everything before it.
    //
    // The slow stub is what makes this assertable without a threshold picked by eye: `sleep`
    // cannot return early, so the four `pnpm` steps are each at least 200 ms, and the three
    // `node` steps -- two the stub answers without exec'ing anything, one the real duplicate-id check
    // on an empty index -- are each far below that. A test that guessed at "fast" would be the flaky one.
    const { log, elapsed } = runGate({ pnpmSleep: '0.2' });

    const row = log[0];
    const steps = row?.steps ?? [];
    // Every step is present, so the bounds below are read off a full row and a step that went
    // missing cannot pass by not being there.
    expect(steps.map((step) => step.label)).toEqual(WHOLE_RUN);
    const ms = (label: string): number => steps.find((step) => step.label === label)?.ms ?? 0;

    // `sleep` cannot return early, so these four are at least 200 ms. An upper bound on the
    // other three is deliberately NOT asserted: measured 2026-10-13 at loadavg 25, a stub that
    // spawns a shell and exits took 227 ms, so "fast" is not a property this machine has.
    for (const label of ['format:check', 'typecheck', 'lint', 'test']) {
      expect(ms(label)).toBeGreaterThan(200);
    }

    // What IS assertable without a threshold: the steps run one after another inside this one
    // process, so their durations cannot add up to more than the process took. A clock started
    // once for the whole run -- each step reporting everything before it -- would report a
    // total larger than the wall clock it is a part of, and nothing else in this file would
    // notice.
    expect(row?.total_ms).toBe(steps.reduce((sum, step) => sum + step.ms, 0));
    expect(row?.total_ms).toBeLessThanOrEqual(elapsed);
  });

  it('writes nothing when the caller says this is not a real run', () => {
    // The record's value is that every row is a run that happened. `dev-hooks.test.ts` drives
    // this file in the REAL repository with stubbed steps, so without this the suite appends
    // six rows per run to the log `docs/evidence/EV-70.md` grades -- measured 2026-10-13 as six
    // rows in eleven seconds, each under 300 ms, each carrying the real HEAD. An append-only
    // log cannot be un-appended, so the fixture says so out loud.
    const { status, log } = runGate({ env: { ASCEND_GATE_NO_RECORD: '1' } });

    expect(status).toBe(0);
    expect(log).toEqual([]);
  });

  it('records what kind of files the commit carries', () => {
    // `asc-09wx.14`'s first step asks for "the kinds of files staged" as well as the timings,
    // because the skip rule that follows has to be argued from what commits actually look like.
    const { dir, bin } = sandbox({});
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    mkdirSync(join(dir, 'dogfood'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(dir, 'dogfood', '9000-fixture.md'), 'x\n', 'utf8');
    writeFileSync(join(dir, 'packages', 'core', 'src', 'fixture.ts'), 'export {};\n', 'utf8');
    writeFileSync(join(dir, 'README.md'), 'root\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });

    const result = spawnSync(process.execPath, [GATE], {
      cwd: dir,
      encoding: 'utf8',
      env: runEnv(bin, false),
    });
    expect(result.status).toBe(0);

    const row = readLog(dir)[0];
    expect(row?.staged?.count).toBe(3);
    // A root file is counted under `(root)` rather than dropped, so a commit of only root files
    // is still visible in the row.
    expect(row?.staged?.top).toEqual({ dogfood: 1, packages: 1, '(root)': 1 });
  });

  it('breaks a lock whose holder never released it, instead of waiting for a run that is over', () => {
    // What a SIGKILLed gate leaves behind: the lock, naming a pid nothing is running. Without the
    // break, this commit waits for a suite that will never finish -- a commit that never happens is
    // a worse outcome than the concurrency the lock prevents.
    const gone = deadPid();
    const { status, output, log } = runGate({
      prepare: (dir) => {
        holdLock(dir, gone);
        // The escape hatch, for the reason `gate-lock.test.ts` explains at length: a runner that
        // failed to break this lock would WAIT rather than fail, and a mutation run cannot afford a
        // killer that hangs instead of going red. Out past the gate's own boot, so the gate is
        // guaranteed to find the lock standing -- see `STALE_RELEASE_MS`.
        releaseAfter(dir, STALE_RELEASE_MS);
      },
    });

    expect(status).toBe(0);
    expect(log[0]?.broke_lock).toBe('dead-pid');
    expect(log[0]?.waited_ms).toBe(0);
    expect(output).toContain('breaking it');
  });

  it("waits for another session's gate, and the wait is not inside a step's duration", () => {
    const { status, log } = runGate({
      prepare: (dir) => {
        holdLock(dir, process.pid);
        releaseAfter(dir, HOLD_MS);
      },
    });

    expect(status).toBe(0);
    const row = log[0];
    // A live holder is not broken, however inconvenient: that is the whole point of the lock.
    expect(row?.broke_lock).toBeNull();
    // By construction: the hatch cannot fire before HOLD_MS, which the gate's first poll still
    // finds held, so the run took at least one more whole poll interval to start.
    expect(row?.waited_ms).toBeGreaterThanOrEqual(POLL_MS);
    // THE WAIT IS ITS OWN QUANTITY, and this is the assertion that keeps it there. `total_ms` is
    // the sum of the step rows, so a wait added to a step's duration cannot be spotted by comparing
    // the two to each other -- it has to be compared against a clock that saw the steps and nothing
    // else, which is what `wall_ms` is: the gate's own hrtime around the loop, holding every step's
    // measured span inside it and node boot, the two `git` calls and process teardown outside.
    //
    // WHY NOT THE TEST'S OWN CLOCK. This assertion began as `waited_ms + total_ms <= elapsed`, with
    // `elapsed` spanning the whole child process. That fails a folded-in wait only when the wait
    // exceeds everything else the child did -- node boot, teardown -- which measured 860 ms on
    // 2026-10-13 and 2710 ms an hour later at loadavg 32, and the spec run reported this mutant as
    // SURVIVED twice: once on a one-poll hold, then again on a four-second one, its killer failing
    // by hand both times. A wait cannot be outrun by a bigger constant on a machine whose noise has
    // no ceiling; the clock had to change, not the number.
    expect(row?.total_ms ?? 0).toBeLessThanOrEqual((row?.wall_ms ?? 0) + LOOP_SLACK_MS);
  });

  it('hands the lock back when a step blocks, so the next commit is not stalled by it', () => {
    const { status, dir } = runGate({ pnpmExit: 1 });

    expect(status).toBe(1);
    expect(existsSync(join(dir, LOCK_PATH))).toBe(false);
  });

  it('takes no lock at all when the caller says this is not a real run', () => {
    // The fixture's opt-out covers the lock as well as the record it is named for. The lock left in
    // its way is aged past the ceiling, so a run that tried to take it would have broken it and said
    // so -- which is what makes "no break, no wait, and it is still standing" mean the lock was
    // never taken rather than that it was never contended. And nothing here can hang: if the
    // opt-out stopped working, the age ceiling would let the run through.
    const { status, output, dir } = runGate({
      env: { ASCEND_GATE_NO_RECORD: '1' },
      prepare: (runDir) => {
        holdLock(runDir, process.pid);
        age(runDir, 4 * 60 * 60 * 1000);
      },
    });

    expect(status).toBe(0);
    expect(output).not.toContain('gate lock');
    expect(existsSync(join(dir, LOCK_PATH, HOLDER_FILE))).toBe(true);
  });
});

/**
 * The cuts, driven through the real file against a real staged set.
 *
 * The pure layer above says what a run SHOULD do; this layer is the only thing that can show the
 * decision arrived. `git diff --cached` is a real subprocess against a real index, and the scope is
 * derived from its output -- so a bug in how the paths are read, split or handed on is invisible to
 * every assertion that stops at `stepsFor`.
 */
describe('cutting the suite on a real commit', () => {
  it('skips the suite for a commit no test reads, and says so in the row', () => {
    const { status, output, log } = runGate({}, ['.ascend/entries/note-1a2b/0001.jsonl']);

    expect(status).toBe(0);
    expect(output).toContain('[pre-commit] scope: nothing staged that any test reads');
    const row = log[0];
    expect(row?.scope).toBe('inert');
    expect(row?.steps.map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 5));
    // THE RECORDED SKIP, which is what an absent row cannot say. Both halves are named: the suite did
    // not run, and therefore the baseline check had nothing to compare.
    expect(row?.skipped?.map((entry) => entry.step)).toEqual(['test', 'test count']);
    expect(row?.outcome).toBe('ok');
  });

  it('runs the packages a code change reaches, and tells the run which it was', () => {
    // `pnpmEcho` is the wire. `stepsFor` can say the subset step carries two directory filters and
    // an environment; only the run itself can show that `pnpm` received them, that the filters came
    // out in the order the scope built them, and that the scope variable did not leak onto the
    // checks -- which are not narrowed and must not read as if they were.
    const { status, output, log } = runGate({ pnpmEcho: true }, ['packages/store/src/pages.ts']);

    expect(status).toBe(0);
    const row = log[0];
    expect(row?.scope).toBe('tests');
    expect(row?.steps.map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 6));
    expect(row?.skipped?.map((entry) => entry.step)).toEqual(['test count']);
    expect(output).toContain(
      'pnpm-stub: exec vitest run packages/cli/test packages/core/test packages/store/test ' +
        '[ASCEND_TEST_SCOPE=subset]',
    );
    expect(output).toContain('pnpm-stub: format:check [ASCEND_TEST_SCOPE=]');
  });

  it('runs everything anyway when the environment asks for it', () => {
    // The escape hatch, end to end: the same inert staged set that skipped the suite a moment ago
    // now pays for it. `ASCEND_GATE_SCOPE` rather than `ASCEND_PRECOMMIT_FULL`, because the umbrella
    // would also add `align check` -- unstubbed here, so it would block the run and the test would
    // be asserting about a red gate.
    const { status, log } = runGate({ env: { ASCEND_GATE_SCOPE: 'full' } }, [
      '.ascend/entries/note-1a2b/0001.jsonl',
    ]);

    expect(status).toBe(0);
    expect(log[0]?.scope).toBe('full');
    expect(log[0]?.steps.map((step) => step.label)).toEqual(WHOLE_RUN);
    expect(log[0]?.skipped).toEqual([]);
  });

  it('lets a package change win over an inert one in the same commit', () => {
    // Mixed commits are the common case, and the answer has to be the tests. A rule that took the
    // last path, or the first, would skip the suite here half the time.
    const { status, log } = runGate({}, [
      '.ascend/entries/note-1a2b/0001.jsonl',
      'packages/store/src/pages.ts',
    ]);

    expect(status).toBe(0);
    expect(log[0]?.scope).toBe('tests');
  });
});
