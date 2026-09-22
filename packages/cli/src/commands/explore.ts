/**
 * `asc explore <type>` -- the map, before any rows.
 *
 * **The default output is a MAP, not a page of entries.** Handed rows, a reader looks at row 1 and
 * generalises; handed a profile, it chooses what to look at. So this prints counts, ranges,
 * cardinalities and per-property state tallies, and never an entry -- which also means a profile of
 * a corpus full of prose puts none of that prose into a caller's context. `--select`, `--filter` and
 * `--group-by` (`asc-56k`) are the drill-down: naming columns, narrowing rows, and asking a joint
 * question of two properties at once, each documented in its own paragraph below.
 *
 * **Four modes answer "which entries, and how much of them"; `--group-by` answers a different
 * question and refuses all four of them.** The map (nothing), `--page` (a stable window you
 * resume, and what `--select` flattens), `--sample` (a subset chosen for spread), and `--dump`
 * (all of them, on disk, with an index) are not composable with each other, and the command
 * refuses the combinations rather than resolving them: a caller who asked for a page and got a
 * dump, or the reverse, is looking at a different set of entries than the one they named, and
 * nothing in either output says so. `--group-by` is a fifth flag but not a fifth member of that
 * family -- it hands back COUNTS over entries, never entries themselves, so it is refused
 * alongside all four rather than merged with any of them (`explore-group.ts`).
 *
 * **`--dump` is the only mode whose output outlives the command, and that changes what it owes the
 * caller.** A page is read and gone; a dump directory is returned to days later by someone holding
 * the files and nothing else. So the index carries what the files were a dump OF, and it is written
 * LAST -- a directory with data in it and no index is a directory with nothing to read, while the
 * reverse would be an index naming files that were never written. For the same reason the token
 * budget never touches the disk: `--max-tokens` fits the INDEX on stdout, which says so in its own
 * `trim` block, while every file and the on-disk manifest are complete regardless.
 *
 * **`--page` is the opt-in that breaks that rule, and it is opt-in for exactly that reason.** The
 * choice of map-over-rows is a good default, not a prohibition: a model that has read the map and
 * decided which slice it needs must be able to ask for it. `--cursor` and `--limit` imply `--page`
 * so the common case is one flag, and every page reports its coverage and, when there is more, the
 * cursor that resumes it.
 *
 * **The page's table elides ids at a shared prefix AND a discriminating suffix, not the head alone
 * (`asc-i36`, fixed in `output.ts`'s `truncateCell`).** An id here is a long shared prefix plus a
 * short discriminating suffix, and a head-only cut used to keep exactly the part every row shares:
 * measured by driving this command against the frozen EV-11 store --
 * `asc explore verification_run --page --limit 40 --json`, then rendering each id the same way the
 * table did -- **40 distinct ids produced 6 distinct cells**, in groups of 12, 13 and 12, under the
 * old head-only rule. `renderTable` now keeps a head AND a tail around the `…`, which is a rule in
 * the renderer and not a width for this command, so every other table in this CLI got the same fix.
 * `--json` and `--csv` still carry ids verbatim and are never truncated at all.
 *
 * **Rows, and one column set for all of them.** Header facts (`count`, the `recorded_at` range,
 * and -- only for a type that declares a `timestamp` property -- the `recorded_at_clock` row
 * naming which clock that range is on (`asc-bn0`, `recordedAtClockRow` below), then one row per
 * registered version, then one row per declared property. The property rows carry the
 * tally and the summary in columns of their own; the table renders a line and `--json` carries the
 * structure, from one build of the data rather than two that could disagree (`output.ts`:
 * `columns` is a view of the rows, not a definition of them).
 *
 * **THREE of a property's four state ratios are over the entries that DECLARED it**, not over the
 * type's total. `measured 51 (58.6%)` is a share of the 87 entries whose registered version declared
 * that property; entries recorded before the property existed are excluded, because the question was
 * not askable of them. So `declared_entries` on the row is NOT `count`, and both are reported -- a
 * ratio against the type's total would report a property as 50% measured when every entry that could
 * have measured it did. **The fourth, `not_declared`, is the opposite: it is a share of `count`, the
 * type's total, because those are exactly the entries it is NOT drawn from a subset of** -- an entry
 * is `not_declared` precisely because its recording version never put it in the `declared` population
 * at all. Dividing it by `declared` instead was a real defect (`asc-5x7`), fixed by `stateDenominator`
 * below: a property added in v2 with 500 v1 entries and 10 v2 entries used to render
 * `not_declared 500 (5000.0%)`.
 *
 * **What is absent is absent, never zero.** `min`/`max` appear only for a property summarised by
 * range, `top` only for a categorical one, and `recorded_at` is omitted entirely for a type with no
 * entries. Every row carries `summary`, so an absent key is never read as "nothing there" -- it is
 * read as "this kind of property does not have that" (`TASKS.md` #7).
 *
 * **A property's tally is ALSO four short rows, one per state, not only the combined line
 * (`asc-cbk`).** The combined line runs 92 characters at the corpus's own numbers --
 * `measured 51 (58.6%), not_applicable 0 (0.0%), not_measured 36 (41.4%), not_declared 0 (0.0%)` --
 * and `renderTable` elides every cell past its shared 60-character limit, so the combined line alone
 * would cut after `not_measured ` and hide two of the four states behind the `…`. Rather than widen
 * the cell for this command (a truncation rule that differs per command) or delete the combined
 * line, `propertyStateRows` adds one row per property PER STATE -- `field: property.<name>.measured`,
 * `value: 51 (58.6%)` originally -- immediately after the property's own summary row. Each is short
 * enough that `renderTable` never truncates it, so the default table cannot collapse "measured" and
 * "nobody looked" into one appearance, which is the failure the three-state model exists to prevent.
 * The summary row and its combined line are unchanged, additive rather than replaced, so a consumer
 * reading `tally` today keeps reading exactly what it read before.
 *
 * **`asc-5x7` upgrades that per-state `value` from the bare percentage above to the QUALIFIED form
 * (`renderProportion` over `wilson`), and adds one more row per `top`-summarised property per top
 * value (`propertyTopRows`).** The combined `tally` line and `values` cell stay exactly the compact
 * shape described above (decision D4) -- only the per-state and per-top-value rows carry the
 * interval, the n and the small-group flag, structured (`proportion`, `denominator`) as well as
 * rendered (`value`). Before this, `--json` for this command carried no `lower`, `upper`,
 * `confidence` or small-group key anywhere, while `asc annotate --backtest` already carried all four
 * for its own proportions -- the inconsistency `asc-5x7` closes.
 *
 * **`--filter` is one predicate language, not two -- but it is not the SAME scope `asc annotate
 * --scope` takes, and the reason is what each command names.** Both are a SQL fragment over
 * `entries`, wrapped by `wrapPredicate`/`typeFilterScope` so a fragment carrying a second statement
 * is refused rather than silently run. `annotate --scope` is corpus-wide -- it runs before any type
 * is chosen, so "the declared properties" is not a well-defined set to project as columns, and a
 * caller writes `json_extract(properties_json, '$.name')` or an envelope column, same as ever. This
 * command already names ONE type, so `--filter` runs over that type's OWN generated view instead
 * (`typeFilterScope`, `@ascend/store`) -- every declared property is a bare column, exactly the
 * name `--select` and `--group-by` already use for it. `--filter "stage = 'done'"` is the filtered
 * read a declared property gets here; the envelope (`type_name`, `recorded_at`, `cwd`, ...) still
 * compares bare too, unaffected by which of the two scopes is running. A second, bespoke expression
 * syntax for this command alone would still be a worse idea than either of these -- there is one
 * grammar (SQL), projected two different ways depending on what the command already knows.
 *
 * **A measured boolean is stored, and compared, as the INTEGER the generated view projects it as --
 * not the word it PRINTS as, and this is the one place the bare-column convenience above still has
 * a sharp edge.** `--select` prints a boolean as `true`/`false` (`renderDeclaredValue`), but
 * `--filter` runs before any rendering happens, against the raw stored value. Measured directly
 * (node v24.18.0, SQLite 3.53.4, `SELECT json_extract(p,'$.flag') AS flag` over two rows, one
 * `true` and one `false` -- `p` standing for `properties_json`, what the generated view's `flag`
 * column is itself built from):
 *
 * ```
 * flag = true      1
 * flag = false     1
 * flag = 1         1
 * flag = 0         1
 * flag = 'false'   0
 * flag = 'true'    0
 * flag IS TRUE     1
 * NOT flag         1
 * typeof           integer
 * ```
 *
 * **This is sharper than "a string comparison fails to match": `--filter "flag = 'false'"` does
 * not fail -- it matches ZERO rows and raises nothing, so it reads as "there are none" rather than
 * "you compared a string to an integer".** Write `--filter "flag = false"` or `--filter "flag =
 * 0"`; never a quoted boolean. This is the one part of the stored-vs-declared asymmetry a caller
 * can still trip over now that every other part of it (the column name itself) is gone.
 *
 * **One caveat this does not fix: a property declared only in a later version projects as SQL
 * NULL for an entry recorded under an earlier one, so a filter cannot tell `not_declared` apart
 * from `not_measured`** -- both are simply absent from the comparison, the same as any other NULL.
 * That is inherent to what NULL means, not an oversight, and it is acceptable because `--filter` is
 * a ROW SELECTOR, not a state reporter -- `--group-by` (and the default map) are what keep the two
 * states apart, over the SAME entries a filter could narrow first.
 *
 * **`--filter` applies to the default map too (`asc-qfk.1`), and EVERY number on it is then over
 * the filtered population -- not only the two denominators `asc-5x7` named.** `profileType`
 * (`@ascend/store`) narrows every subquery it issues -- `top`, `distinct`, `min`/`max`, the
 * per-version tallies, `recorded_at_min`/`max`, and both of a property's state denominators (the
 * map's own `declared_entries`, and `not_declared`'s share of the type's own total) -- through one
 * scope built once from `--filter`'s predicate. A map whose ratios were filtered while its values
 * still described the unfiltered corpus would be worse than the refusal this bead replaced: every
 * one of those values would be a true statement about a population the caller did not ask about,
 * under a `count` that said otherwise. `filter matched N of M entries` (the same line `--page`,
 * `--sample` and `--group-by` already print, from `Output.filter`) says which population every
 * number on the map now describes.
 *
 * **`--filter` is still refused with `--dump`, for a reason unrelated to the map's own refusal.**
 * A dump is meant to be the complete, reproducible record of a type, read again later by someone
 * who never saw the command line that produced it -- a filtered dump would be indistinguishable
 * on disk from a complete one, and its manifest has nowhere to carry the predicate that thinned
 * it. `--page --filter ...` is the filtered read a dump cannot be.
 *
 * **`--select a,b,c` flattens a page's rows to named, declared columns (`asc-56k`), and implies
 * `--page`.** Reading a page for properties you already know you want should not cost the
 * `properties` object's nesting -- `--select stage,outcome --csv` needs a real two-column CSV
 * (`id`, `recorded_at`, `type_version`, `stage`, `outcome`), not a JSON blob sitting in a CSV cell.
 * `id` is always kept even when not named; every column beyond it is a declared property, in the
 * order typed, refused if any name is not one this type's registered versions ever declared
 * (listing the ones that are). A property with no measured value renders its STATE NAME
 * (`not_measured`/`not_applicable`/`not_declared`), never a blank cell -- rendered from the store's
 * own `entryStates` (the same four-state derivation `--group-by` and the default map use), not
 * re-derived here, so this command cannot disagree with itself about what a state is. A selected
 * column can never collide with the three envelope columns, because `reservedPropertyName`
 * (`@ascend/core`) refuses `id`, `recorded_at` and `type_version` as property names when a type is
 * DEFINED, long before a page is ever read. See `explore-select.ts` for the rendering rules this
 * implements.
 *
 * **`--group-by a[,b]` answers a joint question -- how two properties co-occur -- that no number of
 * single-property profiles can (`asc-56k`).** One key gives a single-property tally with a
 * QUALIFIED proportion of `total` per value (`renderProportion` over `wilson`, the same rule
 * `propertyTopRows` above already uses); two keys give counts only, because a cell's share could be
 * of its row, its column or the grand total, and choosing one silently would answer a question the
 * caller did not ask. Only a property `profileType`'s own `summaryFor` would call `top` -- enum,
 * boolean, string or ref -- can be a key; the store throws a caller-facing error naming the
 * property, its declared type and its actual summary otherwise, and this command surfaces that
 * message as-is rather than re-deriving it. A result under `MIN_N` (20) is marked an anecdote, the
 * same convention already applied to a small sample. `--group-by` is refused together with
 * `--page`, `--cursor`, `--sample` and `--dump` (see the "Four modes" paragraph above) and together
 * with `--select`: each of those answers "which entries", and `--group-by` answers "how many", so
 * none of them compose with it. See `explore-group.ts` for the row shape this produces.
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { CURSOR_ORDER, DEFAULT_PAGE_SIZE } from '@ascend/core';
import { wilson, type Proportion } from '@ascend/analysis';
import {
  entryIds,
  findEntry,
  findType,
  groupEntries,
  PredicateError,
  pageEntries,
  profileType,
  signatures,
  typeFilterScope,
  UngroupablePropertyError,
  UnknownGroupKeyError,
  type GroupResult,
  type PropertyProfile,
  type RecordedEntry,
  type PageResult,
  type StateCounts,
  type VersionProfile,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal, usageError } from '../errors.js';
import { knownNames } from '../register-document.js';
import {
  chooseSample,
  resolveSample,
  SAMPLE_MODES,
  type SampleMode,
  type SampleRequest,
} from '../explore-sample.js';
import {
  makeVersionTypeCache,
  parseSelect,
  resolveSelect,
  selectColumns,
  selectRows,
} from '../explore-select.js';
import { buildGroupOutput, headerRowCount, parseGroupBy, rowKey } from '../explore-group.js';
import {
  entryRow,
  render,
  renderProportion,
  subset,
  type Row,
  type SampleReport,
} from '../output.js';
import { fitToBudget, BudgetFloorError, type BudgetRequest } from '../budget.js';
import { dumpFileRow, MANIFEST_NAME, planDump, type DumpChunk } from '../explore-dump.js';

/** The state names, in the order they are rendered and counted. */
const STATES = ['measured', 'not_applicable', 'not_measured', 'not_declared'] as const;

/**
 * The mode the caller typed, as a member of the vocabulary.
 *
 * oclif has already refused anything outside `SAMPLE_MODES` by the time this runs, so the search
 * cannot fail -- and the throw is what makes that a check rather than an assumption, on the one
 * boundary where a string becomes a decision.
 */
function sampleMode(typed: string | undefined): SampleMode | undefined {
  if (typed === undefined) return undefined;
  const mode = SAMPLE_MODES.find((candidate) => candidate === typed);
  if (mode === undefined) throw usageError(`--sample must be one of: ${SAMPLE_MODES.join(', ')}`);
  return mode;
}

/**
 * Which n a state's share is a share OF (`asc-5x7`, decision D2) -- the one thing `renderStates`
 * (the compact tally line) and `propertyStateRows` (the per-state rows) must never disagree about,
 * so it is computed in exactly one place and both call it.
 *
 * `measured`, `not_applicable` and `not_measured` PARTITION the declared count: every entry that
 * declared the property landed in exactly one of the three, so each is a share of `declared`.
 * `not_declared` is not a share of that population at all -- it counts entries that were never IN
 * it, because their recording version never declared the property. Its denominator is the type's
 * own total (`count`, i.e. `profile.count`), the population `not_declared` is actually drawn from.
 *
 * **THIS WAS THE BUG THE WILSON WRAPPING EXPOSED.** Before this fix, both `renderStates` and
 * `propertyStateRows` divided every state -- `not_declared` included -- by `declared`, which for
 * the first three states is correct and for the fourth is a ratio of two DISJOINT sets: a property
 * added in v2, with 500 v1 entries and 10 v2 entries, rendered `not_declared 500 (5000.0%)`. Handing
 * that same pair to `wilson(500, 10)` throws `ProportionError` ("successes cannot exceed n") --
 * `wilson` did not create this defect, it made a percentage over 100% impossible to ship silently.
 */
function stateDenominator(state: (typeof STATES)[number], declared: number, count: number): number {
  return state === 'not_declared' ? count : declared;
}

/**
 * The tally as one line: every state named, with its share of the population `stateDenominator`
 * names for it.
 *
 * **Every state is named, including the ones at zero.** `not_applicable 0` is not noise -- for a
 * derived corpus it is the finding, and dropping the empty states from a rendering whose JSON
 * counterpart states them exactly is how a reader comes to believe a corpus uses a state it never
 * uses (`EV-baseline.md`, decision 2).
 *
 * **Deliberately still the bare count-and-percentage form, not the qualified Wilson string
 * (`asc-5x7`, decision D4).** Four `renderProportion` strings joined into one `tally` cell would run
 * to roughly 350 characters in a table that already elides at 60 -- the exact failure `asc-cbk`
 * created `propertyStateRows` to solve for the un-qualified form. The qualified form lives on the
 * per-state rows below instead; this line stays a map, not a page.
 *
 * A denominator of zero is a type (or, for the first three states, a property) with no entries in
 * that population at all, where a share would be a division by it, so the bare count is rendered
 * instead.
 */
function renderStates(counts: StateCounts, declared: number, count: number): string {
  const share = (state: (typeof STATES)[number]): string => {
    const n = stateDenominator(state, declared, count);
    const value = counts[state];
    return n === 0 ? String(value) : `${String(value)} (${((value / n) * 100).toFixed(1)}%)`;
  };

  return STATES.map((state) => `${state} ${share(state)}`).join(', ');
}

/**
 * The summary of a property's values, as a person reads it. Not a format -- the structured keys on
 * the same row are.
 *
 * A `top` property lists at most K values, and the reader is told when that cut something:
 * the `distinct` column holds the total, so `distinct > top.length` is the statement that values
 * were withheld. No separate "truncated" marker, because a second field for a fact the first
 * already determines is a second field that can disagree with it.
 */
function renderSummary(property: PropertyProfile): string {
  switch (property.summary) {
    case 'top':
      if (property.top.length === 0) return 'no value measured';
      return property.top.map((entry) => `${entry.value} ${String(entry.count)}`).join(', ');
    case 'range':
      if (property.min === null || property.max === null) return 'no value measured';
      return `${String(property.min)} … ${String(property.max)}`;
    case 'cardinality':
      // Said rather than left blank: an empty cell beside a populated `distinct` reads as a
      // summary that failed, and the honest answer is that this kind of value does not have one.
      return 'not summarised';
  }
}

/**
 * What a directory holds, or `undefined` when it does not exist.
 *
 * `undefined` rather than an empty list, because "there is nothing there" and "there is no there
 * there" lead to the same write and different sentences. Only `ENOENT` is caught: a directory that
 * exists and cannot be read is a real failure, and swallowing it would turn a permission problem
 * into a dump that reports the directory as empty and then fails on the first write.
 */
function contentsOf(dir: string): readonly string[] | undefined {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The one row naming which clock `recorded_at` is, placed immediately after the range it
 * describes (`asc-bn0`).
 *
 * **`recorded_at_min`/`recorded_at_max` are accurate and, for an ingested type, read as a
 * corpus with no history.** Verified against the live store (`asc explore tool_denial --json`,
 * 2026-09-18): `recorded_at_min` and `recorded_at_max` were both `2026-09-17T22:37:40.736Z`,
 * while `property.occurred_at`'s own `range` summary -- three rows below, on the same output --
 * carried the true span, `2026-08-13T17:01:28.248Z` to `2026-09-17T20:30:58.884Z`. A `timestamp`
 * property always summarises as `range` (`renderSummary` above), so that true span was already
 * on the output; this row is the pointer to it, not a new query. `profile.ts`'s
 * `MIN`/`MAX(recorded_at)` is unchanged -- the fix is presentational, per the bead's second
 * comment.
 *
 * **Omitted for a type that declares no `timestamp` property**, because there the advice would
 * name no property to read instead, and a pointer at nothing is worse than no pointer
 * (`TASKS.md` #7: omitted, never fabricated).
 *
 * `eventClocks` is every property this type has ever declared `timestamp` (across all
 * registered versions, the same population `declaredTypes` already accumulates for
 * `propertyRow`), sorted -- so two callers reading the same type's map read the properties in
 * the same order regardless of the order they were registered in.
 */
function recordedAtClockRow(typeName: string, eventClocks: readonly string[]): Row | undefined {
  const first = eventClocks[0];
  if (first === undefined) return undefined;

  return {
    field: 'recorded_at_clock',
    value:
      `'recorded_at' is the write clock -- when \`asc\` wrote the row, not when the event ` +
      `happened. '${typeName}' declares ${eventClocks.map((name) => `\`${name}\``).join(', ')} as ` +
      `its event clock${eventClocks.length === 1 ? '' : 's'}: see \`asc stats --at ${first}\`.`,
    event_clocks: eventClocks,
  };
}

/** One registered version, as a person reads it, with the numbers structured beside it. */
function versionRow(row: VersionProfile): Row {
  return {
    field: `version.${String(row.version)}`,
    value: `major ${String(row.major)}, ${row.status}, ${String(row.entries)} entries`,
    version: row.version,
    major: row.major,
    status: row.status,
    entries: row.entries,
    type_hash: row.typeHash,
  };
}

/**
 * How many entries could have declared this property at all -- the denominator `renderStates` and
 * `propertyStateRows` both share, so the two cannot silently disagree about what a share is over.
 */
function declaredCount(property: PropertyProfile): number {
  return property.states.measured + property.states.not_applicable + property.states.not_measured;
}

/**
 * One property row.
 *
 * `min`, `max` and `top` are attached CONDITIONALLY, and that is the whole reason this is a
 * function rather than an object literal: a `min: null` on a categorical property would be
 * indistinguishable from "nothing was measured", which is a different and wrong claim. `summary`
 * is always present, so the reader can tell which keys to expect.
 *
 * `count` -- the type's total (`profile.count`) -- is threaded in explicitly rather than read off a
 * module-level variable, so `renderStates`'s `not_declared` denominator (`asc-5x7`, D2) is a
 * parameter of this function the same way `declared` already is, and not an ambient value a caller
 * could forget to pass or a future caller could pass inconsistently.
 */
function propertyRow(property: PropertyProfile, count: number): Row {
  const declared = declaredCount(property);

  return {
    field: `property.${property.name}`,
    // The rendered type is a display: two versions may declare one name with different types, and
    // both are named rather than one being chosen.
    type: property.declaredTypes.join(' | '),
    tally: renderStates(property.states, declared, count),
    distinct: property.distinct,
    values: renderSummary(property),
    name: property.name,
    declared_types: property.declaredTypes,
    required: property.required,
    declaring_versions: property.declaringVersions,
    summary: property.summary,
    states: property.states,
    declared_entries: declared,
    ...(property.summary === 'top' ? { top: property.top } : {}),
    ...(property.summary === 'range' ? { min: property.min, max: property.max } : {}),
  };
}

/** Which n a rendered proportion used -- named rather than left for a reader to infer from `count`. */
type Denominator = 'declared_entries' | 'entries' | 'measured';

/**
 * One row per property PER STATE, immediately after the property's own summary row (`asc-cbk`).
 *
 * **Additive, not a replacement.** `propertyRow`'s `tally` line is unchanged. Before `asc-5x7` this
 * row's `value` was already in that row's `states` field -- `--json` never hid a count, only the
 * default TABLE did, by cutting the combined line at 60 characters. `asc-5x7` adds something that
 * genuinely was not on the output before: `value` is now the QUALIFIED form (`renderProportion`
 * over `wilson`), and `proportion`/`denominator` carry that same measurement structured, so a
 * `--json` consumer gets `lower`/`upper`/`confidence`/`smallGroup` where before it had only a bare
 * count -- the gap `asc-5x7` exists to close. `renderStates`'s compact `tally` cell deliberately does
 * NOT gain this qualification (decision D4): it stays a map, not a page.
 *
 * `field` is namespaced under the property's own (`property.<name>.<state>`) rather than flattened
 * to the state name alone, because a type can declare a property called `measured`, and a field name
 * that collided with a state name would be ambiguous about which one a reader was looking at.
 *
 * `denominator` names WHICH population `n` was, per `stateDenominator` (D2): three states are shares
 * of `declared`, and `not_declared` is a share of the type's total instead. Naming it rather than
 * leaving a reader to divide `count` by `declared_entries` themselves is what makes the two forms
 * (this row's `count`/`declared_entries` and its own `proportion.n`) impossible to reconcile wrongly.
 *
 * Only `field`, `value` and the fields above are populated -- `type`, `distinct` and `values`
 * describe the PROPERTY, not one of its states, and repeating them on all four rows would be four
 * copies of one fact next to the row that already states it once. Left absent rather than
 * duplicated, per the rule the rest of this command's rows already follow (`min`/`max`/`top` above).
 */
function propertyStateRows(property: PropertyProfile, count: number): readonly Row[] {
  const declared = declaredCount(property);

  return STATES.map((state) => {
    const n = stateDenominator(state, declared, count);
    const successes = property.states[state];
    // `wilson` insists successes <= n; that invariant is exactly what `stateDenominator` restores
    // for `not_declared` (see its own comment) and what already held for the other three states.
    const proportion: Proportion | null = wilson(successes, n);
    const denominator: Denominator = state === 'not_declared' ? 'entries' : 'declared_entries';

    return {
      field: `property.${property.name}.${state}`,
      value: renderProportion(proportion),
      name: property.name,
      state,
      count: successes,
      declared_entries: declared,
      proportion,
      denominator,
    };
  });
}

/**
 * One row per top-K value, immediately after a `top`-summarised property's state rows (`asc-5x7`,
 * decision D5). This is the row that answers the bead's own measurement: a `values` cell that
 * printed `automode-blocked 36` with nothing saying whether 36 of 564 is an estimate or an anecdote.
 *
 * **The denominator is `property.states.measured`, not `declared` and not the type's `count`.** A
 * top value is one of the MEASURED values -- `topValues` (`profile.ts`) only ever counts entries
 * that actually got a value -- so the population a top count is a share OF is the measured entries,
 * which is smaller than (or equal to) both `declared` and `count`.
 *
 * Emitted only for `summary === 'top'`; the other two summaries (`range`, `cardinality`) have no
 * `top` list to walk, and an empty `property.top` (nothing measured) naturally produces zero rows
 * here without a separate guard, the same way an empty list has always mapped to nothing.
 *
 * Follows `propertyStateRows`' own discipline: `type`, `distinct` and `values` describe the
 * property as a whole and are not repeated here.
 */
function propertyTopRows(property: PropertyProfile): readonly Row[] {
  if (property.summary !== 'top') return [];
  const measured = property.states.measured;

  return property.top.map((entry) => {
    const proportion: Proportion | null = wilson(entry.count, measured);

    return {
      field: `property.${property.name}.top.${entry.value}`,
      value: renderProportion(proportion),
      name: property.name,
      top_value: entry.value,
      count: entry.count,
      denominator: 'measured' satisfies Denominator,
      proportion,
    };
  });
}

export default class Explore extends BaseCommand {
  static override description = 'Profile an entry type: the map, before any rows.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> verification_run',
    '<%= config.bin %> <%= command.id %> skill_activation --json',
  ];

  static override args = {
    // `ignoreStdin`: the arg names a type, and oclif would otherwise take the name from stdin --
    // the failure `asc types show` carries the same guard for. See `record.ts` for the long form.
    type: Args.string({
      description: 'The entry type to profile.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    page: Flags.boolean({
      description: 'List entries instead of profiling: one page, in a stable order.',
    }),
    cursor: Flags.string({
      description: 'Resume from the cursor a previous page printed. Implies --page.',
    }),
    limit: Flags.integer({
      description: `Entries per page, or per sample. Default ${String(DEFAULT_PAGE_SIZE)}.`,
    }),
    sample: Flags.string({
      description: 'Draw a sample instead of a page, to show spread rather than order.',
      options: [...SAMPLE_MODES],
    }),
    by: Flags.string({
      description: 'The categorical property to sample by. Required by --sample stratified.',
    }),
    seed: Flags.string({
      description: 'Vary the draw. Omitted, the seed is fixed so a sample is reproducible.',
    }),
    'max-tokens': Flags.integer({
      description:
        'Fit the output to a context budget, dropping rows and reporting what it dropped.',
    }),
    dump: Flags.string({
      description:
        'Write the entries to files in <dir>, plus a manifest.json index of what is there.',
    }),
    'dry-run': Flags.boolean({
      description: 'With --dump: report the files and their sizes without writing any of them.',
    }),
    force: Flags.boolean({
      description: 'With --dump: write into a directory that already has files in it.',
    }),
    select: Flags.string({
      description:
        'Comma-separated declared properties to flatten a page to (id/recorded_at/type_version ' +
        'plus these, in order). Implies --page. Refuses a name this type does not declare.',
    }),
    filter: Flags.string({
      description:
        'A SQL predicate over this type: a declared property (e.g. stage) and an envelope ' +
        'column (e.g. cwd) both compare bare. Applies to the default map, --page, --sample and ' +
        '--group-by (refused with --dump). With the default map, every number on it -- top, ' +
        'distinct, min/max, per-version tallies and both state denominators -- is recomputed ' +
        'against the filtered population. Unlike `asc annotate --scope`, which is corpus-wide ' +
        "and needs json_extract(properties_json,'$.name') for a declared property. WATCH A " +
        'BOOLEAN: it compares as the stored INTEGER, not the printed word -- "...=true" and ' +
        '"...=1" both match; "...=\'false\'" silently matches ZERO rows instead of failing, ' +
        'because it compares a string to an integer. Never quote a boolean.',
    }),
    'group-by': Flags.string({
      description:
        'One or two comma-separated declared properties to cross-tabulate instead of profiling. ' +
        'Only enum, boolean, string or ref properties qualify. Not combinable with --page, ' +
        '--cursor, --sample, --dump or --select.',
    }),
  };

  /**
   * The text this command would write, built and fitted to the budget when there is one.
   *
   * **One path, not two.** The unfitted branch below renders the very same `toOutput` the fitted one
   * does, so a change to what this command emits cannot land in one mode and miss the other. The
   * alternative -- an `if (budget) {...} else {...}` around each of the three modes -- is six places
   * that build an `Output`, and the failure it invites is silent: the budgeted output would drift
   * from the plain one and both would still look right on their own.
   *
   * A floor the budget cannot reach is a `usageError`, not a `refusal`. The caller typed the number,
   * so the world is not the thing that said no -- and the fix is always on the command line: raise
   * `--max-tokens` to the figure the message names, or narrow the scope.
   *
   * **Split from `emitBuilt` so that a mode which WRITES can fit before it commits.** The budget's
   * verdict is a precondition of a dump, not a footnote to one: computing it after the files are on
   * disk is a command that failed the caller's request and modified their filesystem anyway. Every
   * other mode builds and emits in one step, because nothing else has a side effect to order against.
   */
  private builtText<T>(
    budget: number | undefined,
    request: Omit<BudgetRequest<T>, 'maxTokens'>,
  ): string {
    if (budget === undefined) {
      return request.render(request.build(request.requested), undefined);
    }
    try {
      // The fitted text, not a re-render of it -- see `Fitted.text`.
      return fitToBudget({ ...request, maxTokens: budget }).text;
    } catch (error) {
      if (error instanceof BudgetFloorError) throw usageError(error.message);
      throw error;
    }
  }

  /** `builtText`, written. The two steps are separate only for the modes that have a disk to order against. */
  private emitBuilt<T>(
    budget: number | undefined,
    request: Omit<BudgetRequest<T>, 'maxTokens'>,
  ): void {
    this.emitText(this.builtText(budget, request));
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Explore);
    const format = this.resolveFormat(flags);
    // Read once and threaded through every direct `render(format, ...)` call below, so a budgeted
    // render (built by `fitToBudget`, outside `emit`) and a plain one cannot disagree about whether
    // `--csv-raw` was passed for this invocation.
    const csvRaw = this.csvRaw();
    const budget = this.optionalFlag(flags['max-tokens']);

    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
      throw usageError(
        `--max-tokens must be a whole number of tokens, at least 1. Got ${String(budget)}.`,
      );
    }

    // CSV is refused rather than silently trimmed, and the reason is the shape of the format. Every
    // other output has somewhere to say that rows went missing -- `--json` has the `trim` block,
    // `--table` prints a line -- and CSV has only records. A trimmed CSV and a complete CSV are the
    // same kind of file, so a consumer parsing one would read a truncated answer as the whole of it,
    // which is the "reports success wrongly" class this project refuses outright. Refusing here
    // costs a caller one flag; allowing it would cost a caller an answer they cannot tell is short.
    if (budget !== undefined && format === 'csv') {
      throw usageError(
        '--max-tokens cannot be combined with --csv: a CSV has nowhere to record that rows were ' +
          'dropped, so a consumer parsing it cannot tell a trimmed file from a complete one. Use ' +
          '--json or --table, which both state what the budget cost.',
      );
    }

    // The three drill-down flags (`asc-56k`). Parsed here, ahead of every mode below, so every
    // conflict they enter into is checked before any of dump/sample/page does its own work.
    const selectRaw = this.optionalFlag(flags.select);
    const selectNames = selectRaw === undefined ? undefined : parseSelect(selectRaw);
    const filter = this.optionalFlag(flags.filter);
    const groupByRaw = this.optionalFlag(flags['group-by']);
    const groupKeys = groupByRaw === undefined ? undefined : parseGroupBy(groupByRaw);

    if (groupKeys !== undefined && groupKeys.length > 2) {
      throw usageError(
        `--group-by takes one or two properties, comma-separated. Got ${String(groupKeys.length)}` +
          `: ${groupKeys.join(', ')}. Name one property for a single-property tally, or two for a ` +
          'contingency table between them.',
      );
    }

    // Entries vs counts -- the same kind of incomparable answer `--page` and `--dump` already
    // refuse each other over (see the "Four modes" paragraph), so it is refused here too rather
    // than resolved by picking one silently.
    if (selectNames !== undefined && groupKeys !== undefined) {
      throw usageError(
        '--select cannot be combined with --group-by: --select flattens entries into rows, and ' +
          '--group-by collapses entries into counts. Drop one of them.',
      );
    }

    // `--dump` is a third "which entries" mode, and it claims `--limit` too. Read here, ahead of the
    // paging decision below, because `--limit` implies `--page` there and in dump mode it means
    // entries per FILE -- one flag, two questions, and the caller typed it for one of them.
    const dumpDir = this.optionalFlag(flags.dump);
    const dumping = dumpDir !== undefined;
    const dryRun = this.flagValue(flags['dry-run']);
    const force = this.flagValue(flags.force);

    if (!dumping) {
      // Named rather than ignored, for the reason `--seed` is below: a caller who typed it and saw
      // no preview would conclude the flag was broken, when the truth is that it was never read.
      const stray = dryRun ? '--dry-run' : force ? '--force' : undefined;
      if (stray !== undefined) {
        throw usageError(
          `${stray} only applies to --dump. A dump decides what would be written, so it is the only ` +
            `mode with something to preview or to refuse. Add --dump <dir>, or drop ${stray}.`,
        );
      }
    } else if (
      this.flagValue(flags.page) ||
      flags.cursor !== undefined ||
      flags.sample !== undefined ||
      selectNames !== undefined ||
      groupKeys !== undefined
    ) {
      // A dump writes the whole type, as entries. A page is a window you resume, a sample is a
      // subset chosen for spread, --select is a page flattened to named columns, and --group-by
      // hands back counts rather than entries at all -- honouring any of them silently would write
      // files the caller reads as the whole corpus, the plausible-wrong-answer class, in the one
      // output that outlives the command.
      throw usageError(
        '--dump cannot be combined with --page, --cursor, --sample, --select or --group-by: a dump ' +
          'writes the whole type, in chunks of one stable order, as entries. To dump part of a ' +
          'type, narrow the type or read a page. Drop one of them.',
      );
    } else if (filter !== undefined) {
      // A dump is meant to be the complete, reproducible record of a type, read again later by
      // someone who never saw the command line that produced it. A filtered dump would be
      // indistinguishable on disk from a complete one, and its manifest has nowhere to carry the
      // predicate that thinned it -- a different reason from the combinations just above, so it is
      // its own branch rather than folded into that one message.
      throw usageError(
        '--dump cannot be combined with --filter: a dump is the whole type, and its manifest has ' +
          'nowhere to record the predicate that would have thinned it. Read a filtered page ' +
          'instead: --page --filter .... Drop --filter, or drop --dump.',
      );
    }

    const perFile = flags.limit ?? DEFAULT_PAGE_SIZE;
    if (dumping && perFile < 1) {
      throw usageError(
        `--limit is how many entries go in each dumped file, so it must be at least 1. Got ` +
          `${String(perFile)}. A dump of no entries is not a smaller dump; every file would be ` +
          'empty.',
      );
    }

    // Any of the four means the caller wants entries rather than the map. `--limit`, `--cursor`
    // and `--select` implying `--page` is what keeps the common cases to one flag while leaving
    // `--page` for "just show me some entries, default size".
    const paging =
      !dumping &&
      (this.flagValue(flags.page) ||
        flags.cursor !== undefined ||
        flags.limit !== undefined ||
        selectNames !== undefined);

    const sample = sampleMode(flags.sample);

    // A sample and a page are two different answers to "which entries", and honouring one silently
    // would produce the plausible-wrong-answer class: rows a caller reads as the window they asked
    // for. So the combination is refused rather than resolved, and it cannot be expressed by
    // accident -- `--limit` and `--select` imply `--page`, so `--sample --limit 20` or
    // `--sample --select stage` land here unless this runs ahead of that.
    if (flags.sample !== undefined) {
      if (this.flagValue(flags.page) || flags.cursor !== undefined || selectNames !== undefined) {
        throw usageError(
          '--sample cannot be combined with --page, --cursor or --select: a page (or --select, ' +
            'which flattens one) is a stable window you resume, and a sample is a subset chosen ' +
            'for spread. Drop one of them.',
        );
      }
      if (flags.seed !== undefined && flags.sample !== 'random' && flags.sample !== 'stratified') {
        throw usageError(
          `--seed does not apply to --sample ${flags.sample}: that is a deterministic choice, not ` +
            'a draw, so the same corpus always yields the same rows. Drop the seed, or use ' +
            '--sample random.',
        );
      }
    } else if (flags.by !== undefined || flags.seed !== undefined) {
      // Named rather than ignored. A caller who typed `--seed` and got the same rows every time
      // would conclude the seed was broken, when the truth is that it was never read.
      const flag = flags.by === undefined ? '--seed' : '--by';
      throw usageError(
        `${flag} only applies to --sample. Add --sample ${SAMPLE_MODES.join('|')}, or drop ${flag}.`,
      );
    }

    // `--group-by` answers a different question -- counts over entries, not entries -- so it is
    // refused alongside every one of the other "which entries" flags rather than merged with any
    // of them (the "Four modes" paragraph above; `--dump` is already refused earlier, since it
    // exits this function before reaching here).
    if (groupKeys !== undefined && (paging || sample !== undefined)) {
      const other = paging ? '--page (or --cursor/--limit/--select, which imply it)' : '--sample';
      throw usageError(
        `--group-by cannot be combined with ${other}: --group-by hands back counts, not entries. ` +
          'Drop one of them.',
      );
    }

    await this.withProject(({ store }) => {
      // A name nobody registered is a mistyped name or the wrong project, and the fix differs
      // from "you have recorded nothing" -- which is a real profile of zeros, and a real page of
      // zero rows. So both modes refuse rather than answering with emptiness.
      //
      // ONE refusal, two checks, and the checks differ on purpose. `profileType` answers the same
      // question, but only after it has built the whole map, so the paging mode -- which discards
      // the map -- asks `findType` instead. Measured on the real corpus, the largest type:
      // `profileType` **7.4 ms** against `findType`'s **26 us**, so asking the profiler to answer
      // a boolean would cost 280x for an answer it throws away.
      const noSuchType = (): Error =>
        refusal(
          `There is no entry type named '${args.type}' in this project. ${knownNames(store)}`,
        );

      // `typeFilterScope` (used inside `pageEntries`, `groupEntries`, and directly below for
      // `--sample`) throws a `PredicateError` naming what is wrong with the STATEMENT it built,
      // with no idea the fragment came from `--filter`. This is the one place that context is
      // added, so every one of those three call sites converts the identical way.
      const filterUsageError = (error: PredicateError): Error =>
        usageError(`--filter ${JSON.stringify(filter)} is not usable: ${error.message}`);

      // Dump mode. The entries go to disk and the INDEX comes back on stdout, so a caller -- or a
      // scheduler handing work to parallel subagents -- can pick files without having read a byte
      // of any of them.
      if (dumping) {
        if (findType(store.db, args.type) === undefined) throw noSuchType();

        // The ids first, in the page order, then hydrated a chunk at a time. Hydrating all of them
        // up front would pull every `evidence_text` of the type into memory at once, which is what
        // `entryIds` returns ids rather than entries to avoid.
        const ids = entryIds(store.db, args.type);
        const chunks: DumpChunk[] = [];
        for (let start = 0; start < ids.length; start += perFile) {
          const entries: RecordedEntry[] = [];
          for (const id of ids.slice(start, start + perFile)) {
            const entry = findEntry(store.db, id);
            // The id came from this same table a moment ago, so a miss means the table changed
            // underneath the read. Nothing has been written at this point, which is why the message
            // can promise that.
            if (entry === undefined) {
              throw refusal(
                `entry '${id}' was listed for the dump but is no longer in the store, so the dump ` +
                  'was stopped before it wrote anything. Run it again.',
              );
            }
            entries.push(entry);
          }
          chunks.push({ entries });
        }

        // Everything is built and measured BEFORE anything is written, so `--dry-run` and a real
        // dump report the same numbers, and a failure to plan cannot leave a half-written directory.
        const plan = planDump(chunks, { type: args.type, order: CURSOR_ORDER });
        const target = resolve(process.cwd(), dumpDir);
        const rows = plan.manifest.files.map((file) => dumpFileRow(file, dryRun));

        // Every refusal this mode has happens before the first write, and the budget is one of them.
        // Fitting after the files were on disk was the first version of this, and driving it showed
        // what that costs: `--dump <dir> --max-tokens 1` exited 2 with a message about the budget and
        // left a complete five-file dump behind it. The caller asked a question the command declined
        // to answer, and their filesystem changed anyway -- the same defect class as reporting success
        // wrongly, one step further out. The text is built here and written below.
        const text = this.builtText(budget, {
          requested: rows.length,
          // Zero for an empty dump, one otherwise -- and the difference is the message, not the fit.
          // A floor above what the output holds changes nothing about what is emitted (slicing an
          // empty row list gives an empty row list at any floor), which was measured by mutating
          // this line to a bare `1` and re-running against the corpus: the output was identical
          // `dropped: 0` at a workable budget. What moved was the REFUSAL, which names the floor --
          // "the smallest possible one in this output format -- **1 file** -- is about 195 tokens"
          // for a type with no files at all, when the truth is 0 files and 86 tokens. A refusal that
          // overstates what exists is the same class of claim as a report that does, and it is read
          // by someone deciding whether to trust the flag.
          floor: rows.length === 0 ? 0 : 1,
          build: (keep) => rows.slice(0, keep),
          rowsOf: (kept) => kept.length,
          keysOf: (kept) => kept.map((row) => String(row['file'])),
          noun: ['file', 'files'],
          render: (kept, trim) =>
            render(
              format,
              {
                columns: ['file', 'count', 'tokens', 'recorded_at_min', 'recorded_at_max'],
                rows: kept,
                // The same guard the map carries, and it was found the same way -- by driving this
                // against the real corpus rather than by reading it. Without it the coverage block
                // defaults to `complete(kept)`, so `--dump --max-tokens 500` printed **"showing 4 of
                // 4"** beside a trim block saying it had dropped 9 rows. A consumer reading
                // `coverage` alone -- which is what the field is for -- concludes the dump holds four
                // files. That is the "reports success wrongly" class, in the one output whose whole
                // job is to say what exists on disk.
                ...(trim === undefined || trim.dropped === 0
                  ? {}
                  : { coverage: subset(kept.length, rows.length, true) }),
                ...(trim === undefined ? {} : { trim }),
              },
              csvRaw,
            ),
        });

        if (dryRun) {
          // Verbatim the string `record.ts` and `init.ts` use, and the same reason: stdout carries
          // `dry_run: true` on every row for a machine, and this is the line for a person.
          this.warn('dry run: nothing was written.');
        } else {
          const occupied = contentsOf(target) ?? [];
          const written = new Set(plan.files.map((file) => file.name));
          if (occupied.length > 0 && !force) {
            throw usageError(
              `${target} already holds ${String(occupied.length)} ` +
                `${occupied.length === 1 ? 'file' : 'files'}, so a dump written there would sit ` +
                `beside them and nothing would say which files were this dump's. Pass --force to ` +
                'overwrite the names this dump writes, or dump into an empty directory.',
            );
          }

          // `--force` overwrites the names it writes and touches nothing else, so a LARGER previous
          // dump leaves its extra files behind -- and someone globbing the directory would read them
          // as part of this one. Naming them is the difference between a limitation and a trap: the
          // manifest lists exactly what belongs to this dump, and a person who never opens it has no
          // other way to know. Measured on a five-entry type: dump at `--limit 1` (five files), then
          // re-dump at `--limit 5 --force`, and four stale files survive beside a one-file dump.
          const stale = occupied.filter((name) => name !== MANIFEST_NAME && !written.has(name));
          if (stale.length > 0) {
            this.warn(
              `${target} holds ${String(stale.length)} ` +
                `${stale.length === 1 ? 'file' : 'files'} this dump does not write, so ` +
                `${stale.length === 1 ? 'it was' : 'they were'} left alone and ` +
                `${stale.length === 1 ? 'is' : 'are'} not part of it: ${stale.join(', ')}. ` +
                `${MANIFEST_NAME} lists the files this dump wrote, and is the authority on what ` +
                'belongs to it.',
            );
          }

          mkdirSync(target, { recursive: true });
          for (const file of plan.files) {
            writeFileSync(join(target, file.name), file.text);
          }
          // LAST, deliberately. A crash between here and the files above leaves a directory with
          // data in it and no index -- a caller sees nothing to read. Writing the index first would
          // leave the opposite: an index naming files that were never written, which is the
          // "reports success wrongly" class and the one failure of this feature that a reader
          // cannot detect for themselves.
          writeFileSync(join(target, MANIFEST_NAME), plan.manifestText);
        }

        // The budget fits the INDEX, and cannot touch the disk. That ordering is load-bearing: a
        // trimmed stdout is honest (it carries `trim` and names the files it withheld) while a
        // truncated manifest ON DISK would be a permanent lie about what the directory holds, read
        // later by someone with no way to tell. Every file and the whole manifest are complete
        // regardless of what this line writes.
        this.emitText(text);
        return;
      }

      // Group-by mode. A contingency table over one or two declared properties -- a different
      // question from every mode above, so it hands back counts, never a `Row` built from an
      // entry (`explore-group.ts`, `asc-56k`).
      if (groupKeys !== undefined) {
        if (findType(store.db, args.type) === undefined) throw noSuchType();

        // `groupEntries` validates the keys itself against this type's registered versions --
        // `UnknownGroupKeyError` and `UngroupablePropertyError` already carry complete,
        // caller-facing messages naming the property, its declared type and a fix, so they are
        // surfaced as `refusal`s rather than re-derived: the world (this type's own definition)
        // is what says no, the identical reasoning `resolveSelect` gives for the same shape of
        // question (`explore-select.ts`).
        const result: GroupResult = (() => {
          try {
            return groupEntries(store.db, {
              type: args.type,
              keys: groupKeys,
              ...(filter === undefined ? {} : { filter }),
            });
          } catch (error) {
            if (
              error instanceof UnknownGroupKeyError ||
              error instanceof UngroupablePropertyError
            ) {
              throw refusal(error.message);
            }
            if (error instanceof PredicateError) throw filterUsageError(error);
            throw error;
          }
        })();

        const { columns, rows } = buildGroupOutput(result, groupKeys, filter !== undefined);

        this.emitBuilt(budget, {
          requested: rows.length,
          // The header rows state what the table IS (the population, and each axis's shape); a
          // budget that cannot afford them cannot afford a crosstab at all.
          floor: headerRowCount(result, groupKeys, filter !== undefined),
          build: (keep) => rows.slice(0, keep),
          rowsOf: (kept) => kept.length,
          keysOf: (kept) => kept.map((row) => rowKey(row, groupKeys)),
          noun: ['row', 'rows'],
          render: (kept, trim) =>
            render(
              format,
              {
                columns,
                rows: kept,
                // `covered < total` exactly when a key's distinct values exceeded `topK` and the
                // remainder was withheld -- entries that exist and are not represented by any cell
                // shown, the same "more out there, not on screen" fact `has_more` names elsewhere.
                ...(result.covered < result.total
                  ? { coverage: subset(result.covered, result.total, true) }
                  : {}),
                ...(trim === undefined ? {} : { trim }),
              },
              csvRaw,
            ),
        });
        return;
      }

      // Sample mode. A sample is a subset of a population whose MEMBERSHIP is a function of a
      // parameter the reader cannot see, so it states both the share and the choice -- the same
      // argument as the coverage line, one step further.
      //
      // The projection is read first and the rows are hydrated after, rather than the other way
      // round: choosing needs every entry's categorical identity and none of their documents, and
      // hydrating first would pull a whole type's `evidence_text` into memory to select forty of
      // them. It also means the sampler's input never held prose, which is the same rule the spike
      // reader states for the corpus.
      if (sample !== undefined) {
        const profile = profileType(store.db, args.type);
        if (profile === undefined) throw noSuchType();

        const request: SampleRequest = {
          mode: sample,
          size: flags.limit ?? DEFAULT_PAGE_SIZE,
          ...(flags.by === undefined ? {} : { by: flags.by }),
          ...(flags.seed === undefined ? {} : { seed: flags.seed }),
        };

        const resolved = resolveSample(profile, request);

        // Read ONCE, outside `build`: the projection is a function of the type and the properties
        // chosen, not of the sample size, and a budget makes this command build the sample several
        // times over. Re-reading per candidate would repeat a scan of the whole type for an answer
        // that cannot have changed.
        const projected = signatures(store.db, args.type, resolved.properties);

        // `signatures` has no `filter` of its own (unlike `pageEntries` and `groupEntries`), so a
        // filtered sample is resolved client-side: `typeFilterScope` runs the same bare-column
        // projection and single-statement guard those two use internally, scoped to `args.type`,
        // and the id set it returns is intersected with the type's own projection. `entries` below
        // is intentionally the FILTERED population, not `projected`: sampling and every proportion
        // this mode reports must be computed over what the caller actually asked to draw from.
        const entries =
          filter === undefined
            ? projected
            : (() => {
                let matched: readonly { readonly id: string }[];
                try {
                  matched = store.db
                    .prepare(typeFilterScope(store.db, args.type, filter))
                    .all() as unknown as { id: string }[];
                } catch (error) {
                  if (error instanceof PredicateError) throw filterUsageError(error);
                  throw error;
                }
                const allowed = new Set(matched.map((row) => row.id));
                return projected.filter((entry) => allowed.has(entry.id));
              })();

        // Rebuilt for each candidate size rather than truncated from the full draw, and that is the
        // design rather than an implementation detail. A stratified sample of 40 cut to 25 is not a
        // stratified sample of 25 -- the allocation that produced it was computed for 40, so the
        // proportions in the report would describe a draw that no longer exists. Asking the sampler
        // for 25 gives a real 25-row sample, and the report that comes with it is true of the rows
        // on stdout.
        const build = (
          size: number,
        ): { readonly rows: readonly Row[]; readonly sample: SampleReport } => {
          const chosen = chooseSample(entries, resolved, { ...request, size });

          // Hydrated in the sample's own order, so the rows a reader sees are in the order the
          // sampler reported rather than in whatever order a second query returned them.
          const rows: Row[] = [];
          for (const id of chosen.ids) {
            const entry = findEntry(store.db, id);
            if (entry === undefined) continue;
            rows.push(entryRow(entry));
          }
          return { rows, sample: chosen.sample };
        };

        this.emitBuilt(budget, {
          requested: request.size,
          // One row is the smallest sample the sampler accepts (`SampleSizeError` below that), and a
          // sample of zero would say nothing about the population while still costing a report.
          floor: 1,
          build,
          rowsOf: (built) => built.rows.length,
          noun: ['entry', 'entries'],
          render: (built, trim) =>
            render(
              format,
              {
                columns: ['id', 'recorded_at', 'type_version', 'properties', 'evidence_text'],
                rows: built.rows,
                // A sample has no remainder to resume, so `has_more` is false however small the share
                // -- there is no cursor to hand back, and saying "more" would promise one.
                // `entries.length`, not `profile.count`: with --filter, the population a sample is
                // drawn FROM is the filtered one, and reporting the type's unfiltered total here
                // would describe a sample of a population it was never drawn from.
                coverage: subset(built.rows.length, entries.length, false),
                sample: built.sample,
                // `entries.length`/`projected.length`: the population the sample was drawn FROM,
                // before and after `--filter` -- the same two numbers `--page` states from
                // `PageResult.unfiltered`, computed locally because `signatures` (unlike
                // `pageEntries`) has no filter of its own (see above).
                ...(filter === undefined
                  ? {}
                  : { filter: { matched: entries.length, unfiltered: projected.length } }),
                ...(trim === undefined ? {} : { trim }),
              },
              csvRaw,
            ),
        });
        return;
      }

      // Entry mode. A page of rows is the one output this command emits that is a SUBSET of a
      // population, so it is the one that has to state its coverage rather than let `emit`
      // default it to "complete".
      if (paging) {
        // `--select` needs every registered version's declared properties (to validate names and
        // to look up each entry's OWN version's declared type), which is `profileType`'s job, not
        // `findType`'s -- the 280x-cheaper check above is for the common case that does not need
        // it. Without `--select`, this stays the cheap `findType` check it always was.
        let columns: readonly string[] = [
          'id',
          'recorded_at',
          'type_version',
          'properties',
          'evidence_text',
        ];
        let rowsOf: (entries: readonly RecordedEntry[]) => readonly Row[] = (entries) =>
          entries.map(entryRow);

        if (selectNames !== undefined) {
          const profile = profileType(store.db, args.type);
          if (profile === undefined) throw noSuchType();
          resolveSelect(profile, selectNames);
          const propertyType = makeVersionTypeCache(store.db, args.type);
          columns = selectColumns(selectNames);
          rowsOf = (entries) => selectRows(store.db, args.type, entries, selectNames, propertyType);
        } else if (findType(store.db, args.type) === undefined) {
          throw noSuchType();
        }

        const ask = {
          type: args.type,
          ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
          ...(filter === undefined ? {} : { filter }),
        };

        // A TRIMMED PAGE RE-QUERIES AT THE SMALLER LIMIT; IT DOES NOT SLICE. Slicing would leave the
        // page's `next_cursor` pointing past the rows that were cut, so every row between the last
        // one shown and the cursor would be skipped by every caller that followed it -- a hole in
        // the corpus, in the one output whose contract is that it tells you what it did not show.
        // Asking the store for fewer rows makes it compute the cursor for the boundary actually on
        // screen, which costs one query per search step and cannot be wrong.
        const build = (limit: number): PageResult => {
          try {
            return pageEntries(store.db, { ...ask, limit });
          } catch (error) {
            if (error instanceof PredicateError) throw filterUsageError(error);
            throw error;
          }
        };

        this.emitBuilt(budget, {
          requested: flags.limit ?? DEFAULT_PAGE_SIZE,
          // Pages cannot be empty: `pageEntries` refuses a limit below one with a `PageSizeError`,
          // so a budget too small for a single entry has no legal page to fall back to.
          floor: 1,
          build,
          rowsOf: (page) => page.rows.length,
          keysOf: (page) => page.rows.map((row) => row.id),
          noun: ['entry', 'entries'],
          render: (page, trim) =>
            render(
              format,
              {
                columns,
                rows: rowsOf(page.rows),
                coverage: subset(page.rows.length, page.total, page.hasMore),
                ...(page.nextCursor === null ? {} : { next_cursor: page.nextCursor }),
                // `page.total`/`page.unfiltered`: a filtered `count` (or here, `coverage.total`) of
                // zero cannot say whether the filter excluded everything or the type holds nothing
                // -- `unfiltered` is the fact that tells the two apart (`PageResult.unfiltered`).
                ...(filter === undefined
                  ? {}
                  : { filter: { matched: page.total, unfiltered: page.unfiltered } }),
                ...(trim === undefined ? {} : { trim }),
              },
              csvRaw,
            ),
        });
        return;
      }

      // `profileType` throws `PredicateError` for a filter carrying a second statement -- the
      // same wrap-and-count guard `pageEntries`, `groupEntries` and the sample mode's direct
      // `typeFilterScope` call above all go through -- so it converts here the identical way.
      const profile = (() => {
        try {
          return profileType(store.db, args.type, filter === undefined ? {} : { filter });
        } catch (error) {
          if (error instanceof PredicateError) throw filterUsageError(error);
          throw error;
        }
      })();
      if (profile === undefined) throw noSuchType();

      const rows: Row[] = [
        { field: 'type', value: profile.type },
        { field: 'count', value: profile.count },
        { field: 'property_count', value: profile.properties.length },
        { field: 'version_count', value: profile.versions.length },
      ];

      // The floor: these four rows are what the map IS, and a budget that cannot afford them is a
      // budget that cannot afford a map at all -- dropping them would leave property rows with no
      // type name, no count, and no denominator, which is not a smaller answer but a different and
      // misleading one. `emitBuilt` refuses in that case rather than emitting the remainder.
      const header = rows.length;

      // Omitted entirely when there are no entries, rather than rendered as an empty range: a
      // `recorded_at_min` of `null` and a `recorded_at_min` of `''` are both fabrications
      // (`TASKS.md` #7), and the only truthful statement is that no entry exists to have one.
      if (profile.recordedAtMin !== null && profile.recordedAtMax !== null) {
        rows.push(
          { field: 'recorded_at_min', value: profile.recordedAtMin },
          { field: 'recorded_at_max', value: profile.recordedAtMax },
        );

        const eventClocks = profile.properties
          .filter((property) => property.declaredTypes.includes('timestamp'))
          .map((property) => property.name)
          .sort();
        const clockRow = recordedAtClockRow(profile.type, eventClocks);
        if (clockRow !== undefined) rows.push(clockRow);
      }

      rows.push(
        ...profile.versions.map(versionRow),
        ...profile.properties.flatMap((property) => [
          propertyRow(property, profile.count),
          ...propertyStateRows(property, profile.count),
          ...propertyTopRows(property),
        ]),
      );

      // Everything past the header is droppable, and the ORDER it is dropped in is the row order:
      // properties first -- from the end, which is where a reader is least likely to have got to --
      // and only once they are gone, the version rows. That is the cheap-to-expensive order: a
      // property the budget could not afford is one `--json` lookup away, while the counts and the
      // range are what the map was asked for.
      this.emitBuilt(budget, {
        requested: rows.length,
        floor: header,
        build: (keep) => rows.slice(0, keep),
        rowsOf: (kept) => kept.length,
        keysOf: (kept) => kept.map((row) => String(row['field'])),
        noun: ['row', 'rows'],
        render: (kept, trim) =>
          render(
            format,
            {
              columns: ['field', 'value', 'type', 'tally', 'distinct', 'values'],
              rows: kept,
              // Coverage only when something went: an untrimmed map shows every row it built, and
              // `complete` is the honest statement of that. A trimmed one is a subset of its own row
              // list, which is a fact `coverage` is exactly the right shape to carry.
              ...(trim === undefined || trim.dropped === 0
                ? {}
                : { coverage: subset(kept.length, rows.length, true) }),
              // `profile.count`/`profile.unfiltered`: the population every number on this map now
              // describes, and the population it was drawn from (`asc-qfk.1`) -- the same pair
              // `--page` states from `PageResult.unfiltered` and `--sample` states locally, for the
              // identical reason (`TypeProfile.unfiltered`'s own comment).
              ...(filter === undefined
                ? {}
                : { filter: { matched: profile.count, unfiltered: profile.unfiltered } }),
              ...(trim === undefined ? {} : { trim }),
            },
            csvRaw,
          ),
      });
    });
  }
}
