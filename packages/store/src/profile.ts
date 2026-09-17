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
 * **Nothing here is a value of a `text` or `json` property.** Top-K values are returned verbatim
 * for categorical properties (they are identifiers and labels -- the thing being counted), and the
 * `cardinality` shape returns no values at all. A profile of a prose corpus therefore cannot put
 * prose in a caller's context by accident.
 */

import type { PropertyType } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { typeVersions, type TypeVersionRow } from './registry.js';
import { literal, stateCase } from './sql.js';

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

export interface TypeProfile {
  readonly type: string;
  /** Entries of this type, across every version. */
  readonly count: number;
  /**
   * The envelope's own range. Always present for a non-empty type, and it is the ONLY range a
   * hand-recorded corpus has -- which is why it is reported even though it is uninformative for a
   * derived one, where every entry shares one clock reading. Per-property ranges are reported
   * separately, so a derived corpus's event time is not lost to this column's narrowness.
   */
  readonly recordedAtMin: string | null;
  readonly recordedAtMax: string | null;
  readonly versions: readonly VersionProfile[];
  readonly properties: readonly PropertyProfile[];
}

export interface ProfileOptions {
  /** Overrides `TOP_K`. Used by tests to reach the truncation boundary without 11 fixtures. */
  readonly topK?: number;
}

const STATES = ['measured', 'not_applicable', 'not_measured', 'not_declared'] as const;

/** The summary a declared type earns. Exhaustive, so a new property type fails to compile. */
function summaryFor(type: PropertyType): PropertySummary {
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

function valueExpr(property: string): string {
  return `json_extract(e.properties_json, ${literal(`$.${property}`)})`;
}

/**
 * Every state's count for one property, with the absent states filled in as zero.
 *
 * The `GROUP BY` is on the generated CASE's output alias. SQLite resolves output aliases in
 * `GROUP BY`, and the alternative -- a positional `GROUP BY 1` -- would silently follow the
 * SELECT list if anyone ever reorders it.
 */
function stateCounts(
  db: DatabaseSync,
  type: string,
  property: string,
  declaring: readonly number[],
): StateCounts {
  const rows = db
    .prepare(
      `SELECT ${stateCase(property, declaring)} AS state, COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ? GROUP BY state`,
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
function distinctCount(db: DatabaseSync, type: string, property: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT ${valueExpr(property)}) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ? AND ${measuredTest(property)}`,
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
 */
function topValues(
  db: DatabaseSync,
  type: string,
  property: string,
  k: number,
): readonly PropertyValueCount[] {
  const rows = db
    .prepare(
      `SELECT ${valueExpr(property)} AS value, COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ? AND ${measuredTest(property)}\n` +
        ` GROUP BY value ORDER BY n DESC, value ASC LIMIT ?`,
    )
    .all(type, k) as unknown as { value: string | number | null; n: number }[];

  return rows.map((row) => ({ value: String(row.value), count: row.n }));
}

/** Lowest and highest measured value, or nulls when nothing was measured. */
function rangeOf(
  db: DatabaseSync,
  type: string,
  property: string,
): { readonly min: string | number | null; readonly max: string | number | null } {
  const row = db
    .prepare(
      `SELECT MIN(${valueExpr(property)}) AS lo, MAX(${valueExpr(property)}) AS hi\n` +
        `  FROM entries AS e WHERE e.type_name = ? AND ${measuredTest(property)}`,
    )
    .get(type) as unknown as { lo: string | number | null; hi: string | number | null };

  // `MIN` over an empty set is NULL, and SQLite returns null rather than 0 -- which is what this
  // returns too, so "no measurements" stays distinguishable from "a minimum of zero".
  return { min: row.lo, max: row.hi };
}

/** The property set of one type, unioned over the versions that declare each property. */
function propertiesOf(
  versions: readonly TypeVersionRow[],
): ReadonlyMap<string, { declaring: number[]; declaredTypes: PropertyType[] }> {
  const properties = new Map<string, { declaring: number[]; declaredTypes: PropertyType[] }>();

  // Ascending by version, so the LAST write for each property is the definition the newest
  // declaring version states -- which is what `required` and the summary are read from.
  for (const { version, spec } of versions) {
    for (const property of spec.properties) {
      const seen = properties.get(property.name);
      if (seen === undefined) {
        properties.set(property.name, { declaring: [version], declaredTypes: [property.type] });
        continue;
      }
      seen.declaring.push(version);
      if (!seen.declaredTypes.includes(property.type)) seen.declaredTypes.push(property.type);
    }
  }

  return properties;
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
 */
export function profileType(
  db: DatabaseSync,
  type: string,
  options: ProfileOptions = {},
): TypeProfile | undefined {
  const versions = typeVersions(db, type);
  if (versions.length === 0) return undefined;

  const topK = options.topK ?? TOP_K;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(recorded_at) AS lo, MAX(recorded_at) AS hi\n` +
        `  FROM entries WHERE type_name = ?`,
    )
    .get(type) as unknown as { n: number; lo: string | null; hi: string | null };

  const perVersion = new Map(
    (
      db
        .prepare(
          `SELECT type_version AS version, COUNT(*) AS n FROM entries\n` +
            ` WHERE type_name = ? GROUP BY type_version`,
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
      states: stateCounts(db, type, name, seen.declaring),
      distinct: distinctCount(db, type, name),
      top: summary === 'top' ? topValues(db, type, name, topK) : [],
      ...(summary === 'range' ? rangeOf(db, type, name) : { min: null, max: null }),
    });
  }

  return {
    type,
    count: totals.n,
    recordedAtMin: totals.lo,
    recordedAtMax: totals.hi,
    versions: versions.map((row) => ({
      version: row.version,
      major: row.major,
      typeHash: row.typeHash,
      status: row.status,
      entries: perVersion.get(row.version) ?? 0,
    })),
    properties,
  };
}
