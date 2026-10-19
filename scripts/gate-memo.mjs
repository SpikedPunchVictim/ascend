/**
 * A tree that passed the gate is not gated again.
 *
 * WHY THIS EXISTS. `asc-09wx.14`'s fourth cut. `git commit --amend` re-runs the whole gate on a tree
 * the gate has already judged: the amend changes the message, or nothing at all, and the index it
 * commits is byte-identical to the one that passed a minute ago. On this machine that is minutes of
 * `pnpm test` spent re-proving a fact the log already holds -- and the log does hold it, because
 * stage G1 recorded every run.
 *
 * THE TREE, NOT THE DIFF. The key is `git write-tree`, which hashes the INDEX. A diff is the wrong
 * quantity twice over: the same change on a different base is a different tree and must be judged
 * again, and a diff narrows to nothing on the second pass of an amend -- the index now equals HEAD,
 * so `git diff --cached` is empty while the tree is exactly what passed. `scripts/gate-memo.test.ts`
 * pins that case, because it is the one the cut exists for and the one a diff would miss.
 *
 * ANY DOUBT IS A MISS. Every one of these runs the gate, and the gate is the expensive answer, which
 * is the direction this has to fail in:
 *
 *   - no record, an unreadable one, or one that is not JSON;
 *   - a record whose schema version this file does not know;
 *   - the tree cannot be read (`git write-tree` fails, or there is no index);
 *   - the record names a different checkout;
 *   - a different tree.
 *
 * WHAT A HIT DOES NOT ASK, and this was measured rather than reasoned about: a hit does not ask
 * whether the recorded run took every step THIS run would take. The first draft did, and the rule
 * refused exactly the case the cut exists for. After `git commit`, the index equals `HEAD`, so
 * `git diff --cached` is empty and `scopeOf([])` answers `full` -- deliberately, because "nothing
 * staged is not nothing reachable" (`scripts/gate-scope.mjs`). An amend therefore plans the whole
 * commit list while a scoped commit's record covers a subset of it, and a coverage requirement vetoes
 * every amend there is. The record still NAMES the steps that ran, so a reader can see what "passed"
 * meant for that tree; it is evidence rather than a gate.
 *
 * WHAT THE CALLER MAY REQUIRE, and this is the narrow half of that same question. The caller passes
 * `required`: the steps a record must have run before it may answer this run. The commit path passes
 * nothing, which is the paragraph above. One caller passes something, and it is `requiredOf` in
 * `scripts/gate.mjs`: a run that took no cut plans `align check`, no commit-level record ever ran it,
 * and requiring it is how `ASCEND_PRECOMMIT_FULL` -- which `.githooks/pre-push` sets -- stops being
 * answered by a commit's record while a push is still answered by a push's own. Measured 2026-10-14:
 * without that requirement a two-branch stack paid this gate twice for one push, 302.4 s and 259.0 s
 * of a 568 s push (`dogfood/0099`).
 *
 * A FAILED TREE IS NEVER MEMOISED, and the module enforces that rather than trusting its caller:
 * `remember` is handed the run's outcome and writes nothing unless it is `ok`. The defect class is
 * the severity-zero one -- a memo that remembered a red tree would turn the next amend green, and
 * the whole value of a green verdict is that it is not available to a run that failed.
 *
 * THE BOUND, STATED PLAINLY. This keys on the INDEX. The gate's steps mostly read the WORKING TREE
 * (`format:check`, `typecheck`, `lint` and `test` all read files from disk, and vitest collects
 * untracked test files too), so a hit can skip a gate while the working tree holds an edit that
 * would have failed one. What the hit does say is that the COMMIT being judged is byte-identical to
 * a commit that passed -- the amend case this cut is for. Widening the key to the worktree is
 * possible (hash the unstaged diff, and the content of every untracked file) and is deliberately not
 * built: nothing has measured that the amend case is not the whole of the value here.
 *
 * NOT TAKEN BY A FIXTURE, and not by a run that asked for everything. `ASCEND_GATE_NO_RECORD` -- the
 * flag that already stops a fixture taking the real lock and appending to the real log -- suppresses
 * this too, and `ASCEND_GATE_SCOPE=full` suppresses it because a run that asked for every cut to be
 * off must not be answered with "already done". `ASCEND_PRECOMMIT_FULL` no longer does: it asks for
 * one more step (`align check`) rather than a different standard, and that is `required` above.
 *
 * A COST DEVICE, NOT A CORRECTNESS DEVICE. A memo that cannot be written is reported and ignored: a
 * gate that refused a commit because it could not write a cache file would be failing for a reason
 * that has nothing to do with the code. The write is atomic (temp then rename) so a reader never
 * sees half a record, and a torn or corrupt record is a miss rather than a crash.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Relative to the repository root, beside the gate's run record and its lock. Named in `.gitignore`. */
export const MEMO_PATH = '.ascend/gate-memo.json';

/** The record's schema version. A record from any other version is a miss, never a parse to guess at. */
export const MEMO_VERSION = 1;

/**
 * One step, as the memo records it. Only what identifies the step: the label is what a reader sees
 * and may be reworded, while the command and its arguments are what ran.
 *
 * @typedef {object} MemoStep
 * @property {string} command
 * @property {readonly string[]} args
 */

/**
 * The tree this checkout last passed the gate on.
 *
 * @typedef {object} Memo
 * @property {number} v
 * @property {string} checkout Absolute path of the checkout that wrote it.
 * @property {string} tree The `git write-tree` output that passed.
 * @property {string | null} at When it passed, ISO.
 * @property {readonly MemoStep[]} steps Every step that ran on that tree.
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
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
 * One `git` read. `null` for anything that is not a clean success, because every caller here treats
 * "git would not answer" as a doubt, and a doubt is a miss.
 *
 * @param {string} root
 * @param {readonly string[]} args
 * @returns {string | null}
 */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const trimmed = result.stdout.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The index as a tree hash. This is the memo's key: content only, so the same staged set on a
 * different base is a different tree.
 *
 * `git write-tree` is not a read -- it writes the tree object into the object database. That is a
 * cost, not a side effect on anything a person sees, and it is what makes the hash comparable across
 * runs: an index that has not changed re-derives the same hash every time.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function treeOf(root) {
  return git(root, ['write-tree']);
}

/**
 * Which checkout this is, absolutely. The tree hash is content-only, so two checkouts holding the
 * same index share it -- and a record copied between them would be a hit on a tree nobody here has
 * judged. Compared rather than trusted, so a rename of the checkout is a miss and not a wrong hit.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function checkoutOf(root) {
  return git(root, ['rev-parse', '--show-toplevel']);
}

/**
 * A memo step read back from disk, or `null` if it is not one. Read strictly and never repaired: the
 * step list is evidence about what "passed" meant for that tree, so a record whose list cannot be
 * believed is a record that cannot be believed.
 *
 * @param {unknown} value
 * @returns {MemoStep | null}
 */
function memoStep(value) {
  if (!isRecord(value)) return null;
  const { command, args } = value;
  if (typeof command !== 'string' || command === '') return null;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return null;
  return { command, args };
}

/**
 * The record, or `null` for any reason it cannot be believed. It does not throw and it does not
 * repair: a corrupt record is a miss, which costs one gate run, while a generous reading of one
 * costs a commit that was never checked.
 *
 * @param {string} root
 * @param {{ memoPath?: string }} [options]
 * @returns {Memo | null}
 */
export function readMemo(root, { memoPath = MEMO_PATH } = {}) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(root, memoPath), 'utf8'));
  } catch {
    // Absent, unreadable, or not JSON. All three are the same answer.
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { v, checkout, tree, at, steps } = parsed;
  if (v !== MEMO_VERSION) return null;
  if (typeof checkout !== 'string' || checkout === '') return null;
  if (typeof tree !== 'string' || tree === '') return null;
  if (!Array.isArray(steps)) return null;
  /** @type {MemoStep[]} */
  const read = [];
  for (const entry of steps) {
    const step = memoStep(entry);
    if (step === null) return null;
    read.push(step);
  }
  return { v: MEMO_VERSION, checkout, tree, at: typeof at === 'string' ? at : null, steps: read };
}

/**
 * Whether two of these are the same step: the command, and every argument in order, because those are
 * what ran. The label is what a reader sees and is free to be reworded, so it is not what this
 * compares -- which is why the caller can name a required step by holding the step itself.
 *
 * @param {MemoStep} one
 * @param {MemoStep} other
 * @returns {boolean}
 */
export function sameStep(one, other) {
  return (
    one.command === other.command &&
    one.args.length === other.args.length &&
    one.args.every((arg, index) => arg === other.args[index])
  );
}

/**
 * A step as one line, for a message about it. Spelled the way the hook would run it.
 *
 * @param {MemoStep} step
 * @returns {string}
 */
function commandLine(step) {
  return [step.command, ...step.args].join(' ');
}

/**
 * Whether this tree has already been judged.
 *
 * @param {object} options
 * @param {string} [options.root]
 * @param {string | null} options.tree The `treeOf(root)` the caller already computed, or `null`.
 * @param {readonly MemoStep[]} [options.required] Steps the recorded run must have taken. Empty --
 *   the commit path -- asks only what the whole module asks: that the tree is the one that passed.
 * @param {string} [options.memoPath]
 * @returns {{ hit: boolean, why: string, memo: Memo | null }}
 */
export function check({ root = process.cwd(), tree, required = [], memoPath = MEMO_PATH }) {
  /**
   * @param {string} why
   * @returns {{ hit: false, why: string, memo: null }}
   */
  const miss = (why) => ({ hit: false, why, memo: null });
  if (tree === null) return miss('the index could not be read');
  const memo = readMemo(root, { memoPath });
  if (memo === null) return miss('no tree that passed the gate is recorded here');
  const checkout = checkoutOf(root);
  if (checkout === null || checkout !== memo.checkout) {
    return miss('the record was written by a different checkout');
  }
  if (memo.tree !== tree) return miss('this tree has not passed the gate');
  // The bar the caller set, and the miss says what was missing rather than only that something was:
  // "already passed" is a claim, and a reader is owed the reason it does not apply here.
  const missing = required.filter((want) => !memo.steps.some((ran) => sameStep(ran, want)));
  if (missing.length > 0) {
    return miss(`this tree passed without ${missing.map(commandLine).join(', ')}`);
  }
  return { hit: true, why: 'this tree already passed the gate', memo };
}

/**
 * What `remember` did. `written: false` with a `why` is an ordinary outcome -- a blocked run is not a
 * failure to memoise -- while `ok: false` is a write that was attempted and did not land.
 *
 * @typedef {object} RememberResult
 * @property {boolean} ok
 * @property {string} path
 * @property {boolean} written
 * @property {string} [why]
 * @property {string} [error]
 */

/**
 * Remembers this tree as one that passed, if it passed.
 *
 * @param {object} options
 * @param {string} [options.root]
 * @param {string | null} options.tree
 * @param {readonly MemoStep[]} options.steps The steps that actually ran.
 * @param {string} options.outcome The run's own word: only `'ok'` is remembered.
 * @param {string} [options.memoPath]
 * @returns {RememberResult}
 */
export function remember({ root = process.cwd(), tree, steps, outcome, memoPath = MEMO_PATH }) {
  const path = join(root, memoPath);
  if (outcome !== 'ok') {
    return { ok: true, path, written: false, why: `the run was ${outcome}` };
  }
  if (tree === null) {
    return { ok: true, path, written: false, why: 'the index could not be read' };
  }
  const checkout = checkoutOf(root);
  if (checkout === null) {
    return { ok: true, path, written: false, why: 'this checkout could not be identified' };
  }
  const record = {
    v: MEMO_VERSION,
    checkout,
    tree,
    at: new Date().toISOString(),
    steps: steps.map((step) => ({ command: step.command, args: [...step.args] })),
  };
  // Temp then rename, so a reader sees either the previous record or this one and never half of
  // either. The temp file is this process's, so two runs cannot collide on it -- and gates are
  // serialised by the lock in any case.
  const temp = `${path}.${String(process.pid)}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8');
    renameSync(temp, path);
    return { ok: true, path, written: true };
  } catch (error) {
    // A stale temp file would be collected by nothing, so it goes now. `force` because the failure
    // may have been the write itself, in which case there is nothing there to remove.
    //
    // IN ITS OWN try/catch, and that is `asc-s3xx`: when `.ascend` exists as a FILE, `mkdirSync` is
    // what fails and `rmSync` then throws ENOTDIR from its own lstat -- inside the handler, where
    // nothing caught it. A memo that cannot be written must be REPORTED, never thrown: the gate's
    // verdict is not this file's to change, which is the rule this whole function exists under.
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing to remove, or nothing to remove it from. Both are the same answer here.
    }
    return { ok: false, path, written: false, error: messageOf(error) };
  }
}
