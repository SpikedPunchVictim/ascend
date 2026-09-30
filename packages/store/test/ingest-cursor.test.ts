import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, readIngestCursor, writeIngestCursor, type IngestCursor } from '../src/index.js';
import { LEGACY_INGEST_CURSOR_DDL } from './legacy-store.js';

/**
 * The ingest cursor, which is a JSON file beside the tree and not a table (`asc-i5tj.14`,
 * 2026-09-29).
 *
 * **This file used to assert `CHECK constraint failed`, and its header said why: the guarantees
 * were schema facts, so a `:memory:` database would prove nothing.** Half of that is still true and
 * worth keeping: the four refusals did not disappear with the table, they moved into the writer,
 * and they are tested here as the writer's own errors rather than dropped. The other half is now
 * false -- there is no schema -- which is why the tests below reach for the FILE: they assert what
 * is on disk, so that "atomic" and "one entry per path" are claims about bytes rather than about an
 * API's return value.
 *
 * The one thing deliberately NOT tested here is the CLI's use of any of this; `ingest.test.ts`
 * covers the integration, including the property that deleting the cursor reproduces the same
 * entries.
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

const AT = '2026-09-22T00:00:00.000Z';

const row = (path: string, mtimeMs = 1_000, size = 42, ingestedAt = AT) => ({
  path,
  mtimeMs,
  size,
  ingestedAt,
});

/** What is actually on disk for `dir`, as text -- the file this module is. */
const onDisk = (dir: string): string => readFileSync(join(dir, 'ingest-cursor.json'), 'utf8');

describe('a cursor that has never been written', () => {
  it('reads as empty, which means read every file', () => {
    expect(readIngestCursor(tempDir())).toEqual({ files: [], handlers: [] });
  });

  it('reads as empty even where the directory does not exist yet', () => {
    expect(readIngestCursor(join(tempDir(), 'nothing', 'here'))).toEqual({
      files: [],
      handlers: [],
    });
  });

  it('is not read from the SQLite store that used to hold it', () => {
    // The pre-2026-09-29 home. A store carrying rows there has never been ingested as far as this
    // module is concerned, so the first run after the change re-reads the corpus once and writes a
    // cursor -- time, not correctness, which is this module's whole contract. Read rather than
    // assumed: leaving the table populated and getting rows back would be the silent case.
    const dir = tempDir();
    const store = openStore({ dir });
    try {
      // The fixture stands the table up itself, because the current schema no longer creates it
      // (`asc-i5tj.14`). It is still worth asserting against: this is the store a pre-cutover user
      // upgrading would have, and it is the one case where a real cursor exists on disk and must be
      // ignored.
      store.db.exec(LEGACY_INGEST_CURSOR_DDL);
      store.db
        .prepare(
          'INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at) VALUES (?, ?, ?, ?)',
        )
        .run('/a/b.jsonl', 1_000, 42, AT);
      store.db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('ingest.applied_handlers', '["a"]');
    } finally {
      store.close();
    }

    expect(readIngestCursor(dir)).toEqual({ files: [], handlers: [] });
  });
});

describe('round-tripping a cursor', () => {
  it('reads back a row, exactly as written', () => {
    const dir = tempDir();
    writeIngestCursor(dir, { files: [row('/a/b.jsonl')], handlers: [] });
    expect(readIngestCursor(dir)).toEqual({ files: [row('/a/b.jsonl')], handlers: [] });
  });

  it('creates the store directory when it is not there', () => {
    const dir = join(tempDir(), '.ascend');
    writeIngestCursor(dir, { files: [row('/a/b.jsonl')], handlers: [] });
    expect(readIngestCursor(dir).files).toEqual([row('/a/b.jsonl')]);
  });

  it('leaves no temporary file behind, because the write is a rename', () => {
    const dir = tempDir();
    writeIngestCursor(dir, { files: [row('/a/b.jsonl')], handlers: [] });
    writeIngestCursor(dir, { files: [row('/a/c.jsonl')], handlers: ['a'] });

    expect(readdirSync(dir)).toEqual(['ingest-cursor.json']);
  });

  it('replaces a path rather than accumulating a history of it', () => {
    // A file read a second time -- because it changed, or because `--full` forced it -- has one
    // current stat. Two entries for one path would make the CLI's lookup ambiguous.
    const dir = tempDir();
    writeIngestCursor(dir, { files: [row('/a/b.jsonl', 1_000, 42)], handlers: [] });
    writeIngestCursor(dir, {
      files: [row('/a/b.jsonl', 2_000, 99, '2026-09-22T01:00:00.000Z')],
      handlers: [],
    });

    expect(readIngestCursor(dir).files).toEqual([
      row('/a/b.jsonl', 2_000, 99, '2026-09-22T01:00:00.000Z'),
    ]);
  });

  it('keeps one entry per distinct path, sorted, so the file has one spelling', () => {
    const dir = tempDir();
    writeIngestCursor(dir, {
      files: [row('/a/two.jsonl'), row('/a/one.jsonl')],
      handlers: [],
    });

    // Sorted on the way out as well as on the way in: the file is bytes, and two runs over the
    // same set of files must produce the same bytes or every ingest is a diff.
    expect(readIngestCursor(dir).files.map((one) => one.path)).toEqual([
      '/a/one.jsonl',
      '/a/two.jsonl',
    ]);
    expect(onDisk(dir)).toBe(
      `${JSON.stringify(
        { files: [row('/a/one.jsonl'), row('/a/two.jsonl')], handlers: [] },
        null,
        2,
      )}\n`,
    );
  });

  it('deduplicates and sorts the handlers, which are a set and not a log', () => {
    const dir = tempDir();
    writeIngestCursor(dir, { files: [], handlers: ['b', 'a'] });
    writeIngestCursor(dir, { files: [], handlers: ['c', 'a', 'c'] });

    expect(readIngestCursor(dir).handlers).toEqual(['a', 'c']);
  });

  it('keeps the files and the handlers in ONE file, so they cannot disagree', () => {
    // They were two writes to two places (a table and a `meta` key) with a rule that the second had
    // to sit beside the first. Here there is nothing to keep in step.
    const dir = tempDir();
    writeIngestCursor(dir, { files: [row('/a/b.jsonl')], handlers: ['a'] });
    expect(readdirSync(dir)).toEqual(['ingest-cursor.json']);
    expect(readIngestCursor(dir)).toEqual({ files: [row('/a/b.jsonl')], handlers: ['a'] });
  });
});

describe('the four refusals the table’s constraints used to make', () => {
  // Kept rather than dropped with the table, because each refuses a value that could only come from
  // a bug -- and a cache that answers "skip" from a value no real `stat` could return is the one
  // failure this module must not have.
  it('refuses an empty path', () => {
    expect(() => {
      writeIngestCursor(tempDir(), { files: [row('')], handlers: [] });
    }).toThrow(/empty path/);
  });

  it('refuses an empty ingestedAt', () => {
    expect(() => {
      writeIngestCursor(tempDir(), { files: [row('/a/b.jsonl', 1, 1, '')], handlers: [] });
    }).toThrow(/empty ingestedAt/);
  });

  it('refuses a negative mtimeMs or size', () => {
    expect(() => {
      writeIngestCursor(tempDir(), { files: [row('/a/b.jsonl', -1, 1)], handlers: [] });
    }).toThrow(/negative mtimeMs \(-1\) or size \(1\)/);
    expect(() => {
      writeIngestCursor(tempDir(), { files: [row('/a/b.jsonl', 1, -1)], handlers: [] });
    }).toThrow(/negative mtimeMs \(1\) or size \(-1\)/);
  });

  it('refuses the whole write rather than writing the rows that were fine', () => {
    const dir = tempDir();
    expect(() => {
      writeIngestCursor(dir, { files: [row('/a/ok.jsonl'), row('')], handlers: [] });
    }).toThrow(/empty path/);
    expect(readIngestCursor(dir)).toEqual({ files: [], handlers: [] });
  });
});

describe('a file that is present and does not parse', () => {
  // Absence is the ordinary case; this is the other one. An unreadable cache silently read as empty
  // would report a full read as though it were a decision, which is why the message names the file
  // and says deleting it is safe.
  const refuses = (content: string): (() => IngestCursor) => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ingest-cursor.json'), content);
    return () => readIngestCursor(dir);
  };

  it('is refused, naming the file and the remedy', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ingest-cursor.json'), 'not json at all');
    expect(() => readIngestCursor(dir)).toThrow(
      /is not a cursor that asc ingest claude-code wrote/,
    );
    expect(() => readIngestCursor(dir)).toThrow(/deleting it is safe/);
  });

  it('is refused when it is not an object', () => {
    expect(refuses('[1, 2]')).toThrow(/it is not a JSON object/);
    expect(refuses('"a string"')).toThrow(/it is not a JSON object/);
  });

  it('is refused when a half is missing or the wrong shape', () => {
    expect(refuses('{"handlers":[]}')).toThrow(/"files" list/);
    expect(refuses('{"files":[]}')).toThrow(/"handlers" list/);
    expect(refuses('{"files":{},"handlers":[]}')).toThrow(/"files" list/);
  });

  it('is refused when a file entry is not a row of the right shape', () => {
    expect(refuses('{"files":[1],"handlers":[]}')).toThrow(/not a JSON object/);
    expect(refuses('{"files":[{"mtimeMs":1,"size":2}],"handlers":[]}')).toThrow(
      /missing its path or its ingestedAt/,
    );
    expect(refuses('{"files":[{"path":"/a","ingestedAt":"x"}],"handlers":[]}')).toThrow(
      /missing a numeric mtimeMs or size/,
    );
    expect(
      refuses('{"files":[{"path":"/a","ingestedAt":"x","mtimeMs":"1","size":2}],"handlers":[]}'),
    ).toThrow(/missing a numeric mtimeMs or size/);
  });

  it('is refused when a handler is not a string', () => {
    expect(refuses('{"files":[],"handlers":[{"hash":"a"}]}')).toThrow(/not a string/);
  });
});
