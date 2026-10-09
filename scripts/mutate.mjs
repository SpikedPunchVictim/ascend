#!/usr/bin/env node
/**
 * Does each test a phase added actually FAIL when the line it names is broken?
 *
 *   node scripts/mutate.mjs <spec> [--allow-dirty]
 *
 * WHY THIS EXISTS. `README.md` states the invariant this repo holds itself to -- "Every assertion is
 * mutation-tested. A check must be shown to *fail* before it is trusted to pass" -- and until this
 * script landed, no command satisfied it. What satisfied it was a hand-run ritual, performed at least
 * five separate times and re-described in prose each time: `IMPLEMENTATION_PLAN.md` records seven
 * mutations with `shasum`-verified restores, then six, then thirteen, and `docs/evidence/EV-37.md`
 * describes the method exactly -- "replace one exact string in a source file, run the one owning test
 * file, and restore the file from a copy; the restore is checked by `shasum`, not by trusting it."
 * This is that discipline written down once instead of re-derived every time.
 *
 * THE CLAIM-FALSIFIER. A mutant names ONE assertion. `find` must occur exactly once in the target,
 * every killer it names must PASS on the unmutated tree first -- a test that already fails kills
 * nothing -- the file is then mutated, and every killer must FAIL. The file is restored from the bytes
 * read before mutating and compared by sha256, because a mutant left in the tree would be reported as
 * a kill it did not earn, and would silently poison every later run.
 *
 * WHY THE BASELINE MATTERS MORE THAN THE KILL. `scripts/test-baseline.mjs` is a floor on the COUNT of
 * tests; nothing in this repo otherwise checks whether a test would NOTICE a change. A test that
 * passes over a mutated line is indistinguishable from one that asserts nothing, which is
 * `empirical-planning`'s "reports success wrongly" at the test layer. This is the instrument that tells
 * those two apart, and it is deliberately not in the gate: one mutation run is minutes.
 *
 * A RUN EDITS THE WORKING TREE, so two things are refused rather than warned. A spec whose target file
 * has uncommitted changes is refused, because restoring it would silently revert an edit that is not
 * ours; `--allow-dirty` overrides that, prints every path it may revert before the first mutant runs,
 * and is the only way to mutate work that is not yet committed. A second run is refused while another
 * holds the lock, because two runs restore each other's bytes and neither would notice.
 *
 * Usage:
 *   node scripts/mutate.mjs <spec> [--allow-dirty]
 *
 *   <spec> is a path, or a bare name resolved under scripts/mutations/ as `<name>.json`.
 *
 * Exit codes: 0 every named killer killed its mutant; 1 a survivor, a dead killer, or a failed
 * restore; 2 usage error; 130 on SIGINT.
 *
 * A minimal port of grizzly's `.agents/review-feedback/scripts/mutate.mjs`, cut to ascend's shape:
 * there is no server to restart and no per-mutant deploy, so the whole `target`/`restart`/`Lane` axis
 * is gone and what is left is the claim-falsifier.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SPECS_DIR = 'scripts/mutations';
const LOCK = join(repoRoot, SPECS_DIR, '.lock');

/**
 * @typedef {object} Killer
 * @property {string} file  Test file, from the repo root.
 * @property {string} test  The one test name that must notice this mutant.
 */

/**
 * @typedef {object} Mutant
 * @property {string} id
 * @property {string} file     Source file to mutate, from the repo root.
 * @property {string} find     Must occur EXACTLY once in `file`.
 * @property {string} replace
 * @property {Killer[]} killers
 * @property {boolean} [survivor]  An equivalent mutant that no test can kill, and should not.
 * @property {string} [why]        Required with `survivor`, for the same reason.
 */

/**
 * The files a mutant is applied to, mapped to their original bytes, while they are mutated.
 *
 * @type {Map<string, Buffer>}
 */
const inFlight = new Map();
let interrupted = false;

// ------------------------------------------------------------------ pure decisions
//
// Everything below this line to the next banner is a decision, not an effect: it takes values and
// returns values, so `scripts/mutate-core.test.ts` can hold it to account without running a suite.
// The runner is the instrument every other test's credibility rests on, so the corners where it could
// report a green it did not earn are the corners that must be tested.

/**
 * Narrow an unknown to a plain object, or `undefined` when it is not one.
 *
 * `JSON.parse` returns `any`, so every field of a spec is unknown until something proves otherwise.
 * This is that proof, and it is the reason the validators below take `unknown` rather than a type.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
export function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * How many tests actually EXECUTED, read from vitest's own summary line.
 *
 * **vitest exits 0 when no test matches `-t`, measured 2026-10-08.** So a pattern naming nothing is
 * indistinguishable from a test that ran and passed, and without this the spec's own typos would be
 * reported as SURVIVED mutants -- a finding about a test that never ran, which is the false-green this
 * harness exists to catch, sitting inside the harness. It closes the build-failure blind spot for
 * free: a file that will not compile executes no test either, and is named rather than scored.
 *
 * @param {string} output  A killer run's combined stdout and stderr.
 * @returns {number}
 */
export function executed(output) {
  const summary = output
    .split('\n')
    .reverse()
    .find((line) => /^\s*Tests\s/.test(line));
  if (summary === undefined) return 0;
  return [...summary.matchAll(/(\d+) (?:passed|failed)/g)].reduce(
    (sum, m) => sum + Number(m[1]),
    0,
  );
}

/**
 * Where a spec argument points. A bare name is a shorthand for `scripts/mutations/<name>.json`.
 *
 * @param {string} arg
 * @returns {string}
 */
export function resolveSpecPath(arg) {
  return arg.includes('/') || arg.endsWith('.json')
    ? resolve(repoRoot, arg)
    : join(repoRoot, SPECS_DIR, `${arg}.json`);
}

/**
 * The spec argument and the one flag that relaxes the dirty-file guard.
 *
 * @param {readonly string[]} argv
 * @returns {{ spec: string, allowDirty: boolean } | { problem: string, usage: string }}
 */
export function parseArgs(argv) {
  const usage = 'usage: node scripts/mutate.mjs <spec> [--allow-dirty]';
  const allowDirty = argv.includes('--allow-dirty');
  const positional = argv.filter((arg) => arg !== '--allow-dirty');
  const spec = positional[0];
  if (spec === undefined || spec.startsWith('-')) return { problem: 'no spec given', usage };
  const [extra] = positional.slice(1).filter((arg) => arg.startsWith('-'));
  if (extra !== undefined) return { problem: `unknown flag ${extra}`, usage };
  return { spec, allowDirty };
}

/**
 * Every reason a spec cannot be trusted, in the order a reader would want them.
 *
 * A run that checks nothing must never pass, so an empty spec is a problem rather than a no-op, and
 * each mutant is checked for the properties the run depends on: a file to mutate, an anchor to
 * replace, and at least one killer. An intended survivor without its `why` is refused, because the
 * whole value of declaring one is the sentence saying why no test can kill it.
 *
 * `isDirty` is injected rather than read here so this stays a decision: the CLI passes a `git status`
 * probe, and `--allow-dirty` passes a function that answers `false` for everything.
 *
 * @param {unknown} raw  A parsed spec, unvalidated.
 * @param {(path: string) => boolean} isDirty
 * @returns {string[]}
 */
export function validateSpec(raw, isDirty) {
  const spec = asRecord(raw);
  const mutants = spec?.['mutants'];
  if (!Array.isArray(mutants) || mutants.length === 0) {
    return ['the spec holds no mutants: a run that checks nothing must not pass'];
  }

  /** @type {string[]} */
  const problems = [];
  for (const entry of mutants) {
    const m = asRecord(entry);
    if (m === undefined) {
      problems.push('a mutant is not an object');
      continue;
    }
    const id = typeof m['id'] === 'string' && m['id'] !== '' ? m['id'] : '(no id)';
    const killers = m['killers'];
    if (!Array.isArray(killers) || killers.length === 0) {
      problems.push(`${id}: NO KILLERS -- checks nothing`);
    }
    const why = m['why'];
    if (m['survivor'] === true && !(typeof why === 'string' && why.trim() !== '')) {
      problems.push(`${id}: an intended survivor needs its \`why\``);
    }
    const file = m['file'];
    if (typeof file !== 'string' || file === '')
      problems.push(`${id}: NO FILE -- nothing to mutate`);
    else if (isDirty(file)) problems.push(`${id}: ${file} has uncommitted changes`);
  }
  return problems;
}

/**
 * Apply one mutant to `text`, or refuse because the anchor is not unique.
 *
 * The anchor is the whole safety mechanism: a `find` occurring zero times mutates nothing and would be
 * scored as a kill the mutant never earned, and one occurring twice would mutate a line the spec did
 * not name. Both are refused rather than warned.
 *
 * @param {string} text
 * @param {Mutant} mutant
 * @returns {{ ok: true, text: string } | { ok: false, why: string }}
 */
export function applyMutant(text, mutant) {
  const n = text.split(mutant.find).length - 1;
  if (n !== 1) return { ok: false, why: `\`find\` occurs ${String(n)} times` };
  return { ok: true, text: text.replace(mutant.find, () => mutant.replace) };
}

// ----------------------------------------------------------------------- the shell
//
// Below here is effect: spawning vitest, writing the working tree, holding the lock. The decisions
// above are the part worth testing, and they are tested.

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
 * @param {string} cmd
 * @param {readonly string[]} args
 * @returns {Promise<{ code: number, out: string }>}
 */
function sh(cmd, args) {
  return new Promise((settle) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', (error) => {
      settle({ code: 127, out: error.message });
    });
    child.on('close', (code) => {
      settle({ code: code ?? 1, out });
    });
  });
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * One killer, alone. `vitest.config.ts` is resolved relative to the repo root, so the file path is
 * given FROM the root and the process runs there -- the same trap that makes
 * `pnpm --filter <pkg> exec vitest` fail with ERR_LOAD_URL.
 *
 * @param {Killer} killer
 * @returns {Promise<{ code: number, out: string }>}
 */
function runKiller(killer) {
  return sh('npx', ['vitest', 'run', killer.file, '-t', killer.test]);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function uncommitted(path) {
  const { stdout } = spawnSync('git', ['status', '--porcelain', '--', path], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return stdout.trim() !== '';
}

/**
 * Restore every file this run touched, and say which ones could not be put back.
 *
 * @returns {{ restored: string[], failed: string[] }}
 */
function restoreAll() {
  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const failed = [];
  for (const [path, original] of inFlight) {
    try {
      writeFileSync(path, original);
      restored.push(path);
    } catch (error) {
      failed.push(`${path} (${detail(error)})`);
    }
  }
  return { restored, failed };
}

/**
 * Restore on the way out, however the run ends.
 *
 * Registered from `main` rather than at module scope on purpose: this module is IMPORTED by
 * `scripts/mutate-core.test.ts`, and a signal handler installed on import would let a Ctrl+C sent to
 * the test runner exit the whole run from inside a worker.
 */
function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!interrupted) {
        interrupted = true;
        console.log('\nsignal: restoring, no further mutant runs');
        const { restored, failed } = restoreAll();
        console.log(
          `  restored ${String(restored.length)};${failed.length > 0 ? ` COULD NOT RESTORE ${failed.join(', ')}` : ''}`,
        );
        try {
          unlinkSync(LOCK);
        } catch {
          /* the lock is best-effort on the way out */
        }
        process.exit(130);
      }
    });
  }
}

/**
 * The killers a run has to baseline, each once.
 *
 * Keyed by file and test name rather than collected into a `Set`: every killer in the spec is a
 * distinct object off `JSON.parse`, so a `Set` would hold two copies of the same killer and run its
 * baseline twice -- once per mutant that names it.
 *
 * @param {readonly Mutant[]} mutants
 * @returns {Killer[]}
 */
function uniqueKillers(mutants) {
  /** @type {Map<string, Killer>} */
  const byName = new Map();
  for (const m of mutants) {
    for (const killer of m.killers) byName.set(`${killer.file}\u0000${killer.test}`, killer);
  }
  return [...byName.values()];
}

/**
 * Every named killer must run AND pass on the unmutated tree before a single mutant is applied --
 * "a test that already fails kills nothing". Returns the count of problems, and a non-zero return
 * means no verdict is issued at all.
 *
 * @param {readonly Killer[]} unique
 * @returns {Promise<number>}
 */
async function runBaselines(unique) {
  let failed = 0;
  for (const killer of unique) {
    const { code, out } = await runKiller(killer);
    if (executed(out) === 0) {
      console.log(`DEAD KILLER  "${killer.test}" matched no test, so it is no one's evidence`);
      failed += 1;
    } else if (code !== 0) {
      console.log(`BASELINE  "${killer.test}" fails on the unmutated tree -- kills nothing`);
      failed += 1;
    }
  }
  return failed;
}

/**
 * One mutant: apply it, run every killer it names, restore the file, and judge the result.
 *
 * @param {Mutant} m
 * @returns {Promise<{ row: string[], failed: boolean }>}
 */
async function runMutant(m) {
  const path = join(repoRoot, m.file);
  const original = readFileSync(path);
  const applied = applyMutant(original.toString('utf8'), m);
  if (!applied.ok) {
    return { row: [m.id, `NOT APPLIED -- ${applied.why}`, '-', '-'], failed: true };
  }

  const survivors = [];
  const died = [];
  const dead = [];
  inFlight.set(path, original);
  writeFileSync(path, applied.text);
  try {
    for (const killer of m.killers) {
      const { code, out } = await runKiller(killer);
      if (executed(out) === 0) dead.push(killer.test);
      else if (code !== 0) died.push(killer.test);
      else survivors.push(killer.test);
    }
  } finally {
    writeFileSync(path, original);
    inFlight.delete(path);
  }

  const verdict = dead.length
    ? 'DEAD KILLER -- matched no test'
    : m.survivor
      ? died.length
        ? 'intended survivor KILLED'
        : 'intended survivor -- held'
      : survivors.length
        ? 'SURVIVED a named killer'
        : 'killed by every named killer';
  const missed = survivors.length || dead.length;
  // Restore is verified by sha256 rather than trusted: a mutant left in the tree would be reported as
  // a kill it did not earn, and would silently poison every later run.
  const restored = sha(readFileSync(path)) === sha(original);
  return {
    row: [
      m.id,
      restored ? verdict : `RESTORE FAILED; ${verdict}`,
      died.length ? String(died.length) : '-',
      [...survivors, ...dead].join(', ') || '-',
    ],
    failed: (m.survivor ? died.length > 0 || dead.length > 0 : missed > 0) || !restored,
  };
}

/**
 * Which spec target files are dirty, so `--allow-dirty` can say exactly what it may revert.
 *
 * @param {Mutant[]} mutants
 * @returns {string[]}
 */
function dirtyTargets(mutants) {
  return [...new Set(mutants.map((m) => m.file))].filter((file) => uncommitted(file));
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const parsed = parseArgs(argv);
  if ('problem' in parsed) {
    console.error(`\n  ${parsed.problem}\n  ${parsed.usage}\n`);
    return 2;
  }

  const specPath = resolveSpecPath(parsed.spec);
  if (!existsSync(specPath)) refuse(`no spec at ${specPath}`);
  if (existsSync(LOCK)) {
    refuse(`another run holds ${LOCK}; refusing to start a second one.`);
  }

  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    refuse(`could not read ${specPath}: ${detail(error)}`);
  }

  // `--allow-dirty` answers "nothing is dirty" rather than skipping validation, so every other
  // property of the spec is still checked.
  const problems = validateSpec(raw, parsed.allowDirty ? () => false : uncommitted);
  if (problems.length > 0) {
    console.error(`refusing to run:\n  ${problems.join('\n  ')}`);
    if (!parsed.allowDirty) {
      console.error('\n  Pass --allow-dirty to mutate files with uncommitted changes anyway.');
    }
    return 1;
  }

  const mutants = /** @type {Mutant[]} */ (/** @type {Record<string, unknown>} */ (raw)['mutants']);

  if (parsed.allowDirty) {
    const dirty = dirtyTargets(mutants);
    if (dirty.length > 0) {
      // Named, and named BEFORE the first mutant runs: these bytes are restored at the end of each
      // mutant, so an edit made during the run is lost, and only saying so up front makes that
      // something the caller chose rather than something that happened to them.
      console.error(
        `--allow-dirty: these files have uncommitted changes and will be RESTORED from the bytes\n` +
          `  read now. An edit made while this runs is lost.\n  ${dirty.join('\n  ')}`,
      );
    }
  }

  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  installSignalHandlers();
  /** @type {string[][]} */
  const rows = [];
  let failed = 0;
  try {
    // Baselines first, over every named killer: a killer that already fails is not evidence.
    failed = await runBaselines(uniqueKillers(mutants));
    if (failed > 0) {
      console.log(
        '\nno verdict: every named killer must run, and pass, before a mutant is applied.',
      );
      return 1;
    }

    for (const m of mutants) {
      if (interrupted) break;
      const result = await runMutant(m);
      rows.push(result.row);
      if (result.failed) failed += 1;
    }
  } finally {
    restoreAll();
    try {
      unlinkSync(LOCK);
    } catch {
      /* already gone */
    }
  }

  console.log('\n| id | verdict | killers that died | survivors |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log(
    `\n${String(rows.length)} mutant(s), ${String(failed)} problem(s). ` +
      (failed > 0 ? 'FAILS.' : 'Every named killer killed its mutant.'),
  );
  return failed > 0 ? 1 : 0;
}

// The guard is what lets `scripts/mutate-core.test.ts` import the decisions above without running a
// suite. Under Vitest the entry module is the test file, so this is false there and true when the
// runner is the thing Node was asked to run.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
