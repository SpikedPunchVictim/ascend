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
 * **The default output is the document list, not the `--json` envelope.** This is the one
 * command whose default is the machine format, because a round-trip is its purpose and
 * `asc types export | asc types import -` has to work without a flag. Wrapping it in
 * `ascend_output` would hand the pipe a shape `import` cannot parse. `--json` is accepted and
 * means the same thing, so a caller who passes it is not surprised; `--csv` is refused, because
 * a nested definition has no tabular projection and emitting a flattened one would be a shape
 * that looks like the export and is not.
 *
 * `--table` (the no-flag default) is not refused -- refusing it would make the bare
 * `asc types export` fail, and the bare form is the one the round-trip needs. The aligned grid
 * is simply not used: this command's default output is its own format, as `brief`'s is.
 */

import { Args } from '@oclif/core';
import { listTypes, typeVersions, type Store } from '@ascend/store';
import { BaseCommand } from '../../base.js';
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

  static override args = {
    name: Args.string({
      description: 'Export this type only. Omit to export every type in the project.',
      required: false,
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
      this.log(serializeDocuments(this.documentsFor(store, args.name)));
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
