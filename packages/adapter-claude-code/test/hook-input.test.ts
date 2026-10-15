import { describe, expect, it } from 'vitest';
import { HOOK_STAGES, hookEvents, stageForKind } from '../src/index.js';

/**
 * Hook inputs as events (asc-tuur.4). The inputs carry the keys the Stage 0 probe measured
 * (`spike/capture-hooks/FINDINGS.md`); values are synthetic.
 */

const postToolUse = (extra: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  cwd: '/work/project',
  hook_event_name: 'PostToolUse',
  tool_name: 'Skill',
  tool_input: { skill: 'bug-hunt' },
  tool_response: { success: true },
  tool_use_id: 'toolu_1',
  ...extra,
});

describe('hookEvents', () => {
  it('turns a PostToolUse on a Skill into the start and end the transcript would give', () => {
    const events = hookEvents('post-tool-use', postToolUse()) ?? [];
    expect(events.map((event) => event.kind)).toEqual([
      'tool.use.start',
      'tool.use.end',
      'session.end',
    ]);
    expect(events[0]).toMatchObject({
      session_id: 's-1',
      agent_id: 'main',
      tool: 'Skill',
      skill: 'bug-hunt',
      id: 'toolu_1',
    });
  });

  it('attributes a call inside a subagent to that agent', () => {
    const events = hookEvents('post-tool-use', postToolUse({ agent_id: 'a1b2' })) ?? [];
    expect(events[0]?.agent_id).toBe('a1b2');
  });

  it('gives a Write its file.changed, with the full content as after', () => {
    const events =
      hookEvents(
        'post-tool-use',
        postToolUse({ tool_name: 'Write', tool_input: { file_path: 'a.md', content: '# x' } }),
      ) ?? [];
    expect(events.find((event) => event.kind === 'file.changed')).toMatchObject({
      path: 'a.md',
      after: '# x',
    });
  });

  it('turns a PreToolUse into the call starting, and nothing the call has not done yet', () => {
    // PreToolUse fires BEFORE the call. The same input shape as post-tool-use minus `tool_response`,
    // and a handler that saw a `tool.use.end` here would be reading a result that does not exist --
    // `spike/exposure/FINDINGS.md` row PRE measured this stage's JSON additionalContext at 2/2, so
    // the stage is real; the end is not.
    const events = hookEvents('pre-tool-use', {
      session_id: 's-1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'bug-hunt' },
      tool_use_id: 'toolu_1',
    });
    expect(events?.map((event) => event.kind)).toEqual(['tool.use.start', 'session.end']);
    expect(events?.[0]).toMatchObject({
      tool: 'Skill',
      skill: 'bug-hunt',
      id: 'toolu_1',
      agent_id: 'main',
    });
  });

  it('returns undefined for a PreToolUse input missing what the call is', () => {
    expect(
      hookEvents('pre-tool-use', {
        session_id: 's-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Skill',
      }),
    ).toBeUndefined();
  });

  it('turns a UserPromptSubmit into a prompt.submit', () => {
    const events = hookEvents('user-prompt-submit', {
      session_id: 's-1',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'review the diff',
    });
    expect(events?.[0]).toMatchObject({ kind: 'prompt.submit', text: 'review the diff' });
  });

  it.each([
    ['not an object', 'nope'],
    ['no session', { ...postToolUse(), session_id: undefined }],
    ['the other stage', { ...postToolUse(), hook_event_name: 'UserPromptSubmit' }],
    ['no tool_use_id', { ...postToolUse(), tool_use_id: undefined }],
  ])('returns undefined for an input that is %s', (_label, input) => {
    expect(hookEvents('post-tool-use', input)).toBeUndefined();
  });
});

describe('stageForKind', () => {
  it('names the stage that delivers a kind, and none for a kind no stage delivers', () => {
    expect(stageForKind('tool.use.start')).toBe('post-tool-use');
    expect(stageForKind('prompt.submit')).toBe('user-prompt-submit');
    expect(stageForKind('session.end')).toBeUndefined();
  });

  it('keeps post-tool-use as the answer for a kind both stages deliver, with no preference given', () => {
    // `tool.use.start` is the one kind two stages deliver. The default is the stage the single live
    // say handler was measured under (`review-finding-nudge`, `spike/exposure/FINDINGS.md`), so it
    // must not move because a second stage was added beside it. Stated as an assertion rather than
    // left to the order the stages happen to be listed in.
    expect(Object.keys(HOOK_STAGES)).toContain('pre-tool-use');
    expect(stageForKind('tool.use.start')).toBe('post-tool-use');
  });

  it('takes a preference when that stage delivers the kind, and falls back when it does not', () => {
    expect(stageForKind('tool.use.start', 'pre-tool-use')).toBe('pre-tool-use');
    // A preference that does not deliver the kind is not obeyed: wanting `prompt.submit` at
    // pre-tool-use does not make it so, and answering pre would promise a hook that never runs.
    expect(stageForKind('prompt.submit', 'pre-tool-use')).toBe('user-prompt-submit');
    expect(stageForKind('tool.use.end', 'pre-tool-use')).toBe('post-tool-use');
    expect(stageForKind('session.end', 'pre-tool-use')).toBeUndefined();
  });
});

describe('the command a live PreToolUse call is about to run (asc-hvnx)', () => {
  // The point of the field is a handler that is selective about a command BEFORE it runs, and a hook
  // is the only place that can act that early. Live and replayed have to say the same thing, or a
  // handler written against `asc handlers check` would fire on the log and never on the session.
  const preToolUse = (command: string): Record<string, unknown> => ({
    session_id: 's-1',
    cwd: '/work/project',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_1',
  });

  it('carries head and argv from a PreToolUse input', () => {
    const events = hookEvents('pre-tool-use', preToolUse('git commit -m y')) ?? [];
    expect(events[0]).toMatchObject({
      kind: 'tool.use.start',
      role: 'exec',
      head: 'git',
      argv: ['git', 'commit', '-m', 'y'],
    });
  });

  it('flattens across segments here too, so the predicate a replay satisfies works live', () => {
    const events = hookEvents('pre-tool-use', preToolUse('git add a.mjs && git commit -m y')) ?? [];
    const argv = events[0]?.['argv'] as readonly string[];
    expect(argv.some((one, index) => one === 'git' && argv[index + 1] === 'commit')).toBe(true);
  });
});
