/**
 * Rendering command results: `--json`, `--table`, `--csv`.
 *
 * **stdout is data; stderr is everything else.** Nothing here writes a log line, a
 * warning or a progress notice to stdout, so `asc query ... | jq` never sees anything
 * but the result. Failures go to stderr and change the exit code (`errors.ts`).
 *
 * **The format never changes because of the environment.** `--json` is what you asked
 * for, `table` is what you get otherwise -- whether stdout is a TTY, a pipe or a file.
 * Defaulting to JSON when piped is a common convenience and it was rejected: it makes
 * the same command produce different bytes on different days, so a human comparing a
 * hand-run to a logged run sees a difference that means nothing, and a script that
 * forgot the flag gets a shape it did not ask for. Decoration follows the terminal
 * (`color.ts`); the SHAPE does not.
 *
 * **The JSON envelope is a contract and is versioned.** `cli-best-practices` rule 9: the
 * human-readable table may change whenever it should, but a script's parse target must
 * not. `ascend_output` carries the contract version, so a consumer can refuse a shape it
 * does not know instead of silently mis-reading one. Rows keep their native JSON types
 * (a number stays a number) -- stringifying them here would make `--json` no better than
 * scraping the table.
 *
 * Compact, not pretty-printed, on purpose: the primary consumer is a model on a token
 * budget (`asc-9y1` measures exactly that), and `jq .` is one keystroke away for a human.
 */

import { MIN_N, type Proportion } from '@ascend/analysis';
import type { EntryState, RecordedEntry } from '@ascend/store';
import { renderTrim, type Trim } from './budget.js';
import { renderAssist, type SearchAssist } from './search-assist.js';

/**
 * The `--json` contract version. Increment only for a breaking shape change.
 *
 * 2 -- `assist` is present on every `asc search`, not only on a zero result. A consumer that read
 * the block's absence as "this search succeeded" is now wrong, and one that read `reason` as always
 * naming a failure is wrong for the new `rows-returned` code. Both are breaking readings of an
 * unchanged-looking field, which is what this number is for.
 */
export const OUTPUT_CONTRACT_VERSION = 2;

export type OutputFormat = 'json' | 'table' | 'csv';

/**
 * How much of the population an output accounts for.
 *
 * WHY THIS EXISTS AT ALL. Handed the first page of a corpus, a reader concludes something about
 * the whole of it: forty reviews out of five hundred and twelve is 7.8%, and a reader that does
 * not know that writes "most reviews show X". The coverage line is the cheapest thing that stops
 * it, and it has to be on the output itself -- an annotation or a side channel is one the reader
 * has to remember to look for.
 *
 * WHY `total` IS REQUIRED AND NEVER ESTIMATED. "Showing 40 of about 512" is a fabricated
 * denominator in the one place a reader is being asked to trust a proportion, so the store counts
 * rather than samples. See the measurement note in `packages/store/src/pages.ts`.
 *
 * WHY EVERY OUTPUT CARRIES ONE, INCLUDING THE COMPLETE ONES. A consumer that has to handle the
 * field's absence will get it wrong somewhere; a consumer that can always read `coverage` and
 * compare `shown` against `total` cannot. The complete case is not a stand-in value -- `shown`
 * and `total` are both the real row count and `has_more` is genuinely false, which is the true
 * statement that this output withheld nothing. `complete()` below is how a command says that.
 */
export interface Coverage {
  /** How many rows this output shows. */
  readonly shown: number;
  /** The size of the population this output is drawn from. */
  readonly total: number;
  /** Whether rows exist beyond the ones shown. */
  readonly has_more: boolean;
  /**
   * `shown / total` as a percentage, ROUNDED to one decimal place, omitted when `total` is zero.
   *
   * Rounded in the value rather than only in the rendering, so that `--json` and the table footer
   * state the same number. Handing a consumer `66.66666666666666` and printing `66.7` beside it is
   * two renderings of one fact that differ, which is the failure this project rejects ratios for
   * elsewhere (`packages/store/src/profile.ts`) -- and the rounding is lossless here because
   * `shown` and `total` are both on the same object, so a consumer that wants the exact ratio can
   * still divide them.
   *
   * Omitted rather than reported as `0` or `100`, because there is no fraction of nothing and
   * either number would be an invention (`TASKS.md` #7). A reader seeing an empty population
   * gets "showing 0 of 0" with no percentage, which is the whole truth about it.
   */
  readonly percent?: number;
}

/**
 * The share, to one decimal place, or `undefined` when there is no population to be a share of.
 *
 * The single owner of both decisions above, so `complete` and `subset` cannot round differently or
 * disagree about what an empty population reports.
 */
function percentOf(shown: number, total: number): number | undefined {
  if (total === 0) return undefined;
  return Math.round((shown / total) * 1000) / 10;
}

function coverageOf(shown: number, total: number, hasMore: boolean): Coverage {
  const percent = percentOf(shown, total);
  return {
    shown,
    total,
    has_more: hasMore,
    ...(percent === undefined ? {} : { percent }),
  };
}

/**
 * The coverage of an output that withheld nothing.
 *
 * A function rather than a constant so the numbers come from the rows actually being emitted --
 * a caller cannot pass a total it did not count. `shown` and `total` are both the real row count
 * and `has_more` is genuinely false, which is the true statement that this output withheld nothing.
 */
export function complete(rows: readonly Row[]): Coverage {
  return coverageOf(rows.length, rows.length, false);
}

/**
 * The coverage of an output that showed part of a larger result.
 *
 * Named for the case rather than for its arguments, because it is the case that needs stating: a
 * command that emits everything it produced says so with `complete`, and a command that pages is
 * the one that owes the reader a denominator. Taking three numbers rather than an `Output` keeps
 * the caller's own type out of the signature -- a page's rows and its total come from the store
 * and are not the same value.
 */
export function subset(shown: number, total: number, hasMore: boolean): Coverage {
  return coverageOf(shown, total, hasMore);
}

/**
 * The coverage line as a person reads it: `showing 40 of 512, 7.8%`.
 *
 * NOT A PROPORTION, and it must not be converted into one. The `%` here is a census of what this
 * command emitted -- `shown` of `total` are both counts in hand, and the whole truth about this
 * output -- not an estimate of a rate in a population. `renderProportion` is for the second thing,
 * and putting a confidence interval on the first would invent an uncertainty that does not exist.
 * See that function for the boundary.
 */
export function renderCoverage(coverage: Coverage): string {
  const of = `showing ${String(coverage.shown)} of ${String(coverage.total)}`;
  return coverage.percent === undefined ? of : `${of}, ${coverage.percent.toFixed(1)}%`;
}

/**
 * A proportion as a person reads it: `60% (95% CI 44-74%, n=25)`.
 *
 * THE QUALIFICATION IS PART OF THE STRING, NOT A SECOND CALL. `ARCHITECTURE.md` requires that a
 * group below `MIN_N` be flagged rather than printed as a seductive percentage, and a flag offered
 * as its own function is one a call site can forget -- which is the failure mode the requirement
 * exists to prevent. So the small-group marker is appended here, from the `smallGroup` field the
 * proportion already carries, and there is no way to render a proportion without it.
 *
 * The marker keeps the spike's wording, including the threshold it was compared against. The
 * interval is still printed for a small group rather than suppressed: the arithmetic is right, and
 * hiding a correct number because it is weakly evidenced is its own dishonesty -- what the reader
 * needs is the number AND the reason not to lean on it.
 *
 * THE SEPARATOR IS AN ASCII HYPHEN, AND THAT IS A DECISION WITH A RECEIPT. `ARCHITECTURE.md`'s
 * example wrote the interval with an en dash (U+2013) between its bounds; the evidence overruled it
 * (asc-bmf decision entry, and `ARCHITECTURE.md` corrected in the same commit). Measured
 * 2026-09-17: of every TypeScript file in this repository's package `src` and `test` trees, **0
 * contain a non-ASCII byte** -- this string would be the first, in a project whose prose uses em
 * dashes freely and whose code does not use one at all. Every string `asc` has ever printed is
 * likewise ASCII, and this one lands in
 * `--table` cells and `--csv` fields, where a non-ASCII byte is a liability for anyone aligning
 * columns or opening the CSV under a non-UTF-8 default. The prescription's meaning -- percentage,
 * then interval, then n -- is unchanged by the character.
 *
 * `null` renders as the spike rendered it, `n=0 (no estimate)`, which is now the rendering of an
 * honest absence rather than a cover for a fabricated zero. See `proportion.ts`, departure 2.
 */
export function renderProportion(proportion: Proportion | null): string {
  if (proportion === null) return 'n=0 (no estimate)';

  // Rounded from the level rather than stored beside it, so the label cannot drift from the
  // arithmetic the way the spike's hardcoded "95% CI" could. `Math.round` handles the binary
  // representation of the three supported levels: 0.95 * 100 is 95.00000000000001, and rounding is
  // what keeps that from rendering as "95.00000000000001%".
  const level = `${String(Math.round(proportion.confidence * 100))}%`;
  const pct = (100 * proportion.p).toFixed(1);
  const low = (100 * proportion.lower).toFixed(1);
  const high = (100 * proportion.upper).toFixed(1);
  const line = `${pct}% (${level} CI ${low}-${high}%, n=${String(proportion.n)})`;

  return proportion.smallGroup
    ? `${line}  [SMALL GROUP n=${String(proportion.n)} < ${String(MIN_N)} -- treat as anecdote, not estimate]`
    : line;
}

/** One result row. Keys are the column names, in the order the command chose. */
export type Row = Readonly<Record<string, unknown>>;

/**
 * One recorded entry, as a result row -- the projection `--page`, `--sample` and `--dump` all emit.
 *
 * **One owner, because `--dump` writes these rows as LINES OF A FILE and `--page` renders them as a
 * table.** If the two projections were written separately they could differ, and the difference
 * would be invisible from either side: an agent that dumped a corpus and then paged the same type
 * would see two shapes for the same entry and no reason to prefer one. JSON Lines has no envelope
 * to absorb the drift, so the second copy would simply be a different record format.
 *
 * The envelope columns are flat and the properties are NOT spread in beside them, deliberately:
 * property names are chosen by whoever defined the type, so a property called `id` would otherwise
 * silently overwrite the entry's own id -- the collision `asc-865.1` records for the generated
 * views. Keeping `properties` as one key makes that impossible.
 *
 * `evidence_text` is omitted when the entry has none rather than rendered as an empty string, for
 * the same reason every other absent value in this CLI is (`TASKS.md` #7): an empty evidence field
 * and a missing one are different facts.
 */
export function entryRow(entry: RecordedEntry): Row {
  return {
    id: entry.id,
    recorded_at: entry.recordedAt,
    type_version: entry.typeVersion,
    properties: entry.properties,
    ...(entry.evidenceText === null ? {} : { evidence_text: entry.evidenceText }),
  };
}

/**
 * A result, ready for any of the three renderers.
 *
 * One shape rather than three, so a command cannot report its JSON and its table from
 * two independently-built values that disagree -- the failure mode where `--json` and
 * `--table` give different answers to the same question.
 */
export interface Output {
  /**
   * The projection for `--table` and `--csv`: which fields to show, in order.
   *
   * It does NOT filter the JSON. A row may carry fields a command does not want in a
   * terminal table -- a full `type_hash`, a paragraph of prose -- and those are exactly
   * the fields a script wants. So `columns` is a view of the rows, not a definition of
   * them, and `--json` reports the rows as they are.
   */
  readonly columns: readonly string[];
  readonly rows: readonly Row[];
  /**
   * How much of the population these rows account for.
   *
   * **Omitted means complete over the rows present**, which is the right answer for every command
   * that emits everything it produced -- and the normalizer below supplies it, so a command only
   * writes this field when it is reporting a SUBSET. That is the one case where the value cannot
   * be inferred, and therefore the one case worth making a command state explicitly.
   */
  readonly coverage?: Coverage;

  /**
   * Where to resume, for an output that showed part of a larger result. Absent otherwise.
   *
   * Absence here is not a stand-in value and does not need the `complete()` treatment: a command
   * that never pages has no next page, and "there is no cursor" and "this command does not do
   * cursors" lead a caller to the same action. `--json` omits the key entirely rather than
   * reporting `null`, so `json_type(...) IS NULL` and a missing key are the same read.
   */
  readonly next_cursor?: string;

  /**
   * How the rows were chosen, for an output that is a SAMPLE rather than a page or a whole answer.
   *
   * A third member of the same family as `coverage` and `next_cursor`, under the same rule: absent
   * means "this output is not a sample", which every command that does not sample says by saying
   * nothing. `coverage` still applies and still states the share -- what only this block can state
   * is WHICH rows, and therefore whether they are the rows the caller meant.
   */
  readonly sample?: SampleReport;

  /**
   * What a token budget cost, for an output that was fitted to one.
   *
   * The fourth member of the family `coverage`, `next_cursor` and `sample` belong to, under the same
   * rule: absent means "no budget was applied", which every command that does not budget says by
   * saying nothing. It is present whenever `--max-tokens` was passed, `dropped: 0` included, because
   * the absence of this block is how a consumer tells those two cases apart.
   */
  readonly trim?: Trim;

  /**
   * What a search has to say beyond its rows.
   *
   * The fifth member of the family `coverage`, `next_cursor`, `sample` and `trim` belong to, and the
   * one that left it: absent means "this output is not a search", which every command but `asc
   * search` says by saying nothing. It is present on every search -- empty `values` included, and
   * rows included -- because a consumer needs to tell "searched and found nothing" from "did not
   * search", and the `rows-returned` case needs the block for a reason of its own: to say where the
   * query's terms occur that the rows do not cover.
   */
  readonly assist?: SearchAssist;
}

/**
 * An `Output` with its coverage settled.
 *
 * The defaulting lives here, once, rather than as a `coverage: complete(rows)` line in each of the
 * thirteen commands that emit. Those lines would all say the same thing, and four of the commands
 * build their rows as an inline array literal -- so stating it per command would have meant
 * restructuring four of them to name an array purely to hand it to a function that already has it.
 * One rule in one place is also the version that cannot drift: a command that pages supplies its
 * own coverage, and nothing else can accidentally report the wrong one.
 */
function withCoverage(output: Output): Output & { readonly coverage: Coverage } {
  return { ...output, coverage: output.coverage ?? complete(output.rows) };
}

/**
 * One stratum's share of the population and of the sample.
 *
 * `state` is always present and `value` only when there is one, which is the same rule the rest of
 * this CLI applies to absent values (`TASKS.md` #7): a measured value reports its value, and the two
 * absent states report which absence they are. Rendering a stratum whose state is `not_measured` as
 * `value: null` would put a fabricated value in the one place a reader is being asked to trust a
 * proportion over it.
 */
export interface SampleStratum {
  readonly state: EntryState;
  /** The measured value. Omitted in either absent state, where there is no value to report. */
  readonly value?: string;
  readonly population: number;
  readonly selected: number;
}

/**
 * What a sample chose from, and how it chose.
 *
 * WHY THIS IS ON THE OUTPUT AND NOT IN A LOG LINE. A sample is the one thing this CLI emits whose
 * MEMBERSHIP is a function of a parameter the reader cannot see. `--limit` says how many; nothing
 * else says which, so without this block a reader has no way to reproduce a selection or to notice
 * that it was not the one they meant. It carries the mode, the property chosen, the seed when the
 * mode used one, and the achieved per-stratum counts -- so "stratified preserved the proportions" is
 * a fact the output states rather than a claim the documentation makes.
 */
export interface SampleReport {
  readonly mode: string;
  /** The property sampled by. Omitted when the mode does not take one. */
  readonly by?: string;
  /**
   * The seed the selection was derived from. Omitted for the modes that are not draws.
   *
   * Reported rather than assumed to be the default: a caller who did not pass `--seed` still needs
   * to know what it was in order to reproduce this exact output, and one who did needs to see that
   * it took effect.
   */
  readonly seed?: string;
  /** The achieved distribution. Empty when the mode was given no property to report on. */
  readonly strata: readonly SampleStratum[];
}

/**
 * A sample, as a block: one line naming the choice, then one line per stratum. Not a format -- the
 * structured fields on the same output are.
 *
 * **One line per stratum, rather than one long line**, and that is a layout decision with a reason.
 * Every stratum has to be named, including the ones the sample took none of -- a stratum at zero is
 * the finding, since it is exactly what stratified sampling exists to prevent, and a rendering that
 * dropped it would hide the case worth looking at. But ten strata of a real corpus render to four
 * hundred characters, which `renderTable` would either elide (hiding strata) or wrap (unreadably).
 * A column of numbers is what a person comparing two of these actually wants, and it costs nothing
 * in the JSON.
 */
export function renderSample(sample: SampleReport): string {
  const parts = [sample.mode];
  if (sample.by !== undefined) parts.push(`by ${sample.by}`);
  // JSON-quoted so a seed with a space or a quote in it reads as one token rather than as more
  // prose -- the seed is an operand a caller retypes, and it has to survive the round trip.
  if (sample.seed !== undefined) parts.push(`seed ${JSON.stringify(sample.seed)}`);
  if (sample.strata.length === 0) return parts.join(', ');

  const missed = sample.strata.filter((stratum) => stratum.selected === 0).length;
  const lines = [
    `${parts.join(', ')}: ${String(sample.strata.length)} strata, ${String(missed)} unsampled`,
    ...sample.strata.map(
      (stratum) =>
        `  ${stratum.value ?? stratum.state}  ${String(stratum.selected)} of ${String(stratum.population)}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * The versioned `--json` envelope. Every field name here is part of the contract.
 *
 * There is deliberately no `command` field naming which command produced this. It was
 * written, then removed: oclif's command id is optional on a directly-constructed
 * command, so the field would have needed a fallback -- and a provenance field that is
 * sometimes a stand-in is worse than no provenance field, because a consumer cannot tell
 * the two apart. A consumer knows which command it ran. Adding this back means giving it
 * a value that is never guessed.
 */
export interface JsonEnvelope {
  readonly ascend_output: number;
  readonly rows: readonly Row[];
  /**
   * `rows.length`, stated rather than left to be recomputed. It is what distinguishes
   * "the query matched nothing" from "the output was truncated", which is the difference
   * between a real zero and a partial answer.
   */
  readonly row_count: number;
  /**
   * How much of the population `rows` accounts for.
   *
   * Additive at `ascend_output` 1: a consumer that predates this key reads `rows` and
   * `row_count` unchanged, and one that knows the key can tell a page from a whole answer --
   * which is the difference the whole field exists to make legible.
   */
  readonly coverage: Coverage;
  /**
   * Where to resume, present only when the output showed part of a larger result.
   *
   * Part of the contract rather than a note on stderr: a cursor IS data -- it is the operand of
   * the next command -- and stdout is where data goes (`cli-best-practices` rule 1).
   */
  readonly next_cursor?: string;
  /**
   * How the rows were chosen, when they were sampled.
   *
   * Additive at `ascend_output` 1, like `coverage` and `next_cursor` before it: a consumer that
   * predates the key reads `rows`, `row_count` and `coverage` unchanged, and one that knows it can
   * reproduce the selection from `seed` instead of taking the membership on faith.
   */
  readonly sample?: SampleReport;
  /**
   * What a token budget cost, when one was applied.
   *
   * Additive at `ascend_output` 1, like the three before it. It is on the envelope and not only in
   * the table footer because this block is what makes a trimmed output distinguishable from a
   * complete one to a script -- and a script is the consumer most likely to be handed one, since
   * `--max-tokens` exists to feed a model.
   */
  readonly trim?: Trim;
  /** Mirrors `Output.assist`. Present on every search; `reason` says which case it is. */
  readonly assist?: SearchAssist;
}

export function renderJson(output: Output): string {
  const settled = withCoverage(output);
  const envelope: JsonEnvelope = {
    ascend_output: OUTPUT_CONTRACT_VERSION,
    rows: settled.rows,
    row_count: settled.rows.length,
    coverage: settled.coverage,
    ...(settled.next_cursor === undefined ? {} : { next_cursor: settled.next_cursor }),
    ...(settled.sample === undefined ? {} : { sample: settled.sample }),
    ...(settled.trim === undefined ? {} : { trim: settled.trim }),
    ...(settled.assist === undefined ? {} : { assist: settled.assist }),
  };
  return JSON.stringify(envelope);
}

/**
 * Longest cell the table renderer will show before eliding.
 *
 * A table's job is to be scannable, and one `evidence_text` column would otherwise set
 * the width of every row and push the columns that matter off the screen. The elision is
 * marked with `…` rather than silently cut, so what you see is never a plausible-looking
 * value that is actually a prefix. The full value is in `--json` and `--csv`, which do
 * not truncate.
 */
const MAX_CELL_WIDTH = 60;

/** The first half of a surrogate pair -- the only way to write a character above U+FFFF. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The second half. A high surrogate that is not followed by one of these is unpaired. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Where to stop a cell, given the last UTF-16 unit index its budget allows.
 *
 * `slice` counts UTF-16 code units, and a character above U+FFFF -- an emoji, a CJK
 * extension-B ideograph -- occupies two of them. A cut between the two halves leaves a
 * string no encoder can represent: every UTF-8 encoder, `Buffer.from` included, writes
 * U+FFFD in its place. Measured on the real CLI rather than on the renderer alone, because
 * a lone surrogate is only a defect once it reaches the wire: `asc query` on a value with
 * one emoji at unit 58 printed `aaaa�…`, and the same value one unit shorter printed
 * the emoji intact.
 *
 * Backing off one unit is exact rather than a heuristic. The only unpaired surrogate a cut
 * can create is the last unit it keeps, and that unit is unpaired exactly when the next
 * unit is its other half -- so that test is the whole rule.
 *
 * A value that ALREADY held an unpaired surrogate passes through unchanged, deliberately:
 * it is malformed in the store, where `--json` escapes it and `--csv` carries it verbatim,
 * and the table is not the layer that should be hiding that. The claim here is the narrow
 * one a truncation can actually be blamed for -- this never CREATES one.
 *
 * The clamp is part of the same rule rather than defensive noise. `maxCellWidth` below 1
 * makes the budget negative, and a negative index is a slice from the END: `slice(0, -1)`
 * drops the last unit, which creates a lone surrogate whenever that unit was a low half.
 * No caller passes such a width today; the arithmetic should not depend on that.
 */
function lastUnitToKeep(text: string, budget: number): number {
  const end = Math.max(0, budget);
  if (
    end >= 1 &&
    end < text.length &&
    isHighSurrogate(text.charCodeAt(end - 1)) &&
    isLowSurrogate(text.charCodeAt(end))
  ) {
    return end - 1;
  }
  return end;
}

/** What a value looks like in a table or a CSV cell. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  // Objects and arrays have no single-cell rendering of their own. JSON is the honest
  // one, and it round-trips: a reader can paste a cell back into `jq`.
  return JSON.stringify(value);
}

export function renderTable(output: Output, maxCellWidth = MAX_CELL_WIDTH): string {
  if (output.columns.length === 0) return '';

  const coverage = withCoverage(output).coverage;

  const rows = output.rows.map((row) =>
    output.columns.map((column) => {
      // Newlines and tabs would break the grid, so a table flattens whitespace runs.
      // CSV and JSON keep the value verbatim -- the table is the lossy view, and it is
      // the one a human reads with the other two available beside it.
      const text = cellText(row[column]).replace(/\s+/g, ' ').trim();
      if (text.length <= maxCellWidth) return text;
      return `${text.slice(0, lastUnitToKeep(text, maxCellWidth - 1))}…`;
    }),
  );

  // Folded rather than spread, and that is a measured fix rather than a preference.
  //
  // `Math.max(column.length, ...rows.map(...))` passes every row's cell width as an ARGUMENT, so
  // the call dies once there are enough rows: `asc query` on a recursive CTE failed with
  // `Maximum call stack size exceeded` at ~120,000 rows, and an independent probe puts V8's
  // argument limit at ~124,179 -- two numbers close enough to name the cause rather than guess it.
  // Nothing below that limit ever noticed, because no command before `asc query` could return an
  // unbounded number of rows. `--json` was unaffected throughout, which is what a limit in the
  // TABLE renderer and not in the data looks like from outside.
  const widths = output.columns.map((column, index) =>
    rows.reduce((widest, row) => Math.max(widest, row[index]?.length ?? 0), column.length),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  const body = [
    line([...output.columns]),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map((row) => line(row)),
  ];

  // The footer appears only when the output is a SUBSET. On a complete output "showing 3 of 3,
  // 100%" is noise on every command in the CLI, and the table is explicitly the lossy view --
  // the JSON envelope carries `coverage` on every output regardless, so nothing is concealed
  // by leaving it out here. On a page it is the opposite: it is the one line that stops a
  // reader concluding something about five hundred rows from forty of them.
  if (coverage.has_more || coverage.shown < coverage.total) {
    body.push('', renderCoverage(coverage));
    // The cursor goes on stdout beside the coverage line, as a SECOND line rather than appended
    // to the first. It is data -- the operand of the next command -- and stdout is where data
    // goes (`cli-best-practices` rule 1); stderr would put it out of reach of a pipe, and a
    // caller that has to tee stderr to resume is a caller that will not.
    //
    // It is rendered verbatim, unwrapped and untruncated. `renderTable` elides cells past
    // `MAX_CELL_WIDTH` because a table cell is a display of a value that exists elsewhere; this
    // line IS the value, and a cursor with an ellipsis in it is a cursor that cannot be pasted
    // back. It is also base64url-free (`encodeURIComponent` of canonical JSON), so it carries no
    // whitespace that a table's own flattening would disturb.
    if (output.next_cursor !== undefined) body.push(output.next_cursor);
  }

  // The sample line sits OUTSIDE that condition, and the difference is the point: a sample is a
  // subset of the population and can be a very small one, but it is never a COMPLETE output, so
  // `coverage.shown < coverage.total` is true for every sample that is not the whole corpus. The
  // exception -- `--limit` at or above the population, where the sample is everything -- is the
  // one case where the reader is looking at all of it and a line about how it was chosen is
  // still worth having, because it is the line that says the mode had nothing to choose between.
  if (output.sample !== undefined) {
    if (body[body.length - 1] !== '') body.push('');
    body.push(renderSample(output.sample));
  }

  // The trim line is last, and it is unconditional for the same reason the sample line is: a fitted
  // output can be a COMPLETE one -- a map whose property rows all fit -- and a reader still needs to
  // know a budget was in play, because that is what makes `dropped: 0` a measurement rather than an
  // absence. Putting it after the coverage line also makes the two read as a unit: "showing 12 of
  // 486" and "dropped 28 rows to fit 2000 tokens" are the same fact from two directions, and a
  // reader who reads only the second still learns that rows went missing.
  if (output.trim !== undefined) {
    if (body[body.length - 1] !== '') body.push('');
    body.push(renderTrim(output.trim));
  }

  // The assist is last, and on stdout rather than stderr for the reason the cursor line is: it is
  // part of the answer, not a note about it. A caller that pipes `asc search` somewhere and reads
  // the empty table has been told the search failed and told nothing about why -- and the why is
  // the half that decides what they do next. A zero-result search is the one output in this CLI
  // whose most useful content is an explanation, so it travels with the answer.
  if (output.assist !== undefined) {
    if (body[body.length - 1] !== '') body.push('');
    body.push(renderAssist(output.assist));
  }

  return body.join('\n');
}

/**
 * CSV carries NO coverage footer, at any size, and that is deliberate rather than an omission.
 * The table is read by a person and can afford a trailing line; CSV is parsed, and a footer after
 * the last record is a row with the wrong number of fields in it. The `--json` envelope is where
 * a script reads `coverage`, and `--csv` is not the format a consumer asks for a proportion in.
 *
 * Quote a CSV field per RFC 4180 when it needs it.
 *
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on repo-wide, but this
 * function is deliberately regex-and-string only: a CSV writer with a state machine is
 * how a quoting bug gets in.
 */
function csvField(value: unknown): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Line terminator: `\n`, not the RFC's `\r\n`.
 *
 * A deliberate deviation. Every consumer of this output is a Unix pipeline, and a `\r`
 * riding along at the end of the last field is a far more common cause of a wrong parse
 * (a value that compares unequal to itself, a filename that does not resolve) than a
 * non-conforming terminator is of a rejected file.
 */
export function renderCsv(output: Output): string {
  const head = output.columns.map(csvField).join(',');
  const body = output.rows.map((row) =>
    output.columns.map((column) => csvField(row[column])).join(','),
  );
  return [head, ...body].join('\n');
}

export function render(format: OutputFormat, output: Output): string {
  switch (format) {
    case 'json':
      return renderJson(output);
    case 'csv':
      return renderCsv(output);
    case 'table':
      return renderTable(output);
  }
}
