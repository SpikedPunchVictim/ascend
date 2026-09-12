import { guardBrokenPipes, type ErrorEmitting } from '@ascend/cli';
import { describe, expect, it } from 'vitest';

/**
 * The broken-pipe guard, tested as logic.
 *
 * **What this does and does not prove.** `cli.test.ts` drives the real binary, and its
 * closing note explains why that file cannot test EPIPE: a 64 KiB pipe buffer swallows
 * everything `types list` can print, so `asc ... | head -1` would pass whether or not the
 * guard existed. That is the *trigger* -- a closed pipe delivered by the OS -- and it stays
 * unproven until `asc query` (`asc-6ct`) can overrun the buffer.
 *
 * What can be proven now, cheaply and without that trigger, is the decision: given an
 * EPIPE the process exits 0, and given anything else it does not. A fake stream emits
 * exactly the event the OS would, which is the difference between "the handler looks
 * right" and "the handler does what it claims". The remaining gap is narrow and named,
 * rather than the whole behaviour being asserted by inspection.
 */

/** A stream that can be made to emit whatever the test wants. */
function fakeStream(): ErrorEmitting & { fail(error: unknown): void } {
  let listener: ((error: unknown) => void) | undefined;
  return {
    on(event: 'error', next: (error: unknown) => void): void {
      expect(event).toBe('error');
      listener = next;
    },
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
