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
  readonly detail: string;
}

describe('asc doctor', () => {
  it('reports the brief size of what the brief actually prints, header and all (asc-uftd)', () => {
    // This is the test that decided where the recording command lives. `brief-text.ts` is shared
    // between `asc types brief` and this check precisely so the doctor "reports the size of what
    // the brief actually prints", and `BRIEF_CAP_BYTES` bounds that same text. A command line
    // emitted by `.claude/ascend-hook.sh` instead would sit outside both: the SessionStart payload
    // would run over the cap by an uncharged line, and this number would go on reporting a size
    // that had stopped being true. Driving both commands and comparing them is the only form of
    // the check that can fail.
    const dir = project();

    const printed = asc(['types', 'brief'], dir).stdout;
    // `this.log` appends the newline; the doctor measures the text, without it.
    const measured = printed.replace(/\n$/, '');
    expect(measured).toContain('asc record');

    const rows = (
      JSON.parse(asc(['doctor', '--json'], dir).stdout) as {
        rows: Finding[];
      }
    ).rows;
    const brief = rows.find((row) => row.check === 'brief_size');
    expect(brief?.detail.startsWith(`${String(Buffer.byteLength(measured, 'utf8'))} bytes,`)).toBe(
      true,
    );
  });

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
