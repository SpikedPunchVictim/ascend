/**
 * `--max-tokens` -- fitting an output to a context budget, and saying what it cost.
 *
 * **WHY A BUDGET AND NOT A ROW COUNT.** `--limit` answers "how many rows", which is the right
 * question when a person is reading and the wrong one when a model is. A model's constraint is its
 * context window, in tokens, and the number of rows that fits in it depends on the rows: forty
 * entries of a type whose `evidence_text` is one sentence and forty whose `evidence_text` is a
 * paragraph are 2,000 tokens apart. So the interface here is the budget, and the row count becomes
 * an output of the fit rather than an input to it. Two limits on that promise are measured and
 * stated below rather than implied: the estimate is a ceiling for the content ascend produces, and
 * it is optimistic for content written in CJK, Korean, Japanese or emoji.
 *
 * **THE RATIO IS MEASURED, AND THE FOLKLORE FIGURE IS WRONG HERE.** The common heuristic is four
 * characters per token. That number comes from English prose, and it does not survive contact with
 * this CLI's output, which is JSON, hex ids, ISO timestamps and bare identifiers -- symbol-dense
 * text that tokenises far worse than prose. Measured by tokenising real output of the frozen
 * EV-11 corpus with three real tokenizers (tiktoken `cl100k_base`, `o200k_base`, and
 * `@anthropic-ai/tokenizer`):
 *
 * | output | code points | worst code points/token |
 * |---|---|---|
 * | `--page --limit 40 --csv` | 14,607 | **2.18** |
 * | `--page --limit 40 --table` | 7,123 | 2.30 |
 * | `--page --limit 40 --json` | 15,998 | 2.35 |
 * | `--sample ... --json` | 15,711 | 2.32 |
 * | `--json` (the map) | 5,877 | 2.78 |
 * | `--table` (the map) | 1,759 | 4.11 |
 *
 * Only the smallest, most label-heavy output -- the map as a table -- approaches 4. On the output
 * a caller is most likely to budget, the true ratio is nearer 2.2. An estimator using 4.0 would
 * under-count by up to **1.8x**: an output advertised as fitting 1,000 tokens would arrive at
 * about 1,800, which is the failure this flag exists to prevent. `CHARS_PER_TOKEN` is therefore 2,
 * calibrated on real ascend output.
 *
 * **THE COST OF THAT CHOICE IS STATED RATHER THAN HIDDEN.** At the observed worst case the
 * estimate is 9% high, and at the observed mean (2.77) it is 28% high -- so a caller asking for
 * 10,000 tokens gets roughly 7,200 tokens of output. That is the safe direction: a context window
 * that overflows truncates the model's input, and a context window that is under-filled costs
 * nothing but room. The ratio travels on every report as `chars_per_token`, so a caller who
 * measures their own corpus can see exactly what assumption produced the number.
 *
 * **AND IT IS NOT A CEILING FOR EVERY CORPUS, WHICH THE FIRST VERSION OF THIS FILE CLAIMED IT WAS.**
 * That claim read "chosen to sit BELOW every ratio measured, so the estimate is an over-estimate by
 * construction". It was true of the six ascend outputs above and false of the corpus those outputs
 * are made FROM: ascend stores LLM-written `evidence_text`, and that text is not necessarily Latin.
 * Measured on bare content -- no envelope, since the envelope's JSON punctuation tokenises well and
 * would flatter the result -- with the same three tokenizers:
 *
 * | content | worst code points/token | at `CHARS_PER_TOKEN = 2` |
 * |---|---|---|
 * | English prose | 5.77 | over-estimated |
 * | base64 / hex | 1.23 - 1.49 | **under-estimated** |
 * | Cyrillic | 1.63 | **under-estimated** |
 * | Arabic | 1.10 | **under-estimated** |
 * | Japanese | 0.96 | **under-estimated ~2x** |
 * | Korean | 0.90 | **under-estimated ~2.2x** |
 * | CJK | 0.79 | **under-estimated ~2.5x** |
 * | emoji | 0.33 | **under-estimated ~6x** |
 *
 * So there is no single ratio that is a hard ceiling for arbitrary Unicode, and no cheap way to
 * derive one: a model that charges ASCII at the measured prose rate fails on base64, and one that
 * charges non-ASCII per code point fails on emoji, which cost about three tokens each. The default
 * is calibrated for the content ascend produces and the content this user's store holds; a caller
 * whose store is full of CJK or emoji is outside what that calibration covers, and the honest
 * statement of that is here rather than in a footnote. The fix is a caller-settable ratio, which is
 * `asc-52u`'s documented follow-up rather than something to guess at now -- and `chars_per_token`
 * on every report is what makes the assumption visible in the meantime.
 *
 * **ONE TOKEN PER TWO CODE POINTS, NOT PER TWO UTF-16 UNITS, AND THE MEASUREMENT ABOVE IS WHY.**
 * The ratio is defined against code points because that is the unit the six-output measurement used,
 * so counting a different unit would silently change the number the constant means. (`length` would
 * count an emoji as two units, which for a budget is arguably the safer direction, since an emoji
 * costs about three tokens -- but "arguably safer" is not the same as "the unit this ratio was
 * measured in", and mixing the two is how a constant quietly stops meaning what its table says.)
 *
 * **THE REPORT STATES THE SIZE OF THE OUTPUT THAT CONTAINS IT**, which is a fixed point: adding
 * the report's own characters changes the number it reports. It converges, and `settle` is why --
 * only the digit count of one integer can move between iterations, so the sequence stabilises
 * within two steps for any realistic budget. `settle` is the only constructor of a `Trim`, and the
 * invariant it establishes -- `estimated_tokens` equals the estimate of the text that was actually
 * emitted -- is asserted in the shipped code rather than only in a test.
 */

/** Code points per token, below the smallest ratio measured for ascend's own output. */
export const CHARS_PER_TOKEN = 2;

/**
 * How many dropped rows are named rather than only counted.
 *
 * **A CAP WITH A REASON, AND IT IS NOT ABOUT TIDINESS.** When a fit drops two property rows, the
 * useful report names them -- "it dropped `verdict` and `project`" is actionable, and "it dropped 2"
 * is a number a reader has to go and resolve. When it drops forty entries, naming them costs the
 * budget the fit just saved: eight ids are ~250 characters, a tenth of a small budget, spent on a
 * list whose actionable form is the cursor that resumes the page. So the count is always exact and
 * the names appear only when they are cheap. `dropped_keys.length < dropped` is the signal that
 * names were withheld, and it is visible arithmetic rather than a hidden rule.
 */
export const MAX_NAMED_DROPS = 8;

/**
 * The fit, as the output reports it.
 *
 * `chars_per_token` is on the report rather than only in this comment because the estimate is an
 * assumption, and an assumption a consumer cannot see is one they cannot correct. A caller who has
 * measured their own corpus at, say, 3.1 code points per token can divide `estimated_tokens` by this
 * and multiply by that to recover the number they trust.
 */
export interface Trim {
  /** The budget the caller set, echoed so a report is readable on its own. */
  readonly max_tokens: number;
  /** The estimate for the output as emitted -- this report included. */
  readonly estimated_tokens: number;
  /** How many rows were removed to fit. Exact, always. */
  readonly dropped: number;
  /** The ratio the estimate used, so the assumption is auditable. */
  readonly chars_per_token: number;
  /**
   * Which rows were dropped, in order, when there were few enough to be worth naming.
   *
   * Absent when nothing was dropped, and absent when more than `MAX_NAMED_DROPS` were -- see that
   * constant. Also absent for a fit that is not a suffix (a sample is re-drawn smaller rather than
   * truncated, so its dropped rows were never a prefix of anything), where the achieved-stratum
   * report already states what the smaller draw contained.
   */
  readonly dropped_keys?: readonly string[];
}

/** The first half of a surrogate pair -- the only encoding of a character above U+FFFF. */
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

/** The second half. A high surrogate not followed by one of these is unpaired. */
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Code points in `text`.
 *
 * A manual scan rather than `[...text].length`: the spread allocates an array the size of the input,
 * and this runs on every candidate of a binary search over outputs that can be megabytes.
 *
 * **A pair counts once, and a LONE low surrogate also counts once.** The obvious cheaper rule --
 * count every UTF-16 unit that is not a low surrogate -- gets the first case right and the second
 * wrong: an unpaired low surrogate would count as zero characters. That is the unsafe direction for
 * a budget, since under-counting characters under-counts tokens and the estimate stops being a
 * ceiling. An unpaired half is reachable without any malformed input on the caller's part, because
 * `renderTable` can cut a cell between the halves of a pair (`output.ts` documents the fix), so the
 * rule here is the exact one: advance two units over a valid pair, one otherwise. Measured against
 * `[...text].length` in the suite for every shape, including both halves unpaired.
 */
export function countCodePoints(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    // `charCodeAt` past the end is `NaN`, and both predicates are false of it -- so a high surrogate
    // in the last position advances by one rather than reading a second unit that is not there.
    index += isHighSurrogate(unit) && isLowSurrogate(next) ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * The estimated token count for `text`.
 *
 * Rounded UP, because a budget is a ceiling: an output of one character over the ratio is one token
 * as far as a context window is concerned, and truncating the remainder would let a long tail of
 * partial tokens accumulate under the limit.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(countCodePoints(text) / CHARS_PER_TOKEN);
}

/** What to fit. `T` is whatever the command builds -- a page, a sample, a list of map rows. */
export interface BudgetRequest<T> {
  /** The caller's budget, in estimated tokens. */
  readonly maxTokens: number;
  /** The untrimmed ask: the page limit, the sample size, or the row count. */
  readonly requested: number;
  /** Rows that are never dropped. Below this the output is not the thing that was asked for. */
  readonly floor: number;
  /**
   * Build the output for `keep` rows.
   *
   * Called repeatedly with decreasing values, so it must be a pure function of `keep` and must not
   * mutate shared state. For a page it re-queries the store, which is deliberate: see the note on
   * cursors in `fitToBudget`.
   */
  readonly build: (keep: number) => T;
  /** How many rows a built value holds. Used to tell "the page ran out" from "the page was cut". */
  readonly rowsOf: (built: T) => number;
  /** Render a built value, with the fit's report when there was one. */
  readonly render: (built: T, trim: Trim | undefined) => string;
  /**
   * The identifying column of a built value's rows, in order. Supplied for fits that trim a SUFFIX.
   *
   * Omitted by a fit that re-draws, because there the kept rows are not a prefix of the full ones
   * and slicing this array would name the wrong rows.
   */
  readonly keysOf?: (built: T) => readonly string[];
  /** What a row is called in a refusal, singular and plural. */
  readonly noun: readonly [string, string];
}

/** The outcome of a fit: what to emit, and the report that goes with it. */
export interface Fitted<T> {
  readonly value: T;
  /**
   * Present whenever a budget was applied -- `dropped: 0` included.
   *
   * Not omitted when nothing was dropped, because its absence would be ambiguous between "the
   * budget was honoured in full" and "no budget was in play", and a caller reading an output has no
   * other way to tell. A zero that is a real measurement is not the fabricated zero `TASKS.md` #7
   * forbids.
   */
  readonly trim: Trim;
  /**
   * The exact bytes to write, rendered once at the moment they were measured.
   *
   * **Returned rather than left to the caller to re-render**, and this is the difference between a
   * guarantee and a coincidence. The fit's claim is "this output is within budget"; if the caller
   * renders again and anything about the render is not a pure function of its arguments -- a clock,
   * a counter, a `Map` iteration order -- then what is written is not what was measured, and the
   * claim becomes false in exactly the silent way this project treats as severity-zero. Handing back
   * the measured text makes writing it the only option.
   */
  readonly text: string;
}

/** What a fit does when it cannot reach the floor. Thrown by `fitToBudget`, caught by the command. */
export class BudgetFloorError extends Error {
  public constructor(
    message: string,
    /** The estimated size of the smallest legal output, so a message can name the fix. */
    readonly minimumTokens: number,
  ) {
    super(message);
    this.name = 'BudgetFloorError';
  }
}

/**
 * The fit, built so that the number it reports is the size of the text it is printed in.
 *
 * **The fixed point, and why two passes are enough.** `estimated_tokens` has to describe an output
 * that contains `estimated_tokens`. Starting from the size of the output WITHOUT the report and
 * re-measuring with it in place moves the total by at most a few characters -- the only thing that
 * can change between passes is the digit count of one integer, since the report's other fields
 * (`dropped`, `max_tokens`, the keys) are already fixed. So the iteration is monotone in a bounded
 * range and settles immediately; the loop is bounded at four passes anyway, and the last pass's
 * value is what the test asserts equals the emitted text.
 */
function settle<T>(
  request: BudgetRequest<T>,
  built: T,
  dropped: number,
  keys?: readonly string[],
): {
  readonly trim: Trim;
  readonly text: string;
} {
  const base: Omit<Trim, 'estimated_tokens'> = {
    max_tokens: request.maxTokens,
    dropped,
    chars_per_token: CHARS_PER_TOKEN,
    ...(keys === undefined ? {} : { dropped_keys: keys }),
  };

  // Pass 0: measure the output with a report of the right shape but a placeholder count, so the
  // first estimate is already within a few characters of the answer.
  let guess = estimateTokens(request.render(built, { ...base, estimated_tokens: 0 }));
  let text = request.render(built, { ...base, estimated_tokens: guess });

  for (let pass = 0; pass < 4; pass += 1) {
    const next = estimateTokens(text);
    if (next === guess) break;
    guess = next;
    text = request.render(built, { ...base, estimated_tokens: guess });
  }

  // The invariant this function exists to establish, checked rather than assumed. Everything
  // downstream compares `trim.estimated_tokens` against the budget and treats that comparison as the
  // claim "this output fits"; if the number were not the size of `text`, the claim would be about a
  // string nobody emitted. Measured the hard way -- an earlier version of this file searched on the
  // render WITHOUT the report and then added the report, and `--max-tokens 400` emitted an output
  // reporting `estimated_tokens: 401`. That is a false green, and it is the reason this is an
  // assertion in the shipped code rather than a line in a test.
  if (estimateTokens(text) !== guess) {
    throw new Error(
      `budget: the report says ${String(guess)} tokens for an output that measures ` +
        `${String(estimateTokens(text))}, so the fixed point did not settle`,
    );
  }

  return { trim: { ...base, estimated_tokens: guess }, text };
}

/**
 * Fit the output to the budget, dropping rows from the end until it fits, and report the cost.
 *
 * **ROWS ARE DROPPED FROM THE END, AND THAT IS A CHOICE WITH A REASON.** A suffix is the only
 * truncation whose loss is describable in one number, and it composes with the orderings the rest of
 * this CLI already commits to: a page is ordered by `(recorded_at, id)`, so its suffix is "the most
 * recent entries, which the cursor resumes", and the map's rows are ordered so that the header facts
 * come first and the property rows -- the ones a reader can most cheaply re-ask for -- come last.
 *
 * **A TRIMMED PAGE RE-QUERIES RATHER THAN SLICING, AND THIS IS THE PART THAT COULD GO WRONG
 * QUIETLY.** Slicing forty rows to twelve and printing the page's original cursor would tell the
 * caller to resume at row forty-one, so rows thirteen to forty would never be shown by anybody --
 * a silent hole in the middle of a corpus, in the one feature whose whole contract is "I will tell
 * you what I did not show you" (`asc-wsa`). `build` is called with the smaller limit instead, so the
 * store computes the cursor for the boundary that is actually being shown. That costs one query per
 * search step and it is the only correct construction.
 *
 * **Monotonicity is assumed by the binary search and verified at the end.** Text grows with rows, so
 * "does `keep` fit" is false above some threshold -- the search relies on that to be a search at
 * all. The verification is not paranoia about arithmetic: for a page the rendered length includes
 * the cursor, whose payload is one row's `(recorded_at, id)`, and a corpus where those differ in
 * length between rows makes the function wobble by a character or two. Rather than trust the
 * assumption to be exact, the chosen `keep` is re-checked and the fit fails loudly if it does not
 * fit -- a fit that returned an over-budget output while reporting that it fit is the
 * "reports success wrongly" class this project treats as severity-zero.
 */
export function fitToBudget<T>(request: BudgetRequest<T>): Fitted<T> {
  const full = request.build(request.requested);
  const total = request.rowsOf(full);

  // Every candidate is measured as the output it would actually produce, REPORT INCLUDED, and this
  // is the whole correctness argument for the fit. The report is part of what lands in a context
  // window, so a search that measured the rows alone and then appended a report would return an
  // output over budget while reporting that it fit. `settle` is what makes the comparison exact: the
  // number it hands back IS the size of the text it hands back, asserted there.
  const keysFor = (keep: number): readonly string[] | undefined => {
    const dropped = total - keep;
    const allKeys = request.keysOf?.(full);
    return allKeys === undefined || dropped === 0 || dropped > MAX_NAMED_DROPS
      ? undefined
      : allKeys.slice(keep);
  };

  /** The same measurement, but as the output would be rendered if the budget were `maxTokens`. */
  const settleAt = (
    keep: number,
    maxTokens: number,
  ): { readonly trim: Trim; readonly text: string } =>
    settle(
      { ...request, maxTokens },
      keep === total ? full : request.build(keep),
      total - keep,
      keysFor(keep),
    );

  const at = (keep: number): { readonly trim: Trim; readonly text: string } =>
    settleAt(keep, request.maxTokens);

  const floorFit = at(request.floor);
  if (floorFit.trim.estimated_tokens > request.maxTokens) {
    // **The number in the refusal is not the floor's size at the caller's budget, and the difference
    // is the whole reason this loop exists.** The report contains `max_tokens`, so a larger budget
    // makes the report longer by a character or two, which can push the estimate up by a whole token
    // -- so a message that named the floor's size as measured at the CALLER's budget would tell them
    // to raise the flag to a value that is refused again. Measured, not feared: this file shipped
    // that way for one revision, and the case is the one in the suite -- 4 rows of 100 code points
    // measure 271 tokens at a budget of 10, and fitting at 271 does not fit, because "271" is two
    // characters wider than "10".
    //
    // So the figure is the fixed point of "the smallest budget at which the floor output fits". The
    // iteration terminates: the render depends on the budget only through the digits of this one
    // integer, so the estimate cannot run away from it, and every pass that continues increases the
    // candidate by at least one. The bound is a guard against a caller whose `render` breaks that
    // assumption -- a loud failure rather than a hang, and rather than a number that does not work.
    const minimumBudget = (): number => {
      let candidate = floorFit.trim.estimated_tokens;
      for (let pass = 0; pass < 4; pass += 1) {
        const fit = settleAt(request.floor, candidate);
        if (fit.trim.estimated_tokens <= candidate) return candidate;
        candidate = fit.trim.estimated_tokens;
      }
      throw new Error(
        `budget: no budget could be found at which the smallest output fits, so this render's size ` +
          `does not stabilise as the budget grows -- the reported maximum was ${String(candidate)} ` +
          `tokens after 4 passes`,
      );
    };
    const minimum = minimumBudget();

    // "In this output format" is load-bearing rather than padding. The fit measures the output the
    // caller's flags ask for, so the figure is the size of a TABLE here and the size of a JSON
    // envelope in a run given `--json` -- and those differ by a lot, because the envelope repeats
    // every column name on every row. A caller who reads the figure, switches format and passes it
    // back is refused again, by a message that read as an unconditional promise. Stating the
    // boundary is one clause; discovering it costs a round trip.
    throw new BudgetFloorError(
      `--max-tokens is too small for this output: the smallest possible one in this output format ` +
        `-- ${String(request.floor)} ${request.floor === 1 ? request.noun[0] : request.noun[1]} -- is ` +
        `about ${String(minimum)} tokens. Raise --max-tokens to at least ` +
        `that, or ask for a narrower scope so there is less to fit.`,
      minimum,
    );
  }

  const fullFit = at(total);
  if (fullFit.trim.estimated_tokens <= request.maxTokens) {
    // Nothing was dropped, and the report still says so -- see `Fitted.trim`.
    return { value: full, trim: fullFit.trim, text: fullFit.text };
  }

  // The largest `keep` that fits, over `[floor, total - 1]`. `total` is known not to fit, which is
  // the invariant the classic form needs; `floor - 1` is the sentinel for "none of them do", and it
  // cannot be reached here because the floor was checked above.
  const fits = (keep: number): boolean => at(keep).trim.estimated_tokens <= request.maxTokens;

  let low = request.floor - 1;
  let high = total;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  const keep = low;

  // The monotonicity assumption, checked rather than trusted. Unreachable for a render whose length
  // grows with its row count -- which is every render this CLI has -- so a throw here means the
  // search landed on a `keep` that does not fit, and returning it would be an over-budget output
  // claiming to be within budget.
  if (!fits(keep)) {
    throw new Error(
      `budget: the fit settled on ${String(keep)} rows that do not fit ${String(request.maxTokens)} ` +
        `tokens, so the render is not monotone in the row count`,
    );
  }

  const settled = at(keep);
  return { value: request.build(keep), trim: settled.trim, text: settled.text };
}

/** The fit as a person reads it, on one line under the coverage. */
export function renderTrim(trim: Trim): string {
  const head =
    trim.dropped === 0
      ? `within ${String(trim.max_tokens)} tokens (estimated ${String(trim.estimated_tokens)})`
      : `dropped ${String(trim.dropped)} row${trim.dropped === 1 ? '' : 's'} to fit ` +
        `${String(trim.max_tokens)} tokens (estimated ${String(trim.estimated_tokens)} at ` +
        `${String(trim.chars_per_token)} code points per token)`;
  const named = trim.dropped_keys === undefined ? '' : `: ${trim.dropped_keys.join(', ')}`;
  return `${head}${named}`;
}
