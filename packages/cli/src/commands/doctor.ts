/**
 * `asc doctor` -- the registry's health, as one row per finding (asc-12a).
 *
 * Dead types, near-duplicate names, entries spread across definition versions, per-property
 * not_applicable/not_measured counts, the brief's size against its token cap, and the export the
 * store cannot see. The checks, and the two that are deliberately absent, are in `doctor.ts`.
 *
 * Read-only, and it exits 0 whatever it finds: every finding is a prompt for the operator, not a
 * failure of the command.
 */

import { listTypes, profileType, type TypeProfile } from '@ascend/store';
import { BaseCommand } from '../base.js';
import { runDoctor } from '../doctor.js';

export default class Doctor extends BaseCommand {
  static override description =
    'Check the registry for dead types, near-duplicate names, version drift, unmeasured ' +
    'properties, brief size and export.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(Doctor);
    const format = this.resolveFormat(flags);

    const rows = await this.withProject(({ store }) => {
      const summaries = listTypes(store.db);
      const profiles = summaries
        .map((summary) => profileType(store.db, summary.name))
        .filter((profile): profile is TypeProfile => profile !== undefined);
      return runDoctor(summaries, profiles).map((finding) => ({ ...finding }));
    });

    this.emit(format, { columns: ['check', 'status', 'subject', 'detail'], rows });
  }
}
