import { StoreBusyError } from '@ascend/store';
import { describe, expect, it } from 'vitest';
import { MESSAGE_WIDTH, describeFailure, renderForStderr } from '../src/errors.js';

/**
 * The error boundary, tested where it is a boundary.
 *
 * asc-51t's second half: a lock conflict surfaces as SQLite's bare `database is locked`, which is
 * none of context, problem or fix, and exits 1 -- so a caller cannot tell it apart from "no such
 * type". `describeFailure` is the one place that decides what a person sees and what a script
 * branches on, so the mapping is asserted here rather than left to a probe.
 */

/**
 * The driver error, reproduced exactly as `node:sqlite` throws it.
 *
 * Measured on a real lock conflict: a plain `Error` whose own properties are
 * `{ code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' }`, with
 * `constructor.name === 'Error'`. There is no `SQLiteError` class to import, which is why the
 * guard is duck-typed -- and why this fixture is written out by hand rather than constructed
 * from a driver export that does not exist.
 */
const busyFromDriver = (): Error => {
  const error = new Error('database is locked');
  Object.assign(error, { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });
  return error;
};

describe('a lock conflict is reported as something a person can act on', () => {
  it('turns the bare driver string into context, problem and fix', () => {
    const failure = describeFailure(busyFromDriver(), false);
    expect(failure.exitCode).toBe(1);
    expect(failure.message).not.toBe('database is locked');
    expect(failure.message).toMatch(/locked by another ascend process/);
    expect(failure.message).toMatch(/re-run the command/);
  });

  it("passes the store's own busy error through unchanged, since it is already actionable", () => {
    const failure = describeFailure(new StoreBusyError('/x/.ascend/ascend.db'), false);
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toMatch(/\/x\/\.ascend\/ascend\.db is locked/);
  });

  it('does NOT claim nothing was written, which this layer cannot know', () => {
    // The open-path error can promise that; this branch fires for an error from any point in the
    // command. A reassurance that is sometimes false is worse than no reassurance.
    expect(describeFailure(busyFromDriver(), false).message).toMatch(/It did not complete/);
    expect(describeFailure(busyFromDriver(), false).message).not.toMatch(/nothing/i);
  });

  it('leaves an ordinary refusal alone, so the branch is not over-broad', () => {
    // The refutation of this fix: if the guard matched on the message, or on `code`, this would be
    // rewritten too -- and a validation refusal would acquire a "re-run once the other one has
    // finished" that would send the caller looking for a lock conflict that does not exist.
    const failure = describeFailure(new Error('no type named `decision` is registered'), false);
    expect(failure.message).toBe('no type named `decision` is registered');
  });

  it('keeps a NON-busy sqlite error out of the lock branch', () => {
    // errcode 1 is SQLITE_ERROR, not a lock. Sharing `code: 'ERR_SQLITE_ERROR'` is exactly why the
    // guard must read `errcode` as well as `code` -- a guard matching on `code` alone would hand
    // this the lock-conflict message and send the caller hunting a lock that was never there.
    //
    // **The assertion changed when the driver-error layer landed, and the test's purpose did not.**
    // A code-1 error used to pass through verbatim; it is now explained (asc-tno), so asserting
    // `message === 'no such table: entries'` would have been asserting the defect. What this test
    // exists to refute is the over-broad guard, so that is what it pins: not the lock message --
    // and, still, the driver's own wording, which is the specific half the explanation must keep.
    const error = new Error('no such table: entries');
    Object.assign(error, {
      code: 'ERR_SQLITE_ERROR',
      errcode: 1,
      errstr: 'no such table: entries',
    });
    const { message } = describeFailure(error, false);
    expect(message).not.toMatch(/locked by another ascend process/);
    expect(message).toContain('no such table: entries');
  });

  it('still appends the stack under --debug, which never changes the exit code', () => {
    const failure = describeFailure(busyFromDriver(), true);
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toContain('at ');
  });
});

/**
 * `--debug` no longer prints the failure twice. `asc-3u2` item (c).
 *
 * Measured before the fix: `asc types show nope --debug` rendered "There is no entry type named
 * 'nope' ..." on two separate line groups. `describeFailure` prints the message and then appends
 * `error.stack`, whose first line is `${name}: ${message}` -- the same message again. Cosmetic
 * until you need it, and `--debug` is the flag you reach for exactly when you need it.
 *
 * **The count is what is asserted, not the absence.** "Does not contain the message twice" is not
 * expressible as a substring assertion, and a test that only checked the message was present would
 * have passed before the fix -- which is the shape of false-green this repo treats as severity
 * zero. `occurrences` is how "once" is stated.
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('--debug shows the stack without repeating the message', () => {
  it('prints the message once, not twice', () => {
    // Would have been 2 before the fix: once from `failure.message`, once from the stack's header.
    const { message } = describeFailure(new Error('a plain failure'), true);

    expect(occurrences(message, 'a plain failure')).toBe(1);
    expect(message).toContain('at ');
  });

  it('keeps the class name, which is the only thing the dropped line carried', () => {
    // `store/src/db.ts` and friends set `this.name` in the constructor, so this is the shape a real
    // ascend error has -- and it is why the whole header line is not simply deleted: `StoreBusyError`
    // in a trace is information `--debug` exists to give.
    class Named extends Error {
      public constructor(message: string) {
        super(message);
        this.name = 'StoreBusyError';
      }
    }

    const { message } = describeFailure(new Named('a named failure'), true);

    expect(message).toContain('StoreBusyError');
    expect(occurrences(message, 'a named failure')).toBe(1);
  });

  it('handles a message containing a newline, so a multi-line failure prints once', () => {
    // ascend's multi-line messages are real: `EntryRejectedError` lists every problem with an entry
    // on its own line, and that is the error `asc record` shows most often.
    //
    // **This is NOT the case a single-line comparison misses, which is what it was first written
    // to say.** Measured: `new Error('first line\nsecond line').stack` begins
    // `['Error: first line', 'second line', ...]`, so the whole message is on the header and
    // `lines[0] === header[0]` implies the rest. That weaker form was applied as a mutation and
    // survived, which is what exposed the wrong claim rather than a weak test.
    //
    // It is kept because it is not vacuous: dropping the header unconditionally (mutation M10)
    // makes `second line` print twice and this test fails.
    const { message } = describeFailure(new Error('first line\nsecond line'), true);

    expect(occurrences(message, 'first line')).toBe(1);
    expect(occurrences(message, 'second line')).toBe(1);
  });

  it('leaves a stack alone when it does not repeat the message', () => {
    // The refutation of the fix itself. Dropping the first line unconditionally would pass every
    // test above and destroy a stack whose header says something the message does not -- so the
    // match is checked rather than assumed, and this pins that.
    const error = new Error('the message');
    error.stack = 'SomethingElse entirely\n    at somewhere';

    const { message } = describeFailure(error, true);

    expect(message).toContain('SomethingElse entirely');
  });

  it('adds nothing at all when --debug was not asked for', () => {
    // The flag must not be able to change the message it is a diagnostic FOR -- `errors.ts` says
    // `debug` never changes whether the command fails or what it exits with, and the same reasoning
    // covers what it prints when it succeeds at printing.
    const { message } = describeFailure(new Error('a plain failure'), false);

    expect(message).toBe('a plain failure');
  });
});

/**
 * The rendering a failure gets on its way to stderr. `asc-98c`.
 *
 * **Why the rule is tested here and not only through the binary.** `ingest.test.ts` and
 * `init.test.ts` drive the real CLI and assert a long path against the raw stderr, which is the
 * assertion the bead is DONE WHEN on. What they cannot do is say *why* an overlong token survives
 * or what happens at the width boundary, because a tmpdir path is 79 characters and lands one
 * character over the line by accident of the prefix rather than by construction. These are the
 * cases a real fixture cannot reach, and they are the cases the rule is made of.
 *
 * **Why `describeFailure` is not in the loop.** It chooses the wording and the exit code; this
 * chooses how the wording is laid out. Composing them would mean every case below had to be
 * expressed as an error `describeFailure` would classify, which for a 120-character unbreakable
 * token means inventing an error the product never throws. The two are joined at `emitStderr`, and
 * the binary-level tests above that join are the ones that drive it.
 */
describe('a failure is laid out the way a reader has to read it', () => {
  it('is the label, the message, and nothing else on the line', () => {
    // The exact string, because every ornament oclif added is a subtraction from this:
    // `prettyPrint` produced ` ›   Error: ...` -- a leading space, a `›`, and three more spaces,
    // which moved the label off column 0 so it was no longer greppable and put a glyph inside
    // text that a reader is meant to copy.
    expect(renderForStderr('Error', 'no store found here')).toBe('Error: no store found here');
    expect(renderForStderr('Warning', 'dry run: nothing was written')).toBe(
      'Warning: dry run: nothing was written',
    );
  });

  it('leaves a path whole however long it is, because a path has no space in it', () => {
    // The defect itself, at the level where the rule lives. oclif's `wrapAnsi(..., { hard: true })`
    // broke this path across two lines with a `›` between the halves, so the path on stderr was not
    // a path: it could not be pasted, and `expect(stderr).toContain(path)` failed on output that was
    // correct -- which is why every suite that touched a path carried a gutter-stripping helper.
    const path = `/var/folders/${'q'.repeat(120)}/T/asc-ab12cd/.claude/projects`;
    const text = renderForStderr('Error', `No transcripts found under ${path}.`);

    expect(text).toContain(path);
    expect(text).not.toContain('›');

    // The line it sits on overruns the width, and that is the trade rather than a missed case: a
    // long line reads, a broken path does not. Asserted because it is the half a future "fix" for
    // the overrun would take away -- a `wrapLine` that cut here would pass every other test in this
    // block and restore exactly the defect the block exists for.
    expect(text.split('\n').some((line) => line.length > MESSAGE_WIDTH)).toBe(true);
  });

  it('breaks at spaces, so a line is over the width only when it holds a word that cannot fit', () => {
    // 40 four-letter words: over the width by construction, every word short enough to fit on a
    // line of its own. Nothing here may overrun -- the overrun in the test above is licensed by a
    // token no space can rescue, and this is the case that says the licence is not general.
    const text = renderForStderr('Error', Array.from({ length: 40 }, () => 'word').join(' '));
    const lines = text.split('\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MESSAGE_WIDTH);
  });

  it('loses nothing and splits nothing, whatever the message is', () => {
    // The property, stated once and run over the shapes that reach it. Two ways to be wrong and
    // both are covered: dropping text (a wrap that discards), and cutting a token (a wrap that
    // breaks wherever the column lands). Re-joining on whitespace catches the first, and looking
    // each word up as a whole catches the second.
    const messages = [
      'a short one that is under the width',
      Array.from({ length: 40 }, () => 'word').join(' '),
      `No transcripts found under /var/folders/${'q'.repeat(200)}/T/asc/.claude/projects.`,
      'context line\nproblem line\nfix line',
      '  indented under --debug\n    at somewhere (/a/very/long/path/that/goes/on/a/while/index.ts:1:1)',
      'a  run  of  spaces  that  is  long  enough  to  wrap  somewhere  in  the  middle  of  it',
      '',
    ];

    for (const message of messages) {
      const text = renderForStderr('Error', message);

      // Nothing invented, nothing dropped: the same text, with line breaks counted as whitespace.
      expect(text.replace(/\s+/g, ' ').trim()).toBe(
        `Error: ${message}`.replace(/\s+/g, ' ').trim(),
      );

      // Every word arrives whole. A word cut in half leaves its two fragments on the stream and no
      // copy of the word itself, so this is the assertion that breaks when a token is split.
      const words = new Set(text.split(/\s+/).filter(Boolean));
      for (const word of message.split(/\s+/).filter(Boolean)) expect(words).toContain(word);
    }
  });

  it('keeps the paragraph structure, because a refusal is context, problem and fix', () => {
    // Every message in `errors.ts` and every store refusal is written in that shape on purpose, and
    // a renderer that flattened newlines into the wrap would turn three steps into one paragraph.
    const text = renderForStderr('Error', 'context\nproblem\nfix');
    expect(text).toBe('Error: context\nproblem\nfix');
  });

  it('keeps an indented line indented, and fits its words into the room that is left', () => {
    // `--debug`'s stack arrives indented. Re-fitting a frame from column 0 would turn a trace into
    // prose, and ignoring the indent when measuring would push every frame over the width by four.
    const frame = `    at somewhere (${'/a/long/path/'.repeat(8)}index.ts:1:1)`;
    const text = renderForStderr('Error', `a failure\n${frame}`);
    const lines = text.split('\n').slice(1);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith('    ')).toBe(true);
  });

  it('does not tidy a run of spaces out of a line that exactly fills the width', () => {
    // The words below are chosen so the first line lands on EXACTLY `MESSAGE_WIDTH`, and so the
    // double space sits in the middle of that line rather than at the break -- where a wrap would
    // hide it. `body.split(/\s+/)` instead of `body.split(' ')` collapses the run and reads like an
    // obvious tidy-up; this is what refutes it, and the mutation round says so: of the eight wrong
    // implementations tried against this block, M5 (the collapse) is killed by this test and by no
    // other. The message on stderr is the text that was written, so the run stays.
    //
    // **What this test does NOT pin, and the measurement that says so.** An earlier version of this
    // comment claimed the case also guarded the boundary -- "80 is a line, and 81 is a break". It
    // does not, and cannot. The early return in `wrapLine` is a fast path: for a line at or under
    // the width whose every word fits, the general path reassembles exactly the same line, so
    // `line.length < width` and `<= width` are the same function. Measured, not argued: 200,008
    // generated lines straddling the boundary -- exact-width, indented, runs of spaces, overlong
    // tokens, all-space -- and the two implementations differ on 0 of them. The mutation round
    // called that mutation SURVIVED, and the differential run is why it is recorded as an
    // equivalent mutant rather than as a hole in the tests. The assertion below stands because the
    // CONTENT it pins is real; the boundary claim attached to it was not.
    const text = renderForStderr(
      'Error',
      `${'x'.repeat(30)}  ${'y'.repeat(20)} ${'z'.repeat(20)} ${'w'.repeat(20)}`,
    );

    expect(text.split('\n')[0]).toBe(
      `Error: ${'x'.repeat(30)}  ${'y'.repeat(20)} ${'z'.repeat(20)}`,
    );
    expect(text.split('\n')[0]?.length).toBe(MESSAGE_WIDTH);
  });

  it('adds no terminator, which is the writer’s half of the contract', () => {
    // `BaseCommand.emitStderr` supplies the newline, and `emitText` states the rule for stdout:
    // the renderer produces the text and the writer writes it. `types export` is asserted as
    // `'[]\n'` for the same reason. A renderer that ended its own line would be a second owner of
    // the terminator, and the two would double it the first time one of them changed.
    expect(renderForStderr('Error', 'a plain failure')).not.toMatch(/\n$/);
  });
});
