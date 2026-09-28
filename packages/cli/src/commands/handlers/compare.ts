/**
 * `asc handlers compare <file.yaml...> --at <time>` -- what each handler's outcome was before a
 * change and after it, over the replayed log (asc-jwm7).
 *
 * The change is a moment: a rule installed, a skill edited, a hook turned on. Each handler is
 * replayed once, and its triggered units -- compaction segments, the holdout unit asc-6ola.4
 * settled -- are split at that moment. The arithmetic and its caveats are `handler-compare.ts`'s;
 * this prints them, and prints `design: observational` beside every comparison, because a
 * before/after over history the user chose to make shows that a count moved, not that the change
 * moved it.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { Args, Flags } from '@oclif/core';
import { MIN_N, type Proportion } from '@ascend/analysis';
import { BaseCommand } from '../../base.js';
import { usageError } from '../../errors.js';
import { compareArms, type Arm } from '../../handler-compare.js';
import { replayHandlers } from '../../handler-replay.js';
import {
  checkReplayScope,
  FIELD,
  HANDLER,
  load,
  logRows,
  REPLAY_FLAGS,
  replayScope,
  VALUE,
  type Row,
} from '../../handler-scope.js';

/**
 * The design every comparison here has, until something assigns a controlled arm. Printed as a
 * row, not left to the docs, so a number copied out of this output carries it.
 */
const OBSERVATIONAL =
  'observational -- the change was not assigned at random, so a difference is a correlation, ' +
  'not the change’s effect';

export default class HandlersCompare extends BaseCommand {
  static override description =
    'Replay handlers over Claude Code transcripts and compare, per handler, the share of ' +
    'compaction segments whose triggers produced a row before a change and after it. Writes ' +
    'nothing.';

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

    const result = await replayHandlers(handlers, scope);
    const rows: Row[] = logRows(scope.projects, result);
    for (const replay of result.handlers) {
      const add = (field: string, value: unknown): void => {
        rows.push({ [HANDLER]: replay.name, [FIELD]: field, [VALUE]: value });
      };
      const comparison = compareArms(replay.units, result.units, at);
      add('hash', replay.handler.hash);
      add('at', at);
      add('unit', 'compaction segment');
      add('outcome', 'a trigger in the segment produced a row');
      add('design', OBSERVATIONAL);
      armRows('before', comparison.before, add);
      armRows('after', comparison.after, add);
      add('straddling', comparison.straddling);
      add('undated', comparison.undated);
      if (comparison.difference === undefined) {
        add(
          'difference',
          `not estimated -- an arm has fewer than ${String(MIN_N)} units, and a difference ` +
            'between anecdotes is no estimate',
        );
      } else {
        add('difference', round(comparison.difference));
      }
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

function armRows(name: string, arm: Arm, add: (field: string, value: unknown) => void): void {
  add(`${name}.units`, arm.units);
  add(`${name}.with_row`, arm.withRow);
  add(`${name}.triggers`, arm.triggers);
  add(`${name}.rows`, arm.rows);
  add(`${name}.proportion`, describe(arm.proportion));
}

/** One cell per arm, so the interval and the small-group flag cannot be separated from `p`. */
function describe(proportion: Proportion | null): string {
  if (proportion === null) return 'no units -- no estimate';
  const text =
    `${String(round(proportion.p))} ` +
    `[${String(round(proportion.lower))}, ${String(round(proportion.upper))}] ` +
    `${String(proportion.confidence * 100)}% Wilson`;
  return proportion.smallGroup
    ? `${text} (n=${String(proportion.n)} < ${String(MIN_N)}: anecdote)`
    : text;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

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
