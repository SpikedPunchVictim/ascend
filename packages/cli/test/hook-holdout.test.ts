import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armFor } from '../src/holdout-arm.js';
import { readDecided } from '../src/exposure-log.js';
import { unitKey } from '../src/handler-replay.js';
import { loadProjectHandlers } from '../src/typed-handlers.js';

/**
 * The holdout arm in `asc hook` (asc-xn4g), driven as the real binary.
 *
 * The arm a unit lands in is a hash, so these tests do not hard-code which side a session falls on:
 * each computes the expected arm from the same primitives the command uses, and then asserts the
 * command did that. A hard-coded expectation would pass for the wrong reason the first time the
 * seed or the key changed.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');
const TS = '2026-10-12T00:00:00.000Z';

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const NUDGE = [
  'on: tool.use.start',
  'where:',
  '  tool: Skill',
  '  skill: {in: [bug-hunt]}',
  "say: 'Report each finding from ${skill} with ReportFindings.'",
  '',
].join('\n');

const SAYS = 'Report each finding from bug-hunt with ReportFindings.';

/**
 * The store tree the decisions land in. `readDecided` takes the tree, so a read that assumed the
 * project root would agree with a write that assumed it too -- and both would be wrong together,
 * which is how this pair first passed while writing outside `.ascend/`.
 */
const tree = (dir: string): string => join(dir, '.ascend');

/** The context the JSON envelope carries, which is how both tool stages deliver. */
const delivered = (stdout: string): string =>
  (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;

/** A project holding `NUDGE`, a transcript with `compactions` boundaries, and a writable store. */
function project(compactions = 0): { dir: string; transcript: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asc-holdout-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ascend'));
  mkdirSync(join(dir, 'handlers'));
  writeFileSync(join(dir, 'handlers', 'nudge.yaml'), NUDGE, 'utf8');
  const transcript = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', sessionId: 's-1', timestamp: TS, message: { content: 'go' } }),
  ];
  for (let index = 0; index < compactions; index += 1) {
    lines.push(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        sessionId: 's-1',
        timestamp: TS,
        compactMetadata: { trigger: 'auto' },
      }),
    );
  }
  writeFileSync(transcript, `${lines.join('\n')}\n`, 'utf8');
  return { dir, transcript };
}

function hook(stage: string, input: unknown, cwd: string, args: readonly string[] = []) {
  const result = spawnSync(process.execPath, [bin, 'hook', stage, ...args], {
    cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const skillCall = (dir: string, transcript: string, session: string) => ({
  session_id: session,
  cwd: dir,
  transcript_path: transcript,
  hook_event_name: 'PostToolUse',
  tool_name: 'Skill',
  tool_input: { skill: 'bug-hunt' },
  tool_response: { success: true },
  tool_use_id: 'toolu_1',
});

/** The arm the command itself should reach, derived from the same primitives rather than guessed. */
function expectedArm(dir: string, session: string, segment: number, rate: number): string {
  const one = loadProjectHandlers(dir).say[0];
  if (one === undefined) throw new Error('the fixture project has no say handler');
  return armFor(
    unitKey(session, 'main', segment),
    { id: one.name, version: one.handler.hash },
    rate,
  );
}

/** A session id whose unit lands on `want`, found by asking rather than by assuming. */
function sessionFor(dir: string, segment: number, rate: number, want: string): string {
  for (let index = 0; index < 200; index += 1) {
    const session = `s-${String(index)}`;
    if (expectedArm(dir, session, segment, rate) === want) return session;
  }
  throw new Error(`no session landed on ${want}`);
}

describe('asc hook --holdout', () => {
  it('delivers as before, and records the decision, when the unit is not held out', () => {
    const { dir, transcript } = project();
    const session = sessionFor(dir, 0, 0.5, 'delivered');
    const run = hook('post-tool-use', skillCall(dir, transcript, session), dir, [
      '--holdout',
      '0.5',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(delivered(run.stdout)).toBe(SAYS);
    const [record] = readDecided(tree(dir));
    expect(record).toMatchObject({
      arm: 'delivered',
      intervention_id: 'nudge',
      rate: 0.5,
      segment: 0,
    });
  });

  it('says nothing, exits 0, names the holdout on stderr, and still records it', () => {
    const { dir, transcript } = project();
    const session = sessionFor(dir, 0, 0.5, 'held_out');
    const run = hook('post-tool-use', skillCall(dir, transcript, session), dir, [
      '--holdout',
      '0.5',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('held out');
    expect(readDecided(tree(dir)).map((one) => one.arm)).toEqual(['held_out']);
  });

  it('reads the segment off the transcript, so a compacted unit is a different unit', () => {
    const { dir, transcript } = project(2);
    const session = sessionFor(dir, 2, 0.5, 'delivered');
    hook('post-tool-use', skillCall(dir, transcript, session), dir, ['--holdout', '0.5']);
    expect(readDecided(tree(dir)).map((one) => one.segment)).toEqual([2]);
  });

  it('decides per unit, not per event: the same unit twice takes the same arm', () => {
    const { dir, transcript } = project();
    const session = sessionFor(dir, 0, 0.5, 'held_out');
    const one = hook('post-tool-use', skillCall(dir, transcript, session), dir, [
      '--holdout',
      '0.5',
    ]);
    const two = hook('post-tool-use', skillCall(dir, transcript, session), dir, [
      '--holdout',
      '0.5',
    ]);
    expect(one.stdout).toBe('');
    expect(two.stdout).toBe('');
    expect(readDecided(tree(dir)).map((record) => record.arm)).toEqual(['held_out', 'held_out']);
  });

  it('runs no experiment, and writes nothing, when the rate cannot be parsed', () => {
    const { dir, transcript } = project();
    const run = hook('post-tool-use', skillCall(dir, transcript, 's-1'), dir, [
      '--holdout',
      'nope',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(delivered(run.stdout)).toBe(SAYS);
    expect(readDecided(tree(dir))).toEqual([]);
  });

  it('writes the decision inside .ascend, not beside it', () => {
    // The pair this guards against is a write and a read that agreed on the wrong directory: both
    // took the project root, both "worked", and the log landed outside the store -- untracked, and
    // gone from the next clone. So the assertion is on the PATH, not on a round trip.
    const { dir, transcript } = project();
    const session = sessionFor(dir, 0, 0.5, 'delivered');
    hook('post-tool-use', skillCall(dir, transcript, session), dir, ['--holdout', '0.5']);
    expect(existsSync(join(dir, '.ascend', 'exposure', 'decided.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'exposure'))).toBe(false);
  });

  it('still delivers when the exposure log cannot be written', () => {
    // The failure this guards is the one that reads as success: an exception from the log write
    // reaching `catch` exits 0, and the delivery silently never happens.
    const { dir, transcript } = project();
    const session = sessionFor(dir, 0, 0.5, 'delivered');
    // A FILE where the log's directory must be, so creating the directory fails.
    writeFileSync(join(dir, '.ascend', 'exposure'), 'not a directory', 'utf8');
    const run = hook('post-tool-use', skillCall(dir, transcript, session), dir, [
      '--holdout',
      '0.5',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(delivered(run.stdout)).toBe(SAYS);
    expect(run.stderr).toContain('exposure log could not be written');
  });
});
