/**
 * `asc types list` -- what is registered in this project.
 *
 * The table shows a narrow slice (name, version, properties, entries, struck, status) because
 * that is what a person scans. The rows underneath carry the whole summary -- the full
 * `type_hash`, the prose -- so `--json` gives a script everything without a second call.
 *
 * `entries` is the column that earns its place: a type with zero entries is registered
 * and unused, which is the "dead rule" signal `asc doctor` reports (`asc-12a`), and it is
 * worth seeing before you have a dozen of them. It counts entries on ANY version, so a
 * type whose only entries predate a major bump does not read as dead.
 *
 * **`entries` is the LIVE count and `struck` sits beside it** (`asc-9xi0`). This is where you go
 * for what still stands; `asc explore <type>` profiles everything recorded, struck rows included,
 * and `asc explore <type> --struck` narrows to them. Nothing is hidden: the two columns add up to
 * the total, so a reader who expected a bigger `entries` can see where the rest went.
 *
 * `struck` is a COLUMN on every row and an empty cell when nothing is struck -- the shape
 * `review_after` already has, and for the reason `TASKS.md` #7 gives there: a set of columns that
 * varies with the data is a set a script has to discover. The cost is one empty column on a table
 * with no strikes, which is cheaper than a header that changes under a consumer.
 */

import { listTypes } from '@ascend/store';
import { BaseCommand } from '../../base.js';

export default class TypesList extends BaseCommand {
  static override description = 'List the entry types registered in this project.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(TypesList);
    const format = this.resolveFormat(flags);

    const rows = await this.withProject(({ store }) =>
      listTypes(store.db).map((type) => ({
        name: type.name,
        version: type.latestVersion,
        properties: type.propertyCount,
        entries: type.entryCount,
        // Beside `entries`, which is what it is read against. Present on every row and empty when
        // zero: a varying column set is one a script has to discover -- see the module comment.
        struck: type.struckCount === 0 ? null : type.struckCount,
        // Beside `entries`, which is what it is read against. Omitted when undeclared (TASKS.md #7).
        ...(type.reviewAfter === null ? {} : { review_after: type.reviewAfter }),
        status: type.status,
        major: type.major,
        versions: type.versionCount,
        type_hash: type.typeHash,
        description: type.description,
        record_when: type.recordWhen,
      })),
    );

    this.emit(format, {
      columns: ['name', 'version', 'properties', 'entries', 'struck', 'review_after', 'status'],
      rows,
    });
  }
}
