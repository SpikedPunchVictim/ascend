/**
 * The `ingest_cursor` table (schema.ts migration 4): a stored, per-file record of what
 * `asc ingest claude-code` has already read in full, so a later run can skip a file whole
 * instead of streaming it again (asc-4dm.4).
 *
 * **This module only ever causes a SKIP.** It has no opinion about what gets derived or
 * written -- that is `entries`' own idempotency, keyed on the event, and it holds regardless of
 * whether a single row here exists. A caller may delete every row, or run against a store that
 * predates migration 4, and the only visible effect is that the next `asc ingest claude-code`
 * reads every file instead of skipping the ones it already knows -- slower, never wrong. See
 * `INGEST_CURSOR`'s own doc (schema.ts) for the measurement that makes this a stored fact about
 * the FILE rather than something derived from `entries`.
 *
 * **Whole files, never an offset.** `recordIngestCursor` takes the file's `mtime` and `size` as
 * they were at the moment it was read to completion; a caller (the CLI) skips a file only when
 * BOTH still match on a later run. There is no per-line or per-byte position stored here, on
 * purpose: an offset-resume would require the derive path to be provably correct on a partial
 * read, which nothing in this codebase proves, so a changed file is always re-read from its
 * first byte.
 *
 * Time is injected, never read: `ingestedAt` is a parameter, matching `registry.ts`'s own rule
 * that this package never reads a clock -- `recorder.test.ts` scans `src` for exactly that.
 */

import type { DatabaseSync } from 'node:sqlite';

/** One file's recorded cursor: what its stat was, the last time it was read in full. */
export interface IngestCursorRow {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ingestedAt: string;
}

/**
 * Every recorded cursor row, in no particular order -- a caller keys them by `path` itself
 * (`asc ingest claude-code` builds a `Map` from this).
 */
export function ingestCursorRows(db: DatabaseSync): readonly IngestCursorRow[] {
  const rows = db
    .prepare(`SELECT path, mtime_ms AS mtimeMs, size, ingested_at AS ingestedAt FROM ingest_cursor`)
    .all() as unknown as { path: string; mtimeMs: number; size: number; ingestedAt: string }[];
  return rows.map((row) => ({
    path: row.path,
    mtimeMs: row.mtimeMs,
    size: row.size,
    ingestedAt: row.ingestedAt,
  }));
}

/**
 * Record (or update) one file's cursor.
 *
 * `path` is the primary key, so a file read a second time -- because it changed, or because
 * `--full` forced it -- replaces its own row rather than accumulating a history. Callers must
 * write this ONLY for a file that was actually streamed to completion: never for one skipped as
 * ephemeral, a symlink, unreadable, or already unchanged, and never for one whose read did not
 * finish. Recording a partially-read or never-opened file here would make a later run skip
 * exactly the bytes it never derived from -- the one way this table could turn a missing read
 * into a wrong answer instead of merely a slow one.
 */
export function recordIngestCursor(
  db: DatabaseSync,
  path: string,
  mtimeMs: number,
  size: number,
  ingestedAt: string,
): void {
  db.prepare(
    `INSERT INTO ingest_cursor (path, mtime_ms, size, ingested_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET
         mtime_ms = excluded.mtime_ms,
         size = excluded.size,
         ingested_at = excluded.ingested_at`,
  ).run(path, mtimeMs, size, ingestedAt);
}

/** The `meta` key holding the typed handlers every cursor row has already been read through. */
const APPLIED_HANDLERS = 'ingest.applied_handlers';

/**
 * The hashes of the typed handlers (asc-tuur.3) the cursor's files have been read through.
 *
 * The cursor says a file was READ, and a file read before a handler existed was never offered to
 * it -- so a skip that is correct for the deriver would silently withhold every old transcript
 * from a new handler. The caller compares its handlers' hashes against this set and reads every
 * file when one is new, which is the same "absence costs time, never correctness" contract the
 * cursor already keeps: an empty set means a full read, never a missed one.
 */
export function appliedHandlerHashes(db: DatabaseSync): ReadonlySet<string> {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(APPLIED_HANDLERS) as
    { value: string } | undefined;
  if (row === undefined) return new Set();
  const parsed: unknown = JSON.parse(row.value);
  if (!Array.isArray(parsed) || !parsed.every((one) => typeof one === 'string')) {
    throw new Error(
      `meta ${APPLIED_HANDLERS} is ${row.value}, not a list of handler hashes -- the store was ` +
        'edited by something other than asc ingest claude-code.',
    );
  }
  return new Set(parsed);
}

/**
 * Replace the applied set. Call it inside the same transaction as the cursor rows it vouches
 * for, so a dry run's rollback discards both together.
 */
export function recordAppliedHandlers(db: DatabaseSync, hashes: Iterable<string>): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(APPLIED_HANDLERS, JSON.stringify([...new Set(hashes)].sort()));
}
