import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { whyNot } from '../src/handler-power.js';

/**
 * `asc handlers power`, driven as the real binary over a fixture corpus (asc-6ola.3).
 *
 * Thirty sessions, one `bd` each, on days 1..28 of September, and every second one followed by an
 * `ls`. The handler emits a row for a `bd` that no `ls` follows before the stream ends, so 15 of the
 * 30 units produce a row -- a base rate of exactly 0.5 over 28 active days, which is what makes the
 * expected sample size a number that can be checked by hand rather than a number that was recorded.
 *
 * Every session is one compaction segment, so every cluster is a singleton: the correction is
 * `inapplicable`, the design effect is exactly 1, and the plan is the unclustered one. The `compact`
 * variant splits one session in two so the estimated path is exercised too.
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
const SESSIONS = 30;

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
/**
 * One tool call and its result, at `day` and at minute `minute` of that day.
 *
 * The minute is not decoration. `active_days` buckets units by calendar day, and a fixture that put
 * every session's work at the same instant of the day could not tell that bucket from a count of the
 * units themselves -- the two would agree by construction, and the row would be untested.
 */
const bash = (session: string, command: string, day: number, minute: number): string[] => {
  counter += 1;
  const id = `t${String(counter)}`;
  const ts =
    `2026-09-${String(day).padStart(2, '0')}` + `T10:${String(minute).padStart(2, '0')}:00.000Z`;
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

/**
 * `compact` gives the first session a second segment, so it holds two units and the correction
 * stops being `inapplicable`. Its day also shifts to the end, which keeps the other 29 sessions on
 * the days they were on and leaves the active-day count alone.
 */
function fixture(compact = false): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asc-power-')));
  dirs.push(home);
  const dir = join(home, '.claude', 'projects', PROJECT_DIR);
  mkdirSync(dir, { recursive: true });
  const sessions: Record<string, string[]> = {};
  for (let index = 0; index < SESSIONS; index += 1) {
    const session = `s${String(index).padStart(2, '0')}`;
    const day = 1 + (index % 28);
    const lines = bash(session, 'bd ready', day, index);
    // Every second session runs an `ls` before its stream ends, so its window decides "no match".
    sessions[session] = index % 2 === 0 ? lines : [...lines, ...bash(session, 'ls', day, index)];
  }
  if (compact) {
    sessions['s00'] = [
      ...bash('s00', 'bd ready', 1, 0),
      compaction('s00', 2),
      ...bash('s00', 'bd ready', 3, 5),
    ];
  }
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
  const result = spawnSync(process.execPath, [bin, 'handlers', 'power', ...args], {
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

const power = (home: string, ...extra: string[]): Run =>
  asc(['unfollowed.yaml', '--effect', '0.5', '--project', PROJECT_DIR, '--json', ...extra], home);

describe('asc handlers power', () => {
  it('counts the units the handler triggered in, and the successes the outcome names', () => {
    const run = power(fixture());
    expect([valueOf(run, 'units'), valueOf(run, 'successes')]).toEqual([30, 15]);
  });

  it('counts the active days the units actually happened on', () => {
    expect(valueOf(power(fixture()), 'active_days')).toBe(28);
  });

  it('gives the base rate with its Wilson interval, in the rendering compare uses', () => {
    expect(valueOf(power(fixture()), 'proportion')).toBe('0.5 [0.332, 0.668] 95% Wilson');
  });

  it('counts the sessions as the clusters the correction is estimated over', () => {
    expect(valueOf(power(fixture()), 'clusters')).toBe(30);
  });

  it('says the correction is inapplicable when every cluster is a single unit', () => {
    // One observation per cluster: the correction is 1 for any correlation, so the correlation says
    // nothing and the design effect is exactly 1. Reported as `inapplicable` rather than as a
    // measured 0, because those are different claims.
    const run = power(fixture());
    expect([valueOf(run, 'rho_source'), valueOf(run, 'design_effect')]).toEqual([
      'inapplicable',
      1,
    ]);
  });

  it('estimates the correction once one session holds two units', () => {
    const run = power(fixture(true));
    expect([valueOf(run, 'units'), valueOf(run, 'clusters'), valueOf(run, 'rho_source')]).toEqual([
      31,
      30,
      'estimated',
    ]);
  });

  it('divides the units by the active days for the rate the whole plan is built on', () => {
    expect(valueOf(power(fixture()), 'units_per_day')).toBe(1.071);
  });

  it('reports the units needed, the days to power and the days to clear MIN_N', () => {
    const run = power(fixture());
    expect([
      valueOf(run, 'units_needed'),
      valueOf(run, 'units_per_arm'),
      valueOf(run, 'days_to_power'),
      valueOf(run, 'min_n_days'),
    ]).toEqual([116, 58, 108.267, 37.333]);
  });

  it('reports the ratio, so days-to-MIN_N is never read as the answer', () => {
    expect(valueOf(power(fixture()), 'multiple')).toBe(2.9);
  });

  it('says not answerable, and what these units would detect instead', () => {
    expect(valueOf(power(fixture()), 'verdict')).toBe(
      'not answerable in 90 active days -- the smallest reduction these units detect is 54.252%',
    );
  });

  it('says answerable, with the days, when the horizon is long enough', () => {
    expect(valueOf(power(fixture(), '--horizon', '120'), 'verdict')).toBe(
      'answerable here in 109 active days',
    );
  });

  it('refuses the unit when the horizon cannot fill MIN_N in each arm', () => {
    // 30 units over 28 days at a 50% holdout is 16 units in the smaller arm over 30 days, under the
    // floor of 20. The refusal names the unit as the problem, before any effect size is mentioned,
    // because a smallest-detectable computed here would be a number at a sample size never reached.
    const verdict = valueOf(power(fixture(), '--horizon', '30'), 'verdict');
    expect(verdict).toMatch(/^refused -- /);
    expect(verdict).toMatch(/16 units in the smaller arm, under the minimum of 20/);
  });

  it('refuses an --effect that is not a fraction strictly between 0 and 1', () => {
    const run = asc(
      ['unfollowed.yaml', '--effect', '0', '--project', PROJECT_DIR, '--json'],
      fixture(),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--effect takes a fraction strictly between 0 and 1/);
  });

  it('names --holdout, not --effect, when the holdout is the flag that was wrong', () => {
    const run = asc(
      ['unfollowed.yaml', '--effect', '0.5', '--holdout', '1', '--project', PROJECT_DIR, '--json'],
      fixture(),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--holdout takes a fraction strictly between 0 and 1/);
  });

  it('refuses a horizon of zero active days', () => {
    const run = power(fixture(), '--horizon', '0');
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/--horizon takes a positive number of active days/);
  });
});

describe('why a plan could not be computed, when the outcome never varied', () => {
  it('says where a NUDGE is sized, because every unit succeeding is a say: handler by construction', () => {
    // `asc-xg62`: `packages/core` compiles a `say:` handler to one emit per trigger, so "a trigger
    // produced a row" is the identity and this instrument cannot size a nudge. The owner's decision
    // is that nudges are sized git-side; a refusal that stops at "no variance" sends the reader
    // looking for a flag that does not exist.
    const said = whyNot(851, 851, 851, 48);
    expect(said).toContain('size it git-side');
    expect(said).toContain('spike/rework-design-effect/units.mjs');
  });

  it('does not claim a nudge when nothing succeeded', () => {
    // The same branch covers "no unit succeeded", which is a different fact and not a say: handler.
    const said = whyNot(60, 0, 60, 10);
    expect(said).toContain('the outcome was the same');
    expect(said).not.toContain('git-side');
  });
});
