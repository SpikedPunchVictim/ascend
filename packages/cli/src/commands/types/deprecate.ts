/**
 * `asc types deprecate <name>` -- retire a type without rewriting it.
 *
 * Deprecation is a status change on the versions that already exist, not a new version and not
 * a delete. Entries recorded under the type stay valid and stay queryable; what changes is that
 * the type stops appearing in `asc types brief`, so a recorder is no longer pointed at it.
 *
 * **The store returns `0` for two different things, and this command must not.** `deprecateType`
 * reports how many rows it changed, which is zero both when the name is unknown and when the
 * type was already deprecated. Those need opposite answers -- the first is a refusal that lists
 * the names that exist, the second is success with nothing to do -- and a command that
 * printed "0 changed, exit 0" for both would tell a caller their typo worked. So the status is
 * read first, and the two cases are separated before the write is attempted.
 *
 * **`--dry-run` reports the change without making it**, per `cli-best-practices` rule 7. It is
 * not a second code path: the same body runs, on `previewProducedLines` instead of
 * `writeProducedLines`, so what a dry run prints is what the real run does rather than a second
 * computation of it -- and the real statement runs and is rolled back, rather than being skipped.
 *
 * **A retirement is a LINE, and this command is where that was not true (2026-09-29).** The tree is
 * the store, so a status set only in the index is a status that nothing carries: measured before this
 * rewrite, `asc types deprecate review_completed` succeeded and `asc index build` -- the operation
 * whose job is to reproduce the store -- gave the type back `active`. The command called
 * `deprecateType` on the read-only handle it had (which is now refused outright:
 * `attempt to write a readonly database`), and the rebuild had no line to read it from. So the
 * write goes through `produce.deprecate`, which is the same `deprecateType` call `replayType` makes
 * on the way back in, and the line it appends is the repeat that `document.ts`'s `status` field
 * describes.
 *
 * The two reads that decide the outcome -- the status that separates the two zeros, and the version
 * count a caller is told -- happen INSIDE the write body, on the transaction's own handle. They have
 * to: the handle a command holds on the way in is read-only after the flip, and a check-then-act
 * read made there would be made against a store the lock has not taken (asc-q4p).
 */

import { Args, Flags } from '@oclif/core';
import { findType, previewProducedLines, typeVersions, writeProducedLines } from '@ascend/store';
import type { Producers, SqlDatabase } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal } from '../../errors.js';
import { storePaths } from '../../project.js';
import { knownNames } from '../../register-document.js';

/** What the body decided, read out of the transaction and reported after it commits. */
interface Decision {
  readonly name: string;
  readonly before: 'active' | 'deprecated';
  /** Every version of the name: `status` lives on the version rows, so a retirement covers them all. */
  readonly versions: number;
  readonly alreadyDeprecated: boolean;
  readonly changed: number;
}

export default class TypesDeprecate extends BaseCommand {
  static override description = 'Retire an entry type, keeping the entries already recorded.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review_completed',
    '<%= config.bin %> <%= command.id %> --dry-run review_completed',
  ];

  static override args = {
    // `ignoreStdin`: same class as `show`. Measured: `printf 'decision' | asc types deprecate`
    // ran against a type named only on stdin. Deprecating is a WRITE, which makes guessing the
    // operand here worse than guessing it on a read.
    name: Args.string({
      description: 'The type to deprecate.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    'dry-run': Flags.boolean({
      description: 'Report what would change, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesDeprecate);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);

    await this.withProjectRoot((root) => {
      const { tree, index } = storePaths(root);
      const body = (produce: Producers, db: SqlDatabase): Decision => {
        const latest = findType(db, args.name);
        if (latest === undefined) {
          throw refusal(
            `There is no entry type named '${args.name}' in this project. ${knownNames(db)}`,
          );
        }

        const alreadyDeprecated = latest.status === 'deprecated';
        // Read before the write, so the count reported for a dry run is the count the real run
        // would produce rather than a number computed a second way.
        const versions = typeVersions(db, latest.name).length;
        // Not produced at all when there is nothing to do, so a re-run appends no second line to a
        // `merge=union` file. `produce.deprecate` would answer `changed: 0` and emit nothing anyway;
        // asking it here would be a write that the store's own idempotence has to catch.
        const retired = alreadyDeprecated ? { changed: 0 } : produce.deprecate(latest.name);

        return {
          name: latest.name,
          before: latest.status,
          versions,
          alreadyDeprecated,
          changed: retired.changed,
        };
      };

      const decision = dryRun
        ? previewProducedLines(tree, index, body)
        : writeProducedLines(tree, index, { now: this.now() }, body).result;

      // One word rather than a pair of booleans. `changed` and `would_change` would each be
      // true in some of the three cases below and false in others, and a caller would have to
      // hold the truth table in their head to know which of the two to read.
      const outcome = decision.alreadyDeprecated
        ? 'already-deprecated'
        : dryRun
          ? 'would-deprecate'
          : 'deprecated';

      if (decision.alreadyDeprecated) {
        this.warn(`'${decision.name}' was already deprecated; nothing changed.`);
      } else if (dryRun) {
        this.warn('dry run: nothing was written.');
      }

      this.emit(format, {
        columns: ['name', 'status_before', 'status_after', 'versions', 'outcome'],
        rows: [
          {
            name: decision.name,
            status_before: decision.before,
            // `deprecated` in all three cases: what is being reported is the state the type is
            // in or would be left in, and no case leaves it active.
            status_after: 'deprecated',
            // Every version of the name, not just the latest: `status` lives on the version
            // rows, so deprecating a type deprecates the whole family. `versions` is what tells
            // a caller how much that was, and `versions_changed` is 0 for a preview.
            versions: decision.versions,
            versions_changed: decision.changed,
            outcome,
            dry_run: dryRun,
          },
        ],
      });
    });
  }
}
