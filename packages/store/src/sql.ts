/**
 * SQL generation shared by the generated views and the cross-project union.
 *
 * This module exists because those two places must agree EXACTLY about what a property's state is.
 * If they drifted -- a view saying `not_measured` where the union said `not_applicable` -- the same
 * row would report two different states depending on how it was queried, and both answers would look
 * plausible. That is the failure class this product exists to prevent, so the CASE is generated in
 * one place rather than written twice.
 *
 * Internal to the package: `views.ts` and `union.ts` use it, `index.ts` does not export it.
 */

import { ENVELOPE_PROPERTY_NAMES } from '@ascend/core';

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
