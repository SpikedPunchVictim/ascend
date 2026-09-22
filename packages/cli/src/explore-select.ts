/**
 * `asc explore --select` -- flattening a page's rows to named, declared columns (`asc-56k`).
 *
 * **WHY THIS EXISTS SEPARATELY FROM `entryRow`.** A page's default row (`output.ts`'s `entryRow`)
 * carries every property nested under one `properties` key, because a page does not know in
 * advance which of them a caller wants and a flat row would collide a property named `id` with the
 * entry's own id (`asc-865.1`). `--select` is the caller naming exactly which properties matter, so
 * the collision that forces nesting cannot happen for the names it lists -- `reservedPropertyName`
 * (`@ascend/core`) refuses `id`, `recorded_at` and `type_version` as property names at the point a
 * type is DEFINED, so a declared property can never collide with the three envelope columns this
 * module always keeps. That makes the flattening in `selectRow` below collision-free by
 * construction, not by a check this module has to make itself.
 *
 * **WHY THE FOUR-STATE NAME COMES FROM `entryStates`, AND NOT FROM READING
 * `RecordedEntry.states` HERE.** `RecordedEntry.states` (`recorder.ts`) is core's THREE-state
 * `PropertyState`, keyed only by the properties the entry's own recording version declared -- a
 * property that version never declared has no key in it at all. Reading that absence as
 * `'not_declared'` locally would be correct FOR TODAY (`validateEntry`, `core/state.ts`, only ever
 * writes a key for `spec.properties`), but it is the identical collapse `sql.ts`'s four-state
 * `EntryState` and its `stateCase` exist to keep out of this codebase once, in one place: a second
 * spot deciding "absent means not_declared" is a second answer to a question this project already
 * pays a whole module (`sql.ts`) to answer, and the two could drift the moment either side's
 * definition of "absent" changes for a reason neither author of the other one sees. `entryStates`
 * (`@ascend/store`) is the store's own batch derivation of the same four-state answer
 * `groupEntries` reports for `--group-by` and `profileType` reports for the default map -- one
 * function, called once per page, so this module never re-derives what a state is at all; it only
 * renders the string that function returns.
 *
 * **WHY `renderDeclaredValue` RATHER THAN `String(raw)`.** `RecordedEntry.properties` comes from
 * `JSON.parse`, so a measured boolean here is already a genuine `true`/`false`, not the `0`/`1`
 * `renderDeclaredValue`'s own file comment says it exists to recover from a `json_extract`
 * projection. `String(true)` would print the right thing today by coincidence, not by contract --
 * `renderDeclaredValue`'s switch is the ONE place this codebase decides how a declared type prints,
 * and `profileType`'s top values already render through it (`asc-6wn`). `toWireValue` below exists
 * only to put a native JS value into the shape that switch already expects (a boolean becomes the
 * SQLite storage class it would have been projected as, 0 or 1), so the two call sites cannot drift
 * into two different answers for "what does a selected boolean look like".
 */

import { renderDeclaredValue, type PropertyType } from '@ascend/core';
import {
  entryStates,
  findType,
  type EntryState,
  type RecordedEntry,
  type Store,
  type TypeProfile,
} from '@ascend/store';
import { refusal } from './errors.js';
import type { Row } from './output.js';

/**
 * The handle a per-version property-type lookup (and `entryStates`) runs against.
 *
 * An indexed access on the store's own `Store` type rather than `import type { DatabaseSync } from
 * 'node:sqlite'`: `node:sqlite` may not be named anywhere but `@ascend/store` (align and eslint both
 * enforce it). `query.ts`'s `Handle` is the precedent for this.
 */
type Handle = Store['db'];

/** `--select a,b,c` as the names, in the order typed. Not deduplicated: a repeated name is a caller
 * mistake that surfaces as two identical columns rather than one silently dropped. */
export function parseSelect(raw: string): readonly string[] {
  return raw.split(',').map((name) => name.trim());
}

/**
 * Refuse any name that is not a property this type's registered versions ever declared.
 *
 * `refusal`, not `usageError`, for the reason `explore-sample.ts`'s `resolveSample` gives for the
 * identical shape of question: a name a type does not declare is the same kind of answer as a type
 * name nobody registered -- the command line reads fine, and the world (this type's definition)
 * says no.
 */
export function resolveSelect(profile: TypeProfile, names: readonly string[]): void {
  const declared = profile.properties.map((property) => property.name);
  for (const name of names) {
    if (!declared.includes(name)) {
      throw refusal(
        `'${profile.type}' declares no property named '${name}', so --select cannot flatten it. ` +
          `Declared properties: ${declared.join(', ') || '(none)'}.`,
      );
    }
  }
}

/**
 * A cache of a type's per-version property types, so a page spanning several registered versions
 * costs at most one `findType` call per DISTINCT version rather than one per entry.
 */
export type VersionTypeLookup = (version: number, propertyName: string) => PropertyType | undefined;

export function makeVersionTypeCache(db: Handle, typeName: string): VersionTypeLookup {
  // One cache entry per (version, propertyName) pair -- a page can select several properties from
  // the same version, and this is called once per selected property per row.
  const cache = new Map<string, PropertyType | undefined>();
  return (version, propertyName) => {
    const cacheKey = `${String(version)} ${propertyName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const row = findType(db, typeName, version);
    const type = row?.spec.properties.find((property) => property.name === propertyName)?.type;
    cache.set(cacheKey, type);
    return type;
  };
}

/**
 * Adapt a measured value's native JS shape to the wire shape `renderDeclaredValue` expects -- the
 * shape a `json_extract` SQL projection would have produced. A boolean becomes its SQLite storage
 * class (0 or 1); a string or number passes through unchanged. This is plumbing, not a second
 * rendering rule: `renderDeclaredValue`'s own switch is still the only place a declared type's
 * printed form is decided, and this only puts the value in the shape that switch already reads.
 */
function toWireValue(raw: string | number | boolean): string | number {
  return typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
}

/**
 * One selected property's rendered cell, for one entry -- `state` is `entryStates`'s own answer for
 * this (entry, property) pair, never re-derived here (see this module's file comment).
 */
function selectedCell(
  entry: RecordedEntry,
  name: string,
  state: EntryState,
  propertyType: VersionTypeLookup,
): string {
  if (state !== 'measured') return state;

  const raw = entry.properties[name];
  if (typeof raw === 'boolean' || typeof raw === 'string' || typeof raw === 'number') {
    const type = propertyType(entry.typeVersion, name);
    if (type === undefined) {
      // Unreachable: `entryStates` reporting 'measured' for (entry, name) means this entry's own
      // recording version's spec declared `name` (the same fact `validateEntry`, `core/state.ts`,
      // requires to write 'measured' at all), which is exactly the spec `propertyType` reads back
      // out of the registry for that same version.
      throw new Error(
        `explore --select: '${name}' has no declared type for '${entry.typeName}' v` +
          `${String(entry.typeVersion)}, despite being measured`,
      );
    }
    return renderDeclaredValue(type, toWireValue(raw));
  }

  // `json`: an array or object. `renderDeclaredValue`'s own comment says a `json` value is never
  // summarised by it -- `profileType` never calls it with one either. Stringified rather than
  // passed through natively, so a --select column is one consistent shape (a string) whichever
  // state a row is in: `not_measured` is already a string, and a column that was sometimes a
  // string and sometimes a native JSON value would be a column with two shapes for one name.
  return JSON.stringify(raw);
}

/** The columns `--select a,b,c` produces: the three envelope columns, then the named properties, in
 * the order typed (decision D2, `asc-56k`). `id` is always kept even though it was never named. */
export function selectColumns(names: readonly string[]): readonly string[] {
  return ['id', 'recorded_at', 'type_version', ...names];
}

/** One flattened row: the envelope, then one top-level key per selected property, given that
 * entry's own row of `entryStates`'s parallel result. */
export function selectRow(
  entry: RecordedEntry,
  states: Readonly<Record<string, EntryState>>,
  names: readonly string[],
  propertyType: VersionTypeLookup,
): Row {
  const row: Record<string, unknown> = {
    id: entry.id,
    recorded_at: entry.recordedAt,
    type_version: entry.typeVersion,
  };
  for (const name of names) {
    const state = states[name];
    if (state === undefined) {
      // `entryStates`'s own contract is a key for every requested property, on every returned
      // record -- see this module's file comment on why that contract exists at all.
      throw new Error(
        `explore --select: entryStates returned no state for '${name}' on entry '${entry.id}'`,
      );
    }
    row[name] = selectedCell(entry, name, state, propertyType);
  }
  return row;
}

/**
 * Every row for one page, in one batch: `entryStates` is called ONCE for the whole page rather than
 * once per row, because it is a store-side query and a page is exactly the unit this command
 * already reads in one round trip (`pageEntries`, `commands/explore.ts`).
 */
export function selectRows(
  db: Handle,
  type: string,
  entries: readonly RecordedEntry[],
  names: readonly string[],
  propertyType: VersionTypeLookup,
): readonly Row[] {
  const states = entryStates(db, type, entries, names);
  return entries.map((entry, index) => {
    const rowStates = states[index];
    if (rowStates === undefined) {
      // Unreachable: `entryStates`'s own contract is one record per entry, in the same order.
      throw new Error(
        `explore --select: entryStates returned ${String(states.length)} records for ` +
          `${String(entries.length)} entries`,
      );
    }
    return selectRow(entry, rowStates, names, propertyType);
  });
}
