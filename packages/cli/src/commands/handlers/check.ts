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

import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Args, Flags } from '@oclif/core';
import { defaultTranscriptRoot } from '@ascend/adapter-claude-code';
import { canonicalJson, HandlerError, type CompiledHandler } from '@ascend/core';
import { BaseCommand } from '../../base.js';
import { refusal, usageError } from '../../errors.js';
import {
  encodeProjectDir,
  replayHandlers,
  spreadSample,
  type NamedHandler,
  type ReplayResult,
} from '../../handler-replay.js';
import { loadHandler } from '../../handler-yaml.js';
import { findGitRoot, findProjectRoot } from '../../project.js';
import { sayStage } from '../../typed-handlers.js';

const HANDLER = 'handler';
const FIELD = 'field';
const VALUE = 'value';
/** The pseudo-handler name the log's own facts are reported under. */
const LOG = '(log)';

type Row = Readonly<Record<typeof HANDLER | typeof FIELD | typeof VALUE, unknown>>;

function load(path: string): NamedHandler {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw refusal(`Cannot read handler ${path}: ${(error as Error).message}`);
  }
  let handler: CompiledHandler;
  try {
    handler = loadHandler(source);
    // A say handler on a kind no lifecycle hook delivers would never run (asc-tuur.4).
    if (handler.say) sayStage(handler);
  } catch (error) {
    if (error instanceof HandlerError) throw refusal(`${path}: ${error.message}`);
    throw error;
  }
  return { name: basename(path).replace(/\.ya?ml$/, ''), handler };
}

function logRows(projects: readonly string[] | 'all', result: ReplayResult): Row[] {
  const { horizon } = result;
  const facts: [string, unknown][] = [
    // One row per named project, so `--json` gets each as a plain string and the table's
    // 60-character elision cannot hide the second one.
    ...(projects === 'all'
      ? [['project', '(all)'] as [string, unknown]]
      : projects.map((project): [string, unknown] => ['project', project])),
    ['derive_version', result.derive_version],
    ['files', horizon.files],
    ['unreadable', horizon.unreadable],
    // Always, including zero: an all-projects count that silently left out the temp-root
    // projects would read as the whole corpus.
    ['ephemeral_skipped', horizon.ephemeral],
    ['events', horizon.events],
  ];
  if (horizon.first_ts !== undefined) facts.push(['first_ts', horizon.first_ts]);
  if (horizon.last_ts !== undefined) facts.push(['last_ts', horizon.last_ts]);
  for (const [name, count] of Object.entries(result.counters))
    facts.push([`normalizer.${name}`, count]);
  return facts.map(([field, value]) => ({ [HANDLER]: LOG, [FIELD]: field, [VALUE]: value }));
}

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
    root: Flags.string({
      description:
        'The directory holding transcript projects. Defaults to ~/.claude/projects, which is ' +
        'where Claude Code writes them.',
    }),
    project: Flags.string({
      description:
        'A transcript directory name to replay, e.g. -Users-me-projects-app. Repeat it to ' +
        'replay several together. Defaults to the encoded path of the ascend project (or git ' +
        'repository) containing the working directory.',
      multiple: true,
      exclusive: ['all-projects'],
    }),
    'all-projects': Flags.boolean({
      description:
        'Replay every transcript directory under the root. Projects under an OS temp root are ' +
        'skipped and counted unless --include-ephemeral is passed.',
      default: false,
      exclusive: ['project'],
    }),
    'include-ephemeral': Flags.boolean({
      description: 'With --all-projects, also replay projects under an OS temp root.',
      default: false,
    }),
    samples: Flags.integer({
      description: 'Rows to show per handler, spread evenly across the log.',
      default: 3,
      min: 0,
    }),
  };

  public async run(): Promise<void> {
    const { argv, flags } = await this.parse(HandlersCheck);
    const format = this.resolveFormat(flags);
    const root = resolve(this.optionalFlag(flags.root) ?? defaultTranscriptRoot());
    const projects: readonly string[] | 'all' = flags['all-projects']
      ? 'all'
      : [...new Set(this.optionalFlag(flags.project) ?? [this.defaultProject()])];

    // By hand rather than oclif's `dependsOn`, which counts `--all-projects`'s `false` default as
    // present and so never refuses. A named project is always read, so the flag would do nothing.
    if (flags['include-ephemeral'] && projects !== 'all') {
      throw usageError(
        '--include-ephemeral applies only with --all-projects: a project named with --project ' +
          'is always read, wherever it lives.',
      );
    }

    const handlers = (argv as string[]).map(load);
    if (projects === 'all') {
      if (!isDirectory(root)) {
        throw refusal(`There is no transcript root ${root}, so there is no log to replay.`);
      }
    } else {
      // Every name is checked before anything is replayed: a replay over the projects that
      // existed would be a partial count that looks whole.
      for (const project of projects) {
        if (!isDirectory(join(root, project))) {
          throw refusal(
            `There is no transcript directory ${project} under ${root}, so there is no log to ` +
              `replay. Pass --project with the directory name Claude Code used for this project.`,
          );
        }
      }
    }

    const result = await replayHandlers(handlers, {
      root,
      projects,
      includeEphemeral: flags['include-ephemeral'],
    });
    const rows: Row[] = logRows(projects, result);
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

  private defaultProject(): string {
    const cwd = process.cwd();
    const root = findProjectRoot(cwd) ?? findGitRoot(cwd);
    if (root === undefined) {
      throw refusal(
        'Not inside an ascend project or a git repository, so there is no project to replay. ' +
          'Pass --project with a transcript directory name.',
      );
    }
    return encodeProjectDir(root);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
