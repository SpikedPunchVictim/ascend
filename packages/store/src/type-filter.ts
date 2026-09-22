/**
 * `typeFilterScope` -- the id-selecting scope `asc explore --filter`, `pageEntries`'s `filter`
 * option, and `groupEntries`'s `filter` option all run a caller's predicate against (`asc-56k`).
 *
 * **Why the raw `entries` table is the wrong thing to filter over, and this file's whole reason
 * for existing.** `entries` stores every declared property inside one JSON document,
 * `properties_json`, so a bare column reference in a filter -- `flag = true`, typed exactly the
 * way `--group-by flag` already accepts the name -- resolves against nothing, and SQLite reports
 * `no such column: flag`. The only spelling that works over the raw table is
 * `json_extract(properties_json, '$.flag') = true`, and asking a caller to switch vocabularies
 * mid-command depending on which flag they typed is the same class of defect `asc-6wn` closed for
 * a rendered boolean: one command disagreeing with itself about what a property is called.
 *
 * **The fix is to filter over a PROJECTION, not the raw table**: a subquery selecting the type's
 * envelope columns unchanged, plus one `json_extract` alias per declared property, named after the
 * property. `views.ts` already builds exactly this projection, once per major family, for the
 * generated `v_<type>_v<major>` views, and `profile.ts`'s `valueExpr` already knows how to render
 * one property's `json_extract`. Both are reused rather than a third expression builder being
 * written here -- the same one-place rule this bead has already applied twice (`stateCase` for
 * `EntryState`, `propertiesOf`/`valueExpr` for `crosstab.ts`).
 *
 * **The collision that would normally make this ambiguous cannot happen.** `ENVELOPE_PROPERTY_NAMES`
 * (`@ascend/core`'s `spec.ts:148`) reserves `id`, `type_name`, `recorded_at`, `cwd` and the rest,
 * and `reservedPropertyName` refuses a declared property under any of those names at registration
 * time -- so a property alias can never shadow an envelope column in the projection below. The two
 * column sets are disjoint by construction, not by luck.
 *
 * **Why `annotate --scope` does NOT get this treatment, and stays over raw `entries`.** `explore`
 * names exactly one type, so "the declared properties" is a well-defined set to build a projection
 * from. A `--scope` predicate is corpus-wide, evaluated before any one type is chosen, so there is
 * no single property set to project. The two commands filtering through two different vocabularies
 * is a deliberate divergence, not the inconsistency this file exists to close -- it follows
 * directly from one of them having a type and the other not.
 *
 * **A property declared only in a later version is NULL for an earlier row, not a fourth state.**
 * `json_extract` of an absent path is NULL regardless of which version wrote the row, so
 * `flag = true` correctly excludes a row that never declared `flag` -- but `flag IS NULL` cannot
 * tell "not declared" from "declared and never measured": both project as NULL here. That is
 * inherent to SQL NULL, not a gap this function papers over: the filter is a ROW SELECTOR deciding
 * which rows pass, not a state reporter, and it is `--group-by` (`groupEntries`, backed by the same
 * `EntryState` `entryStates` derives) that still separates the two when the question is which state
 * a row is in.
 */

import { canonicalName } from '@ascend/core';
import type { DatabaseSync } from 'node:sqlite';
import { propertiesOf, valueExpr } from './profile.js';
import { UnknownTypeError } from './recorder.js';
import { registeredNames, typeVersions } from './registry.js';
import { ENVELOPE_COLUMNS, ident, literal } from './sql.js';
import { wrapPredicateOverQuery } from './statements.js';

/**
 * The id-selecting scope for a filter over one type, properties projected as bare columns.
 * Returns the full statement, so a caller cannot skip the check and interpolate anyway.
 *
 * Throws `UnknownTypeError` for a type nobody registered, the same error `groupEntries` and
 * `recordEntry` throw for the identical situation -- there is no property set to project without a
 * registered definition, so this cannot silently fall back to filtering nothing. `fragment` goes
 * through `wrapPredicateOverQuery` (`statements.ts`), so a predicate carrying a second statement is
 * refused (`PredicateError`) rather than silently truncated by `db.prepare`, exactly as
 * `wrapPredicate` already refuses one over the raw table for `annotate --scope`.
 */
export function typeFilterScope(db: DatabaseSync, type: string, fragment: string): string {
  const canonical = canonicalName(type);
  const versions = typeVersions(db, canonical);
  if (versions.length === 0) {
    throw new UnknownTypeError(type, undefined, registeredNames(db).types);
  }

  // Sorted, for the reason `views.ts` sorts its own column list (see that file's module comment):
  // the projection's column order becomes a function of the property set rather than of
  // registration history, so two calls against the same definitions build byte-identical SQL.
  const properties = [...propertiesOf(versions).keys()].sort();

  const projected = [
    ...ENVELOPE_COLUMNS.map((column) => `e.${column} AS ${ident(column)}`),
    ...properties.map((name) => `${valueExpr(name)} AS ${ident(name)}`),
  ].join(',\n         ');

  const projection =
    `SELECT ${projected}\n` +
    `           FROM entries AS e WHERE e.type_name = ${literal(canonical)}`;

  return wrapPredicateOverQuery(projection, fragment);
}
