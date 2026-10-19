/**
 * `asc-n0if`: the push gates the commits, not the checkout.
 *
 * THE DEFECT THIS FILE EXISTS FOR is a pre-push verdict that is a fact about the directory rather
 * than about the commits leaving the machine (`dogfood/0096`): an uncommitted edit in another
 * session blocked a push that carried none of it, and the run row named the checkout's `HEAD` rather
 * than the pushed commit. The tests here pin both halves -- the refs that decide what is gated, and
 * the worktree that decides what the gate reads -- plus the failure directions, because a push that
 * could not be gated must never be reported as gated.
 *
 * WHY THE FIXTURES ARE REAL GIT REPOSITORIES, for the reason `scripts/gate-memo.test.ts` gives at its
 * own: the quantities under test are `git worktree add` and `git rev-parse <sha>^{tree}`. A fixture
 * that faked a tree would be asserting about a hash git never produced.
 *
 * THE DRIVEN TESTS RUN THE REAL GATE against a real commit of THIS repository, with `pnpm` and `node`
 * stubbed on `PATH` -- the technique `scripts/gate.test.ts` established -- and with
 * `ASCEND_GATE_STATE_ROOT` pointed at a temporary directory, so no row lands in this checkout's log.
 */

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
import { afterAll, describe, expect, it } from 'vitest';
import { childEnv, commitOf, materialize, parseRefs, tearDown, tipsOf } from './push-gate.mjs';

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** The machine's identity, hooks and signing replaced, so a fixture cannot inherit a global. */
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
  return execFileSync('git', [...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' }).trim();
}

function write(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A repository with one commit. */
function repo(files: Record<string, string>): string {
  const dir = tempDir('asc-push-gate-');
  gitIn(dir, ['init', '-q']);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-qm', 'one']);
  return dir;
}

const line = (ref: string, oid: string): string =>
  `${ref} ${oid} refs/heads/${ref.split('/').at(-1) ?? 'x'} ${'0'.repeat(40)}`;

describe('what git hands the hook', () => {
  it('reads one ref per line, and keeps a line it cannot fully read', () => {
    const refs = parseRefs(`${line('refs/heads/a', 'a'.repeat(40))}\n\nrefs/heads/b only-two\n`);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({
      localRef: 'refs/heads/a',
      localOid: 'a'.repeat(40),
      remoteRef: 'refs/heads/a',
      remoteOid: '0'.repeat(40),
    });
    // A line that is not four fields is kept with what it has: a ref this file cannot read is a ref
    // nobody gated, and dropping it silently is the failure mode the module exists to refuse.
    expect(refs[1]?.localRef).toBe('refs/heads/b');
    expect(refs[1]?.localOid).toBe('only-two');
  });

  it('gates each distinct commit once, and never a deletion', () => {
    const refs = parseRefs(
      [
        line('refs/heads/a', 'a'.repeat(40)),
        line('refs/heads/b', 'b'.repeat(40)),
        // The same commit pushed to two remotes: one tree, one gate.
        line('refs/heads/a-again', 'a'.repeat(40)),
        // A branch deletion announces itself with the zero oid and carries no content.
        line('refs/heads/gone', '0'.repeat(40)),
      ].join('\n'),
    );
    expect(tipsOf(refs)).toEqual([
      { oid: 'a'.repeat(40), refs: ['refs/heads/a', 'refs/heads/a-again'] },
      { oid: 'b'.repeat(40), refs: ['refs/heads/b'] },
    ]);
  });
});

describe('what the gate reads', () => {
  it('materialises the commit, so an uncommitted edit in the checkout is not part of it', () => {
    const dir = repo({ 'a.txt': 'one' });
    const sha = gitIn(dir, ['rev-parse', 'HEAD']);
    const tree = gitIn(dir, ['rev-parse', 'HEAD^{tree}']);

    // THE 0096 REGRESSION, in the smallest form: a file that no commit carries.
    write(dir, 'a.txt', 'uncommitted and broken');
    write(dir, 'extra.txt', 'also uncommitted');
    expect(gitIn(dir, ['status', '--porcelain'])).not.toBe('');

    const spot = materialize(dir, sha);
    expect(spot).not.toBeNull();
    try {
      expect(gitIn(spot!.dir, ['status', '--porcelain'])).toBe('');
      expect(gitIn(spot!.dir, ['rev-parse', 'HEAD^{tree}'])).toBe(tree);
      expect(readFileSync(join(spot!.dir, 'a.txt'), 'utf8')).toBe('one');
      expect(existsSync(join(spot!.dir, 'extra.txt'))).toBe(false);
    } finally {
      expect(tearDown(dir, spot!)).toBe(true);
    }
    expect(gitIn(dir, ['worktree', 'list']).split('\n')).toHaveLength(1);
  });

  it('dereferences a tag to the commit it names, and refuses an object that is not one', () => {
    const dir = repo({ 'a.txt': 'one' });
    const sha = gitIn(dir, ['rev-parse', 'HEAD']);
    gitIn(dir, ['tag', '-a', 'v1', '-m', 'one']);

    expect(commitOf(dir, 'v1')).toBe(sha);
    expect(commitOf(dir, '0'.repeat(40))).toBeNull();
  });
});

/**
 * `pnpm` answers the install and every step, and installs an `align` into the worktree, because
 * `align check` is a full-mode step invoked as `./node_modules/.bin/align` and a stubbed install is
 * the only way it exists. `node` answers the three steps that would read real inputs and is the real
 * node otherwise, so the gate itself runs.
 */
function binDir(formatExit = 0): string {
  const bin = tempDir('asc-push-gate-bin-');
  const fakePnpm = join(bin, 'pnpm');
  writeFileSync(
    fakePnpm,
    '#!/bin/sh\n' +
      'case "$1" in\n' +
      '  install) mkdir -p node_modules/.bin\n' +
      '           printf "#!/bin/sh\\nexit 0\\n" > node_modules/.bin/align\n' +
      '           chmod +x node_modules/.bin/align\n' +
      '           exit 0 ;;\n' +
      `  format:check) exit ${String(formatExit)} ;;\n` +
      'esac\n' +
      'exit 0\n',
    'utf8',
  );
  chmodSync(fakePnpm, 0o755);

  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      '  *packages/cli/dist/bin.js*) exit 0 ;;\n' +
      '  *scripts/test-baseline.mjs*) exit 0 ;;\n' +
      '  *scripts/gate-duplicate-ids.mjs*) exit 0 ;;\n' +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    'utf8',
  );
  chmodSync(fakeNode, 0o755);
  return bin;
}

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** How many worktrees this repository holds right now -- the baseline a run must return to. */
function worktreeCount(): number {
  return execFileSync('git', ['worktree', 'list'], { cwd: repoRoot, encoding: 'utf8' })
    .trim()
    .split('\n').length;
}

function runPush(
  refs: string,
  formatExit = 0,
): {
  status: number | null;
  output: string;
  state: string;
} {
  const bin = binDir(formatExit);
  const state = tempDir('asc-push-gate-state-');
  // A refs file rather than stdin: the hook writes one, and a test that fed stdin would exercise a
  // path the hook does not take.
  const file = join(tempDir('asc-push-gate-refs-'), 'refs');
  writeFileSync(file, refs, 'utf8');
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/push-gate.mjs'), file], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      ASCEND_GATE_STATE_ROOT: state,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, state };
}

function rowsOf(state: string): Record<string, unknown>[] {
  let text = '';
  try {
    text = readFileSync(join(state, '.ascend', 'gate-runs.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parsed: unknown = JSON.parse(entry);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    });
}

describe('gating a pushed commit', () => {
  it('runs the gate in a worktree of the commit, and records a row about THAT commit', () => {
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();

    const before = worktreeCount();
    const { status, output, state } = runPush(`${line('refs/heads/fixture', tip)}\n`);
    expect(status).toBe(0);
    expect(output).toContain('[pre-push] gating');

    const row = rowsOf(state).at(-1);
    // The two facts dogfood/0096 says the old row could not state: which commit, and which content.
    expect(row?.['head']).toBe(tip);
    expect(row?.['tree']).toBe(tree);
    expect(row?.['work']).toBe(tree);
    expect(row?.['outcome']).toBe('ok');
    // And the worktree it ran in is gone. Compared against the count from BEFORE the run, not against
    // one: this repository can legitimately hold other worktrees -- a live pre-push gate holds one
    // while it works, and a person may -- and an assertion of "exactly one" would fail on a fact this
    // test has no business asserting.
    expect(worktreeCount()).toBe(before);
  });

  it('blocks the push when the gate refuses the commit, and still removes the worktree', () => {
    const tip = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const before = worktreeCount();
    const { status, output } = runPush(`${line('refs/heads/fixture', tip)}\n`, 1);

    expect(status).toBe(1);
    expect(output).toContain('the gate refused');
    expect(worktreeCount()).toBe(before);
  });

  it('gates HEAD when it was handed no refs, rather than gating nothing', () => {
    // A person running the hook by hand, or a push carrying only deletions: the commit in front of us
    // is the only thing there is to gate, and gating nothing quietly would be the fail-open direction.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const { status, output, state } = runPush('');

    expect(status).toBe(0);
    expect(output).toContain('for HEAD');
    expect(rowsOf(state).at(-1)?.['head']).toBe(head);
  });
});

describe('the environment a pushed run is handed', () => {
  it("drops git's own variables and states the mode, so the run cannot read the checkout's metadata", () => {
    const env = childEnv(
      { GIT_DIR: '/x', GIT_WORK_TREE: '/y', GIT_INDEX_FILE: '/z', PATH: '/bin' },
      '/repo',
    );

    // An inherited GIT_DIR would point every git call -- and every test subprocess -- back at the
    // checkout, making the worktree a lie. This is the assertion that says it does not.
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_WORK_TREE']).toBeUndefined();
    expect(env['GIT_INDEX_FILE']).toBeUndefined();
    expect(env['ASCEND_GATE_HOOK']).toBe('pre-push');
    expect(env['ASCEND_PRECOMMIT_FULL']).toBe('1');
    expect(env['ASCEND_GATE_STATE_ROOT']).toBe('/repo');
    expect(env['PATH']).toBe('/bin');
  });
});
