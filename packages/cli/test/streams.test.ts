import { guardBrokenPipes, makeWritesSynchronous, type ErrorEmitting } from '@ascend/cli';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

beforeAll(() => {
  // `@ascend/cli` resolves to `dist/`, so without this every arm below would exercise whatever was
  // built last -- green against a source tree it never read. Every other CLI test file builds for the
  // same reason. `scripts/mutate.mjs` depends on it too: a killer that does not build its own mutant
  // reports a false survivor, and this file is a killer for `scripts/mutations/pipe-guard-errno.json`.
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

/**
 * The broken-pipe guard and the synchronous-write guard, tested as logic.
 *
 * **What this does and does not prove.** `cli.test.ts` drives the real binary, and its
 * closing note explains why that file cannot test EPIPE: a 64 KiB pipe buffer swallows
 * everything `types list` can print, so `asc ... | head -1` would pass whether or not the
 * guard existed. That is the *trigger* -- a closed pipe delivered by the OS.
 *
 * **The trigger is now available, and it is used rather than only described.** `asc query`
 * (`asc-6ct`) overruns the buffer, so `query.test.ts` closes the pipe for real and asserts the exit
 * code and stderr end to end. That arm is honest but PROBABILISTIC: measured 2026-10-13, the crash it
 * catches fired in 3 of 300 runs, so a single run catches a regression about one time in a hundred.
 * The deterministic half lives here, and it is the half that decides.
 *
 * What is proven here, cheaply and without the trigger, is the decision: given a reader that went
 * away the process exits 0, and given anything else it does not. A fake stream emits exactly the
 * event the OS would, which is the difference between "the handler looks right" and "the handler
 * does what it claims". **That set is `EPIPE` and `ENOTCONN`, not `EPIPE` alone** -- the second code
 * is the whole of `asc-zimu`, and the arm below that asserts it is the one that would have failed
 * before it was understood.
 *
 * **The truncation guard is tested here as a decision and there as an effect**, and the split is
 * deliberate. What is asserted below is that a handle which can be made blocking IS made blocking
 * and counted, and that one which cannot is skipped rather than fatal -- the branches, with fakes.
 * What is NOT asserted here is any count for the real process streams, because the honest count
 * depends on how they are wired: measured, it is 2 under a pipe or a terminal and 0 when stdout
 * and stderr are redirected to a file, where writes are already synchronous. `8pp-truncation.test.ts`
 * is where the real thing is driven, and it is the stronger test of the two: it does not care
 * whether the mechanism is `setBlocking` or anything else, only that a 75 KB error message arrives
 * through a pipe byte for byte.
 */

/** A stream that can be made to emit whatever the test wants. */
function fakeStream(): ErrorEmitting & { fail(error: unknown): void } {
  let listener: ((error: unknown) => void) | undefined;
  // Both registration methods behave identically here on purpose. Listener ORDER is the property
  // that matters, and no fake can model it -- `EventEmitter` already does, and the arm that tests
  // precedence uses a real one. This fake exists for the decision about the CODE.
  const record = (event: 'error', next: (error: unknown) => void): void => {
    expect(event).toBe('error');
    listener = next;
  };
  return {
    on: record,
    prependListener: record,
    fail(error: unknown): void {
      if (listener === undefined) throw new Error('no error listener was registered');
      listener(error);
    },
  };
}

/** A stream plus the codes `exit` was called with. */
function harness(): {
  readonly stream: ErrorEmitting & { fail(error: unknown): void };
  readonly exits: number[];
} {
  const exits: number[] = [];
  const stream = fakeStream();
  guardBrokenPipes([stream], { exit: (code) => exits.push(code) });
  return { stream, exits };
}

describe('the broken-pipe guard', () => {
  it('exits 0 when the reader closed the pipe', () => {
    const { stream, exits } = harness();

    // Shaped like the real thing: Node's stream errors carry `code`, and it is the only
    // property the guard reads. `asc ... | head -1` is a successful command.
    stream.fail(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(exits).toEqual([0]);
  });

  it('exits 0 when an abrupt reader close arrives as ENOTCONN instead', () => {
    const { stream, exits } = harness();

    // **The arm that was missing, and the reason the guard was wrong for a year of green runs.**
    // Measured through the real binary 2026-10-13 (Darwin 25.3.0, Node v24.18.0): a reader that
    // GRACEFULLY closes -- `asc query ... | head -1`, 150 runs -- produces EPIPE or nothing at all.
    // A reader that destroys the read end while the child is mid-write produces ENOTCONN (errno -57)
    // in 3 of 300 runs. Exiting sends a FIN; `destroy()` sends an RST, and the write on the far side
    // of an RST is reported as a socket that is not connected. Same situation, different errno.
    stream.fail(Object.assign(new Error('write ENOTCONN'), { code: 'ENOTCONN' }));

    expect(exits).toEqual([0]);
  });

  it('answers before a handler that was registered earlier and would rethrow', () => {
    // **Ordering, not just the code, and this is the half that a code-only fix misses.** oclif
    // installs `process.stdout.on('error', ...)` -- EPIPE or rethrow -- when its `Command` module
    // loads, which is before ascend's entry point runs. EventEmitter calls listeners in registration
    // order and stops at the first that throws, so registering with `on` means oclif answers first
    // and rethrows ENOTCONN. Measured on the real binary: accepting ENOTCONN with `on` left the crash
    // at 2 of 300 runs; with `prependListener`, 0 of 600. A real EventEmitter is used here rather than
    // a fake because listener ORDER is the property, and a fake would have to reimplement it.
    const stream = new EventEmitter();
    const seen: string[] = [];
    stream.on('error', (error: unknown) => {
      // oclif's handler in shape AND in position: registered first, and it rethrows anything that is
      // not EPIPE -- which is what turns an unhandled ENOTCONN into a Node crash dump.
      seen.push('the handler installed before ascend');
      throw error;
    });
    const stop = new Error('process.exit does not return');
    guardBrokenPipes([stream], {
      // Models `process.exit`: it never returns, so the emit loop cannot reach the handler above.
      exit: (code) => {
        seen.push(`exit ${String(code)}`);
        throw stop;
      },
    });

    let caught: unknown;
    try {
      stream.emit('error', Object.assign(new Error('write ENOTCONN'), { code: 'ENOTCONN' }));
    } catch (thrown: unknown) {
      caught = thrown;
    }

    expect(caught).toBe(stop);
    expect(seen).toEqual(['exit 0']);
  });

  it('lets a real stream failure through instead of reporting success', () => {
    const { stream, exits } = harness();

    // The false-green this guard must not create: an output stream that failed because the
    // disk is full would, if swallowed, look exactly like a command that succeeded.
    expect(() => {
      stream.fail(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
    }).toThrow('no space left on device');

    expect(exits).toEqual([]);
  });

  it('does not mistake a value with no code for a broken pipe', () => {
    // Nothing stops a stream from emitting a string, `null` or `undefined`, and the guard
    // reads `.code` from whatever arrives -- through an optional chain, so absent values are
    // read safely rather than crashing the handler. `null` and `undefined` are in this list
    // because they are the values the optional chain exists for.
    for (const value of ['not an error at all', null, undefined]) {
      const { stream, exits } = harness();

      // Asserted with an explicit `try`/`catch` rather than `expect(...).toThrow()`: the
      // guard rethrows the ORIGINAL value, which may itself be `undefined`, and whether a
      // matcher counts a thrown `undefined` as having thrown is a detail of the matcher.
      // This states what happened without depending on that.
      const notThrown = Symbol('the guard swallowed the error');
      let caught: unknown = notThrown;
      try {
        stream.fail(value);
      } catch (thrown: unknown) {
        caught = thrown;
      }

      // Rethrown identically -- not wrapped, not stringified -- so the process's uncaught
      // path reports what actually went wrong.
      expect(caught).toBe(value);
      expect(exits).toEqual([]);
    }
  });
});

/**
 * A stream that can be made blocking, and the calls it received.
 *
 * The shape mirrors the real one rather than an idealised one: `_handle` is read as the private,
 * possibly-absent property that it is, so a fake with no handle at all is expressible -- which is
 * the case that matters, because it is the one that must not crash.
 */
function fakeHandle(): {
  readonly calls: boolean[];
  readonly _handle: { setBlocking(blocking: boolean): void };
} {
  const calls: boolean[] = [];
  return {
    calls,
    _handle: {
      setBlocking(blocking: boolean): void {
        calls.push(blocking);
      },
    },
  };
}

describe('the synchronous-write guard', () => {
  it('makes a stream block, and reports that it did', () => {
    const first = fakeHandle();
    const second = fakeHandle();

    const made = makeWritesSynchronous([first, second]);

    // The count is the observable, and it is a count rather than nothing on purpose: a function
    // that silently did nothing would be indistinguishable from one that worked, which is the
    // false-green class this project treats as severity-zero.
    expect(made).toBe(2);
    expect(first.calls).toEqual([true]);
    expect(second.calls).toEqual([true]);
  });

  it('counts only the streams it actually changed', () => {
    const usable = fakeHandle();

    // A mixed list, which is what the real one is whenever a stream cannot be changed: the
    // unusable entries must neither be counted nor abort the ones that follow them.
    const made = makeWritesSynchronous([usable, {}, { _handle: undefined }, { _handle: null }]);

    expect(made).toBe(1);
    expect(usable.calls).toEqual([true]);
  });

  it('skips a stream it cannot change instead of failing to start', () => {
    // Measured rather than imagined: a process whose stdout and stderr are redirected to a FILE
    // has `_handle` undefined on both. 0 is the correct answer there, not a failure -- a file
    // descriptor's writes are already synchronous, so there is nothing queued to lose. Throwing
    // would turn an unsupported private API into a CLI that cannot run at all.
    expect(makeWritesSynchronous([{}, { _handle: null }, { _handle: undefined }])).toBe(0);

    // And a handle that exists but offers no `setBlocking`. Same rule, different reason: the
    // property is private, so a Node that keeps the handle and drops the method is a shape this
    // has to survive rather than a shape it may assume away.
    expect(makeWritesSynchronous([{ _handle: {} }])).toBe(0);
  });

  it('never turns blocking off', () => {
    const handle = fakeHandle();

    makeWritesSynchronous([handle, handle]);

    // Said explicitly because the inverse call is a plausible future edit that would look
    // symmetric and would reintroduce the truncation: only `true` is ever passed.
    expect(handle.calls).toEqual([true, true]);
  });
});
