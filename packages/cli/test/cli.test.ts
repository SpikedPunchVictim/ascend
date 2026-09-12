import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The CLI, driven as the real binary.
 *
 * **These tests spawn `dist/bin.js`.** They do not import a command class and call it, and
 * that is the point: what can be wrong with a CLI is mostly not inside the command body.
 * It is the entry point, oclif's command discovery, the flag parser, which stream a
 * message lands on, and what the process exits with -- none of which a direct call
 * exercises. `empirical-planning` P5 is explicit that availability is not correctness:
 * green unit tests with fakes are not the same as the thing working.
 *
 * **The cost is that this file needs `dist/`.** `vitest.config.ts` aliases `@ascend/*` to
 * source so the rest of the suite needs no build; a subprocess cannot be aliased -- and the
 * entry point IS a subprocess target, compiled like everything else, so this file builds
 * once in `beforeAll` instead of asking a human to remember. It is `tsc -b`, so it is about
 * a second warm and three cold. The build failing is a test failure, which is the correct
 * outcome and not a silent skip.
 *
 * **Hermetic.** Every run gets a fresh temp directory as `cwd` AND as `HOME`, so nothing
 * reads the developer's real configuration and nothing this suite does can reach outside
 * its own scratch tree. (`cli-best-practices`, testing.)
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const dirs: string[] = [];

/** A fresh directory, isolated as both cwd and HOME. Registered for cleanup. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-cli-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A directory holding an `.ascend/` store, with nothing registered in it yet. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.ascend'));
  return dir;
}

describe('the entry point', () => {
  it('reports a version and exits 0', () => {
    const run = asc(['--version'], scratch());
    expect(run.status).toBe(0);
    // oclif's own format: `<name>/<version> <platform> <node>`. Asserted as a substring
    // rather than a whole-line match so a Node upgrade does not fail this test.
    expect(run.stdout).toContain('/0.0.0');
  });

  it('lists the types topic in help', () => {
    const run = asc(['--help'], scratch());
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('types');
  });
});

describe('finding the project', () => {
  it('refuses outside a project, naming where it looked and how to fix it', () => {
    const dir = scratch();
    const run = asc(['types', 'list'], dir);

    expect(run.status).toBe(1);
    // Both halves of this assertion are the contract. The path says WHERE it looked --
    // "no store found" without that is an error the user cannot act on -- and `asc init`
    // is the fix. An error that only reports the problem is half an error.
    expect(run.stderr).toContain(dir.replace('/private', ''));
    expect(run.stderr).toContain('asc init');
    expect(run.stderr).toContain('.ascend');
  });

  it('finds the store from a subdirectory, not only from the project root', () => {
    const dir = project();
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    const run = asc(['types', 'list', '--json'], sub);

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ row_count: 0 });
  });
});

describe('the output formats', () => {
  it('defaults to a table even when stdout is not a terminal', () => {
    // The decision this test exists for: the format does NOT follow the TTY. Piped is
    // the case where a "helpful" default to JSON would be tempting, and it would make the
    // same command produce different bytes depending on how it was invoked.
    const run = asc(['types', 'list'], project());

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('name');
    expect(() => JSON.parse(run.stdout) as unknown).toThrow();
  });

  it('emits a versioned envelope for --json', () => {
    const run = asc(['types', 'list', '--json'], project());

    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(parsed['ascend_output']).toBe(1);
    expect(parsed['rows']).toEqual([]);
    expect(parsed['row_count']).toBe(0);
  });

  it('emits a CSV header for --csv', () => {
    const run = asc(['types', 'list', '--csv'], project());

    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('name,version,properties,entries,status');
  });

  it('refuses two formats at once as a usage error', () => {
    const run = asc(['types', 'list', '--json', '--csv'], project());

    // 2, not 1: the command line was wrong. The two codes need different responses --
    // re-read the help, versus the command was understood and the answer was no.
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--json');
    expect(run.stderr).toContain('--csv');
  });
});

describe('the stream contract', () => {
  it('puts results on stdout and nothing else there', () => {
    const run = asc(['types', 'list', '--json'], project());

    // Parsing the WHOLE stdout, not a substring of it. Anything else ascend printed --
    // a notice, a warning, a deprecation hint -- would make this throw.
    expect(() => JSON.parse(run.stdout) as unknown).not.toThrow();
  });

  it('puts failures on stderr and leaves stdout empty', () => {
    const run = asc(['types', 'list'], scratch());

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr.length).toBeGreaterThan(0);
  });
});

/**
 * NOT TESTED HERE, and stated rather than left to be assumed: **EPIPE end to end**.
 *
 * `asc ... | head -1` must exit 0 rather than print a stack trace. The DECISION behind that
 * is covered by `streams.test.ts`, which feeds the guard an EPIPE and watches the exit code.
 * What no test here can prove is that the OS ever delivers that event to this process: a
 * pipe buffer on this platform holds 64 KiB, and the largest thing any command can currently
 * print is a table with one row per registered type, so a test written against `types list`
 * would pass whether or not the guard existed. That is the false-green `TASKS.md` #5 and
 * this project's whole evidence discipline exist to reject, so the test is not written.
 *
 * The trigger arrives with `asc query` (`asc-6ct`), the first command whose output scales
 * with the entry count. Until then the install step is **unproven**, and measured to be so
 * rather than assumed: replacing `installPipeGuards()` in `src/bin.ts` with `void 0` leaves
 * this suite green (mutation M8, 2026-09-12). What IS covered is that the entry point loads
 * the module at all -- pointing its import at a nonexistent file fails every test here (M7)
 * -- so the gap is one call wide, not the whole wiring.
 */
