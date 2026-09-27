/**
 * asc-gtnu.8 post-hoc checks. NOT PRE-REGISTERED: written after every run was scored, to ask
 * whether the scorer credits proximity alone. Nothing here changes a PREREG reading.
 *
 * 1. Chance-hit rate: score each unseeded arm-C run against every class's seeds, with the sealed
 *    rule (|line - seed.line| <= R). The original code at a seed's line is correct, so any "hit"
 *    here is a finding that happens to sit near where a defect would have been planted.
 * 2. Seeded-run findings that hit no seed of their class.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProportion } from '../lib/stats.mjs';
import { REPO, SUBJECT } from './trees.mjs';

const R = 3;
const OUT = join(REPO, 'spike', 'tmp', 'recall');
const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const doc = JSON.parse(readFileSync(join(REPO, 'spike', 'recall', 'seeds.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(OUT, 'ledger.json'), 'utf8'));

function storeFindings() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-posthoc-'));
  mkdirSync(join(dir, '.ascend'), { recursive: true });
  const run = (args) => {
    const res = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`asc ${args.join(' ')} failed: ${res.stderr}`);
    return res.stdout;
  };
  run(['init', '--json']);
  run(['ingest', 'claude-code', '--root', join(OUT, 'root'), '--include-ephemeral', '--json']);
  const out = run(['query', '--json', "SELECT properties_json FROM entries WHERE type_name = 'review_finding'"]);
  return JSON.parse(out).rows.map((r) => JSON.parse(r.properties_json));
}

const near = (f, s) => {
  if (!String(f.file ?? '').endsWith(SUBJECT)) return false;
  const line = Number.parseInt(String(f.line ?? ''), 10);
  return Number.isFinite(line) && Math.abs(line - s.line) <= R;
};

const findings = storeFindings();
const runs = ledger.runs.filter((r) => r.completed && r.runId !== undefined && !r.runId.startsWith('probe-'));
const found = (r) => findings.filter((f) => f.session_id === r.sessionId);
const classes = Object.keys(doc.lenses);

console.log('## Post-hoc 1 (NOT pre-registered): unseeded arm-C runs scored against each class');
for (const r of runs.filter((x) => x.runId.startsWith('pilot-') || x.arm === 'C')) {
  const fs = found(r);
  const cells = classes.map((cls) => {
    const seeds = doc.seeds.filter((s) => s.class === cls);
    const n = seeds.filter((s) => fs.some((f) => near(f, s))).length;
    return `${cls.slice(0, 4)} ${formatProportion(n, seeds.length)}`;
  });
  console.log(`${r.runId.padEnd(40)} findings=${String(fs.length).padStart(2)}  ${cells.join('  ')}`);
}

console.log('\n## Post-hoc 2 (NOT pre-registered): seeded-run findings near no seed of their class');
let tot = 0;
let miss = 0;
for (const r of runs.filter((x) => !x.runId.startsWith('pilot-') && x.arm !== 'C')) {
  const seeds = doc.seeds.filter((s) => s.class === r.cls);
  const fs = found(r);
  const m = fs.filter((f) => !seeds.some((s) => near(f, s))).length;
  tot += fs.length;
  miss += m;
  console.log(`${r.runId.padEnd(52)} ${formatProportion(m, fs.length)}`);
}
console.log(`all seeded runs: ${formatProportion(miss, tot)}`);

// time_concurrency is 10 of 11 test-breaking, and the highest-recall class, so the P3 gap may be a
// class effect. The same gap within each class, arms A and B, both models pooled.
console.log('\n## Post-hoc 3 (NOT pre-registered): P3 gap within each class');
for (const arm of ['A', 'B']) {
  for (const cls of classes) {
    const rows = [];
    for (const r of runs.filter((x) => x.arm === arm && x.cls === cls && !x.runId.startsWith('pilot-'))) {
      const fs = found(r);
      for (const s of doc.seeds.filter((x) => x.class === cls)) rows.push({ br: s.breaksCommittedTest, hit: fs.some((f) => near(f, s)) });
    }
    const part = (b) => {
      const xs = rows.filter((x) => x.br === b);
      return formatProportion(xs.filter((x) => x.hit).length, xs.length);
    };
    console.log(`${arm} ${cls.padEnd(32)} breaking ${part(true)} | not ${part(false)}`);
  }
}
