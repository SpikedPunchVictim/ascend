/**
 * asc-baj.1, second half: the CPU profile says 80.7% of `asc --help` is "node-internal", but that
 * bucket contains the MODULE LOADER as well as the interpreter's own boot -- so it cannot, by
 * itself, separate "Node is slow to start" from "Node is slow to load what oclif drags in". These
 * rungs do separate them, because each adds exactly one layer:
 *
 *   node -e 0                      the interpreter alone
 *   node -e import('@oclif/core')  + oclif's module graph, nothing else
 *   asc --help                     + ascend's own entry point and command manifest
 *   static --help, no oclif        asc-74a's rung: the SAME bytes written by a script that loads
 *                                  nothing, i.e. the upper bound of what "drop oclif from the help
 *                                  path" can buy. It does strictly less than a real help path would
 *                                  (no argv parsing, no formatting, no docs to render), so it is a
 *                                  FLOOR for that route, not a prediction of it.
 *
 * The gaps are the finding. Same n and same percentile treatment as EV-18's arms so the numbers
 * are comparable to the 171.414 ms already recorded on the bead.
 *
 * Extended for asc-74a (2026-09-28): the static rung above, and WARM_UP samples discarded per rung
 * before timing starts. The warm-up is what the clean-harness re-measure on the bead describes and
 * this file had been missing; without it the first samples of a rung carry the page-cache cost of
 * that rung's files, which is the largest single source of the ~30 ms spread between harnesses
 * recorded on that bead. Pass the help file as argv[3] for the static rung (default: run it live,
 * once, into /tmp, so the number is never measured against stale bytes).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bin = join(process.cwd(), 'packages/cli/dist/bin.js');
const oclif = join(process.cwd(), 'node_modules/@oclif/core/lib/index.js');
const N = Number(process.argv[2] ?? 20);
const WARM_UP = Number(process.env.WARM_UP ?? 5);

// The exact bytes `asc --help` emits, captured now rather than read from a file someone could have
// left stale -- a floor measured against old output would understate what the real path must write.
const helpPath = process.argv[3] ?? join(tmpdir(), 'asc-help-static.txt');
if (process.argv[3] === undefined) {
  writeFileSync(helpPath, execFileSync(process.execPath, [bin, '--help'], { encoding: 'buffer' }));
}
const helpBytes = readFileSync(helpPath).length;

function timed(argv) {
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: r.status, stderr: r.stderr };
}

const rungs = [
  ['node -e 0', ['-e', '0']],
  ["import('@oclif/core')", ['-e', `import(${JSON.stringify(oclif)}).then(()=>{})`]],
  ['asc --help', [bin, '--help']],
  [
    'static --help (no oclif)',
    ['-e', 'require("fs").writeSync(1, require("fs").readFileSync(process.argv[1]))', helpPath],
  ],
];

const p = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** One rung: WARM_UP discarded, then N timed, reported at p50 and p95. */
function measure(argv) {
  for (let i = 0; i < WARM_UP; i++) timed(argv);
  const runs = [];
  for (let i = 0; i < N; i++) {
    const t = timed(argv);
    if (t.status !== 0) throw new Error(`rung exited ${t.status}: ${t.stderr.slice(0, 200)}`);
    runs.push(t.ms);
  }
  return { p50: p(runs, 0.5), p95: p(runs, 0.95) };
}

console.log(`n = ${N} per rung (${WARM_UP} warm-up discarded), node ${process.version}, fresh process each time`);
console.log(`static rung writes ${helpBytes} bytes -- the size \`asc --help\` emits now\n`);

// The first three are CUMULATIVE -- each adds exactly one layer to the one above it, so the gap
// between them is the cost of that layer.
console.log('rung                      p50          p95        gap over previous (p50)');
console.log('------------------------|------------|------------|----------------------');
let prev = null;
let bare = null;
let oclifFloor = null;
for (const [label, argv] of rungs.slice(0, 3)) {
  const { p50, p95 } = measure(argv);
  if (bare === null) bare = p50;
  else if (oclifFloor === null) oclifFloor = p50;
  const gap = prev === null ? '' : `+${(p50 - prev).toFixed(3)} ms`;
  console.log(`${label.padEnd(24)}| ${p50.toFixed(3).padStart(9)} ms | ${p95.toFixed(3).padStart(9)} ms | ${gap}`);
  prev = p50;
}

// The static rung is NOT cumulative: it is a different route to the same output, measured against
// bare Node because that is what it costs above doing nothing at all.
const [staticLabel, staticArgv] = rungs[3];
const st = measure(staticArgv);
console.log(`\n${staticLabel} (a different route, not a layer)`);
console.log(
  `${staticLabel.padEnd(24)}| ${st.p50.toFixed(3).padStart(9)} ms | ${st.p95.toFixed(3).padStart(9)} ms | ` +
    `+${(st.p50 - bare).toFixed(3)} over bare node`,
);

// The two numbers this run exists to put side by side. Every help path keeps oclif or drops it; the
// first is already over the target before a line of ascend runs, the second is under it with room.
const TARGET = 100;
console.log(
  `\n  target                       ${TARGET.toFixed(3).padStart(9)} ms\n` +
    `  floor WITH oclif  (rung 2)   ${oclifFloor.toFixed(3).padStart(9)} ms   ` +
    `${(oclifFloor - TARGET).toFixed(3)} ms OVER target\n` +
    `  floor WITHOUT oclif (rung 4) ${st.p50.toFixed(3).padStart(9)} ms   ` +
    `${(TARGET - st.p50).toFixed(3)} ms UNDER target`,
);
