// The work both runtime arms must perform, identical in each: open the DB,
// ensure the table exists, insert exactly one entry, close.
//
// Keeping this shared is what makes the cold-start comparison a measurement of
// the CLI framework rather than a measurement of two different workloads.

import { DatabaseSync } from 'node:sqlite';

export function recordOne(dbPath, payload) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, type_name TEXT, properties_json TEXT, recorded_at TEXT)');
  db.prepare('INSERT INTO entries (type_name, properties_json, recorded_at) VALUES (?,?,?)').run(
    payload.type, JSON.stringify(payload.properties), payload.recordedAt,
  );
  db.close();
}
