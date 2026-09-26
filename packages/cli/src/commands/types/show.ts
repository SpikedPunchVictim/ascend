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
 * **Not finding the type is `type-lookup.ts`'s answer to give**, so this command names a type and
 * gets a row or a refusal rather than spelling out either for itself.
 */

import { Args, Flags } from '@oclif/core';
import { type TypeVersionRow } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { describedProperties, renderProperty } from '../../property-shape.js';
import { requireType } from '../../type-lookup.js';

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

  // Guidance (asc-bli), under the same omit-when-absent rule and in document order. One row per
  // question rather than one joined value: the table elides at 60 characters, so a joined list
  // would lose every question after the first, and `--json` gets each as a plain string.
  const { guidance } = row;
  if (guidance.purpose !== undefined) rows.push({ field: 'purpose', value: guidance.purpose });
  (guidance.analysis_questions ?? []).forEach((question, index) => {
    rows.push({ field: `analysis_questions[${String(index)}]`, value: question });
  });
  if (guidance.interpretation_notes !== undefined) {
    rows.push({ field: 'interpretation_notes', value: guidance.interpretation_notes });
  }
  if (guidance.review_after !== undefined) {
    rows.push({ field: 'review_after', value: guidance.review_after });
  }

  return rows;
}

export default class TypesShow extends BaseCommand {
  static override description = 'Show one registered entry type.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review_completed',
    '<%= config.bin %> <%= command.id %> review_completed --version 1 --json',
  ];

  static override args = {
    // `ignoreStdin`: the arg names a type, and oclif would otherwise take the name from stdin.
    // Measured: `printf 'decision' | asc types show` succeeded (exit 0) on a name nobody typed
    // on the command line. See `record.ts` for the long form.
    name: Args.string({
      description: 'The type to show.',
      required: true,
      ignoreStdin: true,
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
      // An omitted version means "the latest", a decision the store makes once (`registry.ts`)
      // rather than one this command re-derives with its own ORDER BY. The two refusals for not
      // finding a type live in `type-lookup.ts` now that `asc record --scaffold` performs the same
      // lookup and has to answer the same way; the distinction between them is documented there.
      const row = requireType(store, args.name, version);

      // Per-property prose is put back before rendering, and it is a real fix rather than
      // tidiness. `registry.ts`'s `toStorage` strips every prose field into its own column
      // before the spec is hashed and stored, so `row.spec.properties[].description` is
      // ALWAYS undefined on a row read back -- measured on a real registration: the description
      // round-trips through `asc types export` under `prose`, while `asc types show` printed
      // `json` with no description at all, because the branch below it was unreachable.
      //
      // That mattered enough to fix here rather than note, because a property's description is
      // the only place the shape of a `json` property is written down -- `json` validates the
      // container and says nothing about what is inside it, so the guidance a recorder needs
      // lives in the prose this command was silently dropping.
      //
      // The rule itself now lives in `property-shape.ts`, because `asc record --scaffold`
      // renders the same lines and two implementations would agree until one of them moved.
      const described = describedProperties(row.spec.properties, row.prose);

      this.emit(format, {
        columns: ['field', 'value'],
        rows: [
          ...scalarRows(row),
          ...described.map((property) => ({
            field: `property.${property.name}`,
            value: renderProperty(property),
            // Structured, so `--json` needs no parsing of the line above it. Absent keys stay
            // absent: a `required: false` this command invented would be indistinguishable
            // from one the definition actually stated.
            ...property,
          })),
        ],
      });
    });
  }
}
