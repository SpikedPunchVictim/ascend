/**
 * `asc record <type>` -- write entries.
 *
 * The hot path. A model calls this more than everything else combined, so the shape is built
 * around two constraints from ARCHITECTURE.md ("Recording cost"): the invocation must stay inside
 * a `Bash(asc record:*)` allowlist entry, and the document goes in on **stdin** because shell-
 * escaping a paragraph of evidence text is where a recorder gives up.
 *
 * ```
 * asc record decision --prop=chosen=walk up --prop=rationale=…
 * asc record decision payload.json
 * cat payload.json | asc record decision -
 * ```
 *
 * **The document is an OPERAND, not `--json -`, and that is a recorded deviation from
 * ARCHITECTURE.md's `asc record <type> [--json -]`.** `--json` was already shipped as the
 * versioned-output contract on every command (`base.ts`, `output.ts`, and E4.2's own JSON-contract
 * test), so a `--json` that meant "read JSON here" would be two meanings for one flag on one
 * command: `asc record x --json -` and `asc record x --json` would differ by an operand that
 * changes what the *flag* means. There is no spelling that keeps both.
 *
 * The operand form keeps everything the spec asked for -- stdin is still the primary path,
 * `readInput` still handles `-`, flags are still the convenience -- and it matches
 * `asc types define|import`, which have read their document from an operand since E4.2. One
 * convention for "read a document from stdin" across the whole CLI is worth more than the exact
 * spelling of the flag in one command.
 *
 * **One call records one type.** The operand names it, and an entry document may not carry its own
 * (`entry-document.ts` says why): every validation error the store produces suggests a fix of the
 * form `asc record <type> --prop=<name>=<value>` (`core/state.ts`), and that suggestion has to be
 * a command that works.
 *
 * **Entry-content flags and call-level flags are different kinds, and only the first kind
 * conflicts with a document.** `--prop`, `--na` and `--evidence` describe *an entry*, so supplying
 * both a document and one of them is two answers to one question and is refused as a usage error.
 * `--type-version`, `--run-id`, `--workflow`, `--actor` and `--dry-run` describe *the call*, so
 * they apply to a batch as defaults for entries that do not state their own -- a caller recording
 * ten entries should not repeat the run id ten times.
 *
 * **A batch is all-or-nothing.** SQLite's default is autocommit, so without a transaction a batch
 * whose fourth entry fails validation would leave the first three permanently written (entries are
 * immutable and cannot be deleted) while exiting non-zero and naming one failure. `withTransaction`
 * is what makes the exit code describe the whole store: 0 means every entry is there, 1 means none
 * is. The dry run is the same work inside `withRollback`, so a preview cannot report an outcome
 * the real run would not produce -- the same reasoning as `types import`.
 *
 * **Provenance ascend can read, it reads.** `cwd` comes from the process; `source` is always
 * `self`; `id` and `recorded_at` are minted here because core and store are pure and take both
 * injected (`TASKS.md` #6). `repo`, `git_sha` and `branch` are derivable too and are deliberately
 * NOT read yet: they mean spawning `git` on the path `asc-9y1` exists to measure, and E5's adapter
 * is where derived envelope fields are specified (the E4.1 decision table records the same deferral).
 */

import { randomUUID } from 'node:crypto';
import { Args, Flags } from '@oclif/core';
import {
  recordEntry,
  UnknownTypeError,
  withRollback,
  withTransaction,
  type RecordContext,
  type RecordRequest,
  type RecordResult,
} from '@ascend/store';
import { canonicalJson } from '@ascend/core';
import { BaseCommand } from '../base.js';
import { parseEntryDocuments, type EntryDocument } from '../entry-document.js';
import { refusal, usageError } from '../errors.js';
import { readInput, STDIN } from '../input.js';

/** One row of the report: the entry that was written, as the caller can refer to it. */
interface RecordRow extends Record<string, unknown> {
  readonly index: number;
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly type_hash: string;
  readonly recorded_at: string;
  readonly source: string;
  readonly states: Readonly<Record<string, string>>;
  readonly na: readonly string[];
  readonly warnings: readonly string[];
  readonly dry_run: boolean;
}

/**
 * A flag value, as the type it looks like.
 *
 * JSON when it parses, the raw string otherwise: `--prop=rounds=3` sets the integer 3 and
 * `--prop=verdict=approved` sets the string `approved`, without the caller having to know a
 * convention. A value cannot be *silently* mistyped -- every property type refuses a value of the
 * wrong shape (`core/schema.ts`), so a guess that lands wrong is a loud refusal naming what the
 * property expects, never a plausible-looking wrong value in the ledger.
 *
 * The consequence worth stating: a property typed `string` or `text` whose value is *exactly* a
 * JSON literal needs quoting, `--prop=note='"3"'`, or the value arrives as the number 3 and is
 * refused. That is the correct direction to fail, and it is why the escape hatch is documented
 * here rather than left to be discovered.
 */
function flagValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * `--prop=<name>=<value>` → a `[name, value]` pair.
 *
 * Split on the FIRST `=`, so a value may contain as many as it likes -- an expression, a URL, a
 * base64 blob. The `<= 0` test covers both a missing `=` and an empty name, since `--prop==x` has
 * `indexOf('=')` at 0 and no property can be named the empty string.
 *
 * The spelling is not a choice: `core/state.ts`'s `recordCommand` writes
 * `asc record <type> --prop=<name>=<value>` into every validation error it generates. A parser that
 * accepted anything else would make the fix ascend suggests a command that fails.
 */
function parsePropertyFlag(raw: string): readonly [string, unknown] {
  const separator = raw.indexOf('=');
  if (separator <= 0) {
    throw usageError(
      `--prop must be '--prop=<name>=<value>', but '${raw}' does not have a name and a value ` +
        `separated by '='. Example: --prop=chosen=walk up.`,
    );
  }
  return [raw.slice(0, separator), flagValue(raw.slice(separator + 1))];
}

/**
 * Whether two parsed `--prop` values are the SAME value.
 *
 * `canonicalJson` rather than `JSON.stringify`, because it sorts object keys: `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are one value written two ways, and treating them as two would be a false alarm.
 * And an alarm that fires when nothing was lost is how a warnings channel stops being read.
 *
 * It THROWS on a non-finite number, and `JSON.parse('1e999')` really does produce `Infinity`, so a
 * pair that cannot be compared counts as different. The direction matters: warning about a repeat
 * that turns out to have been harmless is a smaller failure than silently discarding a value, and
 * the silent discard is the defect this exists to fix.
 */
function sameValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

/**
 * What the `--prop` flags came to, and which of them were overruled.
 */
interface PropertyFlags {
  /**
   * The properties to record, keyed by name. Null-prototype: the names come from the command
   * line. On an object literal `--prop=__proto__=x` is swallowed by the inherited `__proto__`
   * accessor instead of becoming a key, so `Object.entries` never sees it and the unknown-
   * property warning never fires -- the flag would be dropped with no output at all, which is
   * the silent-success failure this command refuses everywhere else.
   */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Names given more than once with values that DIFFER, in first-written order, with the text the
   * caller actually typed for each.
   *
   * The text, not the parsed value, because the message has to quote what the caller wrote: the
   * whole point is that they cannot tell from their own command line which of their two values
   * survived. Measured before this existed: `--prop=chosen=a --prop=chosen=b` recorded `"b"`,
   * exited 0, and printed nothing at all to stderr -- into a ledger that cannot be corrected, since
   * entries are immutable and `recordEntry` refuses a duplicate id.
   *
   * A repeat with the SAME value is deliberately NOT here. Nothing is lost, and `--na` already
   * treats a repeat as a set rather than a warning; a warning that fires when nothing was discarded
   * is noise, and noise is what makes a real warning invisible.
   */
  readonly overruled: readonly { readonly name: string; readonly texts: readonly string[] }[];
}

/** The `--prop` flags as a properties object, plus the repeats that discarded a value. */
function propertiesFrom(propFlags: readonly string[]): PropertyFlags {
  const properties = Object.create(null) as Record<string, unknown>;
  // A Map, not a null-prototype object: this groups by name and is never serialized, so it does
  // not need the shape rule the `properties` object above is subject to. Insertion order is the
  // order the names were first written, which is the order the warnings should be reported in.
  const groups = new Map<string, { values: unknown[]; texts: string[] }>();

  for (const raw of propFlags) {
    const [name, value] = parsePropertyFlag(raw);
    const text = raw.slice(raw.indexOf('=') + 1);
    const group = groups.get(name) ?? { values: [], texts: [] };
    group.values.push(value);
    group.texts.push(text);
    groups.set(name, group);
    properties[name] = value;
  }

  const overruled = [...groups]
    .filter(([, group]) => group.values.some((value) => !sameValue(value, group.values[0])))
    .map(([name, group]) => ({ name, texts: group.texts }));

  return { properties, overruled };
}

/**
 * How a discarded `--prop` repeat is reported: what was written, and which value is kept.
 *
 * `problem`/`fix` split rather than one sentence, because this goes onto the row alongside the
 * store's own warnings and those are read as `field: problem`.
 */
function overruledWarning(
  name: string,
  texts: readonly string[],
): { problem: string; fix: string } {
  const values = texts.map((text) => `'${text}'`).join(', ');
  return {
    problem: `--prop=${name} was given ${String(texts.length)} times with different values (${values})`,
    fix:
      `Only the last is recorded. A property has one value, so the earlier ones were discarded -- ` +
      `remove them, or if you did not mean the same property, check the names.`,
  };
}

/** How a message names one entry: by index in a batch, and not at all otherwise. */
function entryLabel(index: number, total: number): string {
  return total > 1 ? `entry ${String(index)}` : 'the entry';
}

/**
 * Re-throw a per-entry failure with the entry named.
 *
 * Measured on a two-entry batch whose second entry was invalid: the store's message described the
 * *problem* precisely and said nothing about *which* entry had it, so a caller with a fifty-entry
 * batch had to bisect it. The store cannot know the index -- it records one entry and has no idea
 * it was called in a loop -- so the index is added where it is known.
 *
 * `UnknownTypeError` is deliberately NOT wrapped: it is about the call rather than any entry (one
 * unregistered type fails every entry identically), and it is already the longest message here,
 * listing the types that do exist.
 */
function withEntryIndex(error: unknown, index: number, total: number): unknown {
  if (total <= 1 || error instanceof UnknownTypeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return refusal(`${entryLabel(index, total)}: ${message}`);
}

/** The `--na` flags as a name list: comma-separated, repeatable, deduplicated. */
function naFrom(naFlags: readonly string[]): readonly string[] {
  const names = naFlags.flatMap((value) => value.split(',')).map((name) => name.trim());
  const empty = names.filter((name) => name === '');
  if (empty.length > 0) {
    throw usageError(
      `--na has an empty name in it. Write the property names separated by commas, with no ` +
        `trailing comma: --na reversibility,stage.`,
    );
  }
  // Deduplicated here as well as in the store, so the flag's own meaning is "these properties do
  // not apply" rather than "these names, plus a warning about the repeats".
  return [...new Set(names)];
}

export default class RecordEntry extends BaseCommand {
  static override description = 'Record one or more entries of a single entry type.';

  static override examples = [
    '<%= config.bin %> <%= command.id %> decision --prop=chosen=walk-up --prop=rationale=git-does-this',
    'cat entry.json | <%= config.bin %> <%= command.id %> decision -',
    '<%= config.bin %> <%= command.id %> stuck_event batch.json --dry-run',
  ];

  static override args = {
    type: Args.string({
      description: 'The entry type to record. It must be registered in this project.',
      required: true,
    }),
    document: Args.string({
      description:
        'Path to an entry document, or `-` for standard input. A single object records one ' +
        'entry; an array records a batch. Omit it when using --prop/--na/--evidence.',
      required: false,
    }),
  };

  static override flags = {
    // Quoted and hyphenated rather than `dryRun`: measured against this oclif, a camelCase key
    // renders verbatim as `--dryRun` (`types/define.ts`).
    'dry-run': Flags.boolean({
      description: 'Validate everything and report what would be written, then write nothing.',
    }),
    // Not plain `--version`: on a subcommand that spelling reads as "the version of asc", which is
    // the root's flag, and the value here is the version of the TYPE being recorded.
    'type-version': Flags.integer({
      description: 'Record against this registered version instead of the latest one.',
    }),
    prop: Flags.string({
      description: 'Set one property: --prop=<name>=<value>. Repeat for each property.',
      multiple: true,
    }),
    na: Flags.string({
      description: 'Property names that do not apply, comma-separated. Repeatable.',
      multiple: true,
    }),
    evidence: Flags.string({
      description: 'Free text stored alongside the entry, and what `asc search` indexes.',
    }),
    'run-id': Flags.string({
      description: 'Group this entry with others from the same run. Defaults to nothing.',
    }),
    workflow: Flags.string({ description: 'What produced this entry. Defaults to nothing.' }),
    actor: Flags.string({ description: 'Who or what recorded this. Defaults to nothing.' }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RecordEntry);
    const format = this.resolveFormat(flags);
    const dryRun = this.flagValue(flags['dry-run']);
    const props = flags.prop ?? [];
    const nas = flags.na ?? [];

    // Two sources for one entry is two answers to the same question, and merging them would mean
    // choosing a winner per property -- a rule nobody could predict from the command line.
    if (
      args.document !== undefined &&
      (props.length > 0 || nas.length > 0 || flags.evidence !== undefined)
    ) {
      throw usageError(
        `a document (${args.document}) and entry flags (--prop/--na/--evidence) cannot be ` +
          `combined: they describe the same entry twice. Use the document, or use flags. ` +
          `--type-version, --run-id, --workflow, --actor and --dry-run apply to either.`,
      );
    }

    // The flag path with neither flags nor a document is a caller who expected stdin to be read
    // without saying so. `cli-best-practices` rule 3: refuse with the missing operand named,
    // never wait for input nobody offered.
    if (
      args.document === undefined &&
      props.length === 0 &&
      nas.length === 0 &&
      flags.evidence === undefined
    ) {
      throw usageError(
        `nothing to record: give a document to read (a path, or - for standard input), or set ` +
          `properties with --prop=<name>=<value>. Run 'asc types show ${args.type}' to see which ` +
          `properties it declares.`,
      );
    }

    const propFlags = propertiesFrom(props);
    // Only ever non-empty when `--prop` supplied the entry, which is the one-document path below:
    // that is why these can be emitted once for the call and attached to the first row.
    const overruled = propFlags.overruled.map(({ name, texts }) => overruledWarning(name, texts));

    const documents =
      args.document === undefined
        ? [
            {
              properties: propFlags.properties,
              ...(nas.length === 0 ? {} : { na: naFrom(nas) }),
              ...(flags.evidence === undefined ? {} : { evidence_text: flags.evidence }),
            } satisfies EntryDocument,
          ]
        : parseEntryDocuments(
            await readInput(args.document),
            args.document === STDIN ? 'standard input' : args.document,
          );

    const typeVersion = this.optionalFlag(flags['type-version']);
    const callLevel = {
      ...(typeVersion === undefined ? {} : { version: typeVersion }),
      ...(flags['run-id'] === undefined ? {} : { run_id: flags['run-id'] }),
      ...(flags.workflow === undefined ? {} : { workflow: flags.workflow }),
      ...(flags.actor === undefined ? {} : { actor: flags.actor }),
    };

    await this.withProject(({ store }) => {
      const ascendVersion = this.ascendVersion();
      const cwd = process.cwd();
      // One clock reading for the whole batch, so entries written by a single call share a
      // timestamp that differs only by what the caller said -- rather than by how long validation
      // took, which is not a fact about the observation.
      //
      // The consequence, stated because it is real and was measured: entries in one batch TIE on
      // `recorded_at`, so `ORDER BY recorded_at` does not recover the order they appeared in the
      // document -- the tie is broken arbitrarily. That is the correct reading. One call recorded
      // them as a set, and within-set order was never a claim this command made; the report's
      // `index` is the caller's order and is the only place it exists.
      const recordedAt = this.now();

      const recordOrRefuse = (
        index: number,
        request: RecordRequest,
        context: RecordContext,
      ): RecordResult => {
        try {
          return recordEntry(store.db, request, context);
        } catch (error) {
          throw withEntryIndex(error, index, documents.length);
        }
      };

      const writeAll = (): RecordRow[] => {
        const rows = documents.map((document, index) => {
          // Call-level flags are DEFAULTS: an entry that states its own value keeps it. A batch
          // carrying one run id per entry and a `--run-id` for the rest must not have the flag
          // overwrite the entries that were explicit about it.
          const merged = { ...callLevel, ...document };
          const context: RecordContext = {
            // Minted when the document does not name one. `randomUUID` rather than a sortable id:
            // `recorded_at` is what orders the ledger, so an id carries no meaning to preserve.
            id: merged.id ?? randomUUID(),
            recordedAt,
            ascendVersion,
            cwd,
            ...(merged.run_id === undefined ? {} : { runId: merged.run_id }),
            ...(merged.workflow === undefined ? {} : { workflow: merged.workflow }),
            ...(merged.actor === undefined ? {} : { actor: merged.actor }),
            ...(merged.evidence_text === undefined ? {} : { evidenceText: merged.evidence_text }),
          };

          const result = recordOrRefuse(
            index,
            {
              type: args.type,
              ...(merged.version === undefined ? {} : { version: merged.version }),
              ...(merged.properties === undefined ? {} : { properties: merged.properties }),
              ...(merged.na === undefined ? {} : { na: merged.na }),
            },
            context,
          );

          for (const warning of result.warnings) {
            this.warn(`${entryLabel(index, documents.length)}: ${warning.problem}. ${warning.fix}`);
          }

          return {
            index,
            id: result.entry.id,
            type: result.entry.typeName,
            version: result.entry.typeVersion,
            type_hash: result.entry.typeHash,
            recorded_at: result.entry.recordedAt,
            source: result.entry.source,
            states: result.entry.states,
            na: result.entry.na,
            // Also on the row, although every one of them has just been written to stderr. A
            // dropped property is silent data loss, and the caller most likely to miss it is the
            // machine reading stdout alone -- which is the caller this command exists for. A
            // discarded `--prop` repeat is the same loss by a different route, so it travels the
            // same way; it is call-level, and the path that produces it is single-entry, which is
            // why it hangs off the first row rather than every one.
            warnings: [
              ...(index === 0 ? overruled.map((w) => `--prop: ${w.problem}`) : []),
              ...result.warnings.map((warning) => `${warning.field}: ${warning.problem}`),
            ],
            dry_run: dryRun,
          };
        });

        // AFTER the writes, not before them, and inside the transaction rather than outside it.
        // The message says the last value IS recorded -- it is a claim about an outcome, so it must
        // not be made until the outcome exists. `recordOrRefuse` refuses from inside the map above,
        // so emitting this first (as the first draft did) announced "Only the last is recorded" on
        // a recording that wrote nothing: a warning about a write that did not happen is its own
        // false report. A dry run reaches here too, because it runs the real work inside
        // `withRollback` rather than skipping it -- so a preview says what the real run would say.
        for (const { problem, fix } of overruled) this.warn(`${problem}. ${fix}`);

        return rows;
      };

      const rows = dryRun ? withRollback(store.db, writeAll) : withTransaction(store.db, writeAll);

      if (dryRun) this.warn('dry run: nothing was written.');
      this.emit(format, { columns: ['index', 'id', 'type', 'version'], rows });
    });
  }
}
