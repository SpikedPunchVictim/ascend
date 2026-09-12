// EV-8: the question EV-storage.md explicitly left open, and which the registry's
// index-emission rule has to answer before it can ship.
//
//   "how many indexes to emit, and whether index count degrades the write path" --
//   not measured. Write cost was measured with <=2 indexes.
//
// The rule EV-storage settled is "emit a composite expression index per property".
// A type is authored by an LLM and nothing bounds its property count, so that rule
// permits 20+ indexes on one table -- and every INSERT then maintains all of them.
// The read side of that trade was measured (A4 = 0.95x C, a win). The write side was
// not, and the two products that would pay it are real:
//
//   - `asc record`, one entry per transaction, called by a hook on every session.
//   - the claude-code adapter's backfill of ~829 real transcripts, which is a bulk
//     insert path and therefore pays the index cost N times.
//
// QUESTIONS
//   Q1. What does one more composite expression index cost per INSERT?
//   Q2. Does it scale linearly in index count, or worse (B-tree depth, page spills)?
//   Q3. Is the cost paid at batch scale different from per-transaction scale?
//   Q4. What does the index set cost in file size?
//
// METHOD
//   For k in {0,1,2,5,10,20}: build the real entries table shape, create k composite
//   expression indexes (type_name, json_extract(properties_json, '$.<prop>')), fill it
//   to 100k rows so the indexes are full-depth, then time 2000 inserts two ways --
//   autocommit (the `asc record` pattern) and one batched transaction (the backfill
//   pattern). Values come from spike/corpus.db, the real denial events, so selectivity
//   and value width are real rather than synthetic padding.

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TMP = 'spike/tmp';
mkdirSync(TMP, { recursive: true });

const src = new DatabaseSync('spike/corpus.db');
const real = src
  .prepare(
    `SELECT COALESCE(denial_kind,'') AS denial_kind, COALESCE(tool_name,'') AS tool_name,
            COALESCE(project,'') AS project, COALESCE(session_id,'') AS session
       FROM events WHERE kind = 'tool-denial'`,
  )
  .all();
src.close();

if (real.length === 0) throw new Error('corpus.db has no tool-denial events to draw on');

const FILL = 100_000;
const TIMED = 2_000;
const INDEX_COUNTS = [0, 1, 2, 5, 10, 20];

// Up to 20 properties, the first few carrying real corpus values and the rest
// permutations of them. Same values for every variant -- only the INDEX COUNT varies,
// so a difference between variants is the index set and nothing else.
const PROPERTY_NAMES = Array.from({ length: 20 }, (_, i) => `prop_${i}`);
const rowFor = (i) => {
  const r = real[i % real.length];
  const values = [r.denial_kind, r.tool_name, r.project, r.session];
  const out = {};
  for (let p = 0; p < 20; p++) out[PROPERTY_NAMES[p]] = values[p % values.length];
  return JSON.stringify(out);
};

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function openVariant(k) {
  const file = `${TMP}/write-cost-${k}.db`;
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE entries (
    id TEXT PRIMARY KEY, type_name TEXT NOT NULL, recorded_at TEXT NOT NULL,
    properties_json TEXT NOT NULL, na_json TEXT NOT NULL DEFAULT '[]')`);

  const indexNames = [];
  for (let p = 0; p < k; p++) {
    const name = `idx_entries_t_prop_${p}`;
    db.exec(
      `CREATE INDEX ${name} ON entries (type_name, json_extract(properties_json, '$.${PROPERTY_NAMES[p]}'))`,
    );
    indexNames.push(name);
  }
  return { db, file, indexNames };
}

const results = [];

for (const k of INDEX_COUNTS) {
  const { db, file, indexNames } = openVariant(k);
  const ins = db.prepare(
    'INSERT INTO entries (id, type_name, recorded_at, properties_json) VALUES (?,?,?,?)',
  );

  // Fill first, so the indexes are at full depth before anything is timed.
  const fillStart = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < FILL; i++) ins.run(`pre-${i}`, 'tool_denial', '2026-09-11T10:00:00.000Z', rowFor(i));
  db.exec('COMMIT');
  const fillMs = performance.now() - fillStart;

  // Q3a: autocommit, one transaction per entry -- what `asc record` actually does.
  const perTxn = [];
  for (let i = 0; i < TIMED; i++) {
    const t = performance.now();
    ins.run(`auto-${i}`, 'tool_denial', '2026-09-11T10:00:00.000Z', rowFor(i));
    perTxn.push(performance.now() - t);
  }

  // Q3b: one transaction for the whole batch -- what the adapter's backfill does.
  const batchStart = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < TIMED; i++) ins.run(`batch-${i}`, 'tool_denial', '2026-09-11T10:00:00.000Z', rowFor(i));
  db.exec('COMMIT');
  const batchMs = performance.now() - batchStart;

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const bytes = statSync(file).size;

  results.push({
    indexes: k,
    indexNames,
    fillMs,
    perTxnMedian: median(perTxn),
    perTxnP95: [...perTxn].sort((a, b) => a - b)[Math.floor(perTxn.length * 0.95)],
    batchMs,
    bytes,
  });
}

// ---------- report ----------
console.log('Q1/Q2/Q4: cost per INSERT by composite-expression-index count');
console.log(`table filled to ${FILL.toLocaleString()} rows first, then ${TIMED.toLocaleString()} timed\n`);
console.log(
  'indexes  autocommit ms/insert  p95    batched ms/insert  file MB  vs 0 indexes',
);
const base = results[0];
for (const r of results) {
  const ratio = (r.batchMs / TIMED / (base.batchMs / TIMED)).toFixed(2);
  console.log(
    `${String(r.indexes).padStart(7)}  ${r.perTxnMedian.toFixed(3).padStart(19)}  ` +
      `${r.perTxnP95.toFixed(3).padStart(5)}  ${(r.batchMs / TIMED).toFixed(4).padStart(17)}  ` +
      `${(r.bytes / 1e6).toFixed(1).padStart(7)}  ${ratio.padStart(12)}x`,
  );
}

console.log('\nindex BUILD cost at 100k rows (the registration path pays this once):');
for (const r of results) console.log(`  ${String(r.indexes).padStart(2)} indexes: fill ${r.fillMs.toFixed(0)} ms`);

// ---------- verdict against the thresholds that matter ----------
const auto20 = results.find((r) => r.indexes === 20);
const auto0 = results.find((r) => r.indexes === 0);
const backfill = (r) => (r.batchMs / TIMED) * 829 * 20; // ~829 transcripts, ~20 entries each

console.log('\nQ3: what the two real write paths would pay at 20 properties');
console.log(
  `  asc record (1 entry/txn):  ${auto0.perTxnMedian.toFixed(3)} ms -> ` +
    `${auto20.perTxnMedian.toFixed(3)} ms  (+${(auto20.perTxnMedian - auto0.perTxnMedian).toFixed(3)} ms per record)`,
);
console.log(
  `  adapter backfill (~16.6k entries, batched): ${backfill(auto0).toFixed(0)} ms -> ` +
    `${backfill(auto20).toFixed(0)} ms`,
);
