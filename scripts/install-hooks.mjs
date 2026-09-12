#!/usr/bin/env node
/**
 * Install (or remove) ascend's pre-commit gate.
 *
 * WHY THIS EXISTS INSTEAD OF `git config core.hooksPath .githooks`
 *
 * `core.hooksPath` is a single value, and beads already claims it. Pointing it at
 * `.githooks` would silence five working beads hooks to install one ascend gate.
 * So ascend does not take the mechanism; it splices its gate ABOVE beads' managed
 * block in `.beads/hooks/pre-commit` and leaves beads in charge of the path.
 *
 * INVARIANT (docs/evidence/EV-hooks.md): an installer's success message is not
 * evidence. `bd hooks install --beads` prints `✓ Git hooks installed successfully`
 * while writing an ABSOLUTE path that a rename silently orphans, and
 * `bd hooks install --beads --chain` prints the same success while producing a
 * beads block that is unreachable. Both were measured, not inferred. So this script
 * re-reads the artifact it just wrote and asserts every property it claims, and it
 * exits non-zero if any check fails.
 *
 * Usage:  node scripts/install-hooks.mjs [--uninstall]
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN = '# --- BEGIN BEADS INTEGRATION';
const END = '# --- END BEADS INTEGRATION';

const SOURCE = 'core.hooksPath';
const HOOKS_PATH = '.beads/hooks'; // RELATIVE, deliberately: see EV-hooks Q2.
const GATE_SOURCE = '.githooks/pre-commit';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const uninstall = process.argv.includes('--uninstall');

/**
 * This file is plain .mjs, so it is type-checked only as far as these JSDoc tags
 * take it (checkJs is off). They exist so the type-aware lint rules can see real
 * types instead of `any` -- without them `args` widens to `any` and every value
 * flowing out of `run()` becomes an unsafe template expression.
 *
 * @param {string} cmd
 * @param {readonly string[]} args
 * @returns {string}
 */
const run = (cmd, args) => execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' }).trim();

/**
 * @param {...string} args
 * @returns {string}
 */
const git = (...args) => run('git', args);

/**
 * A thrown value is `unknown`, not an Error. execFileSync throws Errors, but the
 * narrowing is what the lint rules require and it is correct regardless.
 *
 * @param {unknown} error
 * @returns {string}
 */
const detail = (error) => (error instanceof Error ? error.message : String(error));

/** True when `core.hooksPath` is set at all. `git config --get` exits 1 when absent. */
function hooksPathIsSet() {
  try {
    git('config', '--get', SOURCE);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`\n  FAILED: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- preconditions

const target = join(repoRoot, HOOKS_PATH, 'pre-commit');

if (!existsSync(target)) {
  // Beads builds its own shims and knows the correct set. Let it, rather than
  // hand-writing five files that would drift from the installed bd version.
  console.log(
    `[install-hooks] ${HOOKS_PATH}/pre-commit absent; running 'bd hooks install --beads'`,
  );
  try {
    run('bd', ['hooks', 'install', '--beads']);
  } catch (error) {
    fail(
      `could not install beads' hooks: ${detail(error)}\n  Install beads, or create ${HOOKS_PATH}/ by hand.`,
    );
  }
}

if (!existsSync(target)) fail(`bd did not create ${HOOKS_PATH}/pre-commit`);

const before = readFileSync(target, 'utf8');
const marker = before.indexOf(BEGIN);

if (marker === -1) {
  // Refuse rather than clobber. An unrecognised file is someone else's.
  fail(
    `${HOOKS_PATH}/pre-commit has no beads block (looked for '${BEGIN}'),\n` +
      `  so this script cannot tell which part is safe to replace. Refusing to overwrite.`,
  );
}

const shebang = before.startsWith('#!') ? before.slice(0, before.indexOf('\n') + 1) : '#!/bin/sh\n';
// Everything from the BEGIN marker onward is beads' territory -- preserved verbatim.
const beadsBlock = before.slice(marker);

// ------------------------------------------------------------------- the splice

let gate = '';
if (!uninstall) {
  const gateSource = join(repoRoot, GATE_SOURCE);
  if (!existsSync(gateSource)) fail(`${GATE_SOURCE} not found`);

  gate = readFileSync(gateSource, 'utf8');
  // Strip the source's own shebang; the spliced file already has one.
  if (gate.startsWith('#!')) gate = gate.slice(gate.indexOf('\n') + 1);
  gate = gate.trimEnd();

  // Enforce INVARIANT 1 before writing, not after. A gate that exits the shell
  // above beads' block makes beads' block unreachable while everything still
  // reports success -- the exact defect measured in EV-hooks Q2b.
  const shortCircuit = gate
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .findIndex((line) => /^\s*exit(\s+0)?\s*$/.test(line));
  if (shortCircuit !== -1) {
    fail(
      `${GATE_SOURCE} terminates the shell above beads' block\n` +
        `  (bare exit at gate line ${String(shortCircuit + 1)}). That would make beads' hooks\n` +
        `  unreachable. Let control fall through, or use 'exit 1' to block the commit.`,
    );
  }
}

if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${shebang}${gate ? `${gate}\n\n` : ''}${beadsBlock}`, 'utf8');
chmodSync(target, 0o755);

if (uninstall) {
  console.log(`[install-hooks] removed ascend's gate from ${HOOKS_PATH}/pre-commit`);
} else {
  try {
    git('config', SOURCE, HOOKS_PATH);
  } catch (error) {
    fail(`could not set ${SOURCE}: ${detail(error)}`);
  }
}

// -------------------------------------------------- verify the ARTIFACT, not the writes
//
// Every check below re-reads what is actually on disk. This is the point of the
// script: the two beads defects it works around were both invisible because the
// installer trusted its own return code.

console.log('[install-hooks] verifying the installed artifact');

const problems = [];

const after = readFileSync(target, 'utf8');
if (!after.includes(BEGIN)) problems.push('beads block disappeared from pre-commit');
// Matched as a pattern, not a suffix: beads stamps a version into both markers
// (`# --- END BEADS INTEGRATION v1.2.2 ---`), and a literal endsWith() check
// rejected the correct artifact the first time this script ran. Compare on the
// marker text, ignore the version stamp and any trailing dashes.
if (
  !new RegExp(`^\\s*${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm').test(after.trimEnd())
) {
  problems.push('beads block has no END marker; the file is truncated or was partly overwritten');
}

if (!uninstall) {
  if (!after.includes('[pre-commit]')) problems.push("ascend's gate is not present in pre-commit");

  const above = after
    .slice(0, after.indexOf(BEGIN))
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
  if (above.some((line) => /^\s*exit(\s+0)?\s*$/.test(line))) {
    problems.push("a bare 'exit' above beads' block makes beads' hooks unreachable");
  }
}

// The dead-path check: this is the rename regression, caught at install time.
if (hooksPathIsSet()) {
  const configured = git('config', '--get', SOURCE);
  const resolved = isAbsolute(configured) ? configured : join(repoRoot, configured);

  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    problems.push(`${SOURCE} -> '${configured}' is not a directory; git will run ZERO hooks`);
  }
  if (isAbsolute(configured) && !relative(repoRoot, configured).startsWith('..')) {
    problems.push(`${SOURCE} is absolute and inside the repo; a rename will orphan every hook`);
  }
}

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`  UNVERIFIED: ${problem}`);
  fail('the artifact does not match what this script claims to have installed');
}

console.log(`  ok  ${SOURCE} = ${git('config', '--get', SOURCE)}`);
console.log(`  ok  ${HOOKS_PATH}/pre-commit contains ascend's gate above beads' block`);
console.log("  ok  beads' block is intact and reachable");

try {
  console.log(`\n${run('bd', ['hooks', 'list'])}`);
} catch {
  console.log('\n(bd hooks list unavailable)');
}
