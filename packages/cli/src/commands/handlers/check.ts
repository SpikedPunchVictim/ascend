/**
 * `asc handlers check <file.yaml...>` -- the dry run a handler passes before it is trusted
 * (asc-6ola.14).
 *
 * Every file is loaded strictly first; one refusal stops the command before anything is replayed,
 * with the loader's own message, because a check that reported on the handlers it could load and
 * skipped the rest would be a partial answer that looks whole.
 *
 * Then the project's transcripts are replayed once through the normalizer and every handler, and
 * each handler reports what it would have emitted: its count, the triggers behind it, the windows
 * the log ended inside, the judgment fields it declares (`judged`, asc-6ola.9), and a few rows to
 * read. The log's horizon is reported with them, because a count means nothing without the amount
 * of history it was counted over.
 *
 * Read-only: nothing is written to the store or to the transcripts.
 */

import { Args, Flags } from '@oclif/core';
import { canonicalJson } from '@ascend/core';
import { BaseCommand } from '../../base.js';
import { replayHandlers, spreadSample } from '../../handler-replay.js';
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
import { sayStage } from '../../typed-handlers.js';

export default class HandlersCheck extends BaseCommand {
  static override description =
    'Replay handlers over this project’s Claude Code transcripts and report what each would ' +
    'emit: the parsed handler, its hash, its count, and sample rows. Writes nothing.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> handlers/edit-unverified.yaml',
    '<%= config.bin %> <%= command.id %> a.yaml b.yaml --samples 10 --json',
  ];

  static override strict = false;

  static override args = {
    file: Args.string({
      description: 'A handler file. Pass several to replay them over the log together.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    ...REPLAY_FLAGS,
    samples: Flags.integer({
      description: 'Rows to show per handler, spread evenly across the log.',
      default: 3,
      min: 0,
    }),
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(HandlersCheck);
    const format = this.resolveFormat(flags);
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
      const { name, handler } = replay;
      const add = (field: string, value: unknown): void => {
        rows.push({ [HANDLER]: name, [FIELD]: field, [VALUE]: value });
      };
      add('hash', handler.hash);
      // A typed handler's rows become entries of this type at ingest (asc-tuur.3), so the check
      // names it: the count below is then a count of entries, not only of rows.
      if (handler.type !== undefined) add('type', handler.type);
      // A say handler's rows are what `asc hook <stage>` would have printed at each trigger.
      if (handler.say) add('stage', sayStage(handler));
      add('on', handler.on);
      // Always, including the default. A count is only meaningful over a named partition, and
      // `scope` is the whole difference between "this stream" and "this session" (asc-gtnu.4), so
      // leaving it to be inferred from the handler's absence of a key is the ambiguity this stage
      // exists to remove.
      add('scope', handler.scope);
      if (handler.description !== undefined) add('description', handler.description);
      add('parsed', canonicalJson(handler.spec));
      add('rows', replay.rows.length);
      add('triggers', replay.triggers);
      add('unclosed', replay.unclosed);
      // A window DECIDED with "no match" as its verdict, by `until` or by the `calls` limit
      // (asc-gtnu.4). Reported beside `unclosed` because the two are the whole answer to "the
      // trigger fired and no row came out" -- and before this line existed, only one of them was
      // printed, so a decided-no-match window was indistinguishable from one that never opened.
      add('noMatch', replay.noMatch);
      // Beside `rows` for the same reason as `noMatch`: a table row that could not be read is a
      // finding the report holds and the handler did not emit.
      if (handler.each?.mode === 'table') add('malformedItems', replay.malformedItems);
      if (handler.before !== undefined) {
        add('before', handler.before.on);
        add('unsatisfiedBefore', replay.unsatisfiedBefore);
      }
      // One row per judged name, in document order, following `analysis_questions[i]` in
      // `types show`: the table elides at 60 characters, so a joined list would lose every name
      // after the first, and `--json` gets each as a plain string.
      //
      // Reported next to `rows` deliberately. These fields appear on every row this handler
      // emits and carry no value on any of them -- which is the whole point of the key and is
      // exactly what would otherwise read as a broken handler.
      handler.judged.forEach((name, index) => {
        add(`judged[${String(index)}]`, name);
      });
      spreadSample(replay.rows, flags.samples).forEach((row, index) => {
        add(`sample[${String(index)}]`, row);
      });
    }
    this.emit(format, { columns: [HANDLER, FIELD, VALUE], rows });
  }
}
