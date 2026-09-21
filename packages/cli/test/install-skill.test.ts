import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planFile, type FileSpec } from '../src/commands/install-skill.js';
import { flatten } from './helpers.js';

/**
 * `asc install-skill`, driven as the real binary -- mirroring `install-hook.test.ts`, which this
 * suite's structure follows throughout.
 *
 * **Content assertions never feed the command's own output back into itself.** Each expected byte
 * sequence is `readFileSync` on the repository's own `packages/cli/skill/...` source, read here
 * independently of anything `asc install-skill` prints -- the command and the test each open the
 * same file on disk, which is what makes "byte-identical to the source" a real check rather than a
 * tautology.
 *
 * **One case -- a missing source -- is exercised as a unit test of `planFile` rather than through
 * the binary.** The real `packages/cli/skill/` sources exist in this checkout (a parallel change
 * writes their content), and deleting or renaming them here to simulate absence would race that
 * change and could destroy work neither this test nor that one owns. `planFile` is exported by
 * `install-skill.ts` for exactly this reason: a fabricated `FileSpec` pointed at a path under a
 * throwaway temp directory reaches the identical refusal code with no shared state at risk.
 *
 * Nothing here runs against the repository's own `.claude/`. Every fixture is a temp directory.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

/** The real sources this command installs, read independently of the command under test. */
const SKILL_SOURCE = join(root, 'packages/cli/skill/ascend-analysis/SKILL.md');
const COMMAND_SOURCE = join(root, 'packages/cli/skill/commands/ascend-analyze.md');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-skill-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project with a store, which is the precondition for installing anything. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  const init = asc(['init'], dir);
  if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);
  return dir;
}

const skillDest = (dir: string): string =>
  join(dir, '.claude', 'skills', 'ascend-analysis', 'SKILL.md');
const commandDest = (dir: string): string => join(dir, '.claude', 'commands', 'ascend-analyze.md');

describe('asc install-skill: consent', () => {
  it('--dry-run writes nothing and names both destinations, with their sizes', () => {
    const dir = project();
    const run = asc(['install-skill', '--dry-run'], dir);
    expect(run.status).toBe(0);

    // Not even the directory: a preview that created `.claude/` would itself be a change.
    expect(existsSync(join(dir, '.claude'))).toBe(false);

    const stderr = flatten(run.stderr);
    expect(stderr).toContain(skillDest(dir));
    expect(stderr).toContain(commandDest(dir));

    const skillBytes = readFileSync(SKILL_SOURCE).length;
    const commandBytes = readFileSync(COMMAND_SOURCE).length;
    expect(stderr).toContain(`${String(skillBytes)} bytes`);
    expect(stderr).toContain(`${String(commandBytes)} bytes`);
  });

  it('refuses when stdout is not a terminal, naming the flag that would work', () => {
    // `cli-best-practices` rule 3: a command that prompts into a pipe hangs CI rather than
    // failing, so a non-terminal invocation with neither --dry-run nor --yes must exit fast.
    const dir = project();
    const run = asc(['install-skill'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--yes');
    expect(run.stdout).toBe('');
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });
});

describe('asc install-skill: writing', () => {
  it('--yes writes both files, byte-identical to the source', () => {
    const dir = project();
    const run = asc(['install-skill', '--yes'], dir);
    expect(run.status).toBe(0);

    expect(readFileSync(skillDest(dir))).toEqual(readFileSync(SKILL_SOURCE));
    expect(readFileSync(commandDest(dir))).toEqual(readFileSync(COMMAND_SOURCE));
  });

  it('is idempotent: running --yes twice changes nothing the second time', () => {
    const dir = project();
    asc(['install-skill', '--yes'], dir);
    const skillBefore = readFileSync(skillDest(dir));
    const commandBefore = readFileSync(commandDest(dir));

    const again = asc(['install-skill', '--yes', '--json'], dir);
    expect(again.status).toBe(0);

    const envelope = JSON.parse(again.stdout) as { rows: readonly { outcome: string }[] };
    expect(envelope.rows).toHaveLength(2);
    for (const row of envelope.rows) expect(row.outcome).toBe('already installed');

    expect(readFileSync(skillDest(dir))).toEqual(skillBefore);
    expect(readFileSync(commandDest(dir))).toEqual(commandBefore);
  });

  it('leaves no temp file behind', () => {
    const dir = project();
    asc(['install-skill', '--yes'], dir);
    const leftovers = readdirSync(join(dir, '.claude', 'skills', 'ascend-analysis')).filter(
      (name) => name.includes('ascend-tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('asc install-skill: refusing rather than clobbering', () => {
  it('refuses a destination whose bytes differ, without --force, and leaves it untouched', () => {
    const dir = project();
    asc(['install-skill', '--yes'], dir);

    const edited = Buffer.from('# someone edited this\n');
    writeFileSync(skillDest(dir), edited);

    const run = asc(['install-skill', '--yes'], dir);
    expect(run.status).toBe(1);
    const stderr = flatten(run.stderr);
    expect(stderr).toContain(skillDest(dir));
    expect(stderr).toContain('--force');

    // The file the user's edit produced is still exactly that file -- not reverted, not merged.
    expect(readFileSync(skillDest(dir))).toEqual(edited);
    // The sibling file, already correctly installed, is untouched by the refusal too.
    expect(readFileSync(commandDest(dir))).toEqual(readFileSync(COMMAND_SOURCE));
  });

  it('--force replaces a destination whose bytes differ', () => {
    const dir = project();
    asc(['install-skill', '--yes'], dir);

    writeFileSync(skillDest(dir), Buffer.from('# someone edited this\n'));

    const run = asc(['install-skill', '--yes', '--force'], dir);
    expect(run.status).toBe(0);
    expect(readFileSync(skillDest(dir))).toEqual(readFileSync(SKILL_SOURCE));
  });
});

describe('asc install-skill: a missing source', () => {
  it('refuses, naming the path, rather than throwing an unhandled exception', () => {
    const dir = scratch();
    const spec: FileSpec = {
      label: 'skill',
      source: join(dir, 'nowhere', 'SKILL.md'),
      destRel: join('.claude', 'skills', 'ascend-analysis', 'SKILL.md'),
    };

    let thrown: unknown;
    try {
      planFile(spec, dir, false, false);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toContain(spec.source);
    expect(message).toContain('does not exist');
    // Not a raw filesystem error: a `refusal()` is a plain `Error` with no `code` property, while
    // Node's own `ENOENT` carries one -- the distinction this test exists to pin.
    expect((thrown as { code?: unknown }).code).toBeUndefined();
  });
});
