/**
 * The ingest cursor: a per-file record of what `asc ingest claude-code` has already read in full,
 * so a later run can skip a file whole instead of streaming it again (asc-4dm.4).
 *
 * **This module only ever causes a SKIP.** It has no opinion about what gets derived or written --
 * that is `entries`' own idempotency, keyed on the event, and it holds regardless of whether a
 * single row here exists. A caller may delete the whole cursor, and the only visible effect is that
 * the next `asc ingest claude-code` reads every file instead of skipping the ones it already
 * knows -- slower, never wrong. See the 2026-09-22 measurement quoted in the ingest command: 977
 * `.jsonl` files, 1.63 GiB, 7.965 s for a full read, and only 33 of the store's `session_id`s have
 * ever produced an entry -- which is why this is a stored fact about the FILE rather than something
 * derivable from `entries`.
 *
 * **Whole files, never an offset.** A row takes the file's `mtime` and `size` as they were at the
 * moment it was read to completion; a caller (the CLI) skips a file only when BOTH still match on a
 * later run. There is no per-line or per-byte position stored here, on purpose: an offset-resume
 * would require the derive path to be provably correct on a partial read, which nothing in this
 * codebase proves, so a changed file is always re-read from its first byte.
 *
 * **The writer enforces and the reader trusts, and that asymmetry is safe rather than sloppy.** All
 * four refusals live in `writeIngestCursor` (`assertRowIsAFileThatWasRead`); `parseRow` on the way
 * back in checks only that each field has the right TYPE. It can be this cheap because the skip is a
 * three-way match: a row is used only when its `mtimeMs` and `size` equal a real `stat`'s
 * (`claude-code.ts`'s `knownFiles`), so a row the writer would have refused -- an empty path, a
 * negative size, a stale pair of numbers -- matches nothing and degrades to the re-read that a
 * missing row causes. The failure this module must not have is a WRONG skip, and no malformed row
 * can produce one.
 *
 * Time is injected, never read: `ingestedAt` is part of the row a caller hands in, matching
 * `registry.ts`'s own rule that this package never reads a clock.
 *
 * **It is a FILE beside the tree, not a row in the store (asc-i5tj.14, 2026-09-29).** Three
 * properties left it no home anywhere else:
 *
 *   - **The corpus cannot carry it.** `TypeLine | EntryLine | SchemeLine | AnnotationLine` are the
 *     four kinds, and neither this nor the handler ledger is one. `EV-34` measured the consequence
 *     on the real store: `ingest_cursor` 1,070 rows in the database and **0** in an index built
 *     from the tree, `ingest.applied_handlers` present in the store and absent from the index.
 *   - **The tree is the wrong place on purpose.** A row holds an ABSOLUTE path to a transcript in
 *     the user's home directory, plus its mtime and size. That is this machine's progress through
 *     this machine's files -- not a record -- and the tree is git-tracked and shared, so carrying
 *     it would put one developer's `~/` paths into everyone's checkout.
 *   - **The index would erase it.** The index is derived and rebuilt wholesale, and from E12.4 the
 *     write path builds one whenever the tree has moved -- a checkout, a merge, a hand edit. Rows
 *     written there would be destroyed by a routine operation, with nothing reporting it.
 *
 * So it lives at `${dir}/ingest-cursor.json`, inside `.ascend/` and gitignored, and the index stays
 * a pure function of the tree -- which is what keeps deleting it safe.
 *
 * **Both halves are one file, so they cannot disagree.** The rows and the ledger they were read
 * through used to be two writes to two places, with the rule that the second had to happen beside
 * the first. Here one write covers both.
 *
 * **The cost, stated rather than discovered: this write cannot join the entry transaction.** It is
 * a file, not a statement, so it happens after the entries commit, and a run that dies between the
 * two leaves a cursor that UNDER-claims -- the files it names were not all recorded, so the next
 * run re-reads them. The reverse order would let a cursor claim files the store holds no entries
 * for, which is the one way this module could turn a missing read into a wrong answer, so the order
 * is the fix and not an accident.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One file's recorded cursor: what its stat was, the last time it was read in full. */
export interface IngestCursorRow {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly ingestedAt: string;
}

/**
 * Everything the cursor holds: the files read in full, and the typed handlers they were read
 * through (asc-tuur.3).
 *
 * The ledger is here rather than beside a set of rows because the two are one fact. A row says a
 * file was READ, and a file read before a handler existed was never offered to it -- so a skip that
 * is correct for the deriver would silently withhold every old transcript from a new handler. An
 * EMPTY list means a full read, which is the same "absence costs time, never correctness" contract
 * the rows keep.
 */
export interface IngestCursor {
  readonly files: readonly IngestCursorRow[];
  readonly handlers: readonly string[];
}

/**
 * The cursor's file name inside the store directory. Gitignored: see this module's doc.
 *
 * Exported because `.gitignore` has to name it (`asc init` writes that list) and a second spelling
 * of it in the CLI is a file that stops being ignored the day this one is renamed.
 */
export const INGEST_CURSOR_FILE = 'ingest-cursor.json';

/** Where the cursor lives, given the store directory (`.ascend/`). */
function cursorPath(dir: string): string {
  return join(dir, INGEST_CURSOR_FILE);
}

/**
 * The stored cursor, or an empty one when nothing has been recorded.
 *
 * **Absence is the ordinary case and is not an error**: a project that has never been ingested, or
 * whose cursor was deleted, reads every file, which is the degradation this module is allowed to
 * cause. A file that is present and does NOT parse is the other case, and it is refused with the
 * remedy in the message -- an unreadable cache silently treated as empty would report a full read
 * as though it were a decision.
 */
export function readIngestCursor(dir: string): IngestCursor {
  const path = cursorPath(dir);
  if (!existsSync(path)) return { files: [], handlers: [] };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw corrupt(path, error instanceof Error ? error.message : String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw corrupt(path, error instanceof Error ? error.message : String(error));
  }

  return parseCursor(parsed, path);
}

/**
 * Replace the cursor with `cursor`.
 *
 * **Written whole, once, and atomically**: a temp file plus a rename, so a caller that dies partway
 * through leaves the previous cursor rather than half of this one. `EV-hooks` measured what the
 * alternative costs in this repository already -- a truncated file that reports nothing wrong.
 *
 * A second entry for a path REPLACES the first, because a file read again (it changed, or `--full`
 * forced it) has one current stat and not a history; two entries for one path would make the
 * caller's lookup ambiguous. The last one wins, which is the caller's order of reading.
 *
 * Callers must pass a row ONLY for a file that was actually streamed to completion: never one
 * skipped as ephemeral, a symlink, unreadable, or already unchanged, and never one whose read did
 * not finish. Recording a partially-read or never-opened file here would make a later run skip
 * exactly the bytes it never derived from -- the one way this module could turn a missing read into
 * a wrong answer instead of merely a slow one.
 *
 * **And the obligation runs the other way too, which is the half that was missing (`asc-n4eg`).**
 * This function REPLACES the cursor, so a caller must pass the rows it SKIPPED BY RELYING ON as
 * well as the rows it read -- otherwise a run that skipped 1,079 files and read one writes a
 * one-row cursor, discarding the rows that made every skip legal, and the next run has nothing to
 * skip against. Measured on the live store before the fix: rows 1,080 -> 1 across two consecutive
 * runs, with the skipped run's own warning reporting "1079 transcript file(s) unchanged ... and
 * were skipped without being opened". The SQL version could not lose them, because it was one
 * `INSERT ... ON CONFLICT DO UPDATE` per file and a row nobody mentioned was untouched; the
 * replace-a-file contract is what needs saying out loud. A caller doing a FULL read carries
 * nothing, because its rows already are the whole cursor.
 */
export function writeIngestCursor(dir: string, cursor: IngestCursor): void {
  const path = cursorPath(dir);
  const byPath = new Map<string, IngestCursorRow>();
  for (const row of cursor.files) {
    assertRowIsAFileThatWasRead(row);
    byPath.set(row.path, row);
  }

  const body = {
    files: [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    handlers: [...new Set(cursor.handlers)].sort(),
  };

  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.ascend-tmp`;
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * The four checks the `ingest_cursor` table's constraints used to make -- migration 4 of
 * `schema.ts`, deleted along with the table it built (`asc-i5tj.14`).
 *
 * They belong to the writer now that there is no schema to hold them, and they are kept rather than
 * dropped with the table because each one refuses a row that could only come from a bug: an empty
 * path names no file, an empty `ingestedAt` says nothing recorded it, and a negative `mtimeMs` or
 * `size` cannot be what a real `stat` returned. A cursor is a cache, and a cache that answers
 * `skip` from a value that never could have been read is the one failure this module must not have.
 */
function assertRowIsAFileThatWasRead(row: IngestCursorRow): void {
  if (row.path === '') throw new Error('an ingest cursor entry has an empty path');
  if (row.ingestedAt === '') {
    throw new Error(`the ingest cursor entry for '${row.path}' has an empty ingestedAt`);
  }
  if (row.mtimeMs < 0 || row.size < 0) {
    throw new Error(
      `the ingest cursor entry for '${row.path}' has a negative mtimeMs (${String(row.mtimeMs)}) ` +
        `or size (${String(row.size)}), which no file's stat can return`,
    );
  }
}

function corrupt(path: string, detail: string): Error {
  return new Error(
    `${path} is not a cursor that asc ingest claude-code wrote (${detail}). This file is a local ` +
      'cache of which transcripts have already been read, so deleting it is safe: the next ' +
      'ingest reads every transcript and writes a new one.',
  );
}

function parseCursor(parsed: unknown, path: string): IngestCursor {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw corrupt(path, 'it is not a JSON object');
  }

  const { files, handlers } = parsed as { files?: unknown; handlers?: unknown };
  if (!Array.isArray(files)) throw corrupt(path, 'it has no "files" list');
  if (!Array.isArray(handlers)) throw corrupt(path, 'it has no "handlers" list');

  return {
    files: files.map((row) => parseRow(row, path)),
    handlers: handlers.map((handler) => {
      if (typeof handler !== 'string') throw corrupt(path, 'a handler hash is not a string');
      return handler;
    }),
  };
}

function parseRow(row: unknown, path: string): IngestCursorRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw corrupt(path, 'a file entry is not a JSON object');
  }

  const { path: file, mtimeMs, size, ingestedAt } = row as Record<string, unknown>;
  if (typeof file !== 'string' || typeof ingestedAt !== 'string') {
    throw corrupt(path, 'a file entry is missing its path or its ingestedAt');
  }
  if (typeof mtimeMs !== 'number' || typeof size !== 'number') {
    throw corrupt(path, `the entry for '${file}' is missing a numeric mtimeMs or size`);
  }

  return { path: file, mtimeMs, size, ingestedAt };
}
