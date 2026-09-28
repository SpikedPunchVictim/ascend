/**
 * Claude Code transcripts -> the normalized event stream (asc-6ola.12).
 *
 * The event model is `@ascend/core`'s (`event.ts`); this file is the one place that knows how a
 * Claude Code transcript spells each kind. Handlers match the output and never the transcript,
 * so a second harness needs a second one of these and no handler changes.
 *
 * Pure in the same sense as `derive.ts`: records in, events out, no I/O. The reader streams the
 * files; this only keeps the state one stream needs, and resets it when the file changes.
 *
 * ONE FILE IS ONE STREAM. A main transcript is `(session, 'main')`; a subagent transcript is
 * `(session, <agent id from its file name>)` -- its records carry the PARENT's session id, which
 * is exactly why `agent_id` is part of the key. Every stream ends with a synthetic
 * `session.end`, so a window a handler opened near the end is closed and reported, never lost.
 *
 * What it reuses rather than restates: `execSegments` for shell segments, `checkRun` and
 * `readVerdict` for check verdicts. `check.run` therefore reads a verdict exactly as
 * `verification_run` v2 does -- the check's own exit status when nothing after it can replace
 * that status, its output otherwise, and `not_measured` rather than `is_error` when neither
 * settles it (dogfood/0012).
 */

import {
  MAIN_AGENT,
  canonicalJson,
  type EventRole,
  type EventValue,
  type NormalizedEvent,
} from '@ascend/core';
import type { TranscriptRecord } from './decode.js';
import { checkRun, execSegments, readVerdict } from './derive.js';
import { isFindingLens } from './derived-types.js';
import type { TranscriptFile } from './transcript-file.js';

/**
 * Bumped whenever a change here can change what a handler sees. Every event carries it, so a
 * count that moves between two replays can be attributed to the normalizer or to the handler.
 *
 * 2: `check.run` no longer fires for `prettier --write` (asc-6ola.15).
 * 3: `model.context` is emitted once per stream and again on a model or harness-version change
 *    (asc-6ola.10) -- one more event per stream, and a count that moves with no handler changed.
 * 4: `review.finding`, one event per element of a `ReportFindings` call's `findings[]`
 *    (asc-gtnu). Zero events on every corpus measured so far, because the tool has been called 0
 *    times -- so unlike 3, this one moves nothing today. It is the version that says the FIRST
 *    finding will not be mistaken for a handler bug.
 * 5: `tool.use.start` carries `skill` on a `Skill` call (asc-tuur.2), so a handler can tell which
 *    skill a request loaded. A new field, not a new event: no count moves.
 * 6: `agent.return` is also read from `queue-operation` and `attachment` records (asc-ggd4,
 *    dogfood/0017), which is where the harness writes most task notifications. One notification is
 *    written up to three times (queued, dequeued, delivered), so a return is emitted once per
 *    task id and fields, at its FIRST sighting: a return already emitted at 5 now carries the
 *    enqueue's timestamp rather than the delivery's. On this project, 2026-09-28: 89 of 95
 *    spawns close, up from 45.
 * 7: `check.run` and the `exec` segments behind shell events read quotes (asc-7gz2): a newline or
 *    operator inside a quoted argument is no boundary, a comment is not a command, and the script
 *    of `sh -c` is. Over 99,553 frozen Bash commands: 49 checks that were text are gone, 6 runs
 *    inside `sh -c` are kept, and 5 checks now own their exit status.
 * 8: a notification is also read after the harness's `[SYSTEM NOTIFICATION - NOT USER INPUT]`
 *    preamble (asc-wkmq), the only form a subagent stream receives one in. On this project,
 *    2026-09-28: 12 such deliveries stop being `prompt.submit` events, and the one subagent-spawned
 *    async fork whose return was missing now closes.
 * 9: `review.finding` carries `reviewer_model` (asc-gtnu.11), the record's model as the deriver
 *    writes it: 33 `ReportFindings` calls across every project on 2026-09-28, 0 from a
 *    `<synthetic>` record, so it is taken as-is, exactly like `derive.ts`. A new field; no count
 *    moves.
 * 10: `check.run` carries `paths`, the files the check named as targets (asc-gtnu.10), so a
 *    handler can ask whether a check ran on THIS file. A new field; no count moves.
 */
export const EVENT_DERIVE_VERSION = 10;

/** What the normalizer saw and could not place. Each is a count, because a drop is silent. */
export interface NormalizeCounters {
  records: number;
  events: number;
  /** A `tool_result` whose `tool_use` this stream never showed. */
  unpairedResults: number;
  /** A `tool_use` whose result never arrived before its stream ended. */
  unfinishedCalls: number;
  /**
   * A `<task-notification>` naming a task this stream did not spawn as an agent. Counted once per
   * notification, not per record: the harness writes one up to three times.
   */
  unmatchedNotifications: number;
  /**
   * A record holding a string that LEADS with `<task-notification>` somewhere the parser does not
   * read one (asc-ggd4). Its predecessor gap was invisible because `unmatchedNotifications` counts
   * only what parsed: 108 notification records went uncounted (dogfood/0017). Should be zero, or
   * explained -- a nonzero count is a record shape the harness started writing, or a tool whose
   * output happened to be a notification.
   */
  unreadNotifications: number;
  /** An assistant record whose model is `<synthetic>` -- harness-injected, not model output. */
  syntheticModelRecords: number;
  /**
   * `ReportFindings` findings whose `category` is not one of the nine lens slugs
   * (`FINDING_LENSES`, `derived-types.ts`).
   *
   * COUNTED AND CARRIED, never dropped. The event still holds the raw string under the
   * harness's own field name -- see `review.finding` in `EVENT_KINDS` -- because the log's job
   * is to record what the reviewer said, and the store's job is to decide what it will accept.
   * `derive.ts` counts the same value under `offVocabularyFindings` and refuses to write an
   * entry for it, so the two counters disagreeing is the signal that a reviewer used a word
   * outside the nine; a silent `continue` here would leave nothing to disagree about.
   *
   * Should be zero. MEASURED 2026-09-26: 0 -- on an EMPTY population, since the tool has been
   * called 0 times, so this is not evidence that the vocabulary holds.
   */
  offVocabularyFindings: number;
}

export interface Normalizer {
  /** Take one record; returns the events it completed. A new file first ends the last stream. */
  accept(record: TranscriptRecord, file: TranscriptFile): readonly NormalizedEvent[];
  /** End the last stream. Call once, after the final `accept`. */
  drain(): readonly NormalizedEvent[];
  readonly counters: NormalizeCounters;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** What the harness writes as `message.model` on a record it injected rather than one a model wrote. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * The harness's typed findings tool, which is what a `review.finding` event comes from.
 *
 * Carried from reconnaissance of the tool's schema on 2026-09-26, NOT from an observed call:
 * re-measured the same day, `ReportFindings` has been called 0 times across 1,236 transcript
 * files. The string and the `findings[]` shape below are therefore untested against reality, and
 * the fixture in `normalize.test.ts` is the only thing that has ever exercised this branch.
 */
const REPORT_FINDINGS_TOOL = 'ReportFindings';

/** The harness's skill-loading tool. Its input names the skill in `skill` (spike/capture-hooks). */
const SKILL_TOOL = 'Skill';

/** A string field's text, or `''` when the transcript carried something else or nothing. */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const ROLES: Readonly<Record<string, EventRole>> = {
  Bash: 'exec',
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  Agent: 'spawn',
  Task: 'spawn',
  AskUserQuestion: 'ask',
};

/** Shell programs whose output is a list of hits, so an empty output is a miss. */
const SEARCH_HEADS = new Set(['grep', 'rg', 'ugrep', 'find', 'ag']);

/**
 * How many results a search returned, or `undefined` when the result does not say.
 *
 * Grep and Glob report counts in `toolUseResult`. A shell search is counted by its output lines,
 * or summed from `-c` output. Ported from spike/handler-format, whose parity figures it must keep.
 */
function hitCount(
  tool: string,
  command: string,
  result: Record<string, unknown> | undefined,
  isError: boolean | undefined,
): number | undefined {
  if (tool === 'Grep' || tool === 'Glob') {
    if (result === undefined) return undefined;
    const numFiles = num(result['numFiles']);
    if (numFiles !== undefined && result['mode'] !== 'content') return numFiles;
    const numLines = num(result['numLines']);
    if (numLines !== undefined) return numLines;
    const filenames = result['filenames'];
    if (Array.isArray(filenames)) return filenames.length;
    const content = result['content'];
    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed.split('\n').length : 0;
    }
    return undefined;
  }
  const stdout = result === undefined ? '' : text(result['stdout']);
  if (isError === true && stdout.trim().length === 0) return 0;
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (/(^|\s)-c(\s|$)|--count/.test(command)) {
    return lines.reduce((sum, line) => sum + (Number(line.split(':').pop()) || 0), 0);
  }
  return lines.length;
}

/** The text of a user message, or `undefined` when it is not the user's own prose. */
function promptText(record: TranscriptRecord): string | undefined {
  if (record['type'] !== 'user' || record['isMeta'] === true) return undefined;
  const content = rec(record['message'])?.['content'];
  if (typeof content === 'string') {
    return NOTIFICATION.test(content) ? undefined : str(content);
  }
  if (!Array.isArray(content)) return undefined;
  const parts = content as readonly unknown[];
  if (parts.some((part) => rec(part)?.['type'] === 'tool_result')) return undefined;
  const joined = parts
    .map((part) => {
      const block = rec(part);
      return block?.['type'] === 'text' ? text(block['text']) : '';
    })
    .filter((one) => one.length > 0)
    .join('\n');
  return str(joined);
}

/**
 * A notification leads its text, or follows the harness's own preamble. A subagent stream is
 * delivered notifications ONLY in the preamble form -- 12 of 12 there, 0 read in any other shape
 * in the same stream (asc-wkmq) -- so without it a subagent's own async child never returns, and
 * the delivery was read as a prompt the user typed.
 */
const NOTIFICATION = /^\s*(?:\[SYSTEM NOTIFICATION - NOT USER INPUT\][^<]*)?<task-notification>/;

/**
 * The text of a `<task-notification>`, from each record shape measured to carry one, or
 * `undefined`. `user`: the delivered message. `queue-operation`: queued or dequeued, the tag in a
 * top-level `content` with no `message`. `attachment`: absorbed mid-turn, in `attachment.prompt`.
 */
function notificationText(record: TranscriptRecord): string | undefined {
  const content =
    record['type'] === 'user'
      ? rec(record['message'])?.['content']
      : record['type'] === 'queue-operation'
        ? record['content']
        : record['type'] === 'attachment'
          ? rec(record['attachment'])?.['prompt']
          : undefined;
  return typeof content === 'string' && NOTIFICATION.test(content) ? content : undefined;
}

/** Whether any string in `value`, at any depth, leads with the notification tag or its preamble. */
function leadsWithNotification(value: unknown): boolean {
  if (typeof value === 'string') return NOTIFICATION.test(value);
  if (Array.isArray(value)) return value.some(leadsWithNotification);
  const object = rec(value);
  return object !== undefined && Object.values(object).some(leadsWithNotification);
}

/** The fields of a `<task-notification>`, or `undefined` when the record carries none. */
function taskNotification(record: TranscriptRecord): Record<string, string> | undefined {
  const content = notificationText(record);
  if (content === undefined) return undefined;
  const out: Record<string, string> = {};
  // `<result>` is the subagent's prose and may itself contain tags, so it is cut out first.
  const body = content.replace(/<result>[\s\S]*?<\/result>/g, '');
  for (const tag of [
    'task-id',
    'tool-use-id',
    'status',
    'subagent_tokens',
    'tool_uses',
    'duration_ms',
  ]) {
    const found = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body);
    if (found?.[1] !== undefined) out[tag] = found[1].trim();
  }
  return out;
}

interface Pending {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly call: number;
  readonly batch: number;
}

/** The agent id a subagent transcript's file name carries (`agent-<id>.jsonl`). */
function agentIdOf(file: TranscriptFile): string {
  if (file.kind !== 'subagent') return MAIN_AGENT;
  const leaf = file.path.split(/[\\/]/).pop() ?? '';
  return leaf.replace(/^agent-/, '').replace(/\.jsonl$/, '');
}

export function createNormalizer(): Normalizer {
  const counters: NormalizeCounters = {
    records: 0,
    events: 0,
    unpairedResults: 0,
    unfinishedCalls: 0,
    unmatchedNotifications: 0,
    unreadNotifications: 0,
    syntheticModelRecords: 0,
    offVocabularyFindings: 0,
  };

  let path: string | undefined;
  let sessionId = '';
  let agentId = MAIN_AGENT;
  let seq = 0;
  let calls = 0;
  let batches = 0;
  let lastMessageId: string | undefined;
  let lastTs: string | undefined;
  let pending = new Map<string, Pending>();
  /** child agent id -> nothing; which notifications belong to an agent this stream spawned. */
  let spawned = new Set<string>();
  /** Notifications already emitted, and already counted as unmatched, by task id and fields. */
  let returned = new Set<string>();
  let unmatched = new Set<string>();
  /** The model and harness version last put into a `model.context` event on this stream. */
  let lastModel: string | undefined;
  let lastVersion: string | undefined;

  const emit = (
    out: NormalizedEvent[],
    kind: string,
    call: number,
    ts: string | undefined,
    fields: Readonly<Record<string, EventValue | undefined>>,
    batch?: number,
  ): void => {
    const event: Record<string, EventValue> = {
      kind,
      session_id: sessionId,
      agent_id: agentId,
      seq,
      call,
      derive_version: EVENT_DERIVE_VERSION,
    };
    if (batch !== undefined) event['batch'] = batch;
    if (ts !== undefined) event['ts'] = ts;
    // Absent stays absent: a field the transcript did not carry is omitted, never defaulted.
    for (const [name, value] of Object.entries(fields))
      if (value !== undefined) event[name] = value;
    out.push(event as unknown as NormalizedEvent);
    seq += 1;
    counters.events += 1;
  };

  const end = (out: NormalizedEvent[]): void => {
    if (path === undefined) return;
    counters.unfinishedCalls += pending.size;
    emit(out, 'session.end', calls, lastTs, {});
  };

  /**
   * ONE EVENT PER ELEMENT of a `ReportFindings` call's `findings[]` (asc-gtnu).
   *
   * Per ELEMENT rather than per call, so a handler can `first` on a single finding and an `emit`
   * can name its fields directly: a call carrying an array would force every consumer through an
   * `each` fan-out to reach one finding, and the position of a finding inside its call is
   * exactly the `index` this emits.
   *
   * `category` is carried VERBATIM even when it is not one of the nine lens slugs, and the count
   * is beside it rather than in place of it -- see `offVocabularyFindings`. The alternative, a
   * `continue` on the unknown value, is the silent filter that `syntheticModelRecords` exists to
   * warn about: the log would show a review that reported eight findings and hold nine, with
   * nothing saying which was dropped or why.
   */
  const reviewFindings = (
    out: NormalizedEvent[],
    call: number,
    batch: number,
    ts: string | undefined,
    id: string,
    input: Record<string, unknown> | undefined,
    model: string | undefined,
  ): void => {
    const raw = input === undefined ? undefined : input['findings'];
    if (!Array.isArray(raw)) return;
    const level = input === undefined ? undefined : str(input['level']);
    for (const [index, element] of (raw as readonly unknown[]).entries()) {
      const finding = rec(element);
      if (finding === undefined) continue;
      const category = str(finding['category']);
      if (!isFindingLens(category)) counters.offVocabularyFindings += 1;
      emit(
        out,
        'review.finding',
        call,
        ts,
        {
          // The CALL's id, shared by every finding in it, exactly as `command.run` shares one.
          // `index` is what makes the event addressable, and `(id, index)` is what the entry's
          // key is built from in `derive.ts`.
          id,
          index,
          category,
          file: str(finding['file']),
          // Absent stays absent, never `0`: a finding is not always line-anchored, and `0` is a
          // line number a reader would believe.
          line: num(finding['line']),
          summary: str(finding['summary']),
          failure_scenario: str(finding['failure_scenario']),
          verdict: str(finding['verdict']),
          level,
          reviewer_model: model,
        },
        batch,
      );
    }
  };

  const begin = (file: TranscriptFile, record: TranscriptRecord): void => {
    path = file.path;
    sessionId = file.session ?? str(record['sessionId']) ?? '';
    agentId = agentIdOf(file);
    seq = 0;
    calls = 0;
    batches = 0;
    lastMessageId = undefined;
    lastTs = undefined;
    pending = new Map();
    spawned = new Set();
    returned = new Set();
    unmatched = new Set();
    lastModel = undefined;
    lastVersion = undefined;
  };

  const results = (
    out: NormalizedEvent[],
    record: TranscriptRecord,
    ts: string | undefined,
    blocksIn: readonly Record<string, unknown>[],
  ): void => {
    const resultBlocks = blocksIn.filter((block) => block['type'] === 'tool_result');
    // `toolUseResult` is one per record, so it can be attributed only when the record carries
    // exactly one result. With more, a count read from it could belong to a sibling call.
    const toolUseResult = resultBlocks.length === 1 ? rec(record['toolUseResult']) : undefined;

    for (const block of resultBlocks) {
      const id = str(block['tool_use_id']);
      const start = id === undefined ? undefined : pending.get(id);
      if (id === undefined || start === undefined) {
        counters.unpairedResults += 1;
        continue;
      }
      pending.delete(id);
      const { tool, input, call, batch } = start;
      const isError = typeof block['is_error'] === 'boolean' ? block['is_error'] : undefined;
      const role = ROLES[tool] ?? 'other';
      emit(out, 'tool.use.end', call, ts, { tool, id, role, is_error: isError }, batch);

      if (tool === 'Bash') {
        const command = text(input['command']);
        const segments = execSegments(command);
        for (const [index, argv] of segments.entries()) {
          const head = argv[0];
          emit(
            out,
            'command.run',
            call,
            ts,
            { id, head, argv: [...argv], index, is_error: isError },
            batch,
          );
          if (head !== undefined && SEARCH_HEADS.has(head) && segments.length <= 3) {
            emit(
              out,
              'search.run',
              call,
              ts,
              {
                id,
                via: head,
                pattern: argv.slice(1).join(' '),
                hits: hitCount('Bash', command, toolUseResult, isError),
              },
              batch,
            );
          }
        }
        const check = checkRun(command);
        if (check !== undefined) {
          const read = readVerdict(check.exitStatusIsCheck, block);
          emit(
            out,
            'check.run',
            call,
            ts,
            {
              id,
              runner: check.runner,
              ...(typeof read === 'object'
                ? {
                    verdict: read.verdict ? 'passed' : 'failed',
                    verdict_state: 'measured',
                    verdict_source: read.source,
                  }
                : { verdict_state: 'not_measured' }),
              // Absent, not empty, when the check names no file: it ran over its whole config.
              ...(check.paths.length === 0 ? {} : { paths: check.paths }),
            },
            batch,
          );
        }
      } else if (tool === 'Grep' || tool === 'Glob') {
        emit(
          out,
          'search.run',
          call,
          ts,
          {
            id,
            via: tool,
            pattern: text(input['pattern']),
            hits: hitCount(tool, '', toolUseResult, isError),
          },
          batch,
        );
      } else if (tool === 'Read') {
        emit(out, 'file.read', call, ts, { id, tool, path: str(input['file_path']) }, batch);
      } else if (role === 'edit' && isError !== true) {
        const filePath = str(input['file_path']) ?? str(input['notebook_path']);
        const edits = Array.isArray(input['edits'])
          ? (input['edits'] as readonly unknown[])
          : [input];
        for (const one of edits) {
          const edit = rec(one) ?? {};
          emit(
            out,
            'file.changed',
            call,
            ts,
            {
              id,
              tool,
              path: filePath,
              before: text(edit['old_string']),
              after: text(edit['new_string'] ?? edit['content'] ?? edit['new_source']),
            },
            batch,
          );
        }
      } else if (role === 'spawn') {
        const childId = str(toolUseResult?.['agentId']);
        const launched =
          toolUseResult?.['isAsync'] === true || toolUseResult?.['status'] === 'async_launched';
        if (childId !== undefined) spawned.add(childId);
        emit(
          out,
          'agent.spawn',
          call,
          ts,
          {
            id,
            child_agent_id: childId,
            agent_type: str(input['subagent_type']),
            description: str(input['description']),
            model: str(toolUseResult?.['resolvedModel']),
            async: toolUseResult === undefined ? undefined : launched,
          },
          batch,
        );
        // A synchronous agent's result is its return; an async one returns by notification.
        if (toolUseResult !== undefined && !launched) {
          emit(
            out,
            'agent.return',
            call,
            ts,
            {
              id,
              child_agent_id: childId,
              status: isError === true ? 'failed' : (str(toolUseResult['status']) ?? 'completed'),
              tokens: num(toolUseResult['totalTokens']),
              tool_uses: num(toolUseResult['totalToolUseCount']),
              duration_ms: num(toolUseResult['totalDurationMs']),
            },
            batch,
          );
        }
      }
    }
  };

  /**
   * The model and harness version serving this stream, as CONTEXT rather than as a call.
   *
   * The three-state model has `measured`, `not_applicable` and `not_measured`, and an event can
   * only express the first. A stream with no assistant record emits NOTHING -- it does not emit a
   * `model.context` with every field absent, because `not_applicable` is not expressible here and
   * absence already means `not_measured` (state.ts). Inventing a row to say "nothing to say" is
   * the same defect as emitting a fabricated `0`.
   *
   * A record that carried no `message.model` did not change the model: the last one seen is
   * carried forward, so a missing field is never read as a change to nothing.
   */
  const modelContext = (
    out: NormalizedEvent[],
    record: TranscriptRecord,
    message: Record<string, unknown> | undefined,
    ts: string | undefined,
  ): void => {
    const raw = str(message?.['model']);
    if (raw === SYNTHETIC_MODEL) {
      // Harness-injected, not model output. Skipped AND counted: a silent `continue` is how a
      // filter becomes invisible, and this one would otherwise poison the stratification key.
      counters.syntheticModelRecords += 1;
      return;
    }
    const version = str(record['version']);
    const modelChanged = raw !== undefined && raw !== lastModel;
    const versionChanged = version !== undefined && version !== lastVersion;
    const model = raw ?? lastModel;
    if (model !== undefined && (modelChanged || versionChanged)) {
      emit(out, 'model.context', calls, ts, {
        model,
        // Present only on a model change, and only when there was a model before: absent on the
        // stream's first emission and on a version-only change, which are different facts.
        previous_model: modelChanged ? lastModel : undefined,
        harness_version: version,
      });
    }
    if (modelChanged) lastModel = raw;
    if (versionChanged) lastVersion = version;
  };

  const accept = (record: TranscriptRecord, file: TranscriptFile): readonly NormalizedEvent[] => {
    const out: NormalizedEvent[] = [];
    if (path !== file.path) {
      end(out);
      begin(file, record);
    }
    counters.records += 1;

    const ts = str(record['timestamp']);
    if (ts !== undefined) lastTs = ts;
    const message = rec(record['message']);
    const content = message?.['content'];
    const blocksIn = Array.isArray(content)
      ? (content as readonly unknown[]).flatMap((one) => {
          const block = rec(one);
          return block === undefined ? [] : [block];
        })
      : [];

    const said = promptText(record);
    if (said !== undefined) emit(out, 'prompt.submit', calls, ts, { text: said });

    const notice = taskNotification(record);
    if (notice === undefined) {
      if (leadsWithNotification(record)) counters.unreadNotifications += 1;
    } else {
      const child = notice['task-id'];
      // A copy of one already emitted -- queued, dequeued, delivered -- is the same notification.
      const key = canonicalJson(notice);
      if (returned.has(key)) {
        // Nothing to emit and nothing to count.
      } else if (child !== undefined && spawned.has(child)) {
        returned.add(key);
        const count = (name: string): number | undefined => {
          const raw = notice[name];
          return raw === undefined || !/^\d+$/.test(raw) ? undefined : Number(raw);
        };
        emit(out, 'agent.return', calls, ts, {
          id: notice['tool-use-id'],
          child_agent_id: child,
          status: notice['status'],
          tokens: count('subagent_tokens'),
          tool_uses: count('tool_uses'),
          duration_ms: count('duration_ms'),
        });
      } else if (!unmatched.has(key)) {
        unmatched.add(key);
        counters.unmatchedNotifications += 1;
      }
    }

    if (record['type'] === 'assistant') {
      modelContext(out, record, message, ts);

      const uses = blocksIn.filter((block) => block['type'] === 'tool_use');
      if (uses.length > 0) {
        // Claude Code writes one API message as several records, one per block, all carrying
        // the message's id. A batch is the message, so it advances only when the id changes.
        const messageId = str(message?.['id']);
        if (messageId === undefined || messageId !== lastMessageId) batches += 1;
        lastMessageId = messageId;
      }
      for (const block of uses) {
        const id = str(block['id']);
        const tool = str(block['name']);
        if (id === undefined || tool === undefined) continue;
        calls += 1;
        pending.set(id, { tool, input: rec(block['input']) ?? {}, call: calls, batch: batches });
        const skill = tool === SKILL_TOOL ? str(rec(block['input'])?.['skill']) : undefined;
        emit(
          out,
          'tool.use.start',
          calls,
          ts,
          { tool, id, role: ROLES[tool] ?? 'other', ...(skill === undefined ? {} : { skill }) },
          batches,
        );
        if (tool === REPORT_FINDINGS_TOOL) {
          reviewFindings(out, calls, batches, ts, id, rec(block['input']), str(message?.['model']));
        }
      }
    }

    if (record['type'] === 'user') results(out, record, ts, blocksIn);
    return out;
  };

  const drain = (): readonly NormalizedEvent[] => {
    const out: NormalizedEvent[] = [];
    end(out);
    path = undefined;
    return out;
  };

  return { accept, drain, counters };
}
