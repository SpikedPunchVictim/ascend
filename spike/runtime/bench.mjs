// EV-6 measurement harness.
//
// Cold start means a FRESH process per sample, so every timing here spawns
// `node` and measures wall clock. n=50 per arm; p50/p95 reported.

import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';

const N = Number(process.argv[2] ?? 50);
const ROOT = 'spike/runtime';
mkdirSync(`${ROOT}/tmp`, { recursive: true });

function timeArm(label, file, argvFor) {
  const samples = [];
  for (let i = 0; i < N; i++) {
    const db = `${ROOT}/tmp/${label.replace(/\W/g, '_')}.db`;
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [file, ...argvFor(db)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      console.log(`  !! ${label} failed on sample ${i}: ${r.stderr.toString().split('\n').slice(0, 3).join(' | ')}`);
      break;
    }
    samples.push(ms);
    rmSync(db, { force: true });
    rmSync(`${db}-wal`, { force: true });
    rmSync(`${db}-shm`, { force: true });
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return { label, n: samples.length, min: samples[0], p50: at(0.5), p95: at(0.95), max: samples[samples.length - 1] };
}

console.log(`cold start, n=${N} fresh processes per arm\n`);
// Bare arm takes the db path positionally; oclif takes its command name first.
const bare = timeArm('bare-node', `${ROOT}/bare-record.mjs`, (db) => [db]);
const oclif = timeArm('oclif', `${ROOT}/oclif-probe/bin/run.mjs`, (db) => ['record', db]);

const fmt = (r) => `${r.label.padEnd(12)} n=${String(r.n).padStart(3)}  min ${r.min.toFixed(0).padStart(5)}  p50 ${r.p50.toFixed(0).padStart(5)}  p95 ${r.p95.toFixed(0).padStart(5)}  max ${r.max.toFixed(0).padStart(5)}  (ms)`;
console.log(bare ? fmt(bare) : 'bare-node    ALL SAMPLES FAILED');
console.log(oclif ? fmt(oclif) : 'oclif        ALL SAMPLES FAILED');
if (bare && oclif) {
  console.log(`\noclif overhead over bare node: p50 +${(oclif.p50 - bare.p50).toFixed(0)} ms, p95 +${(oclif.p95 - bare.p95).toFixed(0)} ms`);
  console.log(`ratio at p50: ${(oclif.p50 / bare.p50).toFixed(2)}x`);
}

// --- insert throughput: node:sqlite vs better-sqlite3 ---
const ROWS = 10000;
console.log(`\ninsert throughput, ${ROWS} rows in one transaction (n=5 runs, median reported)\n`);

const runs = { 'node:sqlite': [], 'better-sqlite3': [] };
for (let i = 0; i < 5; i++) {
  const r = spawnSync(process.execPath, [`${ROOT}/throughput.mjs`, String(ROWS)], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log('throughput run failed:', r.stderr.split('\n').slice(0, 4).join(' | '));
    break;
  }
  for (const line of r.stdout.trim().split('\n')) {
    const [name, rps] = line.split(' ');
    if (runs[name]) runs[name].push(Number(rps));
  }
}
for (const [name, values] of Object.entries(runs)) {
  if (values.length === 0) continue;
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  console.log(`  ${name.padEnd(16)} median ${Math.round(median).toLocaleString()} rows/sec   (runs: ${values.map((v) => Math.round(v)).join(', ')})`);
}
