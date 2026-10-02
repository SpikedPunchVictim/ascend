/**
 * `asc init` -- make the current directory a project.
 *
 * Five things happen, and the report is one row each so `--json` describes the same run the table
 * does (`output.ts`: a row per action, not a paragraph per action).
 *
 * 1. **The tree.** `.ascend/` becomes the store (E12.4): `types/`, `entries/`, `annotations/` and
 *    `schemes/` of JSONL, which is what git carries and what every other checkout can read. A legacy
 *    `ascend.db` in that directory is MIGRATED first rather than ignored, because a `.ascend/` that
 *    held a store and now holds an empty tree is a project whose records have silently disappeared --
 *    see `migrate.ts` and the row below.
 * 2. **The merge attribute.** `.ascend/.gitattributes` says `*.jsonl merge=union`, so two branches
 *    that each appended records merge instead of conflicting on them. It is the one line that makes
 *    the tree a store two people can write to, and it is written here because a fresh project has no
 *    other moment at which to get it.
 * 3. **The gitignore.** `.ascend/` itself stops being ignored -- the tree is the point of the epic --
 *    and the derived and machine-local files inside it are named individually instead: the index and
 *    its WAL/SHM, the legacy database, and the ingest cursor. Appended, never rewritten outside the
 *    one line this command itself wrote in older versions (see `updateIgnoreText`).
 * 4. **The starter types.** The four in `starters.ts`, registered through the ordinary
 *    `registerDocumentVia` path so they version, diff and export exactly like a user's own -- as ONE
 *    fused write, so a later starter sees an earlier one. Re-running is not "safe", it is *useful*:
 *    improved starter prose lands as `prose-updated` rather than being dropped as `unchanged`
 *    (`register-document.ts`).
 * 5. **The recall hook, OFFERED and not installed.** See below.
 *
 * **The offer is the whole of this command's involvement with settings.** `ARCHITECTURE.md`:
 * ascend "never silently edits a user's settings file", and the write is `asc install-hook`'s job
 * (E10) behind explicit consent. So this prints what the hook would be and which command will
 * install it, and touches nothing. Printing it is not decoration -- the product's primary failure
 * mode is an empty database, and a user who does not know recall exists will not ask for it. The
 * offer is reported as a row so a script can see that there is something outstanding.
 *
 * **Idempotent.** Every step is: the tree is left as it is if it is there, a known shape registers as
 * `unchanged`, the attribute file is one fixed body, and the ignore lines are added when absent.
 *
 * **A store in an ancestor is a warning, not a refusal.** Running this inside a subdirectory of an
 * existing project creates a nested store that SHADOWS the ancestor's, because `openProject` walks
 * up from the working directory and stops at the first `.ascend/`. That is worth saying loudly and
 * is not worth refusing: `asc query --across` exists precisely because more than one store in a
 * tree is a supported shape, and refusing would make a legitimate layout unreachable.
 *
 * **`--dry-run` opens nothing it would have to create.** Three cases, and the third is the one the
 * flip made subtle:
 *
 *   - **No store here at all.** The starters are previewed against an in-memory store, which reports
 *     exactly the versions a real run would (all `created`, all version 1), and nothing is created --
 *     not the directory, not the index, not the `.gitattributes`.
 *   - **A tree with a current index.** `previewProducedLines` runs the real registrations under a
 *     rollback, so the outcomes are the real ones and neither the tree nor the index moves.
 *   - **A legacy `ascend.db`.** Previewed against THAT store under a rollback, because registering
 *     against the database the migration is about to move gives the same answers as registering
 *     against the tree it moves it to -- the migration carries the registry across unchanged, which
 *     is its whole verified claim (`EV-34`). The alternative, an in-memory preview, would report four
 *     `created`s for types the project already has, which is a preview of a different project.
 *
 * A dry run never migrates, never writes the ignore file, and never writes `.gitattributes`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import {
  ForeignStoreError,
  GITATTRIBUTES_NAME,
  INDEX_FILE,
  INGEST_CURSOR_FILE,
  migrateStoreToTree,
  openIndex,
  openStore,
  produceLines,
  readRecordTree,
  STORE_DIR,
  STORE_FILE,
  writeGitattributes,
  writeProducedLines,
  previewProducedLines,
  type Producers,
  type SqlDatabase,
  type Store,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { findGitRoot, findProjectRoot } from '../project.js';
import { registerDocumentVia } from '../register-document.js';
import { STARTER_TYPES } from '../starters.js';
import { symlinkTarget } from '../symlink.js';

/** One row of the report: what was touched, and what happened to it. */
interface InitRow extends Record<string, unknown> {
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly dry_run: boolean;
}

/**
 * Where a legacy store is archived, relative to the project root.
 *
 * Beside `.ascend/` rather than inside it, because `migrateStoreToTree` refuses an archive inside
 * the tree directory (the record subtree is un-ignored in git, so a database left there is one
 * `git add` from being committed) and because a backup belongs next to the thing it backs up.
 * `dogfood/` and the project's own memory settle the same location: `.ascend-archived/`, gitignored.
 */
const ARCHIVE_DIR = '.ascend-archived';

/**
 * The lines `.gitignore` must carry once the tree is the store.
 *
 * **`.ascend/` as a whole is no longer ignored, and that is the epic** (E12.4): the record tree IS
 * the store, so a checkout that ignored it would carry no records at all. What is ignored is the
 * part that is either derived or machine-local:
 *
 *   - **The index and its WAL/SHM**, which are a pure function of the tree and must never be a
 *     second source of truth. Deleting one costs a rebuild and nothing else.
 *   - **The legacy database**, because a project part-way through the cutover holds one and it means
 *     nothing to anybody else -- the same reason it was ignored when it was the store.
 *   - **The ingest cursor**, which holds absolute paths into one machine's home directory
 *     (`asc-i5tj.14`, `ingest-cursor.ts`).
 *
 * Each file is named rather than the directory being un-ignored wholesale with `!` rules, because a
 * negation list silently reverses whenever a new derived file appears inside a directory that is
 * ignored by pattern, and the failure mode is committing an `index.db` that then conflicts on every
 * merge.
 */
const DERIVED_ENTRIES: readonly string[] = [
  `${STORE_DIR}/${INDEX_FILE}`,
  `${STORE_DIR}/${INDEX_FILE}-wal`,
  `${STORE_DIR}/${INDEX_FILE}-shm`,
  `${STORE_DIR}/${STORE_FILE}`,
  `${STORE_DIR}/${STORE_FILE}-wal`,
  `${STORE_DIR}/${STORE_FILE}-shm`,
  `${STORE_DIR}/${INGEST_CURSOR_FILE}`,
];

/**
 * Is this line the store directory ignored as a whole?
 *
 * Four spellings, because git accepts all four and a user who wrote `/.ascend/` has already done
 * what the older versions of this command would do. This is the line `updateIgnoreText` REMOVES,
 * which is why it is a question about one line and not about the file.
 *
 * **A `!` re-include needs no special case, and this is measured rather than assumed.** The obvious
 * guard -- skip lines beginning with `!` -- was written first and then removed, because it cannot
 * fire: every line is compared by EQUALITY against the four spellings above, and `!` prefixed onto
 * any of them (`!.ascend`, `!.ascend/`, `!/.ascend`, `!/.ascend/`) is unequal to all four. So the
 * branch was unreachable, and an unreachable guard reads like a handled case while handling nothing
 * -- the defect class `packages/core/test/purity-enforcement.test.ts` exists to prevent.
 * `init.test.ts` asserts the behaviour this depends on, so the claim is checked even though the code
 * no longer mentions it.
 */
function ignoresStoreLine(trimmed: string): boolean {
  return ['', '/'].some((prefix) =>
    [STORE_DIR, `${STORE_DIR}/`].some((name) => trimmed === `${prefix}${name}`),
  );
}

/**
 * The `.gitignore` this command wants, given the one that is there.
 *
 * **Two edits, and the removal is the one worth explaining.** Adding the derived entries is the
 * ordinary append. Removing a line that ignores the whole store directory is an edit to a file the
 * user wrote, and it is deliberate: leaving `.ascend/` ignored would make the tree invisible to git,
 * which is the store gone -- a project that appears to work on this machine and carries nothing to
 * the next one. Removing it is the only option that leaves the records committable; negating the
 * individual record paths instead would be a list that grows with the layout.
 *
 * **Every spelling of the line goes**, not only the one this command used to write. A project whose
 * `.gitignore` says `/.ascend/` is in exactly the state the removal exists for, and leaving it
 * because it is spelled differently would be the epic failing on a technicality. `init.test.ts`
 * covers each spelling.
 *
 * The entries are appended rather than inserted where the removed line was: the file's other lines
 * are the user's, order in a `.gitignore` is not meaningful between independent patterns, and
 * splicing into the middle of a file the user maintains is the kind of edit that surprises people
 * looking at a diff.
 */
function updateIgnoreText(text: string): string {
  const kept = text.split('\n').filter((line) => !ignoresStoreLine(line.trim()));
  // A final empty element is an artefact of splitting on the terminator, not a line of its own.
  if (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

  const present = new Set(kept.map((line) => line.trim()));
  const added = DERIVED_ENTRIES.filter((entry) => !present.has(entry));
  return `${[...kept, ...added].join('\n')}\n`;
}

/** Did this rewrite drop a whole-directory ignore line? Reported, because it edits the user's file. */
function removesStoreLine(text: string): boolean {
  return text.split('\n').some((line) => ignoresStoreLine(line.trim()));
}

export default class Init extends BaseCommand {
  static override description = `Create a ${STORE_DIR}/ store here, install the starter types, and offer recall.`;

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static override flags = {
    // Quoted and hyphenated rather than `dryRun`: measured against this oclif, a camelCase key
    // renders verbatim as `--dryRun` and is not converted (`types/define.ts`).
    'dry-run': Flags.boolean({
      description: 'Report exactly what would be created, then write nothing.',
    }),
  };

  /**
   * Refuse an `index.db` ascend did not write, before a single file is created.
   *
   * **The fused write below refuses it too** -- `assertNotForeign` runs on every open, so a foreign
   * file is not something this command can write into by any path. What this adds is the *moment*.
   * `.gitattributes` and `.gitignore` are written first, so without this the refusal arrives after
   * two files exist, which is the shape the migration step's ordering exists to prevent: a project
   * part-set-up by a command that then refused. Measured 2026-09-29 -- `asc init` in a directory
   * holding a foreign `.ascend/index.db` left both files behind and said "refused before anything is
   * migrated".
   *
   * **Everything but `ForeignStoreError` is swallowed**, and that is `openIndexReadOnly`'s own
   * carve-out rather than a new judgement: a stale index, an index whose schema is a version newer
   * than this build, an index at a path that is not a database -- all of those are *derived* files,
   * and the fused write below deals with them by rebuilding. Only "this file is someone else's" is
   * something the command cannot answer, and it is the one thing it must say before it writes.
   */
  private refuseForeignIndex(tree: string, indexFile: string): void {
    if (!existsSync(indexFile)) return;

    try {
      openIndex(tree, indexFile).db.close();
    } catch (error) {
      if (!(error instanceof ForeignStoreError)) return;
      throw error;
    }
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);

    const root = resolve(process.cwd());
    const tree = join(root, STORE_DIR);
    const indexFile = join(tree, INDEX_FILE);
    const legacyStore = existsSync(join(tree, STORE_FILE));

    // Before anything at all: a `index.db` ascend did not write is not an index, and every later step
    // assumes it has one. See the method for why this is not left to the fused write below.
    this.refuseForeignIndex(tree, indexFile);

    // Before anything is created: a store above this directory already answers "which project am
    // I in", and one created here would take precedence over it from now on.
    const ancestor = findProjectRoot(dirname(root));
    if (ancestor !== undefined) {
      this.warn(
        `there is already a store at ${join(ancestor, STORE_DIR)}, and it will be shadowed by ` +
          `the one created here. Commands run in ${root} or below will use THIS store; commands ` +
          `run above it will use that one. Two stores in one tree is a supported layout -- ` +
          `'asc query --across' reads more than one -- but it is rarely what someone means.`,
      );
    }

    const rows: InitRow[] = [];
    const storePresent = legacyStore || existsSync(indexFile);

    rows.push({
      action: 'store',
      target: tree,
      outcome: storePresent ? 'already present' : 'created',
      dry_run: dryRun,
    });

    // The migration comes before anything else that writes, because it is the step that can refuse
    // -- an archive directory that already holds a store, a tree that is already there -- and a
    // refusal that had already appended a `.gitattributes` would leave a project part-migrated.
    if (legacyStore) rows.push(this.migrate(root, tree, dryRun));

    if (!dryRun) writeGitattributes(tree);
    rows.push({
      action: 'gitattributes',
      target: join(tree, GITATTRIBUTES_NAME),
      outcome: dryRun ? 'would write' : 'written',
      dry_run: dryRun,
    });

    rows.push(this.updateGitignore(root, dryRun));

    const registerAll = (produce: Producers, db: SqlDatabase): void => {
      for (const spec of STARTER_TYPES) {
        const result = registerDocumentVia(produce, db, spec, { registeredAt: this.now() });
        for (const warning of result.warnings) {
          this.warn(`${result.name}: warning: ${warning}`);
        }
        rows.push({
          action: 'type',
          target: result.name,
          outcome: result.outcome,
          dry_run: dryRun,
        });
      }
    };

    if (dryRun) this.preview(root, tree, indexFile, legacyStore, registerAll);
    else writeProducedLines(tree, indexFile, { now: this.now() }, registerAll);

    rows.push({
      action: 'hook',
      target: 'SessionStart: asc types brief',
      outcome: dryRun ? 'would offer' : 'offered, not installed',
      dry_run: dryRun,
    });

    if (dryRun) this.warn('dry run: nothing was written.');
    this.emit(format, { columns: ['action', 'target', 'outcome'], rows });

    this.offerRecall();
  }

  /**
   * Migrate a legacy `ascend.db` into the tree beside it, and report what the corpus could not carry.
   *
   * **Reported rather than absorbed, and that is the whole reason the row exists.** The corpus is
   * four line kinds and the store holds more tables, so the migration lists every other populated
   * table by name and row count (`migrate.ts`'s `droppedTables`, derived from `sqlite_master` so the
   * next schema addition appears in it without anyone remembering). On this project that is 1,070
   * `ingest_cursor` rows and two `meta` keys -- the cursor, which has a home of its own now
   * (`asc-i5tj.14`), and the handler ledger that lives in the same file. A run that discarded them
   * in silence would be a run that lost the record of which transcripts had been read, and the only
   * symptom would be a slower next ingest.
   *
   * The archive directory is stamped rather than fixed, so a second migration of a different store
   * cannot overwrite the first -- `archiveStore` refuses an existing destination, and a fixed name
   * would make that refusal inevitable rather than exceptional.
   */
  private migrate(root: string, tree: string, dryRun: boolean): InitRow {
    if (dryRun) {
      return {
        action: 'migrate',
        target: join(tree, STORE_FILE),
        outcome: 'would migrate into the record tree and archive the store (not previewed)',
        dry_run: true,
      };
    }

    const stamp = this.now().replace(/[:.]/g, '-');
    const archiveDir = join(root, ARCHIVE_DIR, stamp);
    const report = migrateStoreToTree({ dir: tree, archiveDir });

    for (const dropped of report.dropped) {
      const named = dropped.keys.length === 0 ? '' : ` (${dropped.keys.join(', ')})`;
      this.warn(
        `the migration could not carry the ${dropped.table} table: ${String(dropped.rows)} ` +
          `row(s)${named}. A record tree holds types, entries, schemes and annotations, and this ` +
          `table is none of them. The archived store at ${archiveDir} still has them.`,
      );
    }

    return {
      action: 'migrate',
      target: join(tree, STORE_FILE),
      outcome: `${String(report.lines)} line(s) written to the tree; store archived to ${archiveDir}`,
      dry_run: false,
    };
  }

  /**
   * Report what registering the starters would do, writing nothing.
   *
   * Three sources, and which one is honest depends on what is here -- see this file's header for
   * why the legacy case cannot use the other two. Each of the three runs the REAL registrations and
   * throws the result away: `produceLines` and `previewProducedLines` both roll back, so no row
   * survives, no line is appended and no fingerprint is stamped. Nothing here can create the
   * directory it is previewing, which is the property a dry run of `init` most needs.
   */
  private preview(
    root: string,
    tree: string,
    indexFile: string,
    legacyStore: boolean,
    registerAll: (produce: Producers, db: SqlDatabase) => void,
  ): void {
    if (legacyStore) {
      this.withPreviewStore(openStore({ dir: tree, migrate: false }), (db) => {
        produceLines(db, (produce) => {
          registerAll(produce, db);
        });
      });
      return;
    }

    if (readRecordTree(tree).length > 0) {
      // A tree with no current index refuses here (`IndexStaleError`, naming `asc index build`),
      // which is the same answer every other preview gives and the honest one: this command cannot
      // report what a registration would do against a store it cannot read.
      previewProducedLines(tree, indexFile, registerAll);
      return;
    }

    this.withPreviewStore(
      openStore({ dir: ':memory:', ascendVersion: this.ascendVersion() }),
      (db) => {
        produceLines(db, (produce) => {
          registerAll(produce, db);
        });
      },
    );
  }

  /** Run `body` against a store opened only for a preview, and close it however the body ends. */
  private withPreviewStore(store: Store, body: (db: SqlDatabase) => void): void {
    try {
      body(store.db);
    } finally {
      store.close();
    }
  }

  /**
   * Add the ignore lines, and remove the one that ignored the whole store.
   *
   * Temp file plus rename, per `cli-best-practices` rule 7: a crash between the two leaves the
   * original `.gitignore` intact rather than truncated, and a truncated `.gitignore` would quietly
   * start committing whatever it used to exclude.
   *
   * Creating a `.gitignore` where none exists is only done when there is a repository to apply it
   * to. A `.gitignore` in a directory git does not track anything from is a file that does nothing,
   * and inventing one is the kind of unrequested edit this command exists to avoid.
   *
   * **The file is written in the store's own directory, and the repository is looked for ABOVE it
   * (asc-bcv.10, B6).** Those are two separate decisions and only the second was wrong: the target
   * was already the directory the store is created in, so a nested `.gitignore` was written
   * correctly whenever one existed to append to. What failed was the question that decides whether
   * to create one at all, which asked about `root` alone and so answered "no repository" for every
   * subdirectory of one. Writing at the repository root instead would have been the other possible
   * fix and is the worse one: it needs a relative path computed from the store to that root, and it
   * edits a file the user may have opinions about, to say something a scoped file says locally.
   *
   * An existing un-ignored store is repaired by running this command again -- `updateGitignore` runs
   * on every `asc init`, so the fix reaches stores created before it. That is the whole of the
   * existing-data plan, and it is why no migration exists for this finding. The same is true of the
   * `.ascend/` line this command used to write: a project that has one gets it removed the next time
   * `asc init` runs, which is the only upgrade path a `.gitignore` can have.
   *
   * **A `.gitignore` that is a SYMLINK is followed, not replaced (asc-bcv.11, B7).** The write is a
   * temp-file-then-rename, and renaming onto the link's own path replaces the LINK with a regular
   * file -- so a repository that deliberately shares one ignore file with others silently stops
   * sharing it, with no message and no way back (the target path is not recoverable from the file
   * afterwards). Measured (`/tmp/probe-b7.mjs`): the link went `isSymbolicLink` true -> false, its
   * content survived, and a second repository linked at the same target no longer saw the change.
   * Resolving the path ONCE with `realpathSync` and using the resolved path for BOTH the read and
   * the write is the fix; the read already followed the link, which is why only the write was wrong.
   *
   * The link is detected with `lstatSync`, NOT with `existsSync`. That distinction is the whole
   * reason this is a second bug and not a detail of the first: `existsSync` FOLLOWS a link, so a
   * DANGLING `.gitignore` symlink reports "no file here" and takes the create branch -- and gets
   * silently replaced by a regular file, which the probe's third arm measured. A broken link is
   * reported and left alone rather than written through.
   *
   * The warning is raised only when this run CHANGES the shared file. Re-running `asc init` on a
   * repository whose `.gitignore` is a link is the ordinary case, and a warning that fires when
   * nothing happened is noise that trains the warning away.
   */
  private updateGitignore(root: string, dryRun: boolean): InitRow {
    const requested = join(root, '.gitignore');
    const link = symlinkTarget(requested);

    // A link to nothing is not "no file here": writing would replace the link, which is the defect
    // this whole branch exists to avoid. Named rather than skipped silently, because a store left
    // un-ignored by a broken link is the kind of thing a `git add -A` finds later.
    if (link === null) {
      return {
        action: 'gitignore',
        target: requested,
        outcome:
          'skipped: .gitignore is a symlink to a file that does not exist, so it was left alone; ' +
          `point it at a file or remove it, then add these yourself: ${DERIVED_ENTRIES.join(', ')}`,
        dry_run: dryRun,
      };
    }

    // The path both read from and written to. `link` is the resolved target when `.gitignore` is a
    // symlink, and the requested path otherwise.
    const path = link ?? requested;

    if (!existsSync(path)) {
      if (findGitRoot(root) === undefined) {
        return {
          action: 'gitignore',
          target: requested,
          outcome: 'skipped: no .gitignore here and no git repository to apply one to',
          dry_run: dryRun,
        };
      }
      if (!dryRun) this.writeAtomically(path, `${DERIVED_ENTRIES.join('\n')}\n`);
      if (link !== undefined) this.warnSharedGitignore(requested, path);
      return { action: 'gitignore', target: requested, outcome: 'created', dry_run: dryRun };
    }

    let existing: string;
    try {
      existing = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `${path} exists but could not be read (${
          error instanceof Error ? error.message : String(error)
        }), so the store cannot be added to it. Add these lines by hand: ` +
          `${DERIVED_ENTRIES.join(', ')}, or make the file readable.`,
      );
    }

    const updated = updateIgnoreText(existing);
    if (updated === existing) {
      return {
        action: 'gitignore',
        target: requested,
        outcome: 'already correct',
        dry_run: dryRun,
      };
    }

    if (!dryRun) this.writeAtomically(path, updated);
    if (link !== undefined) this.warnSharedGitignore(requested, path);

    // Removing a line the user wrote is the one edit here worth saying out loud, and it is said even
    // on a dry run: this is precisely the change someone would want to veto before it happens.
    if (removesStoreLine(existing)) {
      this.warn(
        `'${STORE_DIR}/' was removed from ${requested}: the record tree inside it IS this project's ` +
          `store, so ignoring the directory would leave every record uncommitted. The derived and ` +
          `machine-local files that must stay ignored are named individually instead ` +
          `(${DERIVED_ENTRIES.join(', ')}).`,
      );
    }

    return { action: 'gitignore', target: requested, outcome: 'updated', dry_run: dryRun };
  }

  /**
   * Say that the entry landed in a file this project does not own.
   *
   * Only raised when something was actually written, because the fact worth knowing is not "your
   * `.gitignore` is a link" -- that is the user's own arrangement -- but "the lines ascend just
   * added are now in every repository that shares this file".
   */
  private warnSharedGitignore(requested: string, path: string): void {
    this.warn(
      `${requested} is a symlink, so ascend's ignore lines were written to ${path} -- the file it ` +
        `points at -- rather than replacing the link with a regular file. Every repository sharing ` +
        `that file now ignores ${DERIVED_ENTRIES.join(', ')} as well.`,
    );
  }

  private writeAtomically(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.ascend-tmp`;
    writeFileSync(temporary, contents, 'utf8');
    renameSync(temporary, path);
  }

  /**
   * Say what recall is, and that installing it is a separate, consented act.
   *
   * stderr, not stdout: this is advice rather than a result, and `output.ts` keeps stdout for data
   * alone. Wording avoids naming a settings key or a JSON snippet -- the exact wiring is
   * `asc install-hook`'s to get right (E10), and printing a snippet here that the installer then
   * formats differently would be two answers to one question.
   */
  private offerRecall(): void {
    this.warn(
      'recall: ascend can add a SessionStart hook that runs `asc types brief`, so each session ' +
        'starts knowing which types exist and when to record them. It does not make a session ' +
        'record -- availability was measured not to be adoption (docs/evidence/EV-16.md), and this ' +
        'hook is the selection half, not the recall half -- but it is what tells a session that has ' +
        'already decided to record which type to use. ascend will not edit your settings ' +
        'to do it: `asc install-hook` adds it, with your explicit consent, and ' +
        '`asc install-hook --dry-run` shows exactly what it would write before anything does.',
    );
  }
}
