/**
 * asc-gtnu.8 scorer, written to PREREG section 6 before any seeded run.
 *
 * FINDINGS COME FROM THE STORE. The pruned transcript root (`spike/tmp/recall/root/`) is ingested
 * into a FRESH scratch store under the OS temp root -- never the live `.ascend/` -- and the
 * `review_finding` entries are read back with `asc query`. The raw stream's count is a cross-check
 * only, and a mismatch is printed rather than resolved.
 *
 * The kappa sample is drawn and written WITHOUT the scorer's labels (`--kappa-sample`), so the
 * hand labels can be made before the scorer's are seen; `--kappa` then compares the two.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chiSquare,
  crosstab,
  formatProportion,
  minNFlag,
  mulberry32,
  permutationNull,
} from '../lib/stats.mjs';
import { REPO, SUBJECT } from './trees.mjs';

export const R = 3;
const OUT = join(REPO, 'spike', 'tmp', 'recall');
const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const SEED = 20260927;

const doc = JSON.parse(readFileSync(join(REPO, 'spike', 'recall', 'seeds.json'), 'utf8'));
const ledger = JSON.parse(readFileSync(join(OUT, 'ledger.json'), 'utf8'));

/** Every review_finding in a fresh scratch store built from the pruned root. */
function storeFindings() {
  const dir = mkdtempSync(join(tmpdir(), 'rv-score-'));
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

export function isHit(finding, seed) {
  const file = String(finding.file ?? '');
  if (!file.endsWith(SUBJECT)) return false;
  const line = Number.parseInt(String(finding.line ?? ''), 10);
  if (Number.isFinite(line)) return Math.abs(line - seed.line) <= R;
  const text = `${String(finding.summary ?? '')} ${String(finding.failure_scenario ?? '')}`;
  return text.includes(seed.distinguishingToken);
}

/** Greedy one-to-one match of two finding lists by file and |line diff| <= R. */
export function matchJaccard(a, b) {
  const used = new Set();
  let matched = 0;
  for (const x of a) {
    const lx = Number.parseInt(String(x.line ?? ''), 10);
    const j = b.findIndex((y, i) => {
      if (used.has(i) || y.file !== x.file) return false;
      const ly = Number.parseInt(String(y.line ?? ''), 10);
      return Number.isFinite(lx) && Number.isFinite(ly) && Math.abs(lx - ly) <= R;
    });
    if (j !== -1) {
      used.add(j);
      matched += 1;
    }
  }
  const denom = a.length + b.length - matched;
  return denom === 0 ? null : matched / denom;
}

const jaccardSets = (a, b) => {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return null;
  return [...a].filter((x) => b.has(x)).length / union.size;
};

function cohenKappa(pairs) {
  const n = pairs.length;
  const agree = pairs.filter(([h, s]) => h === s).length / n;
  const pH = pairs.filter(([h]) => h).length / n;
  const pS = pairs.filter(([, s]) => s).length / n;
  const chance = pH * pS + (1 - pH) * (1 - pS);
  return chance === 1 ? null : (agree - chance) / (1 - chance);
}

const findings = storeFindings();
const runs = ledger.runs.filter((r) => r.completed && r.runId !== undefined && !r.runId.startsWith('probe-'));
const bySession = new Map();
for (const f of findings) {
  const list = bySession.get(f.session_id) ?? [];
  list.push(f);
  bySession.set(f.session_id, list);
}
const armOf = (r) => (r.runId.startsWith('pilot-') ? 'C' : r.arm);
const view = runs.map((r) => ({ ...r, arm: armOf(r), found: bySession.get(r.sessionId) ?? [] }));

if (process.argv.includes('--kappa-sample')) {
  const pool = view.filter((r) => r.arm !== 'C').flatMap((r) => r.found.map((f) => ({ cls: r.cls, f })));
  const rand = mulberry32(SEED);
  const shuffled = [...pool];
  for (let j = shuffled.length - 1; j > 0; j -= 1) {
    const k = Math.floor(rand() * (j + 1));
    [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
  }
  const sample = shuffled.slice(0, 40).map(({ cls, f }, i) => ({
    i,
    cls,
    tool_use_id: f.tool_use_id,
    file: f.file,
    line: f.line,
    summary: f.summary,
    failure_scenario: f.failure_scenario,
  }));
  writeFileSync(join(OUT, 'kappa-sample.json'), JSON.stringify(sample, null, 2));
  console.log(`wrote ${String(sample.length)} of ${String(pool.length)} seeded-run findings, without scorer labels`);
  process.exit(0);
}

const report = [];
const say = (s) => report.push(s);

// --- integrity -------------------------------------------------------------------------------
say('## Integrity');
for (const r of view) {
  const mismatch = r.found.length !== r.findings ? `  MISMATCH stream=${String(r.findings)}` : '';
  say(`${r.runId.padEnd(52)} store=${String(r.found.length).padStart(3)} spent=$${r.spentUsd.toFixed(4)} subtype=${String(r.subtype)} git=${String(r.gitUse?.length ?? 0)} outside=${String(r.outsideTreeRefs ?? 0)} runnerRan=${String(r.runnerRan)} denials=${String(r.permissionDenials?.length ?? 0)}${mismatch}`);
}
const failed = ledger.runs.filter((r) => !r.completed);
say(`runs completed=${String(runs.length)} failed=${String(failed.length)} total spent=$${ledger.runs.reduce((s, r) => s + (r.spentUsd ?? 0), 0).toFixed(4)}`);

// --- recall per class ------------------------------------------------------------------------
say('\n## Recall per class (per arm, model)');
const seedRuns = [];
for (const r of view.filter((x) => x.arm !== 'C')) {
  const seeds = doc.seeds.filter((s) => s.class === r.cls);
  const found = new Set(seeds.filter((s) => r.found.some((f) => isHit(f, s))).map((s) => s.id));
  r.foundSet = found;
  for (const s of seeds) seedRuns.push({ run: r, seed: s, found: found.has(s.id) });
  say(`${r.arm} ${r.model.padEnd(16)} ${r.cls.padEnd(32)} ${formatProportion(found.size, seeds.length)}${minNFlag(seeds.length)}`);
}

// --- P3 --------------------------------------------------------------------------------------
say('\n## Prediction 3: test-breaking vs not (seed-runs, both models pooled)');
for (const arm of ['A', 'B']) {
  const rows = seedRuns.filter((x) => x.run.arm === arm && x.seed.breaksCommittedTest !== null);
  const br = rows.filter((x) => x.seed.breaksCommittedTest);
  const nb = rows.filter((x) => !x.seed.breaksCommittedTest);
  if (br.length === 0 || nb.length === 0) {
    say(`arm ${arm}: not measurable (breaking n=${String(br.length)}, not-breaking n=${String(nb.length)})`);
    continue;
  }
  const rb = br.filter((x) => x.found).length / br.length;
  const rn = nb.filter((x) => x.found).length / nb.length;
  const nul = permutationNull(
    rows.map((x) => x.seed.breaksCommittedTest),
    rows.map((x) => x.found),
    { iterations: 10000, seed: SEED },
  );
  const observed = chiSquare(crosstab(rows.map((x) => x.seed.breaksCommittedTest), rows.map((x) => x.found))).chi2;
  say(`arm ${arm}: breaking ${formatProportion(br.filter((x) => x.found).length, br.length)} | not ${formatProportion(nb.filter((x) => x.found).length, nb.length)} | gap ${(rb - rn).toFixed(3)} | chi2 ${observed.toFixed(3)} perm p=${nul.pValue(observed).toFixed(4)}`);
}

// --- P4 --------------------------------------------------------------------------------------
say('\n## Prediction 4: Sonnet vs Opus found-set Jaccard, arm A');
const armA = view.filter((r) => r.arm === 'A');
const pooledS = new Set();
const pooledO = new Set();
for (const cls of Object.keys(doc.lenses)) {
  const s = armA.find((r) => r.cls === cls && r.model === 'claude-sonnet-5');
  const o = armA.find((r) => r.cls === cls && r.model === 'claude-opus-5-5');
  if (!s || !o) {
    say(`${cls}: not run`);
    continue;
  }
  for (const id of s.foundSet) pooledS.add(id);
  for (const id of o.foundSet) pooledO.add(id);
  say(`${cls.padEnd(32)} S=${String(s.foundSet.size)} O=${String(o.foundSet.size)} J=${String(jaccardSets(s.foundSet, o.foundSet)?.toFixed(3) ?? 'undefined (both empty)')}`);
}
say(`pooled J=${String(jaccardSets(pooledS, pooledO)?.toFixed(3) ?? 'undefined')}`);
say('Arm C baseline (finding-location Jaccard, R-matched):');
const armC = view.filter((r) => r.arm === 'C');
for (let i = 0; i < armC.length; i += 1) {
  for (let j = i + 1; j < armC.length; j += 1) {
    const a = armC[i];
    const b = armC[j];
    const kind = a.model === b.model ? `same(${a.model})` : 'cross';
    say(`  ${kind.padEnd(24)} ${a.runId} x ${b.runId} J=${String(matchJaccard(a.found, b.found)?.toFixed(3))}`);
  }
}

// --- P5 --------------------------------------------------------------------------------------
say('\n## Prediction 5: findings per run');
for (const model of ['claude-sonnet-5', 'claude-opus-5-5']) {
  const seeded = view.filter((r) => r.model === model && r.arm !== 'C').map((r) => r.found.length);
  const unseeded = view.filter((r) => r.model === model && r.arm === 'C').map((r) => r.found.length);
  const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  say(`${model.padEnd(16)} seeded n=${String(seeded.length)} mean=${String(mean(seeded)?.toFixed(2))} [${seeded.join(',')}] | unseeded n=${String(unseeded.length)} mean=${String(mean(unseeded)?.toFixed(2))} [${unseeded.join(',')}]`);
}

// --- kappa -----------------------------------------------------------------------------------
const handPath = join(OUT, 'kappa-hand.json');
if (existsSync(handPath)) {
  const sample = JSON.parse(readFileSync(join(OUT, 'kappa-sample.json'), 'utf8'));
  const hand = JSON.parse(readFileSync(handPath, 'utf8'));
  const pairs = sample.map((x) => {
    const seeds = doc.seeds.filter((s) => s.class === x.cls);
    const scorer = seeds.some((s) => isHit(x, s));
    const h = hand.find((y) => y.i === x.i);
    if (!h) throw new Error(`no hand label for sample ${String(x.i)}`);
    return [h.seed !== null, scorer];
  });
  say(`\n## Scorer vs hand, n=${String(pairs.length)}: agreement ${(pairs.filter(([a, b]) => a === b).length / pairs.length).toFixed(3)}, Cohen's kappa ${String(cohenKappa(pairs)?.toFixed(3))}`);
} else {
  say('\n## Kappa: no hand labels yet (spike/tmp/recall/kappa-hand.json)');
}

const text = report.join('\n');
writeFileSync(join(OUT, 'score.txt'), text);
console.log(text);
