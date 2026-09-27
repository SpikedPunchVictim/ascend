import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_DERIVE_VERSION } from '@ascend/adapter-claude-code';
import { encodeProjectDir, spreadSample } from '../src/handler-replay.js';

/**
 * `asc handlers check`, driven as the real binary over a fixture corpus (asc-6ola.14).
 *
 * HOME is the scratch directory, as in `ingest.test.ts`, so the default transcript root resolves
 * inside the fixture and this suite can never read the operator's own transcripts.
 *
 * The fixture's counts are chosen to be unequal: two `bd close` commands naming three beads, one
 * failed close, and one unrelated command. A check that counted triggers as rows, or ignored the
 * `where`, gets a different number from each.
 */

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(repo, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: repo,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PROJECT_DIR = '-Users-me-app';

const BEAD_CLOSE = `on: command.run
where: { is_error: false, head: bd, argv.1: close }
each: { field: argv, from: 2, as: bead }
emit: { stage: '\${bead}' }
`;

const bash = (id: string, command: string, isError: boolean, minute: number): string[] => {
  const ts = `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return [
    {
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: ts,
      message: {
        id: `msg-${id}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      sessionId: 'sess-1',
      timestamp: ts,
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: '' }],
      },
    },
  ].map((record) => JSON.stringify(record));
};

/** A scratch HOME holding one transcript under `project`, and a handler file. */
function fixture(project = PROJECT_DIR): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-handlers-')));
  dirs.push(home);
  const dir = join(home, '.claude', 'projects', project);
  mkdirSync(dir, { recursive: true });
  const lines = [
    ...bash('t1', 'bd close asc-1 asc-2', false, 1),
    ...bash('t2', 'bd close asc-3', true, 2),
    ...bash('t3', 'ls', false, 3),
    ...bash('t4', 'bd close asc-4', false, 4),
  ];
  writeFileSync(join(dir, 'sess-1.jsonl'), `${lines.join('\n')}\n`);
  writeFileSync(join(home, 'bead-close.yaml'), BEAD_CLOSE);
  return home;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, 'handlers', 'check', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface JsonRow {
  readonly handler: string;
  readonly field: string;
  readonly value: unknown;
}

function valueOf(run: Run, handler: string, field: string): unknown {
  const rows = (JSON.parse(run.stdout) as { rows: JsonRow[] }).rows;
  return rows.find((row) => row.handler === handler && row.field === field)?.value;
}

describe('asc handlers check', () => {
  it('counts one row per bead closed by a successful close, not one per trigger', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', PROJECT_DIR, '--json'], home);
    expect(run.status).toBe(0);
    expect(valueOf(run, 'bead-close', 'rows')).toBe(3);
  });

  it('counts the triggers that passed where, before each fans them out', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', PROJECT_DIR, '--json'], home);
    expect(valueOf(run, 'bead-close', 'triggers')).toBe(2);
  });

  it('reports the horizon of the log it replayed', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', PROJECT_DIR, '--json'], home);
    expect([
      valueOf(run, '(log)', 'files'),
      valueOf(run, '(log)', 'first_ts'),
      valueOf(run, '(log)', 'last_ts'),
      valueOf(run, '(log)', 'derive_version'),
    ]).toEqual([1, '2026-09-24T10:01:00.000Z', '2026-09-24T10:04:00.000Z', EVENT_DERIVE_VERSION]);
  });

  it('shows the requested number of sample rows', () => {
    const home = fixture();
    const run = asc(
      ['bead-close.yaml', '--project', PROJECT_DIR, '--samples', '2', '--json'],
      home,
    );
    const rows = (JSON.parse(run.stdout) as { rows: JsonRow[] }).rows;
    expect(rows.filter((row) => row.field.startsWith('sample[')).length).toBe(2);
  });

  it('prints the hash the loader computed', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', PROJECT_DIR, '--json'], home);
    expect(valueOf(run, 'bead-close', 'hash')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults the project to the encoded path of the ascend project it runs in', () => {
    const outer = fixture();
    const inner = join(outer, 'app');
    mkdirSync(join(inner, '.ascend'), { recursive: true });
    const home = fixture(encodeProjectDir(inner));
    writeFileSync(join(inner, 'bead-close.yaml'), BEAD_CLOSE);
    const run = spawnSync(
      process.execPath,
      [bin, 'handlers', 'check', 'bead-close.yaml', '--json'],
      {
        cwd: inner,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, '.cache') },
      },
    );
    expect(valueOf(run, 'bead-close', 'rows')).toBe(3);
  });

  it('refuses a handler the loader refuses, with the loader’s message', () => {
    const home = fixture();
    writeFileSync(
      join(home, 'bad.yaml'),
      'on: command.run\nwhere: { is_error: yes }\nemit: { x: a }',
    );
    const run = asc(['bead-close.yaml', 'bad.yaml', '--project', PROJECT_DIR], home);
    expect([run.status, run.stdout, run.stderr]).toEqual([
      1,
      '',
      expect.stringMatching(/bad\.yaml: .*is a string, the field is a boolean/s),
    ]);
  });

  it('refuses a project with no transcript directory rather than reporting zero', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', '-Users-me-elsewhere'], home);
    expect([run.status, run.stdout]).toEqual([1, '']);
  });
});

describe('spreadSample', () => {
  it('spreads picks across the whole list', () => {
    expect(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 3, 6]);
  });

  it('returns every row when there are fewer than asked for', () => {
    expect(spreadSample([0, 1], 5)).toEqual([0, 1]);
  });
});

describe('encodeProjectDir', () => {
  it('maps every character other than letters, digits and - to -', () => {
    expect(encodeProjectDir('/Users/me/my.app_2/x-y')).toBe('-Users-me-my-app-2-x-y');
  });
});

/**
 * Cross-stream scope and the backward reference, driven as the real binary (asc-gtnu.4).
 *
 * The fixture reproduces the corpus's measured layout -- 792 of 843 files are
 * `<session>/subagents/agent-*.jsonl` (`transcript-file.ts`) -- and relies on `streamCorpus`'s own
 * order: `<sess>.jsonl` sorts before `<sess>/subagents/...` (`.` 0x2E < `/` 0x2F), so a session's
 * main stream is offered first and its subagents after. That order is the whole reason a
 * `scope: session` window can match across streams here, and it is a property of the file layout
 * rather than of the event data, which is why `runHandler` refuses `before:` under session scope
 * instead of leaning on it.
 *
 * The two `bd close` commands and the `ls` are on purpose: a check that counted triggers as rows,
 * or that matched within a stream when it was told to match across one, gets a different number
 * from each of these.
 */

const XPROJECT = '-Users-me-xstream';

const CROSS_HANDLER = `on: command.run
where: { head: bd }
scope: session
window:
  until: prompt.submit
  first: { on: command.run, where: { head: ls } }
emit: { head: '\${head}', found: '\${window.first.head}' }
`;

const NEVER_HANDLER = `on: command.run
where: { head: bd }
scope: session
window:
  until: prompt.submit
  first: { on: command.run, where: { head: nope } }
emit: { head: '\${head}' }
`;

const BEFORE_HANDLER = `on: command.run
where: { head: bd }
before: { on: command.run, where: { head: ls } }
emit: { head: '\${head}', prior: '\${before.head}' }
`;

/** main: one `bd close`, nothing else. subagent: an `ls`, and no `prompt.submit` anywhere. */
function crossFixture(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-handlers-x-')));
  dirs.push(home);
  const dir = join(home, '.claude', 'projects', XPROJECT);
  mkdirSync(join(dir, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(
    join(dir, 'sess-1.jsonl'),
    `${bash('t1', 'bd close asc-1', false, 1).join('\n')}\n`,
  );
  writeFileSync(
    join(dir, 'sess-1', 'subagents', 'agent-abc.jsonl'),
    `${bash('s1', 'ls', false, 2).join('\n')}\n`,
  );
  writeFileSync(join(home, 'cross.yaml'), CROSS_HANDLER);
  writeFileSync(join(home, 'same-stream.yaml'), CROSS_HANDLER.replace('scope: session\n', ''));
  writeFileSync(join(home, 'never.yaml'), NEVER_HANDLER);
  return home;
}

/** main: `bd close`, `ls`, `bd close`. subagent: an `ls` the main stream must never see. */
function beforeFixture(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-handlers-b-')));
  dirs.push(home);
  const dir = join(home, '.claude', 'projects', XPROJECT);
  mkdirSync(join(dir, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(
    join(dir, 'sess-1.jsonl'),
    `${[
      ...bash('t1', 'bd close asc-1', false, 1),
      ...bash('t2', 'ls', false, 2),
      ...bash('t3', 'bd close asc-2', false, 3),
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(dir, 'sess-1', 'subagents', 'agent-abc.jsonl'),
    `${bash('s1', 'ls', false, 4).join('\n')}\n`,
  );
  writeFileSync(join(home, 'prior.yaml'), BEFORE_HANDLER);
  return home;
}

describe('asc handlers check: scope: session and before', () => {
  it('counts a session-scoped window the replay ended inside, rather than dropping it', () => {
    // `session.end` is one event per STREAM, so it can never decide a session-scoped window: the
    // stream that ends is not the session. Nothing here closes this window -- no `prompt.submit`,
    // no match -- so it is `finish()` or it is nothing, and this is what says a window the log
    // ended inside is counted instead of vanishing. Without it: rows 0, unclosed 0, noMatch 0, on
    // a handler that fired once.
    const home = crossFixture();
    const run = asc(['never.yaml', '--project', XPROJECT, '--json'], home);
    expect([
      valueOf(run, 'never', 'triggers'),
      valueOf(run, 'never', 'rows'),
      valueOf(run, 'never', 'unclosed'),
      valueOf(run, 'never', 'noMatch'),
    ]).toEqual([1, 0, 1, 0]);
  });

  it('matches an event of another stream, under the trigger stream and not the watched one', () => {
    const home = crossFixture();
    const run = asc(['cross.yaml', '--project', XPROJECT, '--samples', '1', '--json'], home);
    expect(run.status).toBe(0);
    expect(valueOf(run, 'cross', 'scope')).toBe('session');
    expect(valueOf(run, 'cross', 'rows')).toBe(1);
    // The trigger is main's `bd close`; the match is the SUBAGENT's `ls`. That is the join.
    expect(valueOf(run, 'cross', 'sample[0]')).toMatchObject({
      agent_id: 'main',
      closed_by: 'match',
      fields: { head: 'bd', found: 'ls' },
    });
  });

  it('finds nothing under the default scope, and counts the window the stream ended inside', () => {
    // The same events and the same handler minus one line. `rows: 0` here is not a handler that
    // found nothing -- it is a window nothing closed, and the report has to say which, or the two
    // read identically to a reader with a broken handler.
    const home = crossFixture();
    const run = asc(['same-stream.yaml', '--project', XPROJECT, '--json'], home);
    expect(valueOf(run, 'same-stream', 'scope')).toBe('stream');
    expect([
      valueOf(run, 'same-stream', 'rows'),
      valueOf(run, 'same-stream', 'unclosed'),
      valueOf(run, 'same-stream', 'noMatch'),
    ]).toEqual([0, 1, 0]);
  });

  it('resolves the backward reference to the nearest match, and counts the triggers with none', () => {
    const home = beforeFixture();
    const run = asc(['prior.yaml', '--project', XPROJECT, '--samples', '2', '--json'], home);
    expect(valueOf(run, 'prior', 'before')).toBe('command.run');
    expect([
      valueOf(run, 'prior', 'triggers'),
      valueOf(run, 'prior', 'rows'),
      valueOf(run, 'prior', 'unsatisfiedBefore'),
    ]).toEqual([2, 2, 1]);
    const fields = (index: number): unknown =>
      (valueOf(run, 'prior', `sample[${String(index)}]`) as { fields: unknown }).fields;
    // The first `bd close` has no earlier `ls`; the second one's is main's own. The subagent's
    // `ls` is in another stream, so a per-stream `before:` must not reach it -- that is the second
    // assertion, and it is the one the fixture's extra file exists for.
    expect(fields(0)).toEqual({ head: 'bd' });
    expect(fields(1)).toEqual({ head: 'bd', prior: 'ls' });
  });

  it('reports no before key and no scope surprise for a handler that declares neither', () => {
    const home = fixture();
    const run = asc(['bead-close.yaml', '--project', PROJECT_DIR, '--json'], home);
    expect(valueOf(run, 'bead-close', 'before')).toBeUndefined();
    expect(valueOf(run, 'bead-close', 'scope')).toBe('stream');
    expect(valueOf(run, 'bead-close', 'noMatch')).toBe(0);
  });
});

/**
 * `handlers/review-finding.yaml` over a fixture that actually reports findings (asc-gtnu.5).
 *
 * No corpus holds a finding -- `ReportFindings` has been called 0 times across 1,236 files -- so
 * without this the shipped handler is a green over a signal that is empty everywhere, and "parses
 * and matches nothing" is indistinguishable from "works". The fixture's second finding names a
 * category outside the nine lens slugs on purpose: the handler must emit it rather than filter it,
 * and the counter must move, because a category we will not store is a different fact from a
 * category nobody used.
 */

const REPORT_FINDINGS = 'ReportFindings';

/** One assistant record carrying a `ReportFindings` call, with no tool result. */
function reportFindings(id: string, findings: readonly unknown[], minute: number): string[] {
  const ts = `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`;
  return [
    {
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: ts,
      message: {
        id: `msg-${id}`,
        model: 'claude-sonnet-5',
        content: [
          {
            type: 'tool_use',
            id,
            name: REPORT_FINDINGS,
            input: { level: 'standard', findings },
          },
        ],
      },
    },
  ].map((record) => JSON.stringify(record));
}

describe('asc handlers check: handlers/review-finding.yaml', () => {
  function reported(): string {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-handlers-rf-')));
    dirs.push(home);
    const dir = join(home, '.claude', 'projects', PROJECT_DIR);
    mkdirSync(dir, { recursive: true });
    const lines = reportFindings(
      't1',
      [
        {
          category: 'boundary_conditions',
          file: 'packages/core/src/handler.ts',
          line: 42,
          summary: 'the window admits an event at the boundary',
          failure_scenario: 'seq equal to the trigger still matches',
          verdict: 'CONFIRMED',
        },
        // Outside the nine, no line, no verdict. Emitted, counted, never filtered.
        { category: 'not_a_lens', file: 'a.ts', summary: 'something else' },
      ],
      1,
    );
    writeFileSync(join(dir, 'sess-1.jsonl'), `${lines.join('\n')}\n`);
    return home;
  }

  const handler = (): string => join(repo, 'handlers/review-finding.yaml');

  it('emits one row per finding, not one per call', () => {
    const home = reported();
    const run = asc([handler(), '--project', PROJECT_DIR, '--json'], home);
    expect(run.status).toBe(0);
    expect(valueOf(run, 'review-finding', 'rows')).toBe(2);
    expect(valueOf(run, 'review-finding', 'triggers')).toBe(2);
  });

  it('carries the finding under the log’s own name, category, not our enum name', () => {
    const home = reported();
    const run = asc([handler(), '--project', PROJECT_DIR, '--samples', '2', '--json'], home);
    const fields = (index: number): Record<string, unknown> =>
      (
        valueOf(run, 'review-finding', `sample[${String(index)}]`) as {
          fields: Record<string, unknown>;
        }
      ).fields;
    // `line` comes back as TEXT, and that is the DSL's rule rather than this handler's choice:
    // every reference is rendered through `String(raw)` (packages/core/src/handler.ts:566), so a
    // numeric event field reaches a row as a string. The store keeps the number -- the deriver
    // reads it with `num` -- so the log and the entries disagree about the type of the same fact,
    // which is the same asymmetry `reviewer_model` has, one field over. Asserted as text so the
    // rule is pinned where a reader will find it.
    expect(fields(0)).toEqual({
      category: 'boundary_conditions',
      file: 'packages/core/src/handler.ts',
      line: '42',
      summary: 'the window admits an event at the boundary',
      failure_scenario: 'seq equal to the trigger still matches',
      verdict: 'CONFIRMED',
      level: 'standard',
    });
    // Absent, not zero and not empty: a finding is not always line-anchored, and an empty string
    // is what an omitted reference would look like if the field were defaulted.
    expect(fields(1)).toEqual({
      category: 'not_a_lens',
      file: 'a.ts',
      summary: 'something else',
      level: 'standard',
    });
  });

  it('declares catchable_by without carrying it, and moves the off-vocabulary counter', () => {
    const home = reported();
    const run = asc([handler(), '--project', PROJECT_DIR, '--samples', '2', '--json'], home);
    expect(valueOf(run, 'review-finding', 'judged[0]')).toBe('catchable_by');
    const fields = (
      valueOf(run, 'review-finding', 'sample[0]') as { fields: Record<string, unknown> }
    ).fields;
    expect('catchable_by' in fields).toBe(false);
    // The one finding outside the nine reaches the log AND the counter: the handler emitting it is
    // not the same fact as the deriver refusing to store it, and both have to be visible.
    expect(valueOf(run, '(log)', 'normalizer.offVocabularyFindings')).toBe(1);
  });
});
