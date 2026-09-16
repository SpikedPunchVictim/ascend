/**
 * `asc init` -- make the current directory a project.
 *
 * Four things happen, and the report is one row each so `--json` describes the same run the table
 * does (`output.ts`: a row per action, not a paragraph per action).
 *
 * 1. **The store.** `.ascend/` is created and migrated. `openStore` does both, so this command
 *    does not carry a second copy of "what a store is".
 * 2. **The gitignore.** `.ascend/` is appended to `.gitignore`, because the store is local state:
 *    a database, a WAL and a SHM file that mean nothing to anyone else and conflict on every
 *    merge. Appended, never rewritten -- a `.gitignore` is the user's file and may hold anything.
 * 3. **The starter types.** The four in `starters.ts`, registered through the ordinary
 *    `registerDocument` path so they version, diff and export exactly like a user's own. Re-running
 *    is not "safe", it is *useful*: improved starter prose lands as `prose-updated` rather than
 *    being dropped as `unchanged` (`register-document.ts`).
 * 4. **The recall hook, OFFERED and not installed.** See below.
 *
 * **The offer is the whole of this command's involvement with settings.** `ARCHITECTURE.md`:
 * ascend "never silently edits a user's settings file", and the write is `asc install-hook`'s job
 * (E10) behind explicit consent. So this prints what the hook would be and which command will
 * install it, and touches nothing. Printing it is not decoration -- the product's primary failure
 * mode is an empty database, and a user who does not know recall exists will not ask for it. The
 * offer is reported as a row so a script can see that there is something outstanding.
 *
 * **Idempotent.** Every step is: the store is created if absent, the ignore line is added if
 * absent, and a known shape registers as `unchanged`.
 *
 * **A store in an ancestor is a warning, not a refusal.** Running this inside a subdirectory of an
 * existing project creates a nested store that SHADOWS the ancestor's, because `openProject` walks
 * up from the working directory and stops at the first `.ascend/`. That is worth saying loudly and
 * is not worth refusing: `asc query --across` exists precisely because more than one store in a
 * tree is a supported shape, and refusing would make a legitimate layout unreachable.
 *
 * **`--dry-run` opens nothing it would have to create.** With no store present it previews against
 * an in-memory one, which reports exactly the versions a real run would produce (all `created`, all
 * version 1). With one present it opens it read-only-in-effect (`migrate: false`) and performs the
 * registrations inside a single rollback, so the registry is untouched. `--dry-run` never writes
 * the gitignore at all.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { openStore, STORE_DIR, STORE_FILE, withRollback, type Store } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { findGitRoot, findProjectRoot } from '../project.js';
import { registerDocument } from '../register-document.js';
import { STARTER_TYPES } from '../starters.js';
import { symlinkTarget } from '../symlink.js';

/** One row of the report: what was touched, and what happened to it. */
interface InitRow extends Record<string, unknown> {
  readonly action: string;
  readonly target: string;
  readonly outcome: string;
  readonly dry_run: boolean;
}

/** The line added to `.gitignore`. The trailing slash ignores the directory and its contents. */
const IGNORE_ENTRY = `${STORE_DIR}/`;

/**
 * Does this `.gitignore` already ignore the store directory?
 *
 * Four spellings, because git accepts all four and a user who wrote `/.ascend/` has already done
 * what this command would do.
 *
 * **A `!` re-include needs no special case, and this is measured rather than assumed.** The
 * obvious guard -- skip lines beginning with `!` -- was written first and then removed, because it
 * cannot fire: every line is compared by EQUALITY against the four spellings above, and `!`
 * prefixed onto any of them (`!.ascend`, `!.ascend/`, `!/.ascend`, `!/.ascend/`) is unequal to all
 * four. So the branch was unreachable, and an unreachable guard reads like a handled case while
 * handling nothing -- the defect class `packages/core/test/purity-enforcement.test.ts` exists to
 * prevent. `init.test.ts` asserts the behaviour this depends on, so the claim is checked even
 * though the code no longer mentions it.
 */
function ignoresStore(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    return ['', '/'].some((prefix) =>
      [STORE_DIR, `${STORE_DIR}/`].some((name) => trimmed === `${prefix}${name}`),
    );
  });
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

  public async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);

    const root = resolve(process.cwd());
    const storeDir = join(root, STORE_DIR);
    const storeExists = existsSync(join(storeDir, STORE_FILE));

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

    const store = this.openStoreFor(storeDir, storeExists, dryRun);
    try {
      rows.push({
        action: 'store',
        target: join(storeDir, STORE_FILE),
        outcome: storeExists ? 'already present' : 'created',
        dry_run: dryRun,
      });

      rows.push(this.updateGitignore(root, dryRun));

      const registerAll = (): void => {
        for (const spec of STARTER_TYPES) {
          const result = registerDocument(store, spec, {
            registeredAt: this.now(),
            // `false` even in a dry run: the rollback belongs to this command and spans the whole
            // list. Asking each registration to undo itself would leave the second starter blind
            // to the first -- the defect `types/import.ts` records at length.
            dryRun: false,
          });
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

      if (dryRun) {
        withRollback(store.db, registerAll);
      } else {
        registerAll();
      }
    } finally {
      store.close();
    }

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
   * The store this command registers into.
   *
   * Three cases, and the `--dry-run` ones are the point: a dry run must not create the thing it is
   * previewing, so with no store present it previews against `:memory:` -- which reports the same
   * versions a real run would, because a fresh registry has no versions to conflict with. With a
   * store present it opens that one but without migrating: opening normally would apply pending
   * migrations, which is a write, and a dry run that silently upgraded a database would be
   * reporting on a store it had already changed.
   */
  private openStoreFor(storeDir: string, storeExists: boolean, dryRun: boolean): Store {
    const ascendVersion = this.ascendVersion();
    if (!dryRun) return openStore({ dir: storeDir, ascendVersion });
    if (!storeExists) return openStore({ dir: ':memory:', ascendVersion });
    return openStore({ dir: storeDir, ascendVersion, migrate: false });
  }

  /**
   * Add the ignore line, atomically.
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
   * existing-data plan, and it is why no migration exists for this finding.
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
          `point it at a file or remove it, then add '${IGNORE_ENTRY}' yourself`,
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
      if (!dryRun) this.writeAtomically(path, `${IGNORE_ENTRY}\n`);
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
        }), so the store cannot be added to it. Add '${IGNORE_ENTRY}' by hand, or make the file readable.`,
      );
    }

    if (ignoresStore(existing)) {
      return {
        action: 'gitignore',
        target: requested,
        outcome: 'already ignores it',
        dry_run: dryRun,
      };
    }

    // A file whose last line has no terminator would otherwise get the new entry glued onto it --
    // turning an unrelated ignore rule into one nobody wrote.
    const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
    if (!dryRun) this.writeAtomically(path, `${existing}${separator}${IGNORE_ENTRY}\n`);
    if (link !== undefined) this.warnSharedGitignore(requested, path);
    return { action: 'gitignore', target: requested, outcome: 'appended', dry_run: dryRun };
  }

  /**
   * Say that the entry landed in a file this project does not own.
   *
   * Only raised when something was actually written, because the fact worth knowing is not "your
   * `.gitignore` is a link" -- that is the user's own arrangement -- but "the line ascend just added
   * is now in every repository that shares this file".
   */
  private warnSharedGitignore(requested: string, path: string): void {
    this.warn(
      `${requested} is a symlink, so '${IGNORE_ENTRY}' was added to ${path} -- the file it points ` +
        `at -- rather than replacing the link with a regular file. Every repository sharing that ` +
        `file now ignores ${STORE_DIR}/ as well.`,
    );
  }

  private writeAtomically(path: string, contents: string): void {
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
        'starts knowing which types exist and when to record them -- the failure this product ' +
        'actually faces is an empty database, not a bad one. ascend will not edit your settings ' +
        'to do it: `asc install-hook` adds it, with your explicit consent, and ' +
        '`asc install-hook --dry-run` shows exactly what it would write before anything does.',
    );
  }
}
