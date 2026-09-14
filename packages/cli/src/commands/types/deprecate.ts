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
 * not a second code path: the same check runs, and only the statement that writes is skipped.
 */

import { Args, Flags } from '@oclif/core';
import { deprecateType, findType, typeVersions } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal } from '../../errors.js';
import { knownNames } from '../../register-document.js';

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

    await this.withProject(({ store }) => {
      const latest = findType(store.db, args.name);
      if (latest === undefined) {
        throw refusal(
          `There is no entry type named '${args.name}' in this project. ${knownNames(store)}`,
        );
      }

      const alreadyDeprecated = latest.status === 'deprecated';
      // Read before the write, so the count reported for a dry run is the count the real run
      // would produce rather than a number computed a second way.
      const versions = typeVersions(store.db, args.name).length;
      const updated = alreadyDeprecated || dryRun ? 0 : deprecateType(store.db, args.name);

      // One word rather than a pair of booleans. `changed` and `would_change` would each be
      // true in some of the three cases below and false in others, and a caller would have to
      // hold the truth table in their head to know which of the two to read.
      const outcome = alreadyDeprecated
        ? 'already-deprecated'
        : dryRun
          ? 'would-deprecate'
          : 'deprecated';

      if (alreadyDeprecated) {
        this.warn(`'${args.name}' was already deprecated; nothing changed.`);
      } else if (dryRun) {
        this.warn('dry run: nothing was written.');
      }

      this.emit(format, {
        columns: ['name', 'status_before', 'status_after', 'versions', 'outcome'],
        rows: [
          {
            name: args.name,
            status_before: latest.status,
            // `deprecated` in all three cases: what is being reported is the state the type is
            // in or would be left in, and no case leaves it active.
            status_after: 'deprecated',
            // Every version of the name, not just the latest: `status` lives on the version
            // rows, so deprecating a type deprecates the whole family. `versions` is what tells
            // a caller how much that was, and `versions_changed` is 0 for a preview.
            versions,
            versions_changed: updated,
            outcome,
            dry_run: dryRun,
          },
        ],
      });
    });
  }
}
