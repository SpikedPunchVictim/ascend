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
 *
 * **Then it looks for where the type's data already is** (asc-tuur.5). A newly registered shape is
 * followed by a capture plan over this project's transcripts, and one line on stderr says whether
 * ascend can fill the type from what sessions already write -- so a user learns how the type
 * will be captured without having to ask, and without their workflow changing. The plan only
 * reads; `asc types capture` shows it and `--write` saves it. `--no-capture` skips it, and a
 * failure to read the transcripts never fails the define.
 */

import { Args, Flags } from '@oclif/core';
import type { TypeSpec } from '@ascend/core';
import { BaseCommand } from '../../base.js';
import { parseDocument, verifyDocumentHash } from '../../document.js';
import { defaultTranscriptRoot } from '@ascend/adapter-claude-code';
import { sessionsNote, sweepCapture } from '../../capture-sweep.js';
import { encodeProjectDir } from '../../handler-replay.js';
import { readInput } from '../../input.js';
import { describedProperties } from '../../property-shape.js';
import { registerDocument } from '../../register-document.js';

export default class TypesDefine extends BaseCommand {
  static override description = 'Register a type definition from a JSON document.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review.json',
    '<%= config.bin %> <%= command.id %> --dry-run review.json',
    'cat review.json | <%= config.bin %> <%= command.id %> -',
  ];

  static override args = {
    // `ignoreStdin` because oclif otherwise fills a missing positional from stdin, and `file` is
    // a PATH: `cat review.json | asc types define` read the document as a filename and failed
    // with `ENOENT` quoting the document back. The long form of this is in `record.ts`; the
    // short form is that stdin is reached by `-`, deliberately and only.
    file: Args.string({
      description: 'Path to a type document, or `-` to read one from standard input.',
      required: true,
      ignoreStdin: true,
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
    capture: Flags.boolean({
      description:
        'After registering a new shape, look in this project’s transcripts for where its data ' +
        'already appears. On by default; --no-capture skips it.',
      default: true,
      allowNo: true,
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

    await this.withProject(async ({ store, root }) => {
      const result = registerDocument(store, document, { registeredAt: this.now(), dryRun });

      for (const rename of result.renames) this.warn(`renamed '${rename.from}' -> '${rename.to}'`);
      // No `warning: ` prefix of our own: `this.warn` already renders one, so prefixing printed
      // "Warning: warning: ..." for every store warning. Caught by reading the real command's output
      // rather than by any test -- which is the reason this comment is here instead of a test.
      for (const warning of result.warnings) this.warn(warning);
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

      if (result.outcome === 'created' && flags.capture) {
        // Descriptions may sit in the document's prose rather than on the property; matching reads
        // them, so the overlay `types show` uses is applied first.
        await this.adviseCapture(
          {
            name: document.name,
            properties: describedProperties(document.properties, document.prose ?? {}),
          },
          root,
        );
      }
    });
  }

  /** One line on how the type would be captured; never a failure of the define itself. */
  private async adviseCapture(spec: TypeSpec, root: string): Promise<void> {
    let sweep: Awaited<ReturnType<typeof sweepCapture>>;
    try {
      sweep = await sweepCapture(spec, {
        root: defaultTranscriptRoot(),
        projects: new Set([encodeProjectDir(root)]),
        includeEphemeral: true,
      });
    } catch (error) {
      this.warn(
        `could not look for ${spec.name} in this project's transcripts ` +
          `(${error instanceof Error ? error.message : String(error)}).`,
      );
      return;
    }
    if (sweep.files === 0) return;
    const best = sweep.plan.tables[0];
    if (best === undefined || sweep.verified === undefined) {
      this.warn(
        `nothing in this project's transcripts reads as ${spec.name} yet; ` +
          `'asc types capture ${spec.name}' looks again whenever it is run.`,
      );
      return;
    }
    const { valid, refused } = sweep.verified;
    this.warn(
      `ascend can capture ${spec.name} from what sessions already write: a table with columns ` +
        `${best.columns.map((one) => one.column).join(', ')} in ${sessionsNote(best.sessions)}. ` +
        `A drafted handler would write ${String(valid)} entr${valid === 1 ? 'y' : 'ies'} and ` +
        `the type would refuse ${String(refused)}. Run 'asc types capture ${spec.name}' to ` +
        `read the draft, and add --write to save it.`,
    );
  }
}
