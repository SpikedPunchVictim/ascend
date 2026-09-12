// EV-4 phase 4b: what does ALTER TABLE ADD COLUMN ... STORED actually cost on a
// POPULATED table?
//
// Phase 3 reported "ALTER TABLE ADD COLUMN ... STORED is ACCEPTED at runtime"
// and phase 3's registration-cost line reported 0.26ms -- but that line used
// VIRTUAL. If STORED is accepted, the question is whether it silently rewrites
// every existing row. A 0.26ms registration on a 250k-row corpus would be a
// false green, so this measures it directly.

import { rmSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

const src = new DatabaseSync('spike/corpus.db');
const real = src.prepare(`
  SELECT COALESCE(denial_kind,'') AS denial_kind, COALESCE(tool_name,'') AS tool_name
  FROM events WHERE kind = 'tool-denial'
`).all();
src.close();

const N = 250000;
const path = `${TMP}/stored-cost.db`;
rmSync(path, { force: true });
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = WAL');
db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT)');
const ins = db.prepare('INSERT INTO entries (type_name, properties_json) VALUES (?,?)');
db.exec('BEGIN');
for (let i = 0; i < N; i++) ins.run('tool-denial', JSON.stringify(real[i % real.length]));
db.exec('COMMIT');

const before = {
  pages: db.prepare('PRAGMA page_count').get().page_count,
  bytes: db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size,
};
console.log(`corpus: ${N.toLocaleString()} rows, ${(before.bytes / 1048576).toFixed(1)} MB\n`);

for (const kind of ['VIRTUAL', 'STORED']) {
  // A fresh copy each time so the two arms do not contaminate each other.
  const p = `${TMP}/stored-${kind}.db`;
  rmSync(p, { force: true });
  const d = new DatabaseSync(p);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT)');
  const i2 = d.prepare('INSERT INTO entries (type_name, properties_json) VALUES (?,?)');
  d.exec('BEGIN');
  for (let i = 0; i < N; i++) i2.run('tool-denial', JSON.stringify(real[i % real.length]));
  d.exec('COMMIT');

  const pagesBefore = d.prepare('PRAGMA page_count').get().page_count;
  const t0 = performance.now();
  let err = null;
  try {
    d.exec(`ALTER TABLE entries ADD COLUMN g_sev TEXT
            GENERATED ALWAYS AS (json_extract(properties_json,'$.severity')) ${kind}`);
  } catch (e) { err = e.message; }
  const ms = performance.now() - t0;
  const pagesAfter = d.prepare('PRAGMA page_count').get().page_count;

  if (err) {
    console.log(`  ${kind.padEnd(8)} REJECTED after ${ms.toFixed(1)}ms: ${err}`);
  } else {
    console.log(`  ${kind.padEnd(8)} accepted in ${ms.toFixed(1)}ms  (${ms < 5 ? 'no rewrite -- metadata only' : 'TABLE REWRITE'})`);
    console.log(`  ${''.padEnd(8)} pages ${pagesBefore} -> ${pagesAfter}  (${((pagesAfter / pagesBefore - 1) * 100).toFixed(1)}% growth)`);
    // Backfill correctness: does a pre-existing row now expose the value?
    const probe = d.prepare(`INSERT INTO entries (type_name, properties_json) VALUES (?,?)`);
    probe.run('tool-denial', JSON.stringify({ severity: 'high' }));
    const got = d.prepare('SELECT g_sev FROM entries ORDER BY id DESC LIMIT 1').get();
    const populated = d.prepare('SELECT COUNT(*) c FROM entries WHERE g_sev IS NOT NULL').get();
    console.log(`  ${''.padEnd(8)} new row's generated value: ${JSON.stringify(got.g_sev)}; rows with non-null g_sev: ${populated.c}`);
  }
  d.close();
  rmSync(p, { force: true });
}

db.close();
rmSync(path, { force: true });
