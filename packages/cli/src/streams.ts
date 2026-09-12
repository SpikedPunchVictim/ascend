/**
 * What to do when the process's own output streams fail.
 *
 * **EPIPE.** `asc query ... | head -1` closes stdout while ascend is still writing. Node's
 * default response to a write on an already-closed pipe is to emit an `error` event on the
 * stream, which with no listener becomes an unhandled error and prints a stack trace -- so
 * the most ordinary pipeline in Unix turns a working command into an error report. The
 * reader closed the pipe deliberately, having taken what it wanted, so exiting 0 is the
 * honest answer: the command succeeded and its output was consumed. Nothing is written on
 * the way out, because stdout is gone and stderr may be too.
 *
 * **The decision is a module of its own rather than a few lines at the top of the entry
 * point** so that it can be tested without a process: `test/streams.test.ts` hands
 * `guardBrokenPipes` a fake stream and observes the exit code, which is the difference
 * between the handler doing what it claims and the handler looking like it does. The entry
 * point (`src/bin.ts`) calls `installPipeGuards` -- the only function here that touches
 * `process` -- and does nothing else with streams.
 *
 * **SIGINT is deliberately NOT handled.** Node's default is to terminate on the signal,
 * which a shell reports as 130, and a store write is a single SQLite transaction, so an
 * interrupt mid-record rolls back rather than leaving a half-written entry. A handler here
 * would replace a correct inherited behaviour with a hand-written copy of it.
 */

/** The minimum surface this needs from a stream. Narrow so a test can supply a fake. */
export interface ErrorEmitting {
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface PipeGuardDeps {
  readonly exit: (code: number) => void;
}

/**
 * Exit 0 on a broken pipe; let every other stream error through.
 *
 * Swallowing a non-EPIPE error would be the worst outcome available: an output stream that
 * failed for a real reason (ENOSPC, EIO) would then look exactly like a command that
 * succeeded, which is the false-green class this project treats as severity-zero.
 */
export function guardBrokenPipes(streams: readonly ErrorEmitting[], deps: PipeGuardDeps): void {
  for (const stream of streams) {
    stream.on('error', (error: unknown) => {
      // `unknown` before it is read, and a cast rather than a `try`/`catch`: anything at
      // all can be thrown or emitted in JS, and `EPIPE` is the only shape this acts on.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'EPIPE') {
        deps.exit(0);
        return;
      }
      // Rethrown rather than reported: this runs from an event handler, and the process's
      // uncaught-exception path is what turns an unexpected stream failure into a loud,
      // non-zero exit instead of a silent one.
      throw error;
    });
  }
}

/**
 * Install the guard on this process's stdout and stderr.
 *
 * The only function here that touches `process`, kept separate so the decision above can be
 * tested without spawning anything or taking over a real stream.
 */
export function installPipeGuards(): void {
  guardBrokenPipes([process.stdout, process.stderr], { exit: (code) => process.exit(code) });
}
