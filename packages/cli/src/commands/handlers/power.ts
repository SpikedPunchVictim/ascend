/**
 * `asc handlers power <file.yaml...> --effect <fraction>` -- how long each handler's experiment has
 * to run before its answer means anything, and whether the units on hand can get there (asc-6ola.3).
 *
 * The arithmetic and the sentences live in `../../handler-power.js`, because `handlers/grade.ts`
 * plans the handler an intervention row names with the same code. What is here is the command shell:
 * the flags, the replay, and the row sink that labels each row with the handler it came from.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base.js';
import { usageError } from '../../errors.js';
import { HORIZON_DAYS, plan } from '../../handler-power.js';
import { parseHoldoutFraction } from '../../holdout.js';
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

export default class HandlersPower extends BaseCommand {
  static override description =
    'Replay handlers over Claude Code transcripts and report, per handler, the base rate, the units ' +
    'per active day and the design effect, then how many days an experiment needs to detect a given ' +
    'relative reduction -- and whether the units on hand can reach it. Writes nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> handlers/edit-unverified.yaml --effect 0.5',
    '<%= config.bin %> <%= command.id %> a.yaml --effect 0.3 --holdout 0.2 --horizon 30 --json',
  ];

  static override strict = false;

  static override args = {
    file: Args.string({
      description: 'A handler file. Pass several to plan them over the log together.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    effect: Flags.string({
      description:
        'The RELATIVE reduction to plan for, as a fraction between 0 and 1. 0.5 asks how long it ' +
        'takes to detect a halving of the outcome rate.',
      required: true,
    }),
    holdout: Flags.string({
      description:
        'The share of units held back, between 0 and 1. Defaults to 0.5, the cheapest split.',
      default: '0.5',
    }),
    horizon: Flags.integer({
      description: `The horizon to judge against, in active days. Defaults to ${String(HORIZON_DAYS)}.`,
      default: HORIZON_DAYS,
    }),
    ...REPLAY_FLAGS,
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(HandlersPower);
    const format = this.resolveFormat(flags);
    const asked = {
      reduction: fraction(flags.effect, '--effect'),
      holdout: fraction(flags.holdout, '--holdout'),
      horizon: flags.horizon,
    };
    if (asked.horizon <= 0) {
      throw usageError(
        `--horizon takes a positive number of active days; got ${String(asked.horizon)}.`,
      );
    }
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
      plan(replay, result.units, asked, add);
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}

/** A `--effect`/`--holdout` value as a fraction, or a usage error naming the flag it came from. */
function fraction(raw: string, flag: string): number {
  const parsed = parseHoldoutFraction(raw, flag);
  if (typeof parsed === 'string') throw usageError(parsed);
  return parsed;
}
