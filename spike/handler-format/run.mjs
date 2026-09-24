// Spike asc-6ola.5 (throwaway). Parity and cost of candidates A (YAML) and B (SQL) against the
// JS reference. PREREG.md holds the questions; this file only measures.
//
//   node spike/handler-format/run.mjs <frozen-corpus> <project-dir-name> [a-dir] [b-dir]
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvents } from './events.mjs';
import { handlers, runReference } from './reference.mjs';
import * as A from './yaml-candidate.mjs';
import * as B from './sql-candidate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [corpus, project, aDir = join(here, 'a'), bDir = join(here, 'b')] = process.argv.slice(2);
const NAMES = Object.keys(handlers);
const ms = (t) => +(performance.now() - t).toFixed(0);
const key = (r) => JSON.stringify(Object.keys(r).sort().reduce((o, k) => ((o[k] = r[k]), o), {}));

function diff(ref, got) {
  const count = new Map();
  for (const r of ref) count.set(key(r), (count.get(key(r)) ?? 0) + 1);
  const extra = [];
  for (const r of got) { const k = key(r); if (count.get(k)) count.set(k, count.get(k) - 1); else extra.push(k); }
  const missing = [...count].flatMap(([k, n]) => Array(n).fill(k));
  return { missing: missing.length, extra: extra.length, egMissing: missing.slice(0, 2), egExtra: extra.slice(0, 2) };
}
const byHandler = (rows) => Object.fromEntries(NAMES.map((n) => [n, rows.filter((r) => r.handler === n)]));

let t = performance.now();
const files = await loadEvents(corpus, project);
const events = files.reduce((a, f) => a + f.events.length, 0);
console.log(`normalize: ${files.length} files, ${events} events, ${ms(t)} ms`);

t = performance.now();
const refEnds = byHandler(runReference(files, { rule: 'ends' }));
console.log(`reference (JS, spike/replay window): ${ms(t)} ms`);
const refCalls = byHandler(runReference(files, { rule: 'calls' }));
const refLiteral = byHandler(runReference(files, { rule: 'literal' }));

// A: load, compile, evaluate
const a = {}, aHash = {};
t = performance.now();
const compiled = {};
for (const n of NAMES) {
  const p = join(aDir, `${n}.yaml`);
  if (!existsSync(p)) { a[n] = { error: 'no file' }; continue; }
  try { const { spec, hash } = A.load(readFileSync(p, 'utf8')); aHash[n] = hash.slice(0, 12); compiled[n] = A.compile(spec); }
  catch (err) { a[n] = { error: `refused: ${err.message}` }; }
}
const aLoad = ms(t);
t = performance.now();
for (const n of Object.keys(compiled)) a[n] = A.evaluate(n, compiled[n], files);
const aEval = ms(t);

// B: load the table, then one query per handler
t = performance.now();
const db = B.open();
B.loadTable(db, files);
const bLoad = ms(t);
const b = {};
t = performance.now();
for (const n of NAMES) {
  const p = join(bDir, `${n}.sql`);
  if (!existsSync(p)) { b[n] = { error: 'no file' }; continue; }
  try { b[n] = B.run(db, n, readFileSync(p, 'utf8')); } catch (err) { b[n] = { error: err.message.split('\n')[0] }; }
}
const bQuery = ms(t);

console.log(`A: load+compile ${aLoad} ms, evaluate ${aEval} ms`);
console.log(`B: table load ${bLoad} ms, queries ${bQuery} ms`);
console.log('');
for (const n of NAMES) {
  const w = diff(refEnds[n], refCalls[n]);
  const lit = diff(refLiteral[n], refCalls[n]);
  console.log(`${n}: reference ${refEnds[n].length} (spike window) / ${refCalls[n].length} (call rule); window-rule gap -${w.missing} +${w.extra}; literal-vs-call rule -${lit.missing} +${lit.extra}`);
  for (const [label, got] of [['A', a[n]], ['B', b[n]]]) {
    if (!Array.isArray(got)) { console.log(`  ${label}: ${got.error}`); continue; }
    const d = diff(refCalls[n], got);
    const parity = d.missing === 0 && d.extra === 0;
    console.log(`  ${label}: ${got.length} rows, ${parity ? 'PARITY' : `missing ${d.missing}, extra ${d.extra}`}${label === 'A' && aHash[n] ? ` [${aHash[n]}]` : ''}`);
    if (!parity) { for (const m of d.egMissing) console.log(`     missing ${m.slice(0, 240)}`); for (const x of d.egExtra) console.log(`     extra   ${x.slice(0, 240)}`); }
  }
}
