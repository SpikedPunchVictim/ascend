import { describe, expect, it } from 'vitest';
import { HandlerError, compileHandler, runHandler, type NormalizedEvent } from '../src/index.js';

/**
 * `say:` handlers (asc-tuur.4): a handler whose row is one sentence for the model, printed by a
 * lifecycle hook at the moment its trigger happens. Hand-built events.
 */

const skill = (name: string): NormalizedEvent => ({
  kind: 'tool.use.start',
  session_id: 's1',
  agent_id: 'main',
  seq: 1,
  call: 1,
  derive_version: 5,
  tool: 'Skill',
  id: 'toolu_1',
  role: 'main',
  skill: name,
});

const NUDGE = {
  on: 'tool.use.start',
  where: { tool: 'Skill', skill: { in: ['bug-hunt'] } },
  say: 'Report each finding from ${skill} with ReportFindings.',
};

const refused = (spec: unknown): string => {
  try {
    compileHandler(spec);
  } catch (error) {
    if (error instanceof HandlerError) return error.message;
    throw error;
  }
  return 'ACCEPTED';
};

describe('say: a handler whose row is a sentence for the model', () => {
  it('emits one row whose only field is the rendered sentence', () => {
    const run = runHandler(compileHandler(NUDGE));
    expect(run.accept(skill('bug-hunt')).map((row) => row.fields)).toEqual([
      { say: 'Report each finding from bug-hunt with ReportFindings.' },
    ]);
  });

  it('emits nothing when where does not match', () => {
    const run = runHandler(compileHandler(NUDGE));
    expect(run.accept(skill('commit'))).toEqual([]);
  });

  it('is marked as a say handler, and an emit handler is not', () => {
    expect(compileHandler(NUDGE).say).toBe(true);
    expect(compileHandler({ on: 'tool.use.start', emit: { t: '${tool}' } }).say).toBe(false);
  });

  it('is part of the identity: changing the sentence changes the hash', () => {
    expect(compileHandler(NUDGE).hash).not.toBe(compileHandler({ ...NUDGE, say: 'Other.' }).hash);
  });
});

describe('compileHandler refuses a say handler that a live hook could not run', () => {
  it('refuses say together with emit', () => {
    expect(refused({ ...NUDGE, emit: { t: '${tool}' } })).toMatch(/say: .*emit/);
  });

  it('refuses a say that is not a non-empty string', () => {
    expect(refused({ ...NUDGE, say: '' })).toMatch(/say: must be a non-empty string/);
    expect(refused({ ...NUDGE, say: ['a'] })).toMatch(/say: must be a non-empty string/);
  });

  it.each([
    ['window', { window: { calls: 1, first: { on: 'tool.use.end' } } }],
    ['each', { each: { field: 'argv', as: 'arg' } }],
    ['before', { before: { on: 'model.context' } }],
    ['type', { type: 'review_finding' }],
    ['judged', { judged: ['say'] }],
  ])(
    'refuses say together with %s, which needs events a single hook call does not have',
    (key, extra) => {
      expect(refused({ ...NUDGE, ...extra })).toMatch(new RegExp(`say: .*${key}`));
    },
  );

  it('refuses scope: session, since a hook sees one event', () => {
    expect(refused({ ...NUDGE, scope: 'session' })).toMatch(/say: .*scope/);
  });

  it('refuses an unknown reference in the sentence, as it does in an emit', () => {
    expect(refused({ ...NUDGE, say: '${nope}' })).toMatch(/nope/);
  });

  it('still requires emit on a handler with no say', () => {
    expect(refused({ on: 'tool.use.start' })).toMatch(/emit: is required/);
  });
});

describe('stage: which side of the call a say handler speaks on (asc-eve4)', () => {
  it('is absent unless asked for, so the default stays the caller’s to choose', () => {
    // Not defaulted to `post` here on purpose. Core does not know which lifecycle stages a harness
    // has (asc-tuur.4), so it cannot know that `post` is the measured one -- the front end holds
    // that, and an absent key is how "no preference" is spelled.
    expect(compileHandler(NUDGE).sayStage).toBeUndefined();
    expect(compileHandler({ ...NUDGE, stage: 'post' }).sayStage).toBe('post');
    expect(compileHandler({ ...NUDGE, stage: 'pre' }).sayStage).toBe('pre');
  });

  it('refuses a stage that is neither, rather than defaulting it to one of them', () => {
    // The severity-zero shape this refusal exists for: a typo (or a full stage name) silently
    // becoming `post` would run the handler at a moment its author did not ask for, and nothing
    // in the report would say so.
    expect(refused({ ...NUDGE, stage: 'after' })).toMatch(/stage: .*expected pre or post/);
    expect(refused({ ...NUDGE, stage: 'pre-tool-use' })).toMatch(/stage: .*expected pre or post/);
    expect(refused({ ...NUDGE, stage: true })).toMatch(/stage: .*expected pre or post/);
  });

  it('refuses stage on a handler that does not say anything', () => {
    // A recorded entry is written from the transcript after the fact: there is no moment for it to
    // arrive at, so the key would be a claim about a delivery that cannot happen.
    expect(refused({ on: 'file.changed', stage: 'pre', emit: { p: '${path}' } })).toMatch(
      /stage: .*only .*say/,
    );
  });

  it('is part of the identity: asking for the other side changes the hash', () => {
    // Two handlers that speak the same sentence at different moments are different handlers, and
    // the key has to separate them or one would overwrite the other's entries.
    expect(compileHandler({ ...NUDGE, stage: 'pre' }).hash).not.toBe(compileHandler(NUDGE).hash);
    expect(compileHandler({ ...NUDGE, stage: 'pre' }).hash).not.toBe(
      compileHandler({ ...NUDGE, stage: 'post' }).hash,
    );
  });
});
