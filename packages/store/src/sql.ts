/**
 * SQL generation shared by the generated views and the cross-project union.
 *
 * This module exists because those two places must agree EXACTLY about what a property's state is.
 * If they drifted -- a view saying `not_measured` where the union said `not_applicable` -- the same
 * row would report two different states depending on how it was queried, and both answers would look
 * plausible. That is the failure class this product exists to prevent, so the CASE is generated in
 * one place rather than written twice.
 *
 * `invalidatedColumnSql` exists for the identical reason (`asc-88m`): a view saying an entry was
 * invalidated where the union said it was not would be the same failure wearing a different column.
 * The two callers differ only in where `annotations` lives -- `main` for a per-project view,
 * an ATTACHed schema for the union -- which is exactly the one parameter that function takes.
 *
 * Internal to the package: `views.ts` and `union.ts` use it, `index.ts` does not export it.
 */

import { ENVELOPE_PROPERTY_NAMES, INVALIDATED_COLUMN_NAME } from '@ascend/core';
import { RESERVED_SCHEME } from './annotations.js';

/**
 * The four states a projected property can be in -- `@ascend/core`'s three, plus the one only a
 * version-aware query can produce.
 *
 * The type lives here rather than in `@ascend/core` because `not_declared` is not a fact about an
 * entry: it is a relation between a row and the definition it was recorded under, and it exists
 * exactly where a version list is available. Core's `PropertyState` is therefore genuinely smaller
 * and not a subset that wants widening -- an entry on its own is never `not_declared`. This is the
 * type of the string the CASE below PRODUCES, and it is written once, here, for the reason the whole
 * module exists: a second copy of a four-way decision is a second answer.
 */
export type EntryState = 'measured' | 'not_applicable' | 'not_measured' | 'not_declared';

/** Quote an identifier for generated SQL. Doubling an embedded quote is the SQLite escape. */
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A literal for generated SQL. Property names come from an LLM and are interpolated into DDL. */
export const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The columns every generated projection carries, before the per-property ones.
 *
 * Taken from `@ascend/core` rather than written out here, because this list IS the set of
 * names a view claims for itself -- which is what `reservedPropertyName` refuses as property
 * names (asc-865.1). Two copies of it could disagree, and the disagreement would be a
 * property name that core believed was free and a view believed was taken. One list, and a
 * test that derives the same set back out of a real view's declared columns.
 */
export const ENVELOPE_COLUMNS: readonly string[] = ENVELOPE_PROPERTY_NAMES;

/**
 * The name of the invalidation column every generated view carries, beside the entries
 * envelope. Re-exported from `@ascend/core`'s `INVALIDATED_COLUMN_NAME` rather than repeated as
 * a literal, for the reason `ENVELOPE_COLUMNS` is: one spelling, so the column this file
 * projects and the name `reservedPropertyName` refuses cannot drift apart.
 */
export const INVALIDATED_COLUMN: string = INVALIDATED_COLUMN_NAME;

/**
 * The `invalidated` column every generated view carries (`asc-88m`): the LABEL of the entry's
 * LATEST invalidation annotation, or NULL when it has never been invalidated. Invalidated rows
 * are NOT filtered out of the view -- that would make the view's row count silently disagree
 * with `entries`' with nothing on screen explaining the gap -- so this exposes the fact instead,
 * and a caller who wants live rows only writes `WHERE invalidated IS NULL`.
 *
 * `ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1` is "latest", and the `a.rowid DESC` tiebreak
 * is required, not decorative: `annotations.ts`'s own module comment states a whole pass shares
 * one `created_at` ("THE PASS IS THE TIMESTAMP"), so two invalidations of the same entry in one
 * pass tie on the clock. The tiebreak is `rowid`, not `id`, and that is deliberate: `id` is a
 * SHA-256 of the invalidation's own content (`recordInvalidation`, `annotations.ts`), so ordering
 * by it second would be a HASH ordering, not a chronological one -- deterministic, but no more
 * "latest" than picking whichever label comes first alphabetically. `annotations` is an ordinary
 * ROWID table (no `WITHOUT ROWID` in `schema.ts`, and `id` is a `TEXT PRIMARY KEY`, not an
 * `INTEGER PRIMARY KEY`, so it is not a rowid alias either), and SQLite assigns a new row the
 * next rowid in insertion order absent an explicit one -- which every writer here leaves to
 * SQLite -- so `rowid DESC` is genuinely "written most recently" among rows that tie on the
 * clock. **This is insertion order, not a permanent identity**: `rowid` is not preserved across
 * an `asc export` / `asc import` round-trip, so a same-timestamp tie can resolve differently
 * after one. That is a real limitation, not an oversight -- there is no column on `annotations`
 * that records write order independently of both the clock and storage, so a same-millisecond
 * tie has no identity to break it by that survives a re-import.
 *
 * `schema` qualifies the `annotations` table this subquery reads: `undefined` for a per-project
 * view, where `entries` and `annotations` sit in the same database and the correlated subquery
 * needs no prefix; a database alias for the cross-project union (`union.ts`), where each
 * project's `annotations` table lives in its own ATTACHed schema rather than in `main`. Both
 * callers share this one function so the per-project and unioned views cannot diverge into two
 * different shapes for the same column -- see this module's own comment on why `views.ts` and
 * `union.ts` must agree exactly.
 */
export function invalidatedColumnSql(schema?: string): string {
  const annotations = schema === undefined ? 'annotations' : `${ident(schema)}.annotations`;
  return (
    `(SELECT a.label FROM ${annotations} AS a` +
    ` WHERE a.entry_id = e.id AND a.scheme = ${literal(RESERVED_SCHEME)}` +
    ` ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS ${ident(INVALIDATED_COLUMN)}`
  );
}

/**
 * The `_state` CASE for one property.
 *
 * `json_type(json, '$.p')` is NULL exactly when the path is absent -- which is what "measured" means
 * here, since every value in the vocabulary serializes to a non-null JSON type. The membership test
 * over the `na` array uses `json_each` rather than a substring match on the JSON text:
 * `instr(na_json, '"count"')` would also match `"count_of_x"`, and a state column that reports the
 * wrong state is worse than one that costs a parse.
 *
 * Measured outranks N/A (the recorder refuses both at once, so this only decides how a hand-written
 * row reads).
 *
 * **`declaringVersions` is null when every row in scope is known to declare the property**, which is
 * the cross-project union's situation: the union refuses to mix `type_hash`es, so every row in it
 * shares ONE definition and every property in that definition is declared by every row. The fourth
 * arm (`not_declared`) is then unreachable, and the CASE has three arms -- not because the state
 * model has shrunk, but because a question the four-state model answers cannot be asked here. A
 * version list is passed for the generated views, where a view spans minor versions and an earlier
 * version's rows genuinely never declared a later property.
 */
export function stateCase(property: string, declaringVersions: readonly number[] | null): string {
  const quoted = literal(property);
  const declaring =
    declaringVersions === null
      ? null
      : ` WHEN e.type_version IN (${declaringVersions.map((v) => String(v)).join(', ') || 'NULL'}) THEN 'not_measured'`;

  return (
    `CASE` +
    ` WHEN json_type(e.properties_json, '$.${property}') IS NOT NULL THEN 'measured'` +
    ` WHEN EXISTS (SELECT 1 FROM json_each(e.na_json) AS na WHERE na.value = ${quoted})` +
    ` THEN 'not_applicable'` +
    (declaring ?? ` ELSE 'not_measured'`) +
    (declaring === null ? '' : ` ELSE 'not_declared'`) +
    ` END`
  );
}
