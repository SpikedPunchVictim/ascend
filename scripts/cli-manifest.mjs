#!/usr/bin/env node
/**
 * Writes `packages/cli/oclif.manifest.json`, so `asc --help` stops importing all 26 command modules
 * (`asc-cv3m`).
 *
 * WHY. `asc --help` measured 215.139 ms p50 (2026-10-20, `spike/help-startup-rungs.mjs 30`), of
 * which 108.442 ms sat above the bare `import('@oclif/core')` floor of 106.697 ms. `asc-baj.1`
 * priced the command-module share of that at 26.652 ms when the CLI had 19 command modules; it has
 * 26 today, so that number is an under-estimate. Without a manifest oclif cannot know what commands
 * exist except by walking `dist/commands` and importing every file -- the root help needs each
 * command's id, summary and description, so it paid for all 26 modules to print a list of their
 * names.
 *
 * With `oclif.manifest.json` in the plugin root, `Plugin._manifest` reads that file instead of
 * scanning (node_modules/@oclif/core/lib/config/plugin.js), and each command entry is a lazy
 * `load` function. Root help renders from the cached metadata and imports none of them.
 *
 * HOW. This is oclif's own `Plugin._manifest` output, not a hand-written file: the plugin is made
 * to scan, and the object it built is serialized. Writing that object by hand would mean
 * re-implementing `cacheCommand` -- flags, args, defaults, prototype merging -- and the manifest is
 * exactly the artifact where a hand-copy drifts from the commands it describes.
 *
 * **The scan happens in a temporary plugin root, and that is not a shortcut.** The obvious
 * mechanism, `Config.load({ignoreManifest: true})`, does not work for the root plugin in oclif 5:
 * `PluginLoader.loadRoot` constructs the plugin as `new Plugin({isRoot: true, pjson, root})` and
 * never forwards `ignoreManifest` (plugin-loader.js), so the option is silently dropped and the
 * generator would read back the very file it is supposed to regenerate -- a check that always
 * passes. Moving the file aside and back would work in this process but would open a window where
 * every other reader of the checkout sees no manifest. A temporary root that carries the same
 * `package.json` and a symlink to the same `dist/` has neither problem: oclif scans real commands,
 * nothing in the checkout moves, and `relativePath` comes out identical because both roots are two
 * levels above `dist/`.
 *
 * DETERMINISTIC ON PURPOSE. Command ids are sorted here, so the file changes only when a command
 * or one of its declarations changes. `manifest.test.ts` regenerates it and compares byte for byte
 * against the committed file, which is the check that a command added without a rebuild cannot
 * ship a help screen that does not list it.
 *
 * Run after `tsc -b` (it reads `dist/`), which is why it is chained into the root `build` script.
 */
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config } from '@oclif/core';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The plugin root oclif derives from `packages/cli/package.json`. */
export const cliRoot = join(repoRoot, 'packages/cli');

/** Where the manifest oclif reads lives: the plugin root, beside `package.json`. */
export const manifestPath = join(cliRoot, 'oclif.manifest.json');

/**
 * A plugin root for this build that has no manifest in it, so loading it forces a scan.
 *
 * The caller removes it. `package.json` is copied rather than symlinked because oclif reads it by
 * path and a symlink would resolve back to the real root, where the manifest is.
 */
export function manifestlessRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'asc-manifestless-'));
  copyFileSync(join(cliRoot, 'package.json'), join(dir, 'package.json'));
  symlinkSync(join(cliRoot, 'dist'), join(dir, 'dist'), 'dir');
  return dir;
}

/**
 * One command's cached metadata: the fields this file reads, not the whole shape oclif writes.
 *
 * @typedef {object} CommandEntry
 * @property {string} id
 * @property {string[]} relativePath
 *
 * @typedef {object} Manifest
 * @property {Record<string, CommandEntry>} commands
 * @property {string} version
 */

/**
 * The manifest oclif would compute for `packages/cli` if no manifest existed.
 *
 * Exported so the test can compare it against the committed file without spawning anything. The
 * sort is here rather than at the call site, because "the same commands" and "the same bytes" have
 * to be one answer for the comparison to mean anything.
 */
export async function buildManifest() {
  const root = manifestlessRoot();
  try {
    const config = await Config.load({ root, devPlugins: false });
    const found = [...config.plugins.values()].find((candidate) => candidate.isRoot);
    // `manifest` is a real property of oclif's `Plugin` class that its `Plugin` INTERFACE does not
    // declare, so the public type cannot reach it. Naming the two fields used here is the smallest
    // honest way to say what this reads; the spread below keeps every field the type does not name.
    const plugin =
      /** @type {{ commandIDs: string[], manifest?: Manifest | undefined } | undefined} */ (
        /** @type {unknown} */ (found)
      );
    if (plugin === undefined) throw new Error(`no root plugin found for ${cliRoot}`);
    if (plugin.manifest === undefined) throw new Error(`no manifest built for ${cliRoot}`);
    const { commands } = plugin.manifest;
    // A command module that fails to import is WARNED about and left out, not fatal -- so a
    // manifest generated while one command was broken would quietly stop advertising it, and the
    // staleness check would compare that file to itself. The glob is the list of commands that
    // exist; every one of them has to be in the manifest or the build is refused.
    const missing = plugin.commandIDs.filter((id) => commands[id] === undefined);
    if (missing.length > 0) {
      throw new Error(`${String(missing.length)} command(s) did not load: ${missing.join(', ')}`);
    }
    // `relativePath` is computed against the plugin root, and the root here is the temporary one.
    // Node resolves the imported module to its REAL path, so the entry records the temp root's
    // climb back to the checkout (`../../../../../../Users/.../dist/commands/x.js`). Rebase it onto
    // the real root: it is the only field the temporary root changes, and it is the one field a
    // consumer turns back into a file path (`loadWithDataFromManifest` does exactly that with it).
    /** @type {Record<string, CommandEntry>} */
    const sorted = {};
    for (const id of Object.keys(commands).sort()) {
      const entry = commands[id];
      const real = resolve(root, entry.relativePath.join(sep));
      sorted[id] = { ...entry, relativePath: relative(cliRoot, real).split(sep) };
    }
    return { commands: sorted, version: plugin.manifest.version };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await buildManifest();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const count = Object.keys(manifest.commands).length;
  console.log(`wrote ${manifestPath} -- ${String(count)} commands, version ${manifest.version}`);
}
