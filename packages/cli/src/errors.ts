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

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/**
 * Map anything thrown to a message and an exit code.
 *
 * `debug` never changes whether the command fails or what it exits with -- only whether
 * the trace is shown. That separation is deliberate: a diagnostic flag that alters the
 * result is a flag you cannot debug with.
 */
export function describeFailure(error: unknown, debug: boolean): Failure {
  const detail = debug ? stackOf(error) : undefined;
  const withDetail = (failure: Failure): Failure =>
    detail === undefined ? failure : { ...failure, message: `${failure.message}\n\n${detail}` };

  if (error instanceof NoProjectError) {
    return withDetail({ message: error.message, exitCode: 1 });
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

/** Convenience for the call sites that need to raise their own usage error. */
export function usageError(message: string): Errors.CLIError {
  return new Errors.CLIError(message, { exit: 2 });
}
