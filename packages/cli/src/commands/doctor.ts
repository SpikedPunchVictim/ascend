/**
 * `asc doctor` -- the registry's health, as one row per finding (asc-12a).
 *
 * Dead types, near-duplicate names, entries spread across definition versions, per-property
 * not_applicable/not_measured counts, the brief's size against its token cap, the export the store
 * cannot see, and whether the installed hook script is still the generation this ascend would write.
 * The checks, and the two that are deliberately absent, are in `doctor.ts`.
 *
 * Read-only, and it exits 0 whatever it finds: every finding is a prompt for the operator, not a
 * failure of the command.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listTypes, profileType, type TypeProfile } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { runDoctor, type HookState } from '../doctor.js';
import {
  hookScript,
  isScriptCurrent,
  isShimCurrent,
  namesAscendHook,
  ownBinaryRelativePath,
  resolveOwnBinary,
  SCRIPT_RELATIVE_PATH,
  SHIM_RELATIVE_PATH,
  shimScript,
} from '../hook-script.js';
import { findProjectRoot } from '../project.js';

export default class Doctor extends BaseCommand {
  static override description =
    'Check the registry for dead types, near-duplicate names, version drift, unmeasured ' +
    'properties, brief size, export and a stale installed hook script.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  /**
   * What the hook check needs, gathered here because `doctor.ts` is pure (asc-mu20).
   *
   * **`scriptCurrent` is not computed by asking whether the file looks old.** It is byte equality
   * against `hookScript`'s own output, through the same `isScriptCurrent` the install command uses,
   * so there is one identity for "current" rather than two. A date would answer a different
   * question: a script touched yesterday can be a generation behind, and one written a year ago can
   * be exactly right.
   *
   * **`undefined` when this ascend cannot resolve its own binary**, which is the one case where the
   * expected bytes cannot be computed at all. The check says "unknown" rather than guessing -- the
   * same shape as the export check declining to claim there is no backup.
   */
  private hookState(root: string): HookState {
    const absolute = join(root, ...SCRIPT_RELATIVE_PATH.split('/'));

    const settingsFile = join(root, '.claude', 'settings.json');
    let settingsText: string | undefined;
    if (existsSync(settingsFile)) {
      try {
        settingsText = readFileSync(settingsFile, 'utf8');
      } catch {
        // Unreadable settings cannot be read as "opted in", for the reason `isScriptCurrent`
        // answers `false` rather than throwing: doctor reports, it does not fail.
        settingsText = undefined;
      }
    }

    const own = resolveOwnBinary();
    const ownRelative = own.kind === 'resolved' ? ownBinaryRelativePath(root, own.path) : undefined;
    const shimAbsolute = join(root, ...SHIM_RELATIVE_PATH.split('/'));
    return {
      scriptPath: SCRIPT_RELATIVE_PATH,
      installed: namesAscendHook(settingsText),
      scriptExists: existsSync(absolute),
      scriptCurrent:
        own.kind === 'resolved' ? isScriptCurrent(absolute, hookScript(ownRelative)) : undefined,
      shimPath: SHIM_RELATIVE_PATH,
      shimCurrent:
        own.kind === 'resolved'
          ? isShimCurrent(shimAbsolute, shimScript(own.path, ownRelative))
          : undefined,
    };
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const format = this.resolveFormat(flags);

    const rows = await this.withProject(({ store }) => {
      const summaries = listTypes(store.db);
      const profiles = summaries
        .map((summary) => profileType(store.db, summary.name))
        .filter((profile): profile is TypeProfile => profile !== undefined);
      // `withProject` has already established there is a store, so there is a root; the fallback
      // satisfies the type rather than covering a case the command can reach.
      const root = findProjectRoot(resolve(process.cwd())) ?? resolve(process.cwd());
      return runDoctor(summaries, profiles, this.hookState(root)).map((finding) => ({
        ...finding,
      }));
    });

    this.emit(format, { columns: ['check', 'status', 'subject', 'detail'], rows });
  }
}
