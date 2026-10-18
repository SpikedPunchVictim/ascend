import { describe, expect, it } from 'vitest';
import type { TypeSummary } from '@ascend/store';

import {
  BRIEF_CAP_BYTES,
  DUE_GRADE_LIMIT,
  RECORD_COMMAND_LINE,
  briefHead,
  briefLine,
  briefLines,
  briefText,
  dueGradeLine,
  dueGradeLines,
  reviewAfterReached,
} from '../src/brief-text.js';
import type { DueGrade } from '../src/intervention.js';

/**
 * The payload's composition, as pure functions (`asc-09wx.8.5`).
 *
 * **Why this file exists at all, given that `types.test.ts` drives the real brief.** Three of the
 * four things added here are properties of the TEXT rather than of any project: that the due-grade
 * block is bounded, that the bound is under the cap, and that clipping a name cannot sever a
 * character. Those are the ones a store would have to be built to a shape to exercise, and the shape
 * that matters -- a `change` of 10,000 characters, a backlog of twenty ungraded rows -- is exactly
 * the shape no fixture has. The command's own end-to-end path is covered in `types.test.ts`.
 */

/** An active type, with every field `briefLine` reads supplied. */
function summary(name: string, overrides: Partial<TypeSummary> = {}): TypeSummary {
  return {
    name,
    latestVersion: 1,
    major: 1,
    versionCount: 1,
    typeHash: 'h',
    status: 'active',
    propertyCount: 1,
    entryCount: 5,
    struckCount: 0,
    description: null,
    recordWhen: 'something happens',
    reviewAfter: null,
    ...overrides,
  };
}

/** A grade the project owes itself, with `change` and the bound overridable. */
function due(overrides: Partial<DueGrade> = {}): DueGrade {
  return {
    root: '8f2c1d7a-1e6b-4c2f-9a30-5d7e6b8c9a01',
    handler: 'handlers/beads-delivery.yaml',
    change: '`handlers/beads-delivery.yaml`',
    appliedAt: '2026-09-01T00:00:00.000Z',
    days: 30,
    dueAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the line for a grade the project owes', () => {
  it('names the row, the wait, the bound and the command that reads it', () => {
    const line = dueGradeLine(due());

    expect(line).toContain('8f2c1d7a-1e6b-4c2f-9a30-5d7e6b8c9a01');
    expect(line).toContain('`handlers/beads-delivery.yaml`');
    expect(line).toContain('30 active days');
    expect(line).toContain('2026-10-01T00:00:00.000Z');
    expect(line).toContain('asc handlers grade');
  });

  /**
   * `asc-09wx.8.5`'s decision (`c38bf1a2`), and the whole reason this wording is written out.
   *
   * The instant is `applied_at` plus CALENDAR days while `grading_point` is stated in ACTIVE days, so
   * it is an earlier bound on the wait rather than the wait -- 14.98 calendar days early on the
   * sparsest corpus measured, permitting a grade that holds 20 of the 30 active days the row asked
   * for (`dogfood/0106`). A line that said "due" would be read as a verdict and would be a false
   * alarm on every sparse log, so the words are the fix and this pins them.
   */
  it('says the grade is due to BECOME READABLE, because the instant it names is an earlier bound', () => {
    const line = dueGradeLine(due());

    expect(line).toContain('due to become readable');
    expect(line).toContain('earlier bound');
    // `due` occurs ONCE on this line, and as part of that phrase. A second occurrence -- "is due",
    // "due at", "now due" -- is the verdict the decision forbids, so the count is asserted as well
    // as the phrase: a later edit that adds one is caught here rather than by a reader believing it.
    expect(line.match(/\bdue\b/gu)).toEqual(['due']);
    expect(line).toContain('is due to become readable');
    expect(line).not.toContain('now due');
  });

  it('names the flag the command refuses without, rather than leaving it to a usage error', () => {
    // `asc handlers grade` has no default for `--effect` and refuses without it, deliberately: a
    // figure the row did not choose would be the command inventing one. The flag has to be taught
    // somewhere, and discovering it from a refusal is the discovery step `dogfood/0028` prices.
    expect(dueGradeLine(due())).toContain('--effect');
  });

  it('clips a change too long to print, and says it clipped it', () => {
    const line = dueGradeLine(due({ change: 'c'.repeat(500) }));

    expect(line).toContain(`${'c'.repeat(60)}...`);
    expect(line).not.toContain('c'.repeat(61));
  });

  /**
   * Clipping is by CODE POINT, and this is the case that tells the difference.
   *
   * `asc-bcv.23` is this repository's record of `--table` splitting a grapheme cluster and printing
   * a plausible-looking *different* character. An astral code point is two UTF-16 units, so clipping
   * by unit at an odd offset leaves a lone surrogate -- which renders as a replacement character and
   * reads as "the name is odd" rather than "the brief truncated it".
   */
  it('never leaves half a character behind when it clips', () => {
    const line = dueGradeLine(due({ change: '😀'.repeat(100) }));

    expect(line).toContain(`${'😀'.repeat(60)}...`);
    // A high surrogate not followed by a low one: the artifact a code-unit slice would leave.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(line)).toBe(false);
  });

  /**
   * The other half of the same rule, and the half a code-point cut alone does not cover.
   *
   * `👨` + ZWJ + `👩` is three code points and ONE character, so a cut at a code-point boundary can
   * land on the joiner -- leaving a well-formed string that renders as two separate people with a
   * stray invisible character between them. That is `asc-bcv.23`'s quieter case: the bytes are valid
   * and the value the reader sees is a different value.
   *
   * **This case exists because a mutant found it missing.** Removing the back-off to `isBoundary`
   * from `clip` left the astral case above green -- sixty code points is a cut at a boundary there --
   * so without this one the rule could be deleted with every test still passing.
   *
   * **And the first form of it was also green, which is the second thing the mutant found.** The
   * family was tiled from code point 0, the 60th code point fell on `👩`, and the back-off could still
   * be deleted with the whole file passing. That is why the offset below is written down rather than
   * left as an obvious-looking `repeat`.
   */
  it('does not leave a joiner hanging at the cut', () => {
    // Three code points per family, five UTF-16 units: `👨` is astral, the joiner and `👩` are not.
    //
    // **The leading `a` is the fixture, not decoration, and it was measured in.** Tiling the family
    // from code point 0 puts the 60th code point at `👩` -- two points past the joiner -- so a `clip`
    // with no back-off passes this test: removing the back-off left it green, which is a false green
    // about the one rule the back-off exists for. One leading code point shifts the cut onto the
    // joiner itself, and that is the only position where the rule does anything at all.
    const family = `a${'👨\u200d👩'.repeat(100)}`;
    const line = dueGradeLine(due({ change: family }));

    // The assertion is on what precedes the ellipsis: a joiner there joins nothing, and the pair it
    // was meant to hold together now reads as two characters.
    expect(line).not.toContain(`\u200d...`);
    expect(line).toContain('...');
    // And the cut still happened where a reader would put it: at most the budget, never more.
    const printed = line.slice(line.indexOf('grade owed: ') + 'grade owed: '.length);
    expect(Array.from(printed.slice(0, printed.indexOf('...'))).length).toBeLessThanOrEqual(60);
  });
});

describe('the block of grades owed', () => {
  it('names them longest-waiting first, as `dueGrades` orders them', () => {
    const lines = dueGradeLines([
      due({ root: 'first', dueAt: '2026-09-01T00:00:00.000Z' }),
      due({ root: 'second', dueAt: '2026-10-01T00:00:00.000Z' }),
    ]);

    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
  });

  it('says nothing at all when no grade is owed', () => {
    expect(dueGradeLines([])).toEqual([]);
  });

  it('stops at the limit and counts the rest, so a backlog cannot run away with the payload', () => {
    const lines = dueGradeLines(
      Array.from({ length: DUE_GRADE_LIMIT + 7 }, (_, index) =>
        due({ root: `row-${String(index)}` }),
      ),
    );

    expect(lines).toHaveLength(DUE_GRADE_LIMIT + 1);
    expect(lines[DUE_GRADE_LIMIT]).toContain('and 7 more');
    expect(lines[DUE_GRADE_LIMIT]).toContain(String(DUE_GRADE_LIMIT));
    // The rows past the limit are absent rather than clipped into the last line.
    expect(lines.join('\n')).not.toContain(`row-${String(DUE_GRADE_LIMIT)}`);
  });

  it('does not print a remainder line when every grade fits', () => {
    const lines = dueGradeLines(Array.from({ length: DUE_GRADE_LIMIT }, () => due()));

    expect(lines).toHaveLength(DUE_GRADE_LIMIT);
    expect(lines.join('\n')).not.toContain('more rows');
  });
});

describe('the payload these compose into', () => {
  it('prints the recording command, then the grades owed, then the types', () => {
    const text = briefText([summary('note')], [due()]);
    const lines = text.split('\n');

    expect(lines[0]).toBe(RECORD_COMMAND_LINE);
    expect(lines[1]).toContain('grade owed:');
    expect(lines[2]).toBe(briefLine(summary('note')));
  });

  it('is silence when there is no active type and no grade owed', () => {
    // The old contract, kept: a header with nothing under it names a command and gives a reader
    // nothing to point it at.
    expect(briefText([], [])).toBe('');
    expect(briefHead([], [])).toBe('');
  });

  it('drops the recording command when there is no type to record, and keeps the grade', () => {
    // `asc record TYPE -` with no type to put in the TYPE slot is a command this project cannot run,
    // so a registry with nothing active does not teach it -- but a grade owed is still something to
    // point at, so the brief is not the empty case either.
    const text = briefText([], [due()]);

    expect(text).not.toContain('asc record');
    expect(text).toContain('asc handlers grade');
    expect(text).toBe(briefText([], [due()]));
  });

  it('puts no blank line between the head and the types when no grade is owed', () => {
    const lines = briefText([summary('note')], []).split('\n');

    expect(lines[0]).toBe(RECORD_COMMAND_LINE);
    expect(lines[1]).toBe(briefLine(summary('note')));
    expect(lines).toHaveLength(2);
  });

  /**
   * The bound `DUE_GRADE_LIMIT` exists for, measured rather than asserted.
   *
   * This block is charged off the TOP of the cap, where `fitBrief` cannot drop it -- a line the
   * fitter cannot drop has to have a bound of its own, or `BRIEF_CAP_BYTES` is not a bound on the
   * payload at all. So the worst case is built here out of the longest inputs the block can be given:
   * a full complement of grades, each with a `change` far longer than the line prints, and the
   * remainder line, against the smallest a full brief gets -- no active types, so nothing else is in
   * the payload. What is measured is the whole rendered brief, which is what the cap bounds.
   */
  it('cannot be pushed past the cap by any backlog of grades, however long their names', () => {
    const worst = Array.from({ length: DUE_GRADE_LIMIT + 500 }, (_, index) =>
      due({ root: String(index).padEnd(36, '0'), change: 'x'.repeat(10_000) }),
    );

    const bytes = Buffer.byteLength(briefText([], worst), 'utf8');

    expect(bytes).toBeLessThan(BRIEF_CAP_BYTES);
    // And the bound is tight enough to be worth having: an unbounded block of this input would be
    // over the cap by two orders of magnitude.
    expect(Buffer.byteLength(dueGradeLines(worst).join('\n') + '\n', 'utf8')).toBeLessThan(
      BRIEF_CAP_BYTES,
    );
  });

  /**
   * The other half of the same bound: `fitBrief` gets the cap LESS this block, so the block's bytes
   * are not free even though they cannot be dropped.
   */
  it('is fully charged to the cap the fitter is given, not added on top', () => {
    const types = Array.from({ length: 40 }, (_, index) => summary(`type_${String(index)}`));
    const grades = [due(), due({ root: 'a'.repeat(36) })];

    const head = briefHead(types, grades);

    expect(head).toContain(RECORD_COMMAND_LINE);
    expect(head).toContain('grade owed:');
    expect(Buffer.byteLength(`${head}\n`, 'utf8')).toBeGreaterThan(
      Buffer.byteLength(`${RECORD_COMMAND_LINE}\n`, 'utf8'),
    );
    // The types are still the only thing `briefLines` produces, which is what makes the fitter's
    // note (`N of M types`) count types.
    expect(briefLines(types)).toHaveLength(40);
  });
});

describe('the type lines this shares a payload with', () => {
  it('marks a reached review_after on the type line, and nothing else', () => {
    expect(briefLine(summary('note', { reviewAfter: 5, entryCount: 5 }))).toContain(
      '[review_after 5 reached: 5 entries]',
    );
    expect(reviewAfterReached(summary('note', { reviewAfter: 5, entryCount: 4 }))).toBe(false);
    expect(briefLine(summary('note', { reviewAfter: 5, entryCount: 4 }))).toBe(
      'note -- something happens',
    );
  });
});
