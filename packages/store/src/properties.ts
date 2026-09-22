/**
 * `propertiesOf` and `valueExpr` -- the two pieces of `profile.ts` that `type-filter.ts` also
 * needs, split into their own module so the two can share them without importing each other.
 *
 * **Why this file exists at all.** `type-filter.ts` builds its projection out of the same
 * "declared property union" and the same `json_extract` expression `profile.ts` already computes
 * for its own per-property queries (`propertiesOf`, `valueExpr`) -- one definition of each,
 * reused, rather than a second copy that could drift (`type-filter.ts`'s own module comment). That
 * was fine while `profile.ts` was the only exporter and `type-filter.ts` the only other consumer.
 * `asc-qfk.1` made `profile.ts` itself a caller of `typeFilterScope` (`type-filter.ts`), which would
 * import `propertiesOf`/`valueExpr` back from `profile.ts` -- a two-file cycle `align check`
 * refuses (`arch.no-cycles:repo`), confirmed red when tried the direct way. Moving the two shared
 * functions to a leaf module both `profile.ts` and `type-filter.ts` depend on, and neither exports
 * back into, breaks the cycle without changing what either function does.
 *
 * `profile.ts` re-exports both, so every existing importer of `propertiesOf`/`valueExpr` from
 * `./profile.js` (`crosstab.ts`, and `@ascend/store`'s own index) keeps working unchanged.
 */

import { literal } from './sql.js';
import type { TypeVersionRow } from './registry.js';
import type { PropertyType } from '@ascend/core';

/**
 * The property set of one type, unioned over the versions that declare each property.
 *
 * Exported for `crosstab.ts` (`asc-56k`): resolving a group-by key's declared type has to walk
 * the same "newest declaring version wins" union this function already computes for the profile
 * (see the retyped-and-reverted case documented on `profileType`'s caller in `profile.ts`) -- a
 * second walk over `versions` here would be a second place that rule has to stay correct.
 */
export function propertiesOf(
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
 * The `json_extract` projection of one property.
 *
 * Exported for `crosstab.ts` (`asc-56k`) and `type-filter.ts` (`asc-qfk.1`): every SQL caller of
 * this exact expression reads a property's raw value through the identical path `profile.ts`'s
 * `topValues` and `rangeOf` use, rather than a second one that could disagree about the JSON path
 * syntax.
 */
export function valueExpr(property: string): string {
  return `json_extract(e.properties_json, ${literal(`$.${property}`)})`;
}
