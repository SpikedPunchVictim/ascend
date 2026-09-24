// Spike asc-6ola.5 (throwaway). Candidate B: SQL over an event table (SPEC-B.md).
import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { tokens } from './reference.mjs';

const COLS = ['file', 'seq', 'call', 'kind', 'tool', 'id', 'ok', 'head', 'argv', 'via', 'pattern', 'hits', 'path', 'before', 'after', 'text', 'ts'];

export function open() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE events (file TEXT, seq INTEGER, call INTEGER, kind TEXT, tool TEXT, id TEXT, ok INTEGER,
    head TEXT, argv TEXT, via TEXT, pattern TEXT, hits INTEGER, path TEXT, before TEXT, after TEXT, text TEXT, ts TEXT)`);
  const cache = new Map();
  const rx = (p, f = '') => { const k = f + '/' + p; if (!cache.has(k)) cache.set(k, new RegExp(p, f)); return cache.get(k); };
  const det = { deterministic: true };
  db.function('regexp', det, (p, x) => (typeof x === 'string' && rx(p).test(x) ? 1 : 0));
  db.function('regexp_i', det, (p, x) => (typeof x === 'string' && rx(p, 'i').test(x) ? 1 : 0));
  db.function('regex_capture', det, (x, p, g, f) => (typeof x === 'string' ? (x.match(rx(p, f ?? ''))?.[Number(g)] ?? null) : null));
  db.function('shares_token', det, (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return 0;
    const t = new Set(tokens(a)); return tokens(b).some((k) => t.has(k)) ? 1 : 0;
  });
  db.function('basename', det, (p) => (p == null ? null : basename(p)));
  db.function('snake', det, (s) => (s == null ? null : String(s).toLowerCase().replace(/\s+/g, '_')));
  return db;
}

export function loadTable(db, files) {
  const ins = db.prepare(`INSERT INTO events VALUES (${COLS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (const { events } of files) {
    for (const e of events) {
      ins.run(...COLS.map((c) => {
        const v = e[c];
        if (v === undefined) return null;
        if (c === 'argv') return JSON.stringify(v);
        if (c === 'ok') return v ? 1 : 0;
        return v;
      }));
    }
  }
  db.exec('COMMIT');
  db.exec('CREATE INDEX ev_kind ON events(kind); CREATE INDEX ev_call ON events(file, call)');
}

export function run(db, name, sql) {
  return db.prepare(sql).all().map((r) => {
    const row = { handler: name, file: r.file, seq: r.seq };
    for (const [k, v] of Object.entries(r)) if (k !== 'file' && k !== 'seq' && v !== null) row[k] = String(v);
    return row;
  });
}
