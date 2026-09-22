import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestCursorRows, openStore, recordIngestCursor } from '../src/index.js';

/**
 * `ingest_cursor` (schema.ts migration 4, asc-4dm.4), tested against a real file-backed store --
 * same reasoning as `schema.test.ts`'s own header: the guarantees this table rests on (the
 * CHECK constraints, the PRIMARY KEY upsert) are schema facts, not application logic, so a
 * `:memory:` database would prove nothing an in-process mock could not already fake.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-cursor-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('ingest_cursor: read/write', () => {
  it('round-trips a recorded row', () => {
    const store = openStore({ dir: tempDir() });
    try {
      recordIngestCursor(store.db, '/a/b.jsonl', 1_000, 42, '2026-09-22T00:00:00.000Z');
      const rows = ingestCursorRows(store.db);
      expect(rows).toEqual([
        {
          path: '/a/b.jsonl',
          mtimeMs: 1_000,
          size: 42,
          ingestedAt: '2026-09-22T00:00:00.000Z',
        },
      ]);
    } finally {
      store.close();
    }
  });

  it('starts empty on a fresh store', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(ingestCursorRows(store.db)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('upserts by path rather than accumulating a history', () => {
    // A file read a second time -- because it changed, or because `--full` forced it -- replaces
    // its own row. Two rows for one path would make `asc ingest claude-code`'s lookup ambiguous.
    const store = openStore({ dir: tempDir() });
    try {
      recordIngestCursor(store.db, '/a/b.jsonl', 1_000, 42, '2026-09-22T00:00:00.000Z');
      recordIngestCursor(store.db, '/a/b.jsonl', 2_000, 99, '2026-09-22T01:00:00.000Z');

      const rows = ingestCursorRows(store.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        path: '/a/b.jsonl',
        mtimeMs: 2_000,
        size: 99,
        ingestedAt: '2026-09-22T01:00:00.000Z',
      });
    } finally {
      store.close();
    }
  });

  it('keeps one row per distinct path', () => {
    const store = openStore({ dir: tempDir() });
    try {
      recordIngestCursor(store.db, '/a/one.jsonl', 1, 1, '2026-09-22T00:00:00.000Z');
      recordIngestCursor(store.db, '/a/two.jsonl', 2, 2, '2026-09-22T00:00:00.000Z');

      const paths = ingestCursorRows(store.db)
        .map((row) => row.path)
        .sort();
      expect(paths).toEqual(['/a/one.jsonl', '/a/two.jsonl']);
    } finally {
      store.close();
    }
  });
});

describe('ingest_cursor: schema constraints (no empty-string sentinels)', () => {
  it('rejects an empty path', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(() => {
        recordIngestCursor(store.db, '', 1, 1, '2026-09-22T00:00:00.000Z');
      }).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it('rejects an empty ingested_at', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(() => {
        recordIngestCursor(store.db, '/a/b.jsonl', 1, 1, '');
      }).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it('rejects a negative mtime_ms or size', () => {
    const store = openStore({ dir: tempDir() });
    try {
      expect(() => {
        recordIngestCursor(store.db, '/a/b.jsonl', -1, 1, '2026-09-22T00:00:00.000Z');
      }).toThrow(/CHECK constraint failed/);
      expect(() => {
        recordIngestCursor(store.db, '/a/b.jsonl', 1, -1, '2026-09-22T00:00:00.000Z');
      }).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });
});
