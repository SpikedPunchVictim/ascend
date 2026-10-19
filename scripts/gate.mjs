#!/usr/bin/env node
/**
 * ascend's pre-commit gate: the step list, the timing, and the run record.
 *
 * WHY THE STEPS LIVE IN A JS FILE AND NOT IN `.githooks/pre-commit`. The hook is POSIX `sh`
 * and must stay that way -- it is spliced above beads' block, and a hook cannot be tested by
 * the suite. But `asc-09wx.14` adds four pieces of DECISION logic to this gate (what to skip,
 * what to serialize, what to run instead, what has already passed), and a shell `case`
 * statement can carry neither a test nor the mutation spec this repo requires of new
 * behaviour ("a check must be shown to fail before it is trusted to pass"). So the decisions
 * move here, where they are testable, and the hook keeps only what the splice requires.
 *
 * THREE INVARIANTS survive the move, and the third is the one that was measured the hard way:
 *
 *   1. This gate must never terminate the shell above beads' block. The hook falls through on
 *      success and exits `1` only on failure.
 *   2. The hook runs this in a SUBSHELL, so `set -eu` and `cd` cannot leak into beads' block.
 *   3. The exit status is the FAILING STEP'S status, carried out of the runner and captured
 *      by the hook as a standalone command -- never as an `if` condition. POSIX suppresses
 *      `set -e` inside any command forming an `if` condition, so the obvious
 *      `if ! ( ...; pnpm test ); then fail; fi` SILENTLY IGNORES the failure and prints
 *      "gate ok" over a red suite. That false green was written, measured (`pnpm test` -> 1,
 *      gate -> 0), and fixed. A gate that cannot fail is worse than no gate, because it is
 *      believed.
 *
 * COST. Measured 2026-10-05: 229 s on a quiet machine, 672 s under load, dominated in both
 * cases by `pnpm test`. It moves with the MACHINE, not with the diff, which is the whole
 * reason this file now records the movement instead of asserting a budget. There is no budget
 * on `pnpm test` anywhere in this repo.
 *
 * FAIL-CLOSED. A step that cannot be started (no such command, killed by a signal) fails the
 * gate with the status a shell would have reported. `asc-9flv`'s rule, stated in the hook:
 * a guard that cannot find its own binary must not read like a guard that looked and found
 * nothing.
 */
import { spawnSync } from 'node:child_process';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';
import { INDEX_ENV, stepEnv } from './gate-env.mjs';
import { checkHooksPath, fixCommand } from './hooks-path.mjs';
import { acquire } from './gate-lock.mjs';
import { appendRun, LOG_PATH, ROW_VERSION } from './gate-log.mjs';
import { worktreeOf } from './gate-coverage.mjs';
import { check as checkMemo, remember as rememberMemo, sameStep, treeOf } from './gate-memo.mjs';
import { SUBSET_SCOPE, TEST_SCOPE_ENV, scopeOf } from './gate-scope.mjs';

/**
 * One gate step. `label` is what a reader sees; `command`/`args` are what runs.
 *
 * `env` is added to this process's environment for this step alone. Only the subset run uses it, to
 * tell `vitest.test-count.ts` that what it is about to collect is not the full suite.
 *
 * THE STEP DOES NOT INHERIT THE VARIABLES THIS FILE READS. `runStep` strips them first, so a step is
 * never handed the runner's own mode -- measured 2026-10-14, that leak is what stopped `but push`
 * (`scripts/gate-env.mjs`, `dogfood/0097`). `env` is applied after the strip, so a step that wants one
 * can still state it.
 *
 * `keeps` names a stripped variable this step means to receive anyway. Two steps read the index on
 * purpose -- the commit's own contents, not the tree -- and a path-limited commit hands the hook a
 * temporary index, so they have to say so or they would verify the wrong set (`dogfood/0118`).
 *
 * @typedef {object} Step
 * @property {string} label
 * @property {string} command
 * @property {readonly string[]} args
 * @property {Record<string, string>} [env]
 * @property {readonly string[]} [keeps]
 */

/**
 * One step's outcome inside a run's row.
 *
 * @typedef {object} StepRow
 * @property {string} label
 * @property {number} ms
 * @property {number} status
 */

/**
 * The steps every run takes, whatever it stages. A commit that changes no test-relevant file still
 * gets its formatting, its build, its store guard and its lint -- those are cheap next to the suite
 * and they are the checks a record-tree commit most needs (`store verify --staged` validates exactly
 * the staged JSONL the inert case is about).
 *
 * @type {readonly Step[]}
 */
const CHECK_STEPS = [
  { label: 'format:check', command: 'pnpm', args: ['format:check'] },
  { label: 'typecheck', command: 'pnpm', args: ['typecheck'] },
  {
    label: 'store verify --staged',
    command: 'node',
    args: ['packages/cli/dist/bin.js', 'store', 'verify', '--staged'],
    // Reads `git ls-files -s`: the index is the subject, so a path-limited commit's temporary index
    // is the right one to read (`dogfood/0118`).
    keeps: INDEX_ENV,
  },
  {
    label: 'duplicate entry ids',
    command: 'node',
    args: ['scripts/gate-duplicate-ids.mjs'],
    keeps: INDEX_ENV,
  },
  { label: 'lint', command: 'pnpm', args: ['lint'] },
];

/**
 * The whole suite. What a commit runs when nothing narrows it.
 *
 * IT SAYS SO OUT LOUD, rather than relying on the variable's absence. `vitest.test-count.ts` decides
 * whether to write `.testcount/scan.json` from `ASCEND_TEST_SCOPE`, and absence means full -- which is
 * right for a person typing `pnpm test`, and wrong for a gate that inherited the variable from
 * somewhere else. Measured 2026-10-13, driving the real hook with a `packages/store` change staged:
 * the subset step exports `ASCEND_TEST_SCOPE=subset` to `pnpm exec vitest`, every process below it
 * inherits that, and `dev-hooks.test.ts` -- which is inside the `cli` subset and drives the real
 * pre-push hook -- spawned a FULL gate that then ran `pnpm test` under a stale `subset`. The reporter
 * would have declined to write the scan on a run that really was the full suite, leaving the baseline
 * check comparing a scan from some earlier run. Setting the full spelling explicitly makes every step
 * state which run it is instead of inferring it from what it happened to inherit.
 */
const TEST_STEP = {
  label: 'test',
  command: 'pnpm',
  args: ['test'],
  env: { [TEST_SCOPE_ENV]: '' },
};

// The test-count baseline (asc-049w). `dogfood/0061` is a green gate over a file whose 55
// tests had become 5: the suite printed a pass count and nothing compared it to anything,
// so a deleted test and a passing test were the same word. The run above wrote what it
// collected to `.testcount/scan.json` (through `vitest.test-count.ts`); this compares it
// against the baseline the repo carries.
//
// Its exit codes are deliberately distinct: 1 is a breached floor, 2 is "an input was
// missing, so nothing was compared".
const COUNT_STEP = { label: 'test count', command: 'node', args: ['scripts/test-baseline.mjs'] };

/**
 * The gate's steps, in order. Each label is printed as `<hook> <label>` before the step runs -- under
 * `[pre-commit]` for a commit and `[pre-push]` for a push, since the same list serves both -- and
 * those strings are asserted by `packages/cli/test/dev-hooks.test.ts` -- they are a contract, not
 * decoration.
 *
 * `typecheck` runs before the store guard deliberately: `pnpm typecheck` runs `tsc -b`, which
 * IS this repo's build, so the binary the next step invokes has just been rebuilt from this
 * working tree. dist is still not GUARANTEED fresh -- `.tsbuildinfo` records an input list
 * and no output list, so `tsc -b` cannot notice a DELETED output (measured: delete
 * dist/budget.js, re-run `pnpm typecheck` and `pnpm build`, both exit 0 with the file still
 * gone; only `tsc -b --force` restored it). In that state the store guard exits 2
 * (`command store:verify not found`) and blocks the commit, which is the direction it has to
 * fail in.
 *
 * @type {readonly Step[]}
 */
export const STEPS = [...CHECK_STEPS, TEST_STEP, COUNT_STEP];

/**
 * `align check` is not in the fast path because it re-scans the whole repo. It is still part
 * of the definition of done -- it is just too slow to sit in every commit.
 *
 * @type {Step}
 */
export const ALIGN_STEP = {
  label: 'align check',
  command: './node_modules/.bin/align',
  args: ['check'],
};

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
const isSet = (value) => value === '1';

/**
 * Which hook is printing. The same runner serves both: `pre-commit` runs the checks a commit earned
 * and `pre-push` runs everything the commit may have cut (see `.githooks/pre-push`). Every line this
 * file prints is prefixed with it, because a line that said `[pre-commit]` in the middle of a push
 * names the wrong moment -- and the prefix is how a reader tells which of the two is talking.
 *
 * An env var rather than an argument, because every other knob here is one, and because the hook is
 * POSIX `sh` setting it on the command line either way. `pre-commit` is the default: it is what a
 * person running `node scripts/gate.mjs` by hand is doing, and it is what the labels have always
 * said, so `packages/cli/test/dev-hooks.test.ts` reads the same strings it always did.
 */
const HOOK = process.env.ASCEND_GATE_HOOK ?? 'pre-commit';

/**
 * The lock to hold when no lock is to be taken. One shape, so `main` has no branch between taking
 * the lock and releasing it.
 *
 * @type {import('./gate-lock.mjs').AcquireResult}
 */
const NO_LOCK = { ok: true, waitedMs: 0, holder: null, broke: null, release: () => undefined };

/**
 * @param {string} message
 * @returns {void}
 */
function say(message) {
  console.log(`[${HOOK}] ${message}`);
}

/**
 * Run everything, whatever the scope says. The escape hatch `asc-09wx.14` asks for: every cut can
 * be turned off, and `ASCEND_PRECOMMIT_FULL` -- which already means "and also run `align check`" --
 * implies this one.
 *
 * `ASCEND_GATE_SCOPE` exists separately from `ASCEND_PRECOMMIT_FULL` because the two are not the
 * same request, and conflating them made a test run something it did not ask for. `dev-hooks
 * .test.ts` and this file's own control-flow tests drive the REAL hook with stubbed steps; they need
 * "take no cut" without also reaching the real, unstubbed `align` binary.
 */
const SCOPE_ENV = 'ASCEND_GATE_SCOPE';
const NO_CUTS = { kind: 'full', why: 'no cuts were asked for' };

/**
 * The scope this run will use: the derived one, unless the environment asks for the whole thing.
 *
 * `paths` is `null` when `git` could not report the staged set at all, which is the same answer as
 * an unmapped path -- run everything.
 *
 * @param {Record<string, string | undefined>} env
 * @param {readonly string[] | null} paths
 * @returns {import('./gate-scope.mjs').Scope}
 */
export function scopeFor(env, paths) {
  if (isSet(env.ASCEND_PRECOMMIT_FULL) || env[SCOPE_ENV] === 'full') return NO_CUTS;
  if (paths === null) return { kind: 'full', why: 'the staged set could not be read' };
  return scopeOf(paths);
}

/**
 * The test steps a scope replaces. The suite is narrowed to the packages the staged paths can reach,
 * through `pnpm exec vitest` rather than `pnpm test`, so the filters are unambiguously this run's
 * arguments and not something a package script reformats.
 *
 * `ASCEND_TEST_SCOPE` is how `vitest.test-count.ts` finds out. It writes `.testcount/scan.json` on
 * every run, and a subset run that overwrote it would make `test-baseline.mjs` report a breach on
 * every commit -- a false red blamed on the tests. Absent means full, which is the safe direction: a
 * person typing `pnpm test` gets a scan written.
 *
 * @param {import('./gate-scope.mjs').Scope & { kind: 'tests' }} scope
 * @returns {Step}
 */
function subsetStep(scope) {
  return {
    label: TEST_STEP.label,
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', ...scope.files],
    env: { [TEST_SCOPE_ENV]: SUBSET_SCOPE },
  };
}

/**
 * The steps this run will execute, given the environment and the scope. Pure, so the shape of a run
 * is assertable without spawning anything.
 *
 * `scope` defaults to the uncut one, so a caller that has no opinion gets today's behaviour rather
 * than a silent skip.
 *
 * @param {Record<string, string | undefined>} env
 * @param {import('./gate-scope.mjs').Scope} [scope]
 * @returns {readonly Step[]}
 */
export function stepsFor(env, scope = NO_CUTS) {
  const steps =
    scope.kind === 'inert'
      ? CHECK_STEPS
      : scope.kind === 'tests'
        ? [...CHECK_STEPS, subsetStep(scope)]
        : STEPS;
  return isSet(env.ASCEND_PRECOMMIT_FULL) ? [...steps, ALIGN_STEP] : [...steps];
}

/**
 * The steps this run did NOT run, and why. Recorded rather than omitted, because an absent
 * baseline check and a passing one look the same in a log of steps that ran -- and the whole point
 * of the test-count baseline is that a check which is present but unwired is invisible.
 *
 * @param {import('./gate-scope.mjs').Scope} scope
 * @returns {readonly { step: string, why: string }[]}
 */
export function skippedFor(scope) {
  if (scope.kind === 'inert') {
    return [
      { step: TEST_STEP.label, why: 'no test reads what this commit stages' },
      { step: COUNT_STEP.label, why: 'the suite did not run, so it collected nothing to compare' },
    ];
  }
  if (scope.kind === 'tests') {
    return [{ step: COUNT_STEP.label, why: 'a subset run cannot move the full-suite baseline' }];
  }
  return [];
}

/**
 * What a run that the memo answered did not do.
 *
 * Two kinds of skip are stated together, and the two cannot name the same step: the first half names
 * every step this run would have taken, and `skippedFor` names the steps the SCOPE cut, which are
 * not in this run's list at all. The order is the list's own, so a judged run's `skipped` reads in
 * the same order as `STEPS` whatever scope it took -- and a step named twice would make the row read
 * as if two things had been skipped. Both properties are asserted in `scripts/gate-memo.test.ts`.
 *
 * @param {import('./gate-scope.mjs').Scope} scope
 * @param {readonly Step[]} planned
 * @param {string} why
 * @returns {readonly { step: string, why: string }[]}
 */
export function skippedWhenAlreadyPassed(scope, planned, why) {
  return [...planned.map((step) => ({ step: step.label, why })), ...skippedFor(scope)];
}

/**
 * Whether this run may consult the memo, and therefore whether it may leave one behind -- one
 * condition, both directions.
 *
 * Two kinds of run do not ask, and each has its own reason rather than sharing one flag:
 *
 *   - `ASCEND_GATE_NO_RECORD` says this is a FIXTURE, the same flag that stops it taking the real
 *     lock and appending to the real log. A fixture that skipped its own steps would not be driving
 *     the gate at all.
 *   - `ASCEND_GATE_SCOPE=full` asks for every cut to be off, and a run that asked for everything must
 *     not be answered with "already done".
 *
 * `ASCEND_PRECOMMIT_FULL` is deliberately NOT one of them, and it was. It is what `.githooks/pre-push`
 * sets, and refusing the memo under it made that hook pay the whole gate once per `git push`
 * COMMAND rather than once per push: git runs `pre-push` once per push it is handed, and GitButler
 * pushes a stack one branch at a time. Measured 2026-10-14 -- a `but push` of a two-branch stack ran
 * this runner twice, 302.4 s and 259.0 s, 561 of the 568 s the push took (`dogfood/0099`). What a push
 * must not do is accept a COMMIT's record, and that is `requiredOf` below rather than this function.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function memoAllowed(env) {
  const fixture = isSet(env.ASCEND_GATE_NO_RECORD);
  const everyCutOff = env[SCOPE_ENV] === 'full';
  return !fixture && !everyCutOff;
}

/**
 * What a record must have run before it may answer THIS run -- the bar `scripts/gate-memo.mjs` is
 * handed as `required`.
 *
 * EMPTY FOR A COMMIT, and that is the whole of Cut 4 as it shipped: an amend plans the full commit
 * list while a scoped record covers a subset of it, so a commit asks nothing of a record beyond the
 * tree being the one that passed. That rule and the measurement behind it are the memo module's, and
 * it is not relaxed here -- it is narrowed to the run that cannot afford to be wrong.
 *
 * `align check` FOR A PUSH, and that one step is the entire bar. It is planned only when the run took
 * no cut, and no commit-level run ever plans it -- so requiring it is exactly "a push is not answered
 * by a commit's record", while a push is still answered by another push on the same tree. That second
 * half is what the measurement above cost: the first push of a stack leaves the record the second
 * push needs, and without it the second push pays everything again for the same bytes.
 *
 * Compared by command and arguments rather than by label, because the label is what a reader sees and
 * may be reworded (`scripts/gate-memo.mjs`).
 *
 * @param {readonly Step[]} planned
 * @returns {readonly import('./gate-memo.mjs').MemoStep[]}
 */
export function requiredOf(planned) {
  return planned.some((step) => sameStep(step, ALIGN_STEP)) ? [ALIGN_STEP] : [];
}

/**
 * One line saying which path the run took, so the gate's own output answers "why did this take ten
 * minutes" without reading the record.
 *
 * @param {import('./gate-scope.mjs').Scope} scope
 * @returns {string}
 */
function describeScope(scope) {
  if (scope.kind === 'inert') return 'scope: nothing staged that any test reads -- suite skipped';
  if (scope.kind === 'tests') return `scope: ${scope.packages.join(', ')}`;
  return `scope: everything (${scope.why})`;
}

/**
 * ` at <iso>`, or nothing. The record's own time is what makes a hit legible: "already passed" invites
 * "when, and by what?", and the answer is in the memo.
 *
 * @param {import('./gate-memo.mjs').Memo | null} memo
 * @returns {string}
 */
function atOf(memo) {
  return memo?.at == null ? '' : ` at ${memo.at}`;
}

/**
 * A shell's convention for a command that could not be run or was killed: 127 / 128.
 *
 * @param {{ error?: Error, status: number | null }} result
 * @returns {number}
 */
function statusOf(result) {
  if (result.error) return 127;
  if (result.status === null) return 128;
  return result.status;
}

/**
 * @param {Step} step
 * @param {string} cwd
 * @returns {StepRow}
 */
function runStep(step, cwd) {
  console.log(`[${HOOK}] ${step.label}`);
  const started = process.hrtime.bigint();
  const result = spawnSync(step.command, step.args, {
    cwd,
    stdio: 'inherit',
    env: stepEnv(process.env, step.env, step.keeps),
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const status = statusOf(result);
  if (result.error) {
    console.error(`[${HOOK}] ${step.label} could not run: ${result.error.message}`);
  }
  return { label: step.label, ms: Math.round(ms), status };
}

/**
 * The staged paths themselves, or `null` when `git` could not be asked. The scope is derived from
 * these, so a `null` here is not "no files staged" -- it is "nobody knows", which runs everything.
 *
 * @param {string} root
 * @returns {string[] | null}
 */
function stagedPaths(root) {
  const result = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\0').filter((path) => path !== '');
}

/**
 * `{ count, top }` for the staged set -- what KIND of files this commit carries.
 *
 * @param {string} root
 * @returns {{ count: number, top: Record<string, number> } | null}
 */
function staged(root) {
  const paths = stagedPaths(root);
  if (paths === null) return null;
  /** @type {Record<string, number>} */
  const top = {};
  for (const path of paths) {
    const prefix = path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)';
    top[prefix] = (top[prefix] ?? 0) + 1;
  }
  return { count: paths.length, top };
}

/**
 * @param {string} root
 * @returns {string | null}
 */
function head(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : null;
}

function main() {
  const root = process.cwd();
  // WHERE THE SHARED STATE LIVES, which is not always where the run happens. A push gates a
  // temporary worktree of the pushed commit (`scripts/push-gate.mjs`), and the worktree is deleted
  // when the gate finishes -- so the run row and the lock must live in the checkout, or the verdict
  // would be recorded in a directory nobody keeps. Unset for every other run: `root` is the answer.
  const stateRoot = process.env.ASCEND_GATE_STATE_ROOT ?? root;

  // BEFORE ANY STEP: is the thing that delivered this run still able to deliver the next one? A
  // `core.hooksPath` that is absolute-inside-the-repo, or that points at nothing, turns every hook
  // off with no error anywhere -- and the only signal used to be a suite-wide test going red
  // (`asc-1h3u`, `dogfood/0101`), which reads to whoever last edited anything as their own doing.
  // Cheap enough to run every time: one `git config` and a stat.
  const hooksPath = checkHooksPath(root);
  if (!hooksPath.ok) {
    for (const problem of hooksPath.problems) say(problem);
    say(`fix: ${fixCommand()}`);
    if (!isSet(process.env.ASCEND_GATE_NO_RECORD)) {
      appendRun(
        {
          v: ROW_VERSION,
          at: new Date().toISOString(),
          head: head(root),
          // Nothing was read, so nothing is claimed: a preflight refusal covers no commit.
          tree: null,
          work: null,
          staged: staged(root),
          steps: [],
          total_ms: 0,
          wall_ms: 0,
          scope: 'hooks-path',
          skipped: [],
          waited_ms: 0,
          broke_lock: null,
          outcome: 'blocked',
          blocked_at: 'core.hooksPath',
          loadavg: loadavg(),
        },
        { root, logPath: resolve(stateRoot, LOG_PATH) },
      );
    }
    process.exitCode = 2;
    return;
  }

  // What this commit can reach, and therefore what it has to run. Derived from the staged PATHS
  // rather than from the counts above: the counts say what kind of commit it is, and this decides
  // what it costs.
  const scope = scopeFor(process.env, stagedPaths(root));
  const planned = stepsFor(process.env, scope);
  const rows = [];
  let status = 0;

  console.log(`[${HOOK}] ${describeScope(scope)}`);

  // Cut 4 (`asc-09wx.14`): a tree the gate has already judged is not judged again. The amend case is
  // the whole of it -- `git commit --amend` re-runs every step on an index byte-identical to one that
  // passed a minute ago, and on this machine that is minutes of `pnpm test` re-proving a fact the log
  // already holds. `scripts/gate-memo.mjs` owns the rules; what lives here is which runs may ask
  // (`memoAllowed`) and what a record must have run before it may answer this one (`requiredOf`).
  const memoOff = !memoAllowed(process.env);
  // THE ROW ASKS A DIFFERENT QUESTION FROM THE MEMO, and now records its own answer. The memo asks
  // "may I skip this run?", which `but commit` never asks because `but` runs no hook (`asc-rzhr`).
  // The row is asked "what content did this verdict cover?", and until it could answer, nothing on
  // this checkout could say whether a commit had ever been gated (`dogfood/0095`). So both trees are
  // recorded when a row will be written at all -- the index the staged steps read, and the working
  // tree the test, lint, format and typecheck steps read. A fixture run records nothing and pays for
  // neither.
  const rowWanted = !isSet(process.env.ASCEND_GATE_NO_RECORD);
  const tree = memoOff && !rowWanted ? null : treeOf(root);
  const verdict = memoOff
    ? { hit: false, why: '', memo: null }
    : checkMemo({ root, tree, required: requiredOf(planned) });
  // `judged` runs nothing and still exits 0. What it must NOT do is record a run that happened --
  // hence `skipped` below, which names every step the run would have taken and why it did not.
  const judged = verdict.hit;
  // A JUDGED RUN IS NOT RECORDED AS HAVING READ ANYTHING. It runs no step, so the working tree in
  // front of it is content nobody checked; the run whose verdict it is repeating has its own row
  // carrying its own trees. Recording this one's worktree would hand the coverage query a verdict
  // about a tree no step read, which is the false green this whole file exists to refuse.
  const work = rowWanted && !judged ? worktreeOf(root) : null;
  if (judged) say(`${verdict.why}${atOf(verdict.memo)} -- every step skipped`);

  const steps = judged ? [] : planned;
  // Recorded rather than left to be inferred from an empty `steps` array, because a check that was
  // deliberately not run and a check that is present but unwired produce the same absent row
  // (`dogfood/0061`).
  const skipped = judged
    ? skippedWhenAlreadyPassed(scope, planned, verdict.why)
    : skippedFor(scope);

  // One gate at a time, across sessions. A second gate WAITS rather than failing the commit: a lock
  // that refuses a commit because another session is gating makes one session's work the reason
  // another's cannot land, and the person hitting it can do nothing but wait anyway.
  //
  // NOT TAKEN BY A FIXTURE, for the reason the record below is not written by one -- and the flag
  // that says so is named for the narrower job it was introduced for. A fixture run holding the
  // real lock would make a real commit wait for a run that never happened.
  const lock = isSet(process.env.ASCEND_GATE_NO_RECORD)
    ? NO_LOCK
    : acquire({ root: stateRoot, report: say });
  if (!lock.ok) {
    // The lock is a cost device, not a correctness device: failing to take it must not become a new
    // way for a commit to be refused. Reported, and not obeyed.
    console.error(
      `[${HOOK}] the gate lock could not be taken: ${String(lock.error)} -- running anyway`,
    );
  }

  // The gate's own clock across the step loop, and the lock release that closes it. This is the only
  // reading in the row that shares a window with `total_ms`: every step's `ms` is measured inside
  // it, and node's boot, the two `git` calls that fill the rest of the row and the process's own
  // teardown are all outside it. So `total_ms <= wall_ms` is a statement about this run's accounting
  // rather than about how busy the machine is, and a step that absorbed something the wall clock
  // never saw -- a lock wait folded into a step's duration, most of all -- shows up here and nowhere
  // else. It is measured before the wait and after it, and the wait is not inside it.
  const loopStarted = process.hrtime.bigint();
  try {
    for (const step of steps) {
      const row = runStep(step, root);
      rows.push(row);
      if (row.status !== 0) {
        status = row.status;
        break;
      }
    }
  } finally {
    // On the failure path as well as the success path. A lock left behind by a blocked commit would
    // stall the next one until the age ceiling broke it.
    lock.release();
  }
  const wallMs = Math.round(Number(process.hrtime.bigint() - loopStarted) / 1e6);
  const blocked = rows.find((row) => row.status !== 0);

  // REMEMBERED ONLY IF IT PASSED, and `remember` is the thing that enforces that rather than this
  // call site -- it is handed the outcome and writes nothing unless it is `ok`. A memo that
  // remembered a red tree would turn the next amend green, which is the false-green class this repo
  // treats as severity-zero. `planned` rather than `rows` because the two agree exactly where it
  // matters: a run that passed ran every planned step, and a run that blocked is refused anyway.
  //
  // A PUSH WRITES ONE TOO, and that is the point of removing the umbrella above: the record a push
  // leaves is the only thing that can answer the next push of the same stack, and because it ran the
  // step a commit's record never runs, it answers a commit as well (`required` is a bar, not an
  // equality). The tree is unchanged between the pushes of one `but push` -- neither of them touches
  // the index -- so the second is answered by the first.
  if (!memoOff && !judged) {
    const remembered = rememberMemo({
      root,
      tree,
      steps: planned,
      outcome: blocked ? 'blocked' : 'ok',
    });
    if (!remembered.ok) {
      // Reported and ignored, for the reason the run record's write is: the gate's verdict is not
      // this file's to change, and a cache that cannot be written costs one re-run of the gate.
      console.error(
        `[${HOOK}] could not remember that this tree passed: ${String(remembered.error)}`,
      );
    }
  }

  // WHO WROTE THIS ROW. The record's value is that every row is a run that really happened, so
  // a caller that is driving the gate as a FIXTURE has to say so. `packages/cli/test/dev-hooks
  // .test.ts` runs this file for real -- `cwd` is the repository root, because that is what it is
  // testing -- with `pnpm` and `node` stubbed. Before this flag existed its six invocations
  // appended six rows to the real log on every `pnpm test`: measured 2026-10-13 as six rows in
  // eleven seconds, each totalling under 300 ms, each carrying the real HEAD. An append-only log
  // cannot be un-appended, and `docs/evidence/EV-70.md` grades the gate from these rows, so the
  // rows a test writes are not noise -- they are the measurement.
  if (!isSet(process.env.ASCEND_GATE_NO_RECORD)) {
    const record = appendRun(
      {
        v: ROW_VERSION,
        at: new Date().toISOString(),
        head: head(root),
        // What this run read, rather than what the checkout pointed at. `head` is kept as it was --
        // it is still the right answer to "which checkout was this?", and the two are not the same
        // question: under a `but` commit, `head` is a workspace commit the new commit is not.
        tree,
        work,
        staged: staged(root),
        steps: rows,
        total_ms: rows.reduce((sum, row) => sum + row.ms, 0),
        // The gate's own clock across the loop, for the reason given where it is measured. A row
        // whose two agree is a row whose per-step durations account for the whole run.
        wall_ms: wallMs,
        // WHICH PATH THIS RUN TOOK, and what it therefore did not do. `skipped` is recorded rather
        // than left to be inferred from the step list: a check that is present but unwired and a
        // check that was deliberately not run produce the same absent row, and `dogfood/0061` is
        // the record of that shape costing a real regression.
        scope: scope.kind,
        skipped,
        // Waiting is reported here and NOT folded into any step's `ms`, because the two answer
        // different questions: a step's duration says what the check costs, and this says how much
        // of the commit's wall clock was spent queueing behind another session. A cut that moved
        // the wait into a step would make the gate look slower exactly as the lock made it faster.
        waited_ms: lock.waitedMs,
        broke_lock: lock.broke === null ? null : lock.broke.reason,
        outcome: blocked ? 'blocked' : 'ok',
        blocked_at: blocked ? blocked.label : null,
        loadavg: loadavg(),
      },
      { root, logPath: resolve(stateRoot, LOG_PATH) },
    );
    if (!record.ok) {
      // Reported and ignored. The gate's verdict is not this file's to change.
      console.error(`[${HOOK}] could not record this run: ${String(record.error)}`);
    }
  }

  // `exitCode`, not `process.exit`: exiting while a piped stderr buffer is unflushed
  // truncates it. A step's own output is unaffected (it holds the fd directly), but the
  // note above is ours.
  process.exitCode = status;
}

// The guard is what lets `scripts/gate.test.ts` import the step list and `stepsFor` without running
// a gate. Under Vitest the entry module is the test file, so this is false there and true when the
// runner is the thing Node was asked to run.
if (import.meta.main) main();
