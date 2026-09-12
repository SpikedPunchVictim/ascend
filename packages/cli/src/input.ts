/**
 * Where a command's input comes from: a file path, or `-` for stdin.
 *
 * `-` because that is the Unix convention and because it is what makes a pipeline possible
 * without a temporary file -- `asc types export | asc types import -` is the round-trip the
 * document format exists to support.
 *
 * There is deliberately no default. A command that reads stdin when given no operand looks
 * like it is waiting for input when it is actually waiting for a keypress, which is the
 * hang `cli-best-practices` rule 3 exists to prevent; a missing operand is a usage error
 * that names the fix.
 *
 * **Stdin is read as a stream, and that is the correction of a measured defect rather than a
 * preference.** This file previously called `readFileSync(0, 'utf8')`, on the reasoning that the
 * whole document is needed before anything can be validated so an async read buys nothing. The
 * reasoning about *ordering* was fine -- the read completes before the store is touched, so
 * nothing interleaves -- but the mechanism was broken: `read(2)` on a **pipe with nothing in it
 * yet** returns `EAGAIN`, and `readFileSync` surfaces that as a failure instead of waiting. The
 * documented pipeline therefore failed outright:
 *
 *     $ asc types export | asc types import -
 *     Error: nothing could be read from standard input: EAGAIN: resource temporarily unavailable
 *
 * Measured before and after the fix: with a producer that waits 0.3 s and 1.5 s before writing,
 * both fail deterministically; the CLI's own startup is **0.13-0.15 s** (5 runs), so any producer
 * slower than that -- including `asc types export`, which must open a database first -- hits it
 * every time. `spawnSync(..., {input})` in a test does not reproduce it, because the input is
 * buffered before the child starts, which is why the suite was green while the pipeline was not.
 * `packages/cli/test/types.test.ts` now drives a **real `sh` pipeline with a delayed producer**
 * so the empty-pipe case is covered.
 *
 * Why `EAGAIN` instead of blocking: Node puts a piped stdin into non-blocking mode, and the
 * stream machinery here is what copes with that (it waits for readability and resumes). The
 * exact moment Node flips the descriptor is not something this file relies on either way.
 */

import { readFileSync } from 'node:fs';
import { usageError } from './errors.js';

/** The operand meaning "standard input". */
export const STDIN = '-';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Read all of standard input.
 *
 * Iterating `process.stdin` rather than reading fd 0 directly, for the non-blocking reason in the
 * file comment. The chunks arrive as `Buffer`s (no encoding is set anywhere), and concatenating
 * before decoding is what keeps a multi-byte character split across two chunks from being
 * corrupted -- decoding each chunk as it arrives would do exactly that.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    throw usageError(
      `standard input could not be read: ${messageOf(error)}. Pass a file path instead of ` +
        `${STDIN} if you did not mean to pipe a document in.`,
    );
  }

  // Empty input is left to the parser: what arrives on stdin is the *contents* of a document, and
  // contents are data rather than argv (`errors.ts`), so `asc types define - < /dev/null` is a
  // refusal naming what a document must be, not a usage error about the command line. Same answer
  // as an empty file, which is the point -- stdin and a path should not differ in how they fail.
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read `ref`, which is a filesystem path or `STDIN`.
 *
 * Async only because stdin is. The two paths still finish before the caller does anything with
 * the result, so the store's synchronous work is never interleaved with a read in progress.
 */
export async function readInput(ref: string): Promise<string> {
  if (ref === STDIN) return readStdin();

  try {
    return readFileSync(ref, 'utf8');
  } catch (error) {
    throw usageError(`${ref} could not be read: ${messageOf(error)}.`);
  }
}
