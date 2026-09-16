/**
 * Turning a thrown thing into something a person (or a model) can act on.
 *
 * `cli-best-practices` rule 8: an error is **context → problem → fix**, and a raw stack
 * trace is not an error message. The store's own errors are already written in that
 * shape -- `EntryRejectedError` names the field, the expected type, and what was
 * received -- so the default here is to print them as-is rather than to wrap them in
 * something that buries the useful part. What this module adds is the parts the store
 * cannot know: the **exit code**, and whether a stack trace is wanted at all.
 *
 * **The exception to that default is the layer under the store**, which writes nothing in that
 * shape and cannot be asked to: the operating system reports `EEXIST` and SQLite reports
 * `incomplete input`, and neither knows it is talking to a person. `driver-errors.ts` turns those
 * into the same context -> problem -> fix the store's own errors already have, and is consulted
 * below, before the default. Everything it does not recognise still prints as-is.
 *
 * Exit codes are a contract, not a detail:
 *
 *   0    success, and nothing else claims it
 *   1    the command ran and refused -- an unknown type, a failed validation, no store
 *   2    the command line itself was wrong (oclif's own usage errors, and ours)
 *   130  interrupted (SIGINT), which Node's default signal handling already produces
 *
 * The separation matters because the two failures need different responses: 2 means the
 * caller should re-read the help, 1 means the caller understood the command and the
 * answer was no. A CLI that returns 1 for both cannot be scripted against.
 */

import { Errors } from '@oclif/core';
import { CursorError, PageSizeError } from '@ascend/core';
import { SampleSizeError } from '@ascend/analysis';
import { isBusyError } from '@ascend/store';
import { describeDriverError } from './driver-errors.js';
import { NoProjectError } from './project.js';

export interface Failure {
  /** What to print on stderr. Never a stack unless `--debug` asked for one. */
  readonly message: string;
  readonly exitCode: number;
}

/** oclif stamps usage errors with its own exit code; that decision wins. */
function oclifExitCode(error: Error): number | undefined {
  const oclif = (error as { oclif?: { exit?: unknown } }).oclif;
  const exit = oclif?.exit;
  return typeof exit === 'number' ? exit : undefined;
}

/**
 * The stack, minus the part that repeats the message.
 *
 * Node's `stack` begins with `${name}: ${message}`, and `describeFailure` prints the message on the
 * line above -- so `--debug` printed the failure TWICE. Measured: `asc types show nope --debug`
 * rendered "There is no entry type named 'nope' ..." on two separate line groups. `--debug` is the
 * flag you reach for when something is wrong, and a doubled first line is text the reader has to
 * work out is not two failures.
 *
 * **The class name survives when it is not the default `Error`.** It is the one thing the header
 * line carries that the message does not: `StoreBusyError` or `ForeignStoreError` in a trace is
 * what `--debug` exists to give, and dropping the whole line to remove the duplication would drop
 * that with it. So an `Error`'s header goes and a named error's header becomes a name.
 *
 * The duplication is matched against the message rather than assumed, and matched LINE BY LINE
 * across the whole header -- a message containing newlines makes `${name}: ${message}` several
 * lines long, and all of them sit at the top of the stack.
 *
 * **The line-by-line match is defensive, and a mutation round proved it is not load-bearing.**
 * The obvious weaker form, `lines[0] === header[0]`, was applied as a mutation and SURVIVED every
 * test -- because Node puts the WHOLE message on the stack (measured: `new Error('a\nb').stack`
 * begins `['Error: a', 'b', ...]`), so the first line matching implies the rest do. The two forms
 * agree on every stack Node can produce. This one is kept anyway: it states the precondition the
 * `slice` below actually relies on -- that the entire header is present, not just its first line --
 * so a stack from somewhere other than Node's `Error` cannot be silently mis-sliced. Recorded here
 * because a surviving mutation is a finding either way, and the honest one is "the mutation was
 * equivalent", not "the test was weak".
 */
function detailOf(error: Error): string | undefined {
  const stack = error.stack;
  if (stack === undefined) return undefined;

  const lines = stack.split('\n');
  const header = `${error.name}: ${error.message}`.split('\n');
  const repeats = header.every((line, index) => lines[index] === line);
  if (!repeats) return stack;

  const frames = lines.slice(header.length);
  return error.name === 'Error' ? frames.join('\n') : [error.name, ...frames].join('\n');
}

/**
 * Map anything thrown to a message and an exit code.
 *
 * `debug` never changes whether the command fails or what it exits with -- only whether
 * the trace is shown. That separation is deliberate: a diagnostic flag that alters the
 * result is a flag you cannot debug with.
 */
export function describeFailure(error: unknown, debug: boolean): Failure {
  const detail = debug && error instanceof Error ? detailOf(error) : undefined;
  const withDetail = (failure: Failure): Failure =>
    detail === undefined ? failure : { ...failure, message: `${failure.message}\n\n${detail}` };

  if (error instanceof NoProjectError) {
    return withDetail({ message: error.message, exitCode: 1 });
  }

  // An operand ascend was handed and could not use as given. Exit 2, per the 1-vs-2 rule below.
  //
  // Matched by CLASS rather than by message, because these are thrown from deep inside a query
  // where the store cannot know the value came from argv. A cursor arrives as text a caller
  // round-tripped -- out of a model's context, a shell variable, a file written by an older run --
  // and a page size as a number the caller typed, and both are the rule's "operand that cannot be
  // read": the fix is a different command line, not a retry of this one. `CursorError` also covers
  // the cross-scope replay, which is a caller having mixed two queries up -- still a bad operand.
  //
  // What is deliberately NOT here: `UnknownTypeError` and `EntryRejectedError`. Those are refusals
  // -- the command line was fine and the world said no -- so they fall through to the default 1.
  // `SampleSizeError` joins them for the same reason and by the same argument: `--limit 0` is a size
  // the caller typed, and whether it was typed as a page size or a sample size is not a difference
  // that changes whose fault it is.
  if (
    error instanceof CursorError ||
    error instanceof PageSizeError ||
    error instanceof SampleSizeError
  ) {
    return withDetail({ message: error.message, exitCode: 2 });
  }

  const oclifExit = error instanceof Error ? oclifExitCode(error) : undefined;
  if (oclifExit !== undefined) {
    // A usage error already carries a message written for the user, and oclif has
    // printed usage on stdout's sibling (stderr) itself. Pass it through.
    return withDetail({
      message: error instanceof Error ? error.message : String(error),
      exitCode: oclifExit,
    });
  }

  // A lock conflict that outlived the busy timeout.
  //
  // Two shapes of it reach here. The store's own `StoreBusyError`, thrown when the *open* lost the
  // lock, already reads context -> problem -> fix and needs nothing from this module. The other is
  // the raw driver error from a lock lost *mid-transaction*, and that one is a plain `Error` whose
  // message is the bare string `database is locked` -- no context, no cause, no next step, and
  // indistinguishable to a caller from "no such type" because both exit 1. That bare string is what
  // asc-51t reported, so it is the reason this branch exists.
  //
  // Exit 1 rather than 2: the command line was fine, and the answer is "not right now". A script
  // that branches on the code should retry this and re-read the help for a 2.
  //
  // The wording deliberately stops at "it did not complete" rather than claiming nothing was
  // written. `StoreBusyError` can make that stronger claim because it is raised before the store's
  // first statement runs; here the error may have come from any point in the command, and a
  // reassurance this branch cannot verify is exactly the kind of false-green this project treats as
  // severity-zero.
  if (isBusyError(error)) {
    return withDetail({
      message:
        'the store is locked by another ascend process, and this command gave up waiting for it ' +
        'after the busy timeout. It did not complete. Several ascend processes sharing one store is ' +
        'expected -- re-run the command once the other one has finished.',
      exitCode: 1,
    });
  }

  // The operating system and SQLite, before the default that prints a message as-is.
  //
  // This branch is here rather than at the call sites because there ARE no call sites to speak of:
  // a filesystem error is thrown by `mkdirSync` deep inside `packages/store`, and a SQLite error by
  // the driver underneath it, so by the time anything in `packages/cli` sees one the layer that knew
  // what it was doing is gone. The code is all that survives, which is why the mapping keys on it.
  //
  // Placed AFTER the busy branch on purpose. `isBusyError` is a SQLite code too -- 5 or 6 -- and it
  // has a longer, more specific message built from measurements about what a busy open does and does
  // not do. Letting the general table answer first would replace that with a generic line about code
  // 5, which would be a regression dressed as consolidation.
  //
  // Exit 1, matching the default it precedes: ascend understood the command and could not carry it
  // out. The one thing a caller might expect to be 2 -- `asc query` handed SQL that will not parse
  // -- is 1 by the same argument `refusal` gives for a malformed document: the SQL is data the
  // caller supplied, not the command line they typed, and the command line was fine.
  const driverMessage = describeDriverError(error);
  if (driverMessage !== undefined) {
    return withDetail({ message: driverMessage, exitCode: 1 });
  }

  if (error instanceof Error) {
    return withDetail({ message: error.message, exitCode: 1 });
  }

  // Throwing a non-Error is a bug in whatever threw it, and the honest report says so
  // rather than inventing a message that looks like a diagnosis. `String(value)` is used
  // rather than `JSON.stringify` because the latter returns `undefined` for `undefined`,
  // which would print the word "undefined" and read like a real value.
  return withDetail({
    message:
      `an unexpected ${typeof error} was thrown where an Error was expected: ${String(error)}. ` +
      `This is a bug in ascend, not a problem with your input.`,
    exitCode: 1,
  });
}

/**
 * A refusal: the request was understood, and the answer is no. Exit 1.
 *
 * **Where the line between 1 and 2 is drawn, stated once so it is not re-argued per call site:**
 *
 *   * `usageError` (2) is for what the caller *typed* -- two output flags at once, a format that
 *     cannot apply, an operand that cannot be read. The fix is a different command line, and
 *     re-reading the help is the right next step.
 *   * `refusal` (1) is for everything else: a name that is not registered, a version that does
 *     not exist, a document whose *contents* are invalid, a hash that does not match, no store
 *     in sight. The command line was fine; the world said no.
 *
 * A file's contents are data, not argv, which is why a malformed type document is a refusal and
 * `--json --table` is not. Getting this backwards is not cosmetic -- a script branching on the
 * exit code would retry a typo and give up on a real absence.
 *
 * Returns a plain `Error` rather than an `Errors.CLIError`: `describeFailure` maps anything that
 * is not an oclif error to exit 1, so the default *is* this case, and an oclif error would exist
 * only to restate the default.
 */
export function refusal(message: string): Error {
  return new Error(message);
}

/** Convenience for the call sites that need to raise their own usage error. */
export function usageError(message: string): Errors.CLIError {
  return new Errors.CLIError(message, { exit: 2 });
}
