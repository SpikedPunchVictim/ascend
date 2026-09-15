import { describe, expect, it } from 'vitest';
import {
  BudgetFloorError,
  CHARS_PER_TOKEN,
  countCodePoints,
  estimateTokens,
  fitToBudget,
  MAX_NAMED_DROPS,
  renderTrim,
  type BudgetRequest,
  type Trim,
} from '../src/budget.js';

/**
 * `--max-tokens` -- the fit, on its own.
 *
 * What can be wrong here is arithmetic and a claim. The arithmetic is the estimator and the search;
 * the claim is "this output is within budget, and it dropped this much to get there". A fit that
 * returns an over-budget output while reporting that it fit is a false green -- the class this
 * project treats as severity-zero, because it destroys trust in every other number the tool prints
 * -- and it is the one bug this file's version of the feature actually had while being written.
 *
 * So the assertions below are the two halves of that claim, checked separately: the reported
 * `estimated_tokens` must equal the measurement of the emitted text (the fixed point), and the
 * emitted text must be within the budget (the ceiling). Then maximality -- that it kept as much as
 * it could -- because a fit that drops a row it did not need to drop is a wrong answer that looks
 * exactly like a right one.
 *
 * The fixture is synthetic and each row is a fixed width, deliberately. On a real corpus row sizes
 * vary, so "the largest keep that fits" is a number nobody can predict by reading the test; here it
 * is arithmetic a reader can check against the budget in the assertion.
 */

const WIDTH = 100; // characters per row, so one row is 50 tokens
const FOOTER = 60; // characters that are always rendered, like a coverage line

/** Rows of exactly `WIDTH` characters, so a token count is predictable from a row count. */
interface Doc {
  readonly rows: readonly string[];
  /** Extra characters for a build that deliberately renders differently each time. Empty normally. */
  readonly pad?: string;
}

/**
 * A render shaped like the real one: the rows, a fixed footer, then the fit's own report.
 *
 * The report being INSIDE the rendered text is the whole point of the fixture. A stub that rendered
 * only the rows would let the bug this file exists to catch pass unnoticed -- which is exactly what
 * happened while writing it.
 */
const render = (doc: Doc, trim: Trim | undefined): string =>
  [
    ...doc.rows,
    'f'.repeat(FOOTER),
    ...(trim === undefined ? [] : [renderTrim(trim)]),
    ...(doc.pad === undefined ? [] : [doc.pad]),
  ].join('\n');

const row = (index: number): string => String(index).padEnd(WIDTH, 'x').slice(0, WIDTH);

/** A request over `count` fixed-width rows. */
function request(
  count: number,
  maxTokens: number,
  floor = 1,
  overrides: Partial<Omit<BudgetRequest<Doc>, 'maxTokens'>> = {},
): BudgetRequest<Doc> {
  return {
    maxTokens,
    requested: count,
    floor,
    build: (keep: number) => ({ rows: Array.from({ length: keep }, (_, index) => row(index)) }),
    rowsOf: (doc) => doc.rows.length,
    keysOf: (doc) => doc.rows.map((_, index) => `k${String(index)}`),
    noun: ['row', 'rows'],
    render,
    ...overrides,
  };
}

describe('budget: the ratio and the estimator', () => {
  it('assumes fewer code points per token than any ascend OUTPUT measured', () => {
    // The measured floor for ascend's own output was 2.18 -- a real corpus, three real tokenizers --
    // so the shipped ratio sits below it and the estimate over-counts in the safe direction. Asserted
    // because lowering this constant is how the budget would start lying about fitting.
    expect(CHARS_PER_TOKEN).toBe(2);
    expect(CHARS_PER_TOKEN).toBeLessThan(2.18);

    // **And the claim stops at the word "output", which this assertion makes explicit.** The ratio
    // is calibrated on what this CLI PRINTS. It is not a ceiling for the content ascend STORES: bare
    // CJK measures 0.79 code points per token and emoji 0.33, so evidence written in those is
    // under-estimated by 2.5x and 6x. The numbers live in `budget.ts`'s comment and in EV-13; the
    // point of pinning them here is that the boundary is a measured fact, not a hedge, and a reader
    // who finds this constant too low for their corpus has the figure to argue with.
    expect(CHARS_PER_TOKEN).toBeGreaterThan(0.79);
  });

  it('counts code points, not UTF-16 units', () => {
    // An emoji is one character and two UTF-16 units. `String.length` would call it two and halve
    // the reported size of a text full of them.
    expect(countCodePoints('')).toBe(0);
    expect(countCodePoints('abcd')).toBe(4);
    expect(countCodePoints('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2);
    expect(countCodePoints('\u{1F600}\u{1F600}')).toBe(2);
  });

  it('counts a lone surrogate as one character, matching the string iterator', () => {
    // Reachable only for a string that is already malformed, and the claim here is the narrow one:
    // this agrees with `Array.from(text).length` on it rather than silently disagreeing. An unpaired
    // low surrogate would count as ZERO under the cheaper rule `countCodePoints` used first -- and
    // under-counting is the unsafe direction for a budget, so the exact rule is the one that ships.
    const loneLow = String.fromCharCode(0xdc00);
    const loneHigh = String.fromCharCode(0xd800);

    // Each half on its own is one character. The low half is the case the cheap rule got wrong; the
    // high half is the case a rule written the other way round would get wrong.
    expect(countCodePoints(loneLow)).toBe(1);
    expect(countCodePoints(loneHigh)).toBe(1);

    // And agreement with the iterator on every malformed shape, which is the general claim: an
    // unpaired half, two unpaired halves, and a half followed by ordinary text. The first of these
    // is worth reading twice -- two high surrogates are TWO characters, so a rule that counted the
    // pair as one would be wrong in the other direction, and this is the assertion that says so.
    for (const malformed of [
      `${loneHigh}${loneHigh}`,
      `${loneHigh}x`,
      `x${loneLow}`,
      `${loneHigh}${loneLow}`,
    ]) {
      expect(countCodePoints(malformed)).toBe(Array.from(malformed).length);
    }
    expect(countCodePoints(`${loneHigh}${loneHigh}`)).toBe(2);

    // And a well-formed pair is one character, not two -- the case the cheap rule got right.
    expect(countCodePoints('\u{1F600}')).toBe(Array.from('\u{1F600}').length);
    expect(countCodePoints('\u{1F600}')).toBe(1);
  });

  it('rounds up, because a budget is a ceiling', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abc')).toBe(2);
    // A partial token still occupies a token in a context window, so truncating the remainder is
    // how a long tail of them accumulates past the limit.
    expect(estimateTokens('a'.repeat(101))).toBe(51);
  });
});

describe('budget: the output it reports on is the output it measured', () => {
  /**
   * The fixed point, asserted directly.
   *
   * This is the assertion that would have caught the defect this file's implementation shipped with
   * for one revision: the search measured the rows WITHOUT the report, then appended the report, and
   * `--max-tokens 400` emitted an output whose own report said `401`. The claim is not "it looks
   * about right" -- it is that the number on the report is the measurement of the bytes.
   */
  it('reports the exact size of the text it returns', () => {
    for (const maxTokens of [200, 500, 900, 1500, 5000]) {
      const fitted = fitToBudget(request(40, maxTokens));
      expect(estimateTokens(fitted.text)).toBe(fitted.trim.estimated_tokens);
    }
  });

  it('never emits more than the budget, across a sweep', () => {
    for (let maxTokens = 200; maxTokens <= 3000; maxTokens += 37) {
      const fitted = fitToBudget(request(40, maxTokens));
      expect(fitted.trim.estimated_tokens).toBeLessThanOrEqual(maxTokens);
      expect(estimateTokens(fitted.text)).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('emits the rows it says it emitted', () => {
    const fitted = fitToBudget(request(40, 900));
    // The text is the rows, the footer, and the report -- and nothing else. So a caller writing
    // `fitted.text` writes exactly the rows `fitted.value` holds, in order.
    expect(fitted.trim.dropped).toBeGreaterThan(0);
    const lines = fitted.text.split('\n');
    expect(lines).toHaveLength(fitted.value.rows.length + 2);
    expect(lines.slice(0, fitted.value.rows.length)).toStrictEqual([...fitted.value.rows]);
  });
});

describe('budget: it keeps as much as it can', () => {
  /**
   * Maximality, which is the difference between a fit and a truncation.
   *
   * "Under budget" is satisfied trivially by emitting nothing. The claim a caller relies on is that
   * the fit kept the MOST it could, and the only way to check that is to build one row more and show
   * that it does not fit.
   */
  it('drops one row fewer than the first that would not fit', () => {
    const req = request(40, 900);
    const fitted = fitToBudget(req);

    const kept = req.build(fitted.value.rows.length);
    const oneMore = req.build(fitted.value.rows.length + 1);

    expect(estimateTokens(render(kept, fitted.trim))).toBeLessThanOrEqual(req.maxTokens);
    expect(estimateTokens(render(oneMore, fitted.trim))).toBeGreaterThan(req.maxTokens);
  });

  it('keeps every row when the whole thing fits, and says it dropped nothing', () => {
    const fitted = fitToBudget(request(40, 100_000));

    expect(fitted.value.rows).toHaveLength(40);
    expect(fitted.trim.dropped).toBe(0);
    // Present, not omitted: its absence would be ambiguous between "the budget was honoured in
    // full" and "no budget was in play", and a caller has no other way to tell them apart.
    expect(fitted.trim.max_tokens).toBe(100_000);
    expect(fitted.trim.chars_per_token).toBe(CHARS_PER_TOKEN);
  });

  it('counts the dropped rows exactly', () => {
    for (const maxTokens of [200, 500, 900, 1500]) {
      const fitted = fitToBudget(request(40, maxTokens));
      expect(fitted.trim.dropped).toBe(40 - fitted.value.rows.length);
    }
  });
});

describe('budget: names when they are cheap, a count when they are not', () => {
  it('names the dropped rows when few enough were dropped', () => {
    const fitted = fitToBudget(request(40, 1900));
    expect(fitted.trim.dropped).toBeGreaterThan(0);
    expect(fitted.trim.dropped).toBeLessThanOrEqual(MAX_NAMED_DROPS);
    // The suffix, in order -- so a reader learns not just how many went but which.
    const kept = fitted.value.rows.length;
    expect(fitted.trim.dropped_keys).toStrictEqual(
      Array.from({ length: fitted.trim.dropped }, (_, offset) => `k${String(kept + offset)}`),
    );
  });

  it('reports only the count when more than the cap were dropped', () => {
    const fitted = fitToBudget(request(200, 900));
    expect(fitted.trim.dropped).toBeGreaterThan(MAX_NAMED_DROPS);
    // Eight ids are a tenth of a small budget, spent on a list whose actionable form is the count.
    // `dropped_keys.length < dropped` is the visible signal that names were withheld.
    expect(fitted.trim.dropped_keys).toBeUndefined();
  });

  it('omits the names entirely when nothing was dropped', () => {
    // Not an empty array: "no rows were dropped" and "the names are an empty list" are the same
    // fact here, and an empty array would be a value where the absence is the answer.
    expect(fitToBudget(request(5, 100_000)).trim.dropped_keys).toBeUndefined();
  });
});

describe('budget: a floor it cannot reach is refused, not silently broken', () => {
  /**
   * Below the floor there is no output worth emitting, so the fit refuses rather than emitting a
   * smaller one.
   *
   * The map is why this exists: its first four rows are the type, the count, the property count and
   * the version count, and property rows without them are not a smaller map -- they are a different
   * and misleading one. A refusal that names the minimum is also the only version a caller can act
   * on: the number in the message is exactly what to put in the flag.
   */
  it('throws a BudgetFloorError when the floor does not fit', () => {
    expect(() => fitToBudget(request(40, 10, 4))).toThrow(BudgetFloorError);
  });

  it('names the smallest output that would fit, so the message is actionable', () => {
    const req = request(40, 10, 4);
    try {
      fitToBudget(req);
      expect.unreachable('the fit should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(BudgetFloorError);
      const floor = error as BudgetFloorError;

      // The figure is a MEASUREMENT, not a guess -- and the claim that makes the message actionable
      // is tested rather than restated: setting the flag to exactly the number it names must work.
      // That is deliberately not `minimumTokens === estimateTokens(the floor's rows)`, which is what
      // this assertion said first and which is off by enough to matter twice over. The number must
      // describe the output that contains the REPORT (a report-less measurement is a few characters
      // short), and the report itself gets wider as the budget in it grows -- so the value at the
      // caller's budget is not the value that fits at the value. Both are visible here: 4 rows
      // measure 271 tokens at a budget of 10, and 272 is the smallest budget at which they fit.
      const raised = fitToBudget(request(40, floor.minimumTokens, 4));
      expect(raised.trim.estimated_tokens).toBe(floor.minimumTokens);
      expect(raised.value.rows).toHaveLength(4);
      expect(raised.trim.dropped).toBe(36);

      // So the figure is strictly larger than the report-less size -- and only by the report, which
      // is what makes the difference worth this much comment.
      const rowsOnly = estimateTokens(render(req.build(4), undefined));
      expect(floor.minimumTokens).toBeGreaterThan(rowsOnly);
      expect(floor.message).toContain(String(floor.minimumTokens));
    }
  });

  it('never drops below the floor', () => {
    // The floor is 30 of 40 rows and the budget is tight, so a fit without a floor would go to one
    // row. The floor is what stops it.
    const fitted = fitToBudget(request(40, 2000, 30));
    expect(fitted.value.rows.length).toBeGreaterThanOrEqual(30);
  });
});

describe('budget: the answer is re-measured rather than trusted', () => {
  /**
   * The guard fires only for a build that is not a function of its argument, and that is a finding
   * rather than a gap in the fixture.
   *
   * A PURE render that is merely non-monotone cannot reach it: the search only moves its lower bound
   * on a `keep` it has just measured as fitting, so the `keep` it returns is always one it measured
   * as fitting. The branch is reachable exactly when two calls with the SAME argument disagree --
   * which is what any impurity in a render does: a clock in a header, a counter, a `Map` iteration
   * order. So this stub grows its output on every call, which is the defect in miniature.
   *
   * The value of the test is that the guard is not decoration: without it this request returns a fit
   * whose own report says it is over budget.
   */
  it('throws rather than returning an over-budget fit when the build is not a function of its argument', () => {
    let calls = 0;
    const req = request(8, 500, 1, {
      build: (keep: number) => {
        calls += 1;
        return {
          rows: Array.from({ length: keep }, (_, index) => row(index)),
          pad: 'p'.repeat(calls * 200),
        };
      },
    });

    expect(() => fitToBudget(req)).toThrow(/not monotone in the row count/);
  });
});
