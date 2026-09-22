import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatten } from './helpers.js';

/**
 * `asc install-hook`, driven as the real binary.
 *
 * Two claims carry this command and both are about *not* doing things, which is why they are tested
 * by driving rather than by reading the report:
 *
 *   1. **Installing alongside an existing hook leaves both intact** (`TASKS.md`'s stated test). The
 *      hazard is measured rather than hypothetical -- this repository's own `.claude/settings.json`
 *      carries `bd prime --hook-json` on `SessionStart`, put there by `bd init` -- so a fixture with
 *      the same shape is the minimum, and the assertions are about what survived.
 *   2. **The command it writes actually runs.** A hook that is installed but inert looks exactly
 *      like a hook that works until someone reads their context and finds nothing in it, so the
 *      generated command is extracted from `--json` and executed, and the brief is read back off
 *      stdout. The guards get the same treatment in the other direction: both are driven and
 *      asserted to produce *no output at all*, because "exits 0" is not what inert means -- a guard
 *      that leaked an error to stderr would still exit 0 and still be wrong.
 *
 * Nothing here runs against the repository's own settings file. `.claude/settings.json` is TRACKED,
 * so a test that installed into it would modify a committed file -- every fixture is a temp
 * directory.
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

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-hook-'));
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

/** A repository with a store, which is the precondition for installing anything. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.git'));
  const init = asc(['init'], dir);
  if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);
  return dir;
}

const settingsPath = (dir: string): string => join(dir, '.claude', 'settings.json');

/**
 * The settings file as an object, read back out of the file rather than from the command's report.
 *
 * A command that printed the right thing and wrote the wrong thing would pass a test that only read
 * stdout, which is the reason `types.test.ts` states for reading the store directly.
 */
function settings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Record<string, unknown>;
}

/** Every command on `SessionStart`, in file order. */
function hookCommands(dir: string): readonly string[] {
  const hooks = settings(dir)['hooks'] as Record<string, unknown>;
  const sessionStart = hooks['SessionStart'] as readonly Record<string, unknown>[];
  return sessionStart.flatMap((matcher) => {
    const entries = matcher['hooks'] as readonly Record<string, unknown>[];
    return entries.map((entry) => entry['command'] as string);
  });
}

/** The command the command would write, taken from `--json` rather than reconstructed here. */
function generated(dir: string): string {
  const run = asc(['install-hook', '--dry-run', '--json'], dir);
  const envelope = JSON.parse(run.stdout) as { rows: readonly { command: string }[] };
  return envelope.rows[0]?.command ?? '';
}

/**
 * A settings file holding the beads hook, byte for byte as `bd init` writes it.
 *
 * Measured from this repository's own `.claude/settings.json`. Reproduced rather than simplified:
 * the point of the test is that *this exact shape* survives, and a fixture that dropped the empty
 * `matcher` or reordered the keys would be testing a file nobody has.
 */
function withBeadsHook(dir: string): string {
  const raw = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "bd prime --hook-json",
            "type": "command"
          }
        ],
        "matcher": ""
      }
    ]
  }
}
`;
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath(dir), raw, 'utf8');
  return raw;
}

/**
 * A settings file holding the beads hook AND a pre-asc-4dm.2 ascend hook -- `types brief` alone,
 * no `ingest claude-code` -- so an upgrade can be tested against a fixture that also carries a
 * hook that is NOT ascend's, side by side.
 *
 * The old-style command's paths are deliberately stale (`/old/checkout/...`), the same way a real
 * one goes stale when a checkout moves: the upgrade must replace the whole command, paths
 * included, not merely append the ingest clause to what is already there.
 */
function withOldStyleHook(dir: string): string {
  const raw = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "command": "bd prime --hook-json",
            "type": "command"
          }
        ],
        "matcher": ""
      },
      {
        "hooks": [
          {
            "command": "[ ! -f '/old/checkout/dist/bin.js' ] || [ ! -d '/old/checkout/.ascend' ] || '/old/node' '/old/checkout/dist/bin.js' types brief",
            "type": "command"
          }
        ],
        "matcher": ""
      }
    ]
  }
}
`;
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath(dir), raw, 'utf8');
  return raw;
}

describe('asc install-hook: consent', () => {
  it('refuses when stdout is not a terminal, naming the flag that would work', () => {
    // `cli-best-practices` rule 3. The alternative failure is worse than this one: a command that
    // prompts into a pipe does not fail, it waits, and a CI job that hangs is worse than one that
    // exits 2 saying which flag it wanted.
    const dir = project();
    const run = asc(['install-hook'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--yes');
    expect(run.stdout).toBe('');
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  it('writes nothing on --dry-run, not even the directory', () => {
    const dir = project();
    const run = asc(['install-hook', '--dry-run'], dir);
    expect(run.status).toBe(0);
    // The whole `.claude` tree, not just the file: a directory created by a preview is still a
    // change, and `.claude/` is itself a thing a repository either has or does not.
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  it('refuses when there is no store, and points at the command that creates one', () => {
    const dir = scratch();
    mkdirSync(join(dir, '.git'));
    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('asc init');
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });
});

describe('asc install-hook: appending alongside another tool', () => {
  it('leaves the existing beads hook intact and adds its own beside it', () => {
    const dir = project();
    withBeadsHook(dir);

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(0);

    const commands = hookCommands(dir);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toBe('bd prime --hook-json');
    expect(commands[1]).toContain('types brief');

    // Asserted on the RAW TEXT of the existing entry, not on a parsed field. "Never overwrite" has
    // to mean more than "never delete": the file is re-serialized by `JSON.stringify`, so an entry
    // that came back with its keys reordered or its indentation changed is a diff in a tracked file
    // that nobody asked for. This is the assertion that proves the round trip preserved it.
    //
    // The whole original FILE cannot be asserted as a substring -- appending after the array's last
    // element necessarily rewrites the closing brackets -- which is what an earlier version of this
    // test got wrong.
    expect(readFileSync(settingsPath(dir), 'utf8')).toContain(
      `      {
        "hooks": [
          {
            "command": "bd prime --hook-json",
            "type": "command"
          }
        ],
        "matcher": ""
      }`,
    );
  });

  it('appends a new matcher rather than adding a command to the existing one', () => {
    // Two entries, so the guarantee is visible in the file's structure: whatever was in the array
    // is still in the array. Merging into the existing element would run identically and would make
    // that guarantee harder to check.
    const dir = project();
    withBeadsHook(dir);
    asc(['install-hook', '--yes'], dir);

    const hooks = settings(dir)['hooks'] as Record<string, unknown>;
    expect(hooks['SessionStart']).toHaveLength(2);
  });

  it('creates the file from nothing when there is none', () => {
    const dir = project();
    expect(asc(['install-hook', '--yes'], dir).status).toBe(0);
    expect(hookCommands(dir)).toHaveLength(1);
    expect(hookCommands(dir)[0]).toContain('types brief');
  });

  it('is idempotent: a second run changes not one byte', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const after = readFileSync(settingsPath(dir), 'utf8');

    const again = asc(['install-hook', '--yes', '--json'], dir);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      rows: [{ outcome: 'already installed' }],
    });
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(after);
    expect(hookCommands(dir)).toHaveLength(1);
  });
});

describe('asc install-hook: upgrading a pre-ingest hook in place (D5)', () => {
  it('replaces a types-brief-only command with the chained one, reported "upgraded"', () => {
    const dir = project();
    withOldStyleHook(dir);

    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ outcome: 'upgraded' }] });

    const commands = hookCommands(dir);
    expect(commands).toHaveLength(2);
    // Every other entry in the array, and the order, are unchanged.
    expect(commands[0]).toBe('bd prime --hook-json');
    // The stale command is gone entirely -- replaced, not merely extended.
    // Bound to a local first: `noUncheckedIndexedAccess` types the element as possibly
    // undefined, and a throw here says "the array was not the shape the assertion above just
    // established" rather than silently comparing indexes on `undefined`.
    const upgraded = commands[1];
    if (upgraded === undefined) throw new Error('expected a second SessionStart command');
    expect(upgraded).not.toContain('/old/checkout');
    expect(upgraded).toContain('ingest claude-code');
    expect(upgraded).toContain('types brief');
    expect(upgraded.indexOf('ingest claude-code')).toBeLessThan(upgraded.indexOf('types brief'));

    // The beads entry survives byte for byte, same as the plain-append case.
    expect(readFileSync(settingsPath(dir), 'utf8')).toContain(
      `      {
        "hooks": [
          {
            "command": "bd prime --hook-json",
            "type": "command"
          }
        ],
        "matcher": ""
      }`,
    );
  });

  it('is a no-op the second time, once upgraded', () => {
    const dir = project();
    withOldStyleHook(dir);
    asc(['install-hook', '--yes'], dir);
    const after = readFileSync(settingsPath(dir), 'utf8');

    const again = asc(['install-hook', '--yes', '--json'], dir);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ rows: [{ outcome: 'already installed' }] });
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(after);
  });

  it("never touches a SessionStart command that is not ascend's", () => {
    // A hook with no ascend marker at all -- as distinct from the stale-ascend-marker case above --
    // must never be treated as a candidate for replacement.
    const dir = project();
    withBeadsHook(dir);

    asc(['install-hook', '--yes'], dir);
    expect(hookCommands(dir)[0]).toBe('bd prime --hook-json');

    // Upgrading again (still current) leaves it untouched too.
    asc(['install-hook', '--yes'], dir);
    expect(hookCommands(dir)[0]).toBe('bd prime --hook-json');
  });

  it('--dry-run reports "would upgrade" and writes nothing', () => {
    const dir = project();
    const before = withOldStyleHook(dir);

    const run = asc(['install-hook', '--dry-run', '--json'], dir);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ outcome: 'would upgrade' }] });
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(before);
  });
});

describe('asc install-hook: the command it writes works', () => {
  it('prints the brief when run verbatim, and both guards are silent no-ops', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const command = hookCommands(dir)[0] ?? '';

    // `HOME` is redirected the same way `asc()` redirects it: the command now runs `asc ingest
    // claude-code` for real, and without this it would read the machine's ACTUAL
    // `~/.claude/projects` -- slow, nondeterministic, and exactly the corpus this test must not
    // touch. `dir/.claude` already holds `settings.json`, not a `projects/` sibling, so the
    // resulting `~/.claude/projects` does not exist and ingest sweeps zero files.
    const isolated = { ...process.env, HOME: dir, XDG_CACHE_HOME: join(dir, '.cache') };

    // The positive case. Driven through `sh`, because that is what a hook runner does with it -- a
    // command that works when passed to execFile's argv form and not through a shell would be a
    // command that does not work.
    const live = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(live.status).toBe(0);
    expect(live.stdout).toContain('decision');
    expect(live.stdout).toContain('-- a choice is made');
    // Ingest ran first (D2/D3): its report table and its identity-vocabulary disclosure line
    // would show up here if either of its streams leaked, and `types brief`'s own stdout is the
    // ONLY thing that is supposed to arrive on either stream.
    expect(live.stdout).not.toContain('identity vocabulary');
    expect(live.stderr).toBe('');

    // Guard 1: the binary is gone. Asserted on BOTH streams being empty, because the guard's whole
    // job is to be invisible -- an error on stderr would still exit 0 and still be wrong.
    const missing = spawnSync('sh', ['-c', command.replaceAll('dist/bin.js', 'dist/GONE.js')], {
      cwd: dir,
      encoding: 'utf8',
      env: isolated,
    });
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('');

    // Guard 2: the store is gone. This is the one the architecture's guard did not cover, and the
    // one every teammate hits -- `.ascend/` is gitignored, so a clone has the hook and no store.
    rmSync(join(dir, '.ascend'), { recursive: true, force: true });
    const noStore = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(noStore.status).toBe(0);
    expect(noStore.stdout).toBe('');
    expect(noStore.stderr).toBe('');
  });

  it('runs ingest before types brief, discarding both of its streams', () => {
    // The literal shape D1-D4 require: ingest ordered ahead of the brief, both of its streams
    // thrown away, and the two joined by `;` rather than `&&` so a failing ingest cannot suppress
    // the brief.
    const dir = project();
    const command = generated(dir);
    expect(command).toContain('ingest claude-code >/dev/null 2>&1;');
    expect(command.indexOf('ingest claude-code')).toBeLessThan(command.indexOf('types brief'));
    expect(command.indexOf('>/dev/null 2>&1')).toBeLessThan(command.indexOf('types brief'));
    expect(command).not.toContain('&&');
  });

  it('writes a command whose paths are absolute, so it does not depend on a PATH', () => {
    // `README` is explicit that nothing links `asc` onto a PATH. A hook written as the bare name
    // would be inert in exactly the way that looks like it works.
    const dir = project();
    expect(generated(dir)).toContain(bin);
    expect(generated(dir)).toContain(join(dir, '.ascend'));
  });

  it('quotes paths, so a space in an absolute path does not split the command', () => {
    // macOS home directories routinely contain a space. Unquoted, `[ ! -f /Users/a b/bin.js ]`
    // is a syntax error that a shell reports and a hook runner logs -- every session, silently,
    // as far as the model is concerned.
    const dir = scratch();
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'a dir with spaces'));
    const spaced = join(dir, 'a dir with spaces');
    writeFileSync(join(spaced, '.keep'), '');
    expect(asc(['init'], spaced).status).toBe(0);

    // `realpathSync`, because the temp directory is reached through a symlink on macOS
    // (`/var` -> `/private/var`) and the command correctly names the resolved path.
    const command = generated(spaced);
    expect(command).toContain(`'${realpathSync(spaced)}`);
    // And it parses: `sh -n` reads the command without running it.
    const syntax = spawnSync('sh', ['-n', '-c', command], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
    expect(syntax.stderr).toBe('');
  });
});

describe('asc install-hook: refusing rather than destroying', () => {
  it('refuses invalid JSON and leaves the file byte-identical', () => {
    const dir = project();
    const broken = '{ "hooks": { this is not json }\n';
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), broken, 'utf8');

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('not valid JSON');
    // The file the user wrote is still the file the user wrote. This is the assertion the whole
    // refusal exists for: a merge that destroyed the thing it was merging into would be worse than
    // no command at all.
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(broken);
  });

  it('refuses a SessionStart that is not an array, rather than replacing it', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const wrong = '{\n  "hooks": {\n    "SessionStart": { "command": "mine" }\n  }\n}\n';
    writeFileSync(settingsPath(dir), wrong, 'utf8');

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('SessionStart');
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(wrong);
  });

  it('refuses a hooks key that is not an object', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const wrong = '{\n  "hooks": []\n}\n';
    writeFileSync(settingsPath(dir), wrong, 'utf8');

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('hooks');
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(wrong);
  });

  it('follows a symlinked settings file instead of replacing the link with a file', () => {
    // The defect `symlink.ts` records, measured on `.gitignore`: renaming onto the link's own path
    // replaces the link, so a repository that shares one settings file silently stops sharing it
    // and the target path is not recoverable afterwards.
    const dir = project();
    const shared = join(scratch(), 'shared-settings.json');
    writeFileSync(shared, '{}\n', 'utf8');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    symlinkSync(shared, settingsPath(dir));

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(0);

    expect(lstatSync(settingsPath(dir)).isSymbolicLink()).toBe(true);
    const written = JSON.parse(readFileSync(shared, 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(written)).toContain('types brief');
  });

  it('refuses a settings file that is a symlink to nothing', () => {
    // `existsSync` FOLLOWS a link, so a dangling one answers "no file here" and the create branch
    // would replace it -- the same defect reached through the branch that looks like creation.
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    symlinkSync(join(dir, 'nowhere.json'), settingsPath(dir));

    const run = asc(['install-hook', '--yes'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('symlink');
    expect(lstatSync(settingsPath(dir)).isSymbolicLink()).toBe(true);
  });

  it('leaves no temp file behind', () => {
    // The write is temp-plus-rename. A surviving `.ascend-tmp` would mean the rename never happened
    // -- and, worse, would sit next to a settings file that Claude Code does not read, so the hook
    // would be reported installed and be absent.
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const leftovers = readdirSync(join(dir, '.claude')).filter((name) =>
      name.includes('ascend-tmp'),
    );
    expect(leftovers).toEqual([]);
  });
});

describe('asc install-hook: the report', () => {
  it('carries the command in --json, where a script can read it', () => {
    const dir = project();
    const run = asc(['install-hook', '--dry-run', '--json'], dir);
    const envelope = JSON.parse(run.stdout) as { rows: readonly Record<string, unknown>[] };
    expect(envelope.rows[0]).toMatchObject({
      action: 'hook',
      outcome: 'would install',
      dry_run: true,
    });
    expect(String(envelope.rows[0]?.['command'])).toContain('types brief');
  });

  it('shows the command on stderr during a dry run, since the table does not carry it', () => {
    // A dry run whose whole purpose is "show me what you would write" that answers only
    // "would install" is a preview of nothing.
    const dir = project();
    const run = asc(['install-hook', '--dry-run'], dir);
    expect(flatten(run.stderr)).toContain('types brief');
    // Still on stderr: stdout is the table, and the table is the contract.
    expect(run.stdout).not.toContain('types brief');
  });

  it('reports through the table, with the columns the other commands use', () => {
    const dir = project();
    const run = asc(['install-hook', '--dry-run'], dir);
    expect(run.stdout).toContain('action');
    expect(run.stdout).toContain('target');
    expect(run.stdout).toContain('outcome');
    expect(run.stdout).toContain('hook');
  });
});
