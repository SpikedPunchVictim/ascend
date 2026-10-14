import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Repo-level guard for git-hook wiring. Measured in docs/evidence/EV-hooks.md.
 *
 * This lives under packages/cli because the CLI is the component that owns hook
 * installation (`asc install-hook`, asc-1q9). The product-side equivalent of these
 * checks is `asc doctor` (asc-12a), which must verify the *recall* hook the same way.
 *
 * Why a test and not a hook: a hook cannot report that hooks are broken. When
 * `core.hooksPath` points at a directory that does not exist, git runs nothing and
 * says nothing -- so every signal the hook would have produced is exactly the signal
 * that is missing. The check has to live somewhere that runs unconditionally, which
 * means the test suite.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** The configured hooks path, or null when unset. Unset is a valid, consented state. */
function hooksPath(): string | null {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    // `git config --get` exits 1 when the key is absent. That is the unset case,
    // not an error: ascend ships hooks unarmed and the user opts in.
    return null;
  }
}

const configured = hooksPath();

describe('git hook wiring', () => {
  it('resolves core.hooksPath to a directory that exists', () => {
    if (configured === null) return; // unarmed is fine; nothing to resolve

    const resolved = isAbsolute(configured) ? configured : join(root, configured);
    expect(
      existsSync(resolved) && statSync(resolved).isDirectory(),
      `core.hooksPath is set to '${configured}' but '${resolved}' is not a directory.\n` +
        `Git resolves ZERO hooks in this state and emits no warning, so all hooks are\n` +
        `silently inactive. This is the EV-hooks.md regression.`,
    ).toBe(true);
  });

  it('does not use an absolute path inside the repo, which a rename would silently break', () => {
    if (configured === null) return;

    // bd's own installer PRINTS 'core.hooksPath=.beads/hooks' (relative) but WRITES
    // the resolved absolute path. Renaming the directory then orphans every hook with
    // no error anywhere. An absolute path OUTSIDE the repo is legitimate (a shared
    // hooks dir is unaffected by renaming this checkout); one INSIDE it is not.
    if (!isAbsolute(configured)) return;

    const rel = relative(root, configured);
    const insideRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    expect(
      insideRepo,
      `core.hooksPath is an absolute path inside this repo: '${configured}'.\n` +
        `A future rename of the checkout will break every hook with no warning.\n` +
        `Use a path relative to the repo root instead.`,
    ).toBe(false);
  });

  it('leaves beads-managed hook blocks reachable', () => {
    if (configured === null) return;

    const resolved = isAbsolute(configured) ? configured : join(root, configured);
    const preCommit = join(resolved, 'pre-commit');
    if (!existsSync(preCommit)) return;

    const body = readFileSync(preCommit, 'utf8');
    const marker = body.indexOf('# --- BEGIN BEADS INTEGRATION');
    if (marker === -1) return; // no beads block in this file; nothing to shadow

    // Anything above the marker is user/ascend content. `bd hooks install --chain`
    // APPENDS its block after existing content, so a bare `exit 0` above the marker
    // makes beads' whole block unreachable -- while the installer still prints
    // '✓ Git hooks installed successfully'. Reproduced in EV-hooks.md (Q2b).
    const above = body
      .slice(0, marker)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .filter((line) => line.trim() !== '');

    const shortCircuit = above.findIndex((line) => /^\s*exit(\s+0)?\s*$/.test(line));
    expect(
      shortCircuit,
      `A bare 'exit' at line ${String(shortCircuit + 1)} of the content above beads' managed block\n` +
        `makes that block unreachable. The hooks would not run while the installer\n` +
        `reports success. Let control fall through to the beads block instead.`,
    ).toBe(-1);
  });
});

/**
 * A gate that cannot fail is worse than no gate, because it is believed.
 *
 * This one could not fail. The gate ran its checks in a subshell used as an `if`
 * condition -- `if ! ( set -eu; ...; pnpm test ); then ...` -- and POSIX suppresses
 * `set -e` inside any command forming an `if` condition. So `set -eu` had no effect,
 * the subshell ran past a failing check, exited 0, and the gate printed
 * "ascend gate ok" with the suite red. Measured: `pnpm test` -> 1, gate -> 0.
 *
 * These tests pin the behaviour that was wrong, driving the real gate file with a
 * stubbed `pnpm` and a stubbed `node`, so no arm needs the real suite, the real
 * binary, or this checkout's index to be in any particular state.
 */
/**
 * Runs one of the real hook sources with stubs on PATH, so no arm needs the real suite, the real
 * binary, or this checkout's index to be in any particular state.
 *
 * `node` is stubbed for the same reason `pnpm` is. Left real, the store guard would run against
 * THIS checkout's index, and the gate's own control-flow test would become a test of whatever
 * happens to be staged -- passing or failing for reasons that are not the gate. The test-count
 * check is stubbed for that same reason (asc-049w): its input is `.testcount/scan.json`, which the
 * stubbed `pnpm test` never writes, so left real it would compare whatever the last real run
 * happened to leave on disk.
 *
 * `align` is reached only by the pre-push hook, and it goes through this same stub by accident of
 * how pnpm writes its bin wrappers: `node_modules/.bin/align` is a `sh` script that ends in
 * `exec node ../@spikedpunch/align-cli/dist/index.js "$@"`, and the stub directory is first on
 * PATH -- so the wrapper's own `node` is the stub. Left unstubbed, `align check` costs ten seconds
 * per run and would make the gate's verdict here depend on whether the repo conforms today, which
 * is a different test's question.
 *
 * `pnpm` echoes its arguments and the scope variable it was handed. That is what makes "this hook
 * ran the whole suite" an assertion rather than an inference.
 */
function runHook(
  hook: 'pre-commit' | 'pre-push',
  codes: {
    readonly pnpm?: number;
    readonly store?: number;
    readonly count?: number;
    readonly align?: number;
  },
): { status: number | null; output: string } {
  const bin = mkdtempSync(join(tmpdir(), 'asc-gate-'));
  const fakePnpm = join(bin, 'pnpm');
  writeFileSync(
    fakePnpm,
    '#!/bin/sh\n' +
      'echo "pnpm-stub: $* [ASCEND_TEST_SCOPE=$ASCEND_TEST_SCOPE]"\n' +
      `exit ${String(codes.pnpm ?? 0)}\n`,
    'utf8',
  );
  chmodSync(fakePnpm, 0o755);

  const fakeNode = join(bin, 'node');
  writeFileSync(
    fakeNode,
    '#!/bin/sh\n' +
      '# Only the stubbed steps are faked; anything else is the real node.\n' +
      'case "$*" in\n' +
      `  *packages/cli/dist/bin.js*) exit ${String(codes.store ?? 0)} ;;\n` +
      `  *scripts/test-baseline.mjs*) exit ${String(codes.count ?? 0)} ;;\n` +
      `  *align-cli/dist/index.js*) exit ${String(codes.align ?? 0)} ;;\n` +
      'esac\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    'utf8',
  );
  chmodSync(fakeNode, 0o755);

  const result = spawnSync('sh', [join(root, '.githooks', hook)], {
    cwd: root,
    encoding: 'utf8',
    // Prepend, so the stubs win over the real pnpm and node. `git` is left real: the gate
    // only uses it to find the toplevel, and this IS the toplevel.
    // Bracketed because `noPropertyAccessFromIndexSignature` is on: `PATH` is not a
    // declared member of `ProcessEnv`, so it comes from the index signature.
    env: {
      ...process.env,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      // This runs in the real repository, so the gate would record these stubbed runs in
      // the real `.ascend/gate-runs.jsonl` -- six rows per `pnpm test`, each one a run that
      // never happened. The log is graded (`docs/evidence/EV-70.md`), so a fixture states
      // that it is a fixture rather than being inferred from its absurd timings.
      ASCEND_GATE_NO_RECORD: '1',
      // The gate now cuts the suite to the packages a commit's staged paths can reach
      // (`asc-09wx.14`). This fixture runs in the REAL repository, so without this the steps it
      // observes would be whatever happens to be staged in the working tree at that moment --
      // and an inert staged set would skip the very test-count step asserted below.
      // `ASCEND_GATE_SCOPE=full` rather than `ASCEND_PRECOMMIT_FULL=1`, which would additionally
      // run `align check` in every arm of the pre-commit describe.
      ASCEND_GATE_SCOPE: 'full',
      // THE HOSTILE INHERITANCE, set on purpose. The gate's subset step exports
      // `ASCEND_TEST_SCOPE=subset` to `pnpm exec vitest`, and every process below that inherits it --
      // including this fixture, which is inside the `cli` subset and drives the real hooks. Set from
      // outside exactly as the subset step sets it, so the arms below are the ones that would catch a
      // full run taking its scope from what it inherited. Measured 2026-10-13: without the explicit
      // full marker on the suite step, the pre-push arm failed here and nowhere else, and it failed
      // only when the suite was running under the gate's own subset -- a fixture that passes alone and
      // fails inside the gate.
      ASCEND_TEST_SCOPE: 'subset',
    },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('pre-commit gate', () => {
  function runGate(
    pnpmExitCode: number,
    storeExitCode: number = 0,
    countExitCode: number = 0,
  ): { status: number | null; output: string } {
    return runHook('pre-commit', {
      pnpm: pnpmExitCode,
      store: storeExitCode,
      count: countExitCode,
    });
  }

  it('reports success when every check passes', () => {
    const { status, output } = runGate(0);
    expect(output).toContain('ascend gate ok');
    expect(status).toBe(0);
  });

  it('fails the commit when a check fails, and does not claim success', () => {
    const { status, output } = runGate(1);
    expect(status).not.toBe(0);
    expect(output).toContain('commit blocked');
    // The specific false green: a passing summary printed over a failing run.
    expect(output).not.toContain('ascend gate ok');
  });

  it('runs the store guard, and blocks the commit when it refuses (asc-9flv)', () => {
    // Asserted separately from "the gate fails at all": this is the one step that can lose
    // data rather than only style, so an unwired guard is worth its own red.
    const ran = runGate(0);
    expect(ran.output).toContain('[pre-commit] store verify --staged');

    const refused = runGate(0, 1);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('commit blocked');
    expect(refused.output).not.toContain('ascend gate ok');
  });

  it('runs the test-count check, and blocks the commit when it refuses (asc-049w)', () => {
    // Asserted separately for the same reason the store guard is: the whole point of `dogfood/0061`
    // is that a step which is present but unwired is invisible, so an unwired one is worth its own
    // red. The stub is what makes this testable without a real scan on disk.
    const ran = runGate(0);
    expect(ran.output).toContain('[pre-commit] test count');

    const refused = runGate(0, 0, 1);
    expect(refused.status).not.toBe(0);
    expect(refused.output).toContain('commit blocked');
    expect(refused.output).not.toContain('ascend gate ok');
  });
});

/**
 * The other half of the cut: what a commit does not run, a push does.
 *
 * `asc-09wx.14`'s third cut narrows the suite on commit to the packages the staged paths can reach.
 * `.githooks/pre-push` is what keeps the whole suite in the loop, by running the same runner with
 * `ASCEND_PRECOMMIT_FULL=1` -- so these tests are about the two things that can only go wrong in the
 * hook itself: whether it sets that variable, and whether it names itself truthfully.
 */
describe('pre-push gate', () => {
  it('runs the whole suite, not a narrowed one, and says it is the push talking', () => {
    const { status, output } = runHook('pre-push', { pnpm: 0, align: 0 });

    expect(status).toBe(0);
    // The unfiltered suite: `pnpm test`, with no directory filters and no scope on the step.
    expect(output).toContain('pnpm-stub: test [ASCEND_TEST_SCOPE=]');
    expect(output).not.toContain('exec vitest run');
    // `align check` is reached only in full mode, so its presence is the escape hatch working.
    expect(output).toContain('[pre-push] align check');
    // The prefix, which is the runner's own name for the moment. A push that printed
    // `[pre-commit]` would tell a reader the wrong hook is failing.
    expect(output).toContain('[pre-push] ascend gate ok');
    expect(output).not.toContain('[pre-commit]');
  });

  it('blocks the push when the full suite fails, and does not claim success', () => {
    // A cut is only safe if the thing that covers it actually blocks. The suite is what the commit
    // skipped, so a red one here is the whole reason the push hook exists.
    const { status, output } = runHook('pre-push', { pnpm: 1, align: 0 });

    expect(status).not.toBe(0);
    expect(output).toContain('push blocked');
    expect(output).not.toContain('ascend gate ok');
  });

  it('blocks the push when align check refuses', () => {
    // `align check` is the step no commit pays for, so pre-push is the only place it is enforced.
    const blocked = runHook('pre-push', { pnpm: 0, align: 1 });

    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('push blocked');
    expect(blocked.output).not.toContain('ascend gate ok');
  });
});
