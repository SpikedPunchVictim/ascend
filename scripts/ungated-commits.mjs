/**
 * Which commits on this checkout no gate run has judged.
 *
 * THE QUESTION THIS ANSWERS. `but commit` does not run the pre-commit hook, so a commit can exist
 * that no gate ever read (`asc-rzhr`, `dogfood/0095`). Before `scripts/gate-coverage.mjs` existed the
 * run record could not answer "was this commit gated?" at all: a row named the checkout's HEAD, which
 * a `but commit` never is. Now every row records the two trees the run read, and this script compares
 * commits against them.
 *
 * WHAT IT IS NOT. It is not a gate and it blocks nothing. `--warn` exists so the pre-push hook can
 * print the list without being able to fail a push: enforcement is `asc-n0if`, and it needs the
 * numbers this prints first.
 *
 * THE DEFAULT RANGE IS EVERY LOCAL COMMIT ABOVE THE MERGE-BASE, not `--branches --not --remotes`.
 * The narrower range hides commits that were already pushed, and those are exactly as ungated as the
 * ones that were not; the question is about the gate, not about the remote.
 *
 * Usage:
 *   node scripts/ungated-commits.mjs                 # every local commit above origin/main
 *   node scripts/ungated-commits.mjs --range A..B    # a range, as git rev-list takes it
 *   node scripts/ungated-commits.mjs --warn          # always exit 0 (the pre-push hook)
 *   node scripts/ungated-commits.mjs --json          # the same answer, for a reader
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_PATH } from './gate-log.mjs';
import { parseRows, ungated } from './gate-coverage.mjs';

const USAGE =
  'usage: node scripts/ungated-commits.mjs [--range A..B] [--warn] [--json] [--limit N]';

/**
 * @param {readonly string[]} args
 * @returns {string[] | null}
 */
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.split('\n').filter((line) => line !== '');
}

/**
 * The commits to ask about, and what the range was, so the report can say what it looked at.
 *
 * @param {string | undefined} range
 * @returns {{ shas: string[], label: string }}
 */
function commitsFor(range) {
  if (range !== undefined) {
    return { shas: git(['rev-list', range]) ?? [], label: range };
  }
  const base = git(['merge-base', 'HEAD', 'origin/main']);
  if (base !== null && base[0] !== undefined) {
    return {
      shas: git(['rev-list', '--branches', '--not', base[0]]) ?? [],
      label: `every local commit above ${base[0].slice(0, 7)}`,
    };
  }
  // A checkout with no origin/main is still worth asking: the fallback is narrower, and the label
  // says which question was actually answered rather than claiming the default.
  return {
    shas: git(['rev-list', '--branches', '--not', '--remotes']) ?? [],
    label: 'every local commit not on a remote (origin/main could not be resolved)',
  };
}

/**
 * @param {string[]} argv
 */
function main(argv) {
  let range;
  let warn = false;
  let json = false;
  let limit = 50;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--range') {
      range = argv[index + 1];
      index += 1;
    } else if (arg === '--warn') {
      warn = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      limit = Number(argv[index + 1] ?? limit);
      index += 1;
    } else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const root = process.cwd();
  let text = '';
  try {
    text = readFileSync(join(root, LOG_PATH), 'utf8');
  } catch {
    // No log is a real answer: nothing has been gated here, and the report says so.
  }
  const rows = parseRows(text);

  const { shas, label } = commitsFor(range);
  const report = ungated(rows, { root, shas });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { range: label, judged: shas.length, rows: rows.length, ...report },
        null,
        2,
      )}\n`,
    );
  } else {
    const total = report.covered.length + report.uncovered.length + report.skipped.length;
    const merges = report.skipped.length;
    process.stdout.write(
      `ungated: ${String(report.uncovered.length)} of ${String(total)} commit(s) have no gate run ` +
        `covering their content (${label}); ${String(merges)} not asked\n`,
    );
    for (const entry of report.uncovered.slice(0, limit)) {
      const subject = git(['log', '-1', '--format=%s', entry.sha])?.[0] ?? '';
      process.stdout.write(`  ${entry.sha.slice(0, 7)}  ${subject}\n`);
      process.stdout.write(`          ${entry.why}\n`);
    }
    if (report.uncovered.length > limit) {
      process.stdout.write(`  ... and ${String(report.uncovered.length - limit)} more\n`);
    }
    for (const entry of report.skipped) {
      process.stdout.write(`  (not asked) ${entry.sha.slice(0, 7)}  ${entry.why}\n`);
    }
  }

  if (report.uncovered.length > 0 && !warn) process.exitCode = 1;
}

main(process.argv.slice(2));
