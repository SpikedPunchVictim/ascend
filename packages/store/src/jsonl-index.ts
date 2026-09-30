/**
 * The DERIVED INDEX: `index.db`, built wholesale from a JSONL tree, and never a source of truth.
 *
 * The owner ruling for `asc-i5tj` is either/or -- "JSONL is the store; SQLite does not coexist as a
 * second source of truth". An index is not a second source of truth, and the difference is the whole
 * design: it can be deleted at any moment and reconstructed from the JSONL alone. That only stays
 * true if it is enforced rather than asserted, so this module enforces it twice over:
 *
 * 1. **A READ has no writable handle.** `openIndex` returns a store opened READ-ONLY, so the bead's
 *    invariant -- *no write may land in the index that is not first in the JSONL* -- holds on the read
 *    path because there is nothing to write with, not because callers were asked to behave. Since
 *    E12.4b there ARE writers, `writeLines` and (from b3) `writeProducedLines`, and both hold the same
 *    invariant by ORDER instead: each appends to the tree before it replays anything here, so a line
 *    can only reach the index by having already reached the JSONL. See "The write path" below.
 * 2. **It is a function of the tree.** `openIndex` either finds an index whose fingerprint is the
 *    tree's, or REFUSES. It never repairs one, and since `asc-i5tj.3.1` it never rebuilds one either,
 *    because a read has no path to a build. See "A read never builds" below for what that replaced
 *    and why. `writeLines` is a WRITE and not a repair: it is reached only by something that has just
 *    changed the tree, and it declines to touch an index that was not already current.
 *
 * ## A read never builds (`asc-i5tj.3.1`)
 *
 * `openIndex` used to rebuild on a fingerprint miss, wholesale and silently. EV-33 measured what that
 * costs -- and, more to the point, what it *hides*: 2.97 s at this project's 6,387 entries and **~75 s**
 * at 63,870, with no signal, no progress and no warning, so a caller running a READ could not tell
 * "working" from "hung". At EV-32's 3.02 s estimate the silence was invisible. The defect was never
 * either number; it was that a read could cost one at all.
 *
 * So the build is now a command a caller asks for by name, and `openIndex` refuses instead. It takes
 * no `IndexOptions`, therefore no clock, therefore nothing a build needs; its refusal is
 * `IndexStaleError`, which names `asc index build`; and it leaves the filesystem exactly as it found
 * it. **The guard is a property of the API rather than of a printer**: no mode, flag or option
 * re-enables a rebuild from here, because a parameter is something a later caller sets differently and
 * a missing code path is not.
 *
 * Two things this deliberately does NOT do, both of which the bead's option 2 would have:
 *
 *   - **It does not announce a rebuild before starting one**, because nothing here starts one.
 *   - **It does not refuse loudly and then build anyway** on the grounds that the caller probably
 *     wanted it -- the finding is that a read's cost must be predictable from the command typed.
 *
 * What it costs: a caller who wants a current index must build one, and a read against a stale index
 * is now an error rather than a 75-second answer. That is the right direction -- a stale index is the
 * false-green this module exists to prevent -- and `asc index build` is one command away.
 *
 * **The guard against a read re-reaching a build is two tests, in two files, and neither covers the
 * other's hole.** `packages/cli/test/index-build-is-explicit.test.ts` scans the source and pins the
 * set of modules that can call `buildIndex`, which catches a read path in a module that has not run;
 * the `openIndex` tests below drive every shape of not-current index and require a refusal that writes
 * nothing, which is the only thing that can catch a build put back inside this very file, where a scan
 * for calls to `buildIndex` cannot see the difference between defining it and calling it.
 *
 * ## Wholesale for a BUILD, incremental for a WRITE (E12.4b reverses EV-32)
 *
 * EV-32 measured the alternatives and concluded: *"Because the rebuild is wholesale-cheap, there is no
 * incremental path. Wholesale-or-nothing behind the fingerprint: no partial rebuilds, no per-record
 * index bookkeeping."* The first half of that is still this module's design -- a build is wholesale,
 * and `buildIndex` is the only thing that does one. **The second half was measured false**, and the
 * section is corrected here rather than left standing, because a doc that contradicts its own code
 * teaches the next reader the wrong thing.
 *
 * What changed the answer is EV-33, which measured the premise at 10x: **40.27 s** for a cold rebuild
 * at 63,290 records against **2.97 s** at 6,387. "Rebuild-on-open is out" and "hashing on every open
 * is affordable" both survive -- hashing is 0.05 s at 7.8 MB, and a read still never builds. What does
 * not survive is *wholesale-on-write*: rebuilding on every `asc record` would put 3.39 s (EV-34, at
 * 6,404 entries) on the product's most frequent operation, and 40.27 s at 10x. So the trade EV-32
 * refused -- per-record index bookkeeping -- is now the cheaper one, and `writeLines` is it.
 *
 * **The bookkeeping is the build's own `replay`, and that is the whole of the safety argument.** An
 * incremental writer implemented separately from the builder is the shape that produces two indexes
 * that disagree with nothing reporting it; here the write replays through the same function the build
 * calls, in the same order, against the same store shape. The only thing the write adds is the
 * currency check in front of it.
 *
 * ## The write path: order is the invariant, not a check
 *
 * `writeLines` appends lines to the tree and, **if and only if** the index already described the tree,
 * replays those same lines into the index and re-stamps it. Two properties make the result safe, and
 * neither is an assertion that could be forgotten:
 *
 *   - **The tree is appended first.** A line can only reach the index by having already reached the
 *     JSONL, which is the bead's invariant held by ordering rather than by a guard.
 *   - **The stamp is written last, in the same transaction as the replay.** A death between the append
 *     and the commit therefore leaves an index describing a tree that no longer exists, so every read
 *     refuses until a build -- and a build reads the tree, which is the copy that has the write. There
 *     is no interleaving in which the index holds a record the tree does not.
 *
 * **A stale index is left stale, and that is not the "leave-it-stale" option the plan rejected.** That
 * option was about the ordinary case, where the index describes the tree and rebuilding on write is
 * what costs 3.39 s. This is the case where someone else already moved the tree -- an edit, a checkout,
 * a merge -- and the write cannot make the index current without a wholesale build it has no mandate
 * to run. It appends to the tree and reports `stale: true`, and the caller says so; the alternative
 * would be a write that quietly triggers a 40-second rebuild, which is the silence `asc-i5tj.3.1`
 * exists to remove.
 *
 * **`writeProducedLines` has no stale branch, because its lines come from the index it would be
 * leaving stale.** `writeLines` is handed lines its caller already had, so appending them is right
 * however old the index is. `writeProducedLines` COMPUTES them, by running the real writers against
 * that index -- so a stale index does not merely mean "the index cannot be maintained", it means the
 * lines are not true. EV-35 measured what that produces: a well-formed scheme line claiming version 2,
 * in a `merge=union` file, beside a version 2 the tree already had. So it builds first (the owner's
 * *"build, then write"*), re-checks the fingerprint inside its own lock, and refuses rather than
 * appends. Both writers still hold the invariant by ORDER; only `writeLines` has the outcome where
 * the order is all the caller gets.
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
 * **The replacement has two files' worth of state, not one.** That `close()` belongs to the staging
 * handle, so it accounts for the sidecars of the file being *created* and for none of the sidecars
 * of the file being *replaced*. A `-wal` left by a writer that committed and then died before its
 * own `close()` is committed state sitting beside the target name, and SQLite recovers it onto
 * whatever file it finds there -- so the rename alone publishes a new database carrying an old
 * database's pages. The build deletes those two sidecars before the rename for that reason, and the
 * assertion above does not notice their absence on its own, because it builds into a root where no
 * prior `-wal` exists to be inherited. `dogfood/0044` is the measurement.
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

import { annotationPassGroups, recordAnnotations, registerNamedScheme } from './annotations.js';
import { ForeignStoreError, openStore, STORE_FILE, withTransaction, type Store } from './db.js';
import { documentSpec, type TypeDocument } from './document.js';
import { readRecordTree, recordFiles, openRecordWriter } from './jsonl-files.js';
import type { CorpusLine, EntryLine, SchemeLine } from './jsonl.js';
import { produceLines, type Producers } from './line-producers.js';
import { recordEntry } from './recorder.js';
import { entryFromLine, typeRegistrationOptions } from './replay.js';
import { deprecateType, pendingProseUpdate, registerType, updateTypeProse } from './registry.js';
import type { SqlDatabase } from './sql-port.js';

/**
 * The index's file name inside the store directory.
 *
 * Deliberately not `STORE_FILE` (`ascend.db`). The two lived side by side through the cutover, and
 * two files that meant different things under the same name is how one of them gets read as the
 * other. `ascend.db` is the pre-flip store -- moved into the archive by `asc init`, or never there
 * at all (`asc-i5tj.14`) -- while the source of truth now is the JSONL tree, which the index is only
 * ever a rebuilding of. The name is also the documentation: `index.db` says it may be deleted.
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
   * `buildIndex` is the only taker, and it is required rather than optional so there is one signature
   * for a build. `openIndex` used to share it and now takes no options at all: a read never builds, so
   * a read never needs a clock, and the parameter it does not have is part of how that is enforced
   * rather than merely documented -- see "A read never builds".
   */
  readonly now: string;
}

/** What a build did, for the caller that asked for one. */
export interface IndexBuild {
  /** The tree's fingerprint, which the index now carries. `openIndex` compares this, not an mtime. */
  readonly fingerprint: string;
  /**
   * How many lines were replayed.
   *
   * One number rather than a count per kind, because it is the only one a caller has asked for: it is
   * what makes `asc index build`'s report concrete, and it is free here (the build already holds the
   * parsed lines). A per-kind breakdown is a one-line change with a caller behind it; returning the
   * lines themselves is not, because at 10x that is hundreds of megabytes the caller would keep alive.
   */
  readonly records: number;
}

/**
 * Build the index at `dbPath` from the tree at `root`, wholesale, and report what it did.
 *
 * **This is the only code that writes the index, and the only caller that may is a build command.**
 * Until `asc-i5tj.3.1` it was also reached from `openIndex` on a fingerprint miss; that path is gone,
 * and `packages/cli/test/index-build-is-explicit.test.ts` is what keeps it gone.
 *
 * **The tree is read BEFORE anything is created.** An unreadable line therefore refuses before a
 * temp file exists, let alone before the live index is touched -- so a malformed tree costs nothing
 * and, in particular, does not leave the caller without an index they already had.
 *
 * **A file ascend did not create is refused.** `assertReplaceable` below is the guard `asc-63v`
 * asks for, and it belongs here now rather than on the read path: this function publishes by
 * `renameSync`, which would replace a stranger's database as completely as writing into it.
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
 *
 * **A legacy `ascend.db` beside the tree is refused, and this is the guard the cutover needed most.**
 * A build reads the TREE, and the tree at a half-flipped project is only part of the store, so it
 * publishes an index of what the tree holds and reports success. Measured before this guard existed,
 * on two real stores: a directory holding a 3,585-entry `ascend.db` and no tree at all built to
 * *"0 records"* with exit 0; and this project's own `.ascend/` -- a partial tree of 2,888 lines
 * beside a 6,473-entry store -- built an index reporting 2,894 records, which is what the read that
 * followed then answered with. Nothing downstream can notice: the fingerprint is over the tree, so
 * the index IS current for it, and a read has no reason to look for a file the layout says is gone.
 * See `assertNoLegacyStore` for why the answer is a refusal rather than a warning.
 */
export function buildIndex(root: string, dbPath: string, options: IndexOptions): IndexBuild {
  // Before the tree is read, so a refusal costs a caller nothing and cannot be preceded by the
  // `.tmp` removal or the `renameSync` below.
  assertNoLegacyStore(root);

  const lines = readRecordTree(root);
  const fingerprint = treeFingerprint(root);

  const dir = dirname(dbPath);
  const staging = `${basename(dbPath)}.tmp`;
  // A leftover from a build that died. Removed rather than opened: `openStore` would find a
  // half-built store there, migrate it happily, and produce a plausible index from a fragment.
  rmSync(join(dir, staging), { force: true });

  // Before the rename can clobber it -- and before a temp file is created, so a refusal costs the
  // caller nothing. See `assertReplaceable`.
  assertReplaceable(dbPath);

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

  // The `close()` above belongs to the STAGING handle, so it covers the staging file's sidecars and
  // says nothing about the sidecars of the file the rename is about to replace. Those are inherited
  // by not being deleted, and SQLite recovers a `-wal` onto whatever file sits beside it -- so a
  // writer that committed and then died before its own `close()` (a killed or timed-out hook, which
  // is what leaves one) hands its frames to the NEW index, restoring the replaced database's
  // `meta.index_fingerprint` under a build that reported the new one with exit 0. Removing them
  // first is what makes the rename a replacement of the database rather than of one file of it.
  // Measured, with the refusal loop it produced on a real tree: `dogfood/0044`, `asc-pwv7`.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  renameSync(join(dir, staging), dbPath);

  return { fingerprint, records: lines.length };
}

/**
 * The index is not current for the tree, and a read will not make it so (`asc-i5tj.3.1`).
 *
 * A class rather than a bare `Error` because the caller that meets it is a read path deciding what to
 * say, and which of the three ways it is stale changes what is worth saying -- "there is no index
 * here" and "the tree moved under it" are different situations for the person reading, and neither is
 * a reason to guess. It carries the path and the reason as data, and the message names the remedy and
 * the file, because the file is safe to delete and a refusal is where someone finds that out.
 */
export class IndexStaleError extends Error {
  constructor(
    readonly indexFile: string,
    readonly reason: string,
  ) {
    super(
      `the index at ${indexFile} is not current for this tree (${reason}), and a read does not ` +
        `build one: a rebuild is ~75 s at 63,870 entries and must be asked for. Run ` +
        `\`asc index build\` to rebuild it from the JSONL tree.`,
    );
    this.name = 'IndexStaleError';
  }
}

/**
 * Why the index is not current, in words the caller can act on rather than a code to decode.
 *
 * Three cases, and `openIndex` refuses all of them the same way but says a different thing about each:
 * a missing index has never been built, an unreadable one is a file a build would have to replace, and
 * a mismatched fingerprint means the tree moved after the index was built. The last is the common one
 * -- it is what any edit or checkout produces -- so it gets the plainest wording.
 */
function stalenessReason(present: boolean, stored: string | undefined): string {
  if (!present) return 'there is no index there';
  if (stored === undefined) return 'the file there is not an index ascend can read';
  return 'the tree has changed since it was built';
}

/**
 * An index for the tree at `root`, or a refusal. **It never builds one** (`asc-i5tj.3.1`).
 *
 * The fast path hashes the tree and reads one row: no record is parsed, which is what makes a cache
 * hit cost EV-32's 0.05 s rather than a full replay -- and, unlike the version that shipped before the
 * settlement, there is no slow path at all. A refusal costs a hash plus one SELECT.
 *
 * **An index that is not current is refused, and a file ascend did not create is refused harder.**
 * The first is `IndexStaleError` and names `asc index build`; the second is `ForeignStoreError`
 * (`asc-63v`), which propagates out of `openIndexReadOnly` unchanged, because a valid SQLite database
 * ascend did not write is someone else's and the guard that stops ascend writing into it is not one
 * this module gets to relax. Read-only is not a courtesy either: the handle this returns cannot be
 * written through, which is what makes the bead's invariant -- *no write may land in the index that is
 * not first in the JSONL* -- structural rather than conventional.
 *
 * There is no rebuild loop to worry about, because there is no rebuild: a successful return means the
 * index's fingerprint WAS the tree's, checked in this call and not inferable from the file.
 */
export function openIndex(root: string, dbPath: string): Store {
  const fingerprint = treeFingerprint(root);
  const present = existsSync(dbPath);
  const stored = present ? storedFingerprint(dbPath) : undefined;

  if (stored !== fingerprint) {
    throw new IndexStaleError(dbPath, stalenessReason(present, stored));
  }

  return openIndexStore(dbPath);
}

/** What a guarded write did, and what it refused to do. */
export interface WriteReport {
  /** Lines appended to the tree. */
  readonly lines: number;
  /** The tree's fingerprint AFTER the append, which the index carries when `stale` is false. */
  readonly fingerprint: string;
  /**
   * The index was not current for the tree before this write, so it was left exactly as it was.
   *
   * Reported rather than thrown, because the write itself SUCCEEDED -- the records are in the JSONL,
   * which is the store. A caller that can say so should, since the next read will refuse and the
   * reason is not visible from the refusal alone.
   */
  readonly stale: boolean;
}

/**
 * Append `lines` to the tree at `root`, and keep the index at `dbPath` current for it when it was.
 *
 * The write path's whole operation, and the three steps are in this order for reasons rather than
 * taste -- see this module's "The write path" section for the argument in full:
 *
 * 1. **Read the currency of the index BEFORE appending.** The append is what makes an index stale, so
 *    a check after it would always answer no. This is the only moment the question can be asked.
 * 2. **Append to the tree.** Before anything reaches the index, which is what makes the invariant hold
 *    by ordering. If this throws, the index is untouched and still describes the tree it described
 *    before -- a partial tree is a stale index, which is a state this design already handles.
 * 3. **Replay the same lines, and stamp, in one transaction.** The stamp is the tree's fingerprint as
 *    of AFTER the append, so a read either sees both the records and the stamp or neither.
 *
 * **A write against a not-current index is not refused and not repaired.** The lines go to the tree,
 * `stale: true` comes back, and the index is left byte-identical. See the section above for why this
 * is not the rejected leave-it-stale option.
 *
 * **A file at `dbPath` that ascend did not create refuses the write entirely**, before the append:
 * `ForeignStoreError` (asc-63v) propagates out of the currency check. Writing the tree while refusing
 * to touch someone else's database would be the worst of both -- records that no read of this project
 * can see, and a file ascend must not overwrite -- so the caller is told before anything moves.
 */
export function writeLines(
  root: string,
  dbPath: string,
  lines: readonly CorpusLine[],
  options: IndexOptions,
): WriteReport {
  const before = treeFingerprint(root);
  const current = existsSync(dbPath) && storedFingerprint(dbPath) === before;

  const writer = openRecordWriter(root);
  for (const line of lines) writer.append(line);

  const fingerprint = treeFingerprint(root);
  if (!current) return { lines: lines.length, fingerprint, stale: true };

  const store = openIndexWritable(dbPath);
  try {
    replayInto(store, lines, fingerprint, options.now);
  } finally {
    // `close()` checkpoints the WAL, so the index is one self-contained file -- the same property
    // `buildIndex` relies on when it publishes by `renameSync`, and the one the tests assert by
    // looking for `-wal`/`-shm` residue.
    store.db.close();
  }

  return { lines: lines.length, fingerprint, stale: false };
}

/** What a fused produce-and-write did. */
export interface ProducedWrite<Result> {
  /** Lines appended to the tree. */
  readonly lines: number;
  /** The tree's fingerprint AFTER the append, which the index now carries. */
  readonly fingerprint: string;
  /** What the producing body returned: the warnings, the `unchanged`s, the counts. */
  readonly result: Result;
}

/**
 * Produce lines from `body` and put them in the tree and the index, under ONE lock, or refuse.
 *
 * The write path the six CLI sites use (E12.4b3), and it is a separate function from `writeLines`
 * rather than a flag on it for two reasons that are both about what a caller can then say:
 *
 * 1. **The lines come from HERE.** `writeLines` takes lines its caller already had, so it cannot be
 *    wrong about them. This computes them, which means the currency of the index is no longer a
 *    question about whether the index can be *maintained* -- it is a question about whether the
 *    lines are *true*. EV-35 measured the difference: a producer run against an index holding
 *    `screening` v1 beside a tree holding v1 and v2 minted a well-formed line claiming version 2
 *    with a spec the tree's version 2 does not carry, in a `merge=union` file where nothing collapses
 *    it. So where `writeLines` reports `stale: true` and appends anyway, this one REFUSES, and its
 *    report has no `stale` field for a caller to branch on.
 * 2. **The lock spans all three steps.** The probe reads the index, the append moves the tree and the
 *    replay moves the index, and they are one decision -- "what does this store hold now?" -- so a
 *    concurrent writer must not be able to slip between them. `withRollback` nests as a savepoint
 *    since `db.ts`'s `inOwnScope` (2026-09-29), so `produceLines` runs inside this transaction rather
 *    than beside it, and `annotate.ts`'s read-produce-append (asc-q4p) is one `BEGIN IMMEDIATE`.
 *
 * **The index is made current BEFORE the lock is taken, and re-checked after.** `buildIndex` takes no
 * lock of its own and publishes by `renameSync`, so it cannot be run while a transaction is open on
 * the file it replaces -- hence the build here rather than inside. That is the owner's *"build, then
 * write"* ruling (2026-09-29), and it is what stops a checkout or a merge from making every
 * `asc record` fail until someone thinks to run `asc index build`. The check is then made AGAIN
 * inside the lock, because the first one describes a moment that a concurrent writer can invalidate;
 * the two together are what make "a write cannot slip past the guard" structural rather than likely.
 *
 * **A file at `dbPath` that ascend did not create refuses the write entirely**, before the append:
 * `ForeignStoreError` (`asc-63v`) propagates out of the build, exactly as it does out of `writeLines`.
 *
 * The body is handed the transaction's own `db` as well as the producers, and that is a decision
 * rather than a convenience. Four of the six write sites make a read that decides what they write --
 * `annotate.ts`'s `listSchemes` (asc-q4p), `record.ts`'s `entryCount`, `import.ts`'s `versionsByHash`,
 * `register-document.ts`'s `findType` -- and after the flip the handle a command holds on the way in
 * is READ-ONLY, so those reads cannot be made there (`EV-35`, blocker 1: the preview's INSERT was
 * refused by exactly that). Handing the body the write handle puts every such read inside
 * `BEGIN IMMEDIATE` by construction, which is the shape asc-q4p wanted and could not have. The cost
 * is that a direct writer call on `db` is now spellable from a body, so a source scan pins the
 * modules allowed to call the seven writers.
 *
 * A row written through that `db` is a record the tree does not have -- the tree is appended from the
 * lines `produceLines` collected, never from the database -- so a body that writes to `db` directly
 * is a change that survives the rollback nowhere and is reported by nothing. Read through it; write
 * through `produce`.
 */
export function writeProducedLines<Result>(
  root: string,
  dbPath: string,
  options: IndexOptions,
  body: (produce: Producers, db: SqlDatabase) => Result,
): ProducedWrite<Result> {
  const before = treeFingerprint(root);
  if (!existsSync(dbPath) || storedFingerprint(dbPath) !== before)
    buildIndex(root, dbPath, options);

  const store = openIndexWritable(dbPath);
  try {
    return withTransaction(store.db, () => {
      // Inside the lock, and read from OUR handle rather than by reopening the file: a check-then-act
      // whose check happens outside `BEGIN IMMEDIATE` describes a moment another writer can undo.
      const tree = treeFingerprint(root);
      const stamp = stampedFingerprint(store);
      if (stamp !== tree) throw new IndexStaleError(dbPath, stalenessReason(true, stamp));

      const { lines, result } = produceLines(store.db, (produce) => body(produce, store.db));

      const writer = openRecordWriter(root);
      for (const line of lines) writer.append(line);

      const fingerprint = treeFingerprint(root);
      replayInto(store, lines, fingerprint, options.now);
      return { lines: lines.length, fingerprint, result };
    });
  } finally {
    store.db.close();
  }
}

/**
 * Run `body` against the index and return what it reported, appending nothing and stamping nothing.
 *
 * What `asc <write> --dry-run` needs (E12.4b3), and it cannot use `withRollback` on the read handle
 * for the reason in `writeProducedLines`' own doc: the producers run the REAL writers, so they INSERT,
 * and a read-only handle refuses the INSERT. Measured (`EV-35`): *attempt to write a readonly
 * database*. The preview therefore opens the index writable and produces under a rollback, which
 * leaves the tree, the index and the WAL exactly as it found them and reports what a write would do.
 *
 * **A preview never builds, and this is a real change in behaviour rather than an implementation
 * detail.** `writeProducedLines` builds when the index is not current, because a write has to happen
 * and the owner's ruling is *build, then write*. A preview has no such need, and building one is a
 * ~75 s operation the caller asked to NOT perform -- so a stale index refuses here with
 * `IndexStaleError`, the same error and the same remedy (`asc index build`) a read gives. Stated
 * plainly because it is visible: `asc record --dry-run` against a checkout that has moved the tree
 * now refuses instead of quietly rebuilding.
 *
 * **The currency check is made twice, and the second one is inside the lock.** The first is before
 * anything is opened, and it is what keeps a preview from creating an `index.db` that was not there:
 * `openIndexWritable` runs the store's migrations on the way in, so opening first and checking second
 * would leave a brand-new empty index behind a `--dry-run` that reported writing nothing. The second
 * is inside `produceLines`' own `BEGIN IMMEDIATE` -- `withRollback` takes the lock at the outermost
 * level -- and it is there because the first describes a moment a concurrent write can invalidate
 * while the body is being produced.
 */
export function previewProducedLines<Result>(
  root: string,
  dbPath: string,
  body: (produce: Producers, db: SqlDatabase) => Result,
): Result {
  const present = existsSync(dbPath);
  const stored = present ? storedFingerprint(dbPath) : undefined;
  if (stored !== treeFingerprint(root)) {
    throw new IndexStaleError(dbPath, stalenessReason(present, stored));
  }

  const store = openIndexWritable(dbPath);
  try {
    return produceLines(store.db, (produce) => {
      const stamp = stampedFingerprint(store);
      const tree = treeFingerprint(root);
      if (stamp !== tree) throw new IndexStaleError(dbPath, stalenessReason(true, stamp));

      return body(produce, store.db);
    }).result;
  } finally {
    store.db.close();
  }
}

/**
 * The fingerprint the index in `store` carries, read through the handle that holds the transaction.
 *
 * Takes a `Store` rather than a path, and that is the whole point: `storedFingerprint` opens its own
 * read-only connection, which inside `BEGIN IMMEDIATE` would describe a moment the lock has already
 * frozen -- the right answer for the wrong reason, and a change that would silently stop this being a
 * check-then-act guard at all.
 */
function stampedFingerprint(store: Store): string | undefined {
  const row = store.db.prepare('SELECT value FROM meta WHERE key = ?').get(FINGERPRINT_KEY);
  return (row as { value?: string } | undefined)?.value;
}

/**
 * Replay `lines` into an open index and stamp it, in one transaction.
 *
 * The half `writeLines` and `writeProducedLines` share, and shared rather than written twice for the
 * reason the module doc gives about the build: an incremental writer implemented separately from
 * another incremental writer is how two indexes end up disagreeing with nothing reporting it. Both
 * callers reach the same `replay` with the same stamp, and the only thing either adds is the
 * currency check in front of it.
 *
 * `fingerprint` is the tree's, as of AFTER the append its caller made -- which is why it is a
 * parameter rather than recomputed here. A caller that has not yet appended would stamp a fingerprint
 * describing a tree without the lines it just replayed, which is the false-green this file exists to
 * prevent, spelled as a plausible-looking argument.
 */
function replayInto(
  store: Store,
  lines: readonly CorpusLine[],
  fingerprint: string,
  now: string,
): void {
  withTransaction(store.db, () => {
    replay(store, lines, now);
    store.db
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(FINGERPRINT_KEY, fingerprint);
  });
}

/**
 * The index, opened for writing. The ONLY writable handle to a derived index in this package.
 *
 * Private, and reachable from exactly two callers (`writeLines` and `writeProducedLines`), which is
 * the same construction `buildIndex` has: the writable index is a thing this module does, never a
 * thing a caller is handed. `openIndex`'s read-only handle is what every other caller gets, and the
 * two are separate functions rather than one with a flag so that adding a write is a visible edit
 * here.
 *
 * It is opened through the ordinary `openStore`, so every guard still runs -- `assertNotForeign` above
 * all, which is what stops a write landing in a database that is not ascend's.
 */
function openIndexWritable(dbPath: string): Store {
  return openStore({ dir: dirname(dbPath), file: basename(dbPath) });
}

/**
 * Refuse to build from a tree that is not the only store in the directory.
 *
 * **The failure this prevents is silent, and it is measured in `buildIndex`'s doc.** A half-flipped
 * project -- a legacy `ascend.db` beside a record tree -- builds an index from the TREE alone, so
 * every record still in the database is left out of the index and nothing says so. There is no
 * second line of defence: the fingerprint covers the tree, so the index is genuinely current for it
 * and every later read is a correct read of the wrong store.
 *
 * **The two are refused rather than ranked.** The owner's ruling for the epic is *either/or, never
 * both* -- "JSONL is the store; SQLite does not coexist as a second source of truth". A build that
 * found both cannot tell which the caller meant, and answering that question quietly is precisely
 * how 3,585 records disappear. So it declines to answer it.
 *
 * **The message names a migration and never a deletion.** `index.db` is derived and safe to remove,
 * which `IndexStaleError` says out loud; this file is not, so a refusal that invited `rm` would be
 * inviting the loss it exists to prevent. `asc init` archives the store under `.ascend-archived/`
 * and is already the command that owns this transition.
 *
 * **The remedy takes two hops when the tree already holds lines, and the message says so.** Measured
 * on a copy of this project's own half-flipped `.ascend/` (a 2,917-line tree beside the 6,473-entry
 * store): `asc init` refuses with *"already holds a record tree (2917 line(s)) ... Move the tree aside
 * and run this again"*, so the person who follows this message is refused once more, correctly, and
 * told the next step. Naming it here costs a sentence and saves a round trip through an error. The
 * remedy is not weakened by it: a migration writes a tree and never appends to one, and the archive
 * of the tree is the caller's to make.
 *
 * A path check rather than a store check, deliberately: the file is read only if a caller ignores
 * the refusal, so paying to open it here would cost every build in a migrated project a database
 * open to re-establish a fact its absence already carries. A file of that name in `.ascend/` that is
 * not a store is refused too, and the message's second half covers it.
 */
function assertNoLegacyStore(root: string): void {
  const legacy = join(root, STORE_FILE);
  if (!existsSync(legacy)) return;

  const name = basename(legacy);
  throw new Error(
    `there is a store at ${legacy} beside the record tree at ${root}, and ascend will not build an ` +
      `index from one of them while the other is there: a build reads the tree, so it would index ` +
      `what the tree holds and leave every record in ${name} out of it, reporting success ` +
      `throughout. Run \`asc init\` to migrate the store into the tree -- it moves the file to ` +
      `.ascend-archived/, it never deletes it -- or move ${name} aside yourself, if it holds nothing ` +
      `you need. If the tree there already holds lines, \`asc init\` refuses and names the next ` +
      `step: move the tree aside, then run it again.`,
  );
}

/**
 * Refuse to build over a file ascend did not create (`asc-63v`).
 *
 * **This check moved here when the build became a command, and it was not a formality.** Until
 * `asc-i5tj.3.1`, `openIndex` replaced a not-current index and reached `openStore` first, so
 * `ForeignStoreError` came out of the READ path -- which meant the read path was also the only thing
 * that could clobber the file, and the guard sat with it. Now `buildIndex` is the only code that
 * writes the index at all, and it publishes by `renameSync`: without this, a stranger's database at
 * `index.db` would be replaced wholesale, leaving no file to recover and no error to explain it.
 *
 * An index ascend built but cannot open -- truncated, corrupt, newer schema -- is still replaced, and
 * that is the point of the design: it is derived, so it is disposable. The line is who CREATED the
 * file, not whether it reads.
 */
function assertReplaceable(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  // Opening it and closing it again LOOKS like a no-op and is the whole check: `openIndexReadOnly`
  // lets `ForeignStoreError` out and absorbs every lesser failure, so reaching the line after it
  // means the file is ascend's own and merely not current.
  const existing = openIndexReadOnly(dbPath);
  existing?.db.close();
}

/**
 * An ascend index opened read-only, or `undefined` when the file is not one ascend can read.
 *
 * `ForeignStoreError` is deliberately NOT absorbed, and it is the one failure handed back to the
 * caller: a file ascend did not create is someone else's, and every caller here has to refuse it
 * rather than treat it as a disposable index.
 */
function openIndexReadOnly(dbPath: string): Store | undefined {
  try {
    return openIndexStore(dbPath);
  } catch (error) {
    if (error instanceof ForeignStoreError) throw error;
    return undefined;
  }
}

/** The fingerprint an existing index carries, or `undefined` if it carries none. */
function storedFingerprint(dbPath: string): string | undefined {
  const store = openIndexReadOnly(dbPath);
  if (store === undefined) return undefined;

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
  const options = typeRegistrationOptions(document, now);
  const registered = registerType(store.db, documentSpec(document), options);

  // **A second line for a version the store already holds is how PROSE changes in the tree, and
  // `registerType` alone cannot see it.** Prose is not part of a type's identity -- that is why
  // `registerType` compares specs and answers `unchanged` -- but it does live in the version's LINE,
  // so the tree's copy of a prose edit is a repeat of the same `(name, version)` with a different
  // description. Replayed through `registerType` alone that repeat is a no-op and the edit is gone:
  // an index that disagrees with the tree it was built from, with nothing reporting it. The same
  // question `typeLines` asks on the way out (`pendingProseUpdate`), asked on the way in, so the rule
  // has one spelling.
  if (registered.outcome === 'unchanged') {
    const pending = pendingProseUpdate(store.db, registered.name, registered.version, options);
    if (pending !== undefined) {
      updateTypeProse(store.db, registered.name, registered.version, pending);
    }
  }

  if (document.type_hash !== undefined && document.type_hash !== registered.typeHash) {
    throw new Error(
      `the type line for '${document.name}' claims type_hash ${document.type_hash}, but the ` +
        `definition it carries registers as ${registered.typeHash}. The line and its own contents ` +
        `disagree, so an index built from it would hold a definition the tree does not describe. ` +
        `Re-export the corpus rather than editing this line.`,
    );
  }

  // **A line states which registration it is, and a replay checks the claim rather than deriving
  // the number from the line's position.** The reader sorts type lines by `(name, version)`
  // (`jsonl-files.ts`), so this fires exactly when a name's versions are not the sequence
  // `1, 2, 3…` a replay mints: a registration is missing from the tree, or two lines claim one
  // number with different shapes. Both are trees whose numbering has a hole in it, and minting the
  // next number for the line after the hole would renumber every version past it -- which is the
  // silent renumbering this field exists to stop (`asc-i5tj.6`). It is next to the hash check above
  // because it is the same kind of statement: the line says something about itself, and the store
  // computes the same thing independently.
  if (document.version !== undefined && document.version !== registered.version) {
    throw new Error(
      `the type line for '${document.name}' states version ${String(document.version)}, but the ` +
        `lines for '${document.name}' replayed before it had already reached version ` +
        `${String(registered.version)}. A tree numbers a name's registrations 1, 2, 3… in order, so ` +
        `this line does not continue the sequence: the tree is missing a registration, or two of ` +
        `its lines claim the same number. Nothing was indexed. Restore the tree from a source that ` +
        `holds the whole history rather than editing it by hand.`,
    );
  }

  // **A retirement has no version of its own, so it rides on a REPEAT of a pair the tree already
  // holds, and this is where that repeat is read.** `registerType` cannot see the field: it takes a
  // spec, and a spec is identity only. Measured 2026-09-29, before this line existed: `asc types
  // deprecate` set the status in the index, `asc index build` replayed the tree, and the type came
  // back `active` -- the store's own record of the retirement was erased by the operation whose job
  // is to reproduce it. `deprecateType` rather than a second UPDATE, so the write and the rebuild
  // agree about what retiring a type means by construction (all versions of the name, never one).
  //
  // Applied after the hash check, so a line that misdescribes its own contents is refused rather
  // than half-applied. And only when the line says so: absence means "this line says nothing about
  // status", never "active" (`document.ts`), so no line can un-retire a type and the order a union
  // merge left two repeats in cannot change the answer.
  if (document.status === 'deprecated') deprecateType(store.db, document.name);
}

/** Register one replayed scheme, and refuse if the store's identity for it is not the line's. */
function replayScheme(store: Store, line: SchemeLine): void {
  const context = { createdAt: line.created_at };
  // The reserved scheme is the store's own, so it is replayed as itself rather than registered as
  // a user's: `registerScheme` refuses the name (dogfood/0027). `registerNamedScheme` is that
  // choice, shared with the producer that wrote this line, so the round trip cannot disagree.
  const registered = registerNamedScheme(store.db, line.name, line.spec, context);

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
