/**
 * `asc types export [name]` -- the registry as type documents, for moving between projects.
 *
 * **Every version, oldest first, and that order is load-bearing.** `import` registers in the
 * order it reads, and registration mints the next version number, so replaying v1 then v2
 * reproduces exactly the versions and majors the exporting project holds. Emitting only the
 * latest would produce a project whose history is one version deep -- the same *current*
 * definition, and a different corpus: an entry recorded under v1 would have no definition to
 * attach to, which is a large part of why `type_hash` exists.
 *
 * **The default output is the document list, and `--json` is the versioned envelope.** This is
 * the one command whose default is the machine format, because a round-trip is its purpose and
 * `asc types export | asc types import -` has to work without a flag. Wrapping the DEFAULT in
 * `ascend_output` would hand the pipe a shape `import` cannot parse.
 *
 * `--json` used to ignore the format and emit that same document list, on the reasoning that a
 * caller passing it would not be surprised. That was wrong, and `asc-qmn` measured why:
 * `--json` is described at `base.ts` as "a versioned JSON envelope on stdout. The stable contract
 * for scripts", and `asc types export --json` was byte-identical to the bare form
 * (`61b313eca9b75758b1dc6ba1b15d5219c07ec8ce` both ways) -- a bare array with no `ascend_output`,
 * so a consumer asking for the versioned contract could not tell it from a future format change.
 * Every other command's `--json` is the envelope. This one now is too.
 *
 * This is `brief`'s rule applied to the command that had not applied it: "the line format *is*
 * this command's table -- it is not `output.ts`'s aligned grid, and `--json` is where the rows
 * become a contract." So each spelling now means something distinct -- no flag is the document
 * to move between projects, `--json` is the versioned contract for a script -- rather than
 * `--json` being a synonym for nothing.
 *
 * **The cost, stated: `asc types export --json | asc types import -` no longer round-trips.**
 * It did before, incidentally, because `--json` emitted the document; `import` now receives an
 * envelope and refuses it. The documented pipeline takes no flag (`--help` offers
 * `asc types export | asc types import -`, and `import`'s own example is the same), and no test
 * or doc in this repo used the `--json` spelling, which was checked before changing it. `import`
 * is deliberately NOT taught to unwrap an envelope: that would give one pipeline two spellings
 * whose only difference is a wrapper, which is the ambiguity this change exists to remove.
 *
 * `--csv` is refused, because a nested definition has no tabular projection and emitting a
 * flattened one would be a shape that looks like the export and is not. `--table` is not
 * refused -- refusing it would make the bare `asc types export` fail, and the bare form is the
 * one the round-trip needs. The aligned grid is simply not used: this command's default output
 * is its own format, as `brief`'s is.
 */

import { Args, Flags } from '@oclif/core';
import { listTypes, typeVersions, type Store } from '@ascend/store';
import { BaseCommand, OUTPUT_FLAGS } from '../../base.js';
import { documentFromRow, serializeDocuments, type TypeDocument } from '../../document.js';
import { refusal, usageError } from '../../errors.js';
import { knownNames } from '../../register-document.js';

export default class TypesExport extends BaseCommand {
  static override description = 'Write type definitions as JSON documents.';

  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> review_completed > review.json',
    '<%= config.bin %> <%= command.id %> | <%= config.bin %> types import -',
  ];

  /**
   * `--csv` is accepted and refused, but no longer advertised.
   *
   * Measured: `asc types export --help` listed `--csv  Print RFC 4180 CSV.` while `asc types export
   * --csv` exited 2 refusing it. The flag is inherited from `base.ts`'s `OUTPUT_FLAGS`, and its
   * help line was inherited with it -- so the one screen a caller reads before trying the flag was
   * the screen that said the flag works. `asc-3u2` item (d).
   *
   * **The flag is kept rather than dropped.** Dropping it would make oclif answer with its own
   * "Nonexistent flag: --csv", replacing the refusal below -- which explains WHY a nested
   * definition has no tabular projection and names the command that does -- with a parser message
   * that explains nothing. `hidden: true` removes the line from help and changes no behaviour:
   * `--csv` still parses, still reaches `resolveFormat`, and still gets that refusal.
   *
   * **`--csv-raw` is hidden alongside it, for the same reason `asc-7mv` gave it its own flag: it
   * has no meaning except as a modifier of `--csv`.** A caller reading this command's `--help`
   * must not be offered a flag that only qualifies a format this command refuses -- `asc types
   * export --csv --csv-raw` fails on the same refusal below either way, so advertising `--csv-raw`
   * here would be a promise the command cannot keep. It is still accepted (as a harmless no-op,
   * exactly like passing it to any command that ends up rendering `table` or `json`), just not
   * advertised. Measured: hiding `csv` alone left `--csv-raw` in `--help`, and `--csv-raw` contains
   * `--csv` as a substring, which is what made the help-text assertion below fail before this flag
   * existed at all.
   *
   * This is the only command that overrides `baseFlags`, and it overrides only the presentation of
   * two flags. `base.ts` puts the output flags in one place so that format RESOLUTION cannot vary
   * between commands -- and it still cannot: this command resolves through `resolveFormat` like
   * every other, and the set of formats it accepts is unchanged.
   */
  static override baseFlags = {
    ...OUTPUT_FLAGS,
    csv: Flags.boolean({ description: 'Print RFC 4180 CSV.', hidden: true }),
    'csv-raw': Flags.boolean({ ...OUTPUT_FLAGS['csv-raw'], hidden: true }),
  };

  static override args = {
    // `ignoreStdin`, and this is the arg where the omission was worst. It is `required: false`,
    // so oclif filling it from stdin does not produce an error -- it produces a DIFFERENT ANSWER.
    // Measured in a project with 7 exported type entries: `asc types export` emitted all 7, while
    // `printf 'decision' | asc types export` emitted 2, exit 0 both times, with nothing on stderr
    // to say a pipe had narrowed the result. Every other arg in this class at least failed loudly.
    name: Args.string({
      description: 'Export this type only. Omit to export every type in the project.',
      required: false,
      ignoreStdin: true,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesExport);
    const format = this.resolveFormat(flags);

    if (format === 'csv') {
      // A usage error, not a refusal: `--csv` on this command cannot apply to anything, so the
      // fix is a different command line rather than a different name (`errors.ts`).
      throw usageError(
        '`asc types export --csv` is not a format: a type definition is a nested object, and a ' +
          'CSV cell holding one is a cell a reader has to parse back anyway. The export is ' +
          "JSON; use 'asc types list --csv' if what you want is the registry as columns.",
      );
    }

    await this.withProject(({ store }) => {
      // An empty registry writes `[]`, not nothing (asc-bcv.13, B10). The early return here was
      // reasoned from `output.ts`, where an empty *rendering* is silent because stdout carries data
      // rather than punctuation -- and that reasoning is right for a table and wrong for this
      // command, whose output is a document another command PARSES. Zero bytes is not JSON:
      // `asc types export | asc types import -`, the pipeline this command's own `--help` offers,
      // failed every time on a registry with no types, reporting at restore time rather than at
      // backup time. `[]` is the same answer the registry gives and the one `import` accepts.
      //
      // The caller-contract cost is one line in a consumer that treated 0 bytes as "no types";
      // `import` is the consumer, and it already accepts `[]` (`printf '[]' | asc types import -`
      // exits 0, measured). `asc types brief` keeps its silent empty rendering and is untouched:
      // nothing pipes it into anything.
      const documents = this.documentsFor(store, args.name);

      if (format === 'json') {
        // `row_count` is why this envelope is worth having beyond the version field: it is what
        // distinguishes an empty registry (0 rows) from a truncated answer, in the spelling a
        // script reads. The document list carries no such count.
        //
        // `columns` is required by `Output` and unused here -- `renderJson` builds the envelope
        // from `rows` alone, and no renderer turns these documents into a grid. The names are the
        // document's own top-level fields, listed so a reader of this line is not misled into
        // thinking a table exists.
        this.emit(format, {
          columns: ['name', 'properties', 'description', 'record_when', 'prose', 'type_hash'],
          // `{ ...document }` rather than `document`, and the copy is the point: `TypeDocument` is
          // an interface and has no index signature, so it is not assignable to `Row`
          // (`Readonly<Record<string, unknown>>`). A fresh literal IS contextually typed to `Row`,
          // which is why the sibling commands' inline row objects need no cast. The copy is
          // shallow and changes nothing about the value or its field order.
          rows: documents.map((document) => ({ ...document })),
        });
        return;
      }

      this.log(serializeDocuments(documents));
    });
  }

  /**
   * The documents to write, in registration order.
   *
   * Every type, each with every version, types in name order -- so two exports of the same
   * registry differ only where the registry does, and a diff of them means something.
   */
  private documentsFor(store: Store, name: string | undefined): readonly TypeDocument[] {
    if (name === undefined) {
      return listTypes(store.db)
        .map((summary) => summary.name)
        .sort()
        .flatMap((typeName) => typeVersions(store.db, typeName).map(documentFromRow));
    }

    const versions = typeVersions(store.db, name);
    if (versions.length === 0) {
      throw refusal(`There is no entry type named '${name}' in this project. ${knownNames(store)}`);
    }
    // Already oldest-first: `typeVersions` orders by version ascending, which is the order
    // `import` must register them in to reproduce these version numbers.
    return versions.map(documentFromRow);
  }
}
