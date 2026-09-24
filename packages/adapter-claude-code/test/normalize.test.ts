import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, eventFieldType, type NormalizedEvent } from '@ascend/core';
import { EVENT_DERIVE_VERSION, createNormalizer } from '../src/index.js';
import type { TranscriptFile, TranscriptRecord } from '../src/index.js';

/**
 * The normalizer's rules, against object literals (asc-6ola.12). The real corpus is driven by
 * `normalize-real-corpus.test.ts`, through the same code.
 */

const MAIN: TranscriptFile = {
  path: '/root/-Users-me-app/sess-1.jsonl',
  project: '-Users-me-app',
  session: 'sess-1',
  kind: 'session',
};

const SUB: TranscriptFile = {
  path: '/root/-Users-me-app/sess-1/subagents/agent-abc123.jsonl',
  project: '-Users-me-app',
  session: 'sess-1',
  kind: 'subagent',
};

const TS = '2026-09-24T10:00:00.000Z';

const assistant = (
  uses: readonly { id: string; name: string; input?: Record<string, unknown> }[],
  messageId = `msg-${uses.map((use) => use.id).join('-')}`,
): TranscriptRecord => ({
  type: 'assistant',
  sessionId: 'sess-1',
  timestamp: TS,
  message: {
    id: messageId,
    content: uses.map((use) => ({
      type: 'tool_use',
      id: use.id,
      name: use.name,
      input: use.input ?? {},
    })),
  },
});

const toolResult = (
  id: string,
  isError: boolean,
  extra: Record<string, unknown> = {},
  content = '',
): TranscriptRecord => ({
  type: 'user',
  sessionId: 'sess-1',
  timestamp: TS,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
  ...extra,
});

const prompt = (text: string): TranscriptRecord => ({
  type: 'user',
  sessionId: 'sess-1',
  timestamp: TS,
  message: { content: text },
});

function normalize(
  records: readonly TranscriptRecord[],
  file: TranscriptFile = MAIN,
): NormalizedEvent[] {
  const normalizer = createNormalizer();
  const out: NormalizedEvent[] = [];
  for (const one of records) out.push(...normalizer.accept(one, file));
  out.push(...normalizer.drain());
  return out;
}

const kinds = (events: readonly NormalizedEvent[]): string[] => events.map((event) => event.kind);

describe('createNormalizer', () => {
  it('orders a call as start, end, then its derived events, and ends the stream', () => {
    const events = normalize([
      prompt('run it'),
      assistant([{ id: 't1', name: 'Bash', input: { command: 'bd close asc-1' } }]),
      toolResult('t1', false),
    ]);
    expect(kinds(events)).toEqual([
      'prompt.submit',
      'tool.use.start',
      'tool.use.end',
      'command.run',
      'session.end',
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events.map((event) => event.call)).toEqual([0, 1, 1, 1, 1]);
  });

  it('carries the stream key, version and timestamp on every event', () => {
    for (const event of normalize([prompt('hi')])) {
      expect(event.session_id).toBe('sess-1');
      expect(event.agent_id).toBe('main');
      expect(event.derive_version).toBe(EVENT_DERIVE_VERSION);
      expect(event.ts).toBe(TS);
    }
  });

  it('keys a subagent transcript by the agent id in its file name, not the shared session', () => {
    const [event] = normalize([prompt('task')], SUB);
    expect(event?.session_id).toBe('sess-1');
    expect(event?.agent_id).toBe('abc123');
  });

  it('restarts seq and call when the file changes, ending the previous stream first', () => {
    const normalizer = createNormalizer();
    const first = normalizer.accept(assistant([{ id: 't1', name: 'Read' }]), MAIN);
    const second = normalizer.accept(prompt('task'), SUB);
    expect(kinds(first)).toEqual(['tool.use.start']);
    expect(kinds(second)).toEqual(['session.end', 'prompt.submit']);
    expect(second[0]?.agent_id).toBe('main');
    expect(second[1]).toMatchObject({ agent_id: 'abc123', seq: 0, call: 0 });
    // The Read never got its result, and that is counted rather than dropped.
    expect(normalizer.counters.unfinishedCalls).toBe(1);
  });

  it('gives calls from one assistant message one batch, even across records', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'msg-A'),
      assistant([{ id: 't2', name: 'Read' }], 'msg-A'),
      assistant([{ id: 't3', name: 'Read' }], 'msg-B'),
    ]);
    const starts = events.filter((event) => event.kind === 'tool.use.start');
    expect(starts.map((event) => [event.call, event.batch])).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
    ]);
  });

  it('pairs a result with its call across records and keeps is_error under that name', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } }]),
      prompt('interleaved'),
      toolResult('t1', true),
    ]);
    const end = events.find((event) => event.kind === 'tool.use.end');
    expect(end).toMatchObject({ tool: 'Read', role: 'read', is_error: true, call: 1 });
    expect(events.find((event) => event.kind === 'file.read')).toMatchObject({ path: '/a/b.ts' });
  });

  it('counts a result whose call it never saw', () => {
    const normalizer = createNormalizer();
    normalizer.accept(toolResult('ghost', false), MAIN);
    expect(normalizer.counters.unpairedResults).toBe(1);
  });

  it('emits one command.run per executed segment, with argv and index', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Bash', input: { command: 'cd x && bd close a-1 b-2; ls' } }]),
      toolResult('t1', false),
    ]);
    const runs = events.filter((event) => event.kind === 'command.run');
    expect(runs.map((event) => [event['head'], event['index']])).toEqual([
      ['bd', 0],
      ['ls', 1],
    ]);
    expect(runs[0]?.['argv']).toEqual(['bd', 'close', 'a-1', 'b-2']);
    expect(runs[0]?.['is_error']).toBe(false);
  });

  it('reads a check verdict from its own exit status when nothing follows it', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Bash', input: { command: 'pnpm test' } }]),
      toolResult('t1', true),
    ]);
    expect(events.find((event) => event.kind === 'check.run')).toMatchObject({
      runner: 'pnpm test',
      verdict: 'failed',
      verdict_state: 'measured',
      verdict_source: 'exit_status',
    });
  });

  it('never reads a masked check from is_error: no summary means not_measured', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Bash', input: { command: 'pnpm test | tail -5' } }]),
      toolResult('t1', false, {}, 'some unrelated tail'),
    ]);
    const check = events.find((event) => event.kind === 'check.run');
    expect(check).toMatchObject({ verdict_state: 'not_measured' });
    expect(check?.['verdict']).toBeUndefined();
  });

  it('reads a masked check from its output when the output settles it', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Bash', input: { command: 'pnpm test | tail -5' } }]),
      toolResult(
        't1',
        false,
        {},
        ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)',
      ),
    ]);
    expect(events.find((event) => event.kind === 'check.run')).toMatchObject({
      verdict: 'failed',
      verdict_source: 'output',
    });
  });

  it('counts search hits from Grep and from a shell search', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Grep', input: { pattern: 'foo' } }]),
      toolResult('t1', false, {
        toolUseResult: { mode: 'files_with_matches', numFiles: 0, filenames: [] },
      }),
      assistant([{ id: 't2', name: 'Bash', input: { command: 'rg bar src' } }]),
      toolResult('t2', false, { toolUseResult: { stdout: 'a.ts:1:bar\nb.ts:2:bar\n' } }),
    ]);
    const searches = events.filter((event) => event.kind === 'search.run');
    expect(searches.map((event) => [event['via'], event['pattern'], event['hits']])).toEqual([
      ['Grep', 'foo', 0],
      ['rg', 'bar src', 2],
    ]);
  });

  it('leaves hits absent when a record carries two results and one toolUseResult', () => {
    const events = normalize([
      assistant([
        { id: 't1', name: 'Grep', input: { pattern: 'a' } },
        { id: 't2', name: 'Grep', input: { pattern: 'b' } },
      ]),
      {
        type: 'user',
        sessionId: 'sess-1',
        timestamp: TS,
        toolUseResult: { numFiles: 3 },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', is_error: false },
          ],
        },
      },
    ]);
    const searches = events.filter((event) => event.kind === 'search.run');
    expect(searches).toHaveLength(2);
    for (const search of searches) expect(search['hits']).toBeUndefined();
  });

  it('emits file.changed per edit, and none for a failed edit', () => {
    const events = normalize([
      assistant([
        {
          id: 't1',
          name: 'MultiEdit',
          input: {
            file_path: '/p/PLAN.md',
            edits: [
              { old_string: 'a', new_string: 'b' },
              { old_string: 'c', new_string: 'd' },
            ],
          },
        },
      ]),
      toolResult('t1', false),
      assistant([{ id: 't2', name: 'Write', input: { file_path: '/p/x.ts', content: 'x' } }]),
      toolResult('t2', true),
    ]);
    const changes = events.filter((event) => event.kind === 'file.changed');
    expect(changes.map((event) => [event['path'], event['before'], event['after']])).toEqual([
      ['/p/PLAN.md', 'a', 'b'],
      ['/p/PLAN.md', 'c', 'd'],
    ]);
  });

  it('pairs an async agent spawn with its later task-notification', () => {
    const events = normalize([
      assistant([
        {
          id: 't1',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'look around' },
        },
      ]),
      toolResult('t1', false, {
        toolUseResult: {
          agentId: 'child9',
          isAsync: true,
          status: 'async_launched',
          resolvedModel: 'claude-sonnet-5',
        },
      }),
      prompt(
        '<task-notification>\n<task-id>child9</task-id>\n<tool-use-id>t1</tool-use-id>\n' +
          '<status>completed</status>\n<result>found <b>it</b></result>\n' +
          '<usage><subagent_tokens>1200</subagent_tokens><tool_uses>7</tool_uses>' +
          '<duration_ms>5000</duration_ms></usage>\n</task-notification>',
      ),
    ]);
    expect(events.find((event) => event.kind === 'agent.spawn')).toMatchObject({
      child_agent_id: 'child9',
      agent_type: 'Explore',
      model: 'claude-sonnet-5',
      async: true,
    });
    expect(events.find((event) => event.kind === 'agent.return')).toMatchObject({
      id: 't1',
      child_agent_id: 'child9',
      status: 'completed',
      tokens: 1200,
      tool_uses: 7,
      duration_ms: 5000,
    });
    // A notification is not the user's prompt.
    expect(events.some((event) => event.kind === 'prompt.submit')).toBe(false);
  });

  it('counts a notification for a task it did not spawn as an agent', () => {
    const normalizer = createNormalizer();
    normalizer.accept(
      prompt('<task-notification><task-id>bash1</task-id></task-notification>'),
      MAIN,
    );
    expect(normalizer.counters.unmatchedNotifications).toBe(1);
  });

  it('treats a synchronous agent result as its return', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Task', input: { subagent_type: 'general-purpose' } }]),
      toolResult('t1', false, {
        toolUseResult: {
          agentId: 'c2',
          totalTokens: 50,
          totalToolUseCount: 2,
          totalDurationMs: 900,
        },
      }),
    ]);
    expect(events.find((event) => event.kind === 'agent.return')).toMatchObject({
      child_agent_id: 'c2',
      status: 'completed',
      tokens: 50,
      duration_ms: 900,
    });
  });

  it('does not read a tool result or a meta record as a prompt', () => {
    const events = normalize([
      { type: 'user', isMeta: true, sessionId: 'sess-1', message: { content: 'caveat' } },
      prompt('real'),
    ]);
    expect(
      events.filter((event) => event.kind === 'prompt.submit').map((event) => event['text']),
    ).toEqual(['real']);
  });

  it('emits only fields its kind declares', () => {
    const events = normalize([
      prompt('go'),
      assistant([{ id: 't1', name: 'Bash', input: { command: 'rg x | head; pnpm test' } }]),
      toolResult('t1', false),
      assistant([{ id: 't2', name: 'Agent', input: {} }]),
      toolResult('t2', false, { toolUseResult: { agentId: 'z', isAsync: true } }),
    ]);
    for (const event of events) {
      expect(Object.hasOwn(EVENT_KINDS, event.kind), event.kind).toBe(true);
      for (const field of Object.keys(event)) {
        expect(eventFieldType(event.kind, field), `${event.kind}.${field}`).toBeDefined();
      }
    }
  });
});
