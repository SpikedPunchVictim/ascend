/**
 * `asc import <file|->` -- restore a corpus written by `asc export`.
 *
 * The other half of the escape hatch. Everything here exists to make one promise true: **a restored
 * corpus is the same corpus.** Ids, `recorded_at`, property values, the not-applicable list,
 * provenance and the build that wrote each row are all restored verbatim, and the definitions come
 * with them because an entry's `type_hash` points at one -- and since `asc-6u5`, that promise
 * covers annotation schemes and the annotations recorded under them too, not only entries.
 *
 * **It is all-or-nothing, and that is stronger than `asc types import`.** Registration cannot lose
 * anything by being re-run -- a known shape is `unchanged` -- so that command lets a partial failure
 * stand and says which document failed. An entry cannot be re-run: entries are immutable and
 * `recordEntry` refuses a duplicate id, so a half-applied corpus is a corpus that can never be
 * completed by retrying. Annotations are the same: they are append-only, so a half-restored pass can
 * never be finished by retrying either. So the whole restore runs inside one transaction and any
 * refusal rolls back every row of it.
 *
 * **Everything is checked before anything is written.** The stream is parsed, every type hash and
 * scheme hash is recomputed, and every entry id, annotation id, annotation-entry reference and
 * annotation-scheme reference is looked up against the target store, all before the transaction
 * opens. The conflicts those find are the ones a caller can act on -- this project already holds
 * that id, this project's definition of that name is not the one the corpus was recorded against --
 * and finding them after four thousand rows had landed would be the same finding with a worse
 * repair.
 *
 * **An annotation is restored as part of a PASS, never as an independent row.** `recordAnnotations`
 * stamps one `created_at`/`created_by` onto every row of a single call, and that stamp -- together
 * with the scheme and its version -- is what a pass IS (`annotations.ts`, `RecordedAnnotations`).
 * So this groups the stream's annotation lines by `(scheme, scheme_version, created_at,
 * created_by)`, preserving each group's stream order, and issues one `recordAnnotations` call per
 * group with that group's own timestamp and author fed back in as the write context. Restoring row
 * by row instead would stamp every annotation with the moment of THIS import and collapse every
 * pass a scheme ever ran into one -- `asc kappa` would still run, but it would be comparing a
 * scheme against itself, and no row count would show it.
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
  annotationRows,
  entryIds,
  findEntry,
  listSchemes,
  listTypes,
  recordAnnotations,
  recordEntry,
  registerScheme,
  schemeVersions,
  typeVersions,
  withRollback,
  withTransaction,
  type Store,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import {
  parseCorpus,
  verifySchemeLine,
  verifyTypeLine,
  type AnnotationLine,
  type EntryLine,
  type ParsedLine,
  type SchemeLine,
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
  static override description =
    'Restore type definitions, entries, annotation schemes, and annotations from an `asc export` stream.';

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
      if (line.kind === 'scheme') verifySchemeLine(line, where);
    }

    // The line's own coordinate travels with it (`ParsedLine`). Numbering these lists by their
    // position in the list -- which is what this did originally -- reports the FIRST entry as
    // `line 1` however far into the file it actually is.
    const types = lines.filter(
      (parsed): parsed is ParsedLine & { line: TypeLine } => parsed.line.kind === 'type',
    );
    const entries = lines.filter(
      (parsed): parsed is ParsedLine & { line: EntryLine } => parsed.line.kind === 'entry',
    );
    const schemes = lines.filter(
      (parsed): parsed is ParsedLine & { line: SchemeLine } => parsed.line.kind === 'scheme',
    );
    const annotations = lines.filter(
      (parsed): parsed is ParsedLine & { line: AnnotationLine } =>
        parsed.line.kind === 'annotation',
    );
    refuseUnrestorable(source, types.length, entries.length, schemes.length, annotations.length);

    await this.withProject(({ store }) => {
      // The id conflicts, before the transaction opens. `findEntry` is the existence check rather
      // than a query of this command's own, so "is this id taken" has one answer in the codebase.
      refuseTakenIds(store, entries, source);
      refuseTakenAnnotationIds(store, annotations, source);
      // The two foreign keys `annotations` carries (`schema.ts`), checked before the transaction so
      // a bad reference is a named refusal rather than a raw SQLite foreign-key error with no
      // context (see each function's own doc for why a raw error is not good enough here).
      refuseUnknownAnnotationEntries(store, annotations, entries, source);
      refuseUnknownAnnotationSchemes(store, annotations, schemes, source);

      // The names this project already had, read before the stream is applied. It is what tells the
      // two version refusals apart (`versionMismatch`, `schemeVersionMismatch`), and it has to be
      // read here rather than inside the transaction because it describes the project as the caller
      // found it.
      const preexisting = namesRegistered(store);
      const preexistingSchemes = schemeNamesRegistered(store);

      const rows: ImportRow[] = [];

      /**
       * Register every definition, in order, then restore every entry and every annotation pass
       * against them.
       */
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

        // Schemes, in stream order -- oldest version of each name first, the same replay `export`
        // relies on for types. Each scheme line makes its OWN version claim (unlike a type
        // document, which carries none), so the check that the store minted the claimed number is
        // made right here, immediately after the call that could disagree with it -- there is no
        // need for a `versionsByHash`-style map built after the fact, because there is exactly one
        // `registerScheme` call per line and its return value already IS the resolution by hash.
        for (const { where, line: scheme } of schemes) {
          const result = registerScheme(store.db, scheme.name, scheme.spec, {
            createdAt: scheme.created_at,
          });
          if (result.version !== scheme.version) {
            throw schemeVersionMismatch(
              scheme,
              where,
              result.version,
              preexistingSchemes.has(scheme.name),
            );
          }
          rows.push({
            kind: 'scheme',
            name: result.name,
            version: result.version,
            outcome: result.outcome,
            id: null,
          });
        }

        // Every annotation line restored as part of the PASS it belongs to, not on its own -- see
        // the module doc and `annotationPassGroups`. One `recordAnnotations` call per group, and
        // one report row per call: `recordAnnotations` is a pass-level write, so a report that gave
        // it one row per annotation would be reporting a write that never happened at that grain.
        for (const group of annotationPassGroups(annotations)) {
          const result = recordAnnotations(
            store.db,
            {
              scheme: group.scheme,
              schemeVersion: group.schemeVersion,
              annotations: group.lines.map(({ line }) => ({
                id: line.id,
                entryId: line.entry_id,
                label: line.label,
                // `undefined` is absence here, and `null` is a value the annotation held --
                // `AnnotationLine.value` is an OPTIONAL key for exactly this reason, so testing
                // against `null` would drop a legitimate JSON `null` on the way back in.
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
          rows.push({
            kind: 'annotation',
            name: result.scheme,
            version: result.schemeVersion,
            outcome: 'restored',
            id: null,
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

/**
 * Refuse a scheme line whose version number is not the one this restore mints for its spec.
 *
 * Mirrors `versionMismatch` above, for the identical reason applied to a different table: a
 * scheme's version decides which spec `recordAnnotations` checks a restored pass's labels against
 * (`requireScheme`, `annotations.ts`), so registering the line under a renumbered version would
 * attach its annotations to a rule they were not actually run against -- a different pass, not the
 * one being restored. The same two-case split applies, for the same reason: whether this project
 * already held a version of the name before the restore is what tells "the file is damaged" apart
 * from "this restore's numbers and the target's are two numbering schemes over the same schemes".
 * See `versionMismatch`'s longer comment for the argument in full; it is not repeated here.
 */
function schemeVersionMismatch(
  line: SchemeLine,
  where: string,
  minted: number,
  preexistingName: boolean,
): Error {
  const identity = `scheme '${line.name}' (${where}) claims version ${String(line.version)}`;

  if (preexistingName) {
    return refusal(
      `${identity}, and this restore registers that spec (scheme_hash ${line.scheme_hash}) as ` +
        `version ${String(minted)} -- because this project already held its own '${line.name}', ` +
        `so the corpus's numbers and this project's are not the same numbers. The annotations ` +
        `under this scheme are not restored under a different version: the version decides which ` +
        `spec a pass was run against, so changing it would store a different pass rather than ` +
        `restore this one. Nothing was written. Restore this corpus into a project that does not ` +
        `already hold a different '${line.name}'.`,
    );
  }

  return refusal(
    `${identity} with scheme_hash ${line.scheme_hash}, but the schemes in this stream register ` +
      `that hash as version ${String(minted)} -- and this project held no '${line.name}' before ` +
      `the restore, so those numbers came from the stream and this line disagrees with it. ` +
      `Re-export the corpus rather than editing, filtering or concatenating the file: nothing was ` +
      `written.`,
  );
}

/** The type names this project holds at least one version of. See `versionMismatch`. */
function namesRegistered(store: Store): ReadonlySet<string> {
  return new Set(listTypes(store.db).map((summary) => summary.name));
}

/** The scheme names this project holds at least one version of. See `schemeVersionMismatch`. */
function schemeNamesRegistered(store: Store): ReadonlySet<string> {
  return new Set(listSchemes(store.db).map((summary) => summary.name));
}

/**
 * Refuse a stream that cannot restore anything, before the store is opened.
 *
 * Zero lines is not a successful restore, for the reason `asc record` refuses an empty batch:
 * "restored everything" and "restored nothing" would otherwise be the same report. And entries
 * without definitions -- now annotations without schemes too -- are refused here rather than at
 * the first offending line, so the answer is about the file rather than about whichever line
 * happened to be first.
 *
 * The four counts are independent on purpose: a file can hold schemes and annotations with no
 * types or entries at all (a corpus restored earlier, then re-annotated and re-exported for just
 * that half), so "nothing to restore" is only true when ALL FOUR are absent, not when the first
 * two are.
 */
function refuseUnrestorable(
  source: string,
  typeCount: number,
  entryCount: number,
  schemeCount: number,
  annotationCount: number,
): void {
  if (typeCount === 0 && entryCount === 0 && schemeCount === 0 && annotationCount === 0) {
    throw refusal(
      `${source} holds no corpus lines, so there is nothing to restore. An \`asc export\` of a ` +
        `project with no types, no entries, no annotation schemes, and no annotations writes zero ` +
        `bytes, and this is what that looks like fed back in.`,
    );
  }

  if (typeCount === 0 && entryCount > 0) {
    throw refusal(
      `${source} holds ${String(entryCount)} entry line(s) and no type definitions. An entry's ` +
        `type_hash points at a definition, so a corpus restored without them cannot render its ` +
        `own views. Re-export with \`asc export\`, which always writes the definitions first.`,
    );
  }

  if (schemeCount === 0 && annotationCount > 0) {
    throw refusal(
      `${source} holds ${String(annotationCount)} annotation line(s) and no annotation scheme ` +
        `definitions. An annotation's (scheme, scheme_version) points at a scheme version, so a ` +
        `corpus restored without it cannot say what rule the label came from -- which is the whole ` +
        `reason \`asc kappa\` exists to compare two passes rather than trust one. Re-export with ` +
        `\`asc export\`, which always writes the definitions first.`,
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
 * Every annotation id this project's `annotations` table already holds.
 *
 * There is no `findEntry`-style single-id reader for annotations -- `annotations.ts` never needed
 * one -- so this reads every existing annotation once, scheme version by scheme version, and tests
 * membership rather than querying once per candidate id the way `refuseTakenIds` does for entries.
 */
function existingAnnotationIds(store: Store): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const summary of listSchemes(store.db)) {
    for (const version of schemeVersions(store.db, summary.name)) {
      for (const row of annotationRows(store.db, {
        scheme: version.name,
        version: version.version,
      })) {
        ids.add(row.id);
      }
    }
  }
  return ids;
}

/**
 * Refuse when the target already holds any of these annotation ids.
 *
 * The same shape as `refuseTakenIds`, and the same two reasons: the message can name how many
 * conflict and which, and it runs before the transaction opens so a corpus that cannot land does
 * not touch the store at all. Annotations are append-only (`annotations.ts`), so a taken id can no
 * more be replaced than a taken entry id can.
 */
function refuseTakenAnnotationIds(
  store: Store,
  annotations: readonly (ParsedLine & { line: AnnotationLine })[],
  source: string,
): void {
  if (annotations.length === 0) return;

  const existing = existingAnnotationIds(store);
  const taken = annotations.filter(({ line }) => existing.has(line.id));
  if (taken.length === 0) return;

  const shown = taken.slice(0, 3).map(({ line }) => line.id);
  const rest = taken.length - shown.length;
  const list = rest === 0 ? shown.join(', ') : `${shown.join(', ')}, and ${String(rest)} more`;

  throw refusal(
    `${source} holds ${String(taken.length)} of ${String(annotations.length)} annotation id(s) ` +
      `this project already has (${list}). Annotations are append-only and a recorded id cannot be ` +
      `replaced, so nothing was written. If this corpus was already restored, there is nothing to ` +
      `do: the rows are the ones from the file. If it is a different corpus, restore it into a ` +
      `project that does not hold those ids.`,
  );
}

/** Every entry id this project's `entries` table already holds, across every type. */
function existingEntryIds(store: Store): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const summary of listTypes(store.db)) {
    for (const id of entryIds(store.db, summary.name)) ids.add(id);
  }
  return ids;
}

/**
 * Refuse an annotation whose `entry_id` names neither one of this stream's own entries nor one
 * this project already has.
 *
 * Checked here, before the transaction opens, rather than left to `recordAnnotations`'s own
 * existence check (`annotations.ts`: "entry '...' does not exist") for the reason every other
 * pre-flight check in this file gives: the message can name how many and which, all at once,
 * instead of failing on the first one deep inside a transaction that then rolls back everything
 * anyway.
 */
function refuseUnknownAnnotationEntries(
  store: Store,
  annotations: readonly (ParsedLine & { line: AnnotationLine })[],
  entries: readonly (ParsedLine & { line: EntryLine })[],
  source: string,
): void {
  if (annotations.length === 0) return;

  const known = new Set([...entries.map(({ line }) => line.id), ...existingEntryIds(store)]);
  const missing = annotations.filter(({ line }) => !known.has(line.entry_id));
  if (missing.length === 0) return;

  const shown = missing.slice(0, 3).map(({ line }) => `${line.id} (entry ${line.entry_id})`);
  const rest = missing.length - shown.length;
  const list = rest === 0 ? shown.join(', ') : `${shown.join(', ')}, and ${String(rest)} more`;

  throw refusal(
    `${source} holds ${String(missing.length)} annotation(s) naming an entry that is neither in ` +
      `this stream nor in this project (${list}). \`annotations.entry_id\` is a foreign key to ` +
      `\`entries(id)\` (schema.ts), so restoring one of these would fail on that constraint with no ` +
      `context. Nothing was written.`,
  );
}

/** The key a scheme version is looked up by: its name and its version number. */
function schemeVersionKey(name: string, version: number): string {
  return `${name} ${String(version)}`;
}

/** Every `(scheme, scheme_version)` pair this project already has, across every scheme name. */
function existingSchemeVersionKeys(store: Store): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const summary of listSchemes(store.db)) {
    for (const version of schemeVersions(store.db, summary.name)) {
      keys.add(schemeVersionKey(version.name, version.version));
    }
  }
  return keys;
}

/**
 * Refuse an annotation whose `(scheme, scheme_version)` names neither one of this stream's own
 * scheme lines nor one this project already has.
 *
 * The counterpart of `refuseUnknownAnnotationEntries`, for the other foreign key `annotations`
 * carries. It is deliberately a looser check than `schemeVersionMismatch`: it asks only whether the
 * PAIR is known to exist somewhere, not whether it will still mean the same thing once this
 * stream's schemes are registered -- that precise question is what `schemeVersionMismatch` answers,
 * inside the transaction, once registration has actually run. This one exists so a pair that is
 * simply absent -- a hand-edited file, a corpus concatenated from two unrelated exports -- is named
 * before the transaction opens rather than surfacing as a raw foreign-key failure.
 */
function refuseUnknownAnnotationSchemes(
  store: Store,
  annotations: readonly (ParsedLine & { line: AnnotationLine })[],
  schemes: readonly (ParsedLine & { line: SchemeLine })[],
  source: string,
): void {
  if (annotations.length === 0) return;

  const known = new Set([
    ...schemes.map(({ line }) => schemeVersionKey(line.name, line.version)),
    ...existingSchemeVersionKeys(store),
  ]);
  const missing = annotations.filter(
    ({ line }) => !known.has(schemeVersionKey(line.scheme, line.scheme_version)),
  );
  if (missing.length === 0) return;

  const shown = missing.map(
    ({ line }) => `${line.id} (${line.scheme} version ${String(line.scheme_version)})`,
  );
  const shownList = shown.slice(0, 3);
  const rest = shown.length - shownList.length;
  const list =
    rest === 0 ? shownList.join(', ') : `${shownList.join(', ')}, and ${String(rest)} more`;

  throw refusal(
    `${source} holds ${String(missing.length)} annotation(s) naming a scheme version that is ` +
      `neither in this stream nor in this project (${list}). \`annotations.(scheme, ` +
      `scheme_version)\` is a foreign key to \`annotation_schemes(name, version)\` (schema.ts), so ` +
      `restoring one of these would fail on that constraint with no context. Nothing was written.`,
  );
}

/**
 * One pass of annotations, grouped and ready for one `recordAnnotations` call.
 *
 * `lines` preserves each annotation's position in the stream -- the group does not re-sort them --
 * because nothing about restoring a pass requires a different order than the one it was written
 * in, and `recordAnnotations` does not care what order its `annotations` array arrives in.
 */
interface AnnotationPassGroup {
  readonly scheme: string;
  readonly schemeVersion: number;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly lines: readonly (ParsedLine & { line: AnnotationLine })[];
}

/**
 * Group the stream's annotation lines into passes.
 *
 * `(scheme, scheme_version, created_at)` is the pass identity `RecordedAnnotations` documents, but
 * the grouping key here is all four of `(scheme, scheme_version, created_at, created_by)`. The
 * store's own guarantee is why three would normally be enough: `recordAnnotations` stamps one
 * `created_by` onto every row of a call and refuses a second pass sharing a scheme-version's
 * timestamp, so two genuine passes can never share the first three fields. The fourth is kept
 * anyway as a refusal to trust that guarantee blindly against a file that did not necessarily come
 * from `recordAnnotations` at all -- a hand-edited or concatenated stream could claim the same
 * `created_at` for two different `created_by` values, and grouping by three fields would silently
 * pick one of them for the merged call. Grouping by four instead keeps such a file split into two
 * calls, and the second one meets the store's own "already has a pass at this timestamp" refusal --
 * which is the correct outcome for data that is not a real single pass, not a bug in the grouping.
 *
 * A `Map`, keyed by the composite as one JSON string, because `insertion order of first key` is
 * exactly "the order groups are first seen in the stream", and JS `Map`s preserve that -- so the
 * groups come out in stream order with no separate sort.
 */
interface MutableAnnotationPassGroup {
  scheme: string;
  schemeVersion: number;
  createdAt: string;
  createdBy: string | null;
  lines: (ParsedLine & { line: AnnotationLine })[];
}

function annotationPassGroups(
  annotations: readonly (ParsedLine & { line: AnnotationLine })[],
): readonly AnnotationPassGroup[] {
  const groups = new Map<string, MutableAnnotationPassGroup>();

  for (const parsed of annotations) {
    const { line } = parsed;
    const key = JSON.stringify([
      line.scheme,
      line.scheme_version,
      line.created_at,
      line.created_by,
    ]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        scheme: line.scheme,
        schemeVersion: line.scheme_version,
        createdAt: line.created_at,
        createdBy: line.created_by,
        lines: [parsed],
      });
    } else {
      existing.lines.push(parsed);
    }
  }

  return [...groups.values()];
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
