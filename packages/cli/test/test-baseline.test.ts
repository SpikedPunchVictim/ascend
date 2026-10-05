import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The test-count baseline refuses when the suite collects fewer tests than the repo says it
 * should (asc-049w).
 *
 * WHY THIS IS A TEST AND NOT ONLY A HOOK STEP'S PROBLEM. `dogfood/0061` is a green gate over a file
 * whose 55 tests had become 5. A gate cannot report that it is missing a check, so the comparison
 * needs a red that can be seen before the day it matters -- and the gate's own wiring is already
 * covered by `dev-hooks.test.ts`, which stubs this script out. This file covers what the script
 * DOES: which decreases it refuses, which it lets through, and what it says.
 *
 * WHAT IT DOES NOT PROVE. It drives the script over hand-written counts. It does not prove that
 * `vitest.test-count.ts` writes the counts a real run actually collected -- that reconciliation is
 * a measurement recorded in `docs/evidence/EV-hooks.md`, because a reporter's output cannot be
 * asserted into existence from here.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SCRIPT = join(root, 'scripts', 'test-baseline.mjs');

interface Counts {
  files: number;
  tests: number;
  passed: number;
  byFile: Record<string, number>;
}

/** A baseline whose floors are exactly met, so each case can move one number and nothing else. */
function counts(overrides: Partial<Counts> = {}): Counts {
  return {
    files: 1,
    tests: 10,
    passed: 10,
    byFile: { 'packages/x/test/a.test.ts': 10 },
    ...overrides,
  };
}

let dir = '';
let baselinePath = '';
let scanPath = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'asc-baseline-'));
  baselinePath = join(dir, 'baseline.json');
  scanPath = join(dir, 'scan.json');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the script against whatever the two fixture files hold right now. */
function invoke(action: string): { status: number | null; output: string } {
  const result = spawnSync(
    'node',
    [SCRIPT, action, '--baseline', baselinePath, '--scan', scanPath],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

/** Writes a fixture file, or removes it, so the absent-input arms are expressible. */
function write(path: string, value: Counts | null): void {
  rmSync(path, { force: true });
  if (value !== null) writeFileSync(path, JSON.stringify(value), 'utf8');
}

function run(
  action: string,
  baseline: Counts | null,
  scan: Counts | null,
): { status: number | null; output: string } {
  write(baselinePath, baseline);
  write(scanPath, scan);
  return invoke(action);
}

describe('the test-count baseline', () => {
  it('passes when every floor is met, and says how far above the baseline it is', () => {
    const grown = counts({
      files: 2,
      tests: 14,
      passed: 14,
      byFile: { 'packages/x/test/a.test.ts': 10, 'packages/x/test/b.test.ts': 4 },
    });
    const { status, output } = run('check', counts(), grown);
    expect(output).toContain('4 above baseline');
    expect(status).toBe(0);
  });

  it('refuses when a file collects fewer tests than its floor, and names the file', () => {
    const shrunk = counts({
      files: 2,
      tests: 10,
      passed: 10,
      byFile: { 'packages/x/test/a.test.ts': 5, 'packages/x/test/b.test.ts': 5 },
    });
    const { status, output } = run('check', counts(), shrunk);
    expect(status).toBe(1);
    expect(output).toContain('BELOW baseline');
    expect(output).toContain('SHRANK');
    expect(output).toContain('packages/x/test/a.test.ts  10 -> 5 (-5)');
  });

  it('refuses when a baselined file is absent from the run entirely', () => {
    const gone = counts({
      files: 1,
      tests: 5,
      passed: 5,
      byFile: { 'packages/x/test/other.test.ts': 5 },
    });
    const { status, output } = run('check', counts(), gone);
    expect(status).toBe(1);
    expect(output).toContain('GONE');
    expect(output).toContain('packages/x/test/a.test.ts  10 -> 0 (-10)');
  });

  it('refuses on a falling total even when every per-file floor is still met', () => {
    // The belt-and-braces arm. A baseline whose total sits ABOVE the sum of its own floors is
    // inconsistent, and the comparison must not shrug because no single file moved.
    const inconsistent = counts({ tests: 10, byFile: { 'packages/x/test/a.test.ts': 5 } });
    const scan = counts({
      files: 1,
      tests: 8,
      passed: 8,
      byFile: { 'packages/x/test/a.test.ts': 5 },
    });
    const { status, output } = run('check', inconsistent, scan);
    expect(status).toBe(1);
    expect(output).toContain('BELOW   collected tests  10 -> 8 (-2)');
  });

  it('refuses when a test stops passing, which the collected count cannot see', () => {
    // `it(...)` -> `it.skip(...)` keeps the collected count flat and loses the coverage. This is
    // the arm a collected-count baseline alone would bless.
    const { status, output } = run('check', counts(), counts({ passed: 9 }));
    expect(status).toBe(1);
    expect(output).toContain('BELOW   passed tests  10 -> 9 (-1)');
  });

  it('passes on growth alone, because the acceptance fails on a drop and not on an addition', () => {
    const grown = counts({
      files: 1,
      tests: 12,
      passed: 12,
      byFile: { 'packages/x/test/a.test.ts': 12 },
    });
    const { status, output } = run('check', counts(), grown);
    expect(output).toContain('2 above baseline');
    expect(status).toBe(0);
  });

  it('cannot check without a scan, and says so rather than passing', () => {
    const { status, output } = run('check', counts(), null);
    expect(status).toBe(2);
    expect(output).toContain('CANNOT CHECK');
    expect(output).toContain('no scan at');
  });

  it('cannot check without a baseline, pointing at the command that makes one', () => {
    const { status, output } = run('check', null, counts());
    expect(status).toBe(2);
    expect(output).toContain('no baseline at');
    expect(output).toContain('pnpm test:baseline');
  });

  it('update writes the scan as the new floor, and what it wrote is what the next check reads', () => {
    const lowered = counts({
      files: 1,
      tests: 6,
      passed: 6,
      byFile: { 'packages/x/test/a.test.ts': 6 },
    });
    const { status, output } = run('update', counts(), lowered);
    expect(status).toBe(0);
    expect(output).toContain('LOWERED  packages/x/test/a.test.ts  10 -> 6');

    const written: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
    expect(written).toMatchObject({
      files: 1,
      tests: 6,
      passed: 6,
      byFile: { 'packages/x/test/a.test.ts': 6 },
    });

    // Read the file update WROTE, without rewriting it: the removed floor is now the floor, so the
    // same scan passes -- and one test below it does not.
    expect(invoke('check').status).toBe(0);
    write(scanPath, counts({ tests: 5, passed: 5, byFile: { 'packages/x/test/a.test.ts': 5 } }));
    expect(invoke('check').status).toBe(1);
  });

  it('cannot update without a scan, so a baseline is never taken from nothing', () => {
    const { status, output } = run('update', counts(), null);
    expect(status).toBe(2);
    expect(output).toContain('CANNOT CHECK');
  });
});
