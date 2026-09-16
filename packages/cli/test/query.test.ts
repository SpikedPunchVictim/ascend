import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OUTPUT_CONTRACT_VERSION, statementCount } from '@ascend/cli';
import { attachHeadroom, openStore } from '@ascend/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc query`, driven as the real binary.
 *
 * **The two properties this command exists to have are both asserted end to end**: that it cannot
 * write (checked against the FILE, through a second connection, since a handle that refused a
 * statement is not evidence that nothing changed), and that it never runs more than one statement
 * (checked by exit code, because SQLite would otherwise run the first and discard the rest in
 * silence -- see `sql.ts`).
 *
 * The values block records what the output actually IS rather than what would be nicer: a boolean
 * property reads as `1`, a `json` property as JSON *text*. That is not a defect being tolerated --
 * `columns()` reported `type: null` for every property column of a generated view when this was
 * written, so there is no declared type to render from -- and pinning it here means a later change
 * to it is a deliberate decision with a failing test in front of it.
 *
 * `--across` is tested against several temp projects, including the case where the project being
 * queried is the one you are standing in, and the case where there is no local project at all.
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

function scratch(prefix = 'asc-query-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const env = (dir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: dir,
  XDG_CACHE_HOME: join(dir, '.cache'),
});

function asc(args: readonly string[], cwd: string, input?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: env(cwd),
    // Optional, so every existing call site is unchanged. It exists for the stdin tests: an
    // omitted `input` leaves the child with an empty stdin, which is a different case from a
    // pipe carrying a value, and the two must not be confused.
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project: a directory with the starter types installed. `.git` is a plain directory. */
function project(): string {
  const dir = scratch('asc-query-proj-');
  mkdirSync(join(dir, '.git'));
  expect(asc(['init'], dir).status).toBe(0);
  return dir;
}

/** stderr with oclif's wrap decoration removed, so a substring assertion means what it reads like. */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `flatten` with every whitespace run and every wrap marker deleted, for assertions that name a path.
 *
 * **Measured, and it is the reason this exists rather than `flatten` being enough.** oclif wraps
 * `this.warn` at the terminal width and breaks **mid-token** when a word does not fit, marking the
 * break with a `›`. Observed verbatim: `.../asc-query-hood-wV7xm7/proj-0` came back as
 * `.../asc-query-hood-w›V7xm7/proj-0`. So `flatten`'s newline-to-space collapse inserted a space
 * that is not in the message, AND the marker landed in the middle of the path -- a substring
 * assertion on that path fails against output that is correct.
 *
 * The worse half is the NEGATIVE assertion: `expect(notes).not.toContain(path)` would pass on that
 * same corrupted text without the path being absent at all -- a false green, and exactly the kind of
 * check this repo treats as severity-zero. So both directions go through this one function, where
 * neither inserted whitespace nor a wrap marker can make either of them lie.
 */
function squashed(text: string): string {
  return text.replace(/[\s›]+/g, '');
}

/** The store file as a path this process can compare against SQLite's own resolution of it. */
const storeFile = (projectDir: string): string => join(projectDir, '.ascend', 'ascend.db');

/**
 * Read one row out of a store's file through a connection that is not `asc`'s.
 *
 * `Record<string, unknown>` rather than a type parameter: the column wanted differs per call site,
 * and a generic used once per signature buys nothing (lint's `no-unnecessary-type-parameters` says so,
 * correctly). Callers read the field and assert on it, which is the whole job.
 */
function fromFile(file: string, sql: string): Record<string, unknown> {
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare(sql).get() as Record<string, unknown>;
  db.close();
  return row;
}

const entryCount = (projectDir: string): unknown =>
  fromFile(storeFile(projectDir), 'SELECT count(*) AS n FROM entries')['n'];

/** The rows of a `--json` run. */
function rows(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

describe('the statement scanner', () => {
  it('counts one statement however it is spelled', () => {
    // Each of these is ONE statement with a `;` that must not separate: a literal, a doubled escape
    // inside a literal, a doubled quote inside an identifier, a bracket, and a line comment. An
    // undercount here is the defect the scanner exists to prevent, and it is invisible from the
    // command -- a dropped second statement looks exactly like a query that returned fewer rows.
    for (const sql of [
      'SELECT 1',
      'SELECT 1;',
      "SELECT ';' AS semi",
      "SELECT 'it''s; fine' AS quoted",
      'SELECT "a"";b" AS ident',
      'SELECT `a``;b` AS backtick',
      'SELECT [a;b] AS bracketed',
      'SELECT 1 -- ; not a separator',
      'SELECT 1 /* ; neither is this */',
      '  SELECT 1  ;  ',
    ]) {
      expect(statementCount(sql), sql).toBe(1);
    }
  });

  it('counts what is genuinely more than one', () => {
    expect(statementCount('SELECT 1; SELECT 2')).toBe(2);
    expect(statementCount('SELECT 1; SELECT 2; SELECT 3')).toBe(3);
    expect(statementCount('SELECT 1;;SELECT 2')).toBe(2);
    // A `;` inside a comment does not hide a real separator that follows it.
    expect(statementCount('SELECT 1 -- x\n; SELECT 2')).toBe(2);
  });

  it('counts nothing for what SQLite would refuse as an empty statement', () => {
    expect(statementCount('')).toBe(0);
    expect(statementCount('   \n\t ')).toBe(0);
    expect(statementCount(';')).toBe(0);
    expect(statementCount('-- only a comment')).toBe(0);
    expect(statementCount('/* only a comment */')).toBe(0);
  });
});

describe('running one statement', () => {
  it('prints a table by default and the versioned envelope with --json', () => {
    const dir = project();
    const table = asc(['query', 'SELECT 1 AS one, 2 AS two'], dir);
    const json = asc(['query', 'SELECT 1 AS one, 2 AS two', '--json'], dir);

    expect(table.status).toBe(0);
    expect(table.stdout.split('\n')[0]).toBe('one  two');
    // The envelope is the contract (`output.ts`), so its shape is pinned rather than the rendering.
    // `coverage` joined it as an ADDITIVE key at `ascend_output` 1 (`asc-wsa`): a consumer that
    // predates it reads `rows` and `row_count` unchanged, and this query emitted everything it
    // produced, so its coverage says exactly that.
    //
    // The version is read from the module rather than written here. Pinning the literal in five
    // separate files made a deliberate bump a five-file edit whose diff said nothing about WHY --
    // the number is asserted once, in `output.test.ts`, where the reason for changing it lives.
    expect(JSON.parse(json.stdout)).toEqual({
      ascend_output: OUTPUT_CONTRACT_VERSION,
      rows: [{ one: 1, two: 2 }],
      row_count: 1,
      coverage: { shown: 1, total: 1, has_more: false, percent: 100 },
    });
  });

  it('prints CSV with a header row', () => {
    const dir = project();
    const result = asc(['query', "SELECT 'a,b' AS x, 'c' AS y", '--csv'], dir);

    // The comma inside the value is quoted, which is what makes this CSV rather than a list.
    expect(result.stdout.split('\n')[0]).toBe('x,y');
    expect(result.stdout.split('\n')[1]).toBe('"a,b",c');
  });

  it('does not corrupt a value it has to truncate, which is a claim about the bytes', () => {
    const dir = project();
    // `char(128512)` is U+1F600, built in SQL so the renderer can be driven with a two-unit
    // character at an exact offset without writing anything to the store. 58 a's put it at units
    // 58-59, which is where the 60-unit budget's cut lands, and the trailing b's exist only to
    // push the value past 60 so that a cut happens at all -- without them the value is exactly 60
    // units, `> maxCellWidth` is false, and there is nothing to corrupt. That is why the audit's
    // stated repro did not reproduce through the rendered cell.
    const value = (pad: number): string =>
      `SELECT '${'a'.repeat(pad)}' || char(128512) || '${'b'.repeat(20)}' AS v`;
    const split = asc(['query', value(58)], dir);
    const intact = asc(['query', value(57)], dir);

    expect(split.status).toBe(0);
    expect(intact.status).toBe(0);

    // The old renderer emitted EF BF BD here -- U+FFFD, which is the encoder saying it was handed
    // a lone surrogate. Asserted on the decoded stdout because that is the same fact seen from the
    // other side: the replacement character can only come from the bytes that were written.
    expect(split.stdout).not.toContain('�');
    // And the half-character is dropped rather than half-written: backing off the high surrogate
    // takes the whole character with it, so the ellipsis follows the last a.
    expect(split.stdout.split('\n')[2]).toBe(`${'a'.repeat(58)}…`);
    // The control is the proof that the assertion above is about the CUT and not about emoji:
    // one unit earlier and nothing is split, so the character survives intact.
    expect(intact.stdout).toContain('😀');
    expect(intact.stdout).not.toContain('�');
    // Both views agree about the row; only the table elides (`output.ts`).
    expect(asc(['query', value(58), '--csv'], dir).stdout).toContain('😀');
    expect(asc(['query', value(58), '--json'], dir).stdout).toContain('😀');
  });

  it('refuses two output flags at once', () => {
    const dir = project();
    const result = asc(['query', 'SELECT 1', '--json', '--table'], dir);

    expect(result.status).toBe(2);
    expect(flatten(result.stderr)).toContain('cannot be combined');
  });

  it('refuses more than one statement, naming what SQLite would have done', () => {
    const dir = project();
    const result = asc(['query', 'SELECT 1; SELECT 2'], dir);

    expect(result.status).toBe(2);
    // The second half matters: the refusal is only defensible because the alternative is silent.
    expect(flatten(result.stderr)).toContain('2 statements');
    expect(flatten(result.stderr)).toContain('discard the others without saying so');
  });

  it('refuses an empty statement rather than reporting an empty result', () => {
    const dir = project();
    const result = asc(['query', '  -- nothing here'], dir);

    expect(result.status).toBe(2);
    expect(flatten(result.stderr)).toContain('empty');
  });

  it('reads the generated view for a registered type', () => {
    const dir = project();
    expect(asc(['query', 'SELECT count(*) AS n FROM v_decision_v1'], dir).status).toBe(0);
  });

  it('does not let a duplicate column name silently drop a value', () => {
    const dir = project();
    const result = asc(['query', 'SELECT 1 AS x, 2 AS x', '--json'], dir);
    const table = asc(['query', 'SELECT 1 AS x, 2 AS x'], dir);

    expect(result.status).toBe(0);
    // BOTH values survive. `SELECT 1 AS x, 2 AS x` is legal SQLite, and `node:sqlite` builds a row
    // object keyed by SQLite's own column names -- so the second `x` overwrites the first, the value
    // disappears, and nothing anywhere reports an error. This assertion is why that cannot return.
    expect(rows(result.stdout)[0]).toEqual({ x: 1, x_2: 2 });

    // And the TABLE agrees with the JSON, which is the assertion a first attempt at this fix needed.
    // Renaming the columns without also reading rows as arrays left the header advertising `x_2`
    // over an empty cell -- a column that does not exist, in place of a value that was dropped. A
    // test that checked only the JSON keys would have passed on that.
    const lines = table.stdout.split('\n');
    expect(lines[0]).toBe('x  x_2');
    expect(lines[2]).toBe('1  2');

    // And the caller is told, because `x_2` is not the alias they typed.
    expect(flatten(result.stderr)).toContain("two result columns are named 'x'");
  });
});

describe('a piped value is never taken for an operand', () => {
  it('refuses SQL from stdin, which was never a documented input', () => {
    // `sql` is `required: true`, and before `ignoreStdin` oclif satisfied that requirement from
    // stdin -- so `printf 'SELECT 1 AS x' | asc query` RAN the statement, with nothing in
    // `--help` saying stdin was an input. It contradicted `input.ts`: "a command that reads stdin
    // when given no operand looks like it is waiting for input when it is actually waiting for a
    // keypress".
    //
    // It was also a RACE, which is why nothing caught it. oclif's reader aborts after 10 ms, so
    // the same pipeline ran with `printf` and refused with `( sleep 0.3; printf ... )`. A missing
    // operand is now a usage error every time, naming the operand.
    const dir = project();
    const run = asc(['query'], dir, 'SELECT 1 AS x');

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('Missing 1 required arg');
  });
});

describe('read-only, and what that costs the caller', () => {
  it('refuses a write and leaves the file untouched', () => {
    const dir = project();
    asc(['record', 'decision', '--prop=chosen=x', '--prop=rationale=y'], dir);
    const before = entryCount(dir);
    expect(before).toBe(1);

    const result = asc(['query', 'DELETE FROM entries'], dir);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('read-only connection');
    // Read back through a SECOND connection: the point is the file, not the handle's report.
    expect(entryCount(dir)).toBe(before);
  });

  it('refuses a write hidden behind a read, which is what the one-statement rule also protects', () => {
    const dir = project();
    asc(['record', 'decision', '--prop=chosen=x', '--prop=rationale=y'], dir);
    const result = asc(['query', 'SELECT 1; DELETE FROM entries'], dir);

    // Refused as a usage error before SQLite ever sees it, so the count is still 1 afterwards.
    expect(result.status).toBe(2);
    expect(entryCount(dir)).toBe(1);
  });

  it('reports values as SQLite represents them, and says so where a caller will look', () => {
    const dir = project();
    const result = asc(
      [
        'query',
        // `AS missing`, not `AS nothing`: NOTHING is a SQLite keyword, and the first draft of this
        // test asserted against a query that was a syntax error. It failed loudly rather than
        // silently, which is the behaviour being relied on -- the error propagated verbatim.
        "SELECT 9223372036854775807 AS big, 7 AS small, X'DEADBEEF' AS blob, NULL AS missing",
        '--json',
      ],
      dir,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({
      // Out of `Number`'s safe range, so a decimal STRING -- `Number(...)` would round it to
      // 9223372036854776000, which is a wrong answer in the right shape.
      big: '9223372036854775807',
      small: 7,
      // SQLite's own spelling for these bytes, so it can be pasted back into the next query.
      blob: "X'deadbeef'",
      missing: null,
    });
  });

  it('reports a boolean property as 1, because SQLite has no boolean type to report', () => {
    const dir = project();
    expect(
      asc(
        [
          'record',
          'stage_transition',
          '--prop=stage=E4',
          '--prop=from_status=in_progress',
          '--prop=to_status=complete',
          '--prop=tests_passing=true',
        ],
        dir,
      ).status,
    ).toBe(0);

    const result = asc(
      [
        'query',
        'SELECT tests_passing AS v, typeof(tests_passing) AS t, tests_passing_state AS st FROM v_stage_transition_v1',
        '--json',
      ],
      dir,
    );

    // `typeof` is asserted alongside the value so that a later change to a text `true` fails here
    // with the reason visible rather than as a bare mismatch. The view projects the property through
    // `json_extract`, and what SQLite hands back for a stored JSON `true` is INTEGER 1.
    expect(rows(result.stdout)[0]).toEqual({ v: 1, t: 'integer', st: 'measured' });
  });

  it('reports a json property as text, which is the form a caller can hand back to json_extract', () => {
    const dir = project();
    expect(
      asc(
        ['record', 'review_completed', '--prop=verdict=approved', '--prop=findings=[{"a":1}]'],
        dir,
      ).status,
    ).toBe(0);

    const result = asc(
      ['query', 'SELECT findings, typeof(findings) AS t FROM v_review_completed_v1', '--json'],
      dir,
    );

    // Text rather than a decoded array, and that is the useful form here: `asc query` returns SQL, so
    // the value that survives a round trip through the next statement is the one that still parses.
    expect(rows(result.stdout)[0]).toEqual({ findings: '[{"a":1}]', t: 'text' });
  });

  it('states the value limitation in --help, because it is not discoverable from a row', () => {
    const result = asc(['query', '--help'], project());

    expect(result.stdout).toContain('--across');
    expect(flatten(result.stdout)).toContain("SQLite's representation");
  });
});

/**
 * A parent directory holding `count` sibling projects, so one glob covers them all.
 *
 * At module scope rather than inside a `describe`, because `--across` is not the only block that
 * needs a neighbourhood: the "outside any project" block queries across one from a directory that
 * has no store at all, and a helper nested in a sibling `describe` is not visible there.
 *
 * The sibling names are load-bearing. `--across` derives an alias from each project's basename, so
 * `proj-0` becoming `proj_0` is what the SQL below relies on -- and the tests assert the derivation
 * happened rather than assuming it.
 */
function neighbourhood(count: number): { parent: string; members: string[] } {
  const parent = scratch('asc-query-hood-');
  const members: string[] = [];
  for (let index = 0; index < count; index++) {
    const dir = join(parent, `proj-${String(index)}`);
    // Recursive, because the project directory itself does not exist yet -- unlike `project()`, which
    // mkdirs inside a `scratch()` that is already there.
    mkdirSync(join(dir, '.git'), { recursive: true });
    expect(asc(['init'], dir).status).toBe(0);
    members.push(dir);
  }
  return { parent, members };
}

describe('--across', () => {
  it('attaches each matched project under its own name and reports the names', () => {
    const { parent, members } = neighbourhood(2);
    const [first, second] = members as [string, string];
    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM proj_0.entries) AS a, (SELECT count(*) FROM proj_1.entries) AS b',
        '--across',
        `${parent}/*`,
        '--json',
      ],
      parent,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ a: 0, b: 0 });
    // On stderr, because the names are how the caller writes the SQL -- a result that used them
    // without ever saying what they are would be unusable.
    const notes = squashed(result.stderr);
    expect(notes).toContain(squashed(`${first} attached as 'proj_0'`));
    expect(notes).toContain(squashed(`${second} attached as 'proj_1'`));
  });

  it('accepts the .ascend/ascend.db spelling a shell would complete', () => {
    const { parent } = neighbourhood(2);
    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM proj_1.entries) AS b',
        '--across',
        `${parent}/*/.ascend/ascend.db`,
        '--json',
      ],
      parent,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ b: 0 });
  });

  it('leaves the project you are standing in as main, and does not attach it twice', () => {
    const { parent, members } = neighbourhood(2);
    const [first, second] = members as [string, string];
    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM main.entries) AS m, (SELECT count(*) FROM proj_1.entries) AS b',
        '--across',
        `${parent}/*`,
        '--json',
      ],
      // Run from INSIDE proj-0, which the glob also matches. Attaching it again would make
      // `main.entries UNION ALL proj_0.entries` count every entry twice.
      first,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ m: 0, b: 0 });
    const notes = squashed(result.stderr);
    expect(notes).toContain(squashed("is the project you are in, so it is already here as 'main'"));
    // The one thing that must NOT appear: a second name for the project we are in. Asserted in the
    // squashed form, because a wrapped path would otherwise make this pass without the path being
    // absent -- see `squashed`.
    expect(notes).not.toContain(squashed(`${first} attached as`));
    // And the other project DID get a name, so the assertion above is not passing because the
    // warning loop never ran.
    expect(notes).toContain(squashed(`${second} attached as 'proj_1'`));
  });

  it('refuses a glob that matches nothing, rather than querying an empty corpus', () => {
    const parent = scratch('asc-query-empty-');
    const result = asc(['query', 'SELECT 1', '--across', `${parent}/nothing-*`], parent);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('matched no projects');
  });

  it('attaches a project whose directory is named temp, rather than dying on a reserved name', () => {
    // Measured before the fix, running this exact fixture: the alias allocated was `temp`, and the
    // ATTACH came back as `database temp is already in use` -- a raw driver message naming neither
    // the project nor the alias, from a command the caller had every reason to expect to work. A
    // scratch checkout named `temp` is ordinary, and `temp` is one of SQLite's own two databases:
    // `PRAGMA database_list` omits it while nothing has been created there, but SQLite reserves the
    // name regardless, so seeding the guard from the pragma alone handed out a name it would refuse.
    const parent = scratch('asc-query-reserved-');
    const member = join(parent, 'temp');
    mkdirSync(join(member, '.git'), { recursive: true });
    expect(asc(['init'], member).status).toBe(0);

    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM temp_2.entries) AS n',
        '--across',
        `${parent}/*`,
        '--json',
      ],
      parent,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ n: 0 });
    // The alias it actually chose, reported on stderr as every `--across` alias is.
    expect(squashed(result.stderr)).toContain(squashed(`${member} attached as 'temp_2'`));
    // And the driver's own message is gone -- that is the defect, not the naming.
    expect(flatten(result.stderr)).not.toContain('already in use');
  });

  it('expands a leading ~ in the glob, which --help’s own example requires', () => {
    // `--help` prints `--across '~/projects/*'`, and that example could never work: `fs.globSync`
    // treats `~` as a literal directory name, and the example is single-quoted so the shell does not
    // expand it either. Measured then: `globSync('~/projects/*')` matched nothing while
    // `globSync(homedir() + '/*')` matched 17 entries. `HOME` is redirected to the scratch directory
    // by `env`, so `homedir()` inside the CLI is exactly this directory.
    const home = scratch('asc-query-home-');
    for (const name of ['a', 'b']) {
      const dir = join(home, 'projects', name);
      mkdirSync(join(dir, '.git'), { recursive: true });
      expect(asc(['init'], dir).status).toBe(0);
    }

    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM a.entries) AS a, (SELECT count(*) FROM b.entries) AS b',
        '--across',
        '~/projects/*',
        '--json',
      ],
      home,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ a: 0, b: 0 });
  });

  it('shows what a ~ pattern expanded to, instead of blaming the quoting', () => {
    // The old message ended "Check that the pattern is quoted, so your shell did not expand it
    // first" -- advice that is wrong here twice over: quoting is what `--help`'s example does, and
    // quoting is not what broke it. Advice that cannot work, aimed at the one thing the caller did
    // right, is worse than no advice. The expansion is shown because it is the path actually
    // searched, and the caller otherwise cannot tell whether their `~` was understood.
    const home = scratch('asc-query-home-');
    const result = asc(['query', 'SELECT 1', '--across', '~/nothing-here-*'], home);

    expect(result.status).toBe(1);
    // Squashed, not flattened: the expanded path is long enough that oclif wraps it mid-token, and
    // `flatten`'s newline-to-space collapse would insert a space that is not in the message -- so
    // this assertion would fail against output that is correct. See `squashed`.
    const message = squashed(result.stderr);
    expect(flatten(result.stderr)).toContain('matched no projects');
    expect(message).toContain(squashed(join(home, 'nothing-here-*')));
    expect(message).not.toContain('quoted');
    // A pattern with no `~` is reported as written, since there is no expansion to explain.
    const plain = asc(['query', 'SELECT 1', '--across', 'no-such-*'], home);
    expect(flatten(plain.stderr)).toContain("'no-such-*'");
    expect(flatten(plain.stderr)).not.toContain('expanded to');
  });

  it('leaves ~user alone, because homedir() cannot resolve another user’s home', () => {
    // Anchored on `~/` or a bare `~` rather than on any leading `~`: `~someone` means that user's
    // home directory, which `homedir()` does not answer, so rewriting it to OUR home and searching
    // there would be a silent wrong answer rather than a refusal.
    const home = scratch('asc-query-home-');
    const result = asc(['query', 'SELECT 1', '--across', '~root/nothing-*'], home);

    expect(result.status).toBe(1);
    const message = flatten(result.stderr);
    expect(message).toContain("'~root/nothing-*'");
    expect(message).not.toContain('expanded to');
    // And it really did not reach our home directory: the path it searched is not under it.
    expect(squashed(result.stderr)).not.toContain(squashed(join(home, 'root')));
  });

  it('refuses a match that is not a store, before attaching anything', () => {
    const { parent } = neighbourhood(1);
    mkdirSync(join(parent, 'not-a-project', '.git'), { recursive: true });
    const result = asc(['query', 'SELECT 1', '--across', `${parent}/*`], parent);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('is not an ascend store');
  });

  it('refuses two paths that are one store, so a union cannot count it twice', () => {
    const { parent, members } = neighbourhood(1);
    const [first] = members as [string];
    symlinkSync(first, join(parent, 'zz-alias'));

    const result = asc(['query', 'SELECT 1', '--across', `${parent}/*`], parent);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('counted twice');
    // The resolved path is what catches it, which is asserted by the message naming the symlink.
    expect(flatten(result.stderr)).toContain('compared after resolving the path');
  });

  it('cannot write to a project it attached, and says the statement is what must change', () => {
    const { parent, members } = neighbourhood(1);
    const [first] = members as [string];
    const result = asc(['query', 'DELETE FROM proj_0.entries', '--across', `${parent}/*`], parent);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('read-only connection');
    expect(entryCount(first)).toBe(0);
  });
});

describe('a store written by a newer ascend', () => {
  it('is refused by asc query rather than read, which is what the read-only open used to skip', () => {
    // asc-bcv.9 (B5), and the consequence is a CLI-level one. `asc query` opens read-only, and the
    // ahead-of-build guard lived inside `migrate`, which the read-only path skips -- so this command
    // read a store from a future ascend and reported whatever the running build made of it.
    // Measured before the fix (/tmp/probe-b5.mjs): exit 0, printing `0`.
    const dir = project();
    const raw = new DatabaseSync(storeFile(dir));
    raw.exec('PRAGMA user_version = 99');
    raw.close();

    const result = asc(['query', 'SELECT count(*) AS n FROM entries'], dir);

    expect(result.status).toBe(1);
    expect(flatten(result.stderr)).toContain('this store is at schema version 99');
    // The fix it names, which is the opposite advice to a store that is BEHIND -- the reason the
    // store has two error classes rather than one.
    expect(flatten(result.stderr)).toContain('Upgrade ascend');
    // Nothing was printed as data, because nothing was read.
    expect(result.stdout.trim()).toBe('');
  });
});

describe('--across and the attachment ceiling', () => {
  /**
   * One test for both sides of the boundary, because the interesting failure is the PAIR: refusing
   * one project too many is only correct if exactly one fewer still works, and a check that refused
   * everything would satisfy the first half alone.
   *
   * The capacity is MEASURED here rather than written down, for the reason the store suite gives:
   * an assertion and a constant that came from the same guess cannot check each other. What this
   * test states is the rule -- what fits is attached, what does not is refused -- and the store
   * suite is where the number itself is witnessed by attaching exactly that many and one more.
   *
   * `capacity + 1` projects give both arms: run from a directory with no store, all of them are
   * targets and the glob is one over; run from INSIDE one of them, that project is `main` and the
   * remaining `capacity` are exactly what fits.
   *
   * The explicit timeout is deliberate. Eleven `asc init` calls are eleven real processes, which is
   * ~2s of the 5s default on this machine and less headroom than that on a loaded CI box -- and a
   * flaky boundary test is worse than none, because the failure looks like the boundary moved.
   */
  it('attaches a glob that exactly fills the connection, and refuses one project more', () => {
    const probe = openStore({ dir: ':memory:', ascendVersion: 'test' });
    const capacity = attachHeadroom(probe.db, 64);
    probe.close();
    expect(capacity).toBeGreaterThan(1);

    const { parent, members } = neighbourhood(capacity + 1);
    const [first] = members as [string];

    // --- one project over ----------------------------------------------------------------
    const outside = scratch('asc-query-ceiling-outside-');
    const over = asc(['query', 'SELECT 1', '--across', `${parent}/*`], outside);

    expect(over.status).toBe(1);
    const overNotes = flatten(over.stderr);
    expect(overNotes).toContain(`needs to attach ${String(capacity + 1)} projects`);
    expect(overNotes).toContain(`at most ${String(capacity)} attached databases`);

    // The raw driver message is what this refusal replaced, and `errcode` cannot tell it apart
    // from a syntax error (measured: both are `SQLITE_ERROR`), so the ONLY way this fix can fail
    // is by the message coming back. Asserted in the negative, and on the squeezed text: oclif
    // wraps mid-token, so `squashed` is what makes the phrase matchable at all.
    expect(squashed(over.stderr)).not.toContain('toomanyattacheddatabases');

    // Nothing was attached, which is the observable form of "the refusal is decided before the
    // first ATTACH". It is also why there is nothing for the command to release on this path.
    expect(squashed(over.stderr)).not.toContain('attachedas');

    // --- exactly at capacity -------------------------------------------------------------
    const at = asc(
      ['query', 'SELECT count(*) AS n FROM proj_1.entries', '--across', `${parent}/*`, '--json'],
      first,
    );

    expect(at.status).toBe(0);
    expect(rows(at.stdout)[0]).toEqual({ n: 0 });

    const atNotes = squashed(at.stderr);
    expect((atNotes.match(/attachedas/g) ?? []).length).toBe(capacity);
    // The hoisted local-project check still fires, and still says why -- moving it above the loop
    // is what made the count knowable, and the warning is the part a caller would notice missing.
    expect(flatten(at.stderr)).toContain('is the project you are in');
  }, 30_000);
});

describe('outside any project', () => {
  it('queries across named projects with an empty main, and says main is empty', () => {
    const { parent, members } = neighbourhood(1);
    const [first] = members as [string];
    // A directory with no store anywhere above it -- `scratch()` is under the temp dir.
    const outside = scratch('asc-query-outside-');

    // `SELECT 1` succeeds out here, and that is correct rather than a gap: it names no table, so an
    // empty in-memory `main` answers it. Asserted first so the failure below is attributable to the
    // missing store rather than to the query being malformed.
    const trivial = asc(['query', 'SELECT 1 AS one'], outside);
    expect(trivial.status).toBe(0);
    expect(flatten(trivial.stderr)).toContain("'main' is empty");

    const result = asc(
      [
        'query',
        'SELECT (SELECT count(*) FROM proj_0.entries) AS a',
        '--across',
        `${parent}/*`,
        '--json',
      ],
      outside,
    );

    expect(result.status).toBe(0);
    expect(rows(result.stdout)[0]).toEqual({ a: 0 });
    expect(flatten(result.stderr)).toContain("'main' is empty");
    // The fallback connection is in memory, so the only file in play is the one attached -- and it
    // is read-only, which the store's own suite asserts (`readonly.test.ts`).
    expect(first).toBeTruthy();
  });

  it('refuses an unqualified table when main is empty, naming main rather than the table', () => {
    const outside = scratch('asc-query-outside2-');
    const result = asc(['query', 'SELECT count(*) FROM entries'], outside);

    expect(result.status).toBe(1);
    // SQLite's `no such table: entries` arrives, and the warning above it is what makes it legible.
    expect(flatten(result.stderr)).toContain('no such table: entries');
    expect(flatten(result.stderr)).toContain("'main' is empty");
  });
});

describe('a reader that goes away', () => {
  /**
   * `asc query | head -1`, as a real pipeline.
   *
   * A 64 KiB pipe buffer swallows everything the other commands can print, so this is the first
   * command where the stream guard (`streams.ts`) is exercised at all. The reader is destroyed from
   * the parent rather than by spawning `head`, so the test depends on no shell and no coreutils --
   * `child.stdout.destroy()` closes the read end, which is what gives the writer its EPIPE.
   *
   * **What this asserts, stated exactly: the pipeline works.** It does NOT prove ascend's own guard
   * was installed -- measured, `@oclif/core` installs an equivalent EPIPE handler on stdout when
   * `lib/command.js` loads, so removing ascend's changes nothing observable here. That is recorded
   * rather than papered over; the wiring stays unproven, and `bin.ts` says so.
   */
  it('exits 0 with nothing on stderr when the reader closes the pipe', async () => {
    const dir = project();
    const sql =
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 200000) ' +
      "SELECT x, 'padding-padding-padding' AS pad FROM c";

    const child = spawn(process.execPath, [bin, 'query', sql], {
      cwd: dir,
      env: env(dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.stdout.once('data', () => {
      child.stdout.destroy();
    });

    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(stderr).toBe('');
    expect(code).toBe(0);
  });
});

describe('the store file is where the tests say it is', () => {
  it('resolves through the same symlink SQLite does, so the path assertions above mean something', () => {
    // macOS `tmpdir()` is a symlink under `/var`, and `--across` reports SQLite's RESOLVED path.
    // This pins that the two agree on the real file rather than merely looking similar, which is
    // what makes `storeFile()` usable in the assertions above.
    const dir = project();
    expect(realpathSync(storeFile(dir)).endsWith('ascend.db')).toBe(true);
    expect(readFileSync(storeFile(dir)).subarray(0, 6).toString()).toBe('SQLite');
  });
});
