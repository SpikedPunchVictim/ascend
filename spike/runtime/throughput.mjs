// Insert throughput: node:sqlite vs better-sqlite3, identical workload.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// better-sqlite3 is a transitive dep of the local mast devDependency, so it is
// only resolvable by its pnpm store path -- pnpm does not hoist it to the root.
const BetterSqlite3 = require(
  resolve(process.cwd(), 'node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3'),
);

const rows = Number(process.argv[2] ?? 10000);

function bench(name, open) {
  const path = `spike/runtime/tmp/tp-${name.replace(/\W/g, '')}.db`;
  rmSync(path, { force: true });
  const db = open(path);
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT, recorded_at TEXT)');
  const insert = db.prepare('INSERT INTO entries (type_name, properties_json, recorded_at) VALUES (?,?,?)');
  const payload = JSON.stringify({ stage: 'implementation', verdict: 'approved', findings: 3 });
  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) insert.run('review-completed', payload, '2026-09-11T00:00:00.000Z');
  db.exec('COMMIT');
  const ms = performance.now() - t0;
  db.close();
  rmSync(path, { force: true });
  console.log(`${name} ${rows / (ms / 1000)}`);
}

bench('node:sqlite', (p) => new DatabaseSync(p));
bench('better-sqlite3', (p) => new (BetterSqlite3.default ?? BetterSqlite3)(p));
