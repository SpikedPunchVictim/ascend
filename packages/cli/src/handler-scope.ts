/**
 * What `asc handlers check` and `asc handlers compare` share: which projects' transcripts to replay,
 * the handler loader, and the `(log)` rows that report the horizon a count was taken over.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Flags } from '@oclif/core';
import { defaultTranscriptRoot } from '@ascend/adapter-claude-code';
import { HandlerError, type CompiledHandler } from '@ascend/core';
import { refusal, usageError } from './errors.js';
import {
  encodeProjectDir,
  type NamedHandler,
  type ReplayResult,
  type TranscriptReplay,
} from './handler-replay.js';
import { loadHandler } from './handler-yaml.js';
import { findGitRoot, findProjectRoot } from './project.js';
import { sayStage } from './typed-handlers.js';

export const HANDLER = 'handler';
export const FIELD = 'field';
export const VALUE = 'value';
/** The pseudo-handler name the log's own facts are reported under. */
export const LOG = '(log)';

export type Row = Readonly<Record<typeof HANDLER | typeof FIELD | typeof VALUE, unknown>>;

/** The flags that choose what to replay. */
export const REPLAY_FLAGS = {
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
};

export interface ReplayFlags {
  readonly root?: string | undefined;
  readonly project?: string[] | undefined;
  readonly 'all-projects': boolean;
  readonly 'include-ephemeral': boolean;
}

/**
 * The replay the flags ask for. Refuses a flag combination that would do nothing; the directories
 * are checked separately, by `checkReplayScope`, so a handler the loader refuses is reported first.
 */
export function replayScope(flags: ReplayFlags): TranscriptReplay {
  const root = resolve(flags.root ?? defaultTranscriptRoot());
  const projects: readonly string[] | 'all' = flags['all-projects']
    ? 'all'
    : [...new Set(flags.project ?? [defaultProject()])];

  // By hand rather than oclif's `dependsOn`, which counts `--all-projects`'s `false` default as
  // present and so never refuses. A named project is always read, so the flag would do nothing.
  if (flags['include-ephemeral'] && projects !== 'all') {
    throw usageError(
      '--include-ephemeral applies only with --all-projects: a project named with --project ' +
        'is always read, wherever it lives.',
    );
  }
  return { source: 'transcripts', root, projects, includeEphemeral: flags['include-ephemeral'] };
}

/** Refuse a scope with no log behind it, before anything is replayed. */
export function checkReplayScope({ root, projects }: TranscriptReplay): void {
  if (projects === 'all') {
    if (!isDirectory(root)) {
      throw refusal(`There is no transcript root ${root}, so there is no log to replay.`);
    }
    return;
  }
  // Every name is checked before anything is replayed: a replay over the projects that existed
  // would be a partial count that looks whole.
  for (const project of projects) {
    if (!isDirectory(join(root, project))) {
      throw refusal(
        `There is no transcript directory ${project} under ${root}, so there is no log to ` +
          `replay. Pass --project with the directory name Claude Code used for this project.`,
      );
    }
  }
}

export function load(path: string): NamedHandler {
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

export function logRows(projects: readonly string[] | 'all', result: ReplayResult): Row[] {
  const { horizon } = result;
  if (horizon.source === 'log') {
    // The event log (asc-igg8), and NOT the transcript rows with zeros in them: the project labels
    // and the temp-root skips describe a sweep of `~/.claude/projects`, and no sweep happened. A
    // zero there would read as a sweep that found nothing, which is a different and much worse
    // statement than "this count came from somewhere else".
    //
    // `unreadable` is the one that moved. It was left out here for that same reason -- while the
    // log source could not have one, a zero described a transcript sweep and nothing else. The
    // log's walk records the directories it could not list now (`event-log.ts`'s `listDir`), so the
    // fact it names is the same one on either source: events that exist and never reached the
    // count. Leaving the row out would put a real number where no caller can read it, which is the
    // silence this list exists to avoid.
    const facts: [string, unknown][] = [
      ['source', 'event log'],
      ['derive_version', result.derive_version],
      ['files', horizon.files],
      ['unreadable', horizon.unreadable],
      ['events', horizon.events],
    ];
    if (horizon.first_ts !== undefined) facts.push(['first_ts', horizon.first_ts]);
    if (horizon.last_ts !== undefined) facts.push(['last_ts', horizon.last_ts]);
    return facts.map(([field, value]) => ({ [HANDLER]: LOG, [FIELD]: field, [VALUE]: value }));
  }
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

function defaultProject(): string {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
