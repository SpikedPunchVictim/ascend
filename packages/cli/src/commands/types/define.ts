/**
 * `asc types define <file|->` -- register a type definition.
 *
 * Registration is immutable and versioned: a changed shape becomes a new version with a new
 * `type_hash`, never an edit. So the useful thing this command reports is not "ok" but *what
 * it decided* -- the version it landed on, the bump that produced it, and whether the shape
 * was already known.
 *
 * **Two refusals worth their lines, both before the store is opened.** A document whose
 * `type_hash` disagrees with its own contents is refused (`document.ts`): registering it would
 * file the definition under an identity its contents do not have. And an unrecognised field is
 * refused rather than ignored, so a `recordWhen` where the field is `record_when` cannot be
 * dropped in silence. The third refusal -- an already-registered shape whose *prose* changed
 * must update rather than report `unchanged` -- lives in `register-document.ts`, because
 * `asc types import` needs exactly the same one.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand } from '../../base.js';
import { parseDocument, verifyDocumentHash } from '../../document.js';
import { readInput } from '../../input.js';
import { registerDocument } from '../../register-document.js';

export default class TypesDefine extends BaseCommand {
  static override description = 'Register a type definition from a JSON document.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review.json',
    '<%= config.bin %> <%= command.id %> --dry-run review.json',
    'cat review.json | <%= config.bin %> <%= command.id %> -',
  ];

  static override args = {
    file: Args.string({
      description: 'Path to a type document, or `-` to read one from standard input.',
      required: true,
    }),
  };

  static override flags = {
    // Quoted and hyphenated, not `dryRun`. Measured against this oclif: a camelCase key
    // renders as `--dryRun`, verbatim -- it is NOT converted to kebab-case -- which is the
    // spelling `cli-best-practices` rule 7 asks callers to be offered. Read back as
    // `flags['dry-run']`, since a quoted key is not a valid property access.
    'dry-run': Flags.boolean({
      description: 'Report exactly what would happen, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesDefine);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    // Named for the error messages: with a pipeline, "which document?" is the first question a
    // caller has, and `standard input` is a more useful answer than a bare `-`.
    const source = args.file === '-' ? 'standard input' : args.file;
    const document = parseDocument(await readInput(args.file), source);

    // Before the store is opened, so a document that misdescribes its own identity cannot
    // reach it at all.
    verifyDocumentHash(document, source);

    await this.withProject(({ store }) => {
      const result = registerDocument(store, document, { registeredAt: this.now(), dryRun });

      for (const rename of result.renames) this.warn(`renamed '${rename.from}' -> '${rename.to}'`);
      for (const warning of result.warnings) this.warn(`warning: ${warning}`);
      if (dryRun) this.warn('dry run: nothing was written.');

      this.emit(format, {
        columns: ['name', 'version', 'major', 'outcome', 'bump'],
        rows: [
          {
            name: result.name,
            version: result.version,
            major: result.major,
            type_hash: result.typeHash,
            outcome: result.outcome,
            bump: result.bump,
            // The count, not the list: `changes` are prose describing a diff, and a script
            // that wants them can read the two specs. The list would be a paragraph in a
            // cell, which is what `output.ts` elides.
            change_count: result.changeCount,
            dry_run: dryRun,
          },
        ],
      });
    });
  }
}
