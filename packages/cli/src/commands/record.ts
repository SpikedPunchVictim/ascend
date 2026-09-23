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
import { isAbsolute, relative } from 'node:path';
import { Args, Flags } from '@oclif/core';
import {
  entryCount,
  findType,
  recordEntry,
  UnknownTypeError,
  withRollback,
  withTransaction,
  type RecordContext,
  type RecordRequest,
  type RecordResult,
} from '@ascend/store';
import { canonicalJson, reviewAfterCrossed } from '@ascend/core';
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
 * Whether two `--prop` occurrences of one name are the SAME value.
 *
 * `canonicalJson` rather than `JSON.stringify`, because it sorts object keys: `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are one value written two ways, and treating them as two would be a false alarm.
 * And an alarm that fires when nothing was lost is how a warnings channel stops being read.
 *
 * It THROWS on a non-finite number, and `JSON.parse('1e999')` really does produce `Infinity` --
 * measured. So the uncomparable case needs a direction, and the direction FLIPPED when this stopped
 * feeding a warning and started feeding a refusal. "Cannot compare" used to mean "different", on the
 * grounds that a spurious warning is the smaller failure; as a refusal that same choice refuses a
 * legitimate command, and refuses it with a message quoting two IDENTICAL values as different --
 * a false report, which is the class this project treats as severity-zero.
 *
 * So the text is the tiebreak: when the values cannot be compared, the same text is the same value.
 * That is sound rather than a fudge -- `flagValue` is deterministic, so one text parses to one
 * value, and equal text therefore really is equal input.
 */
function sameValue(left: PropOccurrence, right: PropOccurrence): boolean {
  try {
    return canonicalJson(left.value) === canonicalJson(right.value);
  } catch {
    return left.text === right.text;
  }
}

/** One `--prop` occurrence: the parsed value, and the text the caller typed for it. */
interface PropOccurrence {
  readonly value: unknown;
  readonly text: string;
}

/**
 * What the `--prop` flags came to, and the names they contradicted themselves about.
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
   * would win. Measured before any of this existed: `--prop=chosen=a --prop=chosen=b` recorded
   * `"b"`, exited 0, and printed NOTHING to stderr -- into a ledger that cannot be corrected, since
   * entries are immutable and `recordEntry` refuses a duplicate id.
   *
   * A REFUSAL, not a warning, and the change is deliberate. The warning version said which value
   * won and left the row in place, which is still a row whose contents the caller did not choose:
   * it cannot be distinguished afterwards from one where they meant `b` all along, and the caller
   * this command exists for -- an LLM workflow -- reads stdout and may never look at stderr. This
   * is the same answer asc-4if took for the fold collision one spec over: a conflict resolved by
   * silently picking a winner is refused, not narrated.
   *
   * Grouped by the name AS WRITTEN, which is what the store does too -- measured: `--prop=Chosen=b`
   * against a type declaring `chosen` is dropped as "not a property of decision", not folded onto
   * `chosen`. So the CLI's notion of "the same name" is the store's, and there is no fold-collision
   * to detect on this path.
   *
   * A repeat with the SAME value is deliberately NOT here: nothing is lost, and `--na` already
   * treats a repeat as a set. A refusal that fires when nothing conflicted would reject legitimate
   * work, which is worse than the noise it replaced.
   */
  readonly repeats: readonly { readonly name: string; readonly texts: readonly string[] }[];
}

/** The `--prop` flags as a properties object, plus the names they contradicted themselves about. */
function propertiesFrom(propFlags: readonly string[]): PropertyFlags {
  const properties = Object.create(null) as Record<string, unknown>;
  // A Map, not a null-prototype object: this groups by name and is never serialized, so it does
  // not need the shape rule the `properties` object above is subject to. Insertion order is the
  // order the names were first written, which is the order they should be reported in.
  const groups = new Map<string, PropOccurrence[]>();

  for (const raw of propFlags) {
    const [name, value] = parsePropertyFlag(raw);
    const group = groups.get(name) ?? [];
    group.push({ value, text: raw.slice(raw.indexOf('=') + 1) });
    groups.set(name, group);
    properties[name] = value;
  }

  const repeats = [...groups]
    .filter(([, group]) => {
      const first = group[0];
      return first !== undefined && group.some((occurrence) => !sameValue(occurrence, first));
    })
    .map(([name, group]) => ({ name, texts: group.map((occurrence) => occurrence.text) }));

  return { properties, repeats };
}

/**
 * Refuse a `--prop` given more than once with different values.
 *
 * Every conflicting name is reported in one refusal rather than one per name, so a command line
 * with two of them is fixed in one pass instead of two. Raised before any store work: the conflict
 * is entirely inside the caller's own argv, so there is nothing to open, validate or transact.
 */
function repeatedPropertyError(
  repeats: readonly { readonly name: string; readonly texts: readonly string[] }[],
): Error {
  const conflicts = repeats.map(({ name, texts }) => {
    const values = texts.map((text) => `'${text}'`).join(', ');
    return `--prop=${name} was given ${String(texts.length)} times with different values (${values})`;
  });
  return usageError(
    `${conflicts.join('; ')}. A property has one value, so ascend cannot tell which you meant, and ` +
      `nothing was recorded. Keep one of them -- or, if you meant two different properties, note ` +
      `that a name is matched exactly, so check the spelling.`,
  );
}

/**
 * Refuse a `--prop` whose value came out empty.
 *
 * **The defect, measured.** `--prop=stage=$UNSET_VAR` reaches the store as `""`, which is a real
 * value in SQLite rather than a hole: the row is written, `stage_state` for it computes as
 * `measured`, and the generated view reports a property that was never declared as though someone
 * had recorded the empty string as its value. `--na stage` is how a caller says the property does
 * not apply, and it is one keystroke away -- so the whole failure is a caller intending silence and
 * getting a measurement instead.
 *
 * **Two spellings, one value, and the check is on the VALUE for that reason.** Measured on the real
 * binary: `--prop=stage=` and `--prop=stage=""` both store `{"stage":""}`, because `flagValue` runs
 * `JSON.parse` on the text after the `=` and `JSON.parse('""')` succeeds. A check on the raw text
 * would have caught the first and let the second through with byte-identical stored state. The
 * neighbours are not the defect and are deliberately not caught: `--prop=stage=''` stores the two
 * literal quote characters and `--prop=stage= ` stores a space, and neither is empty.
 *
 * Raised before the store is opened, beside the repeat check, because like that one the whole
 * problem is in the caller's own argv -- and every empty name is reported in one refusal so a
 * command line with two of them is fixed in one pass.
 *
 * **The DOCUMENT path still accepts `{"properties":{"stage":""}}`.** That asymmetry is the
 * decision, not an oversight: `--prop=<name>=` is a spelling that happens by accident -- an unset
 * shell variable, a template with a blank substitution -- while a document is a file someone
 * wrote, where `""` is a value they typed on purpose. The command line is where the accident lives.
 */
function emptyPropertyError(names: readonly string[]): Error {
  const clauses = names.map(
    (name) => `--prop=${name} is empty (record it as not applying with --na ${name} instead)`,
  );
  return refusal(
    `${clauses.join('; ')}. An empty string is a real value in SQLite rather than "unknown", so it ` +
      `would be stored as a measurement of "" rather than as silence, and the generated view would ` +
      `report the property as measured. Omit the property to leave it undeclared.`,
  );
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

  /**
   * `ignoreStdin` on BOTH args, and it is load-bearing rather than hygiene.
   *
   * oclif fills a MISSING positional argument from stdin unless the arg says otherwise
   * (`@oclif/core/lib/parser/parse.js`, `tryStdin`, gated only on `arg.ignoreStdin`), so
   * `cat doc.json | asc record decision` handed the document to `readInput` as a **path** and
   * failed with `ENOENT` naming the document -- or, once the document exceeded `NAME_MAX`, with
   * the whole document echoed into stderr twice. That echo was measured at **2.164x** the
   * document, holding across 40,034 and 100,034 bytes, and `evidence_text` is exactly the field
   * `ARCHITECTURE` routes through stdin. With no operand at all, oclif assigned the document to
   * `type` and advised `asc types show {"name":...}` -- a command that cannot work.
   *
   * The bug was also a RACE, which is why the suite was green: oclif's reader aborts after 10 ms
   * and returns nothing, so a producer slower than that never hit it. Measured with the same
   * `types define`: `printf '%s' "$doc"` piped in used the document as a path, while
   * `( sleep 0.3; printf '%s' "$doc" )` gave `Missing 1 required arg: file`. This fix does not
   * introduce the good behaviour -- it makes the good behaviour the only one.
   *
   * `-` is ascend's stdin path (`input.ts`), so nothing is lost by refusing to guess: the arg
   * keeps its documented meaning and the refusal written for the implicit case -- "nothing to
   * record", below -- is the one that now fires.
   */
  static override args = {
    type: Args.string({
      description: 'The entry type to record. It must be registered in this project.',
      required: true,
      ignoreStdin: true,
    }),
    document: Args.string({
      description:
        'Path to an entry document, or `-` for standard input. A single object records one ' +
        'entry; an array records a batch. Omit it when using --prop/--na/--evidence.',
      required: false,
      ignoreStdin: true,
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

    // Refused by the flag's own name, before the store is opened.
    //
    // Measured: `asc record decision --prop=chosen=a --prop=rationale=b --evidence ''` answered
    // "evidenceText is empty". That message comes from the store's `requireNonEmpty`, which names
    // the field of the RECORD CONTEXT it is handed -- right for a library caller, who passed
    // `evidenceText`, and wrong for someone who typed a flag, who has never seen that identifier.
    // `entry-document.ts` already names the DOCUMENT's field on the document path, so the document
    // path was right and this one was the odd one out: `asc-3u2` item (e).
    //
    // All four text flags are swept together rather than only the one that was measured: they
    // reach the same `requireNonEmpty` through the same `OPTIONAL_TEXT_FIELDS` loop, so fixing
    // `--evidence` alone would have left the other three behind. The exit code stays 1, which is
    // what the store's `TypeError` produced before -- this changes the noun in the sentence, not
    // the outcome.
    //
    // **Two of the four leaked a NAME; the other two leaked only the dashes.** Measured from what
    // the recorder is handed (`record.ts`'s own mapping below): `--evidence` reached the store as
    // `evidenceText` and `--run-id` as `runId`, names no caller has ever seen. `--workflow` and
    // `--actor` reach it as `workflow` and `actor` -- the same words the caller typed, printed
    // without the `--`. Recording the difference because calling all four "the same bug" would be
    // the kind of tidy summary this project's evidence rules exist to prevent.
    for (const [flag, value] of [
      ['--evidence', flags.evidence],
      ['--run-id', flags['run-id']],
      ['--workflow', flags.workflow],
      ['--actor', flags.actor],
    ] as const) {
      if (value === '') {
        throw refusal(
          `${flag} is empty. An empty string is a real value in SQLite rather than "unknown", ` +
            `so omit the flag instead to leave it unset.`,
        );
      }
    }

    const propFlags = propertiesFrom(props);
    // Refused here, before the store is opened and before anything is validated, because the
    // conflict is entirely within the caller's own argv -- no store state can make it resolvable,
    // and no validation error it might also have is the more useful thing to report first. A
    // `--dry-run` reaches this too, and must: previewing a recording that cannot happen is its own
    // false report.
    if (propFlags.repeats.length > 0) throw repeatedPropertyError(propFlags.repeats);

    // The empty check reads the PARSED value rather than the text after the `=`, so it catches
    // `--prop=x=""` as well as `--prop=x=` -- the two spellings store the same `""` (see
    // `emptyPropertyError`). Ordered after the repeat check so a command line with both problems
    // hears about the conflict first: it quotes the two values the caller wrote, which is the only
    // thing that tells them which of their own words they are looking at.
    const emptyNames = Object.entries(propFlags.properties)
      .filter(([, value]) => value === '')
      .map(([name]) => name);
    if (emptyNames.length > 0) throw emptyPropertyError(emptyNames);

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

    await this.withProject(({ store, root }) => {
      const ascendVersion = this.ascendVersion();
      // Project-relative, never absolute (asc-tlc). `project.ts` finds `root` by walking UP
      // from `process.cwd()` -- its own doc says so ("The root is found by walking up") -- and
      // there is no `--store` flag, so `process.cwd()` is always at or under `root` and this
      // can never escape it in practice. `relative` returns `''` when the two paths are equal,
      // and `schema.ts`'s `CHECK (cwd IS NULL OR cwd <> '')` REFUSES that empty string, so the
      // project root itself is written as `'.'` rather than `''` -- a different fact from an
      // absent cwd: `'.'` says "the root", `undefined` still says "not known".
      const relativeCwd = relative(root, process.cwd());
      const cwd =
        relativeCwd === ''
          ? '.'
          : relativeCwd.startsWith('..') || isAbsolute(relativeCwd)
            ? undefined
            : relativeCwd;
      if (cwd === undefined) {
        // Unreachable by construction, per the paragraph above -- but handled rather than
        // assumed, because the alternative failure modes are both worse than a warning: writing
        // the absolute `process.cwd()` here would silently reintroduce the exact leak asc-tlc
        // closes, and writing the (wrong) relative string would be a fabricated value in a
        // column TASKS.md #7 says must omit rather than guess.
        this.warn(
          `cwd (${process.cwd()}) is not under the project root (${root}); omitting cwd from this entry.`,
        );
      }
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

      // The `review_after` advisory (asc-bli.5). Read only when the type declares one, so a type
      // without it pays nothing on the write path; and never on a dry run, which writes nothing
      // and so crosses nothing. An unknown type reads as undefined here and is refused, with its
      // own message, by the first `recordEntry` below.
      const reviewAfter = dryRun ? undefined : findType(store.db, args.type)?.guidance.review_after;
      let countBefore = 0;

      const writeAll = (): RecordRow[] => {
        // Counted inside the transaction, so the "before" this compares against cannot include a
        // concurrent writer's entries and make two processes both claim, or both miss, the crossing.
        if (reviewAfter !== undefined) countBefore = entryCount(store.db, args.type);

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
            ...(cwd === undefined ? {} : { cwd }),
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
            // machine reading stdout alone -- which is the caller this command exists for.
            warnings: result.warnings.map((warning) => `${warning.field}: ${warning.problem}`),
            dry_run: dryRun,
          };
        });

        return rows;
      };

      const rows = dryRun ? withRollback(store.db, writeAll) : withTransaction(store.db, writeAll);

      if (dryRun) this.warn('dry run: nothing was written.');

      // Every document was written or the transaction threw, so the post-write count is
      // arithmetic -- one COUNT on this path, not two. Stderr, like every advisory here
      // (`init.ts`'s offerRecall, `stats.ts`): stdout stays the data a script reads. It reports and
      // never gates -- `stats.ts:51`'s rule, which a threshold nobody measured must not overturn.
      const countAfter = countBefore + rows.length;
      if (reviewAfter !== undefined && reviewAfterCrossed(countBefore, countAfter, reviewAfter)) {
        const name = rows[0]?.type ?? args.type;
        this.warn(
          `${name} now has ${String(countAfter)} entries, reaching the review_after of ` +
            `${String(reviewAfter)} its definition declares -- the point someone said they meant to ` +
            `look at it. 'asc stats ${name}' is one place to start. A note, not a gate; raise ` +
            `review_after to move the point.`,
        );
      }

      this.emit(format, { columns: ['index', 'id', 'type', 'version'], rows });
    });
  }
}
