#!/usr/bin/env node
/**
 * The test-count baseline: does the suite still collect what it used to? (asc-049w)
 *
 * WHY THIS EXISTS. `dogfood/0061` is a green gate over a file whose 55 tests had become 5. The gate
 * runs the whole suite and prints `Tests 3036 passed | 2 skipped (3038)`; nothing compared that to
 * anything, so a deleted test and a passing test were the same word in the gate's output. This is
 * the comparison. It reads `.testcount/scan.json`, written by `vitest.test-count.ts` during the run
 * that just finished, and refuses when a count has fallen below `.testcount/baseline.json`.
 *
 * THE COUNT COMES FROM THE RUNNER. Not from `grep -c "it("`, which `dogfood/0061` measured to be
 * wrong twice (it misses `it.each` expansion and a double-quoted name) and wrong in the direction
 * the check exists to detect.
 *
 * FLOORS, NOT EQUALITY. The acceptance is "drops below a baseline", so growth is never a failure and
 * is never a nag. Equality would red the gate on every test added anywhere, and the record already
 * names where that ends: *"a baseline becomes a number people edit until it stops complaining."*
 * The cost of a floor is drift -- a file that grows keeps an old, low floor -- and the answer is to
 * print the headroom on every green run so a lagging baseline is visible where it would be looked
 * for, not to make the check rewrite a tracked file mid-commit.
 *
 * TWO EXIT CODES, BECAUSE "I COULD NOT CHECK" IS NOT "I CHECKED AND IT IS FINE". Exit 2 means an
 * input was missing or unreadable, so nothing was compared; exit 1 means a floor was breached. The
 * same distinction the store guard's `exit 2` was chosen for (EV-hooks Q4): a guard that cannot find
 * its own input must not read like a guard that looked and found nothing.
 *
 * Usage:
 *   node scripts/test-baseline.mjs [check] [--baseline <path>] [--scan <path>]
 *   node scripts/test-baseline.mjs update  [--baseline <path>] [--scan <path>]
 *
 * `--baseline` and `--scan` exist so the comparison can be driven over fixtures. They default to the
 * real paths, which also means this script makes no assumption about the caller's cwd.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @typedef {object} Counts
 * @property {number} files  How many test files the run collected.
 * @property {number} tests  How many tests it collected -- the acceptance's own word.
 * @property {number} passed How many of them passed, which is what a `it.skip` does not move.
 * @property {Record<string, number>} byFile  Collected tests per file. The floors that can name a file.
 */

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function pathArg(name, fallback) {
  const at = process.argv.indexOf(name);
  const given = at === -1 ? undefined : process.argv[at + 1];
  return resolve(repoRoot, given ?? fallback);
}

/**
 * A thrown value is `unknown`, not an Error.
 *
 * @param {unknown} error
 * @returns {string}
 */
const detail = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {string} message
 * @returns {never}
 */
function refuse(message) {
  console.error(`\n  CANNOT CHECK: ${message}\n`);
  process.exit(2);
}

/**
 * @param {unknown} value
 * @returns {Counts}
 */
function asCounts(value) {
  if (typeof value !== 'object' || value === null) throw new Error('not a JSON object');
  const { files, tests, passed, byFile } = /** @type {Record<string, unknown>} */ (value);
  for (const [name, field] of /** @type {[string, unknown][]} */ ([
    ['files', files],
    ['tests', tests],
    ['passed', passed],
  ])) {
    if (typeof field !== 'number') throw new Error(`'${name}' is not a number`);
  }
  if (typeof byFile !== 'object' || byFile === null || Array.isArray(byFile)) {
    throw new Error("'byFile' is not an object");
  }
  /** @type {Record<string, number>} */
  const perFile = {};
  for (const [file, count] of Object.entries(byFile)) {
    if (typeof count !== 'number') throw new Error(`byFile['${file}'] is not a number`);
    perFile[file] = count;
  }
  return {
    files: /** @type {number} */ (files),
    tests: /** @type {number} */ (tests),
    passed: /** @type {number} */ (passed),
    byFile: perFile,
  };
}

/**
 * @param {string} path
 * @param {string} what
 * @returns {Counts}
 */
function load(path, what) {
  if (!existsSync(path)) {
    refuse(
      `no ${what} at ${path}.\n` +
        (what === 'scan'
          ? `  The scan is written by 'vitest.test-count.ts' on every run, so its absence means the\n` +
            `  suite did not record a count. Run 'pnpm test' (or the gate) and try again.`
          : `  Create it with 'pnpm test:baseline', which runs the full suite first and cannot\n` +
            `  therefore be taken from a partial run.`),
    );
  }
  try {
    return asCounts(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    refuse(`${what} at ${path} is not a readable set of counts: ${detail(error)}`);
  }
}

const baselinePath = pathArg('--baseline', '.testcount/baseline.json');
const scanPath = pathArg('--scan', '.testcount/scan.json');
const action = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'check';

/**
 * The terse one-line movement, in `align`'s shape: what it is, what it was, how far.
 *
 * @param {Counts} scan
 * @param {Counts} baseline
 * @param {string} suffix
 * @returns {string}
 */
function movement(scan, baseline, suffix) {
  return (
    `test count: ${String(scan.tests)} collected / ${String(scan.passed)} passed in ` +
    `${String(scan.files)} files -- baseline ${String(baseline.tests)} / ${String(baseline.passed)}` +
    suffix
  );
}

/** @param {Counts} scan @param {Counts} baseline */
function check(scan, baseline) {
  /** @type {string[]} */
  const drops = [];

  for (const [file, floor] of Object.entries(baseline.byFile)) {
    const now = scan.byFile[file] ?? 0;
    if (now >= floor) continue;
    const verb = file in scan.byFile ? 'SHRANK' : 'GONE  ';
    drops.push(`  ${verb}  ${file}  ${String(floor)} -> ${String(now)} (${String(now - floor)})`);
  }

  if (scan.tests < baseline.tests) {
    drops.push(
      `  BELOW   collected tests  ${String(baseline.tests)} -> ${String(scan.tests)} ` +
        `(${String(scan.tests - baseline.tests)})`,
    );
  }
  if (scan.passed < baseline.passed) {
    drops.push(
      `  BELOW   passed tests  ${String(baseline.passed)} -> ${String(scan.passed)} ` +
        `(${String(scan.passed - baseline.passed)}) -- a test skipped or gone, not necessarily deleted`,
    );
  }

  if (drops.length === 0) {
    const raised = scan.tests - baseline.tests;
    console.log(movement(scan, baseline, `, ${String(raised)} above baseline`));
    return;
  }

  console.error(
    movement(scan, baseline, `, ${String(baseline.tests - scan.tests)} BELOW baseline`),
  );
  for (const drop of drops) console.error(drop);
  console.error(
    `\n  A test count fell below the baseline carried in .testcount/baseline.json.\n` +
      `  If the removal was intentional, run 'pnpm test:baseline' and commit the updated\n` +
      `  baseline in the SAME commit, so the removal is visible in the diff rather than silent.`,
  );
  process.exit(1);
}

/** @param {Counts} scan @param {Counts | null} before */
function update(scan, before) {
  const next = { at: new Date().toISOString(), ...scan };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  if (before === null) {
    console.log(
      `test baseline created: ${String(scan.files)} files / ${String(scan.tests)} collected / ${String(scan.passed)} passed`,
    );
    return;
  }

  console.log(
    `test baseline: ${String(before.files)} files / ${String(before.tests)} collected / ` +
      `${String(before.passed)} passed -> ${String(scan.files)} files / ${String(scan.tests)} collected / ` +
      `${String(scan.passed)} passed`,
  );
  const paths = new Set([...Object.keys(before.byFile), ...Object.keys(scan.byFile)]);
  for (const file of [...paths].sort()) {
    const was = before.byFile[file];
    const now = scan.byFile[file];
    if (was === now) continue;
    if (was === undefined) console.log(`  ADDED    ${file}  ${String(now)}`);
    else if (now === undefined) console.log(`  REMOVED  ${file}  ${String(was)}`);
    else
      console.log(
        `  ${now > was ? 'RAISED ' : 'LOWERED'}  ${file}  ${String(was)} -> ${String(now)}`,
      );
  }
}

if (action === 'check') {
  check(load(scanPath, 'scan'), load(baselinePath, 'baseline'));
} else if (action === 'update') {
  const scan = load(scanPath, 'scan');
  update(scan, existsSync(baselinePath) ? load(baselinePath, 'baseline') : null);
} else {
  refuse(`unknown action '${action}'; expected 'check' or 'update'`);
}
