import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { replayHandlers } from '../src/handler-replay.js';
import { FINDING_LENSES, hookEvents } from '@ascend/adapter-claude-code';
import { runHandler } from '@ascend/core';
import { loadHandler } from '../src/handler-yaml.js';
import { sayStage } from '../src/typed-handlers.js';

/**
 * The handlers this project keeps in `handlers/` (asc-6ola.7).
 *
 * Every file must load under the strict loader, so a handler that stops compiling fails here
 * rather than at activation. The edit pair is also pinned on a fixture: edit-unverified and
 * edit-verified must partition every edit whose window closed, with the edits whose stream ended
 * first counted as unclosed by both -- the invariant the EV-23 counts rest on
 * (411 + 2,583 + 52 = 3,046 on the frozen corpus).
 */

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const HANDLERS = join(repo, 'handlers');
const read = (name: string): string => readFileSync(join(HANDLERS, name), 'utf8');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PROJECT = '-Users-me-app';
let clock = 0;
const at = (): string => {
  clock += 1;
  return `2026-09-24T10:00:${String(clock).padStart(2, '0')}.000Z`;
};

const prompt = (text: string): object => ({
  type: 'user',
  sessionId: 's',
  timestamp: at(),
  message: { content: text },
});

/** A tool call and its successful result. */
const tool = (id: string, name: string, input: object): object[] => [
  {
    type: 'assistant',
    sessionId: 's',
    timestamp: at(),
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] },
  },
  {
    type: 'user',
    sessionId: 's',
    timestamp: at(),
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: '' }] },
  },
];

function corpus(records: readonly object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'asc-project-handlers-'));
  dirs.push(root);
  mkdirSync(join(root, PROJECT));
  writeFileSync(
    join(root, PROJECT, 's.jsonl'),
    `${records.map((one) => JSON.stringify(one)).join('\n')}\n`,
  );
  return root;
}

describe('handlers/', () => {
  it.each(readdirSync(HANDLERS).filter((name) => name.endsWith('.yaml')))(
    '%s loads under the strict loader',
    (name) => {
      expect(() => loadHandler(read(name))).not.toThrow();
    },
  );
});

describe('edit-unverified and edit-verified', () => {
  // a.ts is checked before the next prompt; b.md is edited after the check and reaches the
  // prompt unchecked; c.ts is edited after the last prompt and the session ends.
  const records = [
    prompt('go'),
    ...tool('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }),
    ...tool('b1', 'Bash', { command: 'pnpm test' }),
    ...tool('e2', 'Edit', { file_path: '/p/b.md', old_string: 'x', new_string: 'y' }),
    prompt('next'),
    ...tool('e3', 'Edit', { file_path: '/p/c.ts', old_string: 'x', new_string: 'y' }),
  ];

  const replay = async () => {
    const result = await replayHandlers(
      [
        { name: 'unverified', handler: loadHandler(read('edit-unverified.yaml')) },
        { name: 'verified', handler: loadHandler(read('edit-verified.yaml')) },
      ],
      { root: corpus(records), project: PROJECT },
    );
    const [unverified, verified] = result.handlers;
    if (unverified === undefined || verified === undefined) throw new Error('missing replay');
    return { unverified, verified };
  };

  it('reports the edit that reached the prompt unchecked', async () => {
    const { unverified } = await replay();
    expect(unverified.rows.map((row) => row.fields['path'])).toEqual(['/p/b.md']);
  });

  it('reports the checked edit with the check that verified it', async () => {
    const { verified } = await replay();
    expect(verified.rows.map((row) => [row.fields['path'], row.fields['runner']])).toEqual([
      ['/p/a.ts', 'pnpm test'],
    ]);
  });

  it('counts the edit the session ended on as unclosed in both, not as unverified', async () => {
    const { unverified, verified } = await replay();
    expect([unverified.unclosed, verified.unclosed]).toEqual([1, 1]);
  });

  it('partitions every edit: unverified + verified + unclosed = triggers', async () => {
    const { unverified, verified } = await replay();
    expect(unverified.rows.length + verified.rows.length + unverified.unclosed).toBe(
      unverified.triggers,
    );
  });
});

describe('read-unused', () => {
  // a.ts is read and then edited (used); b.md is read and never touched again (unused); c.ts is
  // read twice and never otherwise (still unused: a re-read is not a use, and each read is a
  // trigger, so c.ts emits two rows).
  const records = [
    prompt('go'),
    ...tool('r1', 'Read', { file_path: '/p/a.ts' }),
    ...tool('r2', 'Read', { file_path: '/p/b.md' }),
    ...tool('r3', 'Read', { file_path: '/p/c.ts' }),
    ...tool('r4', 'Read', { file_path: '/p/c.ts' }),
    ...tool('e1', 'Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' }),
  ];

  it('emits the reads nothing later used, and never counts one unclosed', async () => {
    const result = await replayHandlers(
      [{ name: 'read-unused', handler: loadHandler(read('read-unused.yaml')) }],
      { root: corpus(records), project: PROJECT },
    );
    const [unused] = result.handlers;
    if (unused === undefined) throw new Error('missing replay');
    expect(unused.rows.map((row) => row.fields['path'])).toEqual(['/p/b.md', '/p/c.ts', '/p/c.ts']);
    // The window's until IS session.end, so every trigger is decided: emitted or used. Only
    // a.ts was used, so rows + 1 = triggers.
    expect(unused.unclosed).toBe(0);
    expect(unused.rows.length).toBe(unused.triggers - 1);
  });
});

describe('review-finding-nudge', () => {
  const handler = loadHandler(read('review-finding-nudge.yaml'));
  const said = (skill: string): string[] => {
    const run = runHandler(handler);
    const events =
      hookEvents('post-tool-use', {
        session_id: 's',
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill },
        tool_use_id: 'toolu_1',
      }) ?? [];
    return events.flatMap((event) => run.accept(event).map((row) => row.fields['say'] ?? ''));
  };

  it('runs at post-tool-use', () => {
    expect(sayStage(handler)).toBe('post-tool-use');
  });

  it('speaks when bug-hunt loads, and not for another skill', () => {
    expect(said('bug-hunt')).toHaveLength(1);
    expect(said('commit')).toEqual([]);
  });

  it('names every lens slug the type accepts, so the sentence cannot drift from FINDING_LENSES', () => {
    const [sentence = ''] = said('bug-hunt');
    for (const { slug } of FINDING_LENSES) expect(sentence).toContain(slug);
  });
});
