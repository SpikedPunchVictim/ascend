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
 * These two tests pin the behaviour that was wrong, driving the real gate file with
 * a stubbed `pnpm` so neither arm needs the real suite to pass or fail.
 */
describe('pre-commit gate', () => {
  /** Runs the real gate with a fake `pnpm` on PATH that exits `code`. */
  function runGate(pnpmExitCode: number): { status: number | null; output: string } {
    const bin = mkdtempSync(join(tmpdir(), 'asc-gate-'));
    const fakePnpm = join(bin, 'pnpm');
    writeFileSync(fakePnpm, `#!/bin/sh\nexit ${String(pnpmExitCode)}\n`, 'utf8');
    chmodSync(fakePnpm, 0o755);

    const result = spawnSync('sh', [join(root, '.githooks', 'pre-commit')], {
      cwd: root,
      encoding: 'utf8',
      // Prepend, so the stub wins over the real pnpm. `git` is left real: the gate
      // only uses it to find the toplevel, and this IS the toplevel.
      // Bracketed because `noPropertyAccessFromIndexSignature` is on: `PATH` is not a
      // declared member of `ProcessEnv`, so it comes from the index signature.
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    });
    return { status: result.status, output: result.stdout + result.stderr };
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
});
