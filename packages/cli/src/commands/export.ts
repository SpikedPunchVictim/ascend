/**
 * `asc export` -- the whole corpus as a JSONL stream, definitions before what depends on them.
 *
 * `asc-brt`, and the counterpart of `asc import`. The store is per-project and gitignored, so this
 * is the only thing that carries a corpus out of a working copy: the file this writes is what
 * survives a deleted checkout. As of `asc-6u5`, that includes annotation schemes and the
 * annotations recorded under them -- a hand label, a kappa pass, a rule's whole classification --
 * not only the entries a trigger already protects.
 *
 * **Types first, every version, oldest-first**, for the reason `types export` states: registration
 * mints the next version number, so replaying v1 then v2 reproduces the versions the exporting
 * project holds. Schemes are the same argument applied to `registerScheme`, which mints its own
 * version numbers the identical way. Then every entry, in `(recorded_at, id)` order, then every
 * annotation, in `(scheme, scheme_version, created_at, id)` order. The full order -- `type`,
 * `entry`, `scheme`, `annotation` -- is a foreign-key contract, not a preference: see `corpus.ts`.
 *
 * **The default output is the stream, and `--json` is the versioned envelope.** The same split
 * `types export` makes, for the same reason: the round trip is this command's purpose, so
 * `asc export | asc import -` has to work with no flag, and a caller who asks for `--json` gets
 * the envelope every other command gives rather than a synonym for the bare form (asc-qmn).
 *
 * **The entries are read through `findEntry`, not by a second SELECT.** `findEntry` re-validates
 * every row against the definition it names, so a row that no longer satisfies its own spec is a
 * loud failure on the way out instead of a corpus that restores into a store whose views cannot
 * render it. That is the argument `pages.ts` makes for hydrating ids rather than selecting rows,
 * and it costs an export the ability to rescue such a row -- which is stated here rather than
 * discovered, because "the escape hatch refused to run" is a surprising thing to meet.
 *
 * `--csv` is refused and no longer advertised, exactly as `asc types export` refuses it: a corpus
 * is a heterogeneous stream of four shapes and a CSV cell holding one is a cell a reader has to
 * parse back anyway. `asc-3u2` item (d) is why the flag is hidden as well as refused.
 */

import { Flags } from '@oclif/core';
import {
  annotationRows,
  entryIds,
  findEntry,
  listSchemes,
  listTypes,
  schemeVersions,
  typeVersions,
  type AnnotationRow,
  type RecordedEntry,
  type SchemeSummary,
  type Store,
} from '@ascend/store';
import { BaseCommand, OUTPUT_FLAGS } from '../base.js';
import {
  annotationLine,
  entryLine,
  orderedLine,
  schemeLine,
  serializeCorpus,
  typeLine,
  type AnnotationLine,
  type CorpusLine,
} from '../corpus.js';
import { refusal, usageError } from '../errors.js';

export default class ExportCorpus extends BaseCommand {
  static override description =
    'Write every type definition, entry, annotation scheme, and annotation as a JSONL stream.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> > corpus.jsonl',
    '<%= config.bin %> <%= command.id %> | <%= config.bin %> import -',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  /**
   * The same override, and the same reasoning, as `asc types export` -- see that file. `csv-raw`
   * is hidden alongside `csv` for the same reason: it only qualifies a format this command
   * refuses, so advertising it in `--help` would offer a flag that cannot be honoured here.
   */
  static override baseFlags = {
    ...OUTPUT_FLAGS,
    csv: Flags.boolean({ description: 'Print RFC 4180 CSV.', hidden: true }),
    'csv-raw': Flags.boolean({ ...OUTPUT_FLAGS['csv-raw'], hidden: true }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ExportCorpus);
    const format = this.resolveFormat(flags);

    if (format === 'csv') {
      throw usageError(
        '`asc export --csv` is not a format: a corpus line is a type definition, an entry, an ' +
          'annotation scheme, or an annotation, and the four have different fields, so no one ' +
          'header row describes them. The export is JSONL; use `asc query --csv` if what you want ' +
          'is one type as columns.',
      );
    }

    await this.withProject(({ store }) => {
      const lines = corpusLines(store);

      if (format === 'json') {
        // `row_count` is what distinguishes a corpus with no entries from a truncated answer, in
        // the spelling a script reads -- the same argument `types export` makes for its envelope.
        //
        // `columns` is required by `Output` and unused: the default output is this format, not a
        // grid, and the names are here so a reader is not misled into thinking one exists.
        this.emit(format, {
          columns: ['kind', 'id', 'type_name', 'type_version', 'recorded_at'],
          rows: lines.map(orderedLine),
        });
        return;
      }

      // `emitText`, not `this.log`: `log('')` writes a newline, so an empty corpus -- which
      // `serializeCorpus` deliberately renders as zero bytes -- came out as one blank line, and
      // every non-empty corpus came out with a stray trailing one. Measured against the real
      // binary: `asc export` on a store with nothing in it printed `'\n'`, and `wc -l` on a
      // 42-line export said 43. `emitText` is the door the rest of the commands already use and
      // its comment states this exact rule.
      this.emitText(serializeCorpus(lines));
    });
  }
}

/**
 * Every type version, then every entry, then every scheme version, then every annotation.
 *
 * The order is the contract: `import` registers definitions in the order it reads them, so a
 * stream whose types (or schemes) were sorted differently would mint different version numbers --
 * and `annotations` carries foreign keys to both `entries` and `annotation_schemes` (`schema.ts`),
 * so it has to reach `import` after both. Types and schemes each go in name order -- so two
 * exports of one registry differ only where the registry does, which is what makes a diff of them
 * mean something -- with each name's versions oldest-first. Entries go in `(recorded_at, id)`, the
 * same order `pages.ts` pages in, and annotations go in `(scheme, scheme_version, created_at, id)`
 * -- see `annotationLines` for why the timestamp alone is not enough.
 */
function corpusLines(store: Store): readonly CorpusLine[] {
  const types = listTypes(store.db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => typeVersions(store.db, name))
    .map(typeLine);

  const schemes = listSchemes(store.db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => schemeVersions(store.db, name));

  return [
    ...types,
    ...entries(store).map(entryLine),
    ...schemes.map(schemeLine),
    ...annotationLines(store, schemes),
  ];
}

/**
 * Every entry of every type, hydrated and validated.
 *
 * An id that `entryIds` listed and `findEntry` cannot produce would be a store that disagrees with
 * itself, so it is a refusal naming the id rather than a skipped row: a corpus that is quietly one
 * entry short is the failure this command exists to prevent.
 */
function entries(store: Store): readonly RecordedEntry[] {
  const found: RecordedEntry[] = [];

  for (const summary of listTypes(store.db)) {
    for (const id of entryIds(store.db, summary.name)) {
      const entry = findEntry(store.db, id);
      if (entry === undefined) {
        throw refusal(
          `the store lists an entry with id ${id} under '${summary.name}' and then cannot read ` +
            `it back, so the export would be missing a row. Nothing was written. This is a ` +
            `problem with the store rather than with your input.`,
        );
      }
      found.push(entry);
    }
  }

  // Sorted here rather than by the query, because the rows come from one query per type and the
  // order that matters spans all of them.
  return found.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id),
  );
}

/**
 * Every annotation of every scheme version, in `(scheme, scheme_version, created_at, id)` order.
 *
 * `annotationRows` already orders one scheme-version's rows by `(created_at, entry_id)` -- the
 * order a rater's label list reads well in -- but that is not enough to make a *stream*
 * byte-stable, because two annotations of one pass can share a `created_at` (the pass IS its
 * timestamp; see `annotations.ts`) with nothing but `entry_id` breaking the tie, and this stream's
 * own determinism promise is keyed on `id`, not on which entry happened to be labelled. So the
 * rows are read scheme-version by scheme-version and then re-sorted here, by the id `orderedLine`
 * asserts stability over -- the same reason `export.ts`'s own `entries` function sorts across
 * queries rather than trusting any one of them.
 */
function annotationLines(
  store: Store,
  schemes: readonly SchemeSummary[],
): readonly AnnotationLine[] {
  const rows: { readonly scheme: string; readonly version: number; readonly row: AnnotationRow }[] =
    [];

  for (const summary of schemes) {
    for (const row of annotationRows(store.db, {
      scheme: summary.name,
      version: summary.version,
    })) {
      rows.push({ scheme: summary.name, version: summary.version, row });
    }
  }

  rows.sort(
    (left, right) =>
      left.scheme.localeCompare(right.scheme) ||
      left.version - right.version ||
      left.row.createdAt.localeCompare(right.row.createdAt) ||
      left.row.id.localeCompare(right.row.id),
  );

  return rows.map(({ scheme, version, row }) => annotationLine(row, scheme, version));
}
