/**
 * `renderDeclaredValue` -- recover a property's DECLARED type when the value in hand is no
 * longer that type's own representation.
 *
 * A generated view built with `json_extract` (`packages/store`'s `profileType`, and later its
 * `--select`/`--filter`/`--group-by` drill-down, `asc-56k`) hands back whatever storage class
 * SQLite chose for the JSON scalar underneath, not the type the spec declared for it. That
 * projection is lossy BY CONSTRUCTION, not by a bug in any one query: SQLite has no boolean
 * storage class, so `json_extract('{"flag":true}', '$.flag')` returns the INTEGER `1`, and
 * `typeof()` on it reports `integer`, never `boolean`. Every other type in the ten-type
 * vocabulary (`spec.ts`) happens to round-trip through that same projection unchanged -- a
 * `string` stays TEXT, an `integer` stays INTEGER, a `timestamp` is stored as its own ISO 8601
 * TEXT -- so `boolean` is the one place the lossy conversion is externally visible. The fix is
 * not "special-case boolean" at each call site, though: it is "read the DECLARED type from the
 * spec and render accordingly", because the spec is the only thing downstream of the view that
 * still knows what was written. A future property type could lose just as much through the same
 * projection, and the fix for it belongs in this one switch, not in a second call site that
 * has to remember to special-case it too.
 *
 * `asc explore <type> --page` never has this problem: it reads `properties_json` directly, the
 * value exactly as the recorder wrote it. That is why `--page` and profile mode could disagree
 * about one property's own declared type in the same command (measured, `asc-6wn`) -- `--page`
 * printed `true`, the profile printed `1`, and the profile's own `type` column said `boolean`
 * while doing it.
 *
 * `asc query` deliberately does NOT call this. It has no spec in hand -- `query-values.ts`
 * explains why guessing one from a column name is worse than stating the limitation -- so there
 * is nothing to recover the declared type FROM.
 */

import type { PropertyType } from './spec.js';

/**
 * Render `raw` -- a value that already passed through a `json_extract` projection -- the way the
 * DECLARED type `type` would print it.
 *
 * Only `boolean` changes anything: SQLite's `0`/`1` becomes `false`/`true`. Every other type is
 * passed through as `String(raw)`, unchanged, because nothing about their own projection is
 * lossy (see the file comment). `json` is included in the switch for exhaustiveness, not because
 * a caller should ever reach it with a value to render: a `json` property is never summarised by
 * value (`profile.ts`'s `cardinality` shape reports only a count), so "how a `json` value prints"
 * is not a decision this function makes.
 *
 * `null` passes straight through, unexamined by the switch, on purpose. A NULL is a STATE
 * (`not_measured` / `not_applicable` / `not_declared`), never a value, and this function only
 * ever renders values. Feeding it a NULL and asking "what does the boolean look like" would force
 * an answer that does not exist -- `false` is a measurement, and manufacturing one for an absence
 * is exactly the defect the three-state model exists to prevent (`state.ts`). The two-overload
 * signature below states that contract in the type system: pass a `string | number` and get a
 * `string` back; pass something that might be `null` and the return type says so too, rather than
 * lying that a value was always rendered.
 */
export function renderDeclaredValue(type: PropertyType, raw: string | number): string;
export function renderDeclaredValue(type: PropertyType, raw: string | number | null): string | null;
export function renderDeclaredValue(
  type: PropertyType,
  raw: string | number | null,
): string | null {
  if (raw === null) return null;

  switch (type) {
    case 'boolean':
      if (raw === 1 || raw === '1') return 'true';
      if (raw === 0 || raw === '0') return 'false';
      // Not zero or one: nothing in the vocabulary should ever produce this (`schema.ts` stores a
      // `boolean` as `z.boolean()`, and SQLite's JSON functions represent JS `true`/`false` as
      // 1/0 and nothing else), so the raw value is passed through rather than guessed at -- an
      // unexpected value stays visible as itself instead of being forced into `true` or `false`
      // by a heuristic.
      return String(raw);
    case 'string':
    case 'number':
    case 'integer':
    case 'enum':
    case 'timestamp':
    case 'duration':
    case 'ref':
    case 'text':
    case 'json':
      return String(raw);
    default: {
      // Exhaustiveness. A property type added to the vocabulary and not handled here fails to
      // compile, the same discipline `schema.ts`'s `propertySchema` and `describeProperty` use.
      const unhandled: never = type;
      throw new Error(`unhandled property type: ${String(unhandled)}`);
    }
  }
}
