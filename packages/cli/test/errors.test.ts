import { StoreBusyError } from '@ascend/store';
import { describe, expect, it } from 'vitest';
import { describeFailure } from '../src/errors.js';

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
