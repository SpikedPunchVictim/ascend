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
