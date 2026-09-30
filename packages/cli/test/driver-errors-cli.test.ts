import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Driver errors, driven through the real binary.
 *
 * asc-tno. `driver-errors.test.ts` asserts the mapping where it is a function; this file asserts the
 * thing that made the bead exist -- that the mapping is **reached**, from a command a user would
 * actually type, and that the raw driver string no longer gets through. That distinction is not
 * pedantry here: the branch lives at the top of `errors.ts`'s boundary, and a unit test of
 * `describeDriverError` cannot tell you whether the boundary calls it, calls it too late, or calls
 * it after some earlier branch has already claimed the error. Only the real command line can.
 *
 * **Each site below is a measured leak, quoted in the test that replaces it.** They were reproduced
 * by driving this binary, not inferred from reading code, and the five are deliberately different in
 * kind: two are the operating system (a filesystem refusal, and a store path the OS will not open),
 * and three are SQLite's own codes -- code 1 twice, over two different wordings, and code 26 from a
 * damaged store file.
 *
 * **Every absence assertion is a squashed comparison, and that is a correctness requirement rather
 * than tidiness.** ascend wraps a failure at 80 columns at spaces only (`errors.ts`), so
 * `expect(stderr).not.toContain('Error: incomplete input')` -- the assertion that the old leak is
 * gone -- would PASS on text that contains it split across a line break, which is precisely the
 * false green this project treats as severity-zero. Squashing whitespace out of BOTH sides is what
 * makes that assertion mean what it reads like. The positive assertions run through the same
 * function for the same reason, in the other direction.
 *
 * The break used to be worse than a newline: oclif wrapped with `wrapAnsi(..., { hard: true })` and
 * marked it, so a path arrived as `.../proj-0` then `›V7xm7/proj-0` -- a marker *inside* the token,
 * which is asc-98c. ascend renders its own failures now, so nothing here strips a `›` and the
 * assertions below would fail if one came back.
 *
 * **Every site is asserted at exit 1**, which is the contract: ascend understood the command and
 * could not carry it out. That is distinct from 2, the code for a command line the caller got wrong
 * -- `asc query` handed SQL that will not parse is 1, because the SQL is data the caller supplied,
 * not the command line they typed.
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

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function asc(args: readonly string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Every whitespace run deleted -- so a wrap cannot make either kind of assertion lie.
 *
 * Used on **both** sides of every comparison, which is the point: a phrase and the text it is
 * searched for are reduced the same way, so a break inside a word costs nothing. `flatten` in
 * `helpers.ts` is deliberately NOT reused here -- it inserts a space where the wrap was, which is
 * right for reading a message and wrong for proving a phrase is absent.
 *
 * Nothing strips a `›` any more; ascend renders its own failures (`errors.ts`), so there is none.
 * The argument for why there must not be one is in this file's header comment.
 */
function squashed(text: string): string {
  return text.replace(/\s+/g, '');
}

/** A project: a directory with a `.git` marker, initialised so a store exists. */
function project(prefix = 'asc-driver-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

/** A directory with a `.git` marker and nothing else -- no store, so `init` is the first thing to run. */
function bare(prefix = 'asc-driver-bare-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  return dir;
}

describe('a filesystem refusal names what ascend was doing and what to do next', () => {
  it('explains a FILE sitting where the store directory belongs', () => {
    // Reproduced verbatim before this fix, by running `asc init` in a project holding a file named
    // `.ascend`: `Error: EEXIST: file already exists, mkdir '/private/tmp/tno/.ascend'`. No context,
    // no next step -- and the worst of the four, because "EEXIST" reads as an internal assertion
    // rather than as "you have a file where ascend needs a directory".
    const dir = bare();
    writeFileSync(join(dir, '.ascend'), '');

    const run = asc(['init'], dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const rendered = squashed(run.stderr);
    expect(rendered).toContain(squashed("ascend ran 'mkdir'"));
    expect(rendered).toContain(squashed(join(dir, '.ascend')));
    expect(rendered).toContain('EEXIST');
    // The plain-language problem, which is the half the raw string lacked entirely.
    expect(rendered).toContain(squashed('a FILE is already at that path'));
    // And a next step.
    expect(rendered).toContain(squashed('Move that file aside'));

    // The refutation. Node's own sentence must be GONE -- if it survived alongside the explanation,
    // the explanation would be decoration on a leak rather than a replacement for it.
    expect(rendered).not.toContain(squashed('file already exists'));
  });

  it('explains a store directory the operating system will not read', () => {
    // Reproduced before this fix, from a project whose `.ascend` directory is unreadable:
    // `Error: unable to open database file` -- which names neither the store nor the directory, and
    // sounds like a SQLite internal rather than a permission problem on the caller's own project.
    //
    // **The branch it reaches changed with the flip, and the test was re-measured rather than
    // adjusted.** The store is the JSONL tree now, so the first thing a read does is hash it --
    // `recordFiles` lists each kind directory -- and that fails before any database is opened. What
    // comes out is the FILESYSTEM branch naming `scandir` and the directory inside the tree that
    // could not be listed. `EACCES` and not SQLite's code 14, so the assertion follows.
    const dir = project();
    const store = join(dir, '.ascend');
    // The one site that needs a real permission change. Restored in the `finally` because the temp
    // directory is removed in `afterAll` and an unreadable directory would take its contents with
    // it. A test run as root would not reproduce this -- stated rather than guarded, since the
    // alternative (a root check that skips the test) would turn a real assertion into a silent pass.
    execFileSync('chmod', ['000', store]);

    let run: Run;
    try {
      run = asc(['query', 'SELECT 1 AS n'], dir);
    } finally {
      execFileSync('chmod', ['755', store]);
    }

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const rendered = squashed(run.stderr);
    expect(rendered).toContain(squashed("ascend ran 'scandir'"));
    expect(rendered).toContain(squashed(store));
    expect(rendered).toContain(squashed('EACCES'));
    // The plain-language problem and the next step, which are the half the raw string lacked.
    expect(rendered).toContain(squashed('you do not have permission to use that path'));
    expect(rendered).toContain(squashed('every directory above it'));

    // The raw leak, gone.
    expect(rendered).not.toContain(squashed('Error: unable to open database file'));
  });
});

describe('a statement SQLite cannot make sense of says which of the two things happened', () => {
  it.each([
    { sql: 'SELECT * FROM entries WHERE', wording: 'incomplete input' },
    { sql: 'SELECT * FROM nope', wording: 'no such table: nope' },
  ])('carries the driver wording for $wording', ({ sql, wording }) => {
    // Two measured leaks under ONE code. Reproduced before this fix: `asc query 'SELECT * FROM
    // entries WHERE'` gave `Error: incomplete input`, and `asc query 'SELECT * FROM nope'` gave
    // `Error: no such table: nope` -- each a bare sentence naming no store, no command and no fix.
    //
    // They share a branch, and that is the branch's whole design: code 1 covers both, so the branch
    // cannot key on the code alone. Driving both wordings through it is what proves the wording is
    // carried rather than replaced -- drop it and both become the same unhelpful sentence.
    const dir = project();

    const run = asc(['query', sql], dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const rendered = squashed(run.stderr);
    expect(rendered).toContain(squashed(wording));
    expect(rendered).toContain(squashed('code 1'));
    expect(rendered).toContain(squashed('SQLite could not make sense of a statement'));
    // The fix: the real table names, and the command that lists the generated views.
    expect(rendered).toContain('entries_fts');
    expect(rendered).toContain(squashed('asc types list'));

    // The raw leak -- the whole sentence, with nothing in front of it -- gone.
    expect(rendered).not.toContain(squashed(`Error: ${wording}`));
  });
});

/**
 * The same damage, through the two paths that reach it differently.
 *
 * The damaged file is the INDEX now, not `ascend.db`, and that is the flip in one line: the SQLite
 * file every command opens is derived, so this is the file whose corruption a user can actually
 * produce. Writing garbage into `ascend.db` beside it would leave every command working -- there is
 * no code path left that reads it.
 *
 * **The old single test drove a WRITE** ("a damaged store is more often met while writing"), and the
 * flip made that arm stop reaching this branch at all -- so the split is a measurement, not
 * tidiness. Both arms were run against the real binary on 2026-09-29 and their outputs are what the
 * assertions below quote.
 */
describe('an index that is not a database', () => {
  it('is REFUSED by a read, which names the rebuild rather than a backup', () => {
    // Measured: `asc query 'SELECT 1 AS n'` over a garbage `.ascend/index.db` says the file "is not
    // an index ascend can read" and sends the caller to `asc index build`.
    //
    // The raw `Error: file is not a database` never appears, and the reason is worth stating because
    // it is the mechanism and not a coincidence: `openIndex` compares the tree's fingerprint against
    // what the file claims, and a file that cannot answer claims nothing, so the read arrives here
    // through the STALE branch. One remedy covers every way an index can be broken -- corrupt,
    // absent, out of date, half-copied -- which is the property that makes "derived" true in
    // practice and not just in the header comment.
    const dir = project();
    writeFileSync(join(dir, '.ascend', 'index.db'), 'not a database at all, just bytes\n');

    const run = asc(['query', 'SELECT 1 AS n'], dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const rendered = squashed(run.stderr);
    expect(rendered).toContain(squashed(join(dir, '.ascend', 'index.db')));
    expect(rendered).toContain(squashed('is not an index ascend can read'));
    expect(rendered).toContain(squashed('a read does not build one'));
    expect(rendered).toContain(squashed('asc index build'));
    // The way out, and it is the opposite of the old one. The message used to tell the caller to
    // preserve the file first, because the file was the store; now nothing is lost by deleting it,
    // because the tree beside it still holds every record. A message that still said "copy it
    // somewhere first" would be teaching a backup of a rebuildable cache.
    expect(rendered).not.toContain(squashed('copy it somewhere first'));

    // The raw leak, gone.
    expect(rendered).not.toContain(squashed('Error: file is not a database'));
  });

  it('is REPAIRED by a write, because the tree beside it is the store', () => {
    // Measured: the same garbage, then `asc record decision …` -- exit 0, the entry in the tree, and
    // `index.db` a SQLite file again. A write may pay for a rebuild where a read may not, and this
    // is the assertion that the index really is derived rather than a second source of truth.
    //
    // Asserted on the FILE, not on the exit code: a command that silently wrote into the damaged
    // file, or that left it damaged and reported success, would pass an exit-code check. This is the
    // arm that says a user who corrupts their index loses nothing.
    const dir = project();
    const indexFile = join(dir, '.ascend', 'index.db');
    writeFileSync(indexFile, 'not a database at all, just bytes\n');

    const run = asc(
      ['record', 'decision', '--prop=chosen=rebuilt', '--prop=rationale=the-tree-is-the-store'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(indexFile).subarray(0, 15).toString()).toBe('SQLite format 3');
    // And the record survives a rebuild, which is the half that matters: the index was rebuilt FROM
    // the tree, and the entry just written is in the tree.
    const rebuilt = asc(['query', 'SELECT count(*) AS n FROM entries'], dir);
    expect(rebuilt.status, rebuilt.stderr).toBe(0);
    expect(rebuilt.stdout).toMatch(/\b1\b/);
  });
});
