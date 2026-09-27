/**
 * asc-gtnu.8 Stage 1: apply each seed ALONE to a clean tree, and MEASURE whether it breaks a
 * committed test -- `breaksCommittedTest` is never asserted by the author.
 *
 * WHERE THE MUTANT LIVES. Never in this repository. Every seed is applied inside a tree built by
 * `trees.mjs` under the OS temp root, so the repo's `packages/core/dist` can never hold a mutant
 * build and restore is a string write of the original, verified by sha256 after every seed. That
 * sidesteps the stale-mutant-build hazard (`IMPLEMENTATION_PLAN.md:936-940`) rather than managing it.
 *
 * THREE OUTCOMES, NOT TWO (`IMPLEMENTATION_PLAN.md:462-472`):
 *   - `true`  -- vitest ran tests and at least one NAMED assertion failed;
 *   - `false` -- vitest ran a nonzero number of tests and none failed;
 *   - `null`  -- unverified: the mutant did not compile, or zero tests ran. Never counted as caught.
 * The control seed runs first and must come back `false` with a nonzero count, or nothing after
 * it is trusted -- a filter that matched nothing would otherwise look exactly like a pass.
 *
 * `--check` rewrites `seeds.json` in place with the measured fields and the subject's sha256.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTree, recallEnv, REPO, SUBJECT, SUBJECT_TEST } from './trees.mjs';

const SEEDS = join(REPO, 'spike', 'recall', 'seeds.json');
/** Seeds of one class must sit this far apart: 2R + 1 with R = 3 (PREREG section 3). */
export const MIN_GAP = 7;

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** Apply edits to the ORIGINAL line array, so an edit that inserts a newline shifts nothing. */
export function applyEdits(source, edits) {
  const lines = source.split('\n');
  for (const edit of edits) {
    const text = lines[edit.line - 1];
    if (text === undefined) throw new Error(`line ${String(edit.line)} does not exist`);
    const count = text.split(edit.before).length - 1;
    if (count !== 1) {
      throw new Error(`line ${String(edit.line)}: "${edit.before}" occurs ${String(count)} times, expected 1`);
    }
    lines[edit.line - 1] = text.replace(edit.before, edit.after);
  }
  return lines.join('\n');
}

function measure(dir, cache) {
  const tsc = spawnSync('npx', ['tsc', '-p', 'packages/core', '--noEmit'], {
    cwd: dir,
    env: recallEnv(cache),
    encoding: 'utf8',
  });
  if (tsc.status !== 0) {
    return { compiles: false, testsRun: 0, failingTests: [], tscError: (tsc.stdout + tsc.stderr).slice(0, 400) };
  }
  const report = join(cache, 'vitest.json');
  spawnSync('npx', ['vitest', 'run', SUBJECT_TEST, '--reporter=json', `--outputFile=${report}`], {
    cwd: dir,
    env: recallEnv(cache),
    encoding: 'utf8',
    timeout: 180_000,
  });
  let json;
  try {
    json = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    return { compiles: true, testsRun: 0, failingTests: [], reportMissing: true };
  }
  const failing = json.testResults
    .flatMap((file) => file.assertionResults)
    .filter((a) => a.status === 'failed')
    .map((a) => a.fullName);
  return {
    compiles: true,
    testsRun: json.numPassedTests + json.numFailedTests,
    failingTests: failing,
  };
}

function verdict(m) {
  if (!m.compiles || m.testsRun === 0) return null;
  return m.failingTests.length > 0;
}

if (process.argv.includes('--check')) {
  const doc = JSON.parse(readFileSync(SEEDS, 'utf8'));
  const tree = buildTree({ runnable: true });
  const path = join(tree.dir, SUBJECT);
  const original = readFileSync(path, 'utf8');
  if (original !== readFileSync(join(REPO, SUBJECT), 'utf8')) throw new Error('tree subject differs from repo');
  const originalSha = sha(original);
  const cache = mkdtempSync(join(tmpdir(), 'rv-cache-'));

  const restore = () => {
    writeFileSync(path, original);
    if (sha(readFileSync(path, 'utf8')) !== originalSha) throw new Error('restore failed: sha mismatch');
  };

  // The unmutated baseline and the control, before any seed is trusted.
  const baseline = measure(tree.dir, cache);
  writeFileSync(path, applyEdits(original, doc.control.edits));
  const control = measure(tree.dir, cache);
  restore();
  console.error(`baseline: ${JSON.stringify(baseline)}\ncontrol: ${JSON.stringify(control)}`);
  if (verdict(baseline) !== false || verdict(control) !== false || control.testsRun !== baseline.testsRun) {
    throw new Error('baseline or control is not a clean pass with the same nonzero test count; nothing after it can be trusted');
  }

  for (const seed of doc.seeds) {
    writeFileSync(path, applyEdits(original, seed.edits));
    const m = measure(tree.dir, cache);
    restore();
    seed.compiles = m.compiles;
    seed.testsRun = m.testsRun;
    seed.breaksCommittedTest = verdict(m);
    seed.failingTests = m.failingTests;
    if (m.tscError) seed.tscError = m.tscError;
    console.error(`${seed.id} compiles=${String(m.compiles)} run=${String(m.testsRun)} breaks=${String(seed.breaksCommittedTest)} failing=${String(m.failingTests.length)}`);
  }

  // Per class: spacing, and the whole class applied together still compiles.
  const classes = {};
  for (const cls of Object.keys(doc.lenses)) {
    const seeds = doc.seeds.filter((s) => s.class === cls);
    const lines = seeds.flatMap((s) => s.edits.map((e) => ({ id: s.id, line: e.line }))).sort((a, b) => a.line - b.line);
    const tooClose = [];
    for (let i = 1; i < lines.length; i += 1) {
      const a = lines[i - 1];
      const b = lines[i];
      if (a.id !== b.id && b.line - a.line < MIN_GAP) tooClose.push(`${a.id}@${String(a.line)}/${b.id}@${String(b.line)}`);
    }
    writeFileSync(path, applyEdits(original, seeds.flatMap((s) => s.edits)));
    const together = measure(tree.dir, cache);
    restore();
    classes[cls] = {
      n: seeds.length,
      tooClose,
      togetherCompiles: together.compiles,
      breaking: seeds.filter((s) => s.breaksCommittedTest === true).length,
      surviving: seeds.filter((s) => s.breaksCommittedTest === false).length,
      unverified: seeds.filter((s) => s.breaksCommittedTest === null).length,
    };
  }
  doc.subjectSha256 = originalSha;
  doc.measured = { at: new Date().toISOString(), baselineTests: baseline.testsRun, control: verdict(control), classes };
  writeFileSync(SEEDS, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(JSON.stringify(doc.measured, null, 2));
}
