import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_CONTRACT_VERSION } from '@ascend/cli';

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
    expect(parsed['ascend_output']).toBe(OUTPUT_CONTRACT_VERSION);
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
 * Enough rows that the output clears a 64 KiB pipe with room to spare, and no more.
 *
 * `asc query` runs raw SQL, so this needs no fixture and no stored entries -- which is the whole
 * point of `asc-6ct` no longer being a prerequisite. Each row renders at about 49 bytes (a small
 * integer, a tab, and the 40-character pad), so 5,000 rows is roughly 245 KB: comfortably past the
 * pipe, and a fraction of the work the note above was waiting for.
 */
const BIG_QUERY =
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<5000) ` +
  `SELECT x, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AS pad FROM c`;

describe('a reader that closes the pipe early', () => {
  /**
   * A project with the store CREATED, which is not `project()` above.
   *
   * Measured, because the difference is not visible from the helper's name: `asc query` against a
   * bare `.ascend/` directory fails with *unable to open database file* and exits 1, so the query
   * never runs and this whole block would be testing a startup failure. `asc init` applies the
   * schema, and the same query then succeeds with 235,057 bytes.
   */
  function initialized(): string {
    const dir = scratch();
    mkdirSync(join(dir, '.git'));
    expect(asc(['init'], dir).status).toBe(0);
    return dir;
  }

  it('is a reader the output actually overruns', () => {
    // The precondition, and the reason it is asserted rather than assumed: if this query ever
    // stopped exceeding the pipe, `head -1` would read everything, no EPIPE would be delivered,
    // and the test below would pass while proving nothing. That is the false-green this project
    // treats as severity-zero, so the trigger is checked before the behaviour is.
    //
    // Compared as character counts against a byte capacity, which is exact here because every byte
    // of this output is ASCII (integers, tabs, and a row of `a`). A payload with a multi-byte
    // character in it would need `Buffer.byteLength`, and this says so rather than leaving the
    // next reader to notice.
    const run = asc(['query', BIG_QUERY], initialized());
    expect(run.status).toBe(0);
    expect(
      run.stdout.length,
      `the query produced ${String(run.stdout.length)} bytes, which does not exceed a ` +
        `64 KiB pipe -- raise the row count, or the test below cannot fail`,
    ).toBeGreaterThan(65_536);
  });

  it('exits 0 without a stack trace', () => {
    // The contract: `asc query ... | head -1` is an ordinary, successful pipeline. A reader that
    // took its one line and left is not an error, and printing a stack trace at it is the failure
    // the guard exists to prevent.
    //
    // `bash` and `pipefail` so the status measured is ASCEND's, not `head`'s -- a pipeline reports
    // the last command, which here is 0 whatever ascend did.
    const dir = initialized();
    const script = [
      'set -o pipefail',
      `"${process.execPath}" "${bin}" query ${JSON.stringify(BIG_QUERY)} | head -1 >/dev/null`,
      'echo "ascend=$?"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') },
      timeout: 30_000,
    });

    // Asserted before the exit code, because a hang would otherwise show up as a confusing
    // mismatch rather than as a hang.
    expect(result.error, 'the pipeline was killed at the timeout').toBeUndefined();

    // stdout is inherited from bash through spawnSync, NOT piped into `head`, so a stack trace
    // would land here and be caught. (In the stderr twin in `8pp-truncation.test.ts` it cannot:
    // ascend's stderr goes into a pipe `head` has already closed, so a trace would be discarded
    // rather than observed -- which is why that arm asserts a different property.)
    expect(result.stderr).not.toMatch(/\n\s+at .*:\d+:\d+/);
    expect(result.stdout.trim()).toBe('ascend=0');
  });
});

/**
 * **EPIPE end to end**: `asc ... | head -1` must exit 0 rather than print a stack trace.
 *
 * The DECISION behind that is covered by `streams.test.ts`, which feeds the guard an EPIPE and
 * watches the exit code. This block covers what that file cannot: that the OS delivers the event
 * to this process at all, and that the ordinary pipeline stays quiet when it does.
 *
 * **The earlier claim, and what replaced it.** This note used to say no test here could prove
 * that, because a pipe holds 64 KiB and *"the largest thing any command can currently print is a
 * table with one row per registered type"*, so a test would pass whether or not the guard existed.
 * That was wrong, and measurably so: `asc query` takes raw SQL, and a recursive CTE produces
 * **9,800,061 bytes** with no stored data at all -- far past the pipe. What the earlier note got
 * right is that `types list` would have been the wrong command to write it against.
 *
 * **What this block does NOT prove, corrected 2026-09-14.** It used to end by saying that removing
 * `installPipeGuards()` from `src/bin.ts` (mutation M8) "now fails here". It does not, and the
 * reason is a fact about the dependency rather than about the test: **oclif installs its own EPIPE
 * handler on stdout** -- `@oclif/core/lib/command.js:57`, `process.stdout.on('error', err => { if
 * (err.code === 'EPIPE') return; throw err })`, registered when the `Command` class module loads.
 * That is the same decision `guardBrokenPipes` makes, reached independently of ascend. Measured
 * with a tap on the event: `TAP-stdout EPIPE` fires during `asc query ... | head -c 1`, and the
 * exit status and stderr are identical with the guard installed and with the call removed. So this
 * block pins the contract -- the pipeline is quiet and exits 0 -- and it cannot distinguish the
 * guard's presence on stdout, because something else already provides it.
 *
 * **And the same tap says why the guard stays.** At exit the stdout stream had 3 `error` listeners
 * and stderr had exactly the tap's own one: oclif covers stdout and **not** stderr. The stderr half
 * of `guardBrokenPipes` therefore has no equivalent underneath it, which is where the guard is
 * load-bearing rather than duplicative.
 */
