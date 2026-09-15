/**
 * `asc explore <type>` -- the map, before any rows.
 *
 * **The default output is a MAP, not a page of entries.** Handed rows, a reader looks at row 1 and
 * generalises; handed a profile, it chooses what to look at. So this prints counts, ranges,
 * cardinalities and per-property state tallies, and never an entry -- which also means a profile of
 * a corpus full of prose puts none of that prose into a caller's context. The drill-down flags
 * (`--select`, `--filter`, `--sample`, `--page`, `--max-tokens`, `--dump`) are separate work and
 * land on this command; see beads `asc-56k`, `asc-wsa`, `asc-52u`, `asc-hg3`.
 *
 * **Rows, and one column set for all of them.** Header facts (`count`, the `recorded_at` range,
 * one row per registered version), then one row per declared property. The property rows carry the
 * tally and the summary in columns of their own; the table renders a line and `--json` carries the
 * structure, from one build of the data rather than two that could disagree (`output.ts`:
 * `columns` is a view of the rows, not a definition of them).
 *
 * **A property's state ratios are over the entries that DECLARED it**, not over the type's total.
 * `measured 51 (58.6%)` is a share of the 87 entries whose registered version declared that
 * property; entries recorded before the property existed are excluded, because the question was not
 * askable of them. So `declared_entries` on the row is NOT `count`, and both are reported -- a
 * ratio against the type's total would report a property as 50% measured when every entry that
 * could have measured it did.
 *
 * **What is absent is absent, never zero.** `min`/`max` appear only for a property summarised by
 * range, `top` only for a categorical one, and `recorded_at` is omitted entirely for a type with no
 * entries. Every row carries `summary`, so an absent key is never read as "nothing there" -- it is
 * read as "this kind of property does not have that" (`TASKS.md` #7).
 *
 * **The table truncates the tally, and that is a stated limitation rather than a hidden one.** The
 * full line runs 92 characters at the corpus's own numbers --
 * `measured 51 (58.6%), not_applicable 0 (0.0%), not_measured 36 (41.4%), not_declared 0 (0.0%)` --
 * and `renderTable` elides every cell past its shared 60-character limit, so the default view cuts
 * after `not_measured ` and the `…` marks it. No reformatting closes the gap: the four state NAMES
 * are 55 of those 92 characters, and naming every state is what the line is for. `--json` and
 * `--csv` do not truncate, so the exact counts are one flag away, and the `…` is the signal to ask
 * for them. Closing it properly means a layout where each state is its own row, or a wider cell for
 * this command -- both change the shape `asc-wsa`, `asc-52u` and `asc-hg3` build on, so neither is
 * this bead's call.
 */

import { Args } from '@oclif/core';
import {
  profileType,
  type PropertyProfile,
  type StateCounts,
  type VersionProfile,
} from '@ascend/store';
import { BaseCommand } from '../base.js';
import { refusal } from '../errors.js';
import { knownNames } from '../register-document.js';
import type { Row } from '../output.js';

/** The state names, in the order they are rendered and counted. */
const STATES = ['measured', 'not_applicable', 'not_measured', 'not_declared'] as const;

/**
 * The tally as one line: every state named, with its share of the entries that declared the
 * property.
 *
 * **Every state is named, including the ones at zero.** `not_applicable 0` is not noise -- for a
 * derived corpus it is the finding, and dropping the empty states from a rendering whose JSON
 * counterpart states them exactly is how a reader comes to believe a corpus uses a state it never
 * uses (`EV-baseline.md`, decision 2).
 *
 * The denominator is the declared count rather than the type's total, for the reason in the file
 * comment. A declared count of zero is a type with no entries at all, where a share would be a
 * division by it, so the bare count is rendered instead.
 */
function renderStates(counts: StateCounts, declared: number): string {
  const share = (n: number): string =>
    declared === 0 ? String(n) : `${String(n)} (${((n / declared) * 100).toFixed(1)}%)`;

  return STATES.map((state) => `${state} ${share(counts[state])}`).join(', ');
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
 * One property row.
 *
 * `min`, `max` and `top` are attached CONDITIONALLY, and that is the whole reason this is a
 * function rather than an object literal: a `min: null` on a categorical property would be
 * indistinguishable from "nothing was measured", which is a different and wrong claim. `summary`
 * is always present, so the reader can tell which keys to expect.
 */
function propertyRow(property: PropertyProfile): Row {
  const declared =
    property.states.measured + property.states.not_applicable + property.states.not_measured;

  return {
    field: `property.${property.name}`,
    // The rendered type is a display: two versions may declare one name with different types, and
    // both are named rather than one being chosen.
    type: property.declaredTypes.join(' | '),
    tally: renderStates(property.states, declared),
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

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Explore);
    const format = this.resolveFormat(flags);

    await this.withProject(({ store }) => {
      const profile = profileType(store.db, args.type);

      if (profile === undefined) {
        // A name nobody registered is a mistyped name or the wrong project, and the fix differs
        // from "you have recorded nothing" -- which is a real profile of zeros, returned above.
        // This is the whole reason `profileType` answers `undefined` instead of an empty map.
        throw refusal(
          `There is no entry type named '${args.type}' in this project. ${knownNames(store)}`,
        );
      }

      const rows: Row[] = [
        { field: 'type', value: profile.type },
        { field: 'count', value: profile.count },
        { field: 'property_count', value: profile.properties.length },
        { field: 'version_count', value: profile.versions.length },
      ];

      // Omitted entirely when there are no entries, rather than rendered as an empty range: a
      // `recorded_at_min` of `null` and a `recorded_at_min` of `''` are both fabrications
      // (`TASKS.md` #7), and the only truthful statement is that no entry exists to have one.
      if (profile.recordedAtMin !== null && profile.recordedAtMax !== null) {
        rows.push(
          { field: 'recorded_at_min', value: profile.recordedAtMin },
          { field: 'recorded_at_max', value: profile.recordedAtMax },
        );
      }

      rows.push(...profile.versions.map(versionRow), ...profile.properties.map(propertyRow));

      this.emit(format, {
        columns: ['field', 'value', 'type', 'tally', 'distinct', 'values'],
        rows,
      });
    });
  }
}
