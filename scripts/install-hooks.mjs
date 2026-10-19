#!/usr/bin/env node
/**
 * Install (or remove) ascend's git hooks.
 *
 * WHY THIS EXISTS INSTEAD OF `git config core.hooksPath .githooks`
 *
 * `core.hooksPath` is a single value, and beads already claims it. Pointing it at
 * `.githooks` would silence five working beads hooks to install one ascend gate.
 * So ascend does not take the mechanism; it splices its gates ABOVE beads' managed
 * block in `.beads/hooks/<hook>` and leaves beads in charge of the path.
 *
 * TWO HOOKS, ONE MECHANISM. `pre-commit` runs the gate; `pre-push` runs the same gate with every
 * cut disabled (`asc-09wx.14`, third cut -- see `.githooks/pre-push`). Both are spliced the same
 * way, and the whole script is a loop over `HOOKS` rather than a second copy of the same steps:
 * a second copy is where the two would drift, and the drift would be invisible until a push.
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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHooksPath } from './hooks-path.mjs';

const BEGIN = '# --- BEGIN BEADS INTEGRATION';
const END = '# --- END BEADS INTEGRATION';

const SOURCE = 'core.hooksPath';
const HOOKS_PATH = '.beads/hooks'; // RELATIVE, deliberately: see EV-hooks Q2.

/**
 * The hooks ascend splices into, and the string that proves each one arrived.
 *
 * `marker` is what the verification step looks for in the written file. It is the hook's own name
 * in brackets, which is what the runner prints in front of every line it emits -- so the marker
 * appears only if the gate source for THIS hook is what got spliced. A marker both hooks shared
 * would pass on a `pre-push` file that still held `pre-commit`'s gate, which is exactly the failure
 * a shared marker could not see.
 *
 * @type {readonly { name: string, source: string, marker: string }[]}
 */
const HOOKS = [
  { name: 'pre-commit', source: '.githooks/pre-commit', marker: '[pre-commit]' },
  { name: 'pre-push', source: '.githooks/pre-push', marker: '[pre-push]' },
];

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

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`\n  FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * Where a hook's spliced artifact lives, given the hook's name.
 *
 * @param {string} name
 * @returns {string}
 */
const targetOf = (name) => join(repoRoot, HOOKS_PATH, name);

// ---------------------------------------------------------------- preconditions

// Beads builds its own shims and knows the correct set. Let it, rather than
// hand-writing five files that would drift from the installed bd version.
if (!existsSync(targetOf('pre-commit'))) {
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

// Every hook this script splices into is required to exist first. Checked as a
// set rather than per hook: `bd hooks install --beads` writes all of them at
// once, and a missing one means beads' template changed shape, not that the
// splice should invent a file.
const missing = HOOKS.filter((hook) => !existsSync(targetOf(hook.name))).map((hook) => hook.name);
if (missing.length > 0) {
  fail(
    `${HOOKS_PATH}/${missing.join(', ')} absent after 'bd hooks install --beads'.\n` +
      `  These hooks are spliced above beads' block, so beads' shim has to be there first.`,
  );
}

// -------------------------------------------------------------------- the splice

for (const hook of HOOKS) {
  const target = targetOf(hook.name);
  const before = readFileSync(target, 'utf8');
  const marker = before.indexOf(BEGIN);

  if (marker === -1) {
    // Refuse rather than clobber. An unrecognised file is someone else's.
    fail(
      `${HOOKS_PATH}/${hook.name} has no beads block (looked for '${BEGIN}'),\n` +
        `  so this script cannot tell which part is safe to replace. Refusing to overwrite.`,
    );
  }

  const shebang = before.startsWith('#!')
    ? before.slice(0, before.indexOf('\n') + 1)
    : '#!/bin/sh\n';
  // Everything from the BEGIN marker onward is beads' territory -- preserved verbatim.
  const beadsBlock = before.slice(marker);

  let gate = '';
  if (!uninstall) {
    const gateSource = join(repoRoot, hook.source);
    if (!existsSync(gateSource)) fail(`${hook.source} not found`);

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
        `${hook.source} terminates the shell above beads' block\n` +
          `  (bare exit at gate line ${String(shortCircuit + 1)}). That would make beads' hooks\n` +
          `  unreachable. Let control fall through, or use 'exit 1' to block.`,
      );
    }
  }

  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${shebang}${gate ? `${gate}\n\n` : ''}${beadsBlock}`, 'utf8');
  chmodSync(target, 0o755);
}

if (uninstall) {
  console.log(
    `[install-hooks] removed ascend's gate from ${HOOKS.map((hook) => `${HOOKS_PATH}/${hook.name}`).join(' and ')}`,
  );
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

console.log('[install-hooks] verifying the installed artifacts');

const problems = [];

/**
 * The END marker, matched as a pattern rather than a suffix: beads stamps a version into both
 * markers (`# --- END BEADS INTEGRATION v1.2.2 ---`), and a literal `endsWith()` check rejected the
 * correct artifact the first time this script ran. Compare on the marker text, ignore the version
 * stamp and any trailing dashes.
 */
const endMarker = new RegExp(`^\\s*${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');

for (const hook of HOOKS) {
  const where = `${HOOKS_PATH}/${hook.name}`;
  const after = readFileSync(targetOf(hook.name), 'utf8');

  if (!after.includes(BEGIN)) problems.push(`beads block disappeared from ${where}`);
  if (!endMarker.test(after.trimEnd())) {
    problems.push(
      `${where}: beads block has no END marker; the file is truncated or was partly overwritten`,
    );
  }

  const above = after
    .slice(0, after.indexOf(BEGIN))
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));

  if (!uninstall && !after.includes(hook.marker)) {
    problems.push(`ascend's gate is not present in ${where} (no '${hook.marker}')`);
  }
  if (above.some((line) => /^\s*exit(\s+0)?\s*$/.test(line))) {
    problems.push(`a bare 'exit' above beads' block in ${where} makes beads' hooks unreachable`);
  }
}

// The dead-path check: this is the rename regression, caught at install time. It is
// about `core.hooksPath` and not about a single hook, so it runs once -- and the rule itself lives
// in `scripts/hooks-path.mjs`, because `scripts/gate.mjs` now runs the same check before any step
// (`asc-1h3u`); two spellings of one rule is how the rule drifts.
for (const problem of checkHooksPath(repoRoot).problems) problems.push(problem);

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) console.error(`  UNVERIFIED: ${problem}`);
  fail('an artifact does not match what this script claims to have installed');
}

console.log(`  ok  ${SOURCE} = ${git('config', '--get', SOURCE)}`);
for (const hook of HOOKS) {
  const what = uninstall
    ? `no longer contains ascend's gate`
    : `contains ascend's gate above beads' block`;
  console.log(`  ok  ${HOOKS_PATH}/${hook.name} ${what}`);
}
console.log("  ok  beads' block is intact and reachable in every spliced hook");

try {
  console.log(`\n${run('bd', ['hooks', 'list'])}`);
} catch {
  console.log('\n(bd hooks list unavailable)');
}
