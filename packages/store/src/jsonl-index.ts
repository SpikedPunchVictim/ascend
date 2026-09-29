/**
 * The DERIVED INDEX: `index.db`, built wholesale from a JSONL tree, and never a source of truth.
 *
 * The owner ruling for `asc-i5tj` is either/or -- "JSONL is the store; SQLite does not coexist as a
 * second source of truth". An index is not a second source of truth, and the difference is the whole
 * design: it can be deleted at any moment and reconstructed from the JSONL alone. That only stays
 * true if it is enforced rather than asserted, so this module enforces it twice over:
 *
 * 1. **There is no writable handle.** `openIndex` returns a store opened READ-ONLY, so the bead's
 *    invariant -- *no write may land in the index that is not first in the JSONL* -- holds because
 *    there is nothing to write with, not because callers were asked to behave. The only code that
 *    writes the index is `buildIndex`, and the only thing it writes FROM is the tree.
 * 2. **It is a function of the tree.** `openIndex` either finds an index whose fingerprint is the
 *    tree's, or replaces the index with one built from the tree. It never repairs, merges into, or
 *    incrementally updates an existing index, so there is no stateful path by which the index can
 *    come to hold something the tree does not.
 *
 * ## Wholesale-or-nothing, and why there is no incremental path
 *
 * EV-32 measured the alternatives. A cold rebuild costs 3.02 s at this project's 6,329 entries and
 * 40.27 s at 63,290, so **rebuild-on-open is out**; hashing the whole JSONL set costs 0.05 s at
 * 7.8 MB and 0.24 s at 71 MB, so **hashing on every open is affordable**. Given both, a persistent
 * index behind a fingerprint is the whole design, and partial rebuilds buy nothing they do not cost
 * in bookkeeping that can itself be wrong.
 *
 * ## The fingerprint is a content hash, and that is not a detail
 *
 * `git checkout` and `git switch` stamp files with the CURRENT time even when the content returns to
 * a state the index already holds, so an mtime check forces a multi-second rebuild on every branch
 * switch. A SHA-256 over the record files answers the same case correctly for 50 ms. EV-32 says so;
 * `jsonl-index.test.ts` asserts it by touching a file and requiring no rebuild.
 *
 * It hashes the files' BYTES, keyed by relative path, rather than the parsed records. That keeps the
 * cost on the cache-HIT path -- which is the path every command takes -- down to reading files, with
 * no parse. The price is conservatism: a re-partition, or a union merge that concatenates a file,
 * changes the bytes and forces a rebuild even though the record SET is unchanged. That is the right
 * direction to be wrong in, and it is the opposite of the direction that serves stale answers.
 *
 * **The traversal is `recordFiles`', shared with the reader.** If this function and
 * `readRecordTree` ever disagreed about which files exist, the fingerprint would certify an index
 * that is missing a file's worth of records -- a store that reports it is current while returning
 * yesterday's answers, which is the false-green class this package treats as severity-zero. One
 * traversal, two callers, is what makes that impossible rather than unlikely.
 *
 * ## Publication is atomic
 *
 * The index is built at `<file>.tmp` and moved into place with one `renameSync`, so a build that
 * dies half-way leaves the PREVIOUS index exactly as it was rather than a partial one wearing a
 * current fingerprint. Probed before being adopted: `node:sqlite`'s `close()` checkpoints and
 * removes the `-wal`, so the renamed file is complete and self-contained, and the fingerprint is
 * written inside the same transaction as the records. `jsonl-index.test.ts` asserts both -- no
 * `-wal`/`-shm` residue, and byte-identical survival of a failed build.
 *
 * ## One column the tree cannot determine
 *
 * `entry_types.created_at` is taken from the caller by `registerType` and carried by no `TypeLine`
 * (`documentFromRow` drops it), so a rebuilt index stamps it with the build's own time and is
 * therefore not a *pure* function of the tree: two builds a second apart differ in exactly that
 * column. It is already true of `asc import`, whose module doc says the same thing, and it is the
 * neighbouring gap `dogfood/0031` filed as `asc-i5tj.6`. It does not weaken the invariant -- a
 * timestamp is not a record the JSONL is missing -- but it is named here, and named again in the
 * test that excludes it, because a column silently excluded from an equivalence check is how a real
 * divergence gets hidden behind a convenient one.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  annotationPassGroups,
  recordAnnotations,
  registerScheme,
  restoreInvalidationScheme,
  RESERVED_SCHEME,
} from './annotations.js';
import { ForeignStoreError, openStore, withTransaction, type Store } from './db.js';
import { documentSpec, type TypeDocument } from './document.js';
import { readRecordTree, recordFiles } from './jsonl-files.js';
import type { CorpusLine, EntryLine, SchemeLine } from './jsonl.js';
import { recordEntry } from './recorder.js';
import { entryFromLine, typeRegistrationOptions } from './replay.js';
import { registerType } from './registry.js';

/**
 * The index's file name inside the store directory.
 *
 * Deliberately not `STORE_FILE` (`ascend.db`). During the transition the two coexist -- the SQLite
 * store is still the source of truth and the index is a cache built from the JSONL tree -- and two
 * files that meant different things under the same name is how one of them gets read as the other.
 * The name is also the documentation: `index.db` says it may be deleted.
 */
export const INDEX_FILE = 'index.db';

/**
 * The key the tree's fingerprint is stored under, in the index's own `meta` table.
 *
 * In the index rather than in a sidecar file, and the reason is the failure it prevents: a fresh
 * fingerprint sitting beside a stale index is precisely a store that reports it is current, and two
 * files written at different moments can always come apart. Inside the index, the fingerprint is
 * published with the records it describes or not at all.
 */
export const FINGERPRINT_KEY = 'index_fingerprint';

/**
 * A content hash of every record file under `root`.
 *
 * Covers the relative path and the byte length as well as the bytes, so that moving a file between
 * partitions, or splitting one file into two, changes the fingerprint even when the concatenation of
 * the contents would not.
 */
export function treeFingerprint(root: string): string {
  const hash = createHash('sha256');

  for (const { relative } of recordFiles(root)) {
    const bytes = readFileSync(join(root, relative));
    hash.update(`${relative}\u0000${String(bytes.byteLength)}\u0000`, 'utf8');
    hash.update(bytes);
    hash.update('\u0000', 'utf8');
  }

  return hash.digest('hex');
}

/**
 * What a build needs from its caller that the tree cannot supply.
 *
 * One field, and it is here rather than defaulted for the reason `recorder.test.ts`'s
 * "reads no clock and draws no randomness, in any module" guard exists: this package is pure, time
 * is injected at the command boundary (`BaseCommand.now()`), and a module that reads the clock makes
 * the store's own output depend on when it ran. The first draft of `replayType` called
 * `new Date()` and that guard caught it -- which is the guard working, and the reason the field is
 * required rather than optional. See "One column the tree cannot determine" below for why a
 * timestamp is needed at all.
 */
export interface IndexOptions {
  /**
   * ISO-8601 UTC, the moment of this call.
   *
   * Consulted only when the index must be BUILT: a cache hit parses no record and takes no
   * timestamp, so a caller on the fast path reads a clock for nothing. That is the cost of one
   * signature over two, and it is a clock read at a boundary that already does one.
   */
  readonly now: string;
}

/**
 * Build the index at `dbPath` from the tree at `root`, wholesale, and return the fingerprint it
 * stamped.
 *
 * **The tree is read BEFORE anything is created.** An unreadable line therefore refuses before a
 * temp file exists, let alone before the live index is touched -- so a malformed tree costs nothing
 * and, in particular, does not leave the caller without an index they already had.
 *
 * **Refuses a tree whose lines disagree with what the store would mint.** Three claims a line makes
 * can be silently reinterpreted rather than rejected: a scheme's `version`, because `registerScheme`
 * numbers from the store's own history; a scheme's `scheme_hash`, because `registerScheme` computes
 * it from the spec it was handed rather than reading the line's; and an entry's `type_hash`, because
 * `recordEntry` writes the hash of the definition it resolved rather than the one the line names.
 * Any disagreement means the tree and the store disagree about WHICH DEFINITION a record belongs to,
 * which is the schema drift `schema.ts` makes structurally impossible in the database -- and an index
 * that quietly held the store's answer instead of the tree's would be an index holding something the
 * JSONL does not. This is not the merge guard (`asc-98e1`), which is a wider net over ids and
 * conflict markers and belongs to E12.5; it is the narrow version of it that this module's own
 * invariant requires.
 */
export function buildIndex(root: string, dbPath: string, options: IndexOptions): string {
  const lines = readRecordTree(root);
  const fingerprint = treeFingerprint(root);

  const dir = dirname(dbPath);
  const staging = `${basename(dbPath)}.tmp`;
  // A leftover from a build that died. Removed rather than opened: `openStore` would find a
  // half-built store there, migrate it happily, and produce a plausible index from a fragment.
  rmSync(join(dir, staging), { force: true });

  const store = openStore({ dir, file: staging });
  try {
    withTransaction(store.db, () => {
      replay(store, lines, options.now);
      store.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run(FINGERPRINT_KEY, fingerprint);
    });
  } finally {
    store.db.close();
  }

  renameSync(join(dir, staging), dbPath);

  return fingerprint;
}

/** What `openIndex` found, and what it had to do about it. */
export interface OpenedIndex {
  /** READ-ONLY: the index cannot be written through this handle. See the module doc. */
  readonly store: Store;
  /** True when the index was built or rebuilt by this call rather than found current. */
  readonly rebuilt: boolean;
  /** The tree's fingerprint, which the index now carries. */
  readonly fingerprint: string;
}

/**
 * An index for the tree at `root`, current as of this call.
 *
 * The fast path hashes the tree and reads one row: no record is parsed, which is what makes a cache
 * hit cost EV-32's 0.05 s rather than a full replay. The parse happens only on the path that is
 * about to rebuild anyway.
 *
 * **An index that cannot be read is rebuilt, and a file ascend did not create is refused.** That
 * line is the whole policy. The index is derived, so a corrupt, truncated, stale-schema or
 * newer-schema file is evidence of nothing and replacing it is the point of the design; a file that
 * is a valid SQLite database ascend did not write is someone else's, and overwriting it is what
 * `ForeignStoreError` exists to prevent (`asc-63v`). Refusing costs the caller one `rm` on a file
 * they can regenerate, and the alternative is ascend writing into a database it did not create.
 *
 * There is no rebuild loop to worry about: whatever a rebuilt index looks like, it opens, because
 * the second open is unconditional and its errors propagate.
 */
export function openIndex(root: string, dbPath: string, options: IndexOptions): OpenedIndex {
  const fingerprint = treeFingerprint(root);

  if (existsSync(dbPath) && storedFingerprint(dbPath) === fingerprint) {
    return { store: openIndexStore(dbPath), rebuilt: false, fingerprint };
  }

  buildIndex(root, dbPath, options);

  return { store: openIndexStore(dbPath), rebuilt: true, fingerprint };
}

/** The fingerprint an existing index carries, or `undefined` if it carries none. */
function storedFingerprint(dbPath: string): string | undefined {
  const dir = dirname(dbPath);
  const file = basename(dbPath);
  let store: Store;

  try {
    store = openStore({ dir, file, readOnly: true });
  } catch (error) {
    // A file ascend did not create is the one thing an unreadable index can be that must not be
    // replaced. Everything else -- a foreign schema version, a truncated file, a file that is not a
    // database at all -- is disposable, because the tree it was built from is not.
    if (error instanceof ForeignStoreError) throw error;
    return undefined;
  }

  try {
    const row = store.db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY);
    return (row as { value?: string } | undefined)?.value;
  } finally {
    store.db.close();
  }
}

/**
 * Open an index that is known to exist.
 *
 * Read-only, and that is the invariant rather than an optimisation -- see the module doc. A
 * read-only handle still runs every guard `openStore` has (`assertNotForeign`, `assertNotAhead`,
 * `verifyPragmas`), so an index that is not ascend's own is still refused here rather than read.
 */
function openIndexStore(dbPath: string): Store {
  return openStore({ dir: dirname(dbPath), file: basename(dbPath), readOnly: true });
}

/**
 * Replay the tree into an empty store: definitions first, then the records that depend on them.
 *
 * The order is the corpus's own contract (`jsonl.ts`): a type before the entries recorded against
 * it, a scheme before the annotations labelled under it. `readRecordTree` returns types, schemes,
 * entries and annotations in that order, which satisfies both foreign keys -- entries need types,
 * annotations need entries and schemes.
 *
 * Annotations go in as PASSES, never row by row, for the reason `annotationPassGroups` gives: the
 * pass is the unit `recordAnnotations` writes and `asc kappa` compares, and restoring row by row
 * would stamp every annotation with the moment of the build and collapse every pass a scheme ever
 * ran into one.
 */
function replay(store: Store, lines: readonly CorpusLine[], now: string): void {
  for (const line of lines) {
    if (line.kind === 'type') replayType(store, line.document, now);
  }

  for (const line of lines) {
    if (line.kind === 'scheme') replayScheme(store, line);
  }

  for (const line of lines) {
    if (line.kind === 'entry') replayEntry(store, line);
  }

  for (const group of annotationPassGroups(lines.filter(isAnnotation))) {
    recordAnnotationsAsPass(store, group);
  }
}

/** Narrows the line union to annotations, without a cast that would silence a new kind. */
function isAnnotation(line: CorpusLine): line is Extract<CorpusLine, { kind: 'annotation' }> {
  return line.kind === 'annotation';
}

/** Register one replayed type, and refuse if the store's identity for it is not the line's. */
function replayType(store: Store, document: TypeDocument, now: string): void {
  // `now`, injected, because a `TypeLine` carries no registration timestamp -- see the module doc's
  // "One column the tree cannot determine". The store reads no clock of its own.
  const registered = registerType(
    store.db,
    documentSpec(document),
    typeRegistrationOptions(document, now),
  );

  if (document.type_hash !== undefined && document.type_hash !== registered.typeHash) {
    throw new Error(
      `the type line for '${document.name}' claims type_hash ${document.type_hash}, but the ` +
        `definition it carries registers as ${registered.typeHash}. The line and its own contents ` +
        `disagree, so an index built from it would hold a definition the tree does not describe. ` +
        `Re-export the corpus rather than editing this line.`,
    );
  }
}

/** Register one replayed scheme, and refuse if the store's identity for it is not the line's. */
function replayScheme(store: Store, line: SchemeLine): void {
  const context = { createdAt: line.created_at };
  // The reserved scheme is the store's own, so it is replayed as itself rather than registered as
  // a user's: `registerScheme` refuses the name (dogfood/0027).
  const registered =
    line.name === RESERVED_SCHEME
      ? restoreInvalidationScheme(store.db, line.spec, context)
      : registerScheme(store.db, line.name, line.spec, context);

  if (registered.version !== line.version) {
    throw new Error(
      `the scheme line for '${line.name}' claims version ${String(line.version)}, but its spec ` +
        `registers as version ${String(registered.version)}. A scheme's version decides which spec ` +
        `a pass was run against, so an index built from this line would hold a different pass than ` +
        `the tree describes. Re-export the corpus rather than editing this line.`,
    );
  }

  // The same claim `verifySchemeLine` (jsonl.ts) checks on the import path, and checked again here
  // because `readRecordTree` parses without it -- so a line whose `spec` and `scheme_hash` disagree
  // reaches this function. `registerScheme` computes the hash from the spec it was handed, which
  // means the store would hold a scheme whose hash is not the one the line names: an index that
  // answers "which spec was this pass run against" with something the tree does not say.
  if (registered.specHash !== line.scheme_hash) {
    throw new Error(
      `the scheme line for '${line.name}' claims scheme_hash ${line.scheme_hash}, but the spec it ` +
        `carries registers as ${registered.specHash}. The line and its own contents disagree, so an ` +
        `index built from it would hold a scheme the tree does not describe. Re-export the corpus ` +
        `rather than editing this line.`,
    );
  }
}

/** Record one replayed entry, and refuse if the definition it names is not the one it was filed
 *  against. */
function replayEntry(store: Store, line: EntryLine): void {
  const { request, context } = entryFromLine(line);
  recordEntry(store.db, request, context);

  // `recordEntry` writes the hash of the definition it RESOLVED, so a line naming a hash this store
  // does not hold would be silently rewritten rather than refused -- and the foreign key it satisfies
  // is then the store's own pair, not the tree's.
  const stored = store.db.prepare('SELECT type_hash FROM entries WHERE id = ?').get(line.id) as
    { type_hash?: string } | undefined;

  if (stored?.type_hash !== line.type_hash) {
    throw new Error(
      `entry ${line.id} was recorded against ${line.type_name} version ` +
        `${String(line.type_version)} with type_hash ${line.type_hash}, but this index registered ` +
        `that name and version as ${String(stored?.type_hash)}. The entry names a definition the ` +
        `tree does not hold, so restoring it would attach the record to a spec it was not recorded ` +
        `against. Re-export the corpus rather than editing this line.`,
    );
  }
}

/** One `recordAnnotations` call per pass, with the pass's OWN timestamp and author. */
function recordAnnotationsAsPass(
  store: Store,
  group: ReturnType<typeof annotationPassGroups>[number],
): void {
  recordAnnotations(
    store.db,
    {
      scheme: group.scheme,
      schemeVersion: group.schemeVersion,
      annotations: group.lines.map((line) => ({
        id: line.id,
        entryId: line.entry_id,
        label: line.label,
        // `undefined` is absence here, and `null` is a value the annotation held --
        // `AnnotationLine.value` is an OPTIONAL key for exactly this reason, so testing against
        // `null` would drop a legitimate JSON `null` on the way back in.
        ...(line.value === undefined ? {} : { value: line.value }),
        ...(line.confidence === null ? {} : { confidence: line.confidence }),
        ...(line.note === null ? {} : { note: line.note }),
      })),
    },
    {
      createdAt: group.createdAt,
      ...(group.createdBy === null ? {} : { createdBy: group.createdBy }),
    },
  );
}
