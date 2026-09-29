/**
 * A store, as the corpus lines that carry it: every type version, entry, scheme version and
 * annotation, in the one order the format's foreign keys allow.
 *
 * This is the WRITE half of the pair `jsonl.ts` and `jsonl-files.ts` form with the read layer. Those
 * two own what a line means and where a line lives; this one owns which lines a store IS, which is
 * the question `asc export` asks and which the JSONL cutover (`asc-i5tj.4`) asks again when it turns
 * a SQLite store into a tree.
 *
 * **It lives here rather than in the CLI because a second caller arrived.** `asc export` was the
 * only one, so the composition lived next to it as a private function. The migration needs the same
 * bytes for the same reason -- "the tree must hold exactly what the export would have written" is
 * the migration's whole correctness claim -- and two spellings of it would let a store migrate into
 * a tree its own export does not reproduce, with both paths reporting success. So the composition
 * moved to the package that already owns every part of it: `typeLine`, `schemeLine`, `entryLine` and
 * `annotationLine` are all `jsonl.ts`'s, and every accessor it calls is this package's already.
 *
 * **A store is asked for its lines, not for its rows.** `entries` reads through `findEntry` and
 * refuses an id it cannot read back, rather than selecting rows directly: a row that no longer
 * satisfies the definition it names would otherwise leave a corpus that restores into a store whose
 * own views cannot render it. The cost is that a store holding such a row cannot be carried out at
 * all -- stated rather than discovered, because "the escape hatch refused to run" is a surprising
 * thing to meet.
 */

import {
  annotationRows,
  listSchemes,
  schemeVersions,
  type AnnotationRow,
  type SchemeSummary,
} from './annotations.js';
import { annotationLine, entryLine, schemeLine, typeLine } from './jsonl.js';
import type { AnnotationLine, CorpusLine } from './jsonl.js';
import { entryIds } from './pages.js';
import { findEntry, type RecordedEntry } from './recorder.js';
import { listTypes, typeVersions } from './registry.js';
import type { SqlDatabase } from './sql-port.js';

/**
 * Every type version, then every entry, then every scheme version, then every annotation.
 *
 * The order is the contract: `import` registers definitions in the order it reads them, so a stream
 * whose types (or schemes) were sorted differently would mint different version numbers -- and
 * `annotations` carries foreign keys to both `entries` and `annotation_schemes` (`schema.ts`), so it
 * has to reach `import` after both. Types and schemes each go in name order -- so two exports of one
 * registry differ only where the registry does, which is what makes a diff of them mean something --
 * with each name's versions oldest-first. Entries go in `(recorded_at, id)`, the same order
 * `pages.ts` pages in, and annotations go in `(scheme, scheme_version, created_at, id)` -- see
 * `annotationLines` for why the timestamp alone is not enough.
 */
export function corpusLines(db: SqlDatabase): readonly CorpusLine[] {
  const types = listTypes(db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => typeVersions(db, name))
    .map(typeLine);

  const schemes = listSchemes(db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => schemeVersions(db, name));

  return [
    ...types,
    ...entries(db).map(entryLine),
    ...schemes.map(schemeLine),
    ...annotationLines(db, schemes),
  ];
}

/**
 * Every entry of every type, hydrated and validated.
 *
 * An id that `entryIds` listed and `findEntry` cannot produce would be a store that disagrees with
 * itself, so it is a refusal naming the id rather than a skipped row: a corpus that is quietly one
 * entry short is the failure this function exists to prevent.
 *
 * A plain `Error`, not the CLI's `refusal` -- which is exactly `new Error(message)`, as `corpus.ts`
 * records when it moved the same kind of refusal out of that package. The message is byte-identical
 * to the one `asc export` has always thrown.
 */
function entries(db: SqlDatabase): readonly RecordedEntry[] {
  const found: RecordedEntry[] = [];

  for (const summary of listTypes(db)) {
    for (const id of entryIds(db, summary.name)) {
      const entry = findEntry(db, id);
      if (entry === undefined) {
        throw new Error(
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
 * order a rater's label list reads well in -- but that is not enough to make a *stream* byte-stable,
 * because two annotations of one pass can share a `created_at` (the pass IS its timestamp; see
 * `annotations.ts`) with nothing but `entry_id` breaking the tie, and this stream's own determinism
 * promise is keyed on `id`, not on which entry happened to be labelled. So the rows are read
 * scheme-version by scheme-version and then re-sorted here, by the id `orderedLine` asserts
 * stability over -- the same reason `entries` above sorts across queries rather than trusting any
 * one of them.
 */
function annotationLines(
  db: SqlDatabase,
  schemes: readonly SchemeSummary[],
): readonly AnnotationLine[] {
  const rows: { readonly scheme: string; readonly version: number; readonly row: AnnotationRow }[] =
    [];

  for (const summary of schemes) {
    for (const row of annotationRows(db, { scheme: summary.name, version: summary.version })) {
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
