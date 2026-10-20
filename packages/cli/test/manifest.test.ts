import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Config } from '@oclif/core';
import {
  buildManifest,
  cliRoot,
  manifestlessRoot,
  manifestPath,
} from '../../../scripts/cli-manifest.mjs';

/**
 * The generated manifest keeps `asc --help` off the command modules without changing one byte of
 * what help prints (`asc-cv3m`).
 *
 * The manifest is a CACHE of what oclif would otherwise import 36 command modules to learn. Two
 * things can go wrong with a cache, and they need different checks:
 *
 *   1. **It can be stale.** A command added, renamed or re-flagged without regenerating it would
 *      leave help advertising the old surface. `regenerates the committed manifest` is that check,
 *      and it is a byte comparison so that ordering and formatting drift does not hide inside a
 *      deep-equality comparison of parsed JSON.
 *   2. **It can change the answer.** oclif renders help from cached metadata when a manifest is
 *      present and from live class properties when it is not, so the two paths agreeing is not
 *      something the framework promises -- it is something this test asserts. Every root and
 *      subcommand `--help` is compared byte for byte (stdout, stderr and exit status) against the
 *      same build with no manifest in its plugin root.
 *
 * **The no-manifest arm needs a root with no manifest in it.** `Config.load({ignoreManifest: true})`
 * looks like the tool for the job and is not: oclif 5's `PluginLoader.loadRoot` builds the root
 * plugin as `new Plugin({isRoot: true, pjson, root})` and drops the option, so that arm would read
 * the manifest and the comparison would be the file against itself. `manifestlessRoot` is the same
 * `package.json` with a symlink to the same `dist/`, which makes oclif scan -- the pre-manifest
 * behaviour, measured as 46.254 ms p50 slower on 2026-10-20.
 */

const repoRoot = join(cliRoot, '..', '..');
const corePath = createRequire(import.meta.url).resolve('@oclif/core');

beforeAll(() => {
  // `build` writes the manifest, and `tsc -b` alone does not: the manifest must describe the
  // compiled commands this test is about to compare, not the ones from the last build.
  execFileSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}, 180_000);

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const execFileAsync = promisify(execFile);

/**
 * One child, its three answers. `execFile` rejects on a non-zero exit, so the rejection is where a
 * status other than 0 lives -- and a rejection that is not a number is a real failure (the binary
 * could not be spawned), rethrown rather than reported as a differing screen.
 */
async function run(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== 'number') throw error;
    return { status: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** Where two texts first disagree, as one line -- asserting on 122 KiB of JSON prints a wall. */
function difference(committed: string, generated: string): string {
  if (committed === generated) return 'none';
  const before = committed.split('\n');
  const after = generated.split('\n');
  const at = before.findIndex((line, index) => line !== after[index]);
  return `line ${String(at + 1)}: committed ${JSON.stringify(before[at])} vs generated ${JSON.stringify(after[at])}`;
}

const ids = Object.keys(
  (JSON.parse(readFileSync(manifestPath, 'utf8')) as { commands: Record<string, unknown> })
    .commands,
);

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the manifest is generated from the commands, and oclif reads it', () => {
  it('regenerates the committed manifest byte for byte', async () => {
    const committed = readFileSync(manifestPath, 'utf8');
    const generated = `${JSON.stringify(await buildManifest(), null, 2)}\n`;

    // Named first, because "36 vs 35 commands" is the failure a stale manifest most often is.
    expect(ids.length).toBeGreaterThan(0);
    expect(difference(committed, generated)).toBe('none');
  }, 60_000);

  it('is the file oclif actually loads, and it lists every command on disk', async () => {
    // Without this, a manifest that oclif ignored would make the byte comparison above pass by
    // comparing scanned output to scanned output -- while the help path paid for the scan anyway.
    const config = await Config.load({ root: cliRoot, devPlugins: false });
    const plugin = [...config.plugins.values()].find((candidate) => candidate.isRoot);
    // `manifest` is a property of oclif's `Plugin` CLASS that its `Plugin` interface does not
    // declare, so the public type cannot reach it and this is the one place that has to say so.
    const cached = (
      plugin as unknown as
        { manifest?: { version: string; commands: Record<string, unknown> } } | undefined
    )?.manifest;
    const version = (
      JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;

    expect(plugin?.hasManifest).toBe(true);
    expect(cached?.version).toBe(version);
    expect(Object.keys(cached?.commands ?? {}).sort()).toEqual([...ids].sort());
  }, 60_000);
});

describe('help prints the same bytes with and without the manifest', () => {
  it('renders every root and subcommand help screen identically', async () => {
    const root = manifestlessRoot();
    roots.push(root);
    // The same `execute` the real entry point calls, against a plugin root with no manifest, so
    // oclif has to import every command module the way it did before the manifest existed.
    const launcher = [
      `import { execute } from ${JSON.stringify(corePath)};`,
      `await execute({ dir: ${JSON.stringify(join(root, 'dist/bin.js'))}, args: JSON.parse(process.env.ASC_ARGS) });`,
    ].join('\n');

    const screens: string[][] = [['--help']];
    for (const id of ids) screens.push([...id.split(':'), '--help']);

    /** Both arms of one screen, reported as one line when they disagree. */
    const compare = async (args: readonly string[]): Promise<string | undefined> => {
      const [withManifest, scanned] = await Promise.all([
        run([join(cliRoot, 'dist/bin.js'), ...args]),
        run(['--input-type=module', '-e', launcher], {
          ...process.env,
          ASC_ARGS: JSON.stringify(args),
        }),
      ]);
      if (
        withManifest.status === scanned.status &&
        withManifest.stdout === scanned.stdout &&
        withManifest.stderr === scanned.stderr
      ) {
        return undefined;
      }
      return (
        `"asc ${args.join(' ')}" differed (exit ${String(withManifest.status)}/${String(scanned.status)}, ` +
        `${String(withManifest.stdout.length)}/${String(scanned.stdout.length)} bytes)`
      );
    };

    // Six at a time: 37 screens times two arms is 74 processes, and sequentially that is 23 s of a
    // suite whose whole point is to be affordable (measured 2026-10-20). The pool does not change
    // what is compared, only how long the comparison takes.
    const failures: string[] = [];
    for (let at = 0; at < screens.length; at += 6) {
      const batch = screens.slice(at, at + 6).map(compare);
      failures.push(...(await Promise.all(batch)).filter((one) => one !== undefined));
    }

    expect(failures).toEqual([]);
  }, 180_000);
});
