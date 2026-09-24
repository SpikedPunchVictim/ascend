import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    ]).toEqual([1, '2026-09-24T10:01:00.000Z', '2026-09-24T10:04:00.000Z', 1]);
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
