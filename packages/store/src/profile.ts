/**
 * `profileType` -- the map a reader gets BEFORE any rows.
 *
 * `asc explore`'s default output. The question it answers is "what is in here", not "show me
 * something", because the consumer is a model planning its own drill-down: handed rows it reads
 * row 1 and generalises; handed a map it chooses what to look at. So this returns counts, ranges,
 * cardinalities and per-property state tallies, and never an entry.
 *
 * **The property list comes from the REGISTERED `spec_json`, not from a list typed here.** Each
 * registered version's spec is read back out of `entry_types` and the property set is the union
 * over versions, so a profiler reports on the type the store actually enforced rather than on
 * whatever the calling package believed when it was written. `EV-baseline.md` made the same choice
 * for the same reason, and it is the difference between a census and a memory.
 *
 * **A property's summary is a function of its DECLARED type, not of its values.** Three shapes,
 * chosen so that nothing is reported that would have to be interpreted to be useful:
 *
 *   - `top`         -- `enum`, `boolean`, `string`, `ref`. The value space is categorical, so the
 *                      informative summary is which values occur and how often.
 *   - `range`       -- `integer`, `number`, `duration`, `timestamp`. Every value is likely distinct,
 *                      so a top-K would be a list of singletons. `MIN`/`MAX` is the summary. (For
 *                      `timestamp` this is exact rather than approximate: the values are ISO 8601
 *                      strings, whose lexicographic order is their chronological order -- the same
 *                      property `schema.ts` relies on when it stores them as text.)
 *   - `cardinality` -- `text`, `json`. The value space is unbounded, so neither summary means
 *                      anything: the "top" values of a prose column are near-duplicate prose, and
 *                      its range is two arbitrary strings. Only the distinct count is reported.
 *
 * Which of the three was used is returned as `summary`, so a reader never has to infer "no values
 * reported" from "no values exist" -- the distinction the whole three-state model exists to protect.
 *
 * **Counts, not ratios.** A ratio is a second rendering of a fact already present as a count, and
 * two renderings of one fact can disagree. `count` is returned alongside the per-state counts so
 * the denominator is stated and the ratio is exact for whoever computes it.
 *
 * **Nothing here is a value of a `text` or `json` property.** Top-K values are returned for
 * categorical properties (they are identifiers and labels -- the thing being counted), rendered
 * according to the property's DECLARED type rather than however `json_extract` happened to
 * represent it (`renderDeclaredValue`, `@ascend/core` -- `asc-6wn`: a `boolean`'s `0`/`1` becomes
 * `false`/`true`, every other type is unchanged). The `cardinality` shape returns no values at
 * all. A profile of a prose corpus therefore cannot put prose in a caller's context by accident.
 */

import { canonicalName, renderDeclaredValue, type PropertyType } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { INVALIDATION_LABELS, RESERVED_SCHEME, type InvalidationLabel } from './annotations.js';
import { propertiesOf, valueExpr } from './properties.js';
import { typeVersions } from './registry.js';
import { literal, stateCase } from './sql.js';
import { typeFilterScope } from './type-filter.js';

// Re-exported so every existing importer of `propertiesOf`/`valueExpr` from `./profile.js`
// (`crosstab.ts`, `@ascend/store`'s own index) keeps working unchanged -- see `properties.ts`'s
// own module comment for why the two moved out of this file.
export { propertiesOf, valueExpr } from './properties.js';

/**
 * How many values a `top` summary reports.
 *
 * A constant rather than a flag, and the reason is the coverage rule this product applies
 * everywhere: what matters is not the size of K but that the reader can tell what was cut. So
 * `distinct` is reported next to `top`, and `distinct > top.length` is exactly the statement that
 * values were withheld -- no separate "truncated" flag, because a second field for a fact already
 * computable from the first is a second field that can be wrong.
 */
export const TOP_K = 10;

/** Which summary a property's declared type earns. See the file comment for why. */
export type PropertySummary = 'top' | 'range' | 'cardinality';

/** One value and how many entries hold it. */
export interface PropertyValueCount {
  readonly value: string;
  readonly count: number;
}

/**
 * The three-state model's tally, plus the fourth state a multi-version family produces.
 *
 * All four keys are always present, and a `0` here is a *measured* zero -- the number of rows in
 * that state really is zero. This is the opposite of the rule `TASKS.md` #7 states for an absent
 * value, and it is the right opposite: a count over a result set that was fully read has an exact
 * answer, so omitting it would be withholding a measurement rather than declining to invent one.
 */
export interface StateCounts {
  readonly measured: number;
  readonly not_applicable: number;
  readonly not_measured: number;
  readonly not_declared: number;
}

export interface PropertyProfile {
  readonly name: string;
  /**
   * Every declared type this property has across the versions that declare it, deduplicated and
   * sorted. Usually one. More than one is a definition that changed a property's type between
   * versions, which is legal -- and which `summary` can only describe for the NEWEST declaring
   * version (see `declaringVersions`), so the conflict is stated here rather than resolved
   * invisibly.
   */
  readonly declaredTypes: readonly PropertyType[];
  /** Whether the newest version declaring this property requires a decision for it. */
  readonly required: boolean;
  /**
   * The versions that declare this property, ascending.
   *
   * `summary` and `required` are read from the NEWEST of these, because that is the definition new
   * entries are recorded against. A row whose `not_declared` count is non-zero was recorded by an
   * older version, and the state tally is how a reader sees that.
   */
  readonly declaringVersions: readonly number[];
  readonly summary: PropertySummary;
  readonly states: StateCounts;
  /**
   * Distinct measured values. The number of values the top-K was drawn from, so it is also the
   * statement of what the top-K withheld.
   */
  readonly distinct: number;
  /** Descending by count, then ascending by value so the order is total. Empty unless `top`. */
  readonly top: readonly PropertyValueCount[];
  /** Lowest and highest measured value. `null` unless `range`, or when nothing was measured. */
  readonly min: string | number | null;
  readonly max: string | number | null;
}

/** One registered version of the profiled type, and how many entries carry it. */
export interface VersionProfile {
  readonly version: number;
  readonly major: number;
  readonly typeHash: string;
  readonly status: 'active' | 'deprecated';
  readonly entries: number;
}

/** One invalidation label, and how many entries carry it as their LATEST invalidation. */
export interface InvalidatedLabelCount {
  readonly label: InvalidationLabel;
  readonly count: number;
}

/**
 * How much of a type has stopped counting (`asc-k6p.1`), and why.
 *
 * **Read from `annotations` directly, not from the generated view's `invalidated` column
 * (`asc-88m`).** That column exists in `views.ts` (`invalidatedColumnSql`) but `views.ts` only
 * drops and recreates a type's views inside the REGISTRATION transaction, so a store whose types
 * were registered before `asc-88m` landed has views with no such column at all -- verified
 * 2026-09-22 on the live store: `SELECT invalidated FROM v_tool_denial_v1` fails with `no such
 * column: invalidated`, while the identical query against a type registered after that change
 * succeeds. That staleness is `asc-5ed`'s to fix, not this one's, so this queries `annotations`
 * itself rather than depending on a column that may not exist yet. `count` and `labels` below use
 * EXACTLY the "latest annotation wins" subquery `invalidatedColumnSql` (`sql.ts`) uses for the
 * view -- same table, same scheme, same `ORDER BY created_at DESC, rowid DESC LIMIT 1` -- so the
 * two answer the identical question and cannot drift apart the way a hand-rewritten copy of that
 * subquery could.
 *
 * **Invalidated entries are counted here, and nowhere excluded.** `count`, `top`, `distinct`,
 * `min`/`max` and the per-version tallies above all still include an invalidated entry -- the
 * same decision `views.ts` records for its own column ("NOT a filter... exposes the fact
 * instead"), so this map's other numbers cannot silently disagree with `entries`'s own row count.
 * This is purely an ADDITIONAL fact about the population already counted everywhere else.
 *
 * **`count` is a real measurement, even at zero.** Zero invalidated is "none of these have
 * stopped counting", not "nobody looked" -- `TASKS.md` #7's omit-vs-fabricate rule protects a
 * value that does not exist, and this one always does: every entry either has a latest
 * invalidation label or it does not, over a population that was fully read.
 *
 * **`labels` lists only labels that actually occur.** `INVALIDATION_LABELS` is the closed
 * vocabulary a label may be drawn from, not a taxonomy this type is presumed to have an instance
 * of -- a zero row for every unused label would fabricate a category this type has never seen
 * (`TASKS.md` #7's other half). Ordered by count descending then label ascending, the same
 * determinism rule `topValues` applies for the identical reason: two runs over one store return
 * the labels in the same order even when counts tie.
 *
 * **Over the FILTERED population when `ProfileOptions.filter` is set**, exactly like every other
 * number `profileType` returns (see that function's own comment) -- an invalidated share under a
 * filter describes the filter's own population, not the type's unfiltered total.
 */
export interface InvalidatedSummary {
  /** Entries (of the scope in force) carrying ANY invalidation label. Always present, even at 0. */
  readonly count: number;
  /** Per-label breakdown, occurring labels only. Sums to `count`. */
  readonly labels: readonly InvalidatedLabelCount[];
}

export interface TypeProfile {
  readonly type: string;
  /** Entries of this type that passed the filter (or all of them, when there is none). */
  readonly count: number;
  /**
   * Entries of this type before the filter. Equal to `count` when there is no filter.
   *
   * A filtered `count` alone cannot tell "the filter excluded everything" from "there is nothing
   * here" -- `count: 0` is the same number either way, and the two need different fixes from
   * whoever is reading it: a typo in a predicate, or an empty corpus. `unfiltered` is the fact
   * that tells them apart, the same rule this project already applies to every other proportion
   * it reports (a denominator is stated, not left for the reader to assume) -- see
   * `PageResult.unfiltered` and `GroupResult.unfiltered` (`pages.ts`, `crosstab.ts`), which exist
   * for the identical reason.
   */
  readonly unfiltered: number;
  /**
   * The envelope's own range. Always present for a non-empty type, and it is the ONLY range a
   * hand-recorded corpus has -- which is why it is reported even though it is uninformative for a
   * derived one, where every entry shares one clock reading. Per-property ranges are reported
   * separately, so a derived corpus's event time is not lost to this column's narrowness.
   *
   * Over the FILTERED population, same as everything else on this type (`ProfileOptions.filter`).
   */
  readonly recordedAtMin: string | null;
  readonly recordedAtMax: string | null;
  /** Per-version entry counts, over the filtered population. */
  readonly versions: readonly VersionProfile[];
  /** How much of the (filtered) population has stopped counting, and why. See `InvalidatedSummary`. */
  readonly invalidated: InvalidatedSummary;
  /** Every declared property's summary, over the filtered population. */
  readonly properties: readonly PropertyProfile[];
}

export interface ProfileOptions {
  /** Overrides `TOP_K`. Used by tests to reach the truncation boundary without 11 fixtures. */
  readonly topK?: number;
  /**
   * A SQL predicate over `type`'s rows, with declared properties as bare columns -- see
   * `typeFilterScope` (`type-filter.ts`). Not the same vocabulary `asc annotate --scope` takes:
   * that predicate is corpus-wide, over the raw `entries` table, because it runs before any one
   * type is chosen. The same vocabulary `pageEntries` and `groupEntries` take (`asc-56k`).
   *
   * **EVERY number this function returns is computed against the FILTERED population when this is
   * set -- not only `count` and the state denominators.** `top`, `distinct`, `min`/`max`, the
   * per-version tallies and `recordedAtMin`/`recordedAtMax` all describe the same filtered rows.
   * A profile whose ratios were filtered while its values still described the unfiltered corpus
   * would report true facts about a population the caller never asked about, under a `count` that
   * says otherwise -- worse than refusing the filter outright, which is what this command did
   * before `asc-qfk.1`.
   *
   * The two denominators a property's four state ratios use (`stateDenominator` in `explore.ts`,
   * and `asc-5x7`) are BOTH the filtered ones under a filter: `declared_entries` is the count of
   * FILTERED entries whose recording version declared the property, and `not_declared` is a share
   * of the FILTERED `count` -- not the type's unfiltered total. Both fall out of narrowing every
   * subquery below by the same scope; neither is computed separately.
   */
  readonly filter?: string;
}

const STATES = ['measured', 'not_applicable', 'not_measured', 'not_declared'] as const;

/**
 * The summary a declared type earns. Exhaustive, so a new property type fails to compile.
 *
 * Exported for `crosstab.ts` (`asc-56k`): a group-by key is refused when its declared type earns
 * `range` or `cardinality` rather than `top`, and that refusal has to read this same classifier --
 * a second switch over `PropertyType` here would drift from this one the next time a type is
 * added to the vocabulary, and only one of the two copies would fail to compile.
 */
export function summaryFor(type: PropertyType): PropertySummary {
  switch (type) {
    case 'enum':
    case 'boolean':
    case 'string':
    case 'ref':
      return 'top';
    case 'integer':
    case 'number':
    case 'duration':
    case 'timestamp':
      return 'range';
    case 'text':
    case 'json':
      return 'cardinality';
    default: {
      const unhandled: never = type;
      throw new Error(`unhandled property type: ${String(unhandled)}`);
    }
  }
}

/** `json_type` is NULL exactly when the key is absent -- the same test `stateCase` uses. */
function measuredTest(property: string): string {
  return `json_type(e.properties_json, ${literal(`$.${property}`)}) IS NOT NULL`;
}

/**
 * Every state's count for one property, with the absent states filled in as zero.
 *
 * The `GROUP BY` is on the generated CASE's output alias. SQLite resolves output aliases in
 * `GROUP BY`, and the alternative -- a positional `GROUP BY 1` -- would silently follow the
 * SELECT list if anyone ever reorders it.
 *
 * `scopeClause` narrows to the filtered population when `--filter` was given (`''` otherwise) --
 * see `profileType`'s own comment on why this is BOTH denominators at once. `measured`,
 * `not_applicable` and `not_measured` sum to the FILTERED `declared_entries` because the `WHERE`
 * they are grouped under already excludes anything the filter excluded; `not_declared` is
 * automatically a share of the FILTERED `count` for the identical reason -- all four states are
 * counted over the same narrowed `WHERE`, so there is no second denominator to get wrong.
 */
function stateCounts(
  db: DatabaseSync,
  type: string,
  property: string,
  declaring: readonly number[],
  scopeClause: string,
): StateCounts {
  const rows = db
    .prepare(
      `SELECT ${stateCase(property, declaring)} AS state, COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ?${scopeClause} GROUP BY state`,
    )
    .all(type) as unknown as { state: string; n: number }[];

  const counts: Record<string, number> = {};
  for (const state of STATES) counts[state] = 0;
  for (const row of rows) counts[row.state] = row.n;

  return {
    measured: counts['measured'] ?? 0,
    not_applicable: counts['not_applicable'] ?? 0,
    not_measured: counts['not_measured'] ?? 0,
    not_declared: counts['not_declared'] ?? 0,
  };
}

/** Distinct measured values -- the size of the set the top-K was drawn from. */
function distinctCount(
  db: DatabaseSync,
  type: string,
  property: string,
  scopeClause: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT ${valueExpr(property)}) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ?${scopeClause} AND ${measuredTest(property)}`,
    )
    .get(type) as unknown as { n: number };
  return row.n;
}

/**
 * The K most frequent values.
 *
 * Ordered by count descending and then by value ascending, so the result is deterministic: two
 * runs over the same store return the same list in the same order even where counts tie. A top-K
 * whose order depended on the query plan would make two profiles of one store differ, which is the
 * class of disagreement this product exists to prevent.
 *
 * `LIMIT` is on the grouped result rather than on the entries, so the cost is the grouping and not
 * the corpus -- the rows never leave SQLite.
 *
 * A JSON `null` cannot appear in this list, and that is a fact about the recorder rather than a
 * hope: `propertySchema` (`@ascend/core`) accepts no `null` for any type in the vocabulary, so every
 * value that reaches `properties_json` is non-null, and `json_extract`'s collapse of "absent" and
 * "null" cannot be observed here. Stated because the collapse is real one layer down -- `state.ts`
 * documents it -- and a reader of this function deserves to know why it is not handled.
 *
 * `declared` is the property's own declared type (the NEWEST version's, same as `summaryFor`'s
 * input below), passed to `renderDeclaredValue` (`@ascend/core`) rather than `String`-ing
 * `row.value` verbatim. Without it a `boolean` property's top values are SQLite's `0`/`1` --
 * `json_extract`'s own representation, not the declared type's -- which is the defect `asc-6wn`
 * measured: `asc explore <type> --page` prints `true`/`false` for the same property because it
 * reads `properties_json` directly, so the profile disagreed with itself about a value it was
 * printing in the same command.
 */
function topValues(
  db: DatabaseSync,
  type: string,
  property: string,
  k: number,
  declared: PropertyType,
  scopeClause: string,
): readonly PropertyValueCount[] {
  const rows = db
    .prepare(
      `SELECT ${valueExpr(property)} AS value, COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ?${scopeClause} AND ${measuredTest(property)}\n` +
        ` GROUP BY value ORDER BY n DESC, value ASC LIMIT ?`,
    )
    .all(type, k) as unknown as { value: string | number | null; n: number }[];

  return rows.map((row) => {
    if (row.value === null) {
      // Unreachable per the file comment above: `measuredTest` excludes NULL, and no property
      // type in the vocabulary can store one for a measured value. A null here would be a NEW way
      // for that invariant to break, not a value this function has any business rendering as
      // though it were one -- so it fails loudly rather than silently becoming a rendered `false`.
      throw new Error(`topValues: '${property}' of '${type}' returned a null measured value`);
    }
    return { value: renderDeclaredValue(declared, row.value), count: row.n };
  });
}

/** Lowest and highest measured value, or nulls when nothing was measured. */
function rangeOf(
  db: DatabaseSync,
  type: string,
  property: string,
  scopeClause: string,
): { readonly min: string | number | null; readonly max: string | number | null } {
  const row = db
    .prepare(
      `SELECT MIN(${valueExpr(property)}) AS lo, MAX(${valueExpr(property)}) AS hi\n` +
        `  FROM entries AS e WHERE e.type_name = ?${scopeClause} AND ${measuredTest(property)}`,
    )
    .get(type) as unknown as { lo: string | number | null; hi: string | number | null };

  // `MIN` over an empty set is NULL, and SQLite returns null rather than 0 -- which is what this
  // returns too, so "no measurements" stays distinguishable from "a minimum of zero".
  return { min: row.lo, max: row.hi };
}

/**
 * How much of `type`'s (filtered) population carries a latest invalidation label, broken down by
 * label. See `InvalidatedSummary` for why this reads `annotations` directly rather than a
 * generated view's `invalidated` column, and why an invalidated row is never excluded.
 *
 * One query, not two: grouping the per-entry "latest label" subquery directly gives both the
 * per-label counts and (by summing them) the aggregate, so there is no second query that could
 * count a different set of rows than the one the breakdown was drawn from. `WHERE label IS NOT
 * NULL` drops the entries with no invalidation at all -- the subquery returns NULL for those,
 * exactly as `invalidatedColumnSql` does for the view -- so only entries that DO carry a label
 * reach the `GROUP BY`.
 *
 * `ORDER BY n DESC, label ASC` is `topValues`'s own determinism rule: two runs over one store
 * return the labels in the same order even when two labels tie on count.
 */
function invalidatedCounts(
  db: DatabaseSync,
  type: string,
  scopeClause: string,
): InvalidatedSummary {
  const rows = db
    .prepare(
      `SELECT label, COUNT(*) AS n FROM (\n` +
        `  SELECT (SELECT a.label FROM annotations AS a\n` +
        `            WHERE a.entry_id = e.id AND a.scheme = ${literal(RESERVED_SCHEME)}\n` +
        `            ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS label\n` +
        `    FROM entries AS e WHERE e.type_name = ?${scopeClause}\n` +
        `) WHERE label IS NOT NULL\n` +
        ` GROUP BY label ORDER BY n DESC, label ASC`,
    )
    .all(type) as unknown as { label: string; n: number }[];

  const labels: InvalidatedLabelCount[] = rows.map((row) => {
    // `recordInvalidation` (`annotations.ts`) is the ONLY writer of this scheme and refuses every
    // label outside `INVALIDATION_LABELS` before it ever inserts a row, so a row read back here
    // with a label outside that vocabulary would mean that invariant broke somewhere upstream --
    // worth failing loudly over, not worth silently rendering as though it were expected.
    if (!INVALIDATION_LABELS.includes(row.label as InvalidationLabel)) {
      throw new Error(
        `invalidatedCounts: '${type}' has an invalidation labelled '${row.label}', which is not ` +
          `one of ${INVALIDATION_LABELS.map((label) => `'${label}'`).join(', ')}`,
      );
    }
    return { label: row.label as InvalidationLabel, count: row.n };
  });

  return {
    count: labels.reduce((sum, entry) => sum + entry.count, 0),
    labels,
  };
}

/**
 * Profile one registered type, or `undefined` when the type is not registered.
 *
 * `undefined` rather than an empty profile for an unknown name, because the two are different
 * answers and only the caller can word the difference: a name nobody registered is a mistyped name
 * or the wrong project (the caller can list what exists), while a registered type with no entries
 * is a real and useful profile -- every property present, every count zero. Returning an empty
 * profile for both would make "you are in the wrong project" indistinguishable from "you have
 * recorded nothing", and a caller could not tell which without a second lookup.
 *
 * `type` is canonicalized once, here, before anything else (asc-pw2). `typeVersions` already
 * canonicalizes its own argument, so without this the existence check below and the `entries`
 * queries that follow it would be asking two different questions of a non-canonical spelling:
 * `typeVersions` would find the type and report versions, while every `entries.type_name = ?`
 * query in this function still compared against the caller's raw string, which the store never
 * writes -- a profile that claims a type exists while reporting zero entries and zero for every
 * property, which is a worse answer than a refusal: the caller cannot tell "the profile is empty"
 * from "the whole lookup is asking the wrong question". `type` is used, not `versions[0]?.name`,
 * for the queries below and the returned `TypeProfile.type`, matching `TypeVersionRow.name`
 * (registry.ts): a caller reads back the identity the store actually matched against.
 *
 * **`options.filter` (`asc-qfk.1`) narrows every query below to one id scope, computed ONCE.**
 * `typeFilterScope` (`type-filter.ts`) runs its own query over `entry_types` to build the
 * bare-column projection a predicate compares against, and this function issues one subquery per
 * property (`stateCounts`, `distinctCount`, `topValues`, `rangeOf`) plus two for the envelope
 * (`totals`, `perVersion`) -- so the scope is resolved into a `scopeClause` string here and
 * threaded through all of them, rather than calling `typeFilterScope` again per property and
 * paying its own query N more times over. `PredicateError` (a filter carrying a second statement)
 * propagates out of this call uncaught, the same as it does out of `pageEntries` and
 * `groupEntries` -- the CLI is where all three become a `usageError` naming `--filter`.
 */
export function profileType(
  db: DatabaseSync,
  rawType: string,
  options: ProfileOptions = {},
): TypeProfile | undefined {
  const type = canonicalName(rawType);
  const versions = typeVersions(db, type);
  if (versions.length === 0) return undefined;

  const topK = options.topK ?? TOP_K;

  const scopeClause =
    options.filter === undefined
      ? ''
      : ` AND e.id IN (${typeFilterScope(db, type, options.filter)})`;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(e.recorded_at) AS lo, MAX(e.recorded_at) AS hi\n` +
        `  FROM entries AS e WHERE e.type_name = ?${scopeClause}`,
    )
    .get(type) as unknown as { n: number; lo: string | null; hi: string | null };

  // The population `count` was drawn from, so a caller can tell "the filter excluded everything"
  // apart from "there is nothing here" (see `TypeProfile.unfiltered`). Skipped when there is no
  // filter -- `totals.n` already answers this -- and computed as one plain `COUNT(*)`, not a
  // second run of `scopeClause` or a second `profileType` call: the population before the filter
  // needs no projection at all, only a count of the type's own rows.
  const unfiltered =
    options.filter === undefined
      ? totals.n
      : (
          db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE type_name = ?`).get(type) as {
            n: number;
          }
        ).n;

  const perVersion = new Map(
    (
      db
        .prepare(
          `SELECT e.type_version AS version, COUNT(*) AS n FROM entries AS e\n` +
            ` WHERE e.type_name = ?${scopeClause} GROUP BY version`,
        )
        .all(type) as unknown as { version: number; n: number }[]
    ).map((row) => [row.version, row.n]),
  );

  const properties: PropertyProfile[] = [];
  for (const [name, seen] of propertiesOf(versions)) {
    const newest = versions.find(
      (row) => row.version === seen.declaring[seen.declaring.length - 1],
    );
    if (newest === undefined) {
      // Unreachable: `declaring` is pushed from `versions`, so the version it names came from
      // `versions`.
      throw new Error(`profile: no declaring version for property '${name}' of '${type}'`);
    }

    // The NEWEST version's own type, not `seen.declaredTypes[length - 1]` -- that array is built by
    // first-occurrence dedup (`propertiesOf` above), so its last element is the last type NEWLY SEEN
    // across versions, not the newest version's type. A property retyped and then reverted (string ->
    // integer -> string) leaves `declaredTypes` as `['string', 'integer']`, whose last element is
    // `integer` -- summarising a string property as a numeric range. `required` two lines below
    // already reads from `newest.spec.properties`, which is the correct pattern; this now matches it.
    const declared = newest.spec.properties.find((property) => property.name === name)?.type;
    if (declared === undefined) {
      // Unreachable: `newest` is drawn from `seen.declaring`, which `propertiesOf` only ever pushes
      // for a version whose `spec.properties` contains this property's name.
      throw new Error(`profile: '${type}' v${String(newest.version)} does not declare '${name}'`);
    }

    const summary = summaryFor(declared);
    const required =
      newest.spec.properties.find((property) => property.name === name)?.required === true;

    properties.push({
      name,
      declaredTypes: seen.declaredTypes,
      required,
      declaringVersions: seen.declaring,
      summary,
      states: stateCounts(db, type, name, seen.declaring, scopeClause),
      distinct: distinctCount(db, type, name, scopeClause),
      top: summary === 'top' ? topValues(db, type, name, topK, declared, scopeClause) : [],
      ...(summary === 'range' ? rangeOf(db, type, name, scopeClause) : { min: null, max: null }),
    });
  }

  return {
    type,
    count: totals.n,
    unfiltered,
    recordedAtMin: totals.lo,
    recordedAtMax: totals.hi,
    versions: versions.map((row) => ({
      version: row.version,
      major: row.major,
      typeHash: row.typeHash,
      status: row.status,
      entries: perVersion.get(row.version) ?? 0,
    })),
    invalidated: invalidatedCounts(db, type, scopeClause),
    properties,
  };
}
