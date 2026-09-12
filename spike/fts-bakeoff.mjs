// EV-5: which FTS5 tokenizer should carry `evidence_text`?
//
// Arms: unicode61 (FTS5 default), porter (default + stemming), trigram
// (substring search). ARCHITECTURE.md requires FTS5 over evidence_text and
// forbids embeddings, so tokenizer choice is the whole search design.
//
// HONESTY CONSTRAINT: the documents are real transcript text, and NO document
// content or raw query term is printed. Ground truth is computed inside SQLite
// with LIKE, and every reported number is a retrieval score. The only strings
// surfaced are identifier-shaped tokens (which are code/file names), never prose.
//
// The decisive question is not "which ranks best on whole words" -- all three do
// that. It is: can an LLM find an entry by a PARTIAL token, an identifier, or a
// fragment of a path? That is how agents actually search, and it is where the
// tokenizers diverge.

import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { streamCorpus } from './lib/reader.mjs';

const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

const MAX_DOCS = 40000;
const MAX_DOC_CHARS = 2000;

// ---- 1. extract documents (content never leaves this process) --------------
const docs = [];
const seen = new Set();
function addDoc(text, source) {
  if (typeof text !== 'string') return;
  const t = text.trim();
  if (t.length < 40) return;
  const key = t.slice(0, 160);
  if (seen.has(key)) return; // dedupe near-identical boilerplate
  seen.add(key);
  docs.push({ source, text: t.slice(0, MAX_DOC_CHARS) });
}
function walk(o, depth) {
  if (depth > 4 || o === null || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') { if (v.length >= 40) addDoc(v, k); }
    else if (v && typeof v === 'object') walk(v, depth + 1);
  }
}

process.stdout.write('extracting documents... ');
const t0 = performance.now();
await streamCorpus((rec, n, path) => {
  if (docs.length >= MAX_DOCS) return;
  walk(rec, 0);
}, {});
const extractMs = performance.now() - t0;

const totalChars = docs.reduce((a, d) => a + d.text.length, 0);
console.log(`${docs.length} docs, ${(totalChars / 1048576).toFixed(1)} MB of text in ${(extractMs / 1000).toFixed(1)}s`);

// ---- 2. build one FTS5 table per arm ---------------------------------------
// NOTE: `porter` is a wrapper tokenizer, not an option to unicode61 -- it must
// come FIRST in the spec. `tokenize="unicode61 porter"` fails with "error in
// tokenizer constructor"; `tokenize="porter"` is correct.
const TMPL = (tok) => `CREATE VIRTUAL TABLE ft USING fts5(text, tokenize="${tok}", content='')`;

const path = `${TMP}/fts.db`;
rmSync(path, { force: true });
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL');
db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, source TEXT, text TEXT)');
db.exec('CREATE TABLE ground (id INTEGER PRIMARY KEY, text TEXT)');

const insDoc = db.prepare('INSERT INTO docs (source, text) VALUES (?,?)');
const insGnd = db.prepare('INSERT INTO ground (text) VALUES (?)');
db.exec('BEGIN');
for (const d of docs) { insDoc.run(d.source, d.text); insGnd.run(d.text); }
db.exec('COMMIT');

const arms = {
  unicode61: { ddl: TMPL('unicode61'), label: 'unicode61 (default)' },
  porter: { ddl: TMPL('porter'), label: 'porter' },
  trigram: { ddl: TMPL('trigram'), label: 'trigram' },
};

for (const [name, arm] of Object.entries(arms)) {
  const t = performance.now();
  db.exec(`DROP TABLE IF EXISTS ft_${name}`);
  db.exec(arm.ddl.replace('fts5(text', `fts5(text`).replace('CREATE VIRTUAL TABLE ft', `CREATE VIRTUAL TABLE ft_${name}`));
  const ins = db.prepare(`INSERT INTO ft_${name} (rowid, text) VALUES (?,?)`);
  db.exec('BEGIN');
  for (let i = 0; i < docs.length; i++) ins.run(i + 1, docs[i].text);
  db.exec('COMMIT');
  arm.buildMs = performance.now() - t;
}

const sizeOf = (t) => {
  try { return db.prepare(`SELECT SUM(pgsize) b FROM dbstat WHERE name LIKE ?`).get(`%${t}%`).b ?? 0; }
  catch { return 0; }
};
console.log('\nindex build:');
for (const [n, a] of Object.entries(arms)) console.log(`  ${a.label.padEnd(20)} ${a.buildMs.toFixed(0).padStart(6)}ms  size ${(sizeOf(`ft_${n}`) / 1048576).toFixed(1)} MB`);

// ---- 3. derive query terms from the corpus, deterministically --------------
// Token DF computed in JS over the same documents. Only identifier-shaped
// tokens are ever echoed to stdout.
const tokenDF = new Map();
for (const d of docs) {
  const toks = new Set(d.text.split(/[^A-Za-z0-9_./:-]+/).filter((w) => w.length >= 4));
  for (const w of toks) tokenDF.set(w, (tokenDF.get(w) ?? 0) + 1);
}
const isIdentifier = (w) => /^[A-Za-z][A-Za-z0-9_./-]*$/.test(w) && /[_./-]/.test(w) && w.length >= 6;
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeFts = (s) => `"${s.replace(/"/g, '""')}"`;

function pick(pred, n) {
  return [...tokenDF.entries()]
    .filter(([w, df]) => pred(w, df))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w, df]) => ({ term: w, df }));
}

const commonWords = pick((w, df) => /^[a-z]{5,}$/.test(w) && df >= 50 && df <= docs.length * 0.5, 12);
const identifiers = pick((w) => isIdentifier(w), 12);
// partial tokens: prefixes of common identifiers -- the "I half-remember the name" case
const partials = identifiers.slice(0, 10).map((i) => ({ term: i.term.slice(0, Math.max(4, Math.floor(i.term.length / 2))), df: i.df, from: i.term }));

function df(term) {
  return db.prepare(`SELECT COUNT(*) c FROM ground WHERE text LIKE ? ESCAPE '\\'`).get(`%${escapeLike(term)}%`).c;
}
function retrieve(table, term, limit = 10) {
  try {
    const rows = db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`).all(escapeFts(term), limit);
    return { ids: rows.map((r) => r.rowid), threw: null };
  } catch (e) { return { ids: [], threw: e.message }; }
}
// A retrieved doc is "correct" for a substring query if it actually contains it.
const truth = new Map();
function isRelevant(id, term) {
  const k = `${id}|${term}`;
  if (truth.has(k)) return truth.get(k);
  const row = db.prepare('SELECT text FROM ground WHERE id = ?').get(id);
  const v = row ? row.text.includes(term) : false;
  truth.set(k, v);
  return v;
}

function score(table, terms) {
  let hit = 0, got = 0, total = 0, threw = 0, found = 0;
  const lat = [];
  for (const { term } of terms) {
    if (df(term) === 0) continue;
    total++;
    const t = performance.now();
    const { ids, threw: err } = retrieve(table, term);
    lat.push(performance.now() - t);
    if (err) { threw++; continue; }
    got += ids.length;
    const rel = ids.filter((id) => isRelevant(id, term)).length;
    hit += rel;
    // coverage = did this term retrieve ANY relevant document at all
    if (rel > 0) found++;
  }
  lat.sort((a, b) => a - b);
  return { total, hit, got, threw, found, p50: lat[Math.floor(lat.length / 2)] ?? 0,
    coverage: total ? found / total : 0, precision: got ? hit / got : 0 };
}

console.log('\nretrieval vs substring ground truth (precision@10 / term coverage):');
console.log(`${'query class'.padEnd(26)}${Object.values(arms).map((a) => a.label.padStart(22)).join('')}`);
console.log('-'.repeat(26 + 22 * 3));
const classes = [
  ['common whole words', commonWords],
  ['identifiers (paths, names)', identifiers],
  ['partial tokens (prefixes)', partials],
];
for (const [label, terms] of classes) {
  const cells = Object.entries(arms).map(([n, a]) => {
    const s = score(`ft_${n}`, terms);
    a[label] = s;
    return `${(s.precision * 100).toFixed(0)}% / ${(s.coverage * 100).toFixed(0)}%`.padStart(22);
  });
  console.log(`${label.padEnd(26)}${cells.join('')}`);
}
console.log('  (precision@10 = of the 10 rows returned, how many actually contain the substring)');
console.log('  (term coverage = of the query terms, how many retrieved at least one correct row)');

console.log('\nquery latency and hostile-input behaviour:');
console.log(`${'arm'.padEnd(22)}${'p50'.padStart(10)}${'terms found'.padStart(14)}`);
for (const [n, a] of Object.entries(arms)) {
  const s = a['identifiers (paths, names)'];
  console.log(`${a.label.padEnd(22)}${`${s.p50.toFixed(2)}ms`.padStart(10)}${`${s.total}/12`.padStart(14)}`);
}
console.log(`\n(ground truth document frequency per class: ` +
  classes.map(([l, t]) => `${l.split(' ')[0]}=${t.map((x) => df(x.term)).reduce((a, b) => a + b, 0)}`).join(', ') + ')');

// ---- 4. hostile / raw user input: does MATCH throw? ------------------------
const HOSTILE = [
  'what went wrong with the build',
  '"unbalanced quote',
  'foo -bar',
  'foo*',
  'col:value',
  'NEAR(a b)',
  'a AND b OR c',
  'C++ templates',
  'error (timeout)',
  'why did it fail?',
  'permission-rule',
  "don't panic",
  '路径 中文',
  'emoji 🔥 test',
];
console.log('\nraw user query passed straight to MATCH (no sanitizer):');
console.log(`${'arm'.padEnd(22)}${'threw'.padStart(8)}   example errors`);
for (const [n, a] of Object.entries(arms)) {
  let threw = 0; const msgs = [];
  for (const q of HOSTILE) {
    try { db.prepare(`SELECT rowid FROM ft_${n} WHERE ft_${n} MATCH ? LIMIT 1`).all(q); }
    catch (e) { threw++; if (msgs.length < 2) msgs.push(e.message.replace(/\s+/g, ' ').slice(0, 60)); }
  }
  a.hostileThrew = threw;
  console.log(`${a.label.padEnd(22)}${`${threw}/${HOSTILE.length}`.padStart(8)}   ${msgs.join(' | ')}`);
}

console.log('\nsame queries through a toFtsMatch-style sanitizer (quote-escape whole query):');
for (const [n, a] of Object.entries(arms)) {
  let threw = 0, empty = 0;
  for (const q of HOSTILE) {
    try { const r = db.prepare(`SELECT rowid FROM ft_${n} WHERE ft_${n} MATCH ? LIMIT 1`).all(escapeFts(q)); if (!r.length) empty++; }
    catch (e) { threw++; }
  }
  console.log(`  ${a.label.padEnd(20)} threw ${threw}/${HOSTILE.length}, returned empty for ${empty}`);
}

// ---- 5. stemming: does porter earn its place? ------------------------------
console.log('\nstemming check (query an inflected form, ground truth = substring):');
const pairs = [['configured', 'configuring'], ['running', 'runs'], ['failures', 'failure'], ['completed', 'complete']];
for (const [a1, a2] of pairs) {
  const q = `"${a2}"`;
  const cells = Object.entries(arms).map(([n, arm]) => {
    try { return `${arm.label.split(' ')[0]}=${db.prepare(`SELECT COUNT(*) c FROM ft_${n} WHERE ft_${n} MATCH ?`).get(q).c}`; }
    catch (e) { return `${arm.label.split(' ')[0]}=ERR`; }
  });
  console.log(`  query ${a2.padEnd(12)} ${cells.join('  ')}`);
}
console.log('  (a stemmed arm returns documents containing the OTHER inflection; substring truth is stricter)');

for (const [n, a] of Object.entries(arms)) a.identifiers = a['identifiers (paths, names)'];
db.close();
rmSync(path, { force: true });
