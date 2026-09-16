/**
 * `asc import <file|->` -- restore a corpus written by `asc export`.
 *
 * The other half of the escape hatch. Everything here exists to make one promise true: **a restored
 * corpus is the same corpus.** Ids, `recorded_at`, property values, the not-applicable list,
 * provenance and the build that wrote each row are all restored verbatim, and the definitions come
 * with them because an entry's `type_hash` points at one.
 *
 * **It is all-or-nothing, and that is stronger than `asc types import`.** Registration cannot lose
 * anything by being re-run -- a known shape is `unchanged` -- so that command lets a partial failure
 * stand and says which document failed. An entry cannot be re-run: entries are immutable and
 * `recordEntry` refuses a duplicate id, so a half-applied corpus is a corpus that can never be
 * completed by retrying. So the whole restore runs inside one transaction and any refusal rolls
 * back every row of it.
 *
 * **Everything is checked before anything is written.** The stream is parsed, every type hash is
 * recomputed, and every entry id is looked up in the target store, all before the transaction
 * opens. The conflicts those find are the ones a caller can act on -- this project already holds
 * that id, this project's definition of that name is not the one the corpus was recorded against --
 * and finding them after four thousand rows had landed would be the same finding with a worse
 * repair.
 *
 * **`--dry-run` owns one transaction for the whole stream, like `asc types import`'s.** Previewing
 * each registration separately would mean the second type never sees the first, so it would compute
 * its version as though the first did not exist -- reporting version 1 twice where the real run
 * produces 1 then 2. `withRollback` runs the real code and discards it, so the preview cannot
 * describe a restore the real run would not produce.
 *
 * **One re-run is refused, deliberately.** Restoring a corpus twice meets the first entry's id
 * already present, and this refuses rather than skipping it. Skipping would make the command a
 * sync, which has a different and much harder contract -- what if a row differs? -- and there is
 * nothing to sync toward, because entries are immutable. The message says the corpus is already
 * there so a caller who re-ran by accident knows nothing is wrong.
 */

import { Args, Flags } from '@oclif/core';
import {
  findEntry,
  listTypes,
  recordEntry,
  typeVersions,
  withRollback,
  withTransaction,
  type Store,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import {
  parseCorpus,
  verifyTypeLine,
  type EntryLine,
  type ParsedLine,
  type TypeLine,
} from '../corpus.js';
import { refusal } from '../errors.js';
import { readInput } from '../input.js';
import { registerDocument } from '../register-document.js';

/** A row of the report: what happened to one line. */
interface ImportRow extends Record<string, unknown> {
  readonly kind: string;
  readonly name: string;
  readonly version: number;
  readonly outcome: string;
  readonly id: string | null;
}

export default class ImportCorpus extends BaseCommand {
  static override description = 'Restore type definitions and entries from an `asc export` stream.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> corpus.jsonl',
    '<%= config.bin %> <%= command.id %> --dry-run corpus.jsonl',
    '<%= config.bin %> export | <%= config.bin %> <%= command.id %> -',
  ];

  static override args = {
    // `ignoreStdin`, for the reason `types import` records: without it oclif fills a missing path
    // from stdin and then fails with `ENOENT` quoting the corpus back at the caller.
    file: Args.string({
      description: 'Path to an `asc export` stream, or `-` to read from standard input.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    'dry-run': Flags.boolean({
      description: 'Report exactly what would happen, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ImportCorpus);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const source = args.file === '-' ? 'standard input' : args.file;
    const lines = parseCorpus(await readInput(args.file), source);

    // Every hash, before any write -- the same rule `types import` states, and the same reason:
    // registering a definition under an identity its contents do not have makes two corpora stop
    // being comparable without anything recording that they had.
    for (const { where, line } of lines) {
      if (line.kind === 'type') verifyTypeLine(line, where);
    }

    // The line's own coordinate travels with it (`ParsedLine`). Numbering these two lists by their
    // position in the list -- which is what this did -- reports the FIRST entry as `line 1` however
    // far into the file it actually is.
    const types = lines.filter(
      (parsed): parsed is ParsedLine & { line: TypeLine } => parsed.line.kind === 'type',
    );
    const entries = lines.filter(
      (parsed): parsed is ParsedLine & { line: EntryLine } => parsed.line.kind === 'entry',
    );
    refuseUnrestorable(source, types.length, entries.length);

    await this.withProject(({ store }) => {
      // The id conflicts, before the transaction opens. `findEntry` is the existence check rather
      // than a query of this command's own, so "is this id taken" has one answer in the codebase.
      refuseTakenIds(store, entries, source);

      // The names this project already had, read before the stream is applied. It is what tells the
      // two version refusals apart (`versionMismatch`), and it has to be read here rather than
      // inside the transaction because it describes the project as the caller found it.
      const preexisting = namesRegistered(store);

      const rows: ImportRow[] = [];

      /** Register every definition, in order, then restore every entry against it. */
      const restoreAll = (): void => {
        for (const { line } of types) {
          const result = registerDocument(store, line.document, {
            registeredAt: this.now(),
            dryRun: false,
          });
          rows.push({
            kind: 'type',
            name: result.name,
            version: result.version,
            outcome: result.outcome,
            id: null,
          });
        }

        const versions = versionsByHash(store);

        for (const { where, line: entry } of entries) {
          const resolved = versions.get(hashKey(entry.type_name, entry.type_hash));
          if (resolved === undefined) {
            throw refusal(
              `entry ${entry.id} (${where}) was recorded against ${entry.type_name} version ` +
                `${String(entry.type_version)} with type_hash ${entry.type_hash}, and that ` +
                `definition is not registered here after the definitions in this stream were ` +
                `applied. This project's '${entry.type_name}' is a different definition, so ` +
                `restoring the entry would attach it to a spec it was not recorded against.`,
            );
          }
          if (resolved !== entry.type_version) {
            throw versionMismatch(entry, where, resolved, preexisting.has(entry.type_name));
          }

          recordFromLine(store, entry);
          rows.push({
            kind: 'entry',
            name: entry.type_name,
            version: entry.type_version,
            outcome: 'restored',
            id: entry.id,
          });
        }
      };

      if (dryRun) {
        try {
          withRollback(store.db, restoreAll);
        } catch (error) {
          this.warn(
            'the dry run failed, so the whole preview was discarded and nothing was written. ' +
              'A dry run is all-or-nothing: it cannot report a partial restore it did not make.',
          );
          throw error;
        }
        this.warn('dry run: nothing was written.');
      } else {
        withTransaction(store.db, restoreAll);
      }

      // Emitted after the transaction commits, not inside it: a report that was rolled back with
      // the restore would describe a corpus that does not exist.
      this.emit(format, { columns: [...COLUMNS], rows });
    });
  }
}

/**
 * Refuse an entry whose version number is not the one this restore mints for its hash.
 *
 * **Two different findings reach here, and the first draft of this message confused them.** It said
 * the file was "internally inconsistent", which was measured to be false in the common case: two
 * projects that independently invented the same type name with different shapes, where the target
 * mints the corpus's definition as its *second* version because its own came first. The corpus is
 * perfectly consistent; the target is the one whose numbering differs. Telling that caller to
 * re-export their file sends them to fix the one thing that is not broken.
 *
 * The discriminator is whether this project held any version of that name before the restore, which
 * is why `namesRegistered` is read as a pre-pass:
 *
 *  - **It did.** The stream's numbers and the project's are two numbering schemes over the same
 *    definitions. Nothing is wrong with the file; the restore is simply into the wrong project.
 *  - **It did not.** Every number came from the stream itself, so a number that disagrees came from
 *    the file -- re-exported, filtered, concatenated or edited by hand.
 *
 * Both refuse, and here is the reason that is a decision rather than a default: the version an entry
 * names is one of the columns a restore keeps verbatim, and `findEntry` resolves the definition it
 * validates a row against by `(name, version)` rather than by hash (measured -- `recorder.ts`). So
 * storing the entry under this project's number instead would not be a faithful restore of the row,
 * it would be a *different* row: the one column that decides which spec the row is checked against.
 * A caller who wants the merge rather than the restore can import the definitions with
 * `asc types import` and reconcile the numbering deliberately.
 */
function versionMismatch(
  entry: EntryLine,
  where: string,
  resolved: number,
  preexistingName: boolean,
): Error {
  const identity =
    `entry ${entry.id} (${where}) was recorded against ${entry.type_name} version ` +
    String(entry.type_version);

  if (preexistingName) {
    return refusal(
      `${identity}, and this restore registers that definition (type_hash ${entry.type_hash}) as ` +
        `version ${String(resolved)} -- because this project already held its own ` +
        `${entry.type_name}, so the corpus's numbers and this project's are not the same numbers. ` +
        `The entry is not restored under a different version: the version decides which definition ` +
        `the row is checked against, so changing it would store a different row rather than restore ` +
        `this one. Nothing was written. Restore this corpus into a project that does not already ` +
        `hold a different ${entry.type_name}, or move the definitions with \`asc types import\` and ` +
        `reconcile the numbering deliberately.`,
    );
  }

  return refusal(
    `${identity} with type_hash ${entry.type_hash}, but the definitions in this stream register ` +
      `that hash as version ${String(resolved)} -- and this project held no ${entry.type_name} ` +
      `before the restore, so those numbers came from the stream and the entry disagrees with it. ` +
      `Re-export the corpus rather than editing, filtering or concatenating the file: nothing was ` +
      `written.`,
  );
}

/** The type names this project holds at least one version of. See `versionMismatch`. */
function namesRegistered(store: Store): ReadonlySet<string> {
  return new Set(listTypes(store.db).map((summary) => summary.name));
}

/**
 * Refuse a stream that cannot restore anything, before the store is opened.
 *
 * Zero lines is not a successful restore, for the reason `asc record` refuses an empty batch:
 * "restored everything" and "restored nothing" would otherwise be the same report. And entries
 * without definitions are refused here rather than at the first entry, so the answer is about the
 * file rather than about whichever line happened to be first.
 */
function refuseUnrestorable(source: string, typeCount: number, entryCount: number): void {
  if (typeCount === 0 && entryCount === 0) {
    throw refusal(
      `${source} holds no corpus lines, so there is nothing to restore. An \`asc export\` of a ` +
        `project with no types and no entries writes zero bytes, and this is what that looks ` +
        `like fed back in.`,
    );
  }

  if (typeCount === 0) {
    throw refusal(
      `${source} holds ${String(entryCount)} entry line(s) and no type definitions. An entry's ` +
        `type_hash points at a definition, so a corpus restored without them cannot render its ` +
        `own views. Re-export with \`asc export\`, which always writes the definitions first.`,
    );
  }
}

/**
 * Refuse when the target already holds any of these ids.
 *
 * A pre-pass rather than letting `recordEntry` discover it, for two reasons: the message can name
 * how many conflict and which, and the check runs before the transaction opens, so a corpus that
 * cannot land does not touch the store at all. `recordEntry` still refuses a duplicate -- this is
 * not the only guard, it is the earlier and more informative one.
 */
function refuseTakenIds(
  store: Store,
  entries: readonly (ParsedLine & { line: EntryLine })[],
  source: string,
): void {
  const taken = entries.filter(({ line }) => findEntry(store.db, line.id) !== undefined);
  if (taken.length === 0) return;

  const shown = taken.slice(0, 3).map(({ line }) => line.id);
  const rest = taken.length - shown.length;
  const list = rest === 0 ? shown.join(', ') : `${shown.join(', ')}, and ${String(rest)} more`;

  throw refusal(
    `${source} holds ${String(taken.length)} of ${String(entries.length)} entry id(s) this ` +
      `project already has (${list}). Entries are immutable and a recorded id cannot be replaced, ` +
      `so nothing was written. If this corpus was already restored, there is nothing to do: the ` +
      `rows are the ones from the file. If it is a different corpus, restore it into a project ` +
      `that does not hold those ids.`,
  );
}

/**
 * Restore one entry, verbatim.
 *
 * `recordEntry` is the only writer of entries and is used rather than a direct INSERT, so a
 * restored row passes the same validation a recorded one does: an entry the definition would not
 * accept is refused here instead of becoming a row the read path later fails on.
 *
 * Every optional field is omitted rather than passed as `null`. The store's `requireNonEmpty`
 * treats a present-but-empty value as an error, so passing the nulls through would turn "not
 * recorded" into a refusal -- and `exactOptionalPropertyTypes` is on besides, where an explicit
 * `undefined` is a different type from an absent key.
 */
function recordFromLine(store: Store, entry: EntryLine): void {
  const request = {
    type: entry.type_name,
    version: entry.type_version,
    properties: entry.properties,
    na: entry.na,
  };

  recordEntry(store.db, request, {
    id: entry.id,
    recordedAt: entry.recorded_at,
    source: entry.source,
    ascendVersion: entry.ascend_version,
    schemaVersion: entry.schema_version,
    ...(entry.run_id === null ? {} : { runId: entry.run_id }),
    ...(entry.workflow === null ? {} : { workflow: entry.workflow }),
    ...(entry.actor === null ? {} : { actor: entry.actor }),
    ...(entry.cwd === null ? {} : { cwd: entry.cwd }),
    ...(entry.repo === null ? {} : { repo: entry.repo }),
    ...(entry.git_sha === null ? {} : { gitSha: entry.git_sha }),
    ...(entry.branch === null ? {} : { branch: entry.branch }),
    ...(entry.evidence_text === null ? {} : { evidenceText: entry.evidence_text }),
  });
}

/** The key a type version is looked up by: its name and its content hash. */
function hashKey(name: string, hash: string): string {
  return `${name} ${hash}`;
}

/** Every registered version, keyed by its type's name and its hash. */
function versionsByHash(store: Store): ReadonlyMap<string, number> {
  const versions = new Map<string, number>();

  for (const summary of listTypes(store.db)) {
    for (const row of typeVersions(store.db, summary.name)) {
      versions.set(hashKey(row.name, row.typeHash), row.version);
    }
  }

  return versions;
}

/**
 * The projection for the table and CSV. `--json` reports the rows as they are, ids included.
 *
 * `id` is deliberately absent from the table: a restore is read as "how much landed, and of what",
 * and a terminal full of UUIDs is not that answer.
 */
const COLUMNS = ['kind', 'name', 'version', 'outcome'] as const;
