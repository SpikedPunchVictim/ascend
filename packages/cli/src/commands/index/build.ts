/**
 * `asc index build` -- build the derived index (`index.db`) from the JSONL tree, wholesale.
 *
 * **This command exists because a read must not build one** (`asc-i5tj.3.1`). `openIndex` used to
 * rebuild on a fingerprint miss, silently: EV-33 measured 2.97 s at this project's 6,387 entries and
 * **~75 s** at 63,870, with no signal, no progress and no warning, so a caller running a read could not
 * tell "working" from "hung". The settlement is that the build is a command a caller names, and that
 * `openIndex` refuses instead -- the refusal's text (`IndexStaleError`) points here.
 *
 * **It is the only command that may call `buildIndex`, and that is checked, not asked for.**
 * `packages/cli/test/index-build-is-explicit.test.ts` scans every package's `src` and pins the set of
 * modules that can call it, so a read path added later cannot quietly reach a rebuild.
 *
 * **The build is the whole point, so nothing here is incremental.** `buildIndex` replays the tree into
 * a fresh store at `index.db.tmp` and publishes it with one rename, which is what makes a build that
 * dies half-way leave the previous index exactly as it was rather than a fragment wearing a current
 * fingerprint. There is no `--force`: a not-current index is the normal reason to run this.
 *
 * **A file ascend did not create is refused** (`asc-63v`), inside `buildIndex` rather than here,
 * because the rename is what would replace it. The same guard reaches a reader from `openIndex`, so a
 * stranger's `index.db` is refused by both halves of the pair.
 *
 * **Nothing is printed before the build starts, by decision.** The bead's option 2 was a
 * progress line so a slow rebuild is legible; option 1 -- this one -- removes the *unexpected* wait
 * rather than narrating it, and printing a banner as well would leave it ambiguous which settlement
 * was taken. A caller who typed `asc index build` knows what they asked for; what they did not know,
 * before this, was that a read would ask for it on their behalf.
 */

import { join } from 'node:path';
import { buildIndex, INDEX_FILE, STORE_DIR } from '@ascend/store';
import { BaseCommand } from '../../base.js';

export default class IndexBuild extends BaseCommand {
  static override description =
    'Build the derived index (index.db) from the JSONL tree, wholesale. Reads never build one: a ' +
    'read against a stale index refuses and tells you to run this.';

  static override examples = [
    // No flags, and that is the shape rather than an omission: the index is a function of the tree
    // and the tree is where the project is, so both paths are found the same way the store is --
    // by walking up from the working directory (`project.ts`).
    '<%= config.bin %> <%= command.id %>',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(IndexBuild);
    const format = this.resolveFormat(flags);

    // `withProject` resolves THIS project the way every command does -- walking up from the working
    // directory for `.ascend/` -- and the only thing used from it is `root`. Its store handle is
    // opened and closed around the build and never written through; the build reads the JSONL tree
    // and writes `index.db`, neither of which is that handle.
    await this.withProject(({ root }) => {
      const indexFile = join(root, STORE_DIR, INDEX_FILE);
      const built = buildIndex(join(root, STORE_DIR), indexFile, { now: this.now() });

      this.emit(format, {
        columns: ['index', 'records', 'fingerprint'],
        rows: [
          {
            index: indexFile,
            records: built.records,
            // The fingerprint is the thing `openIndex` compares and the only value that ties this
            // report to the state the index is in -- it is not derived from anything the caller can
            // read back later, so a build that wanted to be cited would have to say it here.
            fingerprint: built.fingerprint,
          },
        ],
      });
    });
  }
}
