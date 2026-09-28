import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** `asc doctor` through the real binary (asc-12a). The checks themselves are in doctor.test.ts. */

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

function asc(args: readonly string[], cwd: string): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout };
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-doctor-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

interface Finding {
  readonly check: string;
  readonly status: string;
  readonly subject: string;
}

describe('asc doctor', () => {
  it('reports every check on a fresh store, and exits 0 with warnings present', () => {
    const run = asc(['doctor', '--json'], project());
    expect(run.status).toBe(0);
    const rows = (JSON.parse(run.stdout) as { rows: Finding[] }).rows;
    expect([...new Set(rows.map((row) => row.check))]).toEqual([
      'dead_type',
      'near_duplicate',
      'version_drift',
      'property_states',
      'brief_size',
      'export',
    ]);
  });

  it('names each starter type as dead until something is recorded', () => {
    const dir = project();
    const starters = (
      JSON.parse(asc(['types', 'list', '--json'], dir).stdout) as {
        rows: { name: string }[];
      }
    ).rows.map((row) => row.name);
    const rows = (JSON.parse(asc(['doctor', '--json'], dir).stdout) as { rows: Finding[] }).rows;
    const dead = rows.filter((row) => row.check === 'dead_type' && row.status === 'warn');
    expect(dead.map((row) => row.subject).sort()).toEqual([...starters].sort());
  });
});
