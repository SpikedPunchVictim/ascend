import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MEMO_PATH, MEMO_VERSION, check, readMemo, remember, treeOf } from './gate-memo.mjs';
import { memoAllowed, scopeFor, skippedFor, skippedWhenAlreadyPassed, stepsFor } from './gate.mjs';

/**
 * `asc-09wx.14`'s fourth cut: a tree that passed is not gated again.
 *
 * THE ONE DEFECT THIS FILE EXISTS FOR is a memo that answers "already passed" for a tree that did not,
 * or that remembers a tree which failed. Either turns the next amend green without running anything,
 * which is the severity-zero class this repository treats as worse than no gate at all -- a green
 * verdict nobody earned destroys the value of every other green verdict. So the corners tested here
 * are the ways that could happen: a corrupt record read generously, a record from another checkout,
 * a record whose list of steps cannot be believed, and a failed run that memoised anyway.
 *
 * WHY THE FIXTURES ARE REAL GIT REPOSITORIES. The key is `git write-tree`, so the thing under test is
 * what git actually hashes -- and the case the cut exists for, an amend, is only expressible by making
 * one. A fixture that faked an index would be asserting about a quantity git never produced.
 *
 * WHY THIS DOES NOT REUSE `scripts/gate.test.ts`'s HARNESS. That one stages files and never commits;
 * this one has to advance HEAD and amend, so it needs its own `git` environment. What it does share is
 * the technique: `pnpm` and `node` are stubbed on `PATH` in a sibling directory, so no test here runs
 * the real suite or reaches this checkout's index.
 */

const GATE = fileURLToPath(new URL('./gate.mjs', import.meta.url));

/**
 * The six labels a person sees today, in order. Literal rather than read off `STEPS`, for the reason
 * `scripts/gate.test.ts` gives: these strings are a contract, and an assertion against the same array
 * could not catch a reorder or a rename.
 */
const WHOLE_RUN = [
  'format:check',
  'typecheck',
  'store verify --staged',
  'lint',
  'test',
  'test count',
];

/** The one staged path most tests use: a code change, so the scope is a real subset and not the cut. */
const STAGED = 'packages/store/src/pages.ts';

/** One gate run's row, as the parts these tests read it. */
interface RunRow {
  readonly steps: readonly { readonly label: string; readonly status: number }[];
  readonly scope?: string;
  readonly skipped?: readonly { readonly step: string; readonly why: string }[];
  readonly outcome: string;
}

type Step = import('./gate.mjs').Step;
type MemoStep = import('./gate-memo.mjs').MemoStep;

/** Every directory this file made, so the suite can remove exactly those and nothing else. */
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * An environment this fixture's `git` owns: the machine's own identity, hook and signing
 * configuration is replaced rather than inherited, so a global `core.hooksPath`, a global
 * `commit.gpgsign` or a missing identity cannot make a fixture behave differently on another machine.
 * The dates are pinned so two runs of this file produce the same commit ids.
 */
function gitEnv(): Record<string, string> {
  /** @type {Record<string, string>} */
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'ascend fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'ascend fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
  };
}

function gitIn(dir: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
}

function write(dir: string, path: string, content = 'fixture\n'): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A fresh repository with one file staged and no commits yet, so `HEAD` is unborn. */
function repo(files: readonly string[] = [STAGED]): string {
  const dir = tempDir('asc-gate-memo-');
  gitIn(dir, ['init', '-q']);
  for (const path of files) write(dir, path);
  gitIn(dir, ['add', '-A']);
  return dir;
}

/** The steps a run over these paths WOULD take. */
function plannedFor(paths: readonly string[]): readonly Step[] {
  return stepsFor({}, scopeFor({}, paths));
}

function memoSteps(paths: readonly string[] = [STAGED]): readonly MemoStep[] {
  return plannedFor(paths).map((step) => ({ command: step.command, args: step.args }));
}

function memoPath(dir: string): string {
  return join(dir, MEMO_PATH);
}

/** `pnpm` and `node` stubbed in a sibling directory, for the reason `gate.test.ts` gives. */
function binDir(pnpmExit: number): string {
  const bin = tempDir('asc-gate-memo-bin-');
  const fakePnpm = join(bin, 'pnpm');
  writeFileSync(fakePnpm, `#!/bin/sh\nexit ${String(pnpmExit)}\n`, 'utf8');
  chmodSync(fakePnpm, 0o755);
  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      '  *packages/cli/dist/bin.js*) exit 0 ;;\n' +
      '  *scripts/test-baseline.mjs*) exit 0 ;;\n' +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    'utf8',
  );
  chmodSync(fakeNode, 0o755);
  return bin;
}

function readLog(dir: string): readonly RunRow[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, '.ascend', 'gate-runs.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RunRow);
}

interface Run {
  readonly status: number | null;
  readonly output: string;
  /**
   * The LAST row the run wrote, which is the run itself. The log is a file the directory keeps across
   * runs, so `rows[0]` is the first run this fixture ever made and not the one just made -- a
   * distinction that cost one red test while this file was being written.
   */
  readonly last: RunRow | undefined;
  readonly rows: readonly RunRow[];
}

function gate(dir: string, options: { pnpmExit?: number; env?: Record<string, string> } = {}): Run {
  const bin = binDir(options.pnpmExit ?? 0);
  /** @type {Record<string, string>} */
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  const result = spawnSync(process.execPath, [GATE], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, PATH: `${bin}:${env['PATH'] ?? ''}`, ...options.env },
  });
  const rows = readLog(dir);
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    last: rows.at(-1),
    rows,
  };
}

describe('the tree, not the diff', () => {
  it('does not re-gate an amend whose index is the tree that passed', () => {
    // THE CASE THE CUT EXISTS FOR, and the one a diff-keyed memo would miss. After the commit the
    // index equals HEAD, so `git diff --cached` is empty while `git write-tree` is exactly the hash
    // that passed a moment ago. A key hashed from the diff would go from "new file" to "" and re-run
    // every step of the gate on a commit nobody changed.
    const dir = repo();
    const first = gate(dir);
    expect(first.status).toBe(0);
    const remembered = readMemo(dir);
    expect(remembered?.tree).toBeTruthy();

    gitIn(dir, ['commit', '-q', '-m', 'fixture']);
    gitIn(dir, ['commit', '-q', '--amend', '--no-edit']);
    // Stated rather than assumed: the diff really is empty now, so the two keys really do disagree.
    expect(gitIn(dir, ['diff', '--cached']).trim()).toBe('');

    const second = gate(dir);
    expect(second.status).toBe(0);
    expect(second.output).toContain('already passed the gate');
    expect(second.last?.steps).toEqual([]);
    // THE AMEND IS A `full`-SCOPE RUN and still hits. Nothing is staged, `scopeOf([])` says `full`
    // because "nothing staged is not nothing reachable" (`scripts/gate-scope.mjs`), and this run
    // therefore wants six steps while the record's subset run took five. That is why a hit does not
    // require coverage -- the requirement was in the first draft and refused every amend there is.
    expect(second.last?.scope).toBe('full');
    expect(remembered?.steps).toHaveLength(5);
    // EVERY STEP, in the order a reader sees them. A hit that recorded nothing would be
    // indistinguishable from a run whose checks were never wired -- the shape `dogfood/0061` records.
    expect(second.last?.skipped?.map((entry) => entry.step)).toEqual(WHOLE_RUN);
    expect(second.last?.outcome).toBe('ok');
    expect(treeOf(dir)).toBe(remembered?.tree);
  });

  it('re-runs everything when one byte of the index changes', () => {
    // The other direction, and the one that has to hold for the cut to be safe at all: a memo keyed
    // on something too coarse -- HEAD, a commit id, the staged file list -- would call this tree the
    // same. A byte in the index is the smallest change that has to defeat it.
    const dir = repo();
    gate(dir);
    const before = treeOf(dir);

    write(dir, STAGED, 'fixture changed\n');
    // The one path, not `-A`: this fixture has no `.gitignore`, so `-A` would sweep up the gate's own
    // `.ascend/gate-memo.json` and `.ascend/gate-runs.jsonl` and widen the scope past the package this
    // test is about. (In the real checkout both are ignored, so this cannot happen there.)
    gitIn(dir, ['add', STAGED]);
    expect(treeOf(dir)).not.toBe(before);

    const second = gate(dir);
    expect(second.output).not.toContain('already passed the gate');
    expect(second.last?.steps.map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 5));
  });

  it('misses for a tree nobody has judged, on a record that exists', () => {
    // The record is present and readable and names a different tree. This is the ordinary state after
    // an edit, and it is worth its own case because it is the one a "the file exists" check would get
    // wrong.
    const dir = repo();
    expect(
      remember({ root: dir, tree: 'a-tree-nobody-judged', steps: memoSteps(), outcome: 'ok' })
        .written,
    ).toBe(true);

    const missed = check({ root: dir, tree: treeOf(dir) });
    expect(missed.hit).toBe(false);
    expect(missed.why).toBe('this tree has not passed the gate');
  });
});

describe('any doubt is a miss', () => {
  it('runs the gate when there is no record at all', () => {
    const dir = repo();
    const missed = check({ root: dir, tree: treeOf(dir) });

    expect(missed.hit).toBe(false);
    expect(missed.why).toBe('no tree that passed the gate is recorded here');
  });

  it('runs the gate when the record is corrupt rather than reading it generously', () => {
    // A torn write, a hand edit, a partial copy. The tempting repair -- take the tree field and
    // ignore the rest -- is the one that turns a damaged file into a green verdict.
    const dir = repo();
    const tree = treeOf(dir);
    expect(remember({ root: dir, tree, steps: memoSteps(), outcome: 'ok' }).written).toBe(true);
    expect(check({ root: dir, tree }).hit).toBe(true);

    writeFileSync(memoPath(dir), '{"v":1,"checkout":', 'utf8');
    const missed = check({ root: dir, tree });
    expect(missed.hit).toBe(false);
    expect(missed.memo).toBeNull();
  });

  it('runs the gate for a record whose schema version it does not know', () => {
    const dir = repo();
    const tree = treeOf(dir);
    const written = remember({ root: dir, tree, steps: memoSteps(), outcome: 'ok' });
    writeFileSync(
      memoPath(dir),
      `${JSON.stringify({ ...rawRecord(written.path), v: MEMO_VERSION + 1 })}\n`,
      'utf8',
    );

    expect(check({ root: dir, tree }).hit).toBe(false);
  });

  it('runs the gate for a record whose step list cannot be believed', () => {
    // The step list is evidence about what "passed" meant for that tree. It is not what a hit turns
    // on, and a record carrying something that is not a step list is still a record that cannot be
    // believed -- the same reading that makes every other doubt a miss.
    const dir = repo();
    const tree = treeOf(dir);
    const written = remember({ root: dir, tree, steps: memoSteps(), outcome: 'ok' });
    writeFileSync(
      memoPath(dir),
      `${JSON.stringify({ ...rawRecord(written.path), steps: ['format:check'] })}\n`,
      'utf8',
    );

    expect(check({ root: dir, tree }).hit).toBe(false);
  });

  it('runs the gate for a record written by a different checkout', () => {
    // The tree hash is content-only, so two checkouts holding the same index share it. A record copied
    // between them would otherwise be a hit on a tree this checkout never judged.
    const here = repo();
    const elsewhere = repo();
    const tree = treeOf(here);
    const written = remember({ root: elsewhere, tree, steps: memoSteps(), outcome: 'ok' });
    expect(written.written).toBe(true);
    expect(written.path).toBe(memoPath(elsewhere));

    // The same tree, written to the wrong place: the tree matches and the checkout does not.
    write(here, MEMO_PATH, readFileSync(written.path, 'utf8'));
    expect(treeOf(here)).toBe(tree);

    const missed = check({ root: here, tree });
    expect(missed.hit).toBe(false);
    expect(missed.why).toBe('the record was written by a different checkout');
  });

  it('runs the gate when the index cannot be read at all', () => {
    // `null` is "nobody knows", which is not the same as "nothing staged" -- and it is not a hit. The
    // same reading `scopeFor` gives a staged set git could not report.
    const dir = repo();
    expect(
      remember({ root: dir, tree: treeOf(dir), steps: memoSteps(), outcome: 'ok' }).written,
    ).toBe(true);

    const missed = check({ root: dir, tree: null });
    expect(missed.hit).toBe(false);
    expect(missed.why).toBe('the index could not be read');
  });
});

describe('a failed tree is never memoised', () => {
  it('writes nothing when the run was handed an outcome that is not ok', () => {
    const dir = repo();
    const result = remember({
      root: dir,
      tree: treeOf(dir),
      steps: memoSteps(),
      outcome: 'blocked',
    });

    expect(result.written).toBe(false);
    expect(result.why).toBe('the run was blocked');
    expect(existsSync(memoPath(dir))).toBe(false);
    expect(readMemo(dir)).toBeNull();
  });

  it('leaves a blocked run out of the record, so the next amend runs the gate', () => {
    // The end-to-end half, and the assertion a mutation on the guard would fail: after a run that
    // blocked, no record exists -- and the next run therefore pays for every step rather than reading
    // a green the previous run did not earn.
    const dir = repo();
    const blocked = gate(dir, { pnpmExit: 1 });

    expect(blocked.status).toBe(1);
    expect(blocked.last?.outcome).toBe('blocked');
    expect(existsSync(memoPath(dir))).toBe(false);

    const next = gate(dir);
    expect(next.status).toBe(0);
    expect(next.output).not.toContain('already passed the gate');
    expect(next.last?.steps.map((step) => step.label)).toEqual(WHOLE_RUN.slice(0, 5));
  });
});

describe('who may consult it', () => {
  it('takes no memo for a fixture, and none under the umbrella', () => {
    // One condition governs both directions: a run that may not ask may not leave a record either, so
    // a fixture cannot seed one. Equalities, not truthiness tests -- `ASCEND_PRECOMMIT_FULL=0` is the
    // documented way to say "fast".
    expect(memoAllowed({})).toBe(true);
    expect(memoAllowed({ ASCEND_GATE_NO_RECORD: '1' })).toBe(false);
    expect(memoAllowed({ ASCEND_PRECOMMIT_FULL: '1' })).toBe(false);
    expect(memoAllowed({ ASCEND_GATE_SCOPE: 'full' })).toBe(false);
    expect(memoAllowed({ ASCEND_PRECOMMIT_FULL: '0' })).toBe(true);
    expect(memoAllowed({ ASCEND_GATE_SCOPE: 'FULL' })).toBe(true);
  });

  it('writes no record when the caller says this is not a real run', () => {
    const dir = repo();
    const run = gate(dir, { env: { ASCEND_GATE_NO_RECORD: '1' } });

    expect(run.status).toBe(0);
    expect(existsSync(memoPath(dir))).toBe(false);
  });

  it('pays for everything when the environment asks for the whole thing', () => {
    // A memo that answered a `ASCEND_GATE_SCOPE=full` run would be a hit that defeats the escape
    // hatch. `ASCEND_GATE_SCOPE` rather than `ASCEND_PRECOMMIT_FULL` because the umbrella would also
    // add `align check` -- unstubbed here, so it would block and the test would be asserting about a
    // red gate rather than about the memo.
    const dir = repo();
    expect(gate(dir).status).toBe(0);
    expect(existsSync(memoPath(dir))).toBe(true);

    const full = gate(dir, { env: { ASCEND_GATE_SCOPE: 'full' } });
    expect(full.output).not.toContain('already passed the gate');
    expect(full.last?.steps.map((step) => step.label)).toEqual(WHOLE_RUN);
    expect(full.last?.scope).toBe('full');
  });

  it('pays for everything at pre-push, which is the hook that sets the umbrella', () => {
    // THE LOAD-BEARING GUARD FOR THE WHOLE CUT. A hit is keyed on the tree alone, so nothing inside
    // `scripts/gate-memo.mjs` stops a record from a subset run answering a run that wants the full
    // suite. This is what does. `.githooks/pre-push` runs this runner with `ASCEND_PRECOMMIT_FULL=1`
    // and its whole job is to run what the commit's cut deferred, so a hit here would skip the full
    // suite at the one moment it is the point.
    //
    // `align check` is unstubbed, so it cannot be started in a throwaway directory and the run blocks
    // on it -- which is itself the assertion that the run reached it instead of answering from the
    // record.
    const dir = repo();
    expect(gate(dir).status).toBe(0);

    const push = gate(dir, { env: { ASCEND_PRECOMMIT_FULL: '1' } });
    expect(push.output).not.toContain('already passed the gate');
    expect(push.last?.steps.map((step) => step.label)).toEqual([...WHOLE_RUN, 'align check']);
    expect(push.status).not.toBe(0);
  });
});

describe('what a judged run records', () => {
  it('names every step the run would have taken, once, in the order a reader sees them', () => {
    // Which scope the tree earned does not change what a judged run did, and it must not change how
    // the row reads. The two halves of the list cannot overlap -- `skippedFor` names steps that are
    // not in this run's list at all -- and a step named twice would read as two skips.
    for (const paths of [[STAGED], ['.ascend/entries/note-1a2b/0001.jsonl'], ['package.json']]) {
      const scope = scopeFor({}, paths);
      const planned = stepsFor({}, scope);
      const skipped = skippedWhenAlreadyPassed(scope, planned, 'this tree already passed the gate');
      const named = skipped.map((entry) => entry.step);

      expect(named, paths.join(',')).toEqual(WHOLE_RUN);
      expect(new Set(named).size, paths.join(',')).toBe(named.length);
      for (const entry of skipped) expect(entry.why).not.toBe('');
    }
  });

  it('keeps the scope skips saying what the SCOPE cut, not what the memo did', () => {
    // The two reasons are different facts and are still different in a judged row: `skippedFor`
    // explains what the staged set could not reach, and the memo explains why nothing ran at all.
    const scope = scopeFor({}, ['.ascend/entries/note-1a2b/0001.jsonl']);
    const skipped = skippedWhenAlreadyPassed(
      scope,
      stepsFor({}, scope),
      'this tree already passed the gate',
    );

    expect(skipped.find((entry) => entry.step === 'test')?.why).toBe(
      skippedFor(scope).find((entry) => entry.step === 'test')?.why,
    );
    expect(skipped.find((entry) => entry.step === 'lint')?.why).toBe(
      'this tree already passed the gate',
    );
  });
});

describe('the bound, pinned', () => {
  it('is a statement about the index, not about the working tree', () => {
    // THIS IS A LIMITATION, ASSERTED SO IT CANNOT BE MISTAKEN FOR COVERAGE. The gate's steps mostly
    // read the WORKING TREE -- `format:check`, `typecheck`, `lint` and `test` all read files from
    // disk -- while this key is the index. An amend therefore hits even when an unstaged edit would
    // have failed a step. What the hit does say is that the COMMIT being judged is byte-identical to
    // one that passed, which is the amend case the cut is for; widening the key to the worktree is
    // possible and deliberately not built. Stated in `scripts/gate-memo.mjs` and in `EV-70.md`.
    const dir = repo();
    const tree = treeOf(dir);
    expect(remember({ root: dir, tree, steps: memoSteps(), outcome: 'ok' }).written).toBe(true);
    const indexBefore = gitIn(dir, ['diff', '--cached']);

    // A real edit, deliberately NOT staged -- so it is invisible to the index and to this key.
    write(dir, STAGED, 'a working tree this key does not see\n');
    expect(gitIn(dir, ['diff', '--cached'])).toBe(indexBefore);
    expect(gitIn(dir, ['diff']).trim()).not.toBe('');
    expect(treeOf(dir)).toBe(tree);

    expect(check({ root: dir, tree }).hit).toBe(true);
  });
});

/**
 * The record `remember` just wrote, read back as raw JSON. Only used where a test has to change one
 * field of a real record, which is why it is not `readMemo` -- that one refuses anything it cannot
 * believe, and these tests are about what happens when a record cannot be believed.
 */
function rawRecord(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the memo just written is not an object');
  }
  return parsed as Record<string, unknown>;
}
