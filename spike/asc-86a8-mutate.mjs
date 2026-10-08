#!/usr/bin/env node
/**
 * Does each test this phase added actually FAIL when the line it names is broken?
 *
 *   node spike/asc-86a8-mutate.mjs spike/asc-86a8-mutate-spec.json
 *
 * A minimal port of grizzly's `.agents/review-feedback/scripts/mutate.mjs`, cut to ascend's shape.
 * Ascend has no server to restart and no per-mutant deploy, so the whole `target`/`restart`/`Lane`
 * axis is gone and what is left is the claim-falsifier: every mutant names ONE assertion, `find`
 * must occur exactly once, its killer must PASS on the unmutated tree first (a test that already
 * fails kills nothing), the file is mutated, and the killer must then FAIL. The file is restored
 * from the bytes read before mutating and compared by sha256.
 *
 * **Why the baseline matters more than the kill.** `scripts/test-baseline.mjs` is a floor on the
 * COUNT of tests; nothing in this repo checks whether a test would notice a change. A test that
 * passes over a mutated line is indistinguishable from one that asserts nothing, which is
 * `empirical-planning`'s "reports success wrongly" at the test layer. This is the instrument that
 * tells those two apart, and it is deliberately not in the gate: one mutation run is minutes.
 *
 * **A mutation run edits the working tree, so two things are refused rather than warned.**
 * A spec file carrying uncommitted changes is refused -- restoring it would silently revert an
 * edit that is not ours -- and a second run is refused while another holds the lock, because two
 * runs restore each other's bytes and neither would notice.
 *
 * No `build` step: the killers here drive `packages/cli/dist/bin.js`, which each test file's own
 * `beforeAll` builds with `tsc -b`, and an incremental build sees the mutant's new mtime. A killer
 * that imported `src` directly would need none either. A spec against a killer that read a
 * pre-built artifact WITHOUT rebuilding would silently report a false survivor -- that is the one
 * way to get this wrong, and it is why `build` is a field rather than an assumption.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
const LOCK = join(ROOT, '.mutate.lock');

/** The files a mutant is applied to, mapped to their original bytes, while they are mutated. */
const inFlight = new Map();
let interrupted = false;

function sh(cmd, args, cwd = ROOT) {
   return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('error', (err) => resolve({ code: 127, out: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, out }));
   });
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * How many tests actually EXECUTED, read from vitest's own summary line.
 *
 * **vitest exits 0 when no test matches `-t`, measured 2026-10-08.** So a pattern naming nothing is
 * indistinguishable from a test that ran and passed, and without this the spec's own typos would
 * be reported as SURVIVED mutants -- a finding about a test that never ran, which is the false-green
 * this harness exists to catch, sitting inside the harness. It closes the build-failure blind spot
 * for free: a file that will not compile executes no test either, and is named rather than scored.
 */
function executed(out) {
   const summary = out.split('\n').reverse().find((line) => /^\s*Tests\s/.test(line));
   if (summary === undefined) return 0;
   return [...summary.matchAll(/(\d+) (?:passed|failed)/g)].reduce(
      (sum, m) => sum + Number(m[1]),
      0,
   );
}

/**
 * One killer, alone. `vitest.failure-log.ts` is resolved relative to the repo root, so the file
 * path is given FROM the root and the process runs there -- the same trap that makes
 * `pnpm --filter <pkg> exec vitest` fail with ERR_LOAD_URL.
 */
async function runKiller(killer) {
   const { code, out } = await sh('npx', ['vitest', 'run', killer.file, '-t', killer.test]);
   return { code, out };
}

/** Refused, not warned: restoring this file would revert an edit that is not ours. */
function uncommitted(path) {
   const { stdout } = spawnSync('git', ['status', '--porcelain', '--', path], {
      cwd: ROOT,
      encoding: 'utf8',
   });
   return stdout.trim() !== '';
}

function restoreAll() {
   const restored = [];
   const failed = [];
   for (const [path, original] of inFlight) {
      try {
         writeFileSync(path, original);
         restored.push(path);
      } catch (err) {
         failed.push(`${path} (${err.code ?? err.message})`);
      }
   }
   return { restored, failed };
}

for (const signal of ['SIGINT', 'SIGTERM']) {
   process.on(signal, () => {
      if (!interrupted) {
         interrupted = true;
         console.log('\nsignal: restoring, no further mutant runs');
         const { restored, failed } = restoreAll();
         console.log(
            `  restored ${restored.length};${failed.length ? ` COULD NOT RESTORE ${failed.join(', ')}` : ''}`,
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

async function main() {
   const specPath = process.argv[2];
   if (!specPath) {
      console.error('usage: node spike/asc-86a8-mutate.mjs SPEC.json');
      return 2;
   }
   if (existsSync(LOCK)) {
      console.error(`another mutation run holds ${LOCK}; refusing to start a second one.`);
      return 1;
   }

   const spec = JSON.parse(readFileSync(join(ROOT, specPath), 'utf8'));
   if (!spec.mutants?.length) {
      console.error('the spec holds no mutants: a run that checks nothing must not pass');
      return 1;
   }

   const problems = [];
   for (const m of spec.mutants) {
      if (!m.killers?.length) problems.push(`${m.id}: NO KILLERS -- checks nothing`);
      if (m.survivor && !String(m.why ?? '').trim()) {
         problems.push(`${m.id}: an intended survivor needs its \`why\``);
      }
      if (uncommitted(m.file)) problems.push(`${m.id}: ${m.file} has uncommitted changes`);
   }
   if (problems.length) {
      console.error(`refusing to run:\n  ${problems.join('\n  ')}`);
      return 1;
   }

   writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
   const rows = [];
   let failed = 0;
   try {
      // Baselines first, over every named killer: a killer that already fails is not evidence.
      const unique = [...new Set(spec.mutants.flatMap((m) => m.killers))];
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
      if (failed) {
         console.log('\nno verdict: every named killer must run, and pass, before a mutant is applied.');
         return 1;
      }

      for (const m of spec.mutants) {
         if (interrupted) break;
         const path = join(ROOT, m.file);
         const original = readFileSync(path);
         const text = original.toString('utf8');
         const n = text.split(m.find).length - 1;
         if (n !== 1) {
            rows.push([m.id, `NOT APPLIED -- \`find\` occurs ${n} times`, '-', '-']);
            failed += 1;
            continue;
         }

         const survivors = [];
         const died = [];
         const dead = [];
         inFlight.set(path, original);
         writeFileSync(path, text.replace(m.find, () => m.replace));
         try {
            for (const killer of m.killers) {
               const { code, out } = await runKiller(killer);
               if (executed(out) === 0) {
                  dead.push(killer.test);
                  continue;
               }
               (code !== 0 ? died : survivors).push(killer.test);
            }
         } finally {
            writeFileSync(path, original);
            inFlight.delete(path);
         }

         const equal = sha(readFileSync(path)) === sha(original);
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
         rows.push([
            m.id,
            verdict,
            died.length ? String(died.length) : '-',
            [...survivors, ...dead].join(', ') || '-',
         ]);
         if (m.survivor ? died.length > 0 || dead.length > 0 : missed > 0) failed += 1;
         if (!equal) {
            rows.at(-1)[1] = `RESTORE FAILED; ${verdict}`;
            failed += 1;
         }
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
         `${failed ? 'FAILS.' : 'Every named killer killed its mutant.'}`,
   );
   return failed ? 1 : 0;
}

process.exitCode = await main();
