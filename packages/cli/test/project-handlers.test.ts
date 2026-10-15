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
      { source: 'transcripts', root: corpus(records), projects: [PROJECT] },
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

  it('partitions every edit across all four counters, for both handlers', async () => {
    const { unverified, verified } = await replay();
    // ALL FOUR terms, where this test used to add three. `edit-unverified` is an `absent` handler, so
    // the a.ts edit -- answered by the very `check.run` the window watches for -- is decided BY a
    // match and lands in `matchedButAbsent`, which is the case `asc-4031` found counted nowhere. A
    // three-term sum was green throughout that defect, which is why the partition is asserted as one
    // identity rather than as a sum a reader has to trust is complete.
    const decided = (run: {
      rows: readonly unknown[];
      unclosed: number;
      noMatch: number;
      matchedButAbsent: number;
    }): number => run.rows.length + run.unclosed + run.noMatch + run.matchedButAbsent;
    expect([decided(unverified), decided(verified)]).toEqual([
      unverified.triggers,
      verified.triggers,
    ]);

    // And the terms themselves, so a change that moved one outcome into another's counter cannot
    // keep the sum green. The a.ts edit emits no row and is neither unclosed nor a miss.
    expect({
      rows: unverified.rows.length,
      unclosed: unverified.unclosed,
      noMatch: unverified.noMatch,
      matchedButAbsent: unverified.matchedButAbsent,
    }).toEqual({ rows: 1, unclosed: 1, noMatch: 0, matchedButAbsent: 1 });
    // The b.md edit reaches its `until` with no match, so it is a miss -- the same decision `first`
    // makes, reached through the other mode, and counted here rather than by this counter.
    expect({
      rows: verified.rows.length,
      unclosed: verified.unclosed,
      noMatch: verified.noMatch,
      matchedButAbsent: verified.matchedButAbsent,
    }).toEqual({ rows: 1, unclosed: 1, noMatch: 1, matchedButAbsent: 0 });
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
      { source: 'transcripts', root: corpus(records), projects: [PROJECT] },
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

describe('sayStage: stage: pre is a request the harness has to be able to serve (asc-eve4)', () => {
  it('resolves a pre handler on tool.use.start to pre-tool-use', () => {
    expect(sayStage(loadHandler('on: tool.use.start\nstage: pre\nsay: hi\n'))).toBe('pre-tool-use');
  });

  it('keeps a handler that names no stage at post-tool-use, where the nudge was measured', () => {
    // `tool.use.start` is the one kind two stages deliver. The default is the stage the one live
    // say handler's compliance was measured under, so adding the other stage must not move it.
    expect(sayStage(loadHandler('on: tool.use.start\nsay: hi\n'))).toBe('post-tool-use');
  });

  it('refuses stage: pre on a kind no pre stage delivers, rather than running it at post', () => {
    // The silent downgrade this refuses. `file.changed` has no PreToolUse input, so a pre request
    // would fall back to post-tool-use -- the handler would run at the other moment, saying its
    // sentence late, and nothing in the report would say it had moved. A handler at the wrong
    // moment is worse than one that refuses to load, because the refusal is the visible half.
    expect(() => sayStage(loadHandler('on: file.changed\nstage: pre\nsay: hi\n'))).toThrow(
      /stage: pre asks for pre-tool-use, which delivers only: tool\.use\.start/,
    );
  });

  it('leaves a prompt handler at user-prompt-submit, which no tool stage can carry', () => {
    expect(sayStage(loadHandler('on: prompt.submit\nsay: hi\n'))).toBe('user-prompt-submit');
  });
});

describe('session-commit', () => {
  const handler = loadHandler(read('session-commit.yaml'));

  /** The rows one Bash command produces, as the reader of a replayed row would see them. */
  const commits = async (command: string, isError = false) => {
    const records = [
      prompt('go'),
      {
        type: 'assistant',
        sessionId: 's',
        timestamp: at(),
        message: {
          id: 'm-1',
          content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command } }],
        },
      },
      {
        type: 'user',
        sessionId: 's',
        timestamp: at(),
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: isError, content: '' }],
        },
      },
    ];
    const result = await replayHandlers([{ name: 'session-commit', handler }], {
      source: 'transcripts',
      root: corpus(records),
      projects: [PROJECT],
    });
    const [run] = result.handlers;
    if (run === undefined) throw new Error('missing replay');
    return run.rows.map((row) => row.fields);
  };

  it('emits the commit a session ran, keyed on the call that ran it', async () => {
    expect(await commits('git commit -m x')).toEqual([
      { id: 'c1', argv: 'git commit -m x', is_error: 'false' },
    ]);
  });

  it('reads the segment a compound command commits in, not the command it is chained to', async () => {
    // `head` is the SEGMENT's first token, not the first token of the line the segment sits on:
    // the normalizer splits a command into segments and emits one `command.run` per segment
    // (packages/adapter-claude-code/src/normalize.ts). `head` for the line above is `git`, and most
    // of this corpus's commits are written this way.
    expect((await commits('cd /repo && git commit -q -m x')).map((one) => one['argv'])).toEqual([
      'git commit -q -m x',
    ]);
  });

  it('matches a commit whose subcommand git options come before', async () => {
    // WHY THE CHECK IS `contains` AND NOT `followed_by: [git, commit]`. The tighter pair needs the
    // two tokens adjacent, so it drops every commit written this way -- measured 2026-10-14, 413 of
    // the corpus's 4,475 commit rows. This assertion is where a tightening gets noticed.
    expect((await commits('git -c user.name=t commit -q -m x')).map((one) => one['argv'])).toEqual([
      'git -c user.name=t commit -q -m x',
    ]);
  });

  it('does not match a command that only mentions the word', async () => {
    // `contains` compares whole argv elements, so this one is excluded by `head` alone.
    expect(await commits('npm run commit')).toEqual([]);
  });

  it('carries a refused commit as the text "true", so a reader can leave it out', async () => {
    // TEXT, not a boolean: `${is_error}` renders through `String(raw)`
    // (packages/core/src/handler.ts), so a reader comparing this to JSON's `true` keeps every
    // refused commit in its count -- and this repository's gate refuses commits.
    expect(await commits('git commit -m x', true)).toEqual([
      { id: 'c1', argv: 'git commit -m x', is_error: 'true' },
    ]);
  });

  it('DOES match a git command that only mentions the word, the measured 1 in 4,483', async () => {
    // The half of the definition that is loose, pinned so it cannot be tightened in silence.
    // Measured 2026-10-14 over 4,483 rows from the whole corpus by reading the subcommand of every
    // one: this is the only row that was not a commit. If this assertion is being changed, the
    // header's numbers are what it is changing.
    expect((await commits('git merge --no-edit -m "the commit is the merge of #220"')).length).toBe(
      1,
    );
  });
});

describe('review-finding-table', () => {
  const handler = loadHandler(read('review-finding-table.yaml'));

  it('declares no judged names, and carries the reason in its own header', () => {
    // It emits neither `failure_scenario` nor `catchable_by`, so declaring both under `judged` is
    // the obvious fix and the one it does not take. The reason is measured: core hashes the whole
    // parsed document (packages/core/src/handler.ts), so a key that emits nothing still moves
    // the handler's identity, and the entry key carries that hash
    // (packages/cli/src/typed-handlers.ts). `asc ingest claude-code --dry-run` goes from
    // `entry review_finding none` to `65 new, 11 rejected`, doubling the parsed corpus until a
    // hand migration of the kind asc-w8tx documents -- and comparable counts are this type's whole
    // product. This assertion is the speed bump: it fails the moment someone adds the declaration,
    // which is the moment to read the header comment (asc-my84).
    expect(handler.judged).toEqual([]);
  });
});
