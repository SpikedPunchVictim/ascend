import { describe, expect, it } from 'vitest';
import { parseAssignments, parseRules } from '../src/annotation-rules.js';

/**
 * The `asc annotate` operand parsers, called directly.
 *
 * No subprocess: what is under test is a pure function from strings to a value, and the subprocess
 * route is already covered in `annotations.test.ts`. What that route cannot show is the VALUE -- it
 * shows the stored `spec_json` after `registerScheme` has normalized it again, so a parser that
 * sorted or deduplicated wrongly, or not at all, would be repaired downstream and pass. These
 * assertions are against the parser's own output, which is the only place that repair is visible.
 *
 * A usage error is asserted by its exit code, because that is the part of it the CLI contract
 * depends on: 2 is "the command line was wrong", and `errors.ts` maps it from `CLIError`.
 */
function exitOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return (error as { oclif?: { exit?: number } }).oclif?.exit;
  }
  return undefined;
}

describe('parseRules', () => {
  it('keeps the rules in the order given, because the first match wins', () => {
    const parsed = parseRules(['b=sql: 1 = 1', 'a=sql: 1 = 1'], []);

    expect(parsed.rules).toStrictEqual([
      { label: 'b', kind: 'sql', query: '1 = 1' },
      { label: 'a', kind: 'sql', query: '1 = 1' },
    ]);
  });

  it('returns the vocabulary as a sorted set of the rules and the declared labels', () => {
    // The value `asc annotate` unions into the scheme's vocabulary, so a repeat here would be a
    // repeat there, and an unsorted list would make two runs of one scheme hash alike only by luck.
    const parsed = parseRules(['b=sql: 1 = 1', 'a=sql: 1 = 1'], ['b', 'c']);

    expect(parsed.labels).toStrictEqual(['a', 'b', 'c']);
  });

  it('trims the label, the kind and the query, so spacing is not a shape', () => {
    const parsed = parseRules(['  bug = sql :  1 = 1  '], []);

    expect(parsed.rules).toStrictEqual([{ label: 'bug', kind: 'sql', query: '1 = 1' }]);
    // And the duplicate check compares these PARSED values, so this is the same rule as the plain
    // spelling rather than a second one.
    expect(exitOf(() => parseRules(['bug=sql: 1 = 1', '  bug = sql :  1 = 1  '], []))).toBe(2);
  });

  it('refuses a duplicate rule on its parsed values', () => {
    expect(exitOf(() => parseRules(['b=sql: 1 = 1', 'b=sql: 1 = 1'], []))).toBe(2);
    // A different kind or a different query is a DIFFERENT rule, and both are reachable in a way
    // the duplicate is not: two rules matching one entry is what first-match-wins decides.
    expect(exitOf(() => parseRules(['b=sql: 1 = 1', 'b=fts: 1 = 1'], []))).toBeUndefined();
    expect(exitOf(() => parseRules(['b=sql: 1 = 1', 'b=sql: 2 = 2'], []))).toBeUndefined();
  });
});

describe('parseAssignments', () => {
  it('returns one pair per id, in the order the ids were given', () => {
    const parsed = parseAssignments(['bug=e1,e7', 'docs=e4']);

    // Entry first, label second: the pair is what `recordAnnotations` is written from, and the
    // reversal of this would annotate the entry named 'bug' with the label 'e1'.
    expect(parsed.pairs).toStrictEqual([
      ['e1', 'bug'],
      ['e7', 'bug'],
      ['e4', 'docs'],
    ]);
  });

  it('returns the vocabulary as a sorted set of the labels, not of the ids', () => {
    const parsed = parseAssignments(['docs=e4', 'bug=e1', 'docs=e5']);

    expect(parsed.labels).toStrictEqual(['bug', 'docs']);
  });

  it('keeps a repeated entry as two pairs, so the duplicate can be refused by name', () => {
    // A map here would keep the last label and lose the contradiction, which is the outcome
    // `recordAnnotations` refuses outright for a pass written through the API.
    const parsed = parseAssignments(['bug=e1', 'docs=e1']);

    expect(parsed.pairs).toStrictEqual([
      ['e1', 'bug'],
      ['e1', 'docs'],
    ]);
  });

  it('trims an id, so a spaced list is the list it names', () => {
    expect(parseAssignments(['bug=e1, e7']).pairs).toStrictEqual([
      ['e1', 'bug'],
      ['e7', 'bug'],
    ]);
  });

  it('refuses an empty element rather than dropping it', () => {
    expect(exitOf(() => parseAssignments(['bug=e1,,e2']))).toBe(2);
  });

  it('refuses a label that is empty or only whitespace', () => {
    expect(exitOf(() => parseAssignments(['=e1']))).toBe(2);
    expect(exitOf(() => parseAssignments([' =e1']))).toBe(2);
  });

  it('refuses an id list that is empty, naming --label as the flag meant', () => {
    expect(exitOf(() => parseAssignments(['bug=']))).toBe(2);
  });
});
