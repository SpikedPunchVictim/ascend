/**
 * Replay handlers over one project's transcripts (asc-6ola.14).
 *
 * This is the dry run a handler must pass before it is trusted: the same normalizer and the same
 * evaluator a live hook will use, fed the project's recorded history instead of one event at a
 * time. Nothing is written anywhere -- the transcripts are read-only to ascend, and a replay's
 * result is a report, not entries.
 *
 * **The horizon is part of the answer.** A count of 0 over three sessions and a count of 0 over
 * three hundred are different findings, so the replay reports how much log it saw (files, events,
 * first and last timestamp) next to every count, and `derive_version` so a count can be matched
 * to the normalizer that produced it.
 */

import {
  EVENT_DERIVE_VERSION,
  createNormalizer,
  streamCorpus,
  type NormalizeCounters,
} from '@ascend/adapter-claude-code';
import {
  runHandler,
  type CompiledHandler,
  type HandlerRow,
  type NormalizedEvent,
} from '@ascend/core';

/**
 * Claude Code's directory name for a project: every character that is not a letter, a digit or a
 * `-` becomes `-`. Checked 2026-09-24 against the 138 directories under `~/.claude/projects` on
 * this machine: none contains a `.`, `_` or space, and one is `-Users-<user>--claude-jobs-…`,
 * a `.claude` path with its `.` written as `-`. `_` and space are not exercised by any directory
 * there; the rule treats them the same way. A caller whose directory is spelled otherwise passes
 * `--project`, and a name that matches no directory is refused rather than replayed as empty.
 */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^A-Za-z0-9-]/g, '-');
}

export interface NamedHandler {
  readonly name: string;
  readonly handler: CompiledHandler;
}

export interface HandlerReplay {
  readonly name: string;
  readonly handler: CompiledHandler;
  readonly rows: readonly HandlerRow[];
  readonly triggers: number;
  readonly unclosed: number;
}

export interface LogHorizon {
  /** Transcripts discovered under the project directory, whether or not they held any events. */
  readonly files: number;
  /** Transcripts that could not be read to the end. A replay over a partial log says so. */
  readonly unreadable: number;
  readonly events: number;
  /** Absent when no event carried a timestamp -- never a stand-in value. */
  readonly first_ts?: string;
  readonly last_ts?: string;
}

export interface ReplayResult {
  readonly handlers: readonly HandlerReplay[];
  readonly horizon: LogHorizon;
  readonly derive_version: number;
  readonly counters: NormalizeCounters;
}

export interface ReplayOptions {
  readonly root: string;
  /** Claude Code's encoded directory name for the project, e.g. `-Users-me-projects-ascend`. */
  readonly project: string;
}

/** Stream the project's transcripts once, offering every event to every handler. */
export async function replayHandlers(
  handlers: readonly NamedHandler[],
  options: ReplayOptions,
): Promise<ReplayResult> {
  const runs = handlers.map(({ name, handler }) => ({
    name,
    handler,
    run: runHandler(handler),
    rows: [] as HandlerRow[],
  }));
  const normalizer = createNormalizer();
  let events = 0;
  let first: string | undefined;
  let last: string | undefined;

  const offer = (event: NormalizedEvent): void => {
    events += 1;
    const { ts } = event;
    if (typeof ts === 'string') {
      if (first === undefined || ts < first) first = ts;
      if (last === undefined || ts > last) last = ts;
    }
    for (const entry of runs) entry.rows.push(...entry.run.accept(event));
  };

  const totals = await streamCorpus(
    (record, file) => {
      for (const event of normalizer.accept(record, file)) offer(event);
    },
    // `includeEphemeral`: the ephemeral skip exists for sweeps over every project (asc-80m). Here
    // the caller named this one project, and skipping it would report a zero over a log that was
    // never read -- found by the default-project test, whose scratch project sits under tmpdir.
    { root: options.root, projects: new Set([options.project]), includeEphemeral: true },
  );
  for (const event of normalizer.drain()) offer(event);

  return {
    handlers: runs.map(({ name, handler, run, rows }) => ({
      name,
      handler,
      rows,
      triggers: run.triggers,
      unclosed: run.unclosed,
    })),
    horizon: {
      files: totals.files,
      unreadable: totals.failures.length,
      events,
      ...(first === undefined ? {} : { first_ts: first }),
      ...(last === undefined ? {} : { last_ts: last }),
    },
    derive_version: EVENT_DERIVE_VERSION,
    counters: normalizer.counters,
  };
}

/**
 * `count` rows spread evenly across the replay, in log order.
 *
 * Evenly spaced rather than the first N: rows arrive in file order, so the first N would all come
 * from the oldest sessions and say nothing about whether the handler still fires on recent ones.
 * Deterministic, so two runs over the same log show the same samples.
 */
export function spreadSample<T>(rows: readonly T[], count: number): readonly T[] {
  if (count <= 0) return [];
  if (rows.length <= count) return rows;
  return Array.from({ length: count }, (_, index) => {
    const row = rows[Math.floor((index * rows.length) / count)];
    if (row === undefined) throw new Error(`sample index ${String(index)} out of range`);
    return row;
  });
}
