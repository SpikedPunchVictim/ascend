import { StoreBusyError } from '@ascend/store';
import { describe, expect, it } from 'vitest';
import { describeDriverError } from '../src/driver-errors.js';

/**
 * The layer under the store, asserted where it is a function.
 *
 * asc-tno: four raw driver strings reached the user with no context and no fix, all four reproduced
 * against the real binary. This file covers the mapping itself, code by code; the five end-to-end
 * sites are in `driver-errors-cli.test.ts`, driven through the real command line.
 *
 * **Every fixture here is the shape the driver actually throws, written out by hand.** Measured:
 * `node:sqlite` throws a plain `Error` -- `constructor.name === 'Error'`, no `SQLiteError` export --
 * whose own properties are exactly `{ code: 'ERR_SQLITE_ERROR', errcode, errstr }`, and Node's
 * filesystem errors carry `{ code, errno, syscall, path }`. There is no driver class to construct,
 * which is also why the guard is duck-typed rather than an `instanceof`.
 */

/** A sqlite driver error, exactly as measured. */
function sqlite(errcode: number, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code: 'ERR_SQLITE_ERROR', errcode, errstr: message });
  return error;
}

/** A Node filesystem error, exactly as measured on `mkdirSync` onto an existing file. */
function filesystem(code: string, syscall: string, path: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code, syscall, path, errno: -17 });
  return error;
}

describe('a filesystem refusal becomes context, problem and fix', () => {
  it('names the syscall, the path, the code, and what to do', () => {
    // The measured original: `Error: EEXIST: file already exists, mkdir
    // '/private/tmp/tno/.ascend'` -- which reads as an internal assertion rather than as "you have
    // a file where ascend needs a directory".
    const message = describeDriverError(
      filesystem(
        'EEXIST',
        'mkdir',
        '/private/tmp/tno/.ascend',
        "EEXIST: file already exists, mkdir '/private/tmp/tno/.ascend'",
      ),
    );
    expect(message).toContain("ascend ran 'mkdir'");
    expect(message).toContain("'/private/tmp/tno/.ascend'");
    expect(message).toContain('EEXIST');
    // The plain-language problem, which is the part the raw string lacked entirely.
    expect(message).toMatch(/a FILE is already at that path/);
    // And a next step.
    expect(message).toMatch(/Move that file aside/);
  });

  it('reads the path out of the error, not out of the sentence that mentions it', () => {
    // The path is a real property. Getting it by parsing the driver's text would be reading a
    // translation, and would come apart the moment Node reworded it -- so this fixture's message
    // deliberately does NOT contain the path, and the assertion is that the output names it anyway.
    const error = filesystem(
      'EACCES',
      'open',
      '/some/where/ascend.db',
      'EACCES: permission denied',
    );
    expect(error.message).not.toContain('/some/where/ascend.db');
    expect(describeDriverError(error)).toContain("'/some/where/ascend.db'");
  });

  it('explains a code it has no specific advice for WITHOUT inventing advice', () => {
    // The honest branch. A fix line invented for a code nobody has seen is a plausible sentence
    // that sends the caller somewhere; saying so is worse-sounding and better. This is the same
    // rule the store follows when it omits a duration it cannot measure.
    const message = describeDriverError(
      filesystem('EBUSY', 'rename', '/x/y', 'EBUSY: resource busy or locked'),
    );
    expect(message).toContain('EBUSY');
    expect(message).toContain("'/x/y'");
    expect(message).toMatch(/no specific advice for it/);
    // The generic fallback must not borrow a mapped code's advice.
    expect(message).not.toMatch(/Move that file aside/);
  });

  it('declines an E-code with neither a syscall nor a path, so the shape check is a shape check', () => {
    // Without this requirement the branch is a name-prefix guess, and any Node error that happened
    // to carry an `E`-prefixed code would be described as a filesystem refusal.
    const error = new Error('something else entirely');
    Object.assign(error, { code: 'ERR_ASSERTION' });
    expect(describeDriverError(error)).toBeUndefined();

    const ePrefixedAlone = new Error('and this one');
    Object.assign(ePrefixedAlone, { code: 'EBUSY' });
    expect(describeDriverError(ePrefixedAlone)).toBeUndefined();
  });
});

describe('a sqlite refusal becomes context, problem and fix', () => {
  it('names the store path when the file is not a database', () => {
    const message = describeDriverError(sqlite(26, 'file is not a database'));
    expect(message).toContain('file is not a database');
    expect(message).toContain('.ascend/ascend.db');
    expect(message).toMatch(/Move that file aside/);
    expect(message).toContain('asc init');
  });

  it("keeps the driver's own wording, because the code is too coarse to replace it", () => {
    // Code 1 covers `incomplete input` AND `no such table`. Dropping the wording to keep the branch
    // tidy would throw away the only part that says which of the two happened, so this asserts the
    // wording survives for two different messages under the same code.
    for (const wording of ['incomplete input', 'no such table: nope']) {
      const message = describeDriverError(sqlite(1, wording));
      expect(message).toContain(wording);
      expect(message).toContain('code 1');
    }
  });

  it('names the real tables, which is the fix for a statement that named one that is not', () => {
    const message = describeDriverError(sqlite(1, 'no such table: nope'));
    for (const table of [
      'entries',
      'entry_types',
      'annotations',
      'annotation_schemes',
      'meta',
      'entries_fts',
    ]) {
      expect(message).toContain(table);
    }
    expect(message).toContain('asc types list');
  });

  it('masks an EXTENDED code down to its primary one', () => {
    // `SQLITE_READONLY_RECOVERY` is `8 | 256`. The mask lives in the store, and this asserts it
    // reaches the layer that renders the message -- a `=== 8` comparison here would fall through to
    // the generic branch and describe a read-only store as a code with no specific advice.
    const message = describeDriverError(sqlite(8 | 256, 'attempt to write a readonly database'));
    expect(message).toMatch(/read-only/);
    expect(message).not.toMatch(/no specific advice/);
  });

  it('says nothing about a code it does not know, rather than guessing', () => {
    // 19 is SQLITE_CONSTRAINT -- deliberately NOT mapped above, because the store raises its own
    // constraint refusals before the driver's ever escapes. The bead's rule is that an unknown code
    // gets no invented fix, so this asserts the honest branch rather than a missing entry being a
    // gap. 19 also survives the mask unchanged, which is what makes `code 19` the right assertion:
    // a code whose high bytes were dropped would print its masked value and this would read as a
    // pass for the wrong reason.
    const message = describeDriverError(sqlite(19, 'constraint failed'));
    expect(message).toContain('code 19');
    expect(message).toContain('constraint failed');
    expect(message).toMatch(/no specific advice for that code/);
  });
});

describe('what this layer declines', () => {
  it('declines an ordinary Error, so the default that prints it as-is still runs', () => {
    // The store's own refusals are already context -> problem -> fix. Wrapping them would bury the
    // part that was already right, which is the cost this module exists to avoid paying.
    expect(
      describeDriverError(new Error('no type named `decision` is registered')),
    ).toBeUndefined();
  });

  it("declines the store's own busy error, which needs nothing from here", () => {
    expect(describeDriverError(new StoreBusyError('/x/.ascend/ascend.db'))).toBeUndefined();
  });

  it('declines a sqlite error carrying no numeric code at all', () => {
    const error = new Error('driver said something');
    Object.assign(error, { code: 'ERR_SQLITE_ERROR' });
    expect(describeDriverError(error)).toBeUndefined();
  });

  it('declines a non-Error', () => {
    expect(describeDriverError('a string')).toBeUndefined();
    expect(describeDriverError(undefined)).toBeUndefined();
    expect(describeDriverError({ code: 'ERR_SQLITE_ERROR', errcode: 1 })).toBeUndefined();
  });
});
