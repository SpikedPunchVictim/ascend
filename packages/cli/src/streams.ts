/**
 * What to do when the process's own output streams fail, and what to do so that they do not.
 *
 * **EPIPE.** `asc query ... | head -1` closes stdout while ascend is still writing. Node's
 * default response to a write on an already-closed pipe is to emit an `error` event on the
 * stream, which with no listener becomes an unhandled error and prints a stack trace -- so
 * the most ordinary pipeline in Unix turns a working command into an error report. The
 * reader closed the pipe deliberately, having taken what it wanted, so exiting 0 is the
 * honest answer: the command succeeded and its output was consumed. Nothing is written on
 * the way out, because stdout is gone and stderr may be too.
 *
 * **TRUNCATION, which is the other half.** For a PIPE on POSIX, Node writes asynchronously: it
 * hands bytes to libuv and returns. `process.exit()` -- which oclif's error handler always ends with
 * (`errors/handle.js`, `Exit.exit`) -- terminates the process without waiting for libuv to finish
 * pushing them, so whatever is still queued is LOST, silently, with the exit code unchanged.
 *
 * **Measured on the mechanism, which is the version that reproduces.** A single
 * `process.stderr.write('x'.repeat(400001))` followed by `process.exit(2)` delivers 65,536 bytes
 * through a `spawnSync` pipe in 12 of 12 runs, and 131,072 through a shell pipe (`... | head -c 1`),
 * against all 400,001 when the same bytes go to a FILE. Nothing reports that anything was dropped.
 * A pipe that is never drained absorbs 131,072 bytes here and blocks at 400,001, so the 65,536 is
 * libuv giving up on a full pipe rather than a cap on the message.
 *
 * **On the real binary it does NOT reproduce today, and this paragraph used to say it did.** The
 * earlier text stated that `asc record` against a type with 240 required properties delivers
 * "exactly 65,536 bytes" through a pipe. Re-measured 2026-09-14, with the whole guard removed from
 * `src/bin.ts`: that command delivers all 75,441 bytes -- 24 of 24 runs, an attentive reader and one
 * asleep for a full second, guard installed and removed -- and 628,078 bytes for a 2,000-property
 * variant of the same fixture. Instrumented inside ascend, the single write returns `true` with
 * `writableLength === 0`, so it has already completed before `process.exit` runs. WHICH layer makes
 * that path complete when the bare mechanism above does not is an open question, recorded as one.
 *
 * **It is not a cap on the message, and the distinction is load-bearing.** The loss is whatever
 * libuv has not yet pushed, so it depends on the WRITE PATTERN, not the size. Measured, same
 * `process.exit(2)`: as ONE write of 400,001 bytes, 65,536 arrive; as 400 writes of 1,000 bytes, all
 * **400,000** arrive; as one write of 18,920 bytes, all 18,920 arrive -- each in 12 of 12 runs.
 * oclif renders an error with a single `console.error(pretty)`, which is why the error path is the
 * one at risk, and why a message smaller than a pipe is never affected at all.
 *
 * **The fix makes the writes synchronous, so there is nothing left queued to lose.**
 * `_handle.setBlocking(true)` on a pipe makes libuv complete the write before returning, which
 * `process.exit()` can no longer interrupt. Cost, measured on the hot read path: `asc query` on a
 * 9.8 MB result took a median 447 ms with both streams blocking against 472 ms without -- within
 * noise, and both delivered all 9,800,061 bytes. The alternative is a reader that stops early, and
 * that was measured too: `asc ... 2>&1 | head -c 10` completes and does NOT hang with blocking on.
 *
 * **`_handle` is underscored, so this is a private API, and the guard is shaped for that.** It is
 * read through an optional chain and skipped when absent, so a Node that renames or removes it
 * leaves the process working rather than throwing. That does mean a future Node could quietly
 * restore the bug, and **a future Node is not the only way to lose it: no end-to-end test here
 * would notice.** Measured 2026-09-14: removing the whole `installPipeGuards()` call from
 * `src/bin.ts` leaves every arm of `test/8pp-truncation.test.ts` byte-identical -- 75,441 bytes
 * through an attentive reader and through one asleep for a second, 24 runs out of 24 both ways, and
 * 628,078 for the 2,000-property variant. The real CLI's error write already completes before
 * `process.exit` on that path, by a mechanism that was NOT identified. So the lever is covered by effect exactly where it
 * can be -- the arms that call this function directly, which do fail when it stops making a stream
 * block -- and the rest is recorded rather than papered over. `test/8pp-truncation.test.ts` carries
 * the same measurement at the site.
 *
 * **SIGINT is deliberately NOT handled.** Node's default is to terminate on the signal,
 * which a shell reports as 130, and a store write is a single SQLite transaction, so an
 * interrupt mid-record rolls back rather than leaving a half-written entry. A handler here
 * would replace a correct inherited behaviour with a hand-written copy of it.
 *
 * **The decisions are a module of their own rather than a few lines at the top of the entry
 * point** so that they can be tested without a process: `test/streams.test.ts` hands
 * `guardBrokenPipes` a fake stream and observes the exit code, and hands `makeWritesSynchronous` a
 * fake handle and observes the call. That is the difference between the handler doing what it
 * claims and the handler looking like it does. The entry point (`src/bin.ts`) calls
 * `installPipeGuards` -- the only function here that touches `process` -- and does nothing else
 * with streams.
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
 * The property Node actually uses, declared here because nothing declares it anywhere else.
 *
 * `_handle` is not described by `@types/node` -- searched all of it (22.20.2): the string appears
 * only in `v8.d.ts`'s unrelated `handles_size` fields, never in `stream.d.ts`, `net.d.ts` or
 * `tty.d.ts`. So no import would type these two lines, which is why the shape is written down in
 * ascend rather than imported, and why `makeWritesSynchronous` takes `unknown` and narrows to
 * this: the shape and the check are then one thing that cannot drift.
 */
export interface BlockingCapable {
  /**
   * Node's stream handle -- private, hence the underscore, and absent for a stream that has no
   * handle at all (a `process.stderr` that was closed or replaced before this runs).
   */
  readonly _handle?: { readonly setBlocking?: (blocking: boolean) => void } | null | undefined;
}

/**
 * Make each stream's writes complete before they return, so `process.exit()` cannot truncate them.
 *
 * **The count is not a fixed number, and the reason is worth knowing before "fixing" it.** Measured
 * by wiring the same process three ways: stdout and stderr are `Pipe` handles under a pipe and `TTY`
 * handles under a terminal, and both carry `setBlocking` -- so the count is 2. Redirected to a FILE,
 * `_handle` is `undefined` and the count is 0 -- and 0 is correct there, because a file descriptor's
 * writes are already synchronous and there is nothing queued for `process.exit()` to lose. So the
 * count reports what was needed, not what was found, and a test asserting it is always 2 would be
 * asserting a bug.
 *
 * **Takes `unknown`, and that is the honest signature rather than a looseness.** The property being
 * reached for is not in any type declaration (see `BlockingCapable`), so a `readonly BlockingCapable[]`
 * parameter would not accept `process.stdout` at all -- TypeScript rejects it as a weak type with no
 * properties in common. Casting at the call site would move the fiction to the one place with the least
 * context to explain it; narrowing here keeps the declared shape and the runtime check side by side,
 * which is the same shape as the EPIPE cast above.
 *
 * Skipped rather than fatal when the handle or the method is missing. This is an unsupported API,
 * and "the output is not synchronous" is a degradation, not a reason to refuse to run -- throwing
 * here would turn a private-API change into a CLI that cannot start at all. **There is deliberately
 * no `try`/`catch` around the call, and that is a measurement rather than an oversight:** the two
 * realistic failure shapes were driven directly -- a live connected socket and that same socket
 * after `destroy()` -- and `setBlocking(true)` returned normally in both. A stream whose handle is
 * gone loses its `_handle` entirely (that is the file case above), so it is skipped before the call
 * rather than blowing up inside it. Catching would guard a branch no input reaches, and the guard
 * that IS needed is the `typeof` check that is already there.
 */
export function makeWritesSynchronous(streams: readonly unknown[]): number {
  let made = 0;
  for (const stream of streams) {
    const handle = (stream as BlockingCapable | null | undefined)?._handle;
    if (typeof handle?.setBlocking !== 'function') continue;
    handle.setBlocking(true);
    made += 1;
  }
  return made;
}

/**
 * Install every stream guard on this process: the broken-pipe handler and synchronous writes.
 *
 * The only function here that touches `process`, kept separate so the decisions above can be
 * tested without spawning anything or taking over a real stream.
 *
 * **Both streams, not just stderr, and the evidence rather than symmetry.** stderr is where the
 * truncation was measured, because oclif always ends its error handler with `process.exit()`. But
 * stdout has the same exposure on that path: oclif's `execute()` is `run().then(flush).catch(handle)`,
 * so `flush()` -- which waits for a stdout drain -- runs on SUCCESS only, and `.catch(handle)` writes
 * to stderr and never flushes stdout. A command that printed more than a pipe holds and then threw
 * would lose the tail the same way.
 *
 * **On stdout the EPIPE half of this duplicates oclif, and that was measured rather than assumed.**
 * `@oclif/core/lib/command.js:57` registers `process.stdout.on('error', ...)` with exactly this
 * decision -- return on `EPIPE`, rethrow anything else -- when the `Command` class module loads. So
 * the broken-pipe half of the guard is load-bearing on **stderr**, where a tap on the event showed no
 * other listener, and redundant on stdout, where ascend's exit status and stderr are identical with
 * the handler installed and without it. It stays on both anyway: the duplication costs one listener,
 * the handler is not something ascend controls the lifetime of, and a guard that covers the stream the
 * bug was *not* measured on is the wrong half to drop.
 *
 * **That was reasoned once and has since been measured, which is the version to trust.** The same
 * one-write-then-`process.exit(2)` payload sent to STDOUT -- 400,001 bytes, attentive reader --
 * arrives as 65,536 or 131,072 bytes with no blocking (n=15: 65,536 x14, 131,072 x1) and as all
 * 400,001 in 15 of 15 with it. So stdout is not covered by analogy; it truncates identically, and
 * `test/8pp-truncation.test.ts` drives both streams through this function to keep it that way.
 * Blocking costs nothing measurable on the read path either (9.8 MB in a median 447 ms blocked
 * against 472 ms not, both delivering every byte), so closing the class costs less than the
 * reasoning required to leave half of it open.
 */
export function installPipeGuards(): void {
  guardBrokenPipes([process.stdout, process.stderr], { exit: (code) => process.exit(code) });
  makeWritesSynchronous([process.stdout, process.stderr]);
}
