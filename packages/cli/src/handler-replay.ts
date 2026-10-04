/**
 * Replay handlers over one or more projects' transcripts (asc-6ola.14, asc-pps4).
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
import { readEventLog } from './event-log.js';

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
  /** Windows DECIDED with "no match" as the verdict, by `until` or by the `calls` limit. */
  readonly noMatch: number;
  /** Triggers whose `before:` reference had no match, so its `${before.…}` fields are absent. */
  readonly unsatisfiedBefore: number;
  /** Table rows skipped because their cells did not match their header (asc-tuur.3). */
  readonly malformedItems: number;
  /**
   * Triggers and rows per unit (`unitKey`), for the units with at least one trigger (asc-jwm7).
   * A row is counted in its TRIGGER's unit, wherever the event that completed it sat.
   */
  readonly units: ReadonlyMap<string, UnitCount>;
}

export interface UnitCount {
  readonly triggers: number;
  readonly rows: number;
}

/** The first and last timestamp seen in one unit. Absent when none of its events carried one. */
export interface UnitSpan {
  readonly first_ts?: string;
  readonly last_ts?: string;
}

/**
 * The holdout unit asc-6ola.4 settled on: one compaction segment of one stream. Keyed on the
 * stream as well as the segment index, because every stream's segments count from 0.
 */
export function unitKey(session: string, agent: string, segment: number): string {
  return `${session}\u0000${agent}\u0000${String(segment)}`;
}

export interface LogHorizon {
  /**
   * Where the events came from. A count is only meaningful over a named population, and "the
   * transcripts under ~/.claude/projects" and "this project's event log" are two different ones
   * that produce the same number today (asc-igg8).
   */
  readonly source: 'transcripts' | 'log';
  /** Transcripts discovered under the project directory, whether or not they held any events. */
  readonly files: number;
  /** Transcripts that could not be read to the end. A replay over a partial log says so. */
  readonly unreadable: number;
  /**
   * Transcripts under a known OS temp root that were NOT read (asc-80m). Only an all-projects
   * replay without `includeEphemeral` skips any; a named project is always read.
   */
  readonly ephemeral: number;
  readonly events: number;
  /** Absent when no event carried a timestamp -- never a stand-in value. */
  readonly first_ts?: string;
  readonly last_ts?: string;
}

export interface ReplayResult {
  readonly handlers: readonly HandlerReplay[];
  readonly horizon: LogHorizon;
  /** Every unit the log held, with its span, so a comparison can place it before or after a time. */
  readonly units: ReadonlyMap<string, UnitSpan>;
  readonly derive_version: number;
  readonly counters: NormalizeCounters;
}

/** The ordinary source: a sweep of Claude Code's transcripts under `root`. */
export interface TranscriptReplay {
  readonly source: 'transcripts';
  readonly root: string;
  /**
   * Claude Code's encoded directory names for the projects to replay, e.g.
   * `-Users-me-projects-ascend`, or `'all'` for every directory under `root` (asc-pps4: the
   * stratum asc-6ola.10 exists for is not in one project).
   */
  readonly projects: readonly string[] | 'all';
  /**
   * Read projects under a known OS temp root in an `'all'` replay. Ignored for named projects,
   * which are always read.
   */
  readonly includeEphemeral?: boolean;
}

/**
 * This project's own event log (asc-igg8), read INSTEAD of the transcripts -- never as well, which
 * would count every event twice.
 *
 * A separate member of the union rather than two more optional fields, so "the transcript scope
 * flags do not apply here" is a type error rather than a sentence somebody has to remember. The log
 * is one project's already; there is no root to sweep and no project to name.
 */
export interface LogReplay {
  readonly source: 'log';
  /** The store tree holding `events/`, e.g. `<project>/.ascend`. */
  readonly tree: string;
}

export type ReplayOptions = TranscriptReplay | LogReplay;

/** Stream the projects' transcripts once, offering every event to every handler. */
export async function replayHandlers(
  handlers: readonly NamedHandler[],
  options: ReplayOptions,
): Promise<ReplayResult> {
  const runs = handlers.map(({ name, handler }) => ({
    name,
    handler,
    run: runHandler(handler),
    rows: [] as HandlerRow[],
    units: new Map<string, { triggers: number; rows: number }>(),
    // A row names its trigger by stream and seq, not by unit, so the unit is noted at the trigger.
    triggerUnit: new Map<string, string>(),
  }));
  const spans = new Map<string, { first_ts?: string; last_ts?: string }>();
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
    const segment = event['segment'];
    // Every event the normalizer emits carries `segment` (asc-73cb), so a missing one is a broken
    // invariant. Defaulting it to 0 would merge a stream's segments into one unit, silently.
    if (typeof segment !== 'number') {
      throw new Error(`A ${event.kind} event carries no segment; the normalizer must set one.`);
    }
    const unit = unitKey(event.session_id, event.agent_id, segment);
    let span = spans.get(unit);
    if (span === undefined) spans.set(unit, (span = {}));
    if (typeof ts === 'string') {
      if (span.first_ts === undefined || ts < span.first_ts) span.first_ts = ts;
      if (span.last_ts === undefined || ts > span.last_ts) span.last_ts = ts;
    }
    for (const entry of runs) {
      const before = entry.run.triggers;
      const rows = entry.run.accept(event);
      if (entry.run.triggers > before) {
        entry.triggerUnit.set(streamSeq(event.session_id, event.agent_id, event.seq), unit);
        countIn(entry.units, unit).triggers += entry.run.triggers - before;
      }
      entry.rows.push(...rows);
      for (const row of rows) countRow(entry, row);
    }
  };

  // The horizon's own numbers, filled by whichever source is read. Declared here rather than
  // derived from `totals`, because a log has no sweep behind it and `totals` is undefined then.
  let files = 0;
  let unreadable = 0;
  let ephemeral = 0;

  if (options.source === 'transcripts') {
    const totals = await streamCorpus(
      (record, file) => {
        for (const event of normalizer.accept(record, file)) offer(event);
      },
      // The ephemeral skip exists for sweeps over every project (asc-80m). A caller who NAMED a
      // project asked for it, and skipping it would report a zero over a log that was never read --
      // found by the default-project test, whose scratch project sits under tmpdir.
      options.projects === 'all'
        ? { root: options.root, includeEphemeral: options.includeEphemeral ?? false }
        : { root: options.root, projects: new Set(options.projects), includeEphemeral: true },
    );
    files = totals.files;
    unreadable = totals.failures.length;
    ephemeral = totals.skipped.filter((entry) => entry.reason === 'ephemeral').length;
    for (const event of normalizer.drain()) offer(event);
  } else {
    // No normalizer ran and no transcript was opened. The log holds the normalizer's own output,
    // already keyed and ordered, so it is offered straight through -- the same `offer` a swept
    // event goes through, which is what makes a count from one source checkable against the other.
    const log = readEventLog(options.tree);
    files = log.files;
    for (const event of log.events) offer(event);
  }

  // The log is over. Without this a `scope: session` window that never met its `until` would
  // vanish -- not emitted, not counted -- because `session.end` is one event per STREAM and so
  // never decides a session-scoped window (asc-gtnu.4). Counting them as `unclosed` is the only
  // honest resting place for a window the log ended inside.
  for (const entry of runs) entry.run.finish();

  return {
    handlers: runs.map(({ name, handler, run, rows, units }) => ({
      name,
      handler,
      rows,
      units,
      triggers: run.triggers,
      unclosed: run.unclosed,
      noMatch: run.noMatch,
      unsatisfiedBefore: run.unsatisfiedBefore,
      malformedItems: run.malformedItems,
    })),
    horizon: {
      source: options.source,
      // A log's `files` are its own files, not transcripts: the row naming the source is printed
      // beside it, so the number is never read as a sweep that found this many transcripts.
      files,
      unreadable,
      ephemeral,
      events,
      ...(first === undefined ? {} : { first_ts: first }),
      ...(last === undefined ? {} : { last_ts: last }),
    },
    derive_version: EVENT_DERIVE_VERSION,
    // Zeros when the log was the source, and `logRows` prints none of them for exactly that reason:
    // the normalizer's counters are a statement about a sweep, and no sweep happened.
    counters: normalizer.counters,
    units: spans,
  };
}

function streamSeq(session: string, agent: string, seq: number): string {
  return `${session}\u0000${agent}\u0000${String(seq)}`;
}

function countIn(
  units: Map<string, { triggers: number; rows: number }>,
  unit: string,
): { triggers: number; rows: number } {
  let count = units.get(unit);
  if (count === undefined) units.set(unit, (count = { triggers: 0, rows: 0 }));
  return count;
}

function countRow(
  entry: {
    units: Map<string, { triggers: number; rows: number }>;
    triggerUnit: Map<string, string>;
  },
  row: HandlerRow,
): void {
  const unit = entry.triggerUnit.get(streamSeq(row.session_id, row.agent_id, row.seq));
  // Every row comes from a trigger this replay offered, so a miss is a broken invariant, not data.
  if (unit === undefined) {
    throw new Error(
      `A handler row names a trigger the replay never saw: ${row.session_id} ${row.agent_id} ` +
        `seq ${String(row.seq)}.`,
    );
  }
  countIn(entry.units, unit).rows += 1;
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
