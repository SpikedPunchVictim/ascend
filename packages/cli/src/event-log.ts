/**
 * The event log: the normalizer's output, written down (asc-igg8).
 *
 * **Why this exists.** Every handler count ascend reports is replayed from `~/.claude/projects`,
 * and those transcripts are a harness's local cache with a retention window nothing in this
 * repository controls (`spike/event-log/FINDINGS.md` Q2: no expiry observable on this machine, and
 * no retention setting configured -- unproven, not disproven). A rule that fired 900 times last
 * quarter cannot be re-checked once the transcript that proved it is gone, and a count over a
 * shrinking window is a count that drifts for a reason no handler changed. This file is the
 * artifact that outlives them.
 *
 * **DERIVED, AND STORED DERIVED.** The line written is the `NormalizedEvent` itself, not a
 * transcript record. Re-normalizing later would mean the log's meaning depends on the normalizer
 * that happens to be installed when it is read, which is the opposite of keeping a record. So the
 * envelope's `derive_version` is written with every line and **checked on read** -- a log from a
 * different derive version is refused rather than replayed, because `event.ts:45` says exactly what
 * it would otherwise do: "A count moves when this moves, with no handler changed."
 *
 * **NOT A STORE TYPE, ON PURPOSE.** `events/` is its own tree beside `entries/`. Handlers consume
 * normalized events, never stored rows (`handler-replay.ts`), so registering the log as a type
 * would buy the replay nothing while putting it into `asc export`, the SessionStart brief budget,
 * the dead-type check and invalidation semantics that do not apply to an event. The volume settles
 * it: 27,462 inputs over 21 days in this project (`EV-39`), against 6,582 entries.
 *
 * **ONE `write()` PER LINE.** Not a style choice. `EV-39` Q3 measured `cat >>` tearing lines from
 * 8 KiB upward, 4 torn lines in one run and 0 in the next at the same 8192 B, with line counts
 * still matching expectations -- silent corruption in a file that looks complete. A single
 * whole-line write never tore at any size tested to 1 MiB, and `appendFileSync` is one write for a
 * payload this size. The safety property is the call site, which is why it is stated here rather
 * than left to a reviewer to notice.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_BYTES_PER_FILE, MAX_RECORDS_PER_FILE } from '@ascend/store';
import { EVENT_DERIVE_VERSION } from '@ascend/adapter-claude-code';
import type { NormalizedEvent } from '@ascend/core';

/** The tree's directory name, beside `entries/`, `types/` and `annotations/`. */
export const EVENTS_DIR = 'events';

/** Where the log for a project's store lives. */
export function eventLogRoot(tree: string): string {
  return join(tree, EVENTS_DIR);
}

/**
 * A stream's directory, one per `(session_id, agent_id)` pair.
 *
 * Two levels rather than one flattened name: the pair IS the stream key (`event.ts:14`), and a
 * flattened `session-agent.jsonl` makes the split ambiguous the moment either id contains the
 * separator. A subagent's transcript carries its parent's session id, so `agent_id` is
 * load-bearing and must not be foldable into `session_id`.
 */
export function eventStreamDir(tree: string, session: string, agent: string): string {
  return join(eventLogRoot(tree), segment(session, 'session_id'), segment(agent, 'agent_id'));
}

/**
 * A path segment from an id that came out of a transcript.
 *
 * Refused rather than sanitized, because sanitizing two ids to the same name merges two streams
 * into one file and the count that moves is a count of a thing that was never one stream. `..` is
 * refused for the reason any path segment is checked at all.
 */
function segment(id: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(
      `A ${field} of ${JSON.stringify(id)} cannot name a directory under the event log: it is not ` +
        `a run of letters, digits, dot, dash or underscore. Refused rather than sanitized, because ` +
        `two ids that sanitized to the same name would merge two streams into one file.`,
    );
  }
  return id;
}

interface Head {
  readonly dir: string;
  index: number;
  records: number;
  bytes: number;
}

export interface EventLogWriter {
  /** Append one event. Every call is one `write()` of one line. */
  accept(event: NormalizedEvent): void;
  /** The stream directories written to, for a caller that reports what it did. */
  streams(): readonly string[];
}

/**
 * A writer over `events/`, rolling to the next file when the current one is full.
 *
 * **NOTHING IS EVER DROPPED.** The two caps bound how many events share a file; reaching one opens
 * a higher-numbered file, exactly as the record tree does (`jsonl-files.ts:133`). `asc-8uzh`'s
 * drop-oldest was deliberately never built, and it is the wrong answer here for the reason the bead
 * gives: a log that silently discards its oldest events is a count that moves for a reason no
 * handler changed, which is the derive-version hazard wearing the other coat.
 *
 * Growth, so the decision has a number behind it: measured at ~1.33 MB/day raw over this project's
 * corpus (`EV-39` Q1), a 20 MiB file rolls about every 15.8 days. Nothing here needs to drop.
 */
export function openEventLog(tree: string): EventLogWriter {
  const heads = new Map<string, Head>();
  const streams = new Set<string>();

  /** Read a stream's tail file ONCE, then append in O(1) -- the same reason as the record writer. */
  const headFor = (dir: string): Head => {
    const known = heads.get(dir);
    if (known !== undefined) return known;
    const head = { dir, index: 1, records: 0, bytes: 0 };
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((name) => /^\d{4}\.jsonl$/.test(name))
        .sort();
    } catch {
      names = [];
    }
    const last = names.at(-1);
    if (last !== undefined) {
      const path = join(dir, last);
      const text = readFileSync(path, 'utf8');
      head.index = Number(last.slice(0, 4));
      // A blank line is not an event, the same rule the record tree states: counting one would roll
      // the file early against nothing.
      head.records = text.split('\n').filter((line) => line.trim() !== '').length;
      head.bytes = statSync(path).size;
    }
    heads.set(dir, head);
    return head;
  };

  return {
    accept(event: NormalizedEvent): void {
      const dir = eventStreamDir(tree, event.session_id, event.agent_id);
      streams.add(dir);
      // `JSON.stringify` cannot fail here: `NormalizedEvent` is flat and holds only the value types
      // the normalizer emits, and a cycle is not among them.
      const text = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(text);
      const head = headFor(dir);
      let path = join(dir, `${String(head.index).padStart(4, '0')}.jsonl`);
      if (
        head.records >= MAX_RECORDS_PER_FILE ||
        // `records > 0` lets a first oversized event be written rather than rolling to an empty
        // file the event still would not fit in. `EV-39` (d) measured the largest record at
        // 60,289 B, 0.057x the per-record cap, so this arm is a guard rather than a live path.
        (head.records > 0 && head.bytes + bytes > MAX_BYTES_PER_FILE)
      ) {
        head.index += 1;
        head.records = 0;
        head.bytes = 0;
        path = join(dir, `${String(head.index).padStart(4, '0')}.jsonl`);
      }
      mkdirSync(dir, { recursive: true });
      appendFileSync(path, text);
      head.records += 1;
      head.bytes += bytes;
    },
    streams: () => [...streams].sort(),
  };
}

/**
 * One directory's entries, or `undefined` when it is not there to be read.
 *
 * **ENOENT is the ordinary case; every other code is not.** `asc init` does not create `events/`
 * -- `openEventLog` does, on the first append (`:156`) -- so a project that never ran an ingest has
 * no log root at all, and a session directory listed a moment ago can be gone a moment later. Two
 * reads that race are not damage. A permission error or a path that is a file IS: nothing under it
 * was read and nothing is going to be, which is the difference between a log that is short and a
 * log this run could not finish reading. `typed-handlers.ts:106-112` draws the same line for a
 * missing `handlers/`.
 *
 * A non-ENOENT path is PUSHED, never thrown: one directory the user cannot read must not cost them
 * the rest of the log. That is `reader.ts:253-257`'s rule for the same situation, and this walk is
 * the same shape of walk.
 */
function listDir(dir: string, unreadable: string[]): string[] | undefined {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(dir);
    return undefined;
  }
}

/** One stream's files, in the order the log wrote them, and the directories that would not list. */
function streamFiles(tree: string): {
  readonly files: readonly string[];
  readonly unreadable: readonly string[];
} {
  const root = eventLogRoot(tree);
  const files: string[] = [];
  const unreadable: string[] = [];

  const sessions = listDir(root, unreadable);
  if (sessions === undefined) return { files, unreadable };
  for (const session of sessions) {
    const sessionDir = join(root, session);
    const agents = listDir(sessionDir, unreadable);
    if (agents === undefined) continue;
    for (const agent of agents) {
      const agentDir = join(sessionDir, agent);
      const names = listDir(agentDir, unreadable);
      if (names === undefined) continue;
      for (const name of names) {
        if (/^\d{4}\.jsonl$/.test(name)) files.push(join(agentDir, name));
      }
    }
  }
  return { files, unreadable };
}

export interface EventLogRead {
  readonly events: readonly NormalizedEvent[];
  /** Log files read, so a caller can say how much log a count is over. */
  readonly files: number;
  /**
   * Directories in the log's tree that could not be listed, so nothing under them was read.
   *
   * **Paths rather than a count, and the paths are the point.** A report saying "unreadable: 1"
   * leaves the caller with nothing to act on; the path is the only part of it they can do anything
   * about. `LogHorizon.unreadable` takes the length of this, which is the number a replay report
   * needs -- so both readings come from one measurement rather than two.
   */
  readonly unreadable: readonly string[];
}

/**
 * Every event the log holds, in stream order.
 *
 * **A repeat of `(session_id, agent_id, seq)` is dropped, keeping the first.** Two ingests can read
 * the same transcript at once -- two sessions starting in one project both run the sweep -- and
 * neither is wrong to append. `seq` is total order within a stream (`event.ts:35`), so a repeat is
 * a duplicate of one event and not a second event, and replaying it twice would double every count
 * that keys on it. Deduplicating here rather than preventing it at the write is what keeps the
 * append lock-free, which is what keeps it one `write()` per line.
 */
export function readEventLog(tree: string): EventLogRead {
  const { files, unreadable } = streamFiles(tree);
  const seen = new Set<string>();
  const events: NormalizedEvent[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let event: NormalizedEvent;
      try {
        event = JSON.parse(line) as NormalizedEvent;
      } catch (error) {
        throw new Error(
          `${path}:${String(index + 1)} is not a JSON object, so the log cannot be replayed past ` +
            `it: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Checked per line rather than once at the head of the file: a rollover is a new file, and a
      // log half-written by one derive version and half by another would otherwise replay as a
      // single consistent history, which is the one thing it is not.
      if (event.derive_version !== EVENT_DERIVE_VERSION) {
        throw new Error(
          `${path}:${String(index + 1)} was derived at version ` +
            `${String(event.derive_version)}, and this build derives ${String(EVENT_DERIVE_VERSION)}. ` +
            `Refused rather than replayed: a count moves when the derive version moves, with no ` +
            `handler changed (event.ts:45). Re-run \`asc ingest claude-code\` to rewrite the log.`,
        );
      }
      const key = `${event.session_id}\u0000${event.agent_id}\u0000${String(event.seq)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  return { events, files: files.length, unreadable };
}
