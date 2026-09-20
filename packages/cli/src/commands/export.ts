/**
 * `asc export` -- the whole corpus as a JSONL stream, definitions before what depends on them.
 *
 * `asc-brt`, and the counterpart of `asc import`. The store is per-project and gitignored, so this
 * is the only thing that carries a corpus out of a working copy: the file this writes is what
 * survives a deleted checkout. As of `asc-6u5`, that includes annotation schemes and the
 * annotations recorded under them -- a hand label, a kappa pass, a rule's whole classification --
 * not only the entries a trigger already protects.
 *
 * **Types first, every version, oldest-first**, for the reason `types export` states: registration
 * mints the next version number, so replaying v1 then v2 reproduces the versions the exporting
 * project holds. Schemes are the same argument applied to `registerScheme`, which mints its own
 * version numbers the identical way. Then every entry, in `(recorded_at, id)` order, then every
 * annotation, in `(scheme, scheme_version, created_at, id)` order. The full order -- `type`,
 * `entry`, `scheme`, `annotation` -- is a foreign-key contract, not a preference: see `corpus.ts`.
 *
 * **The default output is the stream, and `--json` is the versioned envelope.** The same split
 * `types export` makes, for the same reason: the round trip is this command's purpose, so
 * `asc export | asc import -` has to work with no flag, and a caller who asks for `--json` gets
 * the envelope every other command gives rather than a synonym for the bare form (asc-qmn).
 *
 * **The entries are read through `findEntry`, not by a second SELECT.** `findEntry` re-validates
 * every row against the definition it names, so a row that no longer satisfies its own spec is a
 * loud failure on the way out instead of a corpus that restores into a store whose views cannot
 * render it. That is the argument `pages.ts` makes for hydrating ids rather than selecting rows,
 * and it costs an export the ability to rescue such a row -- which is stated here rather than
 * discovered, because "the escape hatch refused to run" is a surprising thing to meet.
 *
 * `--csv` is refused and no longer advertised, exactly as `asc types export` refuses it: a corpus
 * is a heterogeneous stream of four shapes and a CSV cell holding one is a cell a reader has to
 * parse back anyway. `asc-3u2` item (d) is why the flag is hidden as well as refused.
 *
 * **Redaction lives here, not at the write path, and not as a hash.** `redact.ts` states the
 * reasoning in full; the summary that matters for this file is where the boundary falls.
 * Locally the store sits next to the very directories it names -- an absolute `cwd`, a
 * dash-encoded project label -- so it discloses nothing the filesystem around it does not already
 * show. The leak materialises the moment the corpus LEAVES the machine, and this command is the
 * one place that happens. `--redact` rewrites `corpusLines(store)`'s own result before either
 * output path below reads it, so the default JSONL and `--json` can never disagree about which
 * lines they carry. `--redact-name` and `--redact-map` are refused outright without `--redact`,
 * rather than silently doing nothing: a caller who typed `--redact-name` alone and got an
 * unredacted stream back would have shipped the exact disclosure this feature exists to prevent.
 */

import { Flags } from '@oclif/core';
import {
  annotationRows,
  entryIds,
  findEntry,
  listSchemes,
  listTypes,
  schemeVersions,
  typeVersions,
  type AnnotationRow,
  type RecordedEntry,
  type SchemeSummary,
  type Store,
} from '@ascend/store';
import { BaseCommand, OUTPUT_FLAGS } from '../base.js';
import {
  annotationLine,
  entryLine,
  orderedLine,
  schemeLine,
  serializeCorpus,
  typeLine,
  type AnnotationLine,
  type CorpusLine,
} from '../corpus.js';
import { refusal, usageError } from '../errors.js';
import {
  buildRedactionMap,
  identityVocabulary,
  redactLines,
  type IdentityVocabulary,
  type RedactionMap,
  type RedactionResult,
} from '../redact.js';

export default class ExportCorpus extends BaseCommand {
  static override description =
    'Write every type definition, entry, annotation scheme, and annotation as a JSONL stream. ' +
    '--redact scrubs project labels -- and any MCP server or skill named with --redact-name -- ' +
    'before the stream leaves this machine.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> > corpus.jsonl',
    '<%= config.bin %> <%= command.id %> | <%= config.bin %> import -',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --redact | <%= config.bin %> import -',
    '<%= config.bin %> <%= command.id %> --redact --redact-name my-internal-server --redact-map',
  ];

  /**
   * The same override, and the same reasoning, as `asc types export` -- see that file. `csv-raw`
   * is hidden alongside `csv` for the same reason: it only qualifies a format this command
   * refuses, so advertising it in `--help` would offer a flag that cannot be honoured here.
   */
  static override baseFlags = {
    ...OUTPUT_FLAGS,
    csv: Flags.boolean({ description: 'Print RFC 4180 CSV.', hidden: true }),
    'csv-raw': Flags.boolean({ ...OUTPUT_FLAGS['csv-raw'], hidden: true }),
  };

  /**
   * `--redact` is the only one of the three that does anything on its own. `--redact-name` and
   * `--redact-map` each refine or reveal a redaction that is already happening, so each is refused
   * without `--redact` (`run`, below) rather than accepted as a no-op -- see this file's module
   * doc for why a silent no-op is the wrong default here specifically.
   */
  static override flags = {
    redact: Flags.boolean({
      description:
        'Rewrite the stream before printing it: every dash-encoded project label is tokenised, ' +
        'a working directory that cannot be made relative is dropped, and a report of what was ' +
        'found and changed is printed to stderr. Applies to both the default JSONL and --json.',
    }),
    'redact-name': Flags.string({
      description:
        'An MCP server or skill name to tokenise, on top of the project labels --redact always ' +
        'tokenises. Repeat for each name. Run --redact once first (the report names every server ' +
        'and skill the stream discloses) to see what there is to choose from. Requires --redact.',
      multiple: true,
    }),
    'redact-map': Flags.boolean({
      description:
        'Print the allocated label -> token map to stderr. This mapping is what re-identifies ' +
        'the redacted stream, which is why it is off by default and never written to a file: ' +
        'capture it yourself by redirecting stderr if you need to keep it. Requires --redact.',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ExportCorpus);
    const format = this.resolveFormat(flags);

    if (format === 'csv') {
      throw usageError(
        '`asc export --csv` is not a format: a corpus line is a type definition, an entry, an ' +
          'annotation scheme, or an annotation, and the four have different fields, so no one ' +
          'header row describes them. The export is JSONL; use `asc query --csv` if what you want ' +
          'is one type as columns.',
      );
    }

    const redact = this.flagValue(flags.redact);
    const redactNames = flags['redact-name'] ?? [];
    const printMap = this.flagValue(flags['redact-map']);

    // Refusals, not warnings (module doc, above): each of these two flags is worthless without
    // `--redact`, and a caller who forgot it deserves a loud stop rather than a quiet stream that
    // does not do what they asked for.
    if (!redact && redactNames.length > 0) {
      throw usageError(
        '--redact-name names a server or skill to tokenise, but nothing is tokenised unless ' +
          '--redact is also passed -- add --redact, or drop --redact-name.',
      );
    }
    if (!redact && printMap) {
      throw usageError(
        '--redact-map prints the token map --redact builds, but --redact was not passed, so ' +
          'there is no map -- add --redact, or drop --redact-map.',
      );
    }

    await this.withProject(({ store, root }) => {
      const rawLines = corpusLines(store);
      const lines = redact ? this.redacted(rawLines, redactNames, root, printMap) : rawLines;

      if (format === 'json') {
        // `row_count` is what distinguishes a corpus with no entries from a truncated answer, in
        // the spelling a script reads -- the same argument `types export` makes for its envelope.
        //
        // `columns` is required by `Output` and unused: the default output is this format, not a
        // grid, and the names are here so a reader is not misled into thinking one exists.
        this.emit(format, {
          columns: ['kind', 'id', 'type_name', 'type_version', 'recorded_at'],
          rows: lines.map(orderedLine),
        });
        return;
      }

      // `emitText`, not `this.log`: `log('')` writes a newline, so an empty corpus -- which
      // `serializeCorpus` deliberately renders as zero bytes -- came out as one blank line, and
      // every non-empty corpus came out with a stray trailing one. Measured against the real
      // binary: `asc export` on a store with nothing in it printed `'\n'`, and `wc -l` on a
      // 42-line export said 43. `emitText` is the door the rest of the commands already use and
      // its comment states this exact rule.
      this.emitText(serializeCorpus(lines));
    });
  }

  /**
   * `lines`, rewritten under a redaction map built for THIS export, having already printed the
   * report of what the map found and did (`report`, below) and, if asked, the map itself
   * (`printTokenMap`). Pulled out of `run` so the one call site there reads as what it is -- "the
   * lines, or the redacted lines" -- rather than the whole computation inline.
   */
  private redacted(
    lines: readonly CorpusLine[],
    names: readonly string[],
    projectRoot: string,
    printMap: boolean,
  ): readonly CorpusLine[] {
    const vocabulary = identityVocabulary(lines);
    const map = buildRedactionMap(lines, { names });
    const result = redactLines(lines, map, { projectRoot });

    this.report(vocabulary, map, result);
    if (printMap) this.printTokenMap(map);

    return result.lines;
  }

  /**
   * What this export discloses, what got tokenised, and the two counts that must never be spun
   * as "clean" -- `cwdOmitted` (a working directory dropped rather than guessed) and
   * `residueLines` (free text still matching a home-path pattern after every rule above has run).
   *
   * All of it on stderr (`cli-best-practices` rule 1, and `ingest/claude-code.ts`'s `report`
   * follows the identical shape): stdout carries the stream, so `asc export --redact >
   * corpus.jsonl` cannot end up with report text spliced into the JSONL it is supposed to be.
   */
  private report(vocabulary: IdentityVocabulary, map: RedactionMap, result: RedactionResult): void {
    this.logToStderr(
      `this export discloses ${String(vocabulary.projects.length)} project label(s), ` +
        `${String(vocabulary.servers.length)} MCP server name(s), ` +
        `${String(vocabulary.skills.length)} skill name(s), and ` +
        `${String(vocabulary.homePathLines)} line(s) carrying an absolute home-shaped path.`,
    );

    // Project labels are never listed by name: `identityVocabulary` counts every one, but a
    // project label is always tokenised below with no choice involved, so printing it to a
    // terminal here would be the exact disclosure `--redact` exists to stop. Servers and skills
    // ARE listed, with their line counts, because the operator cannot choose what to pass to
    // --redact-name without first seeing what there is to choose from.
    for (const [label, values] of [
      ['MCP server', vocabulary.servers],
      ['skill', vocabulary.skills],
    ] as const) {
      if (values.length === 0) continue;
      this.logToStderr(`${label} name(s) this export discloses:`);
      for (const value of values) {
        this.logToStderr(`  ${value.value}: ${String(value.lines)} line(s)`);
      }
    }

    this.logToStderr(
      `tokenised: ${String(map.projects.size)} project label(s), ` +
        `${String(map.servers.size)} server name(s), ${String(map.skills.size)} skill name(s).`,
    );

    this.logToStderr(
      `${String(result.cwdOmitted)} working director${result.cwdOmitted === 1 ? 'y' : 'ies'} ` +
        `could not be expressed relative to any known root, so ` +
        `${result.cwdOmitted === 1 ? 'it was' : 'they were'} dropped rather than guessed.`,
    );

    // Never an unqualified "clean". Zero is "no line matched the pattern", not "this export is
    // safe to share" -- free text is not scanned for identity with any guarantee, and the wording
    // below says so in both branches rather than only the one where the count is positive.
    this.logToStderr(
      result.residueLines === 0
        ? '0 line(s) still match a home-path pattern after rewriting. That is not a claim that ' +
            'this export is safe to share: free text cannot be scanned for identity with any ' +
            'guarantee.'
        : `${String(result.residueLines)} line(s) still match a home-path pattern after ` +
            'rewriting. Free text cannot be scanned for identity with any guarantee, so read ' +
            'them by hand before sharing this export.',
    );
  }

  /**
   * The allocated map, one `label -> token` line per entry, under a header that says plainly what
   * it is for: this mapping is what would let someone reverse the redaction, so it must never
   * travel with the redacted stream. That is also why this writes nothing to a file -- a caller
   * who wants to keep it captures this stderr output themselves.
   */
  private printTokenMap(map: RedactionMap): void {
    this.logToStderr(
      'redaction map -- do NOT let this travel with the redacted stream above; it is what would ' +
        'let someone reverse it:',
    );
    for (const entries of [map.projects, map.servers, map.skills]) {
      for (const [label, token] of entries) {
        this.logToStderr(`${label} -> ${token}`);
      }
    }
  }
}

/**
 * Every type version, then every entry, then every scheme version, then every annotation.
 *
 * The order is the contract: `import` registers definitions in the order it reads them, so a
 * stream whose types (or schemes) were sorted differently would mint different version numbers --
 * and `annotations` carries foreign keys to both `entries` and `annotation_schemes` (`schema.ts`),
 * so it has to reach `import` after both. Types and schemes each go in name order -- so two
 * exports of one registry differ only where the registry does, which is what makes a diff of them
 * mean something -- with each name's versions oldest-first. Entries go in `(recorded_at, id)`, the
 * same order `pages.ts` pages in, and annotations go in `(scheme, scheme_version, created_at, id)`
 * -- see `annotationLines` for why the timestamp alone is not enough.
 */
function corpusLines(store: Store): readonly CorpusLine[] {
  const types = listTypes(store.db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => typeVersions(store.db, name))
    .map(typeLine);

  const schemes = listSchemes(store.db)
    .map((summary) => summary.name)
    .sort()
    .flatMap((name) => schemeVersions(store.db, name));

  return [
    ...types,
    ...entries(store).map(entryLine),
    ...schemes.map(schemeLine),
    ...annotationLines(store, schemes),
  ];
}

/**
 * Every entry of every type, hydrated and validated.
 *
 * An id that `entryIds` listed and `findEntry` cannot produce would be a store that disagrees with
 * itself, so it is a refusal naming the id rather than a skipped row: a corpus that is quietly one
 * entry short is the failure this command exists to prevent.
 */
function entries(store: Store): readonly RecordedEntry[] {
  const found: RecordedEntry[] = [];

  for (const summary of listTypes(store.db)) {
    for (const id of entryIds(store.db, summary.name)) {
      const entry = findEntry(store.db, id);
      if (entry === undefined) {
        throw refusal(
          `the store lists an entry with id ${id} under '${summary.name}' and then cannot read ` +
            `it back, so the export would be missing a row. Nothing was written. This is a ` +
            `problem with the store rather than with your input.`,
        );
      }
      found.push(entry);
    }
  }

  // Sorted here rather than by the query, because the rows come from one query per type and the
  // order that matters spans all of them.
  return found.sort(
    (left, right) =>
      left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id),
  );
}

/**
 * Every annotation of every scheme version, in `(scheme, scheme_version, created_at, id)` order.
 *
 * `annotationRows` already orders one scheme-version's rows by `(created_at, entry_id)` -- the
 * order a rater's label list reads well in -- but that is not enough to make a *stream*
 * byte-stable, because two annotations of one pass can share a `created_at` (the pass IS its
 * timestamp; see `annotations.ts`) with nothing but `entry_id` breaking the tie, and this stream's
 * own determinism promise is keyed on `id`, not on which entry happened to be labelled. So the
 * rows are read scheme-version by scheme-version and then re-sorted here, by the id `orderedLine`
 * asserts stability over -- the same reason `export.ts`'s own `entries` function sorts across
 * queries rather than trusting any one of them.
 */
function annotationLines(
  store: Store,
  schemes: readonly SchemeSummary[],
): readonly AnnotationLine[] {
  const rows: { readonly scheme: string; readonly version: number; readonly row: AnnotationRow }[] =
    [];

  for (const summary of schemes) {
    for (const row of annotationRows(store.db, {
      scheme: summary.name,
      version: summary.version,
    })) {
      rows.push({ scheme: summary.name, version: summary.version, row });
    }
  }

  rows.sort(
    (left, right) =>
      left.scheme.localeCompare(right.scheme) ||
      left.version - right.version ||
      left.row.createdAt.localeCompare(right.row.createdAt) ||
      left.row.id.localeCompare(right.row.id),
  );

  return rows.map(({ scheme, version, row }) => annotationLine(row, scheme, version));
}
