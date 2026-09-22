/**
 * Streaming, read-only access to Claude Code session transcripts.
 *
 * READ-ONLY. Nothing in this package opens a transcript for writing, creates a
 * file under the root, or renames one. `~/.claude/projects` is the user's own
 * session history and ascend is a guest in it -- a single stray write would
 * corrupt a record the user cannot regenerate. `reader-source.test.ts` turns
 * that promise into a check: it scans these modules for write-capable `fs` calls
 * and fails if one appears.
 *
 * MEMORY-BOUNDED. 1.19 GiB of JSONL is never resident. The bytes arrive as a
 * stream, are decoded one line at a time, and each decoded record is handed to
 * the caller and dropped. The only thing that grows with the corpus is the list
 * of file PATHS (843 of them) -- O(files), not O(bytes). Measured 2026-09-15 end
 * to end: 843 files, 429,783 records, 1,275,740,293 bytes in 6.2 s, peak RSS
 * 234.0 MB against a 46.3 MB baseline -- a 187.6 MB delta, 15.4% of the input,
 * and the largest single file is 107.5 MB, which is the real ceiling on one
 * record's size. `reader-real-corpus.test.ts` re-measures that bound instead of
 * trusting it.
 *
 * SELF-HEALING. A malformed line, an unreadable file, an unreadable directory:
 * each is COUNTED and skipped, never fatal. This is align's rule -- advisory
 * analysis must never crash the thing it observes -- and it is not a nicety
 * here: the corpus is a live directory being appended to by other processes as
 * we read it, so a truncated final line is expected, routine traffic.
 *
 * `\n` IS THE ONLY TERMINATOR, and this is why `node:readline` is not used
 * here. readline additionally treats CARRIAGE RETURN, U+2028 (LINE SEPARATOR)
 * and U+2029 (PARAGRAPH SEPARATOR) as line breaks. The last two are ordinary
 * characters inside a JSON string -- they need no escaping -- so a record whose
 * text contains one is a legal JSONL line that readline SPLITS. The fragments
 * are then not-valid-JSON, and a reader built on readline reports them as
 * damage. Measured on the live corpus: one subagent transcript holding 205 `\n`
 * also held 13 U+2028 and 7 U+2029, readline yielded 225 lines for those 205
 * records, and splitting the same bytes on `\n` alone yielded ZERO malformed
 * lines against readline's 25. The bug is silent and one-directional -- the
 * reader UNDER-counts records and OVER-reports corruption, so a derived type
 * would be measured against a corpus that had quietly lost rows.
 *
 * The one thing that DOES propagate is an exception thrown by the caller's own
 * `visit` callback. That is a bug in the consumer, not damage in the transcript,
 * and swallowing it would turn a broken derived type into a quietly empty
 * corpus -- a false green, the failure class this project treats as
 * severity-zero. The asymmetry is deliberate; see `Visit`.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { decodeLine, type TranscriptRecord } from './decode.js';
import { isEphemeralProject } from './ephemeral.js';
import { defaultTranscriptRoot } from './transcript-root.js';
import {
  JSONL_SUFFIX,
  classifyTranscript,
  type TranscriptFile,
  type TranscriptKind,
} from './transcript-file.js';

/**
 * Called once per decoded record, in file order.
 *
 * Exceptions PROPAGATE out of the sweep. This is the module's one non-tolerant
 * path and it is intentional: the consumer knows something this module does not
 * (that a record violates an invariant, say), and a reader that swallowed it
 * would report a small clean corpus where the truth is a large broken one.
 *
 * Positional rather than a context object because this runs once per line --
 * 425,234 times on the 2026-09-15 corpus -- and `file` is already the per-file
 * context, shared across every record in it.
 */
export type Visit = (record: TranscriptRecord, file: TranscriptFile, line: number) => void;

/**
 * `'unchanged'` (asc-4dm.4): the file's `mtime` AND `size` both matched a stat the caller passed
 * in via `CorpusOptions.knownFiles`, so it was never opened at all -- the whole-file skip that
 * makes a re-run of an unchanged corpus approach the cost of a stat-only walk instead of a full
 * read. Decided here, at the same layer that already decides `'ephemeral'`, rather than by the
 * caller re-implementing the walk: the caller supplies what it already knows (a stored cursor),
 * this module is the one place that knows the actual stat.
 */
export type SkipReason = 'unreadable' | 'symlink' | 'ephemeral' | 'unchanged';

/**
 * A path the sweep deliberately did not read. Never silent -- always reported.
 *
 * `project` is present ONLY for `reason: 'ephemeral'`, and omitted -- never `undefined` --
 * otherwise: `exactOptionalPropertyTypes` makes that the compiler's rule rather than a
 * convention, and it is the label a caller needs to name what was skipped (`asc ingest
 * claude-code`'s report groups on it).
 */
export interface SkippedEntry {
  readonly path: string;
  readonly reason: SkipReason;
  readonly project?: string;
}

export interface ScanResult {
  /** Sorted by path, so two sweeps of an unchanged corpus agree exactly. */
  readonly files: readonly TranscriptFile[];
  readonly skipped: readonly SkippedEntry[];
}

export interface TranscriptCounters {
  readonly lines: number;
  /** Lines that decoded to a record. */
  readonly parsed: number;
  /** Blank lines. Counted, and NOT a defect. */
  readonly empty: number;
  /** Lines that were not decodable. See `DecodeFailure`. */
  readonly malformed: number;
  /**
   * Exact bytes read, counted off the byte stream rather than reconstructed
   * from the decoded lines.
   *
   * This is a correction to the spike, which summed `line.length + 1`. `length`
   * is UTF-16 code units, not bytes, so that undercounts every non-ASCII line
   * and omits the final line's terminator. Measured on a 33-byte file containing
   * one 3-byte character, the spike's arithmetic reports 31.
   */
  readonly bytes: number;
  /** True when the file was not read to its end. */
  readonly incomplete: boolean;
  /** Why, when knowable: an errno code, or `'aborted'`. `null` when complete. */
  readonly reason: string | null;
}

export interface StreamOptions {
  /** Stop at the next line boundary. Partial counters are still returned. */
  readonly signal?: AbortSignal;
}

export interface TranscriptFailure {
  readonly path: string;
  readonly reason: string;
  /** Lines decoded before the failure. Partial data is still real data. */
  readonly parsed: number;
}

export interface CorpusTotals {
  /** Transcripts discovered, whether or not they could be read. */
  readonly files: number;
  readonly lines: number;
  readonly parsed: number;
  readonly empty: number;
  readonly malformed: number;
  readonly bytes: number;
  /** Files that could not be read to the end. Never fatal. */
  readonly failures: readonly TranscriptFailure[];
  /**
   * Everything the sweep deliberately did not read: directories not descended into, symlinks
   * not followed, transcripts under a known OS temp root unless `includeEphemeral` asked
   * otherwise (`asc-80m`), and -- when `knownFiles` was passed -- a file whose stat exactly
   * matched it (`asc-4dm.4`). Four different facts sharing one array, which is why
   * `SkippedEntry` carries the `reason` that tells them apart: a caller that reports the length
   * alone would describe a deliberate exclusion as damage to the walk.
   */
  readonly skipped: readonly SkippedEntry[];
  /** True when a signal stopped the sweep early: the totals are then PARTIAL. */
  readonly aborted: boolean;
}

/** One file's stat, as far as this module needs it: enough to tell "unchanged" from "changed". */
export interface FileStat {
  readonly mtimeMs: number;
  readonly size: number;
}

export interface CorpusOptions {
  /** Defaults to `~/.claude/projects`. */
  readonly root?: string;
  readonly signal?: AbortSignal;
  /** See `ScanOptions`. Defaults to `false`, and is passed straight through to `scanTranscripts`. */
  readonly includeEphemeral?: boolean;
  /**
   * A stored cursor, keyed by absolute path (asc-4dm.4). A file whose CURRENT `mtime` and `size`
   * both equal the entry recorded here is skipped whole -- never opened -- and reported as
   * `SkippedEntry` with `reason: 'unchanged'`. A file with no entry, or one whose stat no longer
   * matches, is read exactly as it would be with no cursor at all.
   *
   * Omit this (the default) to read every file, matching this module's behaviour before
   * asc-4dm.4. A missing or stale entry only ever costs a re-read -- it can never suppress or
   * alter what a file yields, because it only ever chooses NOT to open a file, never what is done
   * with one that is opened.
   */
  readonly knownFiles?: ReadonlyMap<string, FileStat>;
  /**
   * Called once, synchronously, for every file this sweep actually streamed TO COMPLETION --
   * i.e. `TranscriptCounters.incomplete` was `false`. Never called for a file this sweep skipped
   * for any reason (`'unreadable'`, `'symlink'`, `'ephemeral'`, `'unchanged'`), and never for one
   * whose read did not finish, so a caller building a cursor from this callback cannot record a
   * file it never fully derived from.
   */
  readonly onFileRead?: (file: TranscriptFile, stat: FileStat) => void;
}

export interface ScanOptions {
  /**
   * Read transcripts under a known OS temp root (`ephemeral.ts`) instead of skipping them.
   *
   * Defaults to `false`. These projects can never recur -- the directory was a benchmark run's
   * throwaway `os.tmpdir()`, gone the moment the process that made it exited -- so by default
   * they are counted and reported (`reason: 'ephemeral'`) rather than silently read, the same
   * "never silent" treatment this module already gives a symlink or an unreadable directory.
   */
  readonly includeEphemeral?: boolean;
}

/**
 * Every `.jsonl` under `root`, recursively.
 *
 * Three deliberate non-behaviours, all REPORTED rather than silent:
 *
 * - Symlinks are not followed, of either kind. Following one could walk out of
 *   the root or loop forever, and the root is a boundary ascend should respect.
 *   Measured 2026-09-15: there are zero symlinks in the corpus, so this costs
 *   nothing today -- it exists so that a future one is visible instead of
 *   silently doubling or dropping a session.
 * - An unreadable directory is recorded and the walk continues. One directory
 *   the user cannot read must not abort a sweep of 843 files.
 * - A project under a known OS temp root (`ephemeral.ts`) is skipped by default,
 *   `asc-80m`: a directory that can never recur is a permanent singleton stratum
 *   in project-keyed analysis, so it is excluded unless `includeEphemeral` asks
 *   for it -- and even then it is a decision this function reports, not one it
 *   makes invisibly. Measured on the live corpus 2026-09-18: 5 of 879 files.
 *
 * No depth limit: recursion is async, so depth costs no stack, and a limit
 * would be an invented constant guarding against a cycle that symlink-skipping
 * already makes unreachable.
 */
export async function scanTranscripts(
  root: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const includeEphemeral = options.includeEphemeral ?? false;
  const files: TranscriptFile[] = [];
  const skipped: SkippedEntry[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skipped.push({ path: directory, reason: 'unreadable' });
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path, reason: 'symlink' });
      } else if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(JSONL_SUFFIX)) {
        // Classified BEFORE the ephemeral check, deliberately: the check needs the project
        // label, and `classifyTranscript` is what reads it off the path. Note that the
        // `unclassified` fallback labels a file with `basename(root)` -- which carries no
        // leading `-` and so can never match `isEphemeralProject` -- and that is correct: a
        // path not under the root is a different, already-reported problem
        // (`kind: 'unclassified'`), not an ephemeral one.
        const file = classifyTranscript(root, path);
        if (!includeEphemeral && isEphemeralProject(file.project)) {
          skipped.push({ path, reason: 'ephemeral', project: file.project });
        } else {
          files.push(file);
        }
      }
    }
  };

  await walk(root);

  // Compared with `<`/`>` rather than `localeCompare`, which is locale-dependent:
  // two users with different `LANG` would otherwise sweep the same corpus in
  // different orders, and an ingest whose order varies by environment is not
  // reproducible.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, skipped };
}

/**
 * Stream one transcript, handing each decoded record to `visit`.
 *
 * Never throws on account of the transcript. Throws only if `visit` throws.
 */
export async function streamTranscript(
  file: TranscriptFile,
  visit: Visit,
  options: StreamOptions = {},
): Promise<TranscriptCounters> {
  let lines = 0;
  let parsed = 0;
  let empty = 0;
  let malformed = 0;
  let bytes = 0;
  let incomplete = false;
  let reason: string | null = null;

  const source = createReadStream(file.path);
  const decoder = new StringDecoder('utf8');

  // Holds the tail of a line that has not yet met its terminator -- either
  // because the chunk ended or because the character is still incomplete. A
  // single record can therefore span many chunks without ever being resident
  // whole, which is what keeps this O(1) in file size.
  let carry = '';

  // The consumer's failure is held in an OBJECT rather than a pair of `let`s,
  // and that is a type-system fact rather than a style choice. TypeScript's
  // control-flow analysis does not follow assignments made inside a closure, so
  // a plain `let visitorThrew = false` stays narrowed to the literal `false` at
  // the throw below -- `no-unnecessary-condition` then reports the check as dead
  // code, correctly, because from the analyser's view it is. A property read is
  // re-widened by the intervening call to `consume`, which is the truth.
  const outcome: { failed: boolean; error: unknown } = { failed: false, error: undefined };

  let stopped = false;

  /**
   * Handle one complete line. Returns false when the sweep must stop.
   *
   * The abort check lives HERE, per line, rather than only at the chunk
   * boundary: a chunk is up to 64 KB and can hold hundreds of records, so
   * checking once per chunk would honour Ctrl-C only after consuming all of
   * them -- and `streamCorpus`'s callers count on an abort leaving the counters
   * at exactly the record where they stopped.
   */
  const consume = (line: string): boolean => {
    if (options.signal?.aborted === true) {
      incomplete = true;
      reason = 'aborted';
      return false;
    }

    lines += 1;
    const decoded = decodeLine(line);
    if (!decoded.ok) {
      if (decoded.failure === 'empty') empty += 1;
      else malformed += 1;
      return true;
    }
    parsed += 1;

    try {
      visit(decoded.record, file, lines);
    } catch (error) {
      // Captured, not swallowed: the sweep stops here so the stream can be
      // torn down cleanly, and the error is rethrown below. Letting it fall
      // into the catch that follows would classify a consumer bug as
      // transcript damage -- the exact confusion this module must not make.
      outcome.failed = true;
      outcome.error = error;
      return false;
    }
    return true;
  };

  try {
    // Iterated rather than piped. `pipe` does NOT forward `error` events, so
    // routing the bytes through a Transform to count them meant an unopenable
    // transcript emitted an unhandled 'error' on the source stream and took the
    // whole process down -- invisible to the try/catch below, because the error
    // never reached the iterator. Counting bytes in this loop instead removes
    // the intermediate stream and the whole failure mode with it. (Found by
    // test, not by reading.)
    const chunks: AsyncIterable<Buffer> = source;

    for await (const chunk of chunks) {
      // Exact, and deliberately not reconstructed from the decoded string: an
      // invalid byte becomes U+FFFD, which re-encodes to 3 bytes, so summing
      // `Buffer.byteLength(decode(chunk))` would drift on exactly the damaged
      // input this counter exists to characterise.
      bytes += chunk.length;
      carry += decoder.write(chunk);

      let terminator = carry.indexOf('\n');
      while (terminator !== -1) {
        const line = carry.slice(0, terminator);
        carry = carry.slice(terminator + 1);
        if (!consume(line)) {
          stopped = true;
          break;
        }
        terminator = carry.indexOf('\n');
      }

      if (stopped) break;
    }

    if (!stopped) {
      // Flushes a multi-byte character the final chunk cut in half. Only on a
      // clean end: after a stop or a failure there is nothing more to read, and
      // emitting one last line would break the abort contract above.
      carry += decoder.end();
      if (carry.length > 0) consume(carry);
    }
  } catch (error) {
    // ENOENT, EISDIR, EACCES, or a stream torn down mid-file. Recorded, never
    // fatal: one unreadable file must not abort a sweep.
    incomplete = true;
    reason = errorCode(error);
  } finally {
    // Load-bearing, not hygiene. Measured on the readline version: an early
    // exit left the fd open until GC reclaimed it -- 400 short reads left 11 fds
    // open and reclamation lagged the sweep. Across 843 files that is an EMFILE
    // waiting to happen. `reader-fd` test pins it.
    source.destroy();
  }

  if (outcome.failed) throw outcome.error;

  return { lines, parsed, empty, malformed, bytes, incomplete, reason };
}

/**
 * Stream every transcript under `root`, in sorted path order.
 *
 * Sequential by construction. Reading files concurrently would make "how many
 * are left" depend on I/O scheduling, and the peak memory of N open streams is
 * N times the chunk buffer -- both worth less than the wall clock.
 */
export async function streamCorpus(
  visit: Visit,
  options: CorpusOptions = {},
): Promise<CorpusTotals> {
  const root = options.root ?? defaultTranscriptRoot();
  const scan = await scanTranscripts(root, { includeEphemeral: options.includeEphemeral ?? false });

  let lines = 0;
  let parsed = 0;
  let empty = 0;
  let malformed = 0;
  let bytes = 0;
  let aborted = false;
  const failures: TranscriptFailure[] = [];
  const unchanged: SkippedEntry[] = [];

  // A stat costs a syscall per file, so it is taken only when a caller actually asked for
  // something that needs one -- a cursor to compare against, or a callback that wants to build
  // one. Neither is set for the plain `streamCorpus(visit)` call every existing caller (and
  // every test that predates asc-4dm.4) already makes, so that path takes zero extra stats.
  const wantsStat = options.knownFiles !== undefined || options.onFileRead !== undefined;

  for (const file of scan.files) {
    if (options.signal?.aborted === true) {
      aborted = true;
      break;
    }

    let currentStat: FileStat | undefined;
    if (wantsStat) {
      try {
        const info = await stat(file.path);
        currentStat = { mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        // Unreadable, or removed between the walk and here. Fall through and let
        // `streamTranscript` below report the real failure the way it always has -- this is not
        // the place that turns a stat failure into a diagnosis.
        currentStat = undefined;
      }
    }

    if (options.knownFiles !== undefined && currentStat !== undefined) {
      const known = options.knownFiles.get(file.path);
      if (
        known !== undefined &&
        known.mtimeMs === currentStat.mtimeMs &&
        known.size === currentStat.size
      ) {
        unchanged.push({ path: file.path, reason: 'unchanged' });
        continue;
      }
    }

    const counters = await streamTranscript(file, visit, options);
    lines += counters.lines;
    parsed += counters.parsed;
    empty += counters.empty;
    malformed += counters.malformed;
    bytes += counters.bytes;

    if (counters.incomplete) {
      // An abort is not a failure -- it is the caller's instruction, and the
      // remaining files were never opened. Only real damage is recorded.
      if (counters.reason === 'aborted') aborted = true;
      else
        failures.push({
          path: file.path,
          reason: counters.reason ?? 'incomplete',
          parsed: counters.parsed,
        });
    } else if (currentStat !== undefined) {
      // Read to completion, and only now: a file that failed partway must not reach a caller's
      // cursor, or a later run would skip exactly the bytes this run never derived from.
      options.onFileRead?.(file, currentStat);
    }
  }

  return {
    files: scan.files.length,
    lines,
    parsed,
    empty,
    malformed,
    bytes,
    failures,
    // `scan.skipped` (directories, symlinks, ephemeral projects) is decided during the WALK;
    // `unchanged` is decided here, per file, against the caller's cursor. Both are "a path the
    // sweep deliberately did not read" (`CorpusTotals.skipped`'s own doc), so they share one
    // array rather than a second one a caller would have to remember to check.
    skipped: [...scan.skipped, ...unchanged],
    aborted,
  };
}

/** The errno code when there is one, so the counter says WHY rather than just `true`. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

export type { TranscriptFile, TranscriptKind };
