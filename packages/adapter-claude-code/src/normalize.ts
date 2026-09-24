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

import { MAIN_AGENT, type EventRole, type EventValue, type NormalizedEvent } from '@ascend/core';
import type { TranscriptRecord } from './decode.js';
import { checkRun, execSegments, readVerdict } from './derive.js';
import type { TranscriptFile } from './transcript-file.js';

/**
 * Bumped whenever a change here can change what a handler sees. Every event carries it, so a
 * count that moves between two replays can be attributed to the normalizer or to the handler.
 *
 * 2: `check.run` no longer fires for `prettier --write` (asc-6ola.15).
 */
export const EVENT_DERIVE_VERSION = 2;

/** What the normalizer saw and could not place. Each is a count, because a drop is silent. */
export interface NormalizeCounters {
  records: number;
  events: number;
  /** A `tool_result` whose `tool_use` this stream never showed. */
  unpairedResults: number;
  /** A `tool_use` whose result never arrived before its stream ended. */
  unfinishedCalls: number;
  /** A `<task-notification>` naming a task this stream did not spawn as an agent. */
  unmatchedNotifications: number;
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
    return content.trimStart().startsWith('<task-notification>') ? undefined : str(content);
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

/** The fields of a `<task-notification>` message, or `undefined` when it is not one. */
function taskNotification(record: TranscriptRecord): Record<string, string> | undefined {
  if (record['type'] !== 'user') return undefined;
  const content = rec(record['message'])?.['content'];
  if (typeof content !== 'string' || !content.trimStart().startsWith('<task-notification>')) {
    return undefined;
  }
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
            typeof read === 'object'
              ? {
                  id,
                  runner: check.runner,
                  verdict: read.verdict ? 'passed' : 'failed',
                  verdict_state: 'measured',
                  verdict_source: read.source,
                }
              : { id, runner: check.runner, verdict_state: 'not_measured' },
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
    if (notice !== undefined) {
      const child = notice['task-id'];
      if (child !== undefined && spawned.has(child)) {
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
      } else {
        counters.unmatchedNotifications += 1;
      }
    }

    if (record['type'] === 'assistant') {
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
        emit(out, 'tool.use.start', calls, ts, { tool, id, role: ROLES[tool] ?? 'other' }, batches);
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
