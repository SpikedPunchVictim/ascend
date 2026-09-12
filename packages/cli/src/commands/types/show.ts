/**
 * `asc types show <name>` -- what one registered version says.
 *
 * **Rows, not a document.** `asc types export` is the command whose output is a type document;
 * this is the command a person reads, so it reports *fields* -- one `field`/`value` row each --
 * and keeps every value a scalar a table can align. The property rows carry the structured
 * property alongside the line rendered for a table (`output.ts`: `columns` is a view of the
 * rows, not a definition of them), so `--json` gets the whole definition and the table gets
 * something readable, from one build of the data rather than two that could disagree.
 *
 * **The rendered line is a display, and it is the lossy one.** `enum required [approved,
 * changes_requested] -- What the review concluded.` is not a format anything should parse; the
 * `type`, `required`, `enum_values`, `unit` and `description` keys on the same row are.
 *
 * **An unknown name is not the same failure as an unknown version.** The first means the caller
 * is in the wrong project or misspelled a name, so the message lists the names that exist; the
 * second means the name is right and the version is not, so the message says where versions
 * start and points at the command that shows them.
 */

import { Args, Flags } from '@oclif/core';
import type { PropertySpec } from '@ascend/core';
import { findType, type TypeVersionRow } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { refusal } from '../../errors.js';
import { knownNames } from '../../register-document.js';

/** One property as a person reads it, for the table. Not a format -- see the file comment. */
function renderProperty(property: PropertySpec): string {
  const parts: string[] = [property.type];
  if (property.required === true) parts.push('required');
  if (property.enum_values !== undefined) parts.push(`[${property.enum_values.join(', ')}]`);
  if (property.unit !== undefined) parts.push(`in ${property.unit}`);
  return property.description === undefined
    ? parts.join(' ')
    : `${parts.join(' ')} -- ${property.description}`;
}

/**
 * The envelope, as rows.
 *
 * `property_count` is stated as well as the property rows, because a count is what makes a
 * truncated listing detectable -- and a table *is* truncated (`output.ts` elides at 60
 * characters, and marks it with `…`).
 */
function scalarRows(row: TypeVersionRow): readonly { field: string; value: unknown }[] {
  const rows: { field: string; value: unknown }[] = [
    { field: 'name', value: row.name },
    { field: 'version', value: row.version },
    { field: 'major', value: row.major },
    { field: 'status', value: row.status },
    { field: 'type_hash', value: row.typeHash },
    { field: 'registered_at', value: row.registeredAt },
    { field: 'property_count', value: row.spec.properties.length },
  ];

  // Omitted when absent, never rendered as an empty string: `TASKS.md` #7 -- a value that does
  // not exist is omitted, and an empty `record_when` would read as "recorded never", which is a
  // different and wrong claim.
  if (row.description !== null) rows.push({ field: 'description', value: row.description });
  if (row.recordWhen !== null) rows.push({ field: 'record_when', value: row.recordWhen });

  return rows;
}

export default class TypesShow extends BaseCommand {
  static override description = 'Show one registered entry type.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review_completed',
    '<%= config.bin %> <%= command.id %> review_completed --version 1 --json',
  ];

  static override args = {
    name: Args.string({
      description: 'The type to show.',
      required: true,
    }),
  };

  static override flags = {
    version: Flags.integer({
      description: 'Show this version instead of the latest one.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesShow);
    const format = this.resolveFormat(flags);
    const version = this.optionalFlag(flags.version);

    await this.withProject(({ store }) => {
      // `findType` omitted-version means "the latest", a decision the store makes once
      // (`registry.ts`) rather than one this command re-derives with its own ORDER BY.
      const row = findType(store.db, args.name, version);

      if (row === undefined) {
        throw refusal(
          version === undefined
            ? `There is no entry type named '${args.name}' in this project. ${knownNames(store)}`
            : `Entry type '${args.name}' has no version ${String(version)}. ` +
                `Versions are numbered from 1 without gaps; ` +
                `run 'asc types show ${args.name}' to see the latest.`,
        );
      }

      this.emit(format, {
        columns: ['field', 'value'],
        rows: [
          ...scalarRows(row),
          ...row.spec.properties.map((property) => {
            // Per-property prose is put back before rendering, and it is a real fix rather than
            // tidiness. `registry.ts`'s `toStorage` strips every prose field into its own column
            // before the spec is hashed and stored, so `row.spec.properties[].description` is
            // ALWAYS undefined -- measured on a real registration: the description round-trips
            // through `asc types export` under `prose`, while `asc types show` printed
            // `json` with no description at all, because the branch below it was unreachable.
            //
            // That mattered enough to fix here rather than note, because a property's
            // description is the only place the shape of a `json` property is written down --
            // `json` validates the container and says nothing about what is inside it, so the
            // guidance a recorder needs lives in the prose this command was silently dropping.
            const prose = row.prose[property.name];
            const described: PropertySpec =
              prose === undefined ? property : { ...property, description: prose };

            return {
              field: `property.${described.name}`,
              value: renderProperty(described),
              // Structured, so `--json` needs no parsing of the line above it. Absent keys stay
              // absent: a `required: false` this command invented would be indistinguishable
              // from one the definition actually stated.
              ...described,
            };
          }),
        ],
      });
    });
  }
}
