/**
 * `asc-1h3u`: the check that a `core.hooksPath` cannot silently turn every hook off.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The installer wrote the relative value and refused the
 * absolute-inside-the-repo form, and nothing else ran that rule, so the value drifted and the only
 * instrument that noticed was a suite-wide test going red -- twice, inside a pre-push gate, on
 * commits that had nothing to do with it (`dogfood/0101`). The tests here pin the rule in the one
 * place both callers now share, and pin that the gate actually refuses on it.
 *
 * WHY THE FIXTURES ARE REAL GIT REPOSITORIES: the question is what `git config --get core.hooksPath`
 * answers and where that resolves to. A fixture that faked the answer would be asserting about a
 * config read nobody performed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHooksPath, fixCommand } from './hooks-path.mjs';

const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function gitEnv(): Record<string, string> {
  /** @type {Record<string, string>} */
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
}

/** A repository, with `core.hooksPath` set to `value` when one is given. */
function repo(value?: string): string {
  const dir = tempDir('asc-hooks-path-');
  execFileSync('git', ['init', '-q'], { cwd: dir, env: gitEnv() });
  mkdirSync(join(dir, '.beads', 'hooks'), { recursive: true });
  if (value !== undefined) {
    execFileSync('git', ['config', 'core.hooksPath', value], { cwd: dir, env: gitEnv() });
  }
  return dir;
}

describe('core.hooksPath', () => {
  it('says nothing when the value is unset, because a running gate already contradicts it', () => {
    expect(checkHooksPath(repo())).toEqual({ ok: true, configured: null, problems: [] });
  });

  it('accepts the relative value the installer writes', () => {
    expect(checkHooksPath(repo('.beads/hooks'))).toEqual({
      ok: true,
      configured: '.beads/hooks',
      problems: [],
    });
  });

  it('refuses a path that is not a directory, which is git running ZERO hooks quietly', () => {
    const report = checkHooksPath(repo('.beads/gone'));
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      "core.hooksPath -> '.beads/gone' is not a directory; git will run ZERO hooks",
    ]);
  });

  it('refuses an absolute path inside the repository, which a rename orphans', () => {
    // The measured value from 2026-10-14, in miniature.
    const dir = repo();
    const absolute = join(dir, '.beads', 'hooks');
    execFileSync('git', ['config', 'core.hooksPath', absolute], { cwd: dir, env: gitEnv() });

    const report = checkHooksPath(dir);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      'core.hooksPath is absolute and inside the repo; a rename will orphan every hook',
    ]);
  });

  it('allows an absolute path OUTSIDE the repository, which a rename cannot orphan', () => {
    const shared = tempDir('asc-hooks-shared-');
    const report = checkHooksPath(repo(shared));
    expect(report).toEqual({ ok: true, configured: shared, problems: [] });
  });

  it('prints the command that fixes it, relative, because that is what survives a rename', () => {
    expect(fixCommand()).toBe('git config core.hooksPath .beads/hooks');
  });
});
