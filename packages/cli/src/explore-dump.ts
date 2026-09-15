/**
 * `asc explore --dump <dir>` -- a type's entries as many files, plus an index of them.
 *
 * **The problem this solves is that a corpus does not fit in a context window, and reading it
 * anyway is the failure mode.** A model handed 486 entries reads the first forty and writes "most
 * entries show X". `--max-tokens` answers that by showing fewer rows; this answers it by putting the
 * rows where they cost nothing until asked for -- on disk -- and shipping a summary cheap enough to
 * read INSTEAD of them.
 *
 * **A file holds a CHUNK, not an entry, and that was decided by measurement rather than by taste.**
 * The obvious design is one file per entry, which makes the manifest a list of every entry. Measured
 * on the frozen EV-11 corpus (`verification_run`, 486 entries, 93,604 tokens of entry data): a
 * one-entry-per-file manifest is **44,805 tokens**, which is 47.8% of the dump it exists to avoid
 * reading. A manifest of 13 chunks is **1,295 tokens** -- 34.6x cheaper -- and chunking is also the
 * only reading under which the spec's "count" per file means anything, since a file holding one entry
 * has a count that is always 1. `docs/evidence/EV-14.md` has both measurements.
 *
 * **The index is not a substitute for the files and does not pretend to be.** It says what each file
 * costs to read and how many entries are in it, so a caller -- or a scheduler handing work to
 * parallel subagents -- can pick files without opening any of them. What it cannot do is answer a
 * question about the entries, and that is the point: it is cheap precisely because it contains no
 * entry.
 *
 * **Every number here is a measurement of bytes that exist.** `tokens` for a file is
 * `estimateTokens` of the exact string `planDump` returns for that file, and `file_tokens` is the
 * sum of those. It is NOT the manifest's own size, which is deliberately not reported: a manifest
 * that stated its own cost would have to be measured after that field was added, so the number would
 * change the thing it measures -- the fixed point `budget.ts` had to iterate to find, and a
 * self-reference this index does not need, since the caller is already holding it.
 */

import type { RecordedEntry } from '@ascend/store';
import { CHARS_PER_TOKEN, estimateTokens } from './budget.js';
import { entryRow, type Row } from './output.js';

/** The `manifest.json` contract version. Increment only for a breaking shape change. */
export const DUMP_CONTRACT_VERSION = 1;

/**
 * The index's filename, fixed rather than derived from the type.
 *
 * A caller has to name this file to read it, so it is the one name in the directory that cannot be
 * chosen per run. Keeping it a constant also means the "does this directory already hold a dump"
 * check and the write use the same string, rather than two that could drift apart.
 */
export const MANIFEST_NAME = 'manifest.json';

/** The extension for a chunk file. JSON Lines, matching the `asc export` format the CLI specifies. */
export const CHUNK_EXTENSION = '.jsonl';

/** The entries one file will hold, in order. The caller has already hydrated and chunked them. */
export interface DumpChunk {
  readonly entries: readonly RecordedEntry[];
}

/**
 * What selected the entries that were dumped.
 *
 * On the manifest because a directory of files outlives the command that wrote it: a caller
 * returning to a dump next week has the files and this block, and without it cannot tell what the
 * dump was a dump OF. `order` is here rather than beside it because the two together are what make
 * the chunk boundaries mean anything -- the files are contiguous spans of this order.
 */
export interface DumpFilter {
  readonly type: string;
  readonly order: string;
}

/** One file, as the index describes it. */
export interface DumpFileEntry {
  readonly file: string;
  /** How many entries the file holds. */
  readonly count: number;
  /** What reading the file costs, measured from the bytes `planDump` writes. */
  readonly tokens: number;

  /**
   * The range of `recorded_at` in this file. Omitted for an empty chunk rather than reported as a
   * pair of nulls or a zero-width range, which would be a fabricated timestamp (`TASKS.md` #7).
   */
  readonly recorded_at_min?: string;
  readonly recorded_at_max?: string;
}

/** The versioned `manifest.json`. Every field name here is part of the contract. */
export interface DumpManifest {
  readonly ascend_dump: number;
  readonly filter: DumpFilter;
  /** How many entries were dumped, across every file. */
  readonly count: number;
  /** What reading every file costs. Excludes this manifest -- see the file comment. */
  readonly file_tokens: number;
  /**
   * The ratio every `tokens` above was derived from.
   *
   * Carried for the reason `EV-13` decided: this estimate is calibrated on ascend's own OUTPUT and
   * is not a ceiling for the content it STORES, so a corpus of CJK or emoji evidence is
   * under-estimated by up to 6x. A caller who knows their content is not Latin has the number to
   * argue with, and `asc-squ` is the bead for letting them set it.
   */
  readonly chars_per_token: number;
  readonly files: readonly DumpFileEntry[];
}

/** One file the dump will write: the name, and the exact bytes. */
export interface DumpPlanFile {
  readonly name: string;
  readonly text: string;
  readonly count: number;
  readonly tokens: number;
}

/** Everything a dump needs, built and measured before anything touches a disk. */
export interface DumpPlan {
  readonly files: readonly DumpPlanFile[];
  readonly manifest: DumpManifest;
  /** The exact bytes of `manifest.json`. Rendered from `manifest`, so the two cannot disagree. */
  readonly manifestText: string;
}

/**
 * The file name for the `index`-th chunk, zero-padded so lexical order is chunk order.
 *
 * Padding to the width of the largest index rather than to a fixed four digits: `10.jsonl` sorting
 * before `9.jsonl` is the failure this prevents, and padding to a constant that a large corpus then
 * exceeds would reintroduce it exactly when the corpus got big enough to matter.
 */
export function chunkName(index: number, total: number): string {
  const width = String(Math.max(1, total)).length;
  return `${String(index + 1).padStart(width, '0')}${CHUNK_EXTENSION}`;
}

/** The range of `recorded_at` in a chunk, or nothing for an empty one. */
function recordedRange(
  entries: readonly RecordedEntry[],
): { readonly min: string; readonly max: string } | undefined {
  const first = entries[0];
  if (first === undefined) return undefined;

  // Folded over every entry rather than read off the first and last. The chunk is in order today,
  // and a range that silently depended on that would be wrong the moment the order changed --
  // which is the kind of change this file's chunks would still look right under.
  let min = first.recordedAt;
  let max = first.recordedAt;
  for (const entry of entries) {
    if (entry.recordedAt < min) min = entry.recordedAt;
    if (entry.recordedAt > max) max = entry.recordedAt;
  }
  return { min, max };
}

/**
 * One chunk's bytes: JSON Lines, one entry per line, with a trailing newline.
 *
 * **The trailing newline is included in `tokens`, deliberately.** It is part of the file, so a
 * caller comparing a reported size against `wc -c` or against their own tokenizer has to be
 * measuring the same bytes -- and the token count of a file that does not end in a newline is the
 * token count of a file no editor wrote. The line shape comes from `output.ts`'s `entryRow`, so a
 * dumped line and a paged row are the same projection.
 */
function chunkText(entries: readonly RecordedEntry[]): string {
  if (entries.length === 0) return '';
  return `${entries.map((entry) => JSON.stringify(entryRow(entry))).join('\n')}\n`;
}

/**
 * Build every file and the index of them, without writing anything.
 *
 * Separated from the writing so that `--dry-run` and a real dump produce the SAME numbers: a preview
 * that computed its sizes by a different path would be a preview of a dump nobody was going to get.
 * It also puts the whole feature under a unit test, since nothing here touches a disk.
 */
export function planDump(chunks: readonly DumpChunk[], filter: DumpFilter): DumpPlan {
  const files: DumpPlanFile[] = chunks.map((chunk, index) => {
    const text = chunkText(chunk.entries);
    return {
      name: chunkName(index, chunks.length),
      text,
      count: chunk.entries.length,
      tokens: estimateTokens(text),
    };
  });

  const count = files.reduce((total, file) => total + file.count, 0);
  const fileTokens = files.reduce((total, file) => total + file.tokens, 0);

  const manifest: DumpManifest = {
    ascend_dump: DUMP_CONTRACT_VERSION,
    filter,
    count,
    file_tokens: fileTokens,
    chars_per_token: CHARS_PER_TOKEN,
    files: chunks.map((chunk, index) => {
      const range = recordedRange(chunk.entries);
      return {
        file: chunkName(index, chunks.length),
        count: chunk.entries.length,
        tokens: files[index]?.tokens ?? 0,
        ...(range === undefined ? {} : { recorded_at_min: range.min, recorded_at_max: range.max }),
      };
    }),
  };

  // The totals and the per-file rows are computed from the chunk list by separate expressions, so
  // they agree because they were written to, not because they must. Asserted here rather than only
  // in a test: a manifest whose `count` disagrees with the sum of its own file counts is a false
  // green about what is on disk, and it would be read by a caller with no way to check it.
  assertFilesTotalTo(manifest);

  return { files, manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n` };
}

/** The manifest's totals, re-derived from the file rows they claim to total. */
function assertFilesTotalTo(manifest: DumpManifest): void {
  // Stringified into locals rather than wrapped inline. Both spellings of `String(n)` inside a
  // template are rejected by this repo's lint -- bare `n` as a number is an invalid template type,
  // and `String(n)` on a plain identifier is an unnecessary expression -- so the conversion is
  // named once, which is also where a reader looks for it.
  const counts: string = String(manifest.files.reduce((total, file) => total + file.count, 0));
  const tokens: string = String(manifest.files.reduce((total, file) => total + file.tokens, 0));

  if (counts !== String(manifest.count)) {
    throw new Error(
      `dump: the manifest says ${String(manifest.count)} entries but its files account for ${counts}`,
    );
  }
  if (tokens !== String(manifest.file_tokens)) {
    throw new Error(
      `dump: the manifest says ${String(manifest.file_tokens)} tokens but its files account for ` +
        tokens,
    );
  }
}

/**
 * One file of the index, as a result row -- what `--dump` prints on stdout.
 *
 * The stdout output is the INDEX, not a file listing: a caller gets the same numbers the manifest
 * carries without a second read, and the files themselves stay on disk where they cost nothing.
 *
 * `dry_run` is on every row rather than on one, following `record.ts`: a caller reading stdout alone
 * has to be able to tell a preview from a dump, and a single flag row at the end of a list is one a
 * reader can miss.
 */
export function dumpFileRow(file: DumpFileEntry, dryRun: boolean): Row {
  return {
    file: file.file,
    count: file.count,
    tokens: file.tokens,
    ...(file.recorded_at_min === undefined ? {} : { recorded_at_min: file.recorded_at_min }),
    ...(file.recorded_at_max === undefined ? {} : { recorded_at_max: file.recorded_at_max }),
    dry_run: dryRun,
  };
}
