import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A large error message, through a pipe, arriving complete.
 *
 * **What this file is worth, and what it is not -- both measured 2026-09-14.** It drives the real
 * binary and compares what a pipe delivered against what a file got, which is the strongest
 * end-to-end statement available about delivery of a large message. What it is NOT is a check on
 * `installPipeGuards`: removing the call from `src/bin.ts` -- mutation M8 -- changes nothing here.
 * Measured in both directions on this file's own fixture (type `demanding`, 240 required
 * properties): 75,441 bytes in all 24 runs -- eight through an attentive reader, four through a
 * reader that does not read for a full second, each with the guard installed and with it removed.
 * The 2,000-property variant of the same fixture behaves the same way at 628,078 bytes (n=4 each).
 * Byte-identical, every arm.
 *
 * **Why that is so, and the part of it that is not known.** The mechanism is real: a bare
 * `process.stderr.write('x'.repeat(400001)); process.exit(2)` does lose its tail with the fix
 * absent -- 65,536 bytes in 10 of 10 runs through `spawnSync`, and 131,072 through a shell pipe.
 * So libuv does drop what it has not pushed. What differs inside the real CLI is that its write
 * has already completed before `process.exit` runs: instrumented in ascend's own process, the
 * single 75,441-byte write returns `true` with `writableLength === 0`. A pipe that is never
 * drained absorbs 131,072 bytes here and blocks at 400,001, so the 628,078-byte arm arriving whole
 * through a reader that is asleep for a second means that write waited for the reader rather than
 * being dropped. The write on this path is therefore already synchronous, without the guard.
 * WHICH layer makes it so is NOT identified, and is recorded as an open question rather than
 * explained away.
 *
 * **So the file pins the property, not the install.** It will fail if a future change to the write
 * pattern, to oclif, or to Node stops the message arriving whole -- which is worth having. It
 * cannot today distinguish the guard present from the guard absent, and saying so is the point: a
 * test believed to be a guard when it is not is the false-green class this project treats as
 * severity-zero. The guard itself IS covered by effect, by the arms at the bottom of this file
 * that call it directly.
 *
 * **Why `record`, and a fixture with 240 required properties.** The loss happens on the
 * error path specifically, because oclif renders an error with ONE `console.error()` and then calls
 * `process.exit()`: a single large write is the shape libuv has least of pushed when the process
 * dies. A message under the pipe capacity is never affected, so the fixture has to be genuinely
 * over it -- and `asc record` against a type declaring many required properties is the one real
 * command that produces such a message, at one line per missing property. Nothing here is
 * synthetic: no wrapper script, no `repeat(400_000)`, just the product being wrong in a way that
 * produces a long report.
 *
 * **The assertion is `piped === file`, not a byte count.** A hardcoded expectation would have to be
 * updated every time the wording of the message changed, and would pass just as happily if BOTH
 * paths truncated identically. Comparing the two delivery mechanisms against each other is the
 * property that actually matters -- the message is the same message, and the pipe did not eat it.
 *
 * **This paragraph used to claim a mutation result, and the claim did not hold.** It said that with
 * `makeWritesSynchronous` removed the piped arm fell short of the file arm "every run", landing on
 * 65,536 or 131,072 (n=15: 65,536 x8, 131,072 x7). Re-measured 2026-09-14, with the whole call
 * removed from `bin.ts` and the build verified by grep: the piped arm equals the file arm in every
 * arm tried -- see the header above for the numbers. That recorded distribution is not reproduced
 * by the current binary, and nothing here now rests on it. The truncation numbers that DO reproduce
 * are the bare-mechanism ones in the header, which are the ones quoted there.
 */

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const bin = join(root, 'packages/cli/dist/bin.js');

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b'], {
    cwd: root,
    stdio: 'pipe',
  });
});

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const env = (dir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: dir,
  XDG_CACHE_HOME: join(dir, '.cache'),
});

const TYPE = 'demanding';

/**
 * How many required properties the fixture declares.
 *
 * Derived from a measurement rather than picked for roundness: `asc record` renders one line per
 * missing required property, and each line with its prose runs roughly 314 bytes, so the message
 * crosses the pipe's capacity somewhere near 210 properties. 240 lands at 75,441 bytes -- over the
 * line with margin, so that re-wording the message does not quietly drop this test back under the
 * threshold where it would pass without testing anything. The first test asserts that margin
 * rather than trusting this paragraph.
 */
const REQUIRED_PROPERTIES = 240;

/**
 * The pipe capacity, which is what a truncation lands on.
 *
 * Measured on this platform, not assumed: a single 400,001-byte write to stderr followed by
 * `process.exit(2)` delivers exactly this many bytes, and `asc record` against an over-long error
 * delivered exactly this many bytes too. It is a property of the OS pipe, so it is the number the
 * fixture has to beat -- and the number a broken fix would produce.
 */
const PIPE_CAPACITY_BYTES = 65_536;

/**
 * The document every arm feeds, kept in a FILE so each arm sends identical bytes.
 *
 * It is a file rather than a `spawnSync` `input` string because the early-leaving-reader arm needs
 * shell redirection -- that is the usage at risk, and the only way to put `head` on the far end --
 * and a fixture reachable two ways is a fixture that can drift. Measured, and the reason this
 * matters: that arm originally redirected from `/dev/null`, which made `asc record` fail with a
 * 78-byte message instead of the 75,441-byte one, so it had never once asked the hang question of a
 * large write while looking exactly like it had. One file, one source of bytes.
 */
let inputFile: string;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'asc-8pp-'));
  dirs.push(dir);
  // `.git` as a plain directory rather than `git init`: `init` only asks whether the path exists,
  // so the fixture does not depend on git or on a global config.
  mkdirSync(join(dir, '.git'));

  const init = spawnSync(process.execPath, [bin, 'init'], {
    cwd: dir,
    encoding: 'utf8',
    env: env(dir),
  });
  expect(init.status).toBe(0);

  const properties = Array.from({ length: REQUIRED_PROPERTIES }, (_, index) => ({
    name: `field_${String(index).padStart(3, '0')}`,
    type: 'string',
    required: true,
  }));
  const prose = Object.fromEntries(
    properties.map((property) => [
      property.name,
      `What ${property.name} measured, in enough words to matter: this sentence exists so the ` +
        `error message that lists it has realistic length rather than padding.`,
    ]),
  );

  const define = spawnSync(process.execPath, [bin, 'types', 'define', '-'], {
    cwd: dir,
    encoding: 'utf8',
    env: env(dir),
    input: JSON.stringify({ name: TYPE, properties, prose }),
  });
  // Setup asserted rather than assumed: a fixture that failed to define would make every test
  // below fail for a reason that has nothing to do with truncation.
  expect(define.status).toBe(0);

  inputFile = join(dir, 'input.json');
  writeFileSync(inputFile, JSON.stringify({ properties: {} }));
});

/** The failing `record`, with stderr delivered through a PIPE. This is the arm at risk. */
function pipedStderr(): Buffer {
  // No `encoding`, so stdout and stderr come back as Buffers -- which is the unit that matters
  // here. A `utf8` round trip would count CHARACTERS, and the message contains `›` and `…`, so
  // comparing character counts against a file's byte count would show a loss that isn't there.
  // That mistake was made and caught once already; the comment is here so it is not made again.
  const result = spawnSync(process.execPath, [bin, 'record', TYPE, '-'], {
    cwd: dir,
    env: env(dir),
    input: readFileSync(inputFile),
  });
  return result.stderr;
}

/**
 * The identical command, with stderr redirected to a FILE.
 *
 * The control, and the reason this test can assert anything: a file is written synchronously by
 * the OS, so `process.exit()` cannot outrun it. Whatever this returns is what the process meant to
 * say, which makes it the reference the pipe is measured against.
 */
function fileStderr(): Buffer {
  const out = join(dir, `stderr-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(out, 'w');
  try {
    spawnSync(process.execPath, [bin, 'record', TYPE, '-'], {
      cwd: dir,
      env: env(dir),
      input: readFileSync(inputFile),
      stdio: ['pipe', 'pipe', fd],
    });
  } finally {
    closeSync(fd);
  }
  return readFileSync(out);
}

describe('an error message larger than a pipe', () => {
  it('is larger than the pipe, or this file proves nothing', () => {
    // The precondition that keeps this suite honest. If the message ever shrinks below the pipe
    // capacity, both arms deliver it whole and every assertion below passes while testing
    // nothing at all -- the exact false-green this project treats as severity-zero. So the fixture
    // asserts its own relevance, and its failure names the reason.
    const size = fileStderr().length;
    const capacity = String(PIPE_CAPACITY_BYTES);

    expect(
      size,
      `the fixture's error message is ${String(size)} bytes, which does not exceed the ` +
        `${capacity}-byte pipe. Raise REQUIRED_PROPERTIES: below the pipe capacity ` +
        `no truncation is possible, so the tests in this file would pass without the fix.`,
    ).toBeGreaterThan(PIPE_CAPACITY_BYTES);
  });

  it('arrives whole through a pipe, byte for byte', () => {
    const whole = fileStderr();
    const piped = pipedStderr();

    // Stated as a difference before it is stated as a boolean, so a failure reports the size of
    // the loss and where the pipe stopped rather than only that two buffers differed.
    if (!piped.equals(whole)) {
      expect({
        lost: whole.length - piped.length,
        stoppedAt: piped.subarray(-80).toString('utf8'),
        shouldContinue: whole.subarray(piped.length, piped.length + 80).toString('utf8'),
      }).toEqual({ lost: 0 });
    }

    expect(piped.equals(whole)).toBe(true);
  });

  it('does not hang when the reader leaves early, nor turn a failure into a success', () => {
    // Two hazards, one arm, because they are the two ways a large early-abandoned write can go
    // wrong and the same pipeline measures both.
    //
    // HANG: making writes synchronous means a write to a FULL pipe waits for the reader, so a
    // reader that leaves early could turn a truncated message into no message at all -- trading a
    // wrong answer for no answer. The timeout is what turns a hang into a failure.
    //
    // FALSE SUCCESS: the EPIPE guard exits 0, reasoning that "the reader took what it wanted, so
    // the command succeeded". That reasoning does not hold for a command that FAILED -- the
    // `record` here is missing 240 required properties -- and exit 0 for it would be exactly the
    // false-green class this project treats as severity-zero.
    //
    // `bash` and `pipefail` because a pipeline's status is otherwise `head`'s, which is 0 whatever
    // ascend did. That is the difference between measuring the thing and measuring the pipe.
    const script = [
      'set -o pipefail',
      `"${process.execPath}" "${bin}" record ${TYPE} - < "${inputFile}" 2>&1 | head -c 10 >/dev/null`,
      'echo "ascend=$?"',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: env(dir),
      timeout: 20_000,
    });

    // `error` is set only when the child could not be run or was killed -- on a timeout it is an
    // ETIMEDOUT error -- so this together with the null signal is the hang check, and the message
    // is what a reader needs when it fires.
    expect(
      result.error,
      'the pipeline was killed at the timeout: the fix made it hang',
    ).toBeUndefined();
    expect(result.signal).toBe(null);

    // Deterministic rather than a race, measured n=15: exit 1 in 15 of 15, matching the attentive
    // reader's 1. oclif's handler reaches `process.exit(1)` before the deferred stream `error`
    // event can be delivered, so the guard never gets the chance to launder it. That ordering is
    // what makes this true, and an ordering is a thing a change can quietly alter.
    expect(result.stdout.trim()).toBe('ascend=1');
  });
});

/**
 * `installPipeGuards` reaches BOTH streams, asserted by effect rather than by reading the list.
 *
 * **Why this needs its own test, when `streams.test.ts` already covers `makeWritesSynchronous`.**
 * Those tests prove the function blocks a handle it is given; they say nothing about *which* handles
 * `installPipeGuards` chooses to give it. The mutation that removes `process.stdout` from that list
 * survives every test above -- the integration test drives stderr, because stderr is where the bug
 * was measured. This closes that hole, and it is the hole that matters most: the stdout half of the
 * fix is insurance against a hazard no current command reaches, so nothing else would notice it
 * being dropped.
 *
 * **By effect, not by inspection, and that distinction was earned.** A first attempt asserted on
 * `process.stdout._handle.setBlocking` being *called*, which is not observable: `isBlocking` is
 * `undefined` before and after (measured, under a pipe and a terminal), so the handle offers no
 * readback of its own state. This drives the real thing instead -- the built library, a real pipe,
 * a real exit -- which is the `empirical-planning` rule about validating by driving the actual path
 * rather than a fake of it.
 *
 * **Measured: 15 runs each way.** With stdout in the list, 400,001 bytes reach the reader in 15 of
 * 15; with it removed, 65,536 or 131,072 in 15 of 15 -- quantised by pipe capacity, never whole. So
 * the assertion below is deterministic in both directions rather than a race that usually lands.
 */
describe('installPipeGuards, on each stream', () => {
  it.each(['stdout', 'stderr'] as const)('covers %s', (stream) => {
    // A subprocess that reaches for the REAL installed guard, writes more than a pipe can hold in
    // one call -- the shape oclif's error handler produces -- and then exits the way it does.
    // 400,001 is the same payload the mechanism was measured with, so the number in the comment
    // above and the number here are the same number.
    const arm = join(dir, `arm-${stream}.mjs`);
    writeFileSync(
      arm,
      `import { installPipeGuards } from ${JSON.stringify(join(root, 'packages/cli/dist/index.js'))};\n` +
        `installPipeGuards();\n` +
        `process.${stream}.write('x'.repeat(400001));\n` +
        `process.exit(2);\n`,
    );

    const result = spawnSync(process.execPath, [arm], {
      cwd: dir,
      env: env(dir),
      // spawnSync reads the pipe to EOF, which is the attentive reader these arms are measured
      // with. 1 MB is the default and comfortably over the payload; stated for the next reader.
      maxBuffer: 4 * 1024 * 1024,
    });

    // Both are Buffers (no `encoding`), so the length is BYTES -- the same unit the payload was
    // written in and the same unit a truncation is quantised in. Reported as a pair so a failure
    // names the stream and the count it fell short by, rather than only that two values differed.
    const delivered = stream === 'stdout' ? result.stdout.length : result.stderr.length;
    expect({ stream, delivered }).toEqual({ stream, delivered: 400_001 });
  });
});
