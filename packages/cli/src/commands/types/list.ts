/**
 * `asc types list` -- what is registered in this project.
 *
 * The table shows a narrow slice (name, version, properties, entries, status) because
 * that is what a person scans. The rows underneath carry the whole summary -- the full
 * `type_hash`, the prose -- so `--json` gives a script everything without a second call.
 *
 * `entries` is the column that earns its place: a type with zero entries is registered
 * and unused, which is the "dead rule" signal `asc doctor` reports (`asc-12a`), and it is
 * worth seeing before you have a dozen of them. It counts entries on ANY version, so a
 * type whose only entries predate a major bump does not read as dead.
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
      columns: ['name', 'version', 'properties', 'entries', 'review_after', 'status'],
      rows,
    });
  }
}
