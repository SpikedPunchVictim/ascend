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

function fixture(decided?: readonly Decision[]): string {
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
  if (decided !== undefined) writeDecisions(home, decided);
  return home;
}

/**
 * One decision the hook would have written, keyed to a unit of this fixture.
 *
 * `version` defaults to the loaded handler's own hash, read off a run first: the point of the join
 * is that a decision counts only for the intervention version it was made under, so a test that
 * guessed the hash would be testing the mismatch path instead of the match.
 */
interface Decision {
  readonly session: string;
  readonly segment: number;
  readonly arm: 'delivered' | 'held_out';
  readonly version?: string;
}

function writeDecisions(home: string, decided: readonly Decision[]): void {
  const version = String(valueOf(compare(home), 'hash'));
  const tree = join(home, '.ascend', 'exposure');
  mkdirSync(tree, { recursive: true });
  const lines = decided.map((one) =>
    JSON.stringify({
      exposure_id: `${one.session}:${String(one.segment)}`,
      intervention_id: 'unfollowed',
      intervention_version: one.version ?? version,
      arm: one.arm,
      rate: 0.3,
      session: one.session,
      agent: 'main',
      segment: one.segment,
      hook_event: 'PostToolUse',
    }),
  );
  writeFileSync(join(tree, 'decided.jsonl'), `${lines.join('\n')}\n`);
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

/**
 * The controlled arm, driven as the real binary (asc-xn4g).
 *
 * The after arm of this fixture is two units -- `sC`'s only segment and `sE`'s second -- so a
 * decision about each one moves a whole unit, and a decision about anything else moves nothing.
 */
describe('asc handlers compare: the holdout arm', () => {
  it('says controlled and splits the after arm by the arm the hook assigned', () => {
    const home = fixture([
      { session: 'sC', segment: 0, arm: 'held_out' },
      { session: 'sE', segment: 1, arm: 'delivered' },
    ]);
    const run = compare(home);
    expect(valueOf(run, 'design')).toMatch(/^controlled -- /);
    expect([
      valueOf(run, 'after.delivered.units'),
      valueOf(run, 'after.delivered.with_row'),
      valueOf(run, 'after.held_out.units'),
      valueOf(run, 'after.held_out.with_row'),
      valueOf(run, 'after.unassigned'),
    ]).toEqual([1, 1, 1, 0, 0]);
  });

  it('keeps the whole after arm printed beside the split', () => {
    // The split adds to the reading; it does not replace it. A reader who wants after-minus-before
    // still has both arms, and a reader checking the split can see it add up.
    const run = compare(
      fixture([
        { session: 'sC', segment: 0, arm: 'held_out' },
        { session: 'sE', segment: 1, arm: 'delivered' },
      ]),
    );
    expect([valueOf(run, 'after.units'), valueOf(run, 'before.units')]).toEqual([2, 3]);
  });

  it('counts an after unit the hook never decided as unassigned', () => {
    // `sE`'s second segment matched the handler and produced a row, and no decision names it: the
    // hook was not running for that unit. Reading it as either arm would invent an experiment.
    const run = compare(fixture([{ session: 'sC', segment: 0, arm: 'held_out' }]));
    expect([
      valueOf(run, 'after.held_out.units'),
      valueOf(run, 'after.delivered.units'),
      valueOf(run, 'after.unassigned'),
    ]).toEqual([1, 0, 1]);
  });

  it('stays observational when the decisions are for another version of the handler', () => {
    // A handler edited since the experiment began. The units decided under the old sentence are not
    // evidence about the new one, and saying `controlled` over them would claim that they are.
    const home = fixture([{ session: 'sC', segment: 0, arm: 'held_out', version: 'ffffffff' }]);
    const run = compare(home);
    expect([valueOf(run, 'design'), valueOf(run, 'after.delivered.units')]).toEqual([
      expect.stringMatching(/^observational -- /),
      undefined,
    ]);
  });

  it('stays observational when no decision names a unit in the replay', () => {
    const run = compare(fixture([{ session: 'some-other-session', segment: 0, arm: 'held_out' }]));
    expect([valueOf(run, 'design'), valueOf(run, 'after.unassigned')]).toEqual([
      expect.stringMatching(/^observational -- /),
      undefined,
    ]);
  });

  it('withholds the controlled difference while a side is under MIN_N', () => {
    const run = compare(
      fixture([
        { session: 'sC', segment: 0, arm: 'held_out' },
        { session: 'sE', segment: 1, arm: 'delivered' },
      ]),
    );
    expect(valueOf(run, 'difference')).toMatch(/^not estimated -- the delivered or held-out arm /);
  });

  it('prints no arm at all when the hook never ran, leaving every byte as it was', () => {
    // The path this command has always had. `design` is the module's constant, printed here as a
    // literal rather than imported, because "byte-identical" is the property and a test that read
    // the constant could not tell it had changed. `difference` is after-minus-before, and no split
    // row exists.
    const run = compare(fixture());
    expect([
      valueOf(run, 'design'),
      valueOf(run, 'difference'),
      valueOf(run, 'after.unassigned'),
      valueOf(run, 'after.delivered.units'),
    ]).toEqual([
      'observational -- the change was not assigned at random, so a difference is a correlation, ' +
        'not the change’s effect',
      'not estimated -- an arm has fewer than 20 units, and a difference between anecdotes is no ' +
        'estimate',
      undefined,
      undefined,
    ]);
  });
});
