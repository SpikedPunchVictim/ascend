/**
 * `asc handlers compare <file.yaml...> --at <time>` -- what each handler's outcome was before a
 * change and after it, over the replayed log (asc-jwm7).
 *
 * The change is a moment: a rule installed, a skill edited, a hook turned on. Each handler is
 * replayed once, and its triggered units -- compaction segments, the holdout unit asc-6ola.4
 * settled -- are split at that moment. The arithmetic and its caveats are `handler-compare.ts`'s;
 * this prints them.
 *
 * **`design` says which comparison the numbers are, and there are two of them.** With no holdout
 * running the change was not assigned at random, so the result is observational: a count moved, not
 * that the change moved it. When the hook's own decisions (`exposure-log.ts`) name the units of the
 * after arm, that arm is split into the units it was shown to and the units it was held back from,
 * and `difference` becomes that contrast -- which IS assigned at random, and so estimates the
 * guidance's effect. The two are one row apart in the output and this command never prints one
 * without the other.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { MIN_N } from '@ascend/analysis';
import { BaseCommand } from '../../base.js';
import { usageError } from '../../errors.js';
import { readDecided } from '../../exposure-log.js';
import { armAssignments, compareArms, type Arm, type Comparison } from '../../handler-compare.js';
import { replayHandlers } from '../../handler-replay.js';
import { findProjectRoot, storePaths } from '../../project.js';
import {
  checkReplayScope,
  describeProportion,
  FIELD,
  HANDLER,
  load,
  logRows,
  REPLAY_FLAGS,
  replayScope,
  round,
  VALUE,
  type Row,
} from '../../handler-scope.js';

/**
 * The design every comparison has with nothing held out. Printed as a row, not left to the docs, so
 * a number copied out of this output carries it.
 */
const OBSERVATIONAL =
  'observational -- the change was not assigned at random, so a difference is a correlation, ' +
  'not the change’s effect';

/**
 * The design a comparison has once the hook's decisions name the arms of the after arm.
 *
 * It says what makes the number mean something rather than who computed it: the assignment is a
 * hash of the unit, so it cannot depend on what the unit went on to do, and that is the whole of
 * the argument. It does not claim the arms are otherwise alike -- a segment inheriting a summary
 * that already mentions the guidance is exposed, whatever its arm says -- and it does not claim the
 * live arm is correct, which is a measurement nobody has taken.
 */
const CONTROLLED =
  'controlled -- the after arm is split by the arm the hook assigned, which is a hash of the unit ' +
  'and so cannot follow what the unit did: delivered against held out estimates the guidance’s ' +
  'effect, where before against after could only ever be a correlation';

export default class HandlersCompare extends BaseCommand {
  static override description =
    'Replay handlers over Claude Code transcripts and compare, per handler, the share of ' +
    'compaction segments whose triggers produced a row before a change and after it. Where the ' +
    'holdout has assigned arms, each handler’s after arm is split into delivered and held out. ' +
    'Writes nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> handlers/edit-unverified.yaml --at 2026-09-20T00:00:00Z',
    '<%= config.bin %> <%= command.id %> a.yaml --at 2026-09-20 --all-projects --json',
  ];

  static override strict = false;

  static override args = {
    file: Args.string({
      description: 'A handler file. Pass several to compare them over the log together.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    at: Flags.string({
      description:
        'When the change was made, as an ISO 8601 date or time. A segment that ended before it ' +
        'is in the before arm; one that started at or after it is in the after arm.',
      required: true,
    }),
    ...REPLAY_FLAGS,
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(HandlersCompare);
    const format = this.resolveFormat(flags);
    const at = isoInstant(flags.at);
    const scope = replayScope({
      root: this.optionalFlag(flags.root),
      project: this.optionalFlag(flags.project),
      'all-projects': flags['all-projects'],
      'include-ephemeral': flags['include-ephemeral'],
    });
    const handlers = (argv as string[]).map(load);
    checkReplayScope(scope);

    // The project's own decisions, which is to say the project this command is being run in. A
    // decision names a session, and a session belongs to one project, so a decision about another
    // project's transcript names a unit this replay never saw and joins to nothing. That is the
    // safe way round: the mistake a wrong log could make is silence, never a wrong arm.
    const root = findProjectRoot(resolve(process.cwd()));
    const decided = root === undefined ? [] : readDecided(storePaths(root).tree);

    const result = await replayHandlers(handlers, scope);
    const rows: Row[] = logRows(scope.projects, result);
    for (const replay of result.handlers) {
      const add = (field: string, value: unknown): void => {
        rows.push({ [HANDLER]: replay.name, [FIELD]: field, [VALUE]: value });
      };
      const intervention = { id: replay.name, version: replay.handler.hash };
      const comparison = compareArms(
        replay.units,
        result.units,
        at,
        armAssignments(decided, intervention),
      );
      const split = comparison.controlled;
      add('hash', replay.handler.hash);
      add('at', at);
      add('unit', 'compaction segment');
      add('outcome', 'a trigger in the segment produced a row');
      add('design', split === undefined ? OBSERVATIONAL : CONTROLLED);
      armRows('before', comparison.before, add);
      armRows('after', comparison.after, add);
      if (split !== undefined) {
        armRows('after.delivered', split.delivered, add);
        armRows('after.held_out', split.heldOut, add);
        add('after.unassigned', split.unassigned);
      }
      add('straddling', comparison.straddling);
      add('undated', comparison.undated);
      add('difference', difference(comparison));
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

/** The single contrast `design` names, or the sentence saying why there is none. */
function difference(comparison: Comparison): number | string {
  if (comparison.difference !== undefined) return round(comparison.difference);
  return comparison.controlled === undefined
    ? `not estimated -- an arm has fewer than ${String(MIN_N)} units, and a difference between ` +
        'anecdotes is no estimate'
    : `not estimated -- the delivered or held-out arm has fewer than ${String(MIN_N)} units, and a ` +
        'difference between anecdotes is no estimate';
}

function armRows(name: string, arm: Arm, add: (field: string, value: unknown) => void): void {
  add(`${name}.units`, arm.units);
  add(`${name}.with_row`, arm.withRow);
  add(`${name}.triggers`, arm.triggers);
  add(`${name}.rows`, arm.rows);
  add(`${name}.proportion`, describeProportion(arm.proportion));
}

/** One cell per arm, so the interval and the small-group flag cannot be separated from `p`. */

/**
 * `value` as the ISO instant event timestamps are compared with. A date alone means its midnight
 * UTC, as `Date` reads it. Refused rather than guessed when it does not parse.
 */
function isoInstant(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw usageError(`--at ${value} is not an ISO 8601 date or time.`);
  }
  return new Date(time).toISOString();
}
