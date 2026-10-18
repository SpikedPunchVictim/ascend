/**
 * `asc standing-costs` — what a transcript corpus pays for standing context.
 *
 * The measurement lives in `../standing-costs.ts`; this file only chooses a scope, runs one pass
 * and renders. It reads no store, like `asc handlers check` on its transcript path: a project with
 * no `.ascend/` still has transcripts, and asking what they cost should not require an index.
 */

import { Flags } from '@oclif/core';
import { BaseCommand } from '../base.js';
import { REPLAY_FLAGS, checkReplayScope, replayScope } from '../handler-scope.js';
import { measureStandingCosts, standingCostOutput } from '../standing-costs.js';

const DEFAULT_LIMIT = 20;

export default class StandingCosts extends BaseCommand {
  static override description =
    'Measure what is injected into every transcript stream, and what tools return: bytes per ' +
    'attachment source, per instruction file, per skill listing, per tool, per Bash first command, ' +
    'and per --help look-up.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> --project -Users-me-projects-app',
    '<%= config.bin %> <%= command.id %> --all-projects --limit 50 --json',
  ];

  static override flags = {
    ...REPLAY_FLAGS,
    limit: Flags.integer({
      description:
        `Rows per ranked report. The whole corpus is always measured; this only trims what is ` +
        `shown, and every report still states its population in its (groups) row. Default ${String(
          DEFAULT_LIMIT,
        )}.`,
      min: 1,
      default: DEFAULT_LIMIT,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(StandingCosts);
    const format = this.resolveFormat(flags);
    const scope = replayScope({
      root: this.optionalFlag(flags.root),
      project: this.optionalFlag(flags.project),
      'all-projects': flags['all-projects'],
      'include-ephemeral': flags['include-ephemeral'],
    });
    checkReplayScope(scope);

    const measurement = await measureStandingCosts(scope);
    this.emit(format, standingCostOutput(measurement, flags.limit));
  }
}
