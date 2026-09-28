import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc handlers compare`, driven as the real binary over a fixture corpus (asc-jwm7).
 *
 * The handler emits a row for a successful `bd` command that no `ls` follows before the stream
 * ends. Five sessions, split at 2026-09-20:
 *
 * - sA, before: `bd` alone -- a row.
 * - sB, before: `bd`, then `ls` -- no row.
 * - sC, after: `bd`, then `ls` -- no row.
 * - sD: `bd` on the 19th and `ls` on the 21st, one segment across the change -- straddling.
 * - sE: `bd` on the 10th, a compaction on the 24th, `bd` on the 25th, no `ls` -- two units, one in
 *   each arm, each with a row. The compaction is what keeps sE out of `straddling`.
 *
 * So before is 2 of 3 and after is 1 of 2, and a count per session instead of per segment would
 * get both wrong.
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
const AT = '2026-09-20T00:00:00.000Z';

const UNFOLLOWED = `on: command.run
where: { is_error: false, head: bd }
window:
  until: session.end
  absent:
    on: command.run
    where: { head: ls }
emit: { argv: '\${argv}' }
`;

let counter = 0;
const bash = (session: string, command: string, day: number): string[] => {
  counter += 1;
  const id = `t${String(counter)}`;
  const ts = `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  return [
    {
      type: 'assistant',
      sessionId: session,
      timestamp: ts,
      message: {
        id: `msg-${id}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    },
    {
      type: 'user',
      sessionId: session,
      timestamp: ts,
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: '' }],
      },
    },
  ].map((record) => JSON.stringify(record));
};

const compaction = (session: string, day: number): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    sessionId: session,
    timestamp: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 10 },
  });

function fixture(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-compare-')));
  dirs.push(home);
  const dir = join(home, '.claude', 'projects', PROJECT_DIR);
  mkdirSync(dir, { recursive: true });
  const sessions: Record<string, string[]> = {
    sA: bash('sA', 'bd ready', 10),
    sB: [...bash('sB', 'bd ready', 10), ...bash('sB', 'ls', 10)],
    sC: [...bash('sC', 'bd ready', 25), ...bash('sC', 'ls', 25)],
    sD: [...bash('sD', 'bd ready', 19), ...bash('sD', 'ls', 21)],
    sE: [...bash('sE', 'bd ready', 10), compaction('sE', 24), ...bash('sE', 'bd ready', 25)],
  };
  for (const [session, lines] of Object.entries(sessions)) {
    writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
  }
  writeFileSync(join(home, 'unfollowed.yaml'), UNFOLLOWED);
  return home;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, 'handlers', 'compare', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function valueOf(run: Run, field: string): unknown {
  const rows = (
    JSON.parse(run.stdout) as { rows: { handler: string; field: string; value: unknown }[] }
  ).rows;
  return rows.find((row) => row.handler === 'unfollowed' && row.field === field)?.value;
}

const compare = (home: string, ...extra: string[]): Run =>
  asc(['unfollowed.yaml', '--at', AT, '--project', PROJECT_DIR, '--json', ...extra], home);

describe('asc handlers compare', () => {
  it('counts the before arm per compaction segment', () => {
    const run = compare(fixture());
    expect([valueOf(run, 'before.units'), valueOf(run, 'before.with_row')]).toEqual([3, 2]);
  });

  it('counts the after arm per compaction segment', () => {
    const run = compare(fixture());
    expect([valueOf(run, 'after.units'), valueOf(run, 'after.with_row')]).toEqual([2, 1]);
  });

  it('keeps a segment that spans the change out of both arms, and counts it', () => {
    const run = compare(fixture());
    expect(valueOf(run, 'straddling')).toBe(1);
  });

  it('labels every comparison observational', () => {
    const run = compare(fixture());
    expect(valueOf(run, 'design')).toMatch(/^observational -- /);
  });

  it('flags an arm under MIN_N as an anecdote beside its interval', () => {
    const run = compare(fixture());
    expect(valueOf(run, 'before.proportion')).toMatch(
      /^0\.667 \[.*\] 95% Wilson \(n=3 < 20: anecdote\)$/,
    );
  });

  it('withholds the difference between two small arms', () => {
    const run = compare(fixture());
    expect(valueOf(run, 'difference')).toMatch(/^not estimated -- /);
  });

  it('reads a bare date as its midnight UTC', () => {
    const run = asc(
      ['unfollowed.yaml', '--at', '2026-09-20', '--project', PROJECT_DIR, '--json'],
      fixture(),
    );
    expect(valueOf(run, 'at')).toBe(AT);
  });

  it('refuses an --at that is not a date, as a usage error', () => {
    const run = asc(
      ['unfollowed.yaml', '--at', 'last tuesday', '--project', PROJECT_DIR],
      fixture(),
    );
    expect([run.status, run.stdout]).toEqual([2, '']);
  });

  it('refuses without --at', () => {
    const run = asc(['unfollowed.yaml', '--project', PROJECT_DIR], fixture());
    expect([run.status, run.stdout]).toEqual([2, '']);
  });
});
