/**
 * `asc types brief` -- the digest a model is handed before it records anything.
 *
 * This is the command `asc-9y1` measures on a token budget, so its default output is the
 * smallest true thing: one line per active type, `name -- record_when`, and nothing else. No
 * header, no rule, no counts. The types are what the reader needs; the rest is tokens.
 *
 * **Deprecated types are absent, and that is the point of asking for a brief.** A deprecated
 * type still holds entries and is still queryable (`asc types list` and `asc types show` report
 * it), but telling a recorder about one would invite new entries under a definition the project
 * has retired.
 *
 * **`--csv` is refused rather than rendered.** A digest has no columns to project: the two
 * columns it would have are the two fields of a sentence, and every row would repeat the
 * separator. Refusing says so; emitting a degenerate two-column CSV would be a shape a script
 * could parse and nothing else.
 *
 * **`--table` is accepted as the default's name.** The line format *is* this command's table --
 * it is not `output.ts`'s aligned grid, and `--json` is where the rows become a contract.
 */

import { listTypes, type TypeSummary } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { usageError } from '../../errors.js';

/** The line a model reads. Recorded-never is stated, not left blank -- blank reads as "unknown". */
function line(summary: TypeSummary): string {
  return summary.recordWhen === null
    ? `${summary.name} -- no record_when given`
    : `${summary.name} -- ${summary.recordWhen}`;
}

export default class TypesBrief extends BaseCommand {
  static override description = 'List the active entry types, with when to record each one.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  public async run(): Promise<void> {
    const { flags } = await this.parse(TypesBrief);
    const format = this.resolveFormat(flags);

    if (format === 'csv') {
      throw usageError(
        '`asc types brief --csv` is not a format: a brief is one sentence per type, so a CSV ' +
          'of it would repeat the separator in every row. Use `--json` for a machine-readable ' +
          'brief, or `asc types list --csv` for the registry as columns.',
      );
    }

    await this.withProject(({ store }) => {
      const summaries = listTypes(store.db).filter((summary) => summary.status === 'active');

      if (format === 'json') {
        this.emit(format, {
          columns: ['name', 'record_when'],
          rows: summaries.map((summary) => ({
            name: summary.name,
            // Omitted, not `""`: `TASKS.md` #7. A consumer must be able to tell "this type
            // does not say when to record" from "this type says to record it on an empty
            // occasion".
            ...(summary.recordWhen === null ? {} : { record_when: summary.recordWhen }),
            version: summary.latestVersion,
            major: summary.major,
            property_count: summary.propertyCount,
            type_hash: summary.typeHash,
          })),
        });
        return;
      }

      // One write rather than one per line, so a brief read through a pipe arrives whole.
      if (summaries.length > 0) this.log(summaries.map(line).join('\n'));
    });
  }
}
