/**
 * `asc types import <file|->` -- register a list of type documents, in order.
 *
 * The counterpart of `export`, and the reason the document format exists: moving a registry
 * between projects must reproduce it, not approximate it.
 *
 * **Every hash is checked before anything is written.** That is what makes a bad list cheap to
 * refuse: a document whose contents do not hash to its stated `type_hash` means the definitions
 * are not the ones the caller thinks, and finding that out after four of six have been
 * registered leaves a half-applied registry. So the whole list is parsed and verified first,
 * and only then does writing begin.
 *
 * **Writing is per-document, and a partial failure is reported as one.** Each document is its own
 * fused write -- its own transaction and its own append (`writeProducedLines`) -- so a failure
 * part-way through leaves the earlier documents written AND in the tree. That is deliberate, and it
 * is pinned by a test: one transaction spanning the list would either have to nest an API that
 * refuses to nest, or rewrite the store's transaction handling for this command alone. But it must
 * not be *silent*. On failure the rows for what did land are still written to stdout, a line on
 * stderr names the document that failed and says how many were registered before it, and the exit
 * code is 1. A caller who retries is safe: registering an already-known shape is `unchanged` and
 * writes nothing.
 *
 * **`--dry-run` owns one transaction for the whole list, and that is not the same as asking each
 * registration to preview itself.** Per-document rollback would mean the second document never
 * sees the first, so it would compute its version as though the first did not exist -- reporting
 * version 1 twice where the real run produces 1 then 2. A preview that misdescribes what the
 * real run does is worse than no preview, so the whole list runs inside a single rollback
 * (`previewProducedLines`) and the preview is atomic: if a document fails, nothing was previewed and
 * nothing was written, and it says so rather than showing rows for work that was discarded.
 *
 * **The two arms differ in scope, not in what they compute.** Both build their rows through the same
 * `report`, over the same `registerDocumentVia`, so the outcome a preview reports for a document is
 * the outcome the real run produces for it; all that differs is the transaction wrapped around the
 * loop. That is the one asymmetry the shape cannot remove -- the preview must be atomic to be honest
 * about versions, and the write must not be, by the decision above -- so it is stated here rather
 * than left for a reader to notice.
 *
 * **Re-running is idempotent**, in the strong sense -- not "it does not error", but "it leaves
 * the registry exactly as it was". Known shapes report `unchanged`, and a document whose prose
 * changed updates the prose without minting a version (`register-document.ts`).
 */

import { Args, Flags } from '@oclif/core';
import { previewProducedLines, type Producers, type SqlDatabase } from '@ascend/store';
import { BaseCommand } from '../../base.js';
import { storePaths } from '../../project.js';
import { parseDocuments, verifyDocumentHash, type TypeDocument } from '../../document.js';
import { readInput } from '../../input.js';
import {
  registerDocument,
  registerDocumentVia,
  type DocumentRegistration,
} from '../../register-document.js';

/** A row of the report: what happened to one document. */
interface ImportRow extends Record<string, unknown> {
  readonly index: number;
  readonly name: string;
  readonly version: number;
  readonly major: number;
  readonly type_hash: string;
  readonly outcome: string;
  readonly bump: string;
  readonly change_count: number;
  readonly dry_run: boolean;
}

/** Names a document the way every other message does: the source, plus its place in the list. */
function label(source: string, index: number, count: number): string {
  return count === 1 ? source : `${source}[${String(index)}]`;
}

export default class TypesImport extends BaseCommand {
  static override description = 'Register type definitions from exported JSON documents.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> review.json',
    '<%= config.bin %> <%= command.id %> --dry-run types.json',
    '<%= config.bin %> types export | <%= config.bin %> <%= command.id %> -',
  ];

  static override args = {
    // `ignoreStdin` for the same reason as `define` above: the arg is a path, and without this
    // oclif would fill it from stdin and then fail with `ENOENT` quoting the document back.
    // `asc types export | asc types import -` is unaffected -- the `-` is the operand.
    file: Args.string({
      description: 'Path to a document or list of documents, or `-` to read from standard input.',
      required: true,
      ignoreStdin: true,
    }),
  };

  static override flags = {
    // The same measured note as `define`: oclif renders a camelCase key as `--dryRun`, so the
    // key is quoted and hyphenated to get the spelling callers are offered.
    'dry-run': Flags.boolean({
      description: 'Report exactly what would happen, then write nothing.',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(TypesImport);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const source = args.file === '-' ? 'standard input' : args.file;
    const documents = parseDocuments(await readInput(args.file), source);

    // Every hash, before any write. A mismatch is a refusal, not a warning: registering the
    // document anyway would file the definition under an identity its contents do not have,
    // and two corpora would stop being comparable without anything recording that they had.
    for (const [index, document] of documents.entries()) {
      verifyDocumentHash(document, label(source, index, documents.length));
    }

    await this.withProjectRoot((root) => {
      const { tree, index: indexFile } = storePaths(root);

      /** One document's row, and the two warnings that accompany it. */
      const report = (
        document: TypeDocument,
        index: number,
        result: DocumentRegistration,
      ): ImportRow => {
        const where = label(source, index, documents.length);
        for (const rename of result.renames) {
          this.warn(`${where}: renamed '${rename.from}' -> '${rename.to}'`);
        }
        // `where` only: `this.warn` renders the "Warning:" itself, and prefixing a second one
        // printed "Warning: doc.json: warning: ...".
        for (const warning of result.warnings) this.warn(`${where}: ${warning}`);

        return {
          index,
          name: result.name,
          version: result.version,
          major: result.major,
          type_hash: result.typeHash,
          outcome: result.outcome,
          bump: result.bump,
          change_count: result.changeCount,
          dry_run: dryRun,
        };
      };

      let rows: ImportRow[];

      if (dryRun) {
        // The whole list inside ONE rollback, so the second document sees the first -- see the
        // file comment. Nothing is appended and nothing is stamped; the index is only opened.
        const preview = (produce: Producers, db: SqlDatabase): ImportRow[] =>
          documents.map((document, index) =>
            report(
              document,
              index,
              registerDocumentVia(produce, db, document, { registeredAt: this.now() }),
            ),
          );

        try {
          rows = previewProducedLines(tree, indexFile, preview);
        } catch (error) {
          // No rows: everything the preview computed was discarded, so reporting it would
          // describe a registry that does not exist.
          this.warn(
            'the dry run failed, so the whole preview was discarded and nothing was written. ' +
              'A dry run is all-or-nothing: it cannot report a partial registration it did not make.',
          );
          throw error;
        }
        if (documents.length > 0) this.warn('dry run: nothing was written.');
      } else {
        // Per document, so a failure leaves the earlier ones written -- the decision the file
        // comment records. `rows` grows as it goes, which is what the catch below reports.
        rows = [];
        try {
          for (const [index, document] of documents.entries()) {
            rows.push(
              report(
                document,
                index,
                registerDocument(tree, indexFile, document, {
                  registeredAt: this.now(),
                  dryRun: false,
                }),
              ),
            );
          }
        } catch (error) {
          // Emitted before the throw so the caller sees both halves: which documents are in
          // the registry, and why the rest are not. The `--json` consumer gets the same rows
          // the table reader does, which is the only way the two can be reconciled later.
          this.emit(format, { columns: [...COLUMNS], rows });
          this.warn(
            `${String(rows.length)} of ${String(documents.length)} document(s) were registered ` +
              `before ${label(source, rows.length, documents.length)} failed, and they remain ` +
              `registered. Fix the document and re-run: registering an already-known definition ` +
              `changes nothing.`,
          );
          throw error;
        }
      }

      this.emit(format, { columns: [...COLUMNS], rows });
    });
  }
}

/** The projection for the table and CSV. `--json` reports the rows as they are, index included. */
const COLUMNS = ['name', 'version', 'major', 'outcome', 'bump'] as const;
