/**
 * `groupEntries` -- a contingency table over one or two declared properties
 * (`asc explore --group-by`, `asc-56k`).
 *
 * `profileType` answers "what is in here" one property at a time: a `top` property's own
 * value counts, independent of every other property. That is not enough to answer "does
 * `outcome=rejected` cluster with `reviewer=amy`", which needs the JOINT distribution of two
 * properties, not their two marginals side by side. This is that second question.
 *
 * **Which properties can be grouped is not a second decision.** A property earns a crosstab cell
 * exactly when `profileType`'s own `summaryFor` would report it as `top` (enum, boolean, string,
 * ref) -- the reason a `range` property's crosstab would have as many rows as entries, and a
 * `cardinality` property's would be near-duplicate prose, is the identical reason `profileType`
 * reports no top-K for either. `summaryFor` is imported from `profile.ts` rather than
 * re-classified here so the two cannot drift into refusing different properties.
 *
 * **Every entry lands in exactly one cell.** A `top` property with no measured value for an
 * entry is not dropped from the table -- it groups under its own state, with `value: null`, so
 * `cells` always sums to `covered` and `covered` is exactly `total` unless a `topK` cap withheld
 * something (see `GroupResult.covered`).
 *
 * **The state a cell groups under is `sql.ts`'s FOUR-state `EntryState`, the same one
 * `profileType` reports, not core's three-state `PropertyState` -- `not_declared` stays a
 * distinct bucket from `not_measured` rather than folding into it.** From inside one entry the
 * two look like the same fact ("no decision was ever recorded"), but a group key is read across a
 * POPULATION, and across a population they name two different populations: `not_measured` is a
 * row the question was askable of and nobody answered; `not_declared` is a row the question was
 * not askable of at all, because its own `type_version` never declared the property. Folding them
 * loses exactly the distinction `asc-5x7` was named for: a property declared only in v2, with 500
 * v1 entries and 10 v2 entries, folded to one `not_measured: 500` bucket reads as "nobody measures
 * this", when the true statement is "490-odd of those entries could not have been measured, and
 * the other 10 were". A single-key result is also where a Wilson interval lands on this count
 * (the CLI's `--group-by`) -- an interval computed over two conflated populations is a plausible
 * number with an error bar on it, which is worse than a plausible number with no bar at all. And
 * within one command, `profileType` already reports four states for this property; a `--group-by`
 * that reported three would be `asc explore` disagreeing with itself about what a value is, the
 * exact defect `asc-6wn` closed for booleans.
 *

 * **`topK` is a cap per AXIS, not per cell**, and it is chosen from each axis's MARGINAL counts
 * -- how often a value occurs across the whole filtered population -- not from how often it
 * occurs paired with one particular value of the other axis. A value common overall but spread
 * thin against a second axis must survive being locally rare in any one cell; picking by cell
 * counts would drop it instead, and a caller reading "what is common" would get "what happened to
 * co-occur with whatever else made the cut" without any way to tell the two apart.
 *
 * This file also exports `entryStates` (`asc explore --select`), which answers a related but
 * different question: not "how does a population split", but "what is the four-state answer for
 * THIS property on THIS entry". It lives here rather than in `recorder.ts` because the answer it
 * gives is not a fact `RecordedEntry` can carry on its own -- see `entryStates`'s own comment.
 */

import { canonicalName, renderDeclaredValue, type PropertyType } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { propertiesOf, summaryFor, TOP_K, valueExpr, type PropertySummary } from './profile.js';
import { UnknownTypeError, type RecordedEntry } from './recorder.js';
import { registeredNames, typeVersions, type TypeVersionRow } from './registry.js';
import { stateCase, type EntryState } from './sql.js';
import { typeFilterScope } from './type-filter.js';

/** One group key's value for one cell. */
export interface GroupKeyValue {
  /** The measured value, rendered by its DECLARED type. `null` whenever `state` is not 'measured'. */
  readonly value: string | null;
  /**
   * `sql.ts`'s four-state `EntryState`, not core's three-state `PropertyState` -- see this file's
   * own comment on why `not_declared` is kept apart from `not_measured` rather than collapsed.
   */
  readonly state: EntryState;
}

/** One cell: the key values in the order the caller named the keys, and how many entries carry them. */
export interface GroupCount {
  readonly values: readonly GroupKeyValue[];
  readonly count: number;
}

export interface GroupRequest {
  readonly type: string;
  /** One or two declared property names, in the order the caller named them. */
  readonly keys: readonly string[];
  /**
   * A SQL predicate over `type`'s rows, with declared properties as bare columns -- see
   * `typeFilterScope` (`type-filter.ts`). Not the same vocabulary `asc annotate --scope` takes:
   * that predicate is corpus-wide, over the raw `entries` table, because it runs before any one
   * type is chosen.
   */
  readonly filter?: string;
  /** Distinct values kept per key before the remainder is withheld. Defaults to `TOP_K`. */
  readonly topK?: number;
}

export interface GroupAxis {
  readonly key: string;
  /** How many distinct (value, state) pairs existed for this key inside the filtered population. */
  readonly distinct: number;
  /** How many of them `cells` covers. */
  readonly kept: number;
}

export interface GroupResult {
  /** Descending by count, then ascending by rendered value, so the order is total and reproducible. */
  readonly cells: readonly GroupCount[];
  /** Entries of this type the filter admitted. The denominator for every proportion downstream. */
  readonly total: number;
  /** Entries accounted for by `cells`. Less than `total` exactly when a key's distinct values exceeded `topK`. */
  readonly covered: number;
  /**
   * Entries of this type before the filter. Equal to `total` when there is no filter.
   *
   * A filtered `total` alone cannot tell "the filter excluded everything" from "there is nothing
   * here" -- `total: 0` is the same number either way, and the two need different fixes from
   * whoever is reading it: a typo in a predicate, or an empty corpus. `unfiltered` is the fact
   * that tells them apart, the same rule this project already applies to every other proportion
   * it reports (a denominator is stated, not left for the reader to assume).
   */
  readonly unfiltered: number;
  /** One per key, in `keys` order. */
  readonly axes: readonly GroupAxis[];
}

/** Thrown when `keys` does not name exactly one or two properties. */
export class GroupKeyCountError extends Error {
  constructor(readonly count: number) {
    super(
      `groupEntries takes one or two keys, got ${String(count)}. Name one property for a ` +
        `single-property tally, or two for a contingency table.`,
    );
    this.name = 'GroupKeyCountError';
  }
}

/** Thrown when `topK` is not a positive integer -- a table that keeps nothing is not a request. */
export class GroupTopKError extends Error {
  constructor(readonly requested: number) {
    super(`groupEntries: topK must be a positive integer, got ${String(requested)}.`);
    this.name = 'GroupTopKError';
  }
}

/** Thrown when a group key names a property no registered version of the type declares. */
export class UnknownGroupKeyError extends Error {
  constructor(
    readonly typeName: string,
    readonly property: string,
    readonly declared: readonly string[],
  ) {
    super(
      `'${property}' is not a property of '${typeName}'. Declared properties: ` +
        `${declared.join(', ') || '(none)'}.`,
    );
    this.name = 'UnknownGroupKeyError';
  }
}

/**
 * Thrown when a group key names a property whose declared type earns a `range` or `cardinality`
 * summary (`profileType`'s `summaryFor`), not `top`.
 *
 * `declaredType` and `summary` are carried on the error, not just folded into the message, for
 * the same reason `ValidationIssue` carries a `fix` rather than only a rendered string: a caller
 * printing this can say what WOULD have worked without re-deriving it.
 */
export class UngroupablePropertyError extends Error {
  constructor(
    readonly typeName: string,
    readonly property: string,
    readonly declaredType: PropertyType,
    readonly summary: PropertySummary,
  ) {
    super(
      `'${property}' of '${typeName}' is declared '${declaredType}', which earns a '${summary}' ` +
        `summary, not 'top' -- so it cannot be a crosstab key. Group by an enum, boolean, string ` +
        `or ref property instead: those are the ones whose value space is categorical.`,
    );
    this.name = 'UngroupablePropertyError';
  }
}

/** A group key, resolved against the type's registered versions. */
interface ResolvedKey {
  /** The canonical declared name -- what the store holds, not necessarily what the caller typed. */
  readonly name: string;
  /** The newest declaring version's type, matching what `summaryFor` was tested against. */
  readonly declaredType: PropertyType;
  /** Ascending versions that declare this property, same shape as `PropertyProfile.declaringVersions`. */
  readonly declaring: readonly number[];
}

/**
 * Resolve one caller-named key against the type's property union, or refuse it.
 *
 * `rawName` is canonicalized here (asc-pw2), the same treatment `type` gets in `profileType` and
 * `pageEntries`: a caller naming a key under the spelling a type was authored with --
 * `reviewKind` rather than `review_kind` -- matches the declared property exactly as it matches
 * the type. The thrown errors still name `rawName`, not the canonical spelling, for the same
 * reason `findRegisteredType`'s do (`recorder.ts`): a typo that matches nothing should be echoed
 * back as typed, not silently refolded into a near-miss the caller never wrote.
 */
function resolveKey(
  type: string,
  properties: ReadonlyMap<string, { declaring: number[]; declaredTypes: PropertyType[] }>,
  versions: readonly TypeVersionRow[],
  rawName: string,
): ResolvedKey {
  const name = canonicalName(rawName);
  const seen = properties.get(name);
  if (seen === undefined) {
    throw new UnknownGroupKeyError(type, rawName, [...properties.keys()].sort());
  }

  // The NEWEST declaring version's own type -- the same choice `profileType` makes and the same
  // reason: `declaredTypes` is built by first-occurrence dedup, so its last element is the last
  // type NEWLY SEEN across versions, not the newest version's type, and a property retyped and
  // then reverted (string -> integer -> string) would summarise as the middle type instead of the
  // current one.
  const newestVersion = seen.declaring[seen.declaring.length - 1];
  const newest = versions.find((row) => row.version === newestVersion);
  if (newest === undefined) {
    // Unreachable: `declaring` is drawn from `versions` by `propertiesOf`, so every version it
    // names came from `versions`.
    throw new Error(`groupEntries: no declaring version for '${name}' of '${type}'`);
  }

  const declared = newest.spec.properties.find((property) => property.name === name)?.type;
  if (declared === undefined) {
    // Unreachable: `newest` is drawn from `seen.declaring`, which `propertiesOf` only ever pushes
    // for a version whose `spec.properties` contains this property's name.
    throw new Error(
      `groupEntries: '${type}' v${String(newest.version)} does not declare '${name}'`,
    );
  }

  const summary = summaryFor(declared);
  if (summary !== 'top') {
    throw new UngroupablePropertyError(type, name, declared, summary);
  }

  return { name, declaredType: declared, declaring: seen.declaring };
}

/** The identity a (value, state) pair is filtered by, when checking axis `topK` membership. */
function groupKeyId(v: GroupKeyValue): string {
  return v.value === null ? `s:${v.state}` : `v:${v.value}`;
}

/**
 * Render a measured raw value, refusing rather than guessing if the state/value pairing breaks
 * its own invariant.
 *
 * Unreachable in the same sense `profile.ts`'s `topValues` documents for the identical check:
 * `stateCase` assigns `measured` exactly when `json_type(properties_json, '$.<key>') IS NOT
 * NULL`, so a row in that state cannot carry a null raw value. Guarded rather than asserted past,
 * because a null here would be a NEW way for that invariant to break, not a value this function
 * has any business rendering as though it were one.
 */
function measuredValue(key: ResolvedKey, raw: string | number | null, type: string): string {
  if (raw === null) {
    throw new Error(`groupEntries: '${key.name}' of '${type}' returned a null measured value`);
  }
  return renderDeclaredValue(key.declaredType, raw);
}

/**
 * Where one (value, state) bucket sorts among ties on count.
 *
 * A `null` value (every non-measured state) sorts AFTER every rendered value: `￿` is above
 * any character `renderDeclaredValue` produces for the vocabulary's types, so the two
 * non-measured buckets a key can have sort last, ordered between themselves by state name. The
 * contract states only "ascending by rendered value", which has nothing to say about a bucket
 * with no value at all; this is the one total order consistent with that rule rather than the
 * rule itself.
 */
function orderMarker(v: GroupKeyValue): string {
  return v.value ?? `￿${v.state}`;
}

/** Descending by count, then ascending by the joined per-key order markers. */
function byCountThenValues(
  a: { readonly values: readonly GroupKeyValue[]; readonly count: number },
  b: { readonly values: readonly GroupKeyValue[]; readonly count: number },
): number {
  if (a.count !== b.count) return b.count - a.count;
  const am = a.values.map(orderMarker).join('\u0000');
  const bm = b.values.map(orderMarker).join('\u0000');
  return am < bm ? -1 : am > bm ? 1 : 0;
}

interface AxisTally extends GroupKeyValue {
  readonly count: number;
}

function byCountThenValue(a: AxisTally, b: AxisTally): number {
  if (a.count !== b.count) return b.count - a.count;
  const am = orderMarker(a);
  const bm = orderMarker(b);
  return am < bm ? -1 : am > bm ? 1 : 0;
}

interface AxisMarginal {
  /** Descending by count, then ascending by value -- see `byCountThenValue`. */
  readonly rows: readonly AxisTally[];
  /** Distinct (value, state) pairs this key took, across all four `EntryState`s. */
  readonly distinct: number;
}

/**
 * Every distinct (value, state) pair `key` takes across the filtered population, with its own
 * count -- the MARGINAL this file's own comment explains `topK` selection is drawn from.
 *
 * `GROUP BY raw, state` already produces at most one SQL row per (value, state) pair -- `state`
 * is `stateCase`'s own four-way `EntryState`, kept apart rather than collapsed (this file's top
 * comment), so there is nothing left to merge here: a `not_measured` row and a `not_declared` row
 * are two distinct groups, not two spellings of one.
 */
function axisMarginal(
  db: DatabaseSync,
  type: string,
  scope: string,
  key: ResolvedKey,
): AxisMarginal {
  const rows = db
    .prepare(
      `SELECT ${valueExpr(key.name)} AS raw, ${stateCase(key.name, key.declaring)} AS state, COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ? AND e.id IN (${scope})\n` +
        ` GROUP BY raw, state`,
    )
    .all(type) as unknown as { raw: string | number | null; state: EntryState; n: number }[];

  const tallies = rows
    .map((row): AxisTally => ({
      value: row.state === 'measured' ? measuredValue(key, row.raw, type) : null,
      state: row.state,
      count: row.n,
    }))
    .sort(byCountThenValue);

  return { rows: tallies, distinct: tallies.length };
}

interface JointRow {
  readonly v1: string | number | null;
  readonly s1: EntryState;
  readonly v2: string | number | null;
  readonly s2: EntryState;
  readonly n: number;
}

/** The joint (value, state) x (value, state) counts for two keys, over the filtered population. */
function jointCounts(
  db: DatabaseSync,
  type: string,
  scope: string,
  key1: ResolvedKey,
  key2: ResolvedKey,
): readonly JointRow[] {
  return db
    .prepare(
      `SELECT ${valueExpr(key1.name)} AS v1, ${stateCase(key1.name, key1.declaring)} AS s1,\n` +
        `       ${valueExpr(key2.name)} AS v2, ${stateCase(key2.name, key2.declaring)} AS s2,\n` +
        `       COUNT(*) AS n\n` +
        `  FROM entries AS e WHERE e.type_name = ? AND e.id IN (${scope})\n` +
        ` GROUP BY v1, s1, v2, s2`,
    )
    .all(type) as unknown as JointRow[];
}

/** Exactly two `GroupKeyValue`s, so indexing a cell's `values` needs no `undefined` guard. */
type Pair = readonly [GroupKeyValue, GroupKeyValue];

interface JointCell {
  readonly values: Pair;
  readonly count: number;
}

/**
 * The joint rows, as cells. `GROUP BY v1, s1, v2, s2` (in `jointCounts`) already produces at most
 * one SQL row per joint (value, state) x (value, state) pair, with `not_declared` kept apart from
 * `not_measured` on each axis independently (this file's top comment), so -- as in
 * `axisMarginal` -- there is no merge left to do; this only renders each row's raw values.
 */
function jointCells(
  rows: readonly JointRow[],
  key1: ResolvedKey,
  key2: ResolvedKey,
  type: string,
): readonly JointCell[] {
  return rows.map((row): JointCell => {
    const value1 = row.s1 === 'measured' ? measuredValue(key1, row.v1, type) : null;
    const value2 = row.s2 === 'measured' ? measuredValue(key2, row.v2, type) : null;
    return {
      values: [
        { value: value1, state: row.s1 },
        { value: value2, state: row.s2 },
      ],
      count: row.n,
    };
  });
}

/**
 * A contingency table over one or two declared properties of `type`. See the file comment.
 *
 * Throws `UnknownTypeError` (the same one `recordEntry` throws) for a type nobody registered --
 * unlike `profileType`, which returns `undefined` for that case, this always returns a
 * `GroupResult`, so there is no falsy value left to report "not registered" with. `filter` goes
 * through `typeFilterScope` (`type-filter.ts`), so a bare declared-property name in the predicate
 * resolves against a column instead of failing with `no such column`, and a predicate carrying a
 * second statement is still refused (`PredicateError`) rather than silently truncated by
 * `db.prepare`.
 */
export function groupEntries(db: DatabaseSync, request: GroupRequest): GroupResult {
  if (request.keys.length !== 1 && request.keys.length !== 2) {
    throw new GroupKeyCountError(request.keys.length);
  }

  const topK = request.topK ?? TOP_K;
  if (!Number.isInteger(topK) || topK < 1) {
    throw new GroupTopKError(topK);
  }

  const type = canonicalName(request.type);
  const versions = typeVersions(db, type);
  if (versions.length === 0) {
    throw new UnknownTypeError(request.type, undefined, registeredNames(db).types);
  }

  const properties = propertiesOf(versions);
  const keys = request.keys.map((name) => resolveKey(type, properties, versions, name));

  // Through `typeFilterScope`, not `wrapPredicate` over the raw table (asc-56k): `entries`
  // projects every property inside `properties_json`, so a bare `flag = true` -- the same
  // vocabulary `keys` already accepts for a group-by name -- would fail with `no such column`
  // against the raw table. `typeFilterScope` filters over a projection of THIS type's rows with
  // declared properties as bare columns instead, and still refuses (`PredicateError`) a fragment
  // that smuggles in a second statement. See that file's own comment for why `annotate --scope`
  // does not get the same treatment.
  const scope =
    request.filter === undefined
      ? 'SELECT id FROM entries'
      : typeFilterScope(db, type, request.filter);

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM entries WHERE type_name = ? AND id IN (${scope})`)
      .get(type) as { n: number }
  ).n;

  // The population the filter drew `total` from, so a caller can tell "the filter excluded
  // everything" apart from "there is nothing here" -- see `GroupResult.unfiltered`. Skipped when
  // there is no filter (`total` already answers this), and never re-run through `scope` or
  // `profileType`: this is one plain `COUNT(*)`, not the filtered query again and not a whole map
  // built to answer a single number (`profileType` measured 7.4 ms against `findType`'s 26 us).
  const unfiltered =
    request.filter === undefined
      ? total
      : (
          db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE type_name = ?`).get(type) as {
            n: number;
          }
        ).n;

  const computed = keys.map((key) => {
    const marginal = axisMarginal(db, type, scope, key);
    // `marginal.rows` is already ordered descending by count then ascending by value (the same
    // order `GroupResult.cells` promises), so the first `topK` of it IS the kept set in the order
    // a single-key result reports it in -- no second sort needed for that case.
    const kept = marginal.rows.slice(0, topK);
    return {
      key,
      kept,
      keptSet: new Set(kept.map((tally) => groupKeyId(tally))),
      axis: { key: key.name, distinct: marginal.distinct, kept: kept.length },
    };
  });

  const axes: GroupAxis[] = computed.map((entry) => entry.axis);

  const [first, second] = computed;
  if (first === undefined) {
    // Unreachable: `request.keys.length` is 1 or 2 (checked above), so `computed` has at least
    // one entry.
    throw new Error('groupEntries: no keys resolved');
  }

  let cells: readonly GroupCount[];
  let covered: number;

  if (second === undefined) {
    covered = first.kept.reduce((sum, tally) => sum + tally.count, 0);
    cells = first.kept.map((tally): GroupCount => ({
      values: [{ value: tally.value, state: tally.state }],
      count: tally.count,
    }));
  } else {
    const joint = jointCells(
      jointCounts(db, type, scope, first.key, second.key),
      first.key,
      second.key,
      type,
    );
    // The per-axis `topK` cap applies here, independently per key (this file's own comment):
    // a cell survives only when BOTH of its values were kept by their own axis's marginal count,
    // never by how often the pair itself occurred.
    const kept = joint.filter(
      (cell) =>
        first.keptSet.has(groupKeyId(cell.values[0])) &&
        second.keptSet.has(groupKeyId(cell.values[1])),
    );
    covered = kept.reduce((sum, cell) => sum + cell.count, 0);
    // `jointCells` does not sort (it is a 1:1 map over the SQL rows), and filtering removes some
    // of those rows, so the final order is computed fresh here rather than assumed carried over.
    cells = [...kept].sort(byCountThenValues);
  }

  return { cells, total, covered, unfiltered, axes };
}

/**
 * A group key resolved for `entryStates`: only the pieces the composition below needs, so a
 * ranged or cardinality property (which `entryStates` has no reason to refuse -- `--select`
 * renders a state for ANY declared property, not only the categorical ones `groupEntries` can
 * key a table on) is not forced through `resolveKey`'s `summaryFor` check.
 */
interface StateKey {
  readonly name: string;
  readonly declaring: ReadonlySet<number>;
}

/**
 * Resolve one requested property name against the type's property union, or refuse it.
 *
 * Canonicalized the same way `resolveKey` canonicalizes a group key (asc-pw2), and for the
 * same reason the thrown error echoes `rawName` rather than the canonical spelling: a typo that
 * matches nothing should come back as the caller typed it.
 */
function resolveStateKey(
  type: string,
  properties: ReadonlyMap<string, { declaring: number[]; declaredTypes: PropertyType[] }>,
  rawName: string,
): StateKey {
  const name = canonicalName(rawName);
  const seen = properties.get(name);
  if (seen === undefined) {
    throw new UnknownGroupKeyError(type, rawName, [...properties.keys()].sort());
  }
  return { name, declaring: new Set(seen.declaring) };
}

/**
 * The four-state answer for each named property of each entry, parallel to `entries`.
 *
 * Every requested property has a key in every record. A missing key is never the answer.
 *
 * This exists because `RecordedEntry.states` cannot answer the question `asc explore --select`
 * asks. `states` is core's, and core's `PropertyState` is three-state BY DESIGN: `state.ts`'s own
 * resolution loop assigns a state to every property `spec.properties` names -- "every DECLARED
 * property gets a state" -- and a property the entry's own version does not declare is simply
 * never visited, so it gets no key at all, not a fourth value. That is correct for `states`: an
 * entry validated against ONE definition has nothing to say about a property that definition
 * never mentioned. `not_declared` is not a property of an entry in isolation -- it is a relation
 * between a row and a definition it is NOT the row's own, and `sql.ts`'s own comment on
 * `EntryState` says exactly this: the state "exists exactly where a version list is available".
 * A version list is exactly what a lone `RecordedEntry` does not carry and a store, holding every
 * registered version, does. This function is where the two facts meet -- `RecordedEntry.states`
 * for the three states it can answer, and the type's declaring-version sets (`propertiesOf`, the
 * same ones `groupEntries` resolves its keys against) for the one it cannot -- so that `--select`
 * calls one function instead of re-deriving "missing key means not declared" at the CLI layer,
 * which is the same collapse this file's top comment already refused once, one layer up.
 *
 * One query: `typeVersions` (via `propertiesOf`), regardless of how many entries or properties
 * are named. Everything after that is a pure fold over `entries`, so a page of 50 entries costs
 * the one round trip the caller already paid to look the type up, not one query per entry.
 */
export function entryStates(
  db: DatabaseSync,
  type: string,
  entries: readonly RecordedEntry[],
  properties: readonly string[],
): readonly Readonly<Record<string, EntryState>>[] {
  const canonicalType = canonicalName(type);
  const versions = typeVersions(db, canonicalType);
  if (versions.length === 0) {
    throw new UnknownTypeError(type, undefined, registeredNames(db).types);
  }

  const declared = propertiesOf(versions);
  const keys = properties.map((rawName) => resolveStateKey(canonicalType, declared, rawName));

  return entries.map((entry) => {
    const states: Record<string, EntryState> = Object.create(null) as Record<string, EntryState>;
    for (const key of keys) {
      const own = entry.states[key.name];
      if (own !== undefined) {
        states[key.name] = own;
        continue;
      }

      // The key is absent from `entry.states`. That is `not_declared` ONLY when the entry's own
      // `typeVersion` is genuinely outside the property's declaring set -- otherwise `findEntry`
      // built a `states` map that does not satisfy its own contract (every property its version
      // declares gets a state), which is an integrity failure this function is not going to paper
      // over by guessing a fourth state for it.
      if (key.declaring.has(entry.typeVersion)) {
        throw new Error(
          `entryStates: entry '${entry.id}' (${canonicalType} v${String(entry.typeVersion)}) ` +
            `declares '${key.name}' but its own 'states' has no key for it. findEntry's ` +
            `invariant -- every property the entry's version declares gets a state -- is broken.`,
        );
      }
      states[key.name] = 'not_declared';
    }
    return states;
  });
}
