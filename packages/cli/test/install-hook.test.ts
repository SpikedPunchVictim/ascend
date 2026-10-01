import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptNotice } from '../src/commands/install-hook.js';
import { flatten } from './helpers.js';

/**
 * `asc install-hook`, driven as the real binary.
 *
 * Three claims carry this command and all three are about *not* doing things, which is why they
 * are tested by driving rather than by reading the report:
 *
 *   1. **Installing alongside an existing hook leaves both intact** (`TASKS.md`'s stated test). The
 *      hazard is measured rather than hypothetical -- this repository's own `.claude/settings.json`
 *      carries `bd prime --hook-json` on `SessionStart`, put there by `bd init` -- so a fixture with
 *      the same shape is the minimum, and the assertions are about what survived.
 *   2. **The generated script actually runs.** A hook that is installed but inert looks exactly
 *      like a hook that works until someone reads their context and finds nothing in it, so
 *      `.claude/ascend-hook.sh` is executed for real and the brief is read back off stdout. The
 *      guards get the same treatment in the other direction: driven and asserted to produce *no
 *      output at all*, because "exits 0" is not what inert means -- a guard that leaked an error to
 *      stderr would still exit 0 and still be wrong.
 *   3. **Nothing machine-specific ever lands in the tracked settings command, or in the script**
 *      (asc-cjm, dogfood/0009). This is the whole point of the change under test, so it is asserted
 *      directly: neither generated string may contain this checkout's own absolute paths.
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
const scriptPath = (dir: string): string => join(dir, '.claude', 'ascend-hook.sh');

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

/**
 * The script as the generation before `asc-l38f` wrote it: today's text, with the by-hand block
 * removed.
 *
 * Reconstructed rather than pasted in as a literal, so this cannot quietly become a test of a
 * string nobody ships. The block is found by the sentence that introduces it -- not by a line
 * number -- so an edit that moves it cannot produce a "previous" script that is really today's,
 * which would make the staleness test pass while asserting nothing.
 */
function withoutByHandBlock(script: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line.includes('To record an entry by hand'));
  if (start === -1) throw new Error('the generated script has no by-hand block');
  let end = start;
  while (end < lines.length && (lines[end] ?? '').startsWith('#')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
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
 * A settings file holding the beads hook AND a pre-asc-cjm ascend hook -- the generation-2,
 * ingest-chained inline command, no `.claude/ascend-hook.sh` in sight -- so an upgrade can be
 * tested against a fixture that also carries a hook that is NOT ascend's, side by side.
 *
 * The old-style command's paths are deliberately stale (`/old/checkout/...`), the same way a real
 * one goes stale when a checkout moves: the upgrade must replace the whole command with
 * `SETTINGS_COMMAND`, not merely edit what is already there.
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

/** A small executable, standing in for `asc`, written at `path` and made runnable. */
function writeStub(path: string, contents: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
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
    // The whole `.claude` tree, not just a file: a directory created by a preview is still a
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
    expect(commands[1]).toContain('ascend-hook.sh');

    // Asserted on the RAW TEXT of the existing entry, not on a parsed field. "Never overwrite" has
    // to mean more than "never delete": the file is re-serialized by `JSON.stringify`, so an entry
    // that came back with its keys reordered or its indentation changed is a diff in a tracked file
    // that nobody asked for. This is the assertion that proves the round trip preserved it.
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

    // And the script it points at actually exists -- a settings command naming a script that was
    // never written would be inert in exactly the way that looks like it works.
    expect(existsSync(scriptPath(dir))).toBe(true);
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
    expect(hookCommands(dir)[0]).toContain('ascend-hook.sh');
  });

  it('is idempotent: a second run changes not one byte, in either file', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const settingsAfter = readFileSync(settingsPath(dir), 'utf8');
    const scriptAfter = readFileSync(scriptPath(dir), 'utf8');

    const again = asc(['install-hook', '--yes', '--json'], dir);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      rows: [{ outcome: 'already installed' }],
    });
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(settingsAfter);
    expect(readFileSync(scriptPath(dir), 'utf8')).toBe(scriptAfter);
    expect(hookCommands(dir)).toHaveLength(1);
  });
});

describe('asc install-hook: upgrading a pre-script hook in place', () => {
  it('replaces a generation-1/2 command with the script-based one, reported "upgraded"', () => {
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
    expect(upgraded).not.toContain('types brief');
    expect(upgraded).toContain('ascend-hook.sh');
    expect(existsSync(scriptPath(dir))).toBe(true);

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
    const settingsAfter = readFileSync(settingsPath(dir), 'utf8');
    const scriptAfter = readFileSync(scriptPath(dir), 'utf8');

    const again = asc(['install-hook', '--yes', '--json'], dir);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ rows: [{ outcome: 'already installed' }] });
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(settingsAfter);
    expect(readFileSync(scriptPath(dir), 'utf8')).toBe(scriptAfter);
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
    expect(existsSync(scriptPath(dir))).toBe(false);
  });
});

describe('asc install-hook: upgrading a stale script without touching settings.json', () => {
  it('rewrites only the script when the settings command already matches', () => {
    // The settings command is a fixed constant (`SETTINGS_COMMAND`) with no per-project variation,
    // so once a project is on the script generation, the settings TEXT can never again tell a
    // current script from a stale one apart -- that is the whole reason this command has to read
    // the script off disk at all. Simulated here by installing for real, then corrupting the
    // script exactly the way an older ascend version's output would look: present, but different.
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const settingsBefore = readFileSync(settingsPath(dir), 'utf8');
    const commandBefore = hookCommands(dir)[0];

    writeFileSync(scriptPath(dir), '#!/bin/sh\n# a stale version of this script\nexit 0\n', 'utf8');

    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ outcome: 'upgraded' }] });

    // The settings command did not need to change and did not change -- byte for byte.
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(settingsBefore);
    expect(hookCommands(dir)[0]).toBe(commandBefore);

    // The script did change, back to what `install-hook` would write today.
    expect(readFileSync(scriptPath(dir), 'utf8')).not.toContain('a stale version');
    expect(readFileSync(scriptPath(dir), 'utf8')).toContain('ingest claude-code');
  });

  it('--dry-run reports "would upgrade" for a stale script and writes nothing', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const scriptBefore = 'stale-marker\n';
    writeFileSync(scriptPath(dir), scriptBefore, 'utf8');
    const settingsBefore = readFileSync(settingsPath(dir), 'utf8');

    const run = asc(['install-hook', '--dry-run', '--json'], dir);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ outcome: 'would upgrade' }] });
    expect(readFileSync(scriptPath(dir), 'utf8')).toBe(scriptBefore);
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(settingsBefore);
  });
});

/**
 * `asc-l38f`, `dogfood/0028`: the script is the artifact a session reads when it goes looking.
 *
 * **The defect was an asymmetry, not a missing line.** Nothing in the brief named the recording
 * command (`asc record` occurred **0 times in 3,382 bytes**), so a session asked to record had to
 * discover it -- and the one artifact it found, this script, taught
 * `node "$root"/path/to/bin.js record ...`. Measured in `spike/ev16-arms.mjs` arm F: the session
 * that read the script tried that form **four times**, was denied, and stopped. The reason is
 * mechanical and is why the fix is a sentence rather than a working example: a Claude Code allow
 * rule such as `Bash(asc record:*)` matches the **literal text of the command the model emits**
 * (after compound-command splitting), so *"it doesn't match the same program invoked in a different
 * form"*. No artifact can therefore be both runnable and granted -- the path form runs and is not
 * granted, the bare form is granted and (with the binary off `PATH`) resolves nowhere. The script
 * must stop *recommending* the form it needs for itself, and say what to run instead.
 *
 * The comment is the whole change: **no `echo`**, because `install-hook.ts` holds that
 * `types brief`'s stdout is the only thing `SessionStart` ever sees -- a second line of output here
 * would be a second payload, unaudited and outside `BRIEF_CAP_BYTES`.
 */
describe('asc install-hook: the script says what to run by hand (asc-l38f)', () => {
  it('names the recording command, in the same spelling the brief prints', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    // The command spelling, asserted against BOTH artifacts at once. A test that only checked the
    // script could pass while the two drifted apart, which is the defect: the artifact and the
    // digest naming the same program two different ways.
    const command = 'asc record TYPE --json -';
    expect(asc(['types', 'brief'], dir).stdout).toContain(command);
    expect(readFileSync(scriptPath(dir), 'utf8')).toContain(command);
  });

  it('says it by hand, and says the path form below it is not the form to copy', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const content = readFileSync(scriptPath(dir), 'utf8');

    // The line must be a COMMENT. A bare `asc record` in the script body would be a command the
    // hook runs on every session, which would record an entry per session -- the opposite of a
    // sentence telling a reader what to type.
    const telling = content.split('\n').filter((line) => line.includes('asc record'));
    expect(telling.length).toBeGreaterThan(0);
    for (const line of telling) expect(line.startsWith('#')).toBe(true);

    // And the sentence that stops the reader copying `bin="$root"...` above it.
    expect(content).toContain('not a form to copy');
    expect(content).toContain('literal');
  });

  it('reads a script written before that line as stale, so an existing install upgrades', () => {
    // The designed consequence, asserted rather than assumed: every already-installed script
    // differs from this one byte for byte, and `isScriptCurrent` is byte equality -- so an
    // existing install reports `upgraded`, not `already installed`. That is the mechanism working,
    // not a regression, and this is the test that says which it is.
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const current = readFileSync(scriptPath(dir), 'utf8');

    const previous = withoutByHandBlock(current);
    expect(previous).not.toBe(current);
    // The previous generation is otherwise exactly today's script -- so the ONLY thing this can
    // be testing is the block's presence in the currency identity.
    expect(previous).toContain('ingest claude-code');
    writeFileSync(scriptPath(dir), previous, 'utf8');

    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ rows: [{ outcome: 'upgraded' }] });
    expect(readFileSync(scriptPath(dir), 'utf8')).toBe(current);
  });

  it('still prints exactly the brief and nothing else, end to end', () => {
    // The comment must be invisible at run time, and "invisible" means byte-for-byte: the whole
    // payload the hook delivers is compared against what `asc types brief` prints on its own.
    // Asserting only that the brief is *contained* would pass on a script that also leaked the
    // ingest report, an error, or the comment itself.
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    const isolated = {
      ...process.env,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      ASCEND_BIN: bin,
    };
    const command = hookCommands(dir)[0] ?? '';
    const live = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(live.status).toBe(0);
    expect(live.stdout).toBe(asc(['types', 'brief'], dir).stdout);
    expect(live.stderr).toBe('');
  });
});

describe('asc install-hook: nothing machine-specific is ever written', () => {
  it('writes a settings command with no absolute path, naming $CLAUDE_PROJECT_DIR instead', () => {
    // asc-cjm, dogfood/0009: the defect this whole change fixes was 6 absolute-path occurrences
    // across 2 machine-specific roots in the command this replaced. The fixed replacement is
    // asserted against its exact literal shape, not merely "no slash", so a future edit that
    // reintroduced an absolute path in a different spelling would still be caught.
    const dir = project();
    const command = generated(dir);
    expect(command).toBe(
      '[ ! -f "$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh" ] || ' +
        'sh "$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh"',
    );
    // No absolute path at all: every slash in the command belongs to the project-relative
    // `.claude/ascend-hook.sh`, never to a filesystem root.
    expect(command).not.toContain(root);
    expect(command).not.toContain(bin);
    expect(command).not.toMatch(/\/Users\//);
    expect(command).not.toMatch(/^\//);
  });

  it('writes the identical command for two different projects', () => {
    // The old command varied with the checkout (three absolute paths); this one no longer can,
    // because it names nothing but a project-relative script path.
    expect(generated(project())).toBe(generated(project()));
  });

  it("writes a script containing none of this checkout's own absolute paths", () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const content = readFileSync(scriptPath(dir), 'utf8');
    // The binary running these tests lives outside every temp fixture, so its own-checkout branch
    // (`hookScript`'s branch 3) must be omitted entirely rather than emitted with a `..`-prefixed
    // path -- this assertion is what catches either failure mode.
    expect(content).not.toContain(root);
    expect(content).not.toContain(bin);
    expect(content).not.toMatch(/\/Users\//);
    // `..` legitimately appears once, in the `dirname "$0")/..` fallback -- that is shell syntax,
    // not a leaked escaping path. What must never appear is branch 3 itself (`ownBinaryLines`),
    // whose distinctive shape is the adjacent-quote concatenation `"$root"'...'`
    // (`shellQuote`'s single-quoted output glued onto the unquoted `$root`) -- absent here because
    // the binary running these tests lives outside every temp project root.
    expect(content).not.toContain(`"$root"'`);
  });
});

describe('asc install-hook: the script it writes works', () => {
  it('resolves via $ASCEND_BIN, prints the brief, and leaves stderr empty', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    // `HOME` is redirected the same way `asc()` redirects it: the script now runs `asc ingest
    // claude-code` for real, and without this it would read the machine's ACTUAL
    // `~/.claude/projects` -- slow, nondeterministic, and exactly the corpus this test must not
    // touch. `dir/.claude` already holds `settings.json` and the script, not a `projects/`
    // sibling, so the resulting `~/.claude/projects` does not exist and ingest sweeps zero files.
    const isolated = {
      ...process.env,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      ASCEND_BIN: bin,
    };

    // Driven through the settings command itself, via `sh`, because that is what a hook runner
    // does with it -- and it is the command that decides whether `.claude/ascend-hook.sh` is even
    // reached.
    const command = hookCommands(dir)[0] ?? '';
    const live = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(live.status).toBe(0);
    expect(live.stdout).toContain('decision');
    expect(live.stdout).toContain('-- a choice is made');
    // Ingest ran first: its report table and its identity-vocabulary disclosure line would show
    // up here if either of its streams leaked, and `types brief`'s own stdout is the ONLY thing
    // that is supposed to arrive on either stream.
    expect(live.stdout).not.toContain('identity vocabulary');
    expect(live.stderr).toBe('');
  });

  it('runs standalone, invoked by hand with no $CLAUDE_PROJECT_DIR set', () => {
    // The fallback `hookScript` derives from the script's own location -- `<root>/.claude/
    // ascend-hook.sh` -- is what this test exercises: `sh .claude/ascend-hook.sh` must work from
    // a plain checkout, which is the scenario a person reaches for when a hook silently does
    // nothing and they want to see why by hand.
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    // `CLAUDE_PROJECT_DIR` is deliberately absent from this env -- that is the fallback under test.
    const isolated = {
      ...process.env,
      CLAUDE_PROJECT_DIR: undefined,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      ASCEND_BIN: bin,
    };

    const byHand = spawnSync('sh', [scriptPath(dir)], {
      cwd: dir,
      encoding: 'utf8',
      env: isolated,
    });
    expect(byHand.status).toBe(0);
    expect(byHand.stdout).toContain('decision');
    expect(byHand.stderr).toBe('');
  });

  it('acts on the project the script belongs to, not on whatever the working directory is', () => {
    // The store guard tests `$root/.ascend`, but both commands the script runs find their store by
    // walking up from the WORKING DIRECTORY -- so without the `cd`, the guard and the commands it
    // guards are naming two different projects. Measured before the fix: invoked from `/` with a
    // valid `$root`, the guard passed and `types brief` still exited 1 with "No .ascend/ store
    // found in /". That is the harmless half. `ingest` WRITES, so the same mismatch run somewhere
    // that does have a store above it files one project's transcripts into another's database.
    //
    // The stub reports the directory it was run in, because that -- not the exit status -- is the
    // fact under test: the pre-fix script also exited 0 whenever the cwd happened to hold a store.
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    const stub = join(dir, 'stub-asc');
    writeStub(stub, `#!/bin/sh\nif [ "$1" = "types" ]; then echo "cwd=$(pwd -P)"; fi\n`);

    const isolated = {
      ...process.env,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      ASCEND_BIN: stub,
    };
    const command = hookCommands(dir)[0] ?? '';
    const live = spawnSync('sh', ['-c', command], {
      // Deliberately NOT `dir`: every other execution test here runs from the project root, which
      // is exactly why none of them could catch this.
      cwd: scratch(),
      encoding: 'utf8',
      env: isolated,
    });

    expect(live.status).toBe(0);
    expect(live.stderr).toBe('');
    // `pwd -P` in the stub and `realpathSync` here, so both sides name the physical path. A bare
    // `pwd` is LOGICAL -- it echoes back the path it was handed -- so on macOS, where a temp
    // directory is reached through `/var` -> `/private/var`, the two spellings disagree while
    // naming the same directory, and the test would fail over the symlink rather than the cwd.
    expect(live.stdout.trim()).toBe(`cwd=${realpathSync(dir)}`);
  });

  it('resolves via node_modules/.bin/asc when $ASCEND_BIN is not set', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    writeStub(
      join(dir, 'node_modules', '.bin', 'asc'),
      `#!/bin/sh\nif [ "$1" = "types" ]; then echo 'decision -- a choice is made'; fi\n`,
    );

    const isolated = {
      ...process.env,
      ASCEND_BIN: undefined,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
    };
    const command = hookCommands(dir)[0] ?? '';
    const live = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(live.status).toBe(0);
    expect(live.stdout).toContain('decision -- a choice is made');
    expect(live.stderr).toBe('');
  });

  it('guard 1: exits 0 with no output when the store directory is missing', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    rmSync(join(dir, '.ascend'), { recursive: true, force: true });

    const isolated = {
      ...process.env,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      ASCEND_BIN: bin,
    };
    const command = hookCommands(dir)[0] ?? '';
    const run = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('guard 2: exits 0 with no output when no binary resolves', () => {
    const dir = project();
    asc(['install-hook', '--yes'], dir);

    const isolated = {
      ...process.env,
      ASCEND_BIN: undefined,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      // No `asc` on `PATH` (still enough of one for `sh` itself to be found), no `$ASCEND_BIN`, no
      // `node_modules/.bin/asc` in this fixture, and the script's own-checkout branch is absent
      // (asserted in the describe block above) -- every one of the four resolution branches fails.
      PATH: '/bin:/usr/bin',
    };
    const command = hookCommands(dir)[0] ?? '';
    const run = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('a failing, noisy ingest cannot suppress the brief or leak onto either stream', () => {
    // The important guarantee: `;` (in spirit -- two statements, in fact) rather than `&&`, so a
    // broken ingest never takes recall down with it.
    const dir = project();
    asc(['install-hook', '--yes'], dir);
    const stub = join(dir, 'fake-asc.sh');
    writeStub(
      stub,
      [
        '#!/bin/sh',
        'if [ "$1" = "ingest" ]; then',
        '  echo "noisy ingest stdout"',
        '  echo "noisy ingest stderr" 1>&2',
        '  exit 1',
        'fi',
        'if [ "$1" = "types" ]; then',
        "  echo 'decision -- a choice is made'",
        'fi',
        '',
      ].join('\n'),
    );

    const isolated = {
      ...process.env,
      HOME: dir,
      XDG_CACHE_HOME: join(dir, '.cache'),
      CLAUDE_PROJECT_DIR: dir,
      ASCEND_BIN: stub,
    };
    const command = hookCommands(dir)[0] ?? '';
    const run = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', env: isolated });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('decision -- a choice is made\n');
    expect(run.stdout).not.toContain('noisy ingest');
    expect(run.stderr).toBe('');
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
    expect(existsSync(scriptPath(dir))).toBe(false);
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
    expect(JSON.stringify(written)).toContain('ascend-hook.sh');
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
    // The write is temp-plus-rename, for both `settings.json` and the script. A surviving
    // `.ascend-tmp` would mean a rename never happened -- and, worse, would sit next to a file
    // Claude Code does not read, so the hook would be reported installed and be absent.
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
    expect(String(envelope.rows[0]?.['command'])).toContain('ascend-hook.sh');
  });

  it('shows the command and the pending script write on stderr during a dry run', () => {
    // A dry run whose whole purpose is "show me what you would write" that answers only
    // "would install" is a preview of nothing.
    const dir = project();
    const run = asc(['install-hook', '--dry-run'], dir);
    expect(flatten(run.stderr)).toContain('ascend-hook.sh');
    // Still on stderr: stdout is the table, and the table is the contract.
    expect(run.stdout).not.toContain('ascend-hook.sh');
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

describe('asc install-hook: lifecycle stages for say: handlers (asc-tuur.4)', () => {
  const NUDGE = [
    'on: tool.use.start',
    'where:',
    '  tool: Skill',
    '  skill: {in: [bug-hunt]}',
    "say: 'Report each finding with ReportFindings.'",
    '',
  ].join('\n');

  function withHandler(dir: string, name: string, text: string): void {
    mkdirSync(join(dir, 'handlers'), { recursive: true });
    writeFileSync(join(dir, 'handlers', name), text);
  }

  /** The groups under one event, as written. */
  const groups = (dir: string, event: string): readonly Record<string, unknown>[] =>
    ((settings(dir)['hooks'] as Record<string, unknown>)[event] ?? []) as readonly Record<
      string,
      unknown
    >[];

  const rowsOf = (run: Run) =>
    (JSON.parse(run.stdout) as { rows: { action: string; outcome: string; command: string }[] })
      .rows;

  it('installs nothing beyond SessionStart when no handler says anything', () => {
    const dir = project();
    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(rowsOf(run)).toHaveLength(1);
    expect(groups(dir, 'PostToolUse')).toEqual([]);
  });

  it('installs a PostToolUse hook matched to the tools the handler names', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(rowsOf(run)[1]).toMatchObject({ action: 'PostToolUse', outcome: 'installed' });
    expect(groups(dir, 'PostToolUse')).toEqual([
      {
        matcher: 'Skill',
        hooks: [
          {
            type: 'command',
            command:
              '[ ! -f "$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh" ] || ' +
              'sh "$CLAUDE_PROJECT_DIR/.claude/ascend-hook.sh" post-tool-use',
          },
        ],
      },
    ]);
  });

  it('matches every tool when a handler does not narrow where.tool to literals', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    withHandler(dir, 'any.yaml', "on: file.changed\nsay: 'changed ${path}'\n");
    asc(['install-hook', '--yes'], dir);
    expect(groups(dir, 'PostToolUse')[0]?.['matcher']).toBe('');
  });

  it('is idempotent with a stage installed', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    asc(['install-hook', '--yes'], dir);
    const before = readFileSync(settingsPath(dir), 'utf8');
    const again = asc(['install-hook', '--yes', '--json'], dir);
    expect(rowsOf(again).map((row) => row.outcome)).toEqual([
      'already installed',
      'already installed',
    ]);
    expect(readFileSync(settingsPath(dir), 'utf8')).toBe(before);
  });

  it('upgrades the matcher in place when the handlers name another tool', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    asc(['install-hook', '--yes'], dir);
    withHandler(dir, 'nudge.yaml', NUDGE.replace('tool: Skill', 'tool: {in: [Skill, Write]}'));
    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(rowsOf(run)[1]?.outcome).toBe('upgraded');
    expect(groups(dir, 'PostToolUse').map((group) => group['matcher'])).toEqual(['Skill|Write']);
  });

  it("removes its own stage hook when no handler uses the stage, and never another tool's", () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-on-bash' }] };
    writeFileSync(settingsPath(dir), JSON.stringify({ hooks: { PostToolUse: [other] } }));
    withHandler(dir, 'nudge.yaml', NUDGE);
    asc(['install-hook', '--yes'], dir);
    expect(groups(dir, 'PostToolUse')).toHaveLength(2);

    rmSync(join(dir, 'handlers', 'nudge.yaml'));
    const run = asc(['install-hook', '--yes', '--json'], dir);
    expect(rowsOf(run)[1]).toMatchObject({ action: 'PostToolUse', outcome: 'removed' });
    expect(groups(dir, 'PostToolUse')).toEqual([other]);
  });

  it('--dry-run reports "would install" for a stage and writes nothing', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    const run = asc(['install-hook', '--dry-run', '--json'], dir);
    expect(rowsOf(run)[1]?.outcome).toBe('would install');
    expect(run.stderr.replace(/\s+/g, ' ')).toMatch(
      /would install a PostToolUse hook .* Skill call/,
    );
    expect(existsSync(settingsPath(dir))).toBe(false);
  });

  it('writes a script that hands a stage call to asc hook, with the input on stdin', () => {
    const dir = project();
    withHandler(dir, 'nudge.yaml', NUDGE);
    asc(['install-hook', '--yes'], dir);
    const command = (groups(dir, 'PostToolUse')[0]?.['hooks'] as { command: string }[])[0]?.command;
    const input = {
      session_id: 's-1',
      cwd: dir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'bug-hunt' },
      tool_response: { success: true },
      tool_use_id: 'toolu_1',
    };
    const live = spawnSync('sh', ['-c', command ?? ''], {
      cwd: dir,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, CLAUDE_PROJECT_DIR: dir, ASCEND_BIN: bin },
    });
    expect(live.status).toBe(0);
    expect(JSON.parse(live.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Report each finding with ReportFindings.',
      },
    });
    expect(live.stderr).toBe('');
  });
});

describe('asc install-hook: the consent line about the script', () => {
  it('says the script does not exist yet only when it is being created', () => {
    expect(scriptNotice('s.sh', 'settings.json', false)).toMatch(
      /create s\.sh, which does not exist yet/,
    );
    expect(scriptNotice('s.sh', 'settings.json', true)).not.toMatch(/does not exist/);
  });
});
