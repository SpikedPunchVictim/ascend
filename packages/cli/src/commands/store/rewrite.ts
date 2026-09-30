/**
 * `asc store rewrite` -- add `version` to every type line in the tree that states none.
 *
 * **Why this is a command and not part of `asc index build`.** The index is DERIVED and rebuildable,
 * and the tree is the store. A build that quietly rewrote the tree would be a read path that is also
 * a writer -- which is the shape `jsonl-files.ts` refuses on purpose, because a reader which rewrites
 * is a writer, and reading two clones would then be a merge conflict. So the upgrade is its own
 * command, it is named in the error a version-less tree produces, and `buildIndex` never touches a
 * record file.
 *
 * **It prints what it changed, and "nothing" is a real answer.** A second run over an already
 * upgraded tree rewrites no bytes and says so; that is the property whoever runs this needs, because
 * it is what makes running it twice safe.
 *
 * ## The limitation, stated rather than papered over
 *
 * **There is no lock, so this must be run on a quiescent checkout.** Nothing in this command
 * coordinates with a concurrent `asc record` or `asc import` writing the same tree, and one landing
 * mid-rewrite would have its line written to a file this command is about to replace. The failure is
 * not silent -- the line is gone from the tree and the index's fingerprint stops describing it -- but
 * it is avoidable by not doing both at once, which is the same discipline `asc index build` already
 * asks for (`asc-tyl7` tracks the class). Inventing a lock file here would be a second coordination
 * mechanism covering one command; the honest move is to say what is not covered.
 *
 * **The index is left stale, deliberately.** The rewrite changes the tree's fingerprint, so the
 * index no longer describes it and the next read refuses and points at `asc index build`. That is
 * the normal state after any tree write, and the alternative -- rebuilding here -- would make this
 * command depend on the ~75 s rebuild EV-33 measured while doing something that takes milliseconds.
 */

import { join } from 'node:path';
import { rewriteTree, STORE_DIR } from '@ascend/store';
import { BaseCommand } from '../../base.js';

export default class StoreRewrite extends BaseCommand {
  static override description =
    'Add the `version` a type line must now carry to every type line in the tree that states none. ' +
    'Writes only types/ files, only once, and reports what it changed.';

  static override examples = [
    // No flags for the same reason `asc index build` has none: the tree is found by walking up from
    // the working directory (`project.ts`), and there is nothing to choose about the upgrade.
    '<%= config.bin %> <%= command.id %>',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(StoreRewrite);
    const format = this.resolveFormat(flags);

    await this.withProjectRoot((root) => {
      const result = rewriteTree(join(root, STORE_DIR));

      this.emit(format, {
        columns: ['file', 'lines'],
        rows: result.changed.map((change) => ({ file: change.file, lines: change.lines })),
      });

      // Said out loud rather than left to the caller to discover, because the very next command they
      // run will refuse: a tree write changes the fingerprint, so the index stops describing it.
      if (result.versioned > 0) {
        this.warn(
          `${String(result.versioned)} type line(s) now state a version, so index.db no longer ` +
            `describes the tree. Run \`asc index build\` before reading anything.`,
        );
      }
    });
  }
}
