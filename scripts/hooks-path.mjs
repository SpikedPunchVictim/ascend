/**
 * The one thing that can turn every hook off without a single test failing: `core.hooksPath`.
 *
 * WHY THIS MODULE EXISTS. `scripts/install-hooks.mjs` writes the RELATIVE value on purpose and
 * already refuses the absolute-inside-the-repo form, because a rename orphans every hook. Nothing
 * else ran that check, so the value drifted anyway — measured 2026-10-14 in `.git/config`, written
 * hours after a green push — and the only instrument that noticed was a suite-wide test, which turns
 * `dev-hooks.test.ts` red and reads to whoever last edited anything as their own doing
 * (`asc-1h3u`, `dogfood/0101`). Two pre-push gates blocked at `test` for a config line, 366 s and
 * 397 s each.
 *
 * So the rule lives here, in one place, and `scripts/gate.mjs` runs it before any step. The installer
 * keeps using it too: two spellings of one rule is how the rule drifts.
 *
 * WHAT IS CHECKED, and only this:
 *
 *   - an absolute path INSIDE the repository is refused: renaming the checkout silently points git
 *     at nothing, and the hooks stop running with no error anywhere;
 *   - a path that does not resolve to a directory is refused: git runs ZERO hooks, quietly;
 *   - an absolute path OUTSIDE the repository is allowed, and so is a relative one that exists.
 *
 * An UNSET value is not a problem here. The gate only runs because a hook ran it, so "unset" is
 * already contradicted by the fact that we are executing; refusing it would block the very case the
 * check cannot see.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/**
 * A path with every symlink resolved, or the path itself when it does not exist.
 *
 * BOTH SIDES OF THE COMPARISON GO THROUGH THIS, and it is not a nicety: on macOS `os.tmpdir()` is
 * `/var/folders/…` while `process.cwd()` reports `/private/var/folders/…`, so an absolute value built
 * from one spelling and a root spelled the other way differ by `..` and the inside-the-repo rule
 * silently passes. Measured 2026-10-19 while writing the gate-level test, which failed for exactly
 * that reason before this existed. A symlinked checkout has the same shape.
 *
 * @param {string} path
 * @returns {string}
 */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * @typedef {object} HooksPathReport
 * @property {boolean} ok
 * @property {string | null} configured The raw value, or null when unset.
 * @property {string[]} problems Human-readable reasons, empty when `ok`.
 */

/**
 * @param {string} root The repository root -- what a relative value resolves against.
 * @returns {HooksPathReport}
 */
export function checkHooksPath(root) {
  const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: root,
    encoding: 'utf8',
  });
  const raw = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (raw === '') return { ok: true, configured: null, problems: [] };

  /** @type {string[]} */
  const problems = [];
  const resolved = isAbsolute(raw) ? real(raw) : join(root, raw);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    problems.push(`core.hooksPath -> '${raw}' is not a directory; git will run ZERO hooks`);
  }
  if (isAbsolute(raw) && !relative(real(root), resolved).startsWith('..')) {
    problems.push(
      `core.hooksPath is absolute and inside the repo; a rename will orphan every hook`,
    );
  }
  return { ok: problems.length === 0, configured: raw, problems };
}

/**
 * The one command that fixes both problems, printed with the refusal so a reader does not have to
 * find it. Relative, because that is what the installer writes and what survives a rename.
 *
 * @param {string} hooksPath The value the repository's own settings use.
 * @returns {string}
 */
export function fixCommand(hooksPath = '.beads/hooks') {
  return `git config core.hooksPath ${hooksPath}`;
}
