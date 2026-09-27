import { describe, expect, it } from 'vitest';
import { hookEvents, stageForKind } from '../src/index.js';

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
});
