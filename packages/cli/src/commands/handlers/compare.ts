/**
 * `asc handlers compare <file.yaml...> --at <time>` -- what each handler's outcome was before a
 * change and after it, over the replayed log (asc-jwm7).
 *
 * The change is a moment: a rule installed, a skill edited, a hook turned on. Each handler is
 * replayed once, and its triggered units -- compaction segments, the holdout unit asc-6ola.4
 * settled -- are split at that moment. The arithmetic is `handler-compare.ts`'s; the sentences are
 * `handler-compare-rows.ts`'s, because `handlers/grade.ts` prints the same ones for the handler an
 * intervention row names. What is here is the command shell: the flags, the replay, the holdout's
 * own decisions, and the row sink that labels each row with the handler it came from.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base.js';
import { readDecided } from '../../exposure-log.js';
import { armAssignments, compareArms, exposedUnits } from '../../handler-compare.js';
import { compareRows, isoInstant } from '../../handler-compare-rows.js';
import { replayHandlers } from '../../handler-replay.js';
import { findProjectRoot, storePaths } from '../../project.js';
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
      const assignments = armAssignments(decided, intervention);
      // What this handler actually says, taken from the rows it produced rather than re-rendered:
      // a `say:` sentence can be built from event fields, so the replay's own output is the only
      // text that is certain to be the one the hook would have delivered.
      const sentences = replay.rows.flatMap((row) => {
        const said = row.fields['say'];
        return typeof said === 'string' ? [said] : [];
      });
      const comparison = compareArms(
        replay.units,
        result.units,
        at,
        assignments,
        exposedUnits(assignments, result.opening, sentences),
      );
      add('hash', replay.handler.hash);
      compareRows(comparison, at, add);
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}
