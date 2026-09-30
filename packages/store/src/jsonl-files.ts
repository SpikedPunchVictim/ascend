/**
 * The record layer's FILE half: where a record lives, how it is appended and rolled over, and how a
 * tree of record files reads back as one corpus.
 *
 * This module owns LOCATION, ROLLOVER and ORDER and nothing else. It never spells a record itself:
 * writing delegates to `serializeCorpus` and reading to `parseCorpus`, both in `./jsonl.js`, so the
 * store cannot drift from the parser that reads a hand-edited file. A second spelling of the format
 * is the defect the format's own move into this package exists to prevent.
 *
 * **It takes a root path and never discovers the project.** `findProjectRoot` and the `STORE_DIR`
 * convention stay the CLI's business, which keeps this layer drivable from a test against a bare
 * temporary directory -- and makes the layer's own behaviour testable without a CLI in the loop.
 *
 * ## The layout
 *
 * ```
 * .ascend/types/0001.jsonl                  registration order, flat
 * .ascend/schemes/0001.jsonl                registration order, flat
 * .ascend/entries/<type_name>/0001.jsonl    partitioned by name
 * .ascend/annotations/<scheme>/0001.jsonl   partitioned by name
 * .ascend/.gitattributes                    *.jsonl merge=union
 * ```
 *
 * `types/` and `schemes/` are FLAT, one file per kind, and append-only: a line is a registration,
 * and a registration is added, never edited in place or dropped. Their file order USED to be
 * meaning too -- registration order defined the version numbers -- and no reader might sort them.
 * That is no longer true, and the change is the point: a line states its own `version`, so a reader
 * sorts by `(name, version)` and a reordered file reads identically. `merge=union` reorders lines
 * without asking and no code can prevent it, so an order that carried meaning was an order two
 * clones could disagree about (`asc-i5tj.6`).
 *
 * `entries/` and `annotations/` are PARTITIONED BY NAME, which is what keeps two branches that
 * touch different types from colliding, and what makes `merge=union` safe on a file both branches
 * appended to. Their file order is therefore NOT meaning -- it is an artifact of which clone was
 * "ours" when the union merge ran -- so a reader imposes a total order instead of trusting the
 * bytes. See `ORDER` below.
 *
 * The plan's `.gitattributes` line was spelled `records.jsonl merge=union`, from a layout where
 * every record shared one file. Per-kind numbering supersedes that spelling: the files are
 * `<nnnn>.jsonl` at various depths, and a gitattributes pattern matches at any depth, so
 * `*.jsonl` is the pattern that covers them.
 *
 * `<type_name>` and `<scheme>` are not the name verbatim: bytes outside `[A-Za-z0-9._-]` are
 * percent-encoded by `encodeSegment`, which is what keeps a scheme named `a/b` or `..` from
 * deciding a path above its own directory. See that function -- the short version is that a scheme
 * name is any non-empty string the store will accept, so the segment has to be total over it.
 *
 * ## ORDER
 *
 * The rule is derived from the same distinction as the layout -- does file order carry meaning?
 *
 * - **type, scheme lines sort by `(name, version)`.** A version is unique within a name and the
 *   corpus parser refuses a duplicated registration, so this is total, and a reordered file reads
 *   as an ordered one. This replaced *"keep FILE ORDER"* for the reason the layout section gives:
 *   order WAS carrying the version numbers, and a union merge rewrites it without asking. Files are
 *   still read in numeric order -- the sort is what makes which file a line landed in stop
 *   mattering.
 * - **entry lines sort by `(recorded_at, id, then the serialized line)**.** `recorded_at, id` is
 *   the order the bead names. The third key is not decoration: an entry's id is derived and
 *   content-addressed for derived entries, so ONE id legitimately carries TWO contents (the
 *   spike's S3 builds exactly that), and a merge can put them in either order. Sorting on
 *   `(recorded_at, id)` alone would leave those two tied and fall back to file order, which is the
 *   clone-dependent thing being avoided. Comparing the serialized text makes the order total.
 * - **annotation lines sort by `(created_at, id, then the serialized line)`**, for the entry
 *   reason rather than by analogy: an annotation partitions by name, so a union merge can reorder
 *   it, and nothing about an annotation's meaning depends on which line came first. The bead
 *   named entries only, and annotations were a gap in that sentence -- they carry the reorderable
 *   shape and none of the registration-order meaning, so this applies the bead's rule by its own
 *   reason rather than extending its scope by taste.
 * - **entry and annotation lines are DEDUPED on their canonical serialization.** `merge=union`
 *   concatenates both sides and does not dedupe identical lines, and the two sides of a merge are
 *   usually the same bytes -- a derived id comes from its content, so two clones ingesting one
 *   transcript derive the same line. Identical bytes are one record, and a reader that returned
 *   them twice would make every downstream count wrong. This does NOT extend to types and schemes,
 *   where a line is a registration and two identical lines are two versions.
 *
 * Reading returns one flat array: type lines, then scheme lines, then entries, then annotations.
 * Header-shaped kinds first, matching the order `asc export` writes a corpus in.
 *
 * Read ordering is applied in memory, never by rewriting the files -- the bead says so explicitly,
 * and the reason is that a reader which rewrites is a writer, which would make reading two clones
 * a merge conflict.
 */

import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from '@ascend/core';

import {
  parseCorpus,
  serializeCorpus,
  type AnnotationLine,
  type CorpusLine,
  type EntryLine,
  type SchemeLine,
  type TypeLine,
} from './jsonl.js';

/**
 * Records per file before a new one is started.
 *
 * EV-32 measured entries at mean 840 B, p99 2,697 B, max 9,046 B. At that mean 5,000 records is
 * ~4.1 MiB, so this threshold binds first by ~5x and the byte cap below is the backstop for a
 * corpus whose records are far larger than measured, not the working limit.
 */
export const MAX_RECORDS_PER_FILE = 5_000;

/**
 * Bytes per file before a new one is started. Binds only above a 4,194 B mean, which EV-32 puts at
 * a size this corpus has never produced -- 3.2x the p99.
 */
export const MAX_BYTES_PER_FILE = 20 * 1024 * 1024;

/** The file that tells git to union-merge these files instead of conflicting on them. */
export const GITATTRIBUTES_NAME = '.gitattributes';

/** What goes in it. Trailing newline: it is a text file git reads line by line. */
export const GITATTRIBUTES_BODY = '*.jsonl merge=union\n';

/**
 * A name turned into a path segment: a readable slug, then a digest of the name.
 *
 * **This encodes rather than refuses, and the reason is measured rather than cautious.** A first
 * draft refused any name outside `[a-z0-9_]`, on the stated grounds that a name reaching the store
 * is canonical. That holds for a TYPE name -- `canonicalName` (packages/core/src/spec.ts) folds
 * every non-alphanumeric run to `_` and trims, so `a/b` becomes `a_b` before it is ever stored --
 * and it is FALSE for a scheme name. `requireName` (annotations.ts) refuses only the empty string
 * and the reserved `invalidation`, so a scheme name is any string at all, and the real store
 * contains `hand-denial`, `rule-denial` and `shuffled-denial`. The refusing version threw on the
 * project's own corpus the first time it was pointed at real data -- a synthetic fixture cannot
 * produce a name nobody thought to type.
 *
 * A second draft percent-encoded those bytes instead, which fixed the refusal and left three
 * defects that a review then found, all three traced to the same cause: the segment was being used
 * as if it were the name, when it only has to be a FUNCTION of the name.
 *
 * - **Injective.** Two names must never become one directory. Percent-encoding looks injective and
 *   is not: `Buffer.from` replaces an unpaired surrogate with U+FFFD, so `'\uD800'` and `'�'`
 *   encode to identical bytes -- and the read-side guard re-applies this same function, so it
 *   compared the name to itself and was structurally unable to see the collision it had made. The
 *   digest is taken over a lossless spelling of the ORIGINAL string (see `losslessHex`), so names
 *   that differ at all keep distinct segments.
 * - **Bounded.** `NAME_MAX` is 255 bytes on every filesystem this store targets. Percent-encoding
 *   triples the worst case, so 29 CJK characters (3 bytes each) became a 261-character directory
 *   and `mkdir` raised ENAMETOOLONG -- mid-write, leaving a partially written tree. The slug is
 *   truncated and the digest is fixed width, so the segment has a constant upper bound.
 * - **Case-safe.** Directory names are compared case-insensitively on APFS and NTFS, so `Review`
 *   and `review` were ONE directory on macOS and TWO on Linux: the tree read on one machine and
 *   threw on the other. The slug is lowercased and the digest is lowercase hex, so case folding is
 *   the identity on the output -- and two names differing only in case still differ, because the
 *   digest is taken over the name as written.
 *
 * What stays readable is the lowercased alphanumerics, which is what keeps a directory listing of
 * the store legible: `hand-denial-9f2c1a4b7e3d` rather than an opaque hash. Everything outside
 * `[a-z0-9_-]` folds to `_` -- path separators and `.` included -- so no name can introduce a
 * segment boundary or a `.`/`..` segment, whatever it contains, and the empty-slug case needs no
 * branch because the digest alone is always a valid segment.
 *
 * The name is carried on every line, so nothing is ever decoded: this exists so a name can decide a
 * FILE's location without being able to decide anything above it.
 */
const SEGMENT_SLUG_MAX = 40;
const SEGMENT_DIGEST_LENGTH = 12;

/**
 * The string's UTF-16 code units, as fixed-width hex -- a LOSSELESS spelling of it.
 *
 * The digest has to tell two names apart whatever they differ in, and `sha256Hex` cannot be handed
 * the name directly: it encodes its input as UTF-8, and that encoding replaces an unpaired surrogate
 * with U+FFFD. `'\uD800'` and `'�'` therefore hash IDENTICALLY -- which is precisely the
 * collision this digest exists to prevent. That is measured rather than reasoned about: the first
 * version took the name as-is, and the two names still produced one segment.
 *
 * Four hex digits per code UNIT, walking code units rather than code points (`charCodeAt` in a plain
 * index loop, not `Array.from`, which would yield the lone surrogate as one whole element and could
 * re-pair it), so an unpaired surrogate survives as itself. The result is pure ASCII hex, so nothing
 * downstream re-encodes it, and the mapping is injective because every code unit is fixed width.
 */
function losslessHex(name: string): string {
  let hex = '';
  for (let index = 0; index < name.length; index += 1) {
    hex += name.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return hex;
}

function encodeSegment(name: string, what: string, where: string): string {
  if (name === '') {
    throw new Error(`${where}: a ${what} is empty, and an empty name is not a directory.`);
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, SEGMENT_SLUG_MAX);
  const digest = sha256Hex(losslessHex(name)).slice(0, SEGMENT_DIGEST_LENGTH);
  return slug === '' ? digest : `${slug}-${digest}`;
}

/** The directory a line belongs in, as path segments. */
function directoryOf(line: CorpusLine, where: string): readonly string[] {
  switch (line.kind) {
    case 'type':
      return ['types'];
    case 'scheme':
      return ['schemes'];
    case 'entry':
      return ['entries', encodeSegment(line.type_name, 'type_name', where)];
    case 'annotation':
      return ['annotations', encodeSegment(line.scheme, 'scheme', where)];
  }
}

/** `0001.jsonl`, zero-padded so numeric and byte order agree -- the order a reader walks the files
 *  in. Which file a registration line sits in no longer decides its version, but the walk still has
 *  to be total and reproducible. */
function fileName(index: number): string {
  return `${String(index).padStart(4, '0')}.jsonl`;
}

/** The index a file name encodes, or `undefined` for a name this layer does not own. */
function fileIndexOf(name: string): number | undefined {
  const matched = /^(\d{4,})\.jsonl$/.exec(name);
  return matched === null ? undefined : Number(matched[1]);
}

/**
 * The order an entry's or an annotation's lines are presented in, after a merge may have put them
 * in any order at all. Total by construction: the serialized text is a final tiebreak, so two
 * lines that agree on the first two keys still have one determined order.
 */
/** The two kinds whose file order is an artifact of merging rather than meaning, and which
 *  therefore carry the timestamp their recorded order is taken from. */
type OrderableLine = EntryLine | AnnotationLine;

/**
 * Sort by the recorded order, then by the serialized text so the order is total.
 *
 * Decorate-sort-undecorate rather than recomputing `serializeCorpus` inside the comparator: a
 * comparator runs O(n log n) times and the serialization is the expensive part, so the text is
 * computed once per line and carried.
 */
function inRecordedOrder(lines: readonly OrderableLine[]): readonly OrderableLine[] {
  const keyed = lines.map((line) => ({
    line,
    time: line.kind === 'entry' ? line.recorded_at : line.created_at,
    text: serializeCorpus([line]),
  }));
  keyed.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.line.id !== b.line.id) return a.line.id < b.line.id ? -1 : 1;
    if (a.text === b.text) return 0;
    return a.text < b.text ? -1 : 1;
  });
  return keyed.map((entry) => entry.line);
}

/**
 * One line per distinct record, for the kinds whose order is imposed rather than meaningful.
 *
 * A `merge=union` concatenates both sides of a merge and **does not dedupe identical lines**
 * (measured against real git, in `spike/git-layout/`), and the common case rather than the rare one
 * is that the two sides hold the same bytes: a derived entry's id comes from its content, so two
 * clones that ingest the same transcript derive the same id and write the same line. Every count
 * this store produces is a count of records, so a duplicated line is a wrong answer downstream.
 *
 * Applied to entries and annotations ONLY -- the boundary is the same one the ordering rule draws,
 * for the same reason. For a flat append-only kind, file order is meaning and a line is a
 * registration: two identical type lines are two registrations, and collapsing them would delete a
 * version rather than remove a duplicate. Where order carries no meaning, the same content twice
 * cannot be two things.
 *
 * The key is the canonical serialization rather than the parsed object. The parser has a closed key
 * set and normalizes absent optionals, so the canonical text is a record's identity in the format's
 * one spelling -- and it is the same text the writer emitted for it.
 *
 * **Distinct content under ONE id is deliberately not collapsed.** That is a different mechanism
 * (the spike's S3 shape, owned by `asc-2ezs`), and collapsing it would lose a record.
 */
function dedupeByIdentity(lines: readonly OrderableLine[]): readonly OrderableLine[] {
  const seen = new Set<string>();
  const kept: OrderableLine[] = [];
  for (const line of lines) {
    const identity = serializeCorpus([line]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(line);
  }
  return kept;
}

/** A registration line: the two kinds whose version numbers this file is about. */
type HeaderLine = TypeLine | SchemeLine;

/**
 * The version a stored header line states.
 *
 * The corpus parser already refuses a header line that states none, so this cannot throw on a tree
 * this reader accepted -- it exists so the sort compares `number`s rather than `number | undefined`.
 * A default would be worse than a throw: reading a version-less line as `0` would put it first and
 * look like a legitimate order, which is the silent renumbering this whole change removes.
 */
function storedVersion(line: HeaderLine): number {
  const version = line.kind === 'type' ? line.document.version : line.version;
  if (version === undefined) {
    throw new Error(
      `a ${line.kind} line reached the reader with no version, which the corpus parser refuses. ` +
        `That is a reader bug rather than a tree one, and sorting it as 0 would hide it.`,
    );
  }
  return version;
}

/**
 * Header lines in `(name, version)` order, so a reordered file reads as an ordered one.
 *
 * A version is unique within a name and the corpus parser refuses a duplicated registration, so
 * this is a total order and the result does not depend on where a line landed. It replaces *"keep
 * FILE ORDER"* in `ORDER` above for the reason the layout doc gives: file order WAS carrying the
 * version numbers, and a union merge rewrites order without asking, so an order that carried
 * meaning was an order two clones could disagree about (`asc-i5tj.6`).
 *
 * It covers both kinds rather than the type kind alone. A scheme line already stated its version
 * while a type line did not -- that asymmetry is the defect this closes, and sorting only the kind
 * that changed would leave the rule half-true.
 */
function inVersionOrder(lines: readonly HeaderLine[]): readonly HeaderLine[] {
  const keyed = lines.map((line) => ({
    line,
    name: line.kind === 'type' ? line.document.name : line.name,
    version: storedVersion(line),
  }));
  keyed.sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.version - b.version;
  });
  return keyed.map((entry) => entry.line);
}

/**
 * Whether a filesystem error means "there is nothing here" rather than "there is something here I
 * could not look at".
 *
 * The distinction is the whole point: ENOENT is the ordinary case for a kind nothing has been
 * recorded under yet, and every other error -- EACCES, ENOTDIR, EIO -- means a directory EXISTS and
 * could not be read. Swallowing those turns an unreadable partition into an absent one, so the
 * corpus comes back short and every count downstream is quietly wrong, with a malformed tree
 * (`types` as a file) reading as a perfectly empty one.
 */
function isAbsent(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** A directory's files, in file order -- `0001.jsonl` first. Non-record names are ignored. */
function recordFilesIn(directory: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return entries
    .map((name) => ({ name, index: fileIndexOf(name) }))
    .filter((entry): entry is { name: string; index: number } => entry.index !== undefined)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.name);
}

/** Subdirectories of a partitioned kind (`entries/`, `annotations/`), in name order. */
function partitionNamesIn(directory: string): readonly string[] {
  let entries: readonly { name: string; isDirectory(): boolean }[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The four kinds and where each is filed. `partitioned` is the layout distinction the `ORDER`
 * section is derived from: a flat kind's file order is meaning, a partitioned kind's is not.
 */
const KINDS = [
  { dir: 'types', kind: 'type', partitioned: false },
  { dir: 'schemes', kind: 'scheme', partitioned: false },
  { dir: 'entries', kind: 'entry', partitioned: true },
  { dir: 'annotations', kind: 'annotation', partitioned: true },
] as const;

/** One record file, located. */
export interface RecordFile {
  /** Relative to the root, `/`-separated: `entries/note-ab12cd34ef56/0001.jsonl`. */
  readonly relative: string;
  /** The line kind this file's directory implies. */
  readonly kind: CorpusLine['kind'];
  /** The partition directory, for a partitioned kind. Absent for a flat one. */
  readonly partition?: string;
}

/**
 * Every record file under `root`, in a deterministic order.
 *
 * **This is the ONE traversal of the layout, and it is shared on purpose.** `readRecordTree`
 * reads what it returns, and `treeFingerprint` hashes what it returns -- and if those two ever
 * disagreed about which files exist, the fingerprint would certify an index that is missing a
 * file's worth of records. That is not a slow store, it is a store that reports it is current
 * while returning yesterday's answers, so the traversal is a single function rather than a rule
 * both callers are trusted to implement the same way.
 *
 * **The order is (kind, partition name, numeric file index), not lexicographic on the path.** File
 * order is meaning for `types/` and `schemes/` -- registration order IS the version numbering --
 * and a plain string sort breaks it at the fifth digit, where `10000.jsonl` sorts before
 * `9999.jsonl`. A stable order also keeps the fingerprint from changing with the filesystem's
 * `readdir`, which is what `partitionNamesIn` sorts for.
 *
 * **A record file directly under a partitioned kind is refused here**, not skipped. `entries/` and
 * `annotations/` hold one directory per name, so a `*.jsonl` at that level belongs at
 * `entries/<name>/<file>`; descending only through directories would never open it, and its
 * records would not exist as far as every reader is concerned.
 */
export function recordFiles(root: string): readonly RecordFile[] {
  const files: RecordFile[] = [];

  for (const { dir, kind, partitioned } of KINDS) {
    if (partitioned) {
      const loose = recordFilesIn(join(root, dir))[0];
      if (loose !== undefined) {
        throw new Error(
          `${dir}/${loose}: a record file sits directly under '${dir}/', which holds one directory ` +
            `per name -- a record belongs at '${dir}/<name>/<file>'.`,
        );
      }
      for (const partition of partitionNamesIn(join(root, dir))) {
        for (const name of recordFilesIn(join(root, dir, partition))) {
          files.push({ relative: `${dir}/${partition}/${name}`, kind, partition });
        }
      }
    } else {
      for (const name of recordFilesIn(join(root, dir))) {
        files.push({ relative: `${dir}/${name}`, kind });
      }
    }
  }

  return files;
}

/**
 * Every record under `root`, in the order `ORDER` above defines.
 *
 * A line whose kind disagrees with the directory holding it is refused rather than filed under
 * whichever of the two is more convenient, and for a partitioned kind the PARTITION is checked the
 * same way: a line under `entries/note/` must be a note. The writer derives the path FROM the line
 * -- `directoryOf` reads `type_name` and `scheme` off it -- so a reader that trusted only the path
 * would accept a hand-moved file silently and the store would hold a record in a place no query
 * looks. Checking both directions is what makes the write and the read one rule rather than two.
 *
 * Which files exist, and in what order, is `recordFiles`' question -- see its doc for the third
 * guard direction (a record file at the top of a partitioned kind) and for why the order is not a
 * string sort.
 */
export function readRecordTree(root: string): readonly CorpusLine[] {
  const types: TypeLine[] = [];
  const schemes: SchemeLine[] = [];
  const entries: EntryLine[] = [];
  const annotations: AnnotationLine[] = [];

  for (const { relative, kind: expected, partition } of recordFiles(root)) {
    const segments = relative.split('/');
    const text = readFileSync(join(root, ...segments), 'utf8');
    for (const parsed of parseCorpus(text, relative)) {
      if (parsed.line.kind !== expected) {
        throw new Error(
          `${parsed.where}: a '${parsed.line.kind}' line is filed under ` +
            `'${segments.slice(0, -1).join('/')}', which holds '${expected}' lines.`,
        );
      }
      // For a partitioned kind, the directory name must be what the line itself encodes to --
      // otherwise the file is somewhere no reader will look for it by name, which is the same
      // wrong-place defect one level down.
      if (partition !== undefined) {
        const named = directoryOf(parsed.line, relative)[1];
        if (partition !== named) {
          throw new Error(
            `${parsed.where}: filed under '${segments.slice(0, -1).join('/')}', but the line names ` +
              `${JSON.stringify(named)} -- a record must sit in the directory its own name encodes to.`,
          );
        }
      }
      if (parsed.line.kind === 'type') types.push(parsed.line);
      else if (parsed.line.kind === 'scheme') schemes.push(parsed.line);
      else if (parsed.line.kind === 'entry') entries.push(parsed.line);
      else annotations.push(parsed.line);
    }
  }

  return [
    ...inVersionOrder(types),
    ...inVersionOrder(schemes),
    ...inRecordedOrder(dedupeByIdentity(entries)),
    ...inRecordedOrder(dedupeByIdentity(annotations)),
  ];
}

/** Where the writer currently stands in one directory: which file, and its size so far. */
interface Head {
  readonly segments: readonly string[];
  index: number;
  records: number;
  bytes: number;
}

export interface RecordWriter {
  /**
   * Append one record, rolling over first if the head file is full. Returns the store-relative
   * path it landed at, which is what a caller reports and what a test asserts rollover against.
   */
  append(line: CorpusLine): string;
  /** The store-relative paths written so far, in write order. */
  readonly written: readonly string[];
}

export interface RecordWriterOptions {
  /** Defaults to `MAX_RECORDS_PER_FILE`. */
  readonly maxRecordsPerFile?: number;
  /** Defaults to `MAX_BYTES_PER_FILE`. */
  readonly maxBytesPerFile?: number;
}

/**
 * A writer over the tree at `root`, appending records and starting a new file when the current one
 * is full.
 *
 * **It reads each directory's head file ONCE, on first use, and then appends in O(1).** Counting
 * the tail file on every append is O(n^2): at 5,000 records a file is ~4.1 MiB (EV-32), so a
 * 63,290-entry build would re-read hundreds of GB to learn a number it already knew. The count is
 * not persistent state and JSONL stays the only source of truth -- it is per-session state derived
 * from the file, which is why re-opening a writer on an existing tree simply re-derives it.
 *
 * Lazily, per directory: opening a writer for a run that records only notes must not stat
 * `annotations/` at all.
 */
export function openRecordWriter(root: string, options: RecordWriterOptions = {}): RecordWriter {
  const maxRecords = options.maxRecordsPerFile ?? MAX_RECORDS_PER_FILE;
  const maxBytes = options.maxBytesPerFile ?? MAX_BYTES_PER_FILE;
  // `!(x > 0)` rather than `x <= 0`, so NaN is refused too. Both are refused HERE rather than at the
  // first append because a threshold of 0 is not an error the writer could report later: the roll
  // condition is true before the first record, so a fresh tree starts at index 0002 with 0001 never
  // created, and the symptom is a different layout rather than a failure.
  if (!(maxRecords > 0)) {
    throw new Error(`maxRecordsPerFile must be positive, but it is ${String(maxRecords)}.`);
  }
  if (!(maxBytes > 0)) {
    throw new Error(`maxBytesPerFile must be positive, but it is ${String(maxBytes)}.`);
  }
  const heads = new Map<string, Head>();
  const written: string[] = [];

  const inspect = (segments: readonly string[]): Head => {
    const existing = recordFilesIn(join(root, ...segments));
    const last = existing.at(-1);
    if (last === undefined) return { segments, index: 1, records: 0, bytes: 0 };
    const path = join(root, ...segments, last);
    const text = readFileSync(path, 'utf8');
    return {
      segments,
      index: fileIndexOf(last) ?? 1,
      // Non-empty lines, because a blank line is not a record -- the format has no blank-line
      // meaning, so counting one would roll the file over early against nothing.
      records: text.split('\n').filter((line) => line.trim() !== '').length,
      bytes: statSync(path).size,
    };
  };

  return {
    append(line: CorpusLine): string {
      const segments = directoryOf(line, 'record');
      const key = segments.join('/');
      let head = heads.get(key);
      if (head === undefined) {
        head = inspect(segments);
        heads.set(key, head);
      }

      // Delegated, so this module holds no spelling of the format. `serializeCorpus` writes no
      // trailing newline -- that byte is the writer's, one per record, here.
      const text = `${serializeCorpus([line])}\n`;
      const bytes = Buffer.byteLength(text, 'utf8');

      // `head.records > 0` so a single record larger than the cap is still written rather than
      // rolling forever: the cap bounds how many records share a file, it never refuses a record.
      if (head.records >= maxRecords || (head.records > 0 && head.bytes + bytes > maxBytes)) {
        head = { segments, index: head.index + 1, records: 0, bytes: 0 };
        heads.set(key, head);
      }

      const name = fileName(head.index);
      const directory = join(root, ...segments);
      mkdirSync(directory, { recursive: true });
      appendFileSync(join(directory, name), text);

      head.records += 1;
      head.bytes += bytes;

      const relative = [...segments, name].join('/');
      written.push(relative);
      return relative;
    },
    written,
  };
}

/**
 * Write the `.gitattributes` that makes these files union-merge instead of conflicting.
 *
 * Idempotent by construction -- one fixed body, no accumulation -- so it is safe on every
 * `asc init` and on a tree that already has one.
 */
export function writeGitattributes(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, GITATTRIBUTES_NAME), GITATTRIBUTES_BODY);
}
