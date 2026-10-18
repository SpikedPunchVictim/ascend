/**
 * `asc standing-costs` driven through the real binary.
 *
 * `HOME` is the scratch directory, so `defaultTranscriptRoot()` resolves inside the fixture and the
 * operator's corpus is never read — the pattern `handlers-check.test.ts` established. `cwd` is the
 * scratch directory too, and it holds no `.ascend/`: the command must not need a store, and a run
 * that quietly opened one would fail here rather than on a machine that happens to have one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(repo, 'packages/cli/dist/bin.js');
const PROJECT = '-fixture-project';
const made: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-b'], {
    stdio: 'pipe',
  });
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function records(home: string): string[] {
  const bash = (id: string, command: string, content: string): Record<string, unknown>[] => [
    {
      type: 'assistant',
      sessionId: 'sess-1',
      message: {
        id: `msg-${id}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      sessionId: 'sess-1',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
    },
  ];
  return [
    {
      type: 'attachment',
      sessionId: 'sess-1',
      attachment: {
        type: 'instructions',
        files: [
          { path: join(home, '.claude/CLAUDE.md'), type: 'text', content: 'alpha' },
          { path: '/srv/one/CLAUDE.md', type: 'text', content: 'beta' },
          { path: '/srv/two/CLAUDE.md', type: 'text', content: 'gamma' },
        ],
      },
    },
    {
      type: 'attachment',
      sessionId: 'sess-1',
      attachment: { type: 'skill_listing', content: 'listing', names: ['a', 'b'] },
    },
    ...bash('t1', 'git diff', '0123456789'),
    ...bash('t2', 'sed -n 1p f', '01234'),
    ...bash('t3', 'grep --help', '0123456789'),
  ].map((value) => JSON.stringify(value));
}

function fixture(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-standing-')));
  made.push(home);
  const dir = join(home, '.claude', 'projects', PROJECT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sess-1.jsonl'), `${records(home).join('\n')}\n`);
  return home;
}

// No explicit return type: `ReturnType<typeof spawnSync>` widens `stdout` to `string | Buffer`,
// and the `encoding: 'utf8'` literal below is what makes inference pick the string overload.
function run(home: string, args: string[]) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, '.cache') },
  });
}

interface Envelope {
  ascend_output: number;
  rows: { report: string; key: string; bytes?: number; count?: number; value?: unknown }[];
  row_count: number;
  coverage?: { shown: number; total: number; has_more: boolean };
}

describe('asc standing-costs', () => {
  it('reports every report in one --json array with real numbers', () => {
    const home = fixture();
    const result = run(home, ['standing-costs', '--project', PROJECT, '--json']);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as Envelope;

    expect(output.ascend_output).toBe(3);
    expect(output.rows).toHaveLength(output.row_count);
    // One array, partitioned by `report`, so a consumer never has to know a second shape.
    const reports = new Set(output.rows.map((row) => row.report));
    for (const name of ['(log)', 'injected', 'instructions', 'skills', 'tools', 'bash', 'help']) {
      expect(reports.has(name)).toBe(true);
    }

    const instructions = output.rows.find(
      (row) => row.report === 'injected' && row.key === 'instructions',
    );
    // 'alpha' + 'beta' + 'gamma' across three files of one record.
    expect(instructions?.bytes).toBe(14);
    expect(instructions?.count).toBe(1);
    // The home prefix is abbreviated, and nothing else is.
    expect(
      output.rows.find((row) => row.report === 'instructions' && row.key === '/srv/one/CLAUDE.md'),
    ).toMatchObject({ bytes: 4, count: 1 });
    expect(
      output.rows.some((row) => row.report === 'instructions' && row.key.startsWith('~/')),
    ).toBe(true);
    // Byte values are numbers, not strings, in JSON.
    expect(typeof instructions?.bytes).toBe('number');
  });

  it('trims each ranked report and still shows the table footer', () => {
    const home = fixture();
    const result = run(home, ['standing-costs', '--project', PROJECT, '--table', '--limit', '1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/showing \d+ of \d+/);
  });

  it('projects the documented columns into --csv', () => {
    const home = fixture();
    const result = run(home, ['standing-costs', '--project', PROJECT, '--csv']);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(
      'report,key,bytes,count,sessions,stream_segments,value,note',
    );
  });

  it('refuses a limit below one', () => {
    const home = fixture();
    const result = run(home, ['standing-costs', '--project', PROJECT, '--limit', '0']);
    expect(result.status).toBe(2);
  });

  it('refuses a project directory that does not exist rather than reporting zero', () => {
    const home = fixture();
    const result = run(home, ['standing-costs', '--project', '-not-a-project', '--json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no transcript directory');
  });
});
