// asc-6ola.3 (throwaway). Power check at inquiry planning time, against the frozen corpus.
//   node spike/power/power.mjs <scratchpad>
// Reads <scratchpad>/replay-out/{events.jsonl,matches.json} (spike/replay/replay.mjs, all projects)
// and <scratchpad>/corpus-frozen for vitest summaries. Questions and predictions: PREREG.md.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { wilson, MIN_N, mulberry32 } from '../../packages/analysis/dist/index.js';

const [scratch] = process.argv.slice(2);
const HERE = '-Users-spikedpunchvictim-projects-ascend';
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
const day = (ts) => ts.slice(0, 10);

// ---------- M1: search miss, unit = search.run ----------
const matches = JSON.parse(readFileSync(join(scratch, 'replay-out', 'matches.json'), 'utf8'))['search_miss/empty-then-found'];
const missKey = new Set(matches.map((m) => `${m.session}|${m.ts}|${m.pattern}`));
const m1 = [];
for (const l of lines(join(scratch, 'replay-out', 'events.jsonl'))) {
  if (!l.includes('"search.run"')) continue;
  const e = JSON.parse(l);
  if (e.kind !== 'search.run') continue;
  m1.push({ session: e.session, project: e.project, ts: e.ts, y: missKey.has(`${e.session}|${e.ts}|${e.pattern}`) ? 1 : 0 });
}

// ---------- M2: failing test run, unit = a tool_result holding a vitest summary ----------
const SUMMARY = /Test Files\s+[^\n]*?\(\d+\)/g;
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') ? [p] : [];
});
const corpus = join(scratch, 'corpus-frozen');
const m2 = [];
for (const f of walk(corpus)) {
  const project = f.slice(corpus.length).replace(/^\//, '').split('/')[0];
  for (const l of lines(f)) {
    if (!l.includes('Test Files')) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) {
      if (c.type !== 'tool_result') continue;
      const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('\n');
      const sums = text.replace(/\x1b\[[0-9;]*m/g, '').match(SUMMARY);
      if (!sums) continue;
      m2.push({ session: r.sessionId, project, ts: r.timestamp, y: sums.some((s) => /failed/.test(s)) ? 1 : 0 });
    }
  }
}

// ---------- statistics ----------
const Z = { a: 1.959963984540054, b: 0.8416212335729143 }; // two-sided 95%, power 80%

function describe(units) {
  const bySession = new Map();
  for (const u of units) bySession.set(u.session, [...(bySession.get(u.session) ?? []), u.y]);
  const days = new Set(units.map((u) => day(u.ts)));
  const N = units.length, k = bySession.size, succ = units.reduce((s, u) => s + u.y, 0), p = succ / N;
  // One-way ANOVA ICC estimator for a binary outcome, unequal cluster sizes.
  let ssb = 0, ssw = 0, sumM2 = 0;
  for (const ys of bySession.values()) {
    const m = ys.length, pi = ys.reduce((a, b) => a + b, 0) / m;
    ssb += m * (pi - p) ** 2; ssw += ys.reduce((s, y) => s + (y - pi) ** 2, 0); sumM2 += m * m;
  }
  const msb = ssb / (k - 1), msw = ssw / (N - k), m0 = (N - sumM2 / N) / (k - 1);
  const icc = Math.max(0, (msb - msw) / (msb + (m0 - 1) * msw));
  const mbar = N / k, mtilde = sumM2 / N;
  return { N, successes: succ, p, sessions: k, activeDays: days.size, perDay: N / days.size, icc, mbar, mtilde,
    deff: 1 + (mbar - 1) * icc, deffTilde: 1 + (mtilde - 1) * icc };
}

// Total units for a two-proportion z-test with a holdout share h (normal approximation).
function totalN(p0, rel, h) {
  const p1 = p0, p2 = p0 * (1 - rel), pb = h * p1 + (1 - h) * p2, d = p1 - p2;
  const num = Z.a * Math.sqrt(pb * (1 - pb) * (1 / h + 1 / (1 - h))) + Z.b * Math.sqrt((p1 * (1 - p1)) / h + (p2 * (1 - p2)) / (1 - h));
  return (num / d) ** 2;
}

function plan(desc, rel) {
  return [0.5, 0.2].map((h) => {
    const naive = totalN(desc.p, rel, h);
    return { holdout: h, minNDays: MIN_N / (Math.min(h, 1 - h) * desc.perDay), naiveDays: naive / desc.perDay,
      clusteredDays: (naive * desc.deff) / desc.perDay, clusteredDaysTilde: (naive * desc.deffTilde) / desc.perDay, unitsNeeded: Math.ceil(naive * desc.deff) };
  });
}

function halves(units) {
  const days = [...new Set(units.map((u) => day(u.ts)))].sort();
  const cut = days[Math.floor(days.length / 2)];
  const part = (f) => { const us = units.filter(f); return wilson(us.reduce((s, u) => s + u.y, 0), us.length); };
  const a = part((u) => day(u.ts) < cut), b = part((u) => day(u.ts) >= cut);
  return { cut, first: a, second: b, overlap: a.lower <= b.upper && b.lower <= a.upper };
}

// Seeded simulation at the analytic n, unclustered: pooled z-test and Newcombe hybrid interval.
function simulate(p0, rel, h, n, reps = 10000) {
  const rnd = mulberry32(20260923);
  const n1 = Math.round(n * h), n2 = Math.round(n * (1 - h)), p2 = p0 * (1 - rel);
  let z = 0, newcombe = 0;
  for (let r = 0; r < reps; r++) {
    let x1 = 0, x2 = 0;
    for (let i = 0; i < n1; i++) x1 += rnd() < p0 ? 1 : 0;
    for (let i = 0; i < n2; i++) x2 += rnd() < p2 ? 1 : 0;
    const q1 = x1 / n1, q2 = x2 / n2, pb = (x1 + x2) / (n1 + n2);
    const se = Math.sqrt(pb * (1 - pb) * (1 / n1 + 1 / n2));
    if (se > 0 && Math.abs(q1 - q2) / se > Z.a) z++;
    const a = wilson(x1, n1), b = wilson(x2, n2), d = q1 - q2;
    if (d - Math.sqrt((q1 - a.lower) ** 2 + (b.upper - q2) ** 2) > 0) newcombe++;
  }
  return { n1, n2, zPower: z / reps, newcombePower: newcombe / reps };
}

const r = (x, d = 1) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
const out = {};
for (const [name, units, rel] of [['M1 search miss', m1, 0.5], ['M2 failing test run', m2, 0.3]]) {
  for (const [scope, us] of [['this project', units.filter((u) => u.project === HERE)], ['pooled', units]]) {
    const d = describe(us);
    const key = `${name} / ${scope}`;
    out[key] = { d, plan: plan(d, rel) };
    console.log(`\n== ${key}  (relative reduction ${rel * 100}%)`);
    console.log(`units ${d.N} successes ${d.successes} p ${(100 * d.p).toFixed(2)}% sessions ${d.sessions} activeDays ${d.activeDays} perDay ${r(d.perDay)}`);
    console.log(`icc ${d.icc.toFixed(4)} mbar ${r(d.mbar)} mtilde ${r(d.mtilde)} deff ${r(d.deff, 2)} deffTilde ${r(d.deffTilde, 2)}`);
    for (const p of out[key].plan) console.log(`  holdout ${p.holdout}: MIN_N ${r(p.minNDays)} d | powered naive ${r(p.naiveDays)} d, clustered ${r(p.clusteredDays)} d (mtilde ${r(p.clusteredDaysTilde)} d) | units ${p.unitsNeeded} | ratio ${r(p.clusteredDays / p.minNDays)}x`);
    if (scope === 'this project') {
      const hv = halves(us);
      console.log(`  halves at ${hv.cut}: first ${hv.first.successes}/${hv.first.n} [${(100 * hv.first.lower).toFixed(2)}, ${(100 * hv.first.upper).toFixed(2)}] second ${hv.second.successes}/${hv.second.n} [${(100 * hv.second.lower).toFixed(2)}, ${(100 * hv.second.upper).toFixed(2)}] overlap ${hv.overlap}`);
    }
  }
}
const sp = out['M1 search miss / pooled'].d;
const n = Math.ceil(totalN(sp.p, 0.5, 0.5));
console.log('\nW5 simulation, M1 pooled p0, 50% holdout, analytic n', n, JSON.stringify(simulate(sp.p, 0.5, 0.5, n)));

// ---------- Addendum, NOT pre-registered: is the prompt a workable randomization unit? ----------
// Sessions turned out to be few and long. Re-cluster each unit by the latest prompt.submit at or
// before it in the same session, and ask how many randomization units there are and how clustered.
const prompts = new Map(); // session -> sorted prompt timestamps
for (const l of lines(join(scratch, 'replay-out', 'events.jsonl'))) {
  if (!l.includes('"prompt.submit"')) continue;
  const e = JSON.parse(l);
  if (e.kind === 'prompt.submit') prompts.set(e.session, [...(prompts.get(e.session) ?? []), e.ts]);
}
for (const ts of prompts.values()) ts.sort();
const promptOf = (u) => { const ts = prompts.get(u.session) ?? []; let last = 'none'; for (const t of ts) { if (t <= u.ts) last = t; else break; } return `${u.session}|${last}`; };
console.log('\n== Addendum (exploratory): randomize by prompt instead of session');
for (const [name, units, rel] of [['M1 search miss', m1, 0.5], ['M2 failing test run', m2, 0.3]]) {
  for (const [scope, us] of [['this project', units.filter((u) => u.project === HERE)], ['pooled', units]]) {
    const bySessionDays = new Map();
    for (const u of us) bySessionDays.set(u.session, new Set([...(bySessionDays.get(u.session) ?? []), day(u.ts)]));
    const spans = [...bySessionDays.values()].map((s) => s.size).sort((a, b) => a - b);
    const ds = describe(us);
    const dp = describe(us.map((u) => ({ ...u, session: promptOf(u) })));
    const naive = totalN(dp.p, rel, 0.5);
    console.log(`${name} / ${scope}: sessions ${ds.sessions} (active days per session: median ${spans[Math.floor(spans.length / 2)]}, max ${spans.at(-1)}); P(no session held out at 20%) ${(0.8 ** ds.sessions * 100).toFixed(1)}%`);
    console.log(`   prompts ${dp.sessions} mbar ${r(dp.mbar)} icc ${dp.icc.toFixed(4)} deff ${r(dp.deff, 2)} deffTilde ${r(dp.deffTilde, 2)} | 50% holdout powered: ${r((naive * dp.deff) / dp.perDay)} d (mtilde ${r((naive * dp.deffTilde) / dp.perDay)} d) needing ${Math.ceil(naive * dp.deff / dp.mbar)} prompts`);
  }
}
