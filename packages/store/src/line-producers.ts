/**
 * The producing half of a write: the lines a write WOULD produce, without producing it.
 *
 * E12.4b1. `writeLines` (`jsonl-index.ts`) takes lines and puts them in the tree; something has to
 * hand it those lines. Everything before E12.4b obtained them by writing first and reading back
 * (`corpusLines`), which cannot work here: the write path's whole ordering rule is that the tree is
 * appended BEFORE the index is touched, so the lines have to exist first.
 *
 * **Each production is its writer, run and undone** -- `withRollback`, the preview idiom
 * `registerType`'s `dryRun` and `asc import --dry-run` already use. That is a deliberate choice over
 * the two alternatives, and it is the one that makes divergence impossible rather than unlikely:
 *
 *   - **Not a second implementation of the validation.** A producer that re-derived an entry's
 *     `type_hash`, its canonical property order and its `na` set would be a second answer to "what
 *     does this record look like", and the two would drift exactly where the tests are thinnest. The
 *     producer here runs the real writer, so the line it returns is built by the same call that
 *     would have written the row.
 *   - **Not a no-INSERT half split out of each writer.** That is the smaller change in principle and
 *     the larger one in practice: `recorder.ts`, `registry.ts` and `annotations.ts` are the three
 *     most heavily guarded modules in the package, and threading a "compute but do not write" mode
 *     through each of them puts a branch on the path every real write takes. The producers here are
 *     additive: a write that does not want a line cannot be affected by them.
 *
 * The cost is one extra statement per write, rolled back. Measured against what the plan refused --
 * a wholesale rebuild on write, 3.39 s (EV-34) -- it is not the same kind of cost at all.
 *
 * **A producer is usable ONLY against a CURRENT index, and this paragraph used to say the
 * opposite.** It read: *"A producer is usable against a STALE index, and that is the point. ... So
 * the probe writes to whatever index is there and rolls it back, and `writeLines` decides separately
 * whether that index is current enough to maintain."* That argument is about whether the INDEX can be
 * maintained, and it never asks whether the LINE is true. Measured (`EV-35`, 2026-09-29, n=1, scheme
 * productions): an index holding `screening` v1 beside a tree holding v1 and v2 produced a
 * well-formed scheme line claiming **version 2** with a spec the tree's version 2 does not carry --
 * a duplicate version number in a `merge=union` file, where nothing ever collapses it. It does not
 * fail, and the line is not one the store would reject. So the fused write path
 * (`writeProducedLines`, `jsonl-index.ts`) refuses a stale index instead of appending beside one, and
 * makes the index current before it takes its lock. The two decisions are not independent after all:
 * the probe's input is the thing the write path is deciding about.
 *
 * Only `schemeLines` was measured there. `entryLines` against a stale index is expected to refuse
 * (`UnknownTypeError`, or a version the tree has since grown past) rather than to mint a duplicate --
 * a different failure, and **unmeasured**.
 *
 * **A sequence is ONE rollback, and `produceLines` is the only way to produce at all.** The first
 * version of this module exported five functions that each opened their own `withRollback`, and it
 * was green -- 14 tests, all passing -- while being unusable for the only thing it exists for. A
 * sequence does not see itself when each production rolls back before the next, and every measured
 * failure is that one mistake wearing a different hat (2026-09-29, a throwaway probe, all three
 * failing):
 *
 * ```
 * asc annotate    SchemeError: annotation scheme 'screening' has no version 1. Its versions: (none).
 * asc import      expected [ 1, 1 ] to deeply equal [ 1, 2 ]
 * asc invalidate  expected [ 2, 2 ] to deeply equal [ 2, 1 ]
 * ```
 *
 * `annotate` registers a scheme and the pass that belongs to it, so the pass could not see the
 * scheme it had just been given; `import` replays a corpus where each version depends on the one
 * before it, so every type came out version 1; and a batch of invalidations re-registered the
 * reserved scheme per claim, appending the same scheme line twice -- a duplicate in a `merge=union`
 * file, which never collapses.
 *
 * A single-call equivalence test cannot see any of that, which is why the fix is not a test but a
 * shape. `withRollback`'s own doc gives the rule -- *"a preview of registering three documents would
 * have each one rolled back before the next, so the second would compute its version as though the
 * first had never happened"* -- and this module is the caller that sentence was written about. So the
 * transaction belongs to `produceLines` and not to each production, the single-production functions
 * are private, and the body is handed an object whose methods are the only way to produce
 * anything at all. The mistake is not documented away; it is unspellable.
 *
 * **`result` is returned beside the lines rather than discarded.** The writers do more than write:
 * `recordEntry` returns validation warnings, `registerType` reports whether a version was created,
 * `recordInvalidation` reports whether an identical claim already existed. A producer that returned
 * lines alone would force its caller to re-derive that, which is how a CLI loses the one warning it
 * was supposed to print.
 *
 * **A write that wrote nothing produces no lines.** Three of the six writers are idempotent by
 * design -- `registerType` and `registerScheme` answer `'unchanged'` for a shape the store already
 * holds, and `recordInvalidation` answers `created: false` for a claim already on record -- and each
 * of those answers means the export ALREADY carries the line. Emitting it again would append a
 * duplicate to the tree on every re-run, which is the one thing a `merge=union` file must not
 * accumulate. So the lines are empty in those cases, and the caller learns why from `result` rather
 * than from a line count. `deprecateType` is the fourth of the kind by a different vocabulary: it
 * answers `0` for a family it has already retired, and `deprecationLines` reads that as the same
 * "nothing to say".
 *
 * **`unchanged` is not the same question as "wrote nothing", and `typeLines` is where the two come
 * apart.** Prose is not part of a type's identity -- that is deliberate, and it is why `registerType`
 * compares specs -- but prose DOES live in the version's line, so `asc types define` with only the
 * description changed is a real write that `registerType` reports as `unchanged`. Asked no further,
 * `typeLines` would emit nothing and the tree, being the store, would rebuild the version without the
 * edit: silent data loss. `pendingProseUpdate` (`registry.ts`) is that second question, it answers
 * `undefined` for the ordinary re-run, and `TypeProduction.proseUpdated` reports the distinction its
 * own `outcome` cannot. `replayType` asks it too, on the way back in, for the same reason.
 *
 * **A retirement is the second write with no version of its own, and `deprecate` is why it survives
 * a rebuild.** `deprecateType` changes rows that already exist and mints nothing, so before this
 * producer existed the one fact with no line to carry it was erased by every rebuild. Measured
 * 2026-09-29 on a real store: `asc types deprecate review_completed` set the status, `asc index
 * build` read the tree, and the type came back `active`. The mechanism is the one prose established
 * -- a REPEAT of a `(name, version)` the tree already holds, read back in document order with
 * `'deprecated'` applied where it appears -- and it is the same `deprecateType` call `replayType`
 * makes on the way back in, so the line and the rebuild cannot disagree about what it means.
 */

import { canonicalName, type TypeSpec } from '@ascend/core';
import {
  annotationRows,
  registerNamedScheme,
  recordAnnotations,
  recordInvalidation,
  RESERVED_SCHEME,
  schemeVersions,
  type AnnotationContext,
  type AnnotationPass,
  type RecordedAnnotations,
  type RecordedInvalidation,
  type RecordInvalidationInput,
  type RegisteredScheme,
  type SchemeContext,
  type SchemeSpec,
} from './annotations.js';
import { withRollback } from './db.js';
import type { CorpusLine } from './jsonl.js';
import { annotationLine, entryLine, schemeLine, typeLine } from './jsonl.js';
import {
  recordEntry,
  type RecordContext,
  type RecordRequest,
  type RecordResult,
} from './recorder.js';
import {
  deprecateType,
  findType,
  pendingProseUpdate,
  registerType,
  typeVersions,
  updateTypeProse,
  type RegisteredType,
  type RegisterTypeOptions,
} from './registry.js';
import type { SqlDatabase } from './sql-port.js';

/** The lines a write would produce, and what the write itself reported. */
export interface ProducedLines<Result> {
  readonly lines: readonly CorpusLine[];
  readonly result: Result;
}

/**
 * The only way to produce a line: one method per writer, each returning what that writer returned.
 *
 * Handed to `produceLines`' body and constructed nowhere else. The results keep the shape their
 * writers give them, so a batch can still read a warning or an `unchanged` off the call it came from
 * while the lines accumulate beside it.
 */
export interface Producers {
  entry(request: RecordRequest, context: RecordContext): RecordResult;
  type(spec: TypeSpec, options: RegisterTypeOptions): TypeProduction;
  scheme(name: string, spec: SchemeSpec, context: SchemeContext): RegisteredScheme;
  annotation(pass: AnnotationPass, context: AnnotationContext): RecordedAnnotations;
  invalidation(input: RecordInvalidationInput): RecordedInvalidation;
  /** Retire a type. A sixth writer, and a sixth production -- see `deprecationLines`. */
  deprecate(name: string): TypeDeprecation;
}

/**
 * What retiring a type did, in the terms the caller decides with.
 *
 * `changed` is `deprecateType`'s own answer -- the rows its statement matched, which is ZERO both
 * when every version was already retired and when there is no such type at all. Those are opposite
 * answers to a caller (`asc types deprecate` refuses the second and reports the first as success
 * with nothing to do), which is why the command reads the status itself before producing rather than
 * reading a count here.
 */
export interface TypeDeprecation {
  /** The name the store matched, canonicalized -- the same spelling `typeVersions` answers to. */
  readonly name: string;
  /** Rows the statement changed. Zero means nothing was retired. */
  readonly changed: number;
}

/**
 * Run a sequence of productions under ONE rollback, and return the lines they produced, in order.
 *
 * `body` is handed the only way to produce. Each method runs its writer for real and keeps the line
 * the writer would have written; the whole sequence is discarded when `body` returns, whether it
 * returned a value or threw, because `withRollback` rolls back either way.
 *
 * `result` is `body`'s own return value, so a caller collects the warnings and the
 * `unchanged`/`created: false` answers by returning them. That is the half a lines-only producer
 * would drop, and it is why this returns a pair rather than an array.
 *
 * The lines come out in the order the body produced them, across kinds, which is the order
 * `writeLines` appends them in. Within a kind that order is load-bearing -- `import` replays a corpus
 * where each version depends on the one before it -- and across kinds it is simply the body's.
 */
export function produceLines<Result>(
  db: SqlDatabase,
  body: (produce: Producers) => Result,
): ProducedLines<Result> {
  const lines: CorpusLine[] = [];

  const collect = <R>(produced: ProducedLines<R>): R => {
    for (const line of produced.lines) lines.push(line);
    return produced.result;
  };

  const result = withRollback(db, () =>
    body({
      entry: (request, context) => collect(entryLines(db, request, context)),
      type: (spec, options) => collect(typeLines(db, spec, options)),
      scheme: (name, spec, context) => collect(schemeLines(db, name, spec, context)),
      annotation: (pass, context) => collect(annotationLines(db, pass, context)),
      invalidation: (input) => collect(invalidationLines(db, input)),
      deprecate: (name) => collect(deprecationLines(db, name)),
    }),
  );

  return { lines, result };
}

/**
 * The line `recordEntry` would append for this request, and its warnings, with nothing written.
 *
 * The `entries` row is what the enclosing rollback discards; the line is what is kept. Both come out
 * of the same `recordEntry` call, so a field the writer fills in and a reader does not expect -- or
 * the reverse -- is a difference `corpusLines` has no way to express, because the line was built by
 * `entryLine`, which is exactly what `corpusLines` uses to build one.
 *
 * Takes no transaction of its own, and neither does anything below it: `produceLines` owns the one
 * the whole sequence runs in.
 */
function entryLines(
  db: SqlDatabase,
  request: RecordRequest,
  context: RecordContext,
): ProducedLines<RecordResult> {
  const result = recordEntry(db, request, context);
  return { lines: [entryLine(result.entry)], result };
}

/**
 * What `registerType` did, plus the half its own `outcome` cannot report.
 *
 * `outcome` answers *is this shape already registered*, which is the right question for minting a
 * version and the wrong one for a write: prose is not part of a type's identity, so a prose-only
 * edit registers as `unchanged` while changing the version's line. A caller that reported
 * `unchanged` there would be telling the truth about the shape and a lie about the write -- and the
 * CLI's `asc types define` reports exactly this distinction as `prose-updated`, so the answer has to
 * come from the call that knows rather than be re-derived by re-reading the row.
 */
export interface TypeProduction extends RegisteredType {
  /** This registration also replaced the version's prose. `outcome` cannot say so. */
  readonly proseUpdated: boolean;
}

/**
 * The line `registerType` would append for this definition, with nothing registered.
 *
 * The row is read back rather than assembled from `RegisteredType`. `typeLine` takes the row the
 * registry stores -- the canonical spec, the derived hash, the version it counted to -- and a
 * document built here would be a second spelling of that row, which is the drift this module's
 * header exists to prevent. The read is one statement against a table the transaction has already
 * touched, and the rollback takes the row with it.
 *
 * **A prose-only edit is still a write, and `outcome` alone would call it `unchanged`.** Prose is
 * not part of a type's identity -- that is deliberate, and it is why the registry compares specs --
 * but prose DOES live in the version's line, so an edit that produced no line would be an edit the
 * tree, being the source of truth, does not have. `pendingProseUpdate` is the second question, and
 * `undefined` from it is the ordinary re-run: emitting a line for a no-op edit would append a
 * duplicate to a `merge=union` file on every run, where nothing ever collapses it.
 */
function typeLines(
  db: SqlDatabase,
  spec: TypeSpec,
  options: RegisterTypeOptions,
): ProducedLines<TypeProduction> {
  const registered = registerType(db, spec, options);

  const pending =
    registered.outcome === 'unchanged'
      ? pendingProseUpdate(db, registered.name, registered.version, options)
      : undefined;
  if (pending !== undefined) updateTypeProse(db, registered.name, registered.version, pending);

  return {
    lines:
      registered.outcome === 'created' || pending !== undefined
        ? typeVersions(db, registered.name)
            .filter((row) => row.version === registered.version)
            .map(typeLine)
        : [],
    result: { ...registered, proseUpdated: pending !== undefined },
  };
}

/**
 * The line `deprecateType` would append for this name, with nothing retired.
 *
 * **One line for the whole family, and it is the LATEST version's row.** `deprecateType`'s statement
 * is `WHERE name = ?` -- retiring a type retires every version of it, which is what the command
 * reports as `versions` -- and `deprecateType` is also what `replayType` calls on the way back in,
 * so one line carries the whole change and the rebuild applies it the same way. A line per version
 * would be N repeats of rows the tree already holds, in a `merge=union` file where nothing ever
 * collapses a duplicate.
 *
 * The row is read AFTER the statement rather than before: the line's whole content is the retirement,
 * and a `typeLine` built from the pre-retirement row would say `active` while retiring the type. That
 * is the same ordering rule `typeLines` follows for prose, and for the same reason.
 *
 * Nothing changed means no line, like every other production here. It is reachable from a caller
 * that did not ask first (a replayed corpus holding two retirement lines for one type), and the
 * answer is `changed: 0` rather than a second identical line.
 */
function deprecationLines(db: SqlDatabase, name: string): ProducedLines<TypeDeprecation> {
  const canonical = canonicalName(name);
  const changed = deprecateType(db, canonical);

  // Only worth a read when something moved. `changed: 0` is "no such type" or "already retired", and
  // neither has a row to describe.
  const latest = changed > 0 ? findType(db, canonical) : undefined;

  return {
    // `changed > 0` with no row is not a state the store can reach -- the statement just matched one
    // -- so the guard is here to keep the type honest rather than to handle a case.
    lines: latest === undefined ? [] : [typeLine(latest)],
    result: { name: canonical, changed },
  };
}

/**
 * The line `registerScheme` would append for this scheme, with nothing registered.
 *
 * Unlike `typeLines` this one needs no read: `RegisteredScheme` already carries the normalized spec,
 * the version and the timestamp that `schemeLine` takes, so the line is built from the writer's own
 * return value. That it is the SAME spec `schemeVersions` reads back is not assumed -- it is what
 * this producer's equivalence test measures, since a spec normalized differently on the way in than
 * on the way out would mint a tree whose scheme hash disagrees with the export's.
 */
function schemeLines(
  db: SqlDatabase,
  name: string,
  spec: SchemeSpec,
  context: SchemeContext,
): ProducedLines<RegisteredScheme> {
  // `registerNamedScheme`, not `registerScheme`: a corpus carries the store's own `invalidation`
  // line, and the reserved name is refused by `registerScheme` on purpose (dogfood/0027). See that
  // function for why the choice lives there and not here.
  const result = registerNamedScheme(db, name, spec, context);

  return { lines: result.outcome === 'unchanged' ? [] : [schemeLine(result)], result };
}

/**
 * The lines `recordAnnotations` would append for this pass, with nothing recorded.
 *
 * The rows are read back because `RecordedAnnotations` answers with a COUNT. `annotationLine` takes
 * a row, and every field of that row -- the trimmed note, the `value`/null distinction, the shared
 * pass stamp -- is the writer's decision rather than the caller's input, so re-deriving rows from
 * `pass.annotations` would be the second implementation this module refuses.
 *
 * **Sorted by id, which is `corpusLines`' own tiebreak within a pass** (`created_at`, then id) and
 * not the `(created_at, entry_id)` that `annotationRows` returns. A pass has one label per entry, so
 * the two orders hold the same rows and differ only in sequence -- but the tree is bytes, and "the
 * tree holds exactly what the export would have written" is a claim about bytes.
 */
function annotationLines(
  db: SqlDatabase,
  pass: AnnotationPass,
  context: AnnotationContext,
): ProducedLines<RecordedAnnotations> {
  const result = recordAnnotations(db, pass, context);
  const rows = annotationRows(db, {
    scheme: result.scheme,
    version: result.schemeVersion,
    pass: result.createdAt,
  });

  return {
    lines: [...rows]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => annotationLine(row, result.scheme, result.schemeVersion)),
    result,
  };
}

/**
 * The lines `recordInvalidation` would append for this claim, with nothing recorded.
 *
 * **Two lines are possible, and the reason is that the reserved scheme is registered by the same
 * call.** The first invalidation a store ever takes writes the `invalidation` scheme version too,
 * and `asc export` emits a scheme line for it (`listSchemes` sees it). A producer that emitted only
 * the annotation would mint a tree where the reserved scheme exists solely as the `scheme` field of
 * its own lines, and `import` cannot rebuild it from that: `restoreInvalidationScheme` is reached
 * through a scheme LINE.
 *
 * So the scheme line is the one this write ADDED -- the versions before the call are counted and
 * dropped -- rather than "the reserved scheme exists". After the first invalidation the answer is
 * always empty, and within a batch it is empty from the second claim onward, because the enclosing
 * rollback lets each production see what the one before it did. That is the measured difference
 * `expected [ 2, 2 ] to deeply equal [ 2, 1 ]` above was about.
 */
function invalidationLines(
  db: SqlDatabase,
  input: RecordInvalidationInput,
): ProducedLines<RecordedInvalidation> {
  const before = schemeVersions(db, RESERVED_SCHEME).length;
  const result = recordInvalidation(db, input);
  const added = schemeVersions(db, RESERVED_SCHEME).slice(before);

  // `created: false` means an identical CLAIM is already on record -- the id is derived from the
  // claim and not from the clock -- so the export already carries this row and a second line would
  // be a duplicate. The read is by id rather than by pass timestamp because invalidations have no
  // pass: a batch sharing one timestamp is several independent claims, not one event.
  const rows = result.created
    ? annotationRows(db, {
        scheme: result.scheme,
        version: result.schemeVersion,
        pass: input.createdAt,
      }).filter((row) => row.id === result.id)
    : [];

  return {
    lines: [
      ...added.map(schemeLine),
      ...rows.map((row) => annotationLine(row, result.scheme, result.schemeVersion)),
    ],
    result,
  };
}
