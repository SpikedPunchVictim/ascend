/**
 * Score `asc-asq` from `spike/tmp/asq/{split,results}.json`. Reports BOTH arms, the paired
 * per-draw difference, and the predictions PREREG.md fixed before the run.
 *
 * The inference unit is the draw: the test set is fixed, so the only thing that varies between
 * a random and a stratified call is the prompt the sampler produced.
 *
 *   node spike/asq/score.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../recall/trees.mjs';

const WORK = join(REPO, 'spike', 'tmp', 'asq');
const split = JSON.parse(readFileSync(join(WORK, 'split.json'), 'utf8'));
const results = JSON.parse(readFileSync(join(WORK, 'results.json'), 'utf8'));

const draws = [...new Set(results.pairs.map((p) => p.draw))].sort((a, b) => a - b);
const byPair = new Map(results.pairs.map((p) => [`${p.draw}:${p.arm}`, p]));
const classes = [...new Set(split.test.map((f) => f.class))].sort();

const RARE = ['state_machine', 'error_paths', 'data_lifecycle'];
const COMMON = ['boundary_conditions', 'assumption_audit', 'cross_implementation_divergence'];

function accuracy(pair) {
  let correct = 0;
  for (const [i, f] of split.test.entries()) if (pair.predicted[i + 1] === f.class) correct += 1;
  return correct / split.test.length;
}

function recall(pair, restrict) {
  const per = {};
  for (const [i, f] of split.test.entries()) {
    if (restrict && !restrict.includes(f.class)) continue;
    per[f.class] ??= { n: 0, correct: 0 };
    per[f.class].n += 1;
    if (pair.predicted[i + 1] === f.class) per[f.class].correct += 1;
  }
  return per;
}

function accuracyOn(pair, keep) {
  let n = 0;
  let correct = 0;
  for (const [i, f] of split.test.entries()) {
    if (!keep(f)) continue;
    n += 1;
    if (pair.predicted[i + 1] === f.class) correct += 1;
  }
  return n === 0 ? null : correct / n;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function bootstrapCI(xs, reps = 20000) {
  if (xs.length < 2) return [Number.NaN, Number.NaN];
  const out = [];
  for (let r = 0; r < reps; r += 1) {
    let sum = 0;
    for (let i = 0; i < xs.length; i += 1) sum += xs[Math.floor(Math.random() * xs.length)];
    out.push(sum / xs.length);
  }
  out.sort((a, b) => a - b);
  return [out[Math.floor(reps * 0.025)], out[Math.floor(reps * 0.975)]];
}
const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? '   -  ' : `${(x * 100).toFixed(1).padStart(5)}%`);

const rows = [];
for (const d of draws) {
  const R = byPair.get(`${d}:random`);
  const S = byPair.get(`${d}:stratified`);
  if (!R || !S) continue;
  const omitted = R.omitted ?? [];
  rows.push({
    draw: d,
    accRandom: accuracy(R),
    accStratified: accuracy(S),
    diff: accuracy(S) - accuracy(R),
    omitted,
    accRandomOmitted: accuracyOn(R, (f) => omitted.includes(f.class)),
    accStratifiedOmitted: accuracyOn(S, (f) => omitted.includes(f.class)),
    rareRandom: mean(RARE.map((c) => recall(R)[c]).filter(Boolean).map((v) => v.correct / v.n)),
    rareStratified: mean(RARE.map((c) => recall(S)[c]).filter(Boolean).map((v) => v.correct / v.n)),
  });
}

console.log(`pairs: ${rows.length} draws x 2 arms, ${split.test.length} test items, corpus sha ${split.corpus_sha256.slice(0, 12)}`);
console.log(`spent: $${(results.spent_usd ?? 0).toFixed(2)}`);
console.log('\nper draw');
console.log('draw  omitted  random   strat   diff    | on omitted-class items: random strat | rare recall: random strat');
for (const r of rows) {
  console.log(
    `${String(r.draw).padStart(4)}  ${String(r.omitted.length).padStart(2)}  ${pct(r.accRandom)}  ${pct(r.accStratified)}  ${pct(r.diff)}  | ${pct(r.accRandomOmitted)} ${pct(r.accStratifiedOmitted)} | ${pct(r.rareRandom)} ${pct(r.rareStratified)}`,
  );
}

const diffs = rows.map((r) => r.diff);
const [lo, hi] = bootstrapCI(diffs);
const wins = diffs.filter((d) => d > 0).length;
console.log(`\nP1 paired accuracy difference: mean ${pct(mean(diffs))} (95% CI ${pct(lo)} to ${pct(hi)}), stratified better in ${wins}/${diffs.length} draws`);

const omittedRows = rows.filter((r) => r.accRandomOmitted !== null);
if (omittedRows.length > 0) {
  const gains = omittedRows.map((r) => r.accStratifiedOmitted - r.accRandomOmitted);
  const [olo, ohi] = bootstrapCI(gains);
  console.log(
    `P2 on the classes random omitted (${omittedRows.length} draws, ${omittedRows.reduce((n, r) => n + split.test.filter((f) => r.omitted.includes(f.class)).length, 0)} item-draws): random ${pct(mean(omittedRows.map((r) => r.accRandomOmitted)))} vs stratified ${pct(mean(omittedRows.map((r) => r.accStratifiedOmitted)))}, gain ${pct(mean(gains))} (95% CI ${pct(olo)} to ${pct(ohi)})`,
  );
}

const rareGains = rows.map((r) => r.rareStratified - r.rareRandom);
const [rlo, rhi] = bootstrapCI(rareGains);
console.log(`P3 rare-class recall: random ${pct(mean(rows.map((r) => r.rareRandom)))} vs stratified ${pct(mean(rows.map((r) => r.rareStratified)))}, gain ${pct(mean(rareGains))} (95% CI ${pct(rlo)} to ${pct(rhi)})`);

console.log('\nper-class recall (mean over draws)');
console.log(`class                            random  strat   diff    n(test)`);
for (const cls of classes) {
  const perR = rows.map((r) => {
    const rec = recall(byPair.get(`${r.draw}:random`))[cls];
    return rec ? rec.correct / rec.n : null;
  }).filter((x) => x !== null);
  const perS = rows.map((r) => {
    const rec = recall(byPair.get(`${r.draw}:stratified`))[cls];
    return rec ? rec.correct / rec.n : null;
  }).filter((x) => x !== null);
  const n = split.test.filter((f) => f.class === cls).length;
  const flag = RARE.includes(cls) ? ' rare' : '';
  console.log(`${cls.padEnd(32)}${pct(mean(perR))}  ${pct(mean(perS))}  ${pct(mean(perS) - mean(perR))}  ${String(n).padStart(4)}${flag}`);
}

const commonGains = rows.map((r) => {
  const cr = (p) => mean(COMMON.map((c) => recall(p)[c]).filter(Boolean).map((v) => v.correct / v.n));
  return cr(byPair.get(`${r.draw}:stratified`)) - cr(byPair.get(`${r.draw}:random`));
});
console.log(`P4 common-class recall: gain under stratified ${pct(mean(commonGains))} (negative expected)`);

const accR = mean(rows.map((r) => r.accRandom));
const accS = mean(rows.map((r) => r.accStratified));
const majority = Math.max(...classes.map((c) => split.test.filter((f) => f.class === c).length)) / split.test.length;
console.log(`P5 accuracy: random ${pct(accR)}, stratified ${pct(accS)}, majority baseline ${pct(majority)}`);

const decision =
  hi < 0.02 ? 'DROP the mode (CI entirely below +2 points)' : lo > 0.02 ? 'KEEP the mode' : 'INCONCLUSIVE (CI spans +2 points)';
console.log(`\ndecision: ${decision}`);
