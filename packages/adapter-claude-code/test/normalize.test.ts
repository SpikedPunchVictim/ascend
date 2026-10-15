import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, compileHandler, eventFieldType, type NormalizedEvent } from '@ascend/core';
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

/**
 * `model` and `version` are ABSENT by default, which is the point: a record that carried neither
 * emits no `model.context`, so every test written before that kind existed keeps the event list
 * it asserted.
 */
const assistant = (
  uses: readonly { id: string; name: string; input?: Record<string, unknown> }[],
  messageId = `msg-${uses.map((use) => use.id).join('-')}`,
  model?: string,
  version?: string,
): TranscriptRecord => ({
  type: 'assistant',
  sessionId: 'sess-1',
  timestamp: TS,
  ...(version === undefined ? {} : { version }),
  message: {
    id: messageId,
    ...(model === undefined ? {} : { model }),
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

  it('carries the files a check named, and omits the field when it named none', () => {
    const events = normalize([
      assistant([
        { id: 't1', name: 'Bash', input: { command: 'npx vitest run test/a.test.ts' } },
        { id: 't2', name: 'Bash', input: { command: 'npx vitest run' } },
      ]),
      toolResult('t1', false),
      toolResult('t2', false),
    ]);
    const checks = events.filter((event) => event.kind === 'check.run');
    expect(checks.map((event) => event['paths'])).toEqual([['test/a.test.ts'], undefined]);
    expect(checks[1]).not.toHaveProperty('paths');
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

  describe('a notification in the records that queue and deliver it (asc-ggd4)', () => {
    const NOTICE =
      '<task-notification>\n<task-id>child9</task-id>\n<tool-use-id>t1</tool-use-id>\n' +
      '<status>completed</status>\n<usage><subagent_tokens>1200</subagent_tokens></usage>\n' +
      '</task-notification>';
    const spawn = [
      assistant([{ id: 't1', name: 'Agent', input: { subagent_type: 'Explore' } }]),
      toolResult('t1', false, { toolUseResult: { agentId: 'child9', isAsync: true } }),
    ];
    // The shapes measured in this project's transcripts: the tag in a top-level `content`, with
    // no `message`, and in an attachment's `prompt`.
    const queued = (operation: string, timestamp = TS): TranscriptRecord => ({
      type: 'queue-operation',
      operation,
      sessionId: 'sess-1',
      timestamp,
      content: NOTICE,
    });
    const absorbed: TranscriptRecord = {
      type: 'attachment',
      sessionId: 'sess-1',
      timestamp: TS,
      attachment: { type: 'queued_command', prompt: NOTICE },
    };
    const returns = (events: readonly NormalizedEvent[]) =>
      events.filter((event) => event.kind === 'agent.return');

    it('reads a return from a queue-operation record', () => {
      expect(returns(normalize([...spawn, queued('enqueue')]))).toMatchObject([
        { id: 't1', child_agent_id: 'child9', status: 'completed', tokens: 1200 },
      ]);
    });

    it('reads a return from an attachment that absorbed it mid-turn', () => {
      expect(returns(normalize([...spawn, absorbed]))).toHaveLength(1);
    });

    it('emits one return for a notification queued, dequeued and delivered', () => {
      const events = normalize([
        ...spawn,
        queued('enqueue', '2026-09-24T10:00:05.000Z'),
        queued('remove'),
        absorbed,
        prompt(NOTICE),
      ]);
      // At the first sighting: the enqueue is when the child returned.
      expect(returns(events).map((event) => event.ts)).toEqual(['2026-09-24T10:00:05.000Z']);
    });

    it('emits a second return when the same task notifies again with other fields', () => {
      const again = NOTICE.replace('1200', '1500');
      expect(returns(normalize([...spawn, prompt(NOTICE), prompt(again)]))).toHaveLength(2);
    });

    it('still emits the return when a copy was seen before the spawn was known', () => {
      const events = normalize([
        spawn[0] as TranscriptRecord,
        queued('enqueue'),
        spawn[1] as TranscriptRecord,
        absorbed,
      ]);
      expect(returns(events)).toHaveLength(1);
    });

    it('counts an unmatched notification once, however many records carry it', () => {
      const normalizer = createNormalizer();
      for (const one of [queued('enqueue'), queued('remove'), absorbed]) {
        normalizer.accept(one, MAIN);
      }
      expect(normalizer.counters.unmatchedNotifications).toBe(1);
    });

    // How a subagent stream receives one (asc-wkmq): the harness's preamble, then the tag.
    const PREAMBLE =
      '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, ' +
      'NOT a message from the user.\n\n';

    it('reads a return delivered after the harness preamble, and not as a prompt', () => {
      const events = normalize([...spawn, prompt(PREAMBLE + NOTICE)]);
      expect(returns(events)).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'prompt.submit')).toHaveLength(0);
    });

    it('still reads a prompt that only mentions the preamble words', () => {
      const events = normalize([prompt(`why does [SYSTEM NOTIFICATION] appear?`)]);
      expect(events.filter((event) => event.kind === 'prompt.submit')).toHaveLength(1);
    });

    it('counts a record that leads with the tag somewhere this parser does not read', () => {
      const normalizer = createNormalizer();
      normalizer.accept(
        { type: 'system', sessionId: 'sess-1', timestamp: TS, data: { note: NOTICE } },
        MAIN,
      );
      // A mention inside prose is not a notification, and is not counted.
      normalizer.accept(prompt(`what is a ${NOTICE}?`), MAIN);
      expect(normalizer.counters.unreadNotifications).toBe(1);
      expect(normalizer.counters.unmatchedNotifications).toBe(0);
    });
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
      assistant(
        [{ id: 't1', name: 'Bash', input: { command: 'rg x | head; pnpm test' } }],
        undefined,
        'claude-opus-5',
        '2.1.283',
      ),
      toolResult('t1', false),
      assistant([{ id: 't2', name: 'Agent', input: {} }]),
      toolResult('t2', false, { toolUseResult: { agentId: 'z', isAsync: true } }),
    ]);
    // The `model.context` above is in this list on purpose: a kind whose fields are not checked
    // here is a kind a typo can be introduced into without a test noticing.
    expect(kinds(events)).toContain('model.context');
    for (const event of events) {
      expect(Object.hasOwn(EVENT_KINDS, event.kind), event.kind).toBe(true);
      for (const field of Object.keys(event)) {
        expect(eventFieldType(event.kind, field), `${event.kind}.${field}`).toBeDefined();
      }
    }
  });
});

/**
 * `model.context` (asc-6ola.10) -- which model served a stream, under which harness, as the
 * stratification key a holdout comparison needs. The comparison this project wanted is NOT
 * reachable from this data (EV-26), but the key has to be right before anything can rest on it.
 */
/**
 * `segment` (asc-73cb): the holdout unit asc-6ola.4 settled on -- stream start or a compaction
 * boundary to the next -- carried on every event, with the boundary itself an event.
 */
describe('segment', () => {
  const compaction = (trigger: string): TranscriptRecord => ({
    type: 'system',
    subtype: 'compact_boundary',
    sessionId: 'sess-1',
    timestamp: TS,
    compactMetadata: { trigger, preTokens: 100, postTokens: 10 },
  });

  it('starts every stream at segment 0, with no event for it', () => {
    const events = normalize([prompt('first')]);
    expect(events.map((event) => event['segment'])).toEqual([0, 0]);
    expect(kinds(events)).not.toContain('segment.start');
  });

  it('opens the next segment at each compaction, and marks the boundary', () => {
    const events = normalize([
      prompt('before'),
      compaction('auto'),
      prompt('between'),
      compaction('manual'),
      prompt('after'),
    ]);
    expect(events.filter((event) => event.kind === 'segment.start')).toMatchObject([
      { index: 1, trigger: 'auto', segment: 1 },
      { index: 2, trigger: 'manual', segment: 2 },
    ]);
    expect(
      events.filter((event) => event.kind === 'prompt.submit').map((event) => event['segment']),
    ).toEqual([0, 1, 2]);
  });

  it('counts segments per stream, so a new stream starts at 0 again', () => {
    const normalizer = createNormalizer();
    normalizer.accept(compaction('auto'), MAIN);
    // Switching streams first ends the main one, in ITS segment; the subagent's own starts at 0.
    const events = [...normalizer.accept(prompt('in a subagent'), SUB)];
    expect(events.map((event) => [event.kind, event['segment']])).toEqual([
      ['session.end', 1],
      ['prompt.submit', 0],
    ]);
  });
});

/**
 * `hook.delivery` (asc-xn4g): a hook's injected context, read off the harness's own `attachment`
 * record. This is the ONLY thing that makes a delivery checkable -- without it, replay sees a
 * transcript in which a withheld sentence and a delivered one are identical, and the AFTER arm of
 * a holdout comparison cannot be split.
 *
 * The fields here come from a real record read out of `~/.claude/projects` on 2026-10-12 (read-only).
 * `stdout` is present on the real record too and is deliberately NOT read: `content` is the stdin the
 * harness handed the hook, which is the injected text, and hashing one of two equal strings is enough.
 */
describe('hook.delivery', () => {
  const attachment = (attachment: Record<string, unknown>): TranscriptRecord => ({
    type: 'attachment',
    sessionId: 'sess-1',
    timestamp: TS,
    attachment,
  });

  const hookSuccess = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'hook_success',
    hookName: 'asc hook PostToolUse',
    hookEvent: 'PostToolUse',
    toolUseID: 't1',
    command: 'asc hook PostToolUse',
    exitCode: 0,
    content: 'a sentence',
    stdout: 'a sentence',
    stderr: '',
    durationMs: 12,
    ...fields,
  });

  const deliveries = (records: readonly TranscriptRecord[]): NormalizedEvent[] =>
    normalize(records).filter((event) => event.kind === 'hook.delivery');

  /**
   * A copy of `fields` carrying only the keys not named, built by FILTERING rather than by deleting.
   *
   * A destructuring rest discards a binding, which is an unused variable under this repo's lint
   * config (it exempts no prefix), and `delete copy[key]` trips `no-dynamic-delete`, which
   * `corpus.test.ts` avoids only because its key is a literal. Filtering the entries sidesteps both
   * and needs no per-key copy of the helper.
   */
  const without = (
    fields: Record<string, unknown>,
    keys: readonly string[],
  ): Record<string, unknown> =>
    Object.fromEntries(Object.entries(fields).filter(([name]) => !keys.includes(name)));

  const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

  it('emits the event, the command, the exit status and the digest of what was injected', () => {
    expect(deliveries([attachment(hookSuccess())])).toMatchObject([
      {
        id: 't1',
        hook_event: 'PostToolUse',
        command: 'asc hook PostToolUse',
        exit_code: 0,
        bytes: 10,
        sha256: digest('a sentence'),
      },
    ]);
  });

  it('does NOT carry the injected text, so the log holds no second copy of it', () => {
    // The absence IS the design: replay recomputes the sentence from the handlers and compares
    // the digest, so storing `content` would put every injected sentence in the event log twice,
    // and that log is measured rolling at ~1.33 MB/day (EV-39 Q1). A test asserting `content` were
    // present would be pinning the thing the kind's docblock argues against.
    const [event] = deliveries([attachment(hookSuccess())]);
    expect(event?.['content']).toBeUndefined();
    expect(Object.values(event ?? {})).not.toContain('a sentence');
  });

  it('leaves `id` ABSENT when the hook ran for no tool call, rather than defaulting it to empty', () => {
    // Every `SessionStart` hook is this case. An empty id would join to nothing in the `decided`
    // log while looking like a key that does -- the same reason the envelope omits absent fields.
    const [event] = deliveries([attachment(without(hookSuccess(), ['toolUseID']))]);
    expect(event).toBeDefined();
    expect('id' in (event ?? {})).toBe(false);
  });

  it('counts BYTES rather than characters, so a multibyte sentence is not reported short', () => {
    // A replay judges truncation by comparing `bytes` against the recomputed sentence, so a
    // character count would read a 3-byte em dash as a one-byte difference and call a verbatim
    // delivery truncated. `Buffer.byteLength` and `.length` differ on exactly this input.
    const content = 'naïve — ok';
    const [event] = deliveries([attachment(hookSuccess({ content }))]);
    expect(event?.['bytes']).toBe(Buffer.byteLength(content, 'utf8'));
    expect(event?.['bytes']).not.toBe(content.length);
    expect(event?.['sha256']).toBe(digest(content));
  });

  it('leaves `exit_code` absent when the record carries none, rather than defaulting to zero', () => {
    // Zero is a MEASURED outcome -- the hook ran and succeeded -- so writing it for a record that
    // said nothing would make an unrecorded run indistinguishable from a clean one.
    const [event] = deliveries([attachment(without(hookSuccess(), ['exitCode']))]);
    expect('exit_code' in (event ?? {})).toBe(false);
  });

  it('leaves `command` and `hook_event` absent rather than writing the empty string', () => {
    // An empty string IS a value: a reader filtering on `command !== ''` to find the hooks that
    // named themselves would be counting this default as a measurement.
    const [event] = deliveries([attachment(without(hookSuccess(), ['command', 'hookEvent']))]);
    expect('command' in (event ?? {})).toBe(false);
    expect('hook_event' in (event ?? {})).toBe(false);
    // The digest is still taken: a hook that named neither still ran and still said something.
    expect(event?.['sha256']).toBe(digest('a sentence'));
  });

  it('emits nothing for an attachment that is not a hook, and nothing for a non-attachment', () => {
    // The predicate is one string comparison against the harness's own discriminator, so any value
    // that is not `hook_success` is the same case and one of them stands for all.
    expect(deliveries([attachment(hookSuccess({ type: 'file' }))])).toEqual([]);
    expect(deliveries([prompt('a sentence')])).toEqual([]);
  });

  it('counts a redelivered hook twice, because each run is its own record', () => {
    // Deliberately NOT deduplicated the way `agent.return` is: two `hook_success` records are two
    // runs of the hook, and collapsing them would hide a hook that fired twice for one call --
    // which is the delivery defect the AFTER arm exists to find.
    expect(deliveries([attachment(hookSuccess()), attachment(hookSuccess())])).toHaveLength(2);
  });
});

describe('model.context', () => {
  const contexts = (events: readonly NormalizedEvent[]): NormalizedEvent[] =>
    events.filter((event) => event.kind === 'model.context');

  it('emits the stream model and harness version once, before the calls it accounts for', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
    ]);
    // toStrictEqual, not toEqual: `previous_model` must be ABSENT rather than present-and-
    // undefined, and `toEqual` cannot tell those two apart. A stream's first emission has no
    // previous model, and a fabricated empty string would be indistinguishable from a model the
    // harness spelled "".
    expect(contexts(events)).toStrictEqual([
      {
        kind: 'model.context',
        session_id: 'sess-1',
        agent_id: 'main',
        seq: 0,
        call: 0,
        ts: TS,
        derive_version: EVENT_DERIVE_VERSION,
        segment: 0,
        model: 'claude-opus-5',
        harness_version: '2.1.283',
      },
    ]);
    expect(kinds(events)).toEqual(['model.context', 'tool.use.start', 'session.end']);
  });

  it('emits again on a model change, naming the model it left', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2', 'claude-sonnet-5', '2.1.283'),
    ]);
    expect(contexts(events).map((event) => [event['model'], event['previous_model']])).toEqual([
      ['claude-opus-5', undefined],
      ['claude-sonnet-5', 'claude-opus-5'],
    ]);
  });

  it('does not emit again while the same model repeats', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't3', name: 'Read' }], 'm3', 'claude-opus-5', '2.1.283'),
    ]);
    expect(contexts(events)).toHaveLength(1);
  });

  it('emits on a harness version change, with no previous_model, which did not change', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2', 'claude-opus-5', '2.1.284'),
    ]);
    const seen = contexts(events);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.['harness_version']).toBe('2.1.284');
    // Absent, because the only thing that changed is which harness was running. Rendering
    // `previous_model` here would make a version change read as a model change.
    expect(Object.hasOwn(seen[1] as NormalizedEvent, 'previous_model')).toBe(false);
  });

  it('never emits <synthetic> as a model, and counts what it skipped', () => {
    const normalizer = createNormalizer();
    const events = [
      ...normalizer.accept(
        assistant([{ id: 't1', name: 'Read' }], 'm0', '<synthetic>', '2.1.283'),
        MAIN,
      ),
      ...normalizer.accept(
        assistant([{ id: 't2', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
        MAIN,
      ),
      ...normalizer.drain(),
    ];
    // The synthetic record comes FIRST, so a skip that still advanced the state would leave the
    // real model looking like a change from a model that was never serving anything.
    expect(contexts(events).map((event) => event['model'])).toEqual(['claude-opus-5']);
    expect(normalizer.counters.syntheticModelRecords).toBe(1);
  });

  it('emits nothing for a stream with no assistant record', () => {
    // `not_applicable` is not expressible as an event and absence already means `not_measured`,
    // so a row here would be a fabricated value rather than a measurement -- the same defect as
    // a defaulted cost, in the other direction.
    expect(contexts(normalize([prompt('hello')]))).toEqual([]);
  });

  it('does not read a record that carried no model as a change to nothing', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2'),
      assistant([{ id: 't3', name: 'Read' }], 'm3', 'claude-opus-5', '2.1.283'),
    ]);
    expect(contexts(events)).toHaveLength(1);
  });

  it('carries the last model forward when a version change arrives on a record with no model', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2', undefined, '2.1.284'),
    ]);
    const seen = contexts(events);
    expect(seen).toHaveLength(2);
    // The model is the one still serving the stream. Dropping it would emit a row with no model
    // under a kind named for the model -- a row a stratification query cannot use.
    expect(seen[1]?.['model']).toBe('claude-opus-5');
    expect(seen[1]?.['harness_version']).toBe('2.1.284');
  });

  it('emits nothing at all when no record in the stream carries a model', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', undefined, '2.1.283'),
      assistant([{ id: 't2', name: 'Read' }], 'm2', undefined, '2.1.284'),
    ]);
    expect(contexts(events)).toEqual([]);
  });

  it('starts over at a new stream, so the second stream gets its own context', () => {
    const normalizer = createNormalizer();
    const events = [
      ...normalizer.accept(
        assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
        MAIN,
      ),
      ...normalizer.accept(
        assistant([{ id: 't1', name: 'Read' }], 'm1', 'claude-opus-5', '2.1.283'),
        SUB,
      ),
      ...normalizer.drain(),
    ];
    // Without the reset in `begin`, a subagent stream inheriting the main stream's model would
    // emit no context at all -- silently, and only for the second stream onward.
    expect(contexts(events).map((event) => event['agent_id'])).toEqual(['main', 'abc123']);
  });

  it('carries a model name through unchanged, because the vocabulary is not ours', () => {
    const events = normalize([
      assistant([{ id: 't1', name: 'Read' }], 'm1', 'deepseek-v4.1-flash:cloud', '2.1.283'),
    ]);
    // `agent.spawn.model` spells this same model `deepseek-v4.1-flash`. Two fields spelling one
    // model differently is why the field is a string and not an enum (derived-types.ts).
    expect(contexts(events)[0]?.['model']).toBe('deepseek-v4.1-flash:cloud');
  });

  it('declares all three fields as strings', () => {
    for (const field of ['model', 'previous_model', 'harness_version']) {
      expect(eventFieldType('model.context', field)).toBe('string');
    }
  });
});

/**
 * `review.finding` (asc-gtnu): the harness's own `ReportFindings` call, one event per finding.
 *
 * Every test here is exercised by a FIXTURE and by nothing else. That is not a caveat in the
 * usual sense -- it is the state of the world: re-measured 2026-09-26, `ReportFindings` has been
 * called 0 times across 1,236 transcript files and 637,258 records, so no real corpus can produce
 * one of these events. `normalize-real-corpus.test.ts` asserts the opposite direction and says so.
 */
describe('review.finding, from a ReportFindings call', () => {
  const REPORT = (findings: readonly Record<string, unknown>[], level = 'medium') => ({
    id: 't-report',
    name: 'ReportFindings',
    input: { findings, level },
  });

  const FINDING = (over: Record<string, unknown> = {}) => ({
    file: 'packages/core/src/state.ts',
    line: 412,
    summary: 'The writer accepts a trailing separator the reader rejects.',
    failure_scenario: 'state.ts:412 writes "a/" and line 88 splits without filtering the tail.',
    category: 'write_read_asymmetry',
    verdict: 'CONFIRMED',
    ...over,
  });

  const findings = (events: readonly NormalizedEvent[]): NormalizedEvent[] =>
    events.filter((event) => event.kind === 'review.finding');

  it('emits one event per element, sharing the call id and numbered by position', () => {
    const events = findings(
      normalize([assistant([REPORT([FINDING(), FINDING({ file: 'packages/cli/src/bin.ts' })])])]),
    );
    // Two findings, two events -- not one event carrying an array. Per element so a handler can
    // `first` on a single finding without an `each` fan-out around it.
    expect(events).toHaveLength(2);
    // `id` names the CALL and is therefore the same on both, exactly as `command.run` shares
    // one. `index` is what makes an event addressable, and `(id, index)` is the entry's key.
    expect(events.map((event) => event['id'])).toEqual(['t-report', 't-report']);
    expect(events.map((event) => event['index'])).toEqual([0, 1]);
    expect(events.map((event) => event['file'])).toEqual([
      'packages/core/src/state.ts',
      'packages/cli/src/bin.ts',
    ]);
  });

  it('orders the findings after the call, on the call it belongs to', () => {
    const events = normalize([assistant([REPORT([FINDING()])])]);
    expect(kinds(events)).toEqual(['tool.use.start', 'review.finding', 'session.end']);
    // Same `call` and the same `batch` as the `tool.use.start`, because they are the same call.
    expect(events.slice(0, 2).map((event) => event.call)).toEqual([1, 1]);
    expect(events.slice(0, 2).map((event) => event.batch)).toEqual([1, 1]);
  });

  it('carries the call level on every finding, and all eight fields the kind declares', () => {
    const [event] = findings(normalize([assistant([REPORT([FINDING()], 'high')])]));
    expect(event).toMatchObject({
      id: 't-report',
      index: 0,
      category: 'write_read_asymmetry',
      file: 'packages/core/src/state.ts',
      line: 412,
      summary: 'The writer accepts a trailing separator the reader rejects.',
      failure_scenario: 'state.ts:412 writes "a/" and line 88 splits without filtering the tail.',
      verdict: 'CONFIRMED',
      level: 'high',
    });
    // The declared field set, checked against the kind rather than against this literal: a field
    // added here without being declared would be invisible to every handler's `where`.
    for (const field of Object.keys(event ?? {})) {
      if (field === 'kind' || field === 'session_id' || field === 'agent_id') continue;
      if (field === 'seq' || field === 'call' || field === 'batch' || field === 'ts') continue;
      if (field === 'derive_version') continue;
      expect(eventFieldType('review.finding', field), field).toBeDefined();
    }
  });

  it('carries the model of the record that made the call, as the store entry does', () => {
    const events = findings(
      normalize([assistant([REPORT([FINDING()])], 'msg-1', 'claude-sonnet-5')]),
    );
    expect(events.map((event) => event['reviewer_model'])).toEqual(['claude-sonnet-5']);
  });

  it('OMITS reviewer_model when the record names no model', () => {
    const [event] = findings(normalize([assistant([REPORT([FINDING()])])]));
    expect(event).not.toHaveProperty('reviewer_model');
  });

  it('OMITS line when the finding was not line-anchored, rather than writing 0', () => {
    const [event] = findings(normalize([assistant([REPORT([FINDING({ line: undefined })])])]));
    // `0` is a line number a reader would believe, and a finding about a whole file has none.
    expect(event).not.toHaveProperty('line');
  });

  it('carries a category outside the nine VERBATIM, and counts it rather than dropping it', () => {
    const normalizer = createNormalizer();
    const events = [
      ...normalizer.accept(
        assistant([REPORT([FINDING({ category: 'off_by_one' }), FINDING()])]),
        MAIN,
      ),
      ...normalizer.drain(),
    ];
    // Both events exist. A `continue` on the unknown value is the silent filter this project
    // counts instead of writing: the log would show a review that reported two findings and
    // hold one, with nothing saying which went.
    expect(findings(events)).toHaveLength(2);
    expect(findings(events)[0]?.['category']).toBe('off_by_one');
    expect(normalizer.counters.offVocabularyFindings).toBe(1);
  });

  it('emits nothing, and counts nothing, when the call carries no findings array', () => {
    const normalizer = createNormalizer();
    const events = [
      ...normalizer.accept(assistant([{ id: 't-report', name: 'ReportFindings' }]), MAIN),
      ...normalizer.drain(),
    ];
    expect(findings(events)).toEqual([]);
    // Not a drop: there was no finding to lose. The tool call itself is still an event, which is
    // what makes "a review ran and reported nothing" distinguishable from "no review ran".
    expect(kinds(events)).toEqual(['tool.use.start', 'session.end']);
    expect(normalizer.counters.offVocabularyFindings).toBe(0);
  });

  it('leaves a call to any other tool alone, even one named like a report', () => {
    const events = normalize([assistant([{ id: 't1', name: 'ReportFindings2' }])]);
    expect(kinds(events)).toEqual(['tool.use.start', 'session.end']);
  });

  it('declares index and line as numbers, and the rest as strings', () => {
    expect(eventFieldType('review.finding', 'index')).toBe('number');
    expect(eventFieldType('review.finding', 'line')).toBe('number');
    for (const field of [
      'id',
      'category',
      'file',
      'summary',
      'failure_scenario',
      'verdict',
      'level',
      'reviewer_model',
    ]) {
      expect(eventFieldType('review.finding', field), field).toBe('string');
    }
  });

  it('pins the derivation version as a LITERAL, so a bump is deliberate', () => {
    // 13: `tool.use.end` carries `bytes`, `hook.context` is a new kind, and `tool.use.start`
    // carries `head`/`argv` for an exec call (asc-09wx.8.4, asc-hvnx).
    // 12: `hook.delivery` reads a `hook_success` attachment (asc-xn4g).
    // 11: every event carries `segment`; a compaction is `segment.start` (asc-73cb).
    // 10: `check.run` carries `paths` (asc-gtnu.10).
    // 9: `review.finding` carries `reviewer_model` (asc-gtnu.11).
    // 8: a notification after the harness preamble is read (asc-wkmq).
    // 7: shell segments read quotes (asc-7gz2).
    // 6: `agent.return` is read from queue-operation and attachment records too (asc-ggd4).
    // 5: `tool.use.start` names the skill a `Skill` call loads (asc-tuur.2). 4: `review.finding`. Asserted as a number rather than against the constant, which would be
    // tautological. The version exists so a count that moves between two replays can be
    // attributed to the normalizer rather than to a handler, and that only works if changing it
    // is a decision someone makes on purpose.
    expect(EVENT_DERIVE_VERSION).toBe(13);
  });
});

describe('tool.use.start, for a Skill call (asc-tuur.2)', () => {
  const starts = (events: readonly NormalizedEvent[]): NormalizedEvent[] =>
    events.filter((event) => event.kind === 'tool.use.start');

  it('names the skill the call loads', () => {
    const [start] = starts(
      normalize([assistant([{ id: 't1', name: 'Skill', input: { skill: 'bug-hunt' } }])]),
    );
    expect(start).toMatchObject({ tool: 'Skill', id: 't1', skill: 'bug-hunt' });
  });

  it('names it inside a subagent too, where a review is often run', () => {
    const [start] = starts(
      normalize([assistant([{ id: 't1', name: 'Skill', input: { skill: 'bug-hunt' } }])], SUB),
    );
    expect(start?.['skill']).toBe('bug-hunt');
  });

  it('leaves skill ABSENT when the call carries no skill name, rather than writing ""', () => {
    const [start] = starts(normalize([assistant([{ id: 't1', name: 'Skill', input: {} }])]));
    expect(start).not.toHaveProperty('skill');
  });

  it('gives no other tool a skill field', () => {
    const [start] = starts(
      normalize([assistant([{ id: 't1', name: 'Bash', input: { skill: 'bug-hunt' } }])]),
    );
    expect(start).not.toHaveProperty('skill');
  });

  it('declares skill as a string, so a handler can match on it', () => {
    expect(eventFieldType('tool.use.start', 'skill')).toBe('string');
  });
});

/**
 * `tool.use.start`, for the command a call is about to run (asc-hvnx).
 *
 * `command.run` carries the same two names, and it is emitted from the tool RESULT -- so by the time
 * it exists, the command has already run. A handler that has to be selective BEFORE a command, which
 * is what a PRE-tool-use stage is for, has only this event.
 */
describe('tool.use.start, for the command it is about to run (asc-hvnx)', () => {
  const starts = (records: readonly TranscriptRecord[]): NormalizedEvent[] =>
    normalize(records).filter((event) => event.kind === 'tool.use.start');

  const bash = (command: string): TranscriptRecord =>
    assistant([{ id: 't1', name: 'Bash', input: { command } }]);

  it('carries the head and the tokens of a shell command', () => {
    expect(starts([bash('bd close asc-1')])).toMatchObject([
      { tool: 'Bash', role: 'exec', head: 'bd', argv: ['bd', 'close', 'asc-1'] },
    ]);
  });

  it('flattens the tokens ACROSS segments, which is what a commit predicate needs', () => {
    // MEASURED 2026-10-15 over 2,496 transcript files: of 162,906 `Bash` calls, `[git, commit]` sits
    // in the FIRST segment of 306 and ONLY in a later one of 3,508 -- so an `argv` holding segment 0
    // alone makes a `followed_by: [git, commit]` predicate miss 92% of commits, and a nudge built on
    // it fires on 8% while reading as working. This is that shape, and the assert below is the
    // predicate itself rather than the array spelling: what has to survive is that the pair is
    // ADJACENT in the flat list.
    const [start] = starts([bash('git add a.mjs && git status --short && git commit -m y')]);
    const argv = start?.['argv'] as readonly string[];
    expect(argv).toEqual([
      'git',
      'add',
      'a.mjs',
      'git',
      'status',
      '--short',
      'git',
      'commit',
      '-m',
      'y',
    ]);
    expect(argv.some((one, index) => one === 'git' && argv[index + 1] === 'commit')).toBe(true);
  });

  it('drops a bare `cd` the way the segment split does, so head is the first real command', () => {
    // `cd /tmp` is a step, not a command: `execSegments` yields no segment for it. Both spellings go
    // through the same function, so `tool.use.start` and `command.run` agree about what a command is
    // -- and a handler matching `head: git` is not defeated by a leading `cd`.
    const [start] = starts([bash('cd /tmp && git commit -m y')]);
    expect(start?.['head']).toBe('git');
    expect(start?.['argv']).toEqual(['git', 'commit', '-m', 'y']);
  });

  it('leaves both ABSENT on a call that runs no shell command, rather than writing []', () => {
    // A handler matching `head` on a `Read` then matches NOTHING. Writing `[]` instead would make it
    // match an exec call that ran no segment, which is a different and reachable record.
    const [start] = starts([assistant([{ id: 't1', name: 'Read', input: { file_path: '/x' } }])]);
    expect(start?.['role']).toBe('read');
    expect('head' in (start ?? {})).toBe(false);
    expect('argv' in (start ?? {})).toBe(false);
  });

  it('declares both with the types a `where` checks literals against', () => {
    // The kind is what lets the strict loader refuse a typo by name; the TYPE is what refuses a
    // `followed_by` on `head` or an `eq` on `argv`. Without the two together a handler over these
    // fields is a `where` that is silently never true.
    expect(eventFieldType('tool.use.start', 'head')).toBe('string');
    expect(eventFieldType('tool.use.start', 'argv')).toBe('array');
  });
});

/**
 * `tool.use.end`, for the bytes its result carried (asc-09wx.8.4).
 *
 * This is the field that makes `EV-54`'s context tax countable. That review found three detectors,
 * one of which paid -- the context tax -- and the one that paid could not be written as a handler,
 * because an event carried no size. The same quantity under the same name is on `hook.context`.
 */
describe('tool.use.end, for the bytes its result carried (asc-09wx.8.4)', () => {
  const ends = (records: readonly TranscriptRecord[]): NormalizedEvent[] =>
    normalize(records).filter((event) => event.kind === 'tool.use.end');

  const call = assistant([{ id: 't1', name: 'Read', input: { file_path: '/x' } }]);

  /** A result whose `content` is whatever the caller says, which the shared helper cannot express. */
  const result = (content: unknown): TranscriptRecord => ({
    type: 'user',
    sessionId: 'sess-1',
    timestamp: TS,
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content }] },
  });

  it('counts the bytes of a result that is one string', () => {
    const [event] = ends([call, result('hello')]);
    expect(event?.['bytes']).toBe(5);
  });

  it('counts a result written as content BLOCKS, the other spelling in the corpus', () => {
    // Both spellings occur, and reading only the string one would report every block-shaped result
    // as carrying nothing -- a false zero, which is the class `EV-54` could not count and the reason
    // `hook.context` exists as a kind rather than a widened field.
    const [event] = ends([
      call,
      result([
        { type: 'text', text: 'hello' },
        { type: 'text', text: '!' },
      ]),
    ]);
    expect(event?.['bytes']).toBe(6);
  });

  it('counts BYTES rather than characters, so a multibyte result is not reported short', () => {
    // The whole use of the number is a SUM a reader compares against a budget, so a character count
    // would under-report exactly the non-English text a context tax is most likely to contain.
    const text = 'naïve — ok';
    const [event] = ends([call, result(text)]);
    expect(event?.['bytes']).toBe(Buffer.byteLength(text, 'utf8'));
    expect(event?.['bytes']).not.toBe(text.length);
  });

  it('writes a real ZERO for an empty result, which is not the same as no result', () => {
    // The harness wrote a result and it was empty. That is a measurement, and it belongs in a sum.
    const [event] = ends([call, result('')]);
    expect(event?.['bytes']).toBe(0);
  });

  it('leaves `bytes` ABSENT when the record carried no result text, rather than writing zero', () => {
    // The other side of the pair above: nothing to measure is not a measurement of nothing. Folding
    // it into the zero bucket would make a reader's sum quietly wrong instead of visibly short.
    const [event] = ends([call, result(undefined)]);
    expect('bytes' in (event ?? {})).toBe(false);
  });

  it('is a number, so a handler can compare it against a budget', () => {
    expect(eventFieldType('tool.use.end', 'bytes')).toBe('number');
  });
});

/**
 * `hook.context` (asc-09wx.8.4): the context a hook ATTACHED, read off the harness's own
 * `hook_additional_context` attachment.
 *
 * A different record from `hook.delivery`, and why is measured rather than argued. Read-only over
 * this machine's `~/.claude/projects` on 2026-10-15 (2,496 files): 672 such records, every one
 * carrying `content` as a ONE-ELEMENT ARRAY of strings. Three consecutive records of ONE real run in
 * this checkout's own transcript: a `hook_success` with empty content, a SECOND `hook_success`
 * carrying the same `toolUseID` and 3,567 bytes of the hook's own output, and this record -- whose
 * `toolUseID` is the hook EVENT NAME `SessionStart` and whose content, 1,538 bytes, is the wrapper
 * below. The model was handed those 1,538 and neither of the other two.
 *
 * Both record shapes below are transcribed from that run rather than invented.
 */
describe('hook.context', () => {
  const attachment = (attachment: Record<string, unknown>): TranscriptRecord => ({
    type: 'attachment',
    sessionId: 'sess-1',
    timestamp: TS,
    attachment,
  });

  const attached = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'hook_additional_context',
    hookEvent: 'SessionStart',
    hookName: 'SessionStart',
    toolUseID: 'SessionStart',
    content: ['the index'],
    ...fields,
  });

  const contexts = (records: readonly TranscriptRecord[]): NormalizedEvent[] =>
    normalize(records).filter((event) => event.kind === 'hook.context');

  /** A `hook_success` sibling, as the harness writes it: a different record with a different id. */
  const hookSuccess = (content: string): Record<string, unknown> => ({
    type: 'hook_success',
    hookEvent: 'SessionStart',
    hookName: 'SessionStart:startup',
    toolUseID: 'd18d2d1a-3ac4-41d7-a939-c26f8a717a0a',
    command: 'node .claude/bd-prime-hook.mjs',
    exitCode: 0,
    content,
  });

  /** The persisted arm's content verbatim, as the harness writes it in place of the text. */
  const WRAPPER = [
    '<persisted-output>\n',
    'Output too large (46.3KB). Full output saved to: /Users/me/.claude/projects/x/tool-results/a.txt\n\n',
    'Preview (first 2KB):\n',
    '[bd prime] If this output is truncated by your host, read the full persisted hook output',
  ].join('');

  it('emits the hook that attached it and the bytes it put in front of the model', () => {
    expect(contexts([attachment(attached())])).toMatchObject([
      { hook_event: 'SessionStart', hook_name: 'SessionStart', bytes: 9, persisted: false },
    ]);
  });

  it('reads `persisted: false` and counts the text itself for an inlined delivery', () => {
    const [event] = contexts([attachment(attached({ content: ['a sentence'] }))]);
    expect(event?.['persisted']).toBe(false);
    expect(event?.['bytes']).toBe(Buffer.byteLength('a sentence', 'utf8'));
  });

  it('reads `persisted: true` off the wrapper, and counts the WRAPPER the model received', () => {
    // The number is small by construction, and that is the honest one: what reached the model is the
    // wrapper and its 2 KB preview, not the 46.3 KB the wrapper names. Counting the delivered text
    // instead would need the persisted FILE, which the log does not hold and a replay cannot be
    // handed -- so the field reports what is on the record and `persisted` says which arm it is.
    const [event] = contexts([attachment(attached({ content: [WRAPPER] }))]);
    expect(event?.['persisted']).toBe(true);
    expect(event?.['bytes']).toBe(Buffer.byteLength(WRAPPER, 'utf8'));
    expect(event?.['bytes']).toBeLessThan(1024);
  });

  it('joins a multi-element array rather than counting only its first element', () => {
    // `content` is an ARRAY on this record. A reader taking element 0 would report a fraction of what
    // the model received while looking like it had measured the whole thing.
    const [whole] = contexts([attachment(attached({ content: ['the ', 'index'] }))]);
    const [part] = contexts([attachment(attached({ content: ['the '] }))]);
    expect(whole?.['bytes']).toBe(9);
    expect(part?.['bytes']).toBe(4);
  });

  it('counts BYTES rather than characters, so a multibyte preview is not reported short', () => {
    const content = 'naïve — ok';
    const [event] = contexts([attachment(attached({ content: [content] }))]);
    expect(event?.['bytes']).toBe(Buffer.byteLength(content, 'utf8'));
    expect(event?.['bytes']).not.toBe(content.length);
  });

  it('does not file a hook that only PRINTS the marker as a preview', () => {
    // The flag is read off the wrapper's exact leading marker rather than guessed from a size, so a
    // hook whose own output began with those words is an inlined delivery. Inferring from the size
    // would also have to be right about every future 2 KB preview length.
    const [event] = contexts([attachment(attached({ content: ['Output too large (46.3KB)'] }))]);
    expect(event?.['persisted']).toBe(false);
    expect(event?.['bytes']).toBe(Buffer.byteLength('Output too large (46.3KB)', 'utf8'));
  });

  it('reads the marker only at the START, so a hook that describes the wrapper is inlined', () => {
    // The anchor is the whole content of the test: a hook explaining the persisted form to a reader
    // prints the marker in the middle of its own text, and an unanchored match would file that
    // delivery -- whose bytes ARE the whole text -- under the arm where bytes is a truncated preview.
    const [event] = contexts([
      attachment(
        attached({
          content: ['A hook that exceeds the limit is replaced by a <persisted-output> wrapper.'],
        }),
      ),
    ]);
    expect(event?.['persisted']).toBe(false);
  });

  it('does NOT carry the injected text, so the log holds no second copy of it', () => {
    // `hook.delivery`'s rule, and the same reason: this population is the largest injected source in
    // `EV-54`, and a 46.3 KB `bd prime` per session is measured rolling at ~1.33 MB/day (`EV-39` Q1).
    const [event] = contexts([attachment(attached({ content: ['a sentence'] }))]);
    expect(event?.['content']).toBeUndefined();
    expect(Object.values(event ?? {})).not.toContain('a sentence');
  });

  it('leaves `hook_event` and `hook_name` absent rather than writing the empty string', () => {
    // An empty string IS a value: a reader filtering on `hook_event !== ''` would be counting this
    // default as a measurement. The bytes are still taken -- a delivery that named neither still put
    // text in the stream.
    const bare = Object.fromEntries(
      Object.entries(attached()).filter(([name]) => name !== 'hookEvent' && name !== 'hookName'),
    );
    const [event] = contexts([attachment(bare)]);
    expect('hook_event' in (event ?? {})).toBe(false);
    expect('hook_name' in (event ?? {})).toBe(false);
    expect(event?.['bytes']).toBe(9);
  });

  it('emits nothing for a `hook_success`, and nothing for a non-attachment', () => {
    // The two records are different facts about one run, and neither stands in for the other: this
    // kind reads one discriminator and any other value is the same case.
    expect(contexts([attachment(hookSuccess('a sentence'))])).toEqual([]);
    expect(contexts([prompt('a sentence')])).toEqual([]);
  });

  it('puts the flag on the context and NOT on the delivery, whose own record cannot say it', () => {
    // The measured defect this kind exists for, in one assertion: BOTH records arrive for one run, the
    // delivery carrying the hook's own output and the context carrying what was attached, and only
    // one of them can be asked whether the text was persisted.
    const events = normalize([
      attachment(hookSuccess('the index')),
      attachment(attached({ content: [WRAPPER] })),
    ]);
    const [delivery] = events.filter((event) => event.kind === 'hook.delivery');
    const [context] = events.filter((event) => event.kind === 'hook.context');
    expect(delivery?.['bytes']).toBe(Buffer.byteLength('the index', 'utf8'));
    expect('persisted' in (delivery ?? {})).toBe(false);
    expect(context?.['persisted']).toBe(true);
  });

  it('counts a redelivered context twice, because each attachment is its own record', () => {
    expect(contexts([attachment(attached()), attachment(attached())])).toHaveLength(2);
  });

  it('declares the two fields a reader needs, with the types a `where` checks', () => {
    expect(eventFieldType('hook.context', 'bytes')).toBe('number');
    expect(eventFieldType('hook.context', 'persisted')).toBe('boolean');
  });
});

/**
 * The bead's own acceptance criterion, stated as a test: *"A handler over hook.delivery can count
 * bytes injected per stream and deliveries that arrived as a preview. The context-tax detector is
 * expressible as a handler, or the reason it is not is recorded."*
 *
 * `compileHandler` is the strict loader every handler file goes through, and it refuses a `where`
 * naming a field its kind does not carry. So "expressible" is not a claim about prose here: the
 * handler below compiles, and the typo below is refused BY NAME.
 */
describe('a handler over the attached context (asc-09wx.8.4)', () => {
  const HANDLER = {
    on: 'hook.context',
    description: 'How much context a hook attached, and whether it arrived as a preview.',
    where: { hook_event: { eq: 'SessionStart' } },
    emit: {
      bytes: '${bytes}',
      persisted: '${persisted}',
      hook_event: '${hook_event}',
    },
  };

  it('compiles a handler that reads the delivered bytes and the persisted flag', () => {
    // One row per attached context. "Per stream" is a sum over these rows, which is what every
    // handler's count is -- `emit` writes a row, and the reader aggregates.
    expect(() => compileHandler(HANDLER)).not.toThrow();
    expect(compileHandler(HANDLER).on).toBe('hook.context');
  });

  it('compiles one that selects only the previews, the worst arm of the tax', () => {
    expect(() => compileHandler({ ...HANDLER, where: { persisted: { eq: true } } })).not.toThrow();
  });

  it('refuses a field name this kind does not carry, and names it', () => {
    // The severity-zero case the flat registry exists for: without it, `bytse` is a `where` that is
    // silently never true -- a handler that runs green and matches nothing.
    expect(() => compileHandler({ ...HANDLER, emit: { bytse: '${bytse}' } })).toThrow(
      /hook\.context has no field "bytse"/u,
    );
  });

  it('refuses a literal of the wrong type, so a numeric budget cannot be written as a string', () => {
    expect(() => compileHandler({ ...HANDLER, where: { bytes: { eq: 'big' } } })).toThrow(
      /the field is a number/u,
    );
  });

  it('refuses `matches` on the byte count, which is not a string', () => {
    expect(() => compileHandler({ ...HANDLER, where: { bytes: { matches: '^1' } } })).toThrow(
      /matches needs a string field/u,
    );
  });
});

/**
 * asc-hvnx's own measurement, turned the other way round and stated as a test.
 *
 * The bead says, verbatim: *"Four pre-tool-use selectors tried through the strict loader with
 * `say:` + `stage: pre`. `argv contains commit`, `argvs`, and `head git` are each REFUSED
 * (`"tool.use.start has no field ..."`); only `tool: {eq: Bash}` loads."* That was true of the kind
 * before the two fields existed, and it is why the bead was filed: a hook that fires BEFORE a
 * command could not read the command. The handler below is the one it was filed for, and the
 * refusals beside it pin the other end -- a field this kind does not carry is still refused BY NAME,
 * so this is two fields arriving rather than the loader loosening.
 */
describe('a pre-tool-use handler that can be selective about the command (asc-hvnx)', () => {
  const starts = (records: readonly TranscriptRecord[]): NormalizedEvent[] =>
    normalize(records).filter((event) => event.kind === 'tool.use.start');

  const bash = (command: string): TranscriptRecord =>
    assistant([{ id: 't1', name: 'Bash', input: { command } }]);

  /** The handler asc-hvnx was filed for: fire before a commit, and on nothing else. */
  const HANDLER = {
    on: 'tool.use.start',
    description: 'Say something before a commit runs.',
    stage: 'pre',
    where: { argv: { followed_by: ['git', 'commit'] } },
    say: 'About to commit.',
  };

  it('compiles a `say:` + `stage: pre` handler that selects a commit by an adjacent pair', () => {
    // This is the four-selector measurement's outcome, as an assertion: `argv` is an array, so
    // `followed_by` takes it, and the pair is the predicate rather than the array spelling. This
    // document is refused by the kind as the bead measured it -- `head` and `argv` did not exist --
    // whether or not the bead's own probe spelled the pair exactly this way.
    expect(() => compileHandler(HANDLER)).not.toThrow();
    expect(compileHandler(HANDLER).sayStage).toBe('pre');
  });

  it('loads every selector the bead measured as REFUSED, not just the tightest one', () => {
    // `tool` was the ONE that loaded. The other three are the ones the measurement is about, so
    // each is asserted on its own rather than only in the combination above -- a `where` combining
    // them would still load if one of them were refused and the test caught only the throw.
    for (const where of [
      { tool: { eq: 'Bash' } },
      { head: { eq: 'git' } },
      { argv: { contains: 'commit' } },
      { argv: { followed_by: ['git', 'commit'] } },
    ]) {
      expect(() => compileHandler({ ...HANDLER, where })).not.toThrow();
    }
  });

  it('fires on a commit that is not the first command in the line', () => {
    // The case the field exists for, and the one a `head`-only predicate cannot express: measured
    // over 2,496 transcript files, `[git, commit]` is in the FIRST segment of 306 `Bash` calls and
    // only in a LATER one of 3,508. A predicate keyed on the segment would miss 92% of commits.
    const [start] = starts([bash('git add a.mjs && git commit -m y')]);
    expect(compileHandler(HANDLER).where(start as NormalizedEvent, () => undefined)).toBe(true);
  });

  it('does not fire on a git command that is not a commit, or on a call that runs no command', () => {
    // Both conjuncts are load-bearing: `git status` has the head but not the pair, and a `Read`
    // carries neither field -- so a handler matching `head` on a non-exec call matches NOTHING
    // rather than everything, which is the absent-not-empty decision one describe above.
    const [status] = starts([bash('git status --short')]);
    const [read] = starts([assistant([{ id: 't1', name: 'Read', input: { file_path: '/x' } }])]);
    const where = compileHandler(HANDLER).where;
    expect(where(status as NormalizedEvent, () => undefined)).toBe(false);
    expect(where(read as NormalizedEvent, () => undefined)).toBe(false);
  });

  it('refuses `followed_by` on `head`, which is a string rather than an array', () => {
    expect(() =>
      compileHandler({ ...HANDLER, where: { head: { followed_by: ['git', 'commit'] } } }),
    ).toThrow(/followed_by needs an array field/u);
  });

  it('still refuses a field name this kind does not carry, and names it', () => {
    // The refusals the bead measured are gone BECAUSE the fields now exist -- not because the
    // loader loosened. A name that is still not on `tool.use.start` is refused the same way.
    expect(() => compileHandler({ ...HANDLER, where: { cwd: { eq: '/tmp' } } })).toThrow(
      /tool\.use\.start has no field "cwd"/u,
    );
  });
});
