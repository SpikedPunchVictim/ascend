import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_FLAGS } from '../src/base.js';
import { ROOT_EXAMPLES } from '../src/help.js';

/**
 * `asc --help` at the ROOT, and the argv routing that makes the root's flags real.
 *
 * `asc-3u2` items (a), (b) and (d). Three defects with one shape: a screen that promises something
 * the command line does not do, or refuses something the screen never mentioned.
 *
 *   (a) the root help carried no FLAGS and no EXAMPLES -- measured, `grep -c '^FLAGS'` and
 *       `grep -c '^EXAMPLES'` were both 0 -- while every subcommand's help carried both.
 *   (b) `asc --json` exited 2 with `command --json not found`, because `bin.ts` applied the
 *       `types brief` default only to a FULLY empty argv. The base output flags were unreachable on
 *       the root, so the natural spelling of "the brief, as JSON" was an error.
 *   (d) `asc types export --help` listed `--csv`, which that command refuses.
 *
 * **These spawn the real binary** (`cli.test.ts` records why: what can be wrong with a CLI is
 * mostly not inside a command body). It is also the only level at which (b) exists at all -- the
 * routing happens in `bin.ts`, before any command class is constructed.
 *
 * **The strongest test here runs the help text rather than reading it.** `the examples in the root
 * help are executed` takes every line of `ROOT_EXAMPLES`, strips the `$ ` prompt and runs it. A
 * help screen whose examples are not real command lines is the same defect as (d) -- text that
 * describes something that does not work -- and it is not detectable by looking at the text, which
 * is precisely why (d) survived review until someone typed the flag.
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

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-help-'));
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

/** A directory that looks like a repository, with the starter types installed. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  const run = asc(['init'], dir);
  expect(run.status).toBe(0);
  return dir;
}

/**
 * Help text as lines, with oclif's wrap decoration removed.
 *
 * oclif wraps at the terminal width and prefixes continuation lines with ` › `. A test that
 * asserted on the raw text would fail on a phrase that is plainly there (`helpers.ts` records the
 * measurement), and -- worse for this file -- `not.toContain('--csv')` in the export help would
 * PASS on text where `--csv` is present but wrapped.
 */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the root help carries what every subcommand’s help carries', () => {
  it('has a FLAGS section naming every output flag base.ts declares', () => {
    // Asserted against `OUTPUT_FLAGS` rather than against four literal strings. The section is
    // built by reading that object, so this is the check that the reading still reaches the screen:
    // a fifth output flag added to `base.ts` fails here rather than shipping undocumented.
    const run = asc(['--help'], scratch());

    expect(run.status).toBe(0);
    expect(flatten(run.stdout)).toContain('FLAGS');
    for (const name of Object.keys(OUTPUT_FLAGS)) {
      expect(flatten(run.stdout)).toContain(`--${name}`);
    }
  });

  it('has an EXAMPLES section', () => {
    expect(flatten(asc(['--help'], scratch()).stdout)).toContain('EXAMPLES');
  });

  it('executes every example it prints, because an example that is not a command is a lie', () => {
    // The root help is the one screen a new caller reads, and `asc-3u2` (d) is the proof that help
    // text goes unchecked: `--csv` was advertised on a command that refuses it, and it took someone
    // TYPING the flag to find out. Running the examples is the check that reading them cannot be.
    const dir = project();

    const failures: string[] = [];
    for (const example of ROOT_EXAMPLES) {
      // `$ asc --json` -> `['--json']`. The prompt is help's convention, not part of the command.
      const argv = example.replace(/^\$ /, '').split(' ').slice(1);
      const run = asc(argv, dir);
      if (run.status !== 0) {
        failures.push(
          `"${example}" exited ${String(run.status)}: ${flatten(run.stderr).slice(0, 120)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it('says what a bare `asc` does, which is the one thing a root help has to say', () => {
    // `asc` with no args runs `types brief` and nothing in the help said so -- so `asc --json` was
    // unreachable AND unexplained.
    expect(flatten(asc(['--help'], scratch()).stdout)).toContain('types brief');
  });

  it('still documents --version by showing it', () => {
    expect(flatten(asc(['--help'], scratch()).stdout)).toContain('asc --version');
  });
});

describe('output flags on the root reach the command a bare `asc` runs', () => {
  it('answers `asc --json` with the versioned envelope', () => {
    // Before: exit 2, `command --json not found`.
    const run = asc(['--json'], project());

    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ascend_output: 2, row_count: 4 });
  });

  it('makes `asc --json` byte-identical to the command it stands for', () => {
    // Equality rather than "both parse": two spellings of one thing that produce different bytes
    // are two things, and the whole justification for routing is that they are one.
    const dir = project();

    expect(asc(['--json'], dir).stdout).toBe(asc(['types', 'brief', '--json'], dir).stdout);
  });

  it('routes a bare invocation exactly as before', () => {
    // The default that already worked, asserted so the new branch cannot have replaced it.
    const dir = project();

    expect(asc([], dir).stdout).toBe(asc(['types', 'brief'], dir).stdout);
  });

  it('routes --csv, and the refusal that comes back is the brief’s own', () => {
    // Routing this one lands on a refusal, and that is the correct answer: `types brief` has no
    // columns to project. Asserted rather than avoided because the alternative -- leaving `--csv`
    // unrouted -- would keep answering "command --csv not found", which says nothing about why,
    // while the routing reaches a message that names both the reason and the command that does it.
    const run = asc(['--csv'], project());

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('asc types list --csv');
  });

  it('leaves --help and --version alone, routing neither', () => {
    // Both are answered by oclif without instantiating a command. Routing them would replace two
    // working screens with whatever `types brief` does with an unknown flag.
    const dir = scratch();

    expect(asc(['--help'], dir).stdout).toContain('USAGE');
    expect(asc(['--version'], dir).status).toBe(0);
  });

  it('leaves a real command line alone', () => {
    // The routing is for output flags ONLY. A caller who named a command must get exactly what they
    // typed, including a command that takes its own `--json`.
    const dir = project();

    expect(asc(['types', 'list', '--json'], dir).status).toBe(0);
    expect(asc(['types', 'list'], dir).stdout).not.toBe(asc(['types', 'brief'], dir).stdout);
  });
});

describe('help does not advertise a flag the command refuses', () => {
  it('drops --csv from `asc types export --help`', () => {
    const run = asc(['types', 'export', '--help'], scratch());

    expect(run.status).toBe(0);
    expect(flatten(run.stdout)).not.toContain('--csv');
    // The other three are still there, so this is one flag removed rather than the section gone.
    expect(flatten(run.stdout)).toContain('--json');
  });

  it('still accepts --csv, and still explains the refusal', () => {
    // The flag is HIDDEN, not dropped. Dropping it would hand the caller oclif's "Nonexistent flag:
    // --csv" in place of the message that says why a nested definition has no tabular projection --
    // a worse answer to the same question.
    const run = asc(['types', 'export', '--csv'], project());

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('asc types list --csv');
    expect(flatten(run.stderr)).not.toContain('Nonexistent flag');
  });

  it('does not hide --csv anywhere else, so the fix is scoped to the command that refuses it', () => {
    // The mutation this guards against is the easy one: hide `--csv` in `base.ts` and every command
    // loses it. `asc types list --csv` is the command the refusal message recommends.
    const run = asc(['types', 'list', '--help'], scratch());

    expect(flatten(run.stdout)).toContain('--csv');
  });
});
