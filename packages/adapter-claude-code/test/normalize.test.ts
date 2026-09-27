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
    // model differently is why the field is a string and not an enum (derived-types.ts:153).
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
    ]) {
      expect(eventFieldType('review.finding', field), field).toBe('string');
    }
  });

  it('pins the derivation version as a LITERAL, so a bump is deliberate', () => {
    // 4: `review.finding`. Asserted as a number rather than against the constant, which would be
    // tautological. The version exists so a count that moves between two replays can be
    // attributed to the normalizer rather than to a handler, and that only works if changing it
    // is a decision someone makes on purpose.
    expect(EVENT_DERIVE_VERSION).toBe(4);
  });
});
