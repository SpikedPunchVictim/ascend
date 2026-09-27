import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc hook <stage>` (asc-tuur.4), driven as the real binary with the hook input on stdin, the way
 * Claude Code runs it. Inputs carry the keys the Stage 0 probe measured; values are synthetic.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

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

function project(handlers: Record<string, string> = { 'nudge.yaml': NUDGE }): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-hook-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.ascend'));
  mkdirSync(join(dir, 'handlers'));
  for (const [name, text] of Object.entries(handlers)) {
    writeFileSync(join(dir, 'handlers', name), text);
  }
  return dir;
}

function hook(stage: string, input: unknown, cwd: string) {
  const result = spawnSync(process.execPath, [bin, 'hook', stage], {
    cwd,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const skillCall = (dir: string, skill: string) => ({
  session_id: 's-1',
  cwd: dir,
  hook_event_name: 'PostToolUse',
  tool_name: 'Skill',
  tool_input: { skill },
  tool_response: { success: true },
  tool_use_id: 'toolu_1',
});

describe('asc hook post-tool-use', () => {
  it('prints the JSON envelope with what a matching handler says', () => {
    const dir = project();
    const run = hook('post-tool-use', skillCall(dir, 'bug-hunt'), dir);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Report each finding from bug-hunt with ReportFindings.',
      },
    });
  });

  it('prints nothing when no handler matches', () => {
    const dir = project();
    const run = hook('post-tool-use', skillCall(dir, 'commit'), dir);
    expect(run).toMatchObject({ status: 0, stdout: '' });
  });

  it('prints nothing, and exits 0, on input that is not JSON', () => {
    const dir = project();
    const run = hook('post-tool-use', 'not json', dir);
    expect(run).toMatchObject({ status: 0, stdout: '' });
    expect(run.stderr).toMatch(/not JSON/);
  });

  it('exits 0 on a stage it does not know', () => {
    const dir = project();
    const run = hook('nope', skillCall(dir, 'bug-hunt'), dir);
    expect(run).toMatchObject({ status: 0, stdout: '' });
  });

  it('prints nothing outside an ascend project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-hook-bare-'));
    dirs.push(dir);
    const run = hook('post-tool-use', skillCall(dir, 'bug-hunt'), dir);
    expect(run).toMatchObject({ status: 0, stdout: '' });
  });

  it('runs the other handlers when one does not load, and names the one that did not', () => {
    const dir = project({ 'nudge.yaml': NUDGE, 'broken.yaml': 'on: nope\nsay: x\n' });
    const run = hook('post-tool-use', skillCall(dir, 'bug-hunt'), dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/ReportFindings/);
    expect(run.stderr).toMatch(/handler handlers\/broken\.yaml was not run/);
  });

  it('drops a sentence whole, and names it, when the stage output would pass the cap', () => {
    const long = `on: tool.use.start\nsay: '${'x'.repeat(5000)}'\n`;
    const dir = project({ 'a.yaml': NUDGE, 'b.yaml': long });
    const run = hook('post-tool-use', skillCall(dir, 'bug-hunt'), dir);
    expect(
      (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext,
    ).toBe('Report each finding from bug-hunt with ReportFindings.');
    expect(run.stderr).toMatch(/handler b was not said/);
  });

  it('does not run a say handler whose trigger no hook stage delivers', () => {
    const dir = project({ 'end.yaml': "on: session.end\nsay: 'bye'\n" });
    const run = hook('post-tool-use', skillCall(dir, 'bug-hunt'), dir);
    expect(run.stdout).toBe('');
    expect(run.stderr.replace(/\s+/g, ' ')).toMatch(/no lifecycle hook delivers session\.end/);
  });
});

describe('asc hook user-prompt-submit', () => {
  it('prints plain text, which is the channel this stage delivers', () => {
    const dir = project({
      'p.yaml': "on: prompt.submit\nwhere: {text: {matches: review}}\nsay: 'Use ReportFindings.'\n",
    });
    const run = hook(
      'user-prompt-submit',
      { session_id: 's-1', cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'review this' },
      dir,
    );
    expect(run.stdout.trim()).toBe('Use ReportFindings.');
  });
});
