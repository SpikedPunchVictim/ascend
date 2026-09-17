import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStore, registerScheme } from '@ascend/store';
import { flatten } from './helpers.js';

/**
 * `asc annotate` and `asc kappa`, driven as the real binary against a real store.
 *
 * Same reasoning as `cli.test.ts` -- a subprocess rather than a direct call, because what can be
 * wrong is the flag parser, the streams, the exit code and oclif's discovery, none of which a
 * direct call exercises. Same cost: this file needs `dist/`, so it builds in `beforeAll`.
 *
 * **The two commands share a file because they share a fixture.** Kappa's input is what annotate
 * wrote, so a suite for either alone would have to build the other's output by hand -- and a
 * hand-built `annotations` table is a fixture that can drift from the schema without anything
 * failing. There is exactly one hand-built one here (the scheme with no pass, below) and it is built
 * through the store's own API for that reason, not with SQL.
 *
 * **Every claim about what was written is read back out of SQLite**, never inferred from the
 * command's own report. A command that printed the right census and wrote the wrong rows would pass
 * a test that only read stdout, and the census is precisely the number a reader would trust.
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

function asc(args: readonly string[], cwd: string, stdin?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  return { status: result.status ?? null, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The same binary, started without waiting for it -- the one test in this file (asc-q4p) that needs
 * two runs actually overlapping, which `spawnSync` cannot give: it blocks Node's own event loop
 * until the child exits, so two `spawnSync` calls can never be in flight at once. `spawn` starts
 * both processes before either has necessarily finished, and the OS -- not this test -- decides how
 * they interleave.
 */
function ascAsync(args: readonly string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** The `--json` envelope's rows. One place, so its shape is stated once. */
function rows(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

function one(stdout: string): Record<string, unknown> {
  const list = rows(stdout);
  expect(list).toHaveLength(1);
  return list[0] as Record<string, unknown>;
}

/**
 * Run one query against the store and return the rows as value arrays.
 *
 * Read-only, and it throws if the store file is not there. That is deliberate: every call site is
 * reached after a command that opened the store, so a missing file means the command failed in a way
 * the test has not accounted for, and saying so is better than returning `[]` and letting an
 * assertion about an empty table pass.
 */
function column(dir: string, sql: string, ...params: (string | number)[]): readonly unknown[][] {
  const file = join(dir, '.ascend', 'ascend.db');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]).map((row) =>
      Object.values(row),
    );
  } finally {
    db.close();
  }
}

/** Every annotation in the store, as `[entry_id, label, scheme, version, created_by]`. */
function annotations(dir: string): readonly unknown[][] {
  return column(
    dir,
    'SELECT entry_id, label, scheme, scheme_version, created_by FROM annotations ' +
      'ORDER BY created_by, scheme, entry_id',
  );
}

/** Every registered scheme, as `[name, version, spec_json]`, latest version only. */
function schemes(dir: string): readonly unknown[][] {
  return column(
    dir,
    'SELECT s.name, s.version, s.spec_json FROM annotation_schemes s ' +
      'JOIN (SELECT name, max(version) AS version FROM annotation_schemes GROUP BY name) latest ' +
      'ON latest.name = s.name AND latest.version = s.version ORDER BY s.name',
  );
}

/** The registered version of one scheme, or `0` when it has none. */
function versionOf(dir: string, name: string): number {
  const found = column(dir, 'SELECT max(version) FROM annotation_schemes WHERE name = ?', name);
  return (found[0]?.[0] as number | null) ?? 0;
}

/** The vocabulary of the latest version of a scheme. */
function vocabulary(dir: string, name: string): readonly string[] {
  const found = column(
    dir,
    'SELECT spec_json FROM annotation_schemes WHERE name = ? ORDER BY version DESC LIMIT 1',
    name,
  );
  const spec = JSON.parse(String(found[0]?.[0])) as { labels: string[] };
  return spec.labels;
}

/**
 * The rules of the latest version of a scheme, rendered the way `--rule` is written.
 *
 * The single space after the colon is the RENDERING, not the storage: `parseRule` trims the query, so
 * `--rule "bug=sql: 0 = 1"` and `--rule "bug=sql:0 = 1"` store the same rule. Rendering it with the
 * space makes the expectation read like the flag a caller would type.
 */
function rulesOf(dir: string, name: string): readonly string[] {
  const found = column(
    dir,
    'SELECT spec_json FROM annotation_schemes WHERE name = ? ORDER BY version DESC LIMIT 1',
    name,
  );
  const spec = JSON.parse(String(found[0]?.[0])) as {
    rules: { label: string; kind: string; query: string }[];
  };
  return spec.rules.map((rule) => `${rule.label}=${rule.kind}: ${rule.query}`);
}

/**
 * A type to record into.
 *
 * `body` rather than `text`: `asc types define` warns when a new property name overlaps a
 * registered one, and every warning assertion in this file is about annotations, so the fixture
 * should not be adding its own noise to stderr.
 */
const NOTE = { name: 'note', properties: [{ name: 'body', type: 'string' }] };

/** Six entries: four whose evidence mentions a crash, two that mention an install. */
const ENTRIES = [
  { id: 'e1', properties: { body: 'crash' }, evidence_text: 'the crash happened' },
  { id: 'e2', properties: { body: 'crash' }, evidence_text: 'the crash happened' },
  { id: 'e3', properties: { body: 'crash' }, evidence_text: 'the crash happened' },
  { id: 'e4', properties: { body: 'crash' }, evidence_text: 'the crash happened' },
  { id: 'e5', properties: { body: 'install' }, evidence_text: 'the install happened' },
  { id: 'e6', properties: { body: 'install' }, evidence_text: 'the install happened' },
];

/** A project with six entries recorded and no scheme registered. */
function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-annotate-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'note.json'), JSON.stringify(NOTE));
  expect(asc(['types', 'define', join(dir, 'note.json')], dir).status).toBe(0);

  for (const entry of ENTRIES) {
    const run = asc(['record', NOTE.name, '-', '--json'], dir, JSON.stringify(entry));
    expect(run.status, run.stderr).toBe(0);
  }
  return dir;
}

/** The two rules the fixture is built around: crash is a bug, install is docs. */
const CRASH_IS_A_BUG = "bug=sql: evidence_text LIKE '%crash%'";
const INSTALL_IS_DOCS = 'docs=fts: install';

/** Annotate `review` with those two rules, and return the run. */
function reviewRun(dir: string, extra: readonly string[] = []): Run {
  return asc(
    [
      'annotate',
      '--scheme',
      'review',
      '--rule',
      CRASH_IS_A_BUG,
      '--rule',
      INSTALL_IS_DOCS,
      ...extra,
    ],
    dir,
  );
}

describe('asc annotate: applying rules to the corpus', () => {
  it('writes one label per matched entry, and reports the census it read back', () => {
    const dir = seeded();

    const run = reviewRun(dir, ['--json']);

    expect(run.status, run.stderr).toBe(0);
    expect(one(run.stdout)).toMatchObject({
      scheme: 'review',
      version: 1,
      outcome: 'created',
      considered: 6,
      labelled: 6,
      unclassified: 0,
      labels: [
        { label: 'bug', count: 4 },
        { label: 'docs', count: 2 },
      ],
      dry_run: false,
    });

    // Read back, because the report is the command's own account of itself. The labels ARE the
    // rules' verdicts, so the assertion is the full table rather than a count.
    expect(annotations(dir)).toStrictEqual([
      ['e1', 'bug', 'review', 1, null],
      ['e2', 'bug', 'review', 1, null],
      ['e3', 'bug', 'review', 1, null],
      ['e4', 'bug', 'review', 1, null],
      ['e5', 'docs', 'review', 1, null],
      ['e6', 'docs', 'review', 1, null],
    ]);
  });

  it('gives the entry to the first matching rule when two rules both match it', () => {
    const dir = seeded();

    // Both rules match every crash entry; the first is the one that labels it. Written as a
    // `sql` rule that is true of everything, so the second rule is genuinely reachable and the
    // first-match rule is the only thing deciding the outcome.
    const run = asc(
      [
        'annotate',
        '--scheme',
        'review',
        '--rule',
        'first=sql: 1 = 1',
        '--rule',
        "second=sql: evidence_text LIKE '%crash%'",
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(one(run.stdout)).toMatchObject({
      labelled: 6,
      labels: [{ label: 'first', count: 6 }],
    });
    // Every label is `first`, and `second` appears nowhere -- which is what "the first match wins"
    // means, and it is also why the vocabulary is declared rather than discovered.
    expect(annotations(dir).map((row) => row[1])).toStrictEqual([
      'first',
      'first',
      'first',
      'first',
      'first',
      'first',
    ]);
  });

  it('treats --scope as the body its remainder is a remainder of', () => {
    const dir = seeded();

    const run = reviewRun(dir, ['--scope', "properties_json LIKE '%install%'", '--json']);

    expect(run.status, run.stderr).toBe(0);
    // The remainder is computed over the scope, so an install-only scope considers two entries and
    // both are classified. A census taken over the whole corpus would report four unclassified and
    // read as a taxonomy that does not fit.
    expect(one(run.stdout)).toMatchObject({
      considered: 2,
      labelled: 2,
      unclassified: 0,
      labels: [{ label: 'docs', count: 2 }],
    });
    // Only the entries in scope were annotated. The bug rule matched e1..e4 and was applied within
    // a scope that excludes them.
    expect(annotations(dir)).toStrictEqual([
      ['e5', 'docs', 'review', 1, null],
      ['e6', 'docs', 'review', 1, null],
    ]);
  });

  it('reports the whole scope as unclassified when no rule matches, and says so on stderr', () => {
    const dir = seeded();

    // ONLY the non-matching rule: a third rule added alongside the two real ones would leave them
    // matching, and the run would report a full census with the warning asserting the opposite.
    const run = asc(['annotate', '--scheme', 'review', '--rule', 'none=sql: 0 = 1', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    expect(one(run.stdout)).toMatchObject({ considered: 6, labelled: 0, unclassified: 6 });
    expect(flatten(run.stderr)).toContain('no rule matched any of the 6 entries in scope');
  });

  it('records who produced a pass, and omits the column when nobody said', () => {
    const dir = seeded();

    expect(reviewRun(dir, ['--actor', 'claude-code']).status).toBe(0);

    expect(annotations(dir).map((row) => row[4])).toStrictEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'claude-code',
      'claude-code',
      'claude-code',
    ]);
  });
});

describe('asc annotate: the scheme a run leaves behind', () => {
  it('mints a new version when the rules change, and keeps the labels the run did not name', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);

    // `--label other` declares a label nothing assigns. The vocabulary after this run must contain
    // it alongside the two the rules use, because a run that dropped it would be a version whose
    // vocabulary a previous version's annotations do not fit.
    const second = asc(
      [
        'annotate',
        '--scheme',
        'review',
        '--rule',
        "chore=sql: evidence_text LIKE '%install%'",
        '--label',
        'other',
        '--json',
      ],
      dir,
    );

    expect(second.status, second.stderr).toBe(0);
    expect(one(second.stdout)).toMatchObject({ version: 2, outcome: 'created' });
    expect(vocabulary(dir, 'review')).toStrictEqual(['bug', 'chore', 'docs', 'other']);
    // The version's annotations are the new pass, all under version 2.
    expect(new Set(annotations(dir).map((row) => row[3]))).toStrictEqual(new Set([1, 2]));
  });

  it('replaces the rules rather than appending, so an edited rule takes effect', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);

    // The same label, a narrower query. Appending would leave the old crash rule ahead of it and
    // the edit would be a silent no-op, because the first match wins.
    const second = asc(
      ['annotate', '--scheme', 'review', '--rule', 'bug=sql: 0 = 1', '--json'],
      dir,
    );

    expect(second.status, second.stderr).toBe(0);
    expect(rulesOf(dir, 'review')).toStrictEqual(['bug=sql: 0 = 1']);
    // The new pass labels nothing -- the rule matches nothing -- so the census is all remainder.
    expect(one(second.stdout)).toMatchObject({ considered: 6, labelled: 0, unclassified: 6 });
  });

  it('re-registers an unchanged shape as unchanged rather than minting a version', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);

    const again = reviewRun(dir, ['--json']);

    expect(again.status, again.stderr).toBe(0);
    expect(one(again.stdout)).toMatchObject({ version: 1, outcome: 'unchanged' });
    expect(versionOf(dir, 'review')).toBe(1);
  });

  it('declares a --label that no rule assigns, and reports it as an empty class', () => {
    const dir = seeded();

    const run = asc(
      ['annotate', '--scheme', 'review', '--rule', CRASH_IS_A_BUG, '--label', 'docs', '--json'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    // Declared, and absent from the census: a label in the vocabulary with no entries is a class
    // nobody used, which is not the same fact as a class that does not exist.
    expect(vocabulary(dir, 'review')).toStrictEqual(['bug', 'docs']);
    expect(one(run.stdout)['labels']).toStrictEqual([{ label: 'bug', count: 4 }]);
  });

  it('splits a rule on the first colon, so a query may contain colons of its own', () => {
    const dir = seeded();

    // The kind ends at the FIRST ':', which is what lets the query hold a colon -- a time, a JSON
    // path, a label written 'a:b'. Splitting on the last one would take everything up to the final
    // colon as the kind, and `sql: evidence_text LIKE '%crash%' AND 'a` is not a kind, so the rule
    // would be refused.
    const query = "evidence_text LIKE '%crash%' AND 'a:b' <> ''";
    const run = asc(
      ['annotate', '--scheme', 'review', '--rule', `bug=sql: ${query}`, '--json'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(rulesOf(dir, 'review')).toStrictEqual([`bug=sql: ${query}`]);
    // Stored and applied whole: the rule matched the four crash entries, so it is the query that was
    // kept rather than a prefix of it.
    expect(one(run.stdout)).toMatchObject({ labelled: 4 });
  });
});

describe('asc annotate: hand labelling', () => {
  it('writes several labels in one pass, which is what makes a hand rater comparable', () => {
    const dir = seeded();

    const run = asc(
      ['annotate', '--scheme', 'hand', '--ids', 'bug=e1,e2', '--ids', 'docs=e5', '--json'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(one(run.stdout)).toMatchObject({
      scheme: 'hand',
      version: 1,
      considered: 6,
      labelled: 3,
      unclassified: 3,
      labels: [
        { label: 'bug', count: 2 },
        { label: 'docs', count: 1 },
      ],
    });
    // Two labels under ONE pass timestamp, which is the thing a `--label`-per-invocation form could
    // not express: the second label would have been a second pass, and `asc kappa` reads only the
    // latest one.
    expect(annotations(dir)).toStrictEqual([
      ['e1', 'bug', 'hand', 1, null],
      ['e2', 'bug', 'hand', 1, null],
      ['e5', 'docs', 'hand', 1, null],
    ]);
    expect(new Set(column(dir, 'SELECT DISTINCT created_at FROM annotations'))).toHaveLength(1);
  });

  it('refuses an entry named twice in one pass, and refuses it the same way under --dry-run', () => {
    const dir = seeded();
    const args = ['annotate', '--scheme', 'hand', '--ids', 'bug=e1', '--ids', 'docs=e1'];

    const dry = asc([...args, '--dry-run'], dir);
    const real = asc(args, dir);

    // Identical, and that is the point: a dry run writes nothing, so a duplicate only the write
    // refused would let a preview report a census for a pass the real run then rejects.
    expect(dry.status).toBe(1);
    expect(real.status).toBe(1);
    expect(flatten(dry.stderr)).toContain("entry 'e1' is named twice in this pass");
    expect(flatten(real.stderr)).toContain("entry 'e1' is named twice in this pass");
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses an id that is outside the scope the remainder is computed over', () => {
    const dir = seeded();

    const run = asc(
      [
        'annotate',
        '--scheme',
        'hand',
        '--ids',
        'bug=e1',
        '--scope',
        "properties_json LIKE '%install%'",
      ],
      dir,
    );

    expect(run.status).toBe(1);
    // Labelling e1 under an install-only scope would make `labelled + unclassified` exceed
    // `considered`, so the report would be incoherent rather than merely incomplete.
    // asc-nd6: e1 is a real entry excluded by the scope, not a nonexistent id, so the message names
    // that cause specifically rather than the ambiguous "is not in this run's scope".
    expect(flatten(run.stderr)).toContain("entry 'e1' exists but is excluded by this run's scope");
    expect(annotations(dir)).toStrictEqual([]);
  });

  it('tells a nonexistent id apart from one that exists but is excluded by --scope (asc-q4p sibling: asc-nd6)', () => {
    const dir = seeded();

    // Same phrasing today for two different causes: a typo in the id, and a real id the scope
    // predicate excludes. Both go through `--ids` with a narrowing `--scope` so the only variable
    // between the two runs is whether the id names a real entry.
    const typo = asc(
      [
        'annotate',
        '--scheme',
        'hand',
        '--ids',
        'bug=nope',
        '--scope',
        "properties_json LIKE '%install%'",
      ],
      dir,
    );
    const excluded = asc(
      [
        'annotate',
        '--scheme',
        'hand',
        '--ids',
        'bug=e1',
        '--scope',
        "properties_json LIKE '%install%'",
      ],
      dir,
    );

    expect(typo.status).toBe(1);
    expect(excluded.status).toBe(1);
    expect(flatten(typo.stderr)).toContain("entry 'nope' does not exist");
    expect(flatten(excluded.stderr)).toContain(
      "entry 'e1' exists but is excluded by this run's scope",
    );
    // The two messages are not the same one reused with the id swapped in.
    expect(flatten(typo.stderr)).not.toContain('excluded by');
    expect(flatten(excluded.stderr)).not.toContain('does not exist');
    expect(annotations(dir)).toStrictEqual([]);
  });

  it('refuses an id list with no equals sign, naming the form', () => {
    const dir = seeded();

    const run = asc(['annotate', '--scheme', 'hand', '--ids', 'e1,e2'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain("--ids must be '<label>=<id>,<id>'");
  });

  it('refuses an empty label', () => {
    const dir = seeded();

    // Two spellings, two different checks, because only the first is caught by the position of the
    // '=': `=e1` has no label BEFORE the '=', and ` =e1` has one that trims to nothing. Both are an
    // entry given a label that says nothing, which is the thing the unclassified remainder says
    // instead.
    const atStart = asc(['annotate', '--scheme', 'hand', '--ids', '=e1'], dir);
    expect(atStart.status).toBe(2);
    expect(flatten(atStart.stderr)).toContain('has no label and id list separated');

    const whitespace = asc(['annotate', '--scheme', 'hand', '--ids', ' =e1'], dir);
    expect(whitespace.status).toBe(2);
    expect(flatten(whitespace.stderr)).toContain('names an empty label');
  });

  it('refuses a label with no ids, and points at --label instead', () => {
    const dir = seeded();

    const run = asc(['annotate', '--scheme', 'hand', '--ids', 'bug='], dir);

    expect(run.status).toBe(2);
    // The message has to offer the thing the caller probably meant, because "declare this label
    // without assigning it" is a real operation on this command and `--ids` is not how you do it.
    expect(flatten(run.stderr)).toContain('use --label bug to declare');
  });

  it('refuses an empty element in an id list, which is an unset shell variable', () => {
    const dir = seeded();

    const run = asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1,,e2'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('no empty element');
  });
});

describe('asc annotate: refusals', () => {
  it('refuses --rule together with --ids, as the sketch\'s "|" says', () => {
    const dir = seeded();

    const run = asc(
      ['annotate', '--scheme', 'review', '--rule', CRASH_IS_A_BUG, '--ids', 'bug=e1'],
      dir,
    );

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--rule and --ids cannot be combined');
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses a run with nothing to do, rather than registering an empty scheme', () => {
    const dir = seeded();

    const run = asc(['annotate', '--scheme', 'review'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('nothing to do');
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses --backtest by naming the bead that owns it', () => {
    const dir = seeded();

    const run = reviewRun(dir, ['--backtest', 'x']);

    // Refused rather than ignored: a flag that parses and does nothing would let a caller read a
    // precision/recall number out of an output that never computed one.
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('asc-3o9');
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses a text rule with no searchable term, in the words of the rule the caller typed', () => {
    const dir = seeded();

    const run = asc(['annotate', '--scheme', 'review', '--rule', 'docs=fts: ab'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain('rule for label \'docs\' is the text query "ab"');
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses a malformed --rule, naming which of the four things is missing', () => {
    const dir = seeded();

    // Table-driven because the four are one form with four holes in it, and a caller who mistyped
    // needs the message to name the hole rather than to say the flag is invalid. Each is a usage
    // error: the command line is what was wrong, and nothing was registered.
    const cases = [
      { rule: 'bug sql', message: 'has no label and kind' },
      { rule: 'bug:sql', message: 'has no label and kind' },
      // A label with no kind: the one form where the label is fine and the `:` is what is missing.
      { rule: 'bug=1 = 1', message: `names no kind -- there is no ':' after the '='` },
      { rule: 'bug=sparql: 1 = 1', message: `names the kind "sparql"` },
      { rule: 'bug=sql:   ', message: 'names no query' },
    ];

    for (const { rule, message } of cases) {
      const run = asc(['annotate', '--scheme', 'review', '--rule', rule], dir);

      expect(run.status, `${rule}: ${run.stderr}`).toBe(2);
      expect(flatten(run.stderr), rule).toContain(message);
    }
    // `bug=` is the empty-query case spelled the other way, and it is the one `parseRule` reaches
    // through `equals <= 0` rather than through the empty-label check: an empty LABEL is `=sql: 1`.
    const emptyLabel = asc(['annotate', '--scheme', 'review', '--rule', '=sql: 1 = 1'], dir);
    expect(emptyLabel.status).toBe(2);
    expect(flatten(emptyLabel.stderr)).toContain('has no label and kind');

    // Nothing was written by any of them.
    expect(schemes(dir)).toStrictEqual([]);
  });

  it('refuses a duplicate rule, which first-match-wins could never reach', () => {
    const dir = seeded();

    const run = asc(
      ['annotate', '--scheme', 'review', '--rule', CRASH_IS_A_BUG, '--rule', CRASH_IS_A_BUG],
      dir,
    );

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('is the same rule as an earlier one');
  });
});

describe('asc annotate: concurrent runs (asc-q4p)', () => {
  it("keeps both labels when two runs add to the same new scheme at once, rather than dropping the loser's", async () => {
    const dir = seeded();

    // Two real ascend processes sharing one store -- the scenario `db.ts`'s own header names as the
    // reason a write lock exists at all. Neither names the other's label, so the defect this guards
    // against is unambiguous: a vocabulary union computed from a snapshot the other run's commit had
    // already invalidated drops the label that snapshot did not know about. Whichever process's
    // commit lands second must see the first one's write and union with it, not overwrite it -- and
    // that has to hold whichever order the OS actually runs them in, which is why the assertion below
    // does not care which.
    const [a, b] = await Promise.all([
      ascAsync(['annotate', '--scheme', 'concurrent', '--ids', 'from_a=e1'], dir),
      ascAsync(['annotate', '--scheme', 'concurrent', '--ids', 'from_b=e2'], dir),
    ]);

    expect(a.status, a.stderr).toBe(0);
    expect(b.status, b.stderr).toBe(0);

    // The LATEST version's vocabulary, not either run's own report of it: a report is what a
    // process believed it wrote, and the bug is a process that believed correctly about its own
    // write while a concurrent commit had invalidated the read behind it.
    expect(vocabulary(dir, 'concurrent')).toStrictEqual(['from_a', 'from_b']);
    expect(
      annotations(dir)
        .map((row) => row[1])
        .sort(),
    ).toStrictEqual(['from_a', 'from_b']);
  });
});

describe('asc annotate: --dry-run', () => {
  it('previews the census the real run then reports, and writes nothing', () => {
    const dir = seeded();
    // The labels are chosen so that the two plausible orderings DISAGREE -- `zzz` is the bigger
    // class and `aaa` sorts first -- because the preview's ordering is a second implementation of
    // the store's `ORDER BY n DESC, a.label ASC`, and this is the fixture that tells them apart.
    // Every other test here uses `bug` and `docs`, whose count order and alphabetical order coincide,
    // which is why an alphabetical preview would pass all of them.
    const args = [
      'annotate',
      '--scheme',
      'review',
      '--rule',
      "zzz=sql: evidence_text LIKE '%crash%'",
      '--rule',
      'aaa=fts: install',
      '--json',
    ];

    const dry = asc([...args, '--dry-run'], dir);

    expect(dry.status, dry.stderr).toBe(0);
    expect(schemes(dir)).toStrictEqual([]);
    expect(annotations(dir)).toStrictEqual([]);
    expect(flatten(dry.stderr)).toContain('dry run: nothing was written');

    const real = asc(args, dir);

    expect(real.status, real.stderr).toBe(0);
    // The preview's census is computed in memory by `censusOf` and the run's is read out of SQLite
    // by `schemeCensus` -- two implementations of one aggregation, pinned here. Everything except
    // the fields a preview cannot know is compared: `version` and `pass` are omitted from a dry run
    // rather than predicted, and `outcome` answers a different question.
    const preview = one(dry.stdout);
    const actual = one(real.stdout);
    expect(preview).toMatchObject({
      considered: actual['considered'],
      labelled: actual['labelled'],
      unclassified: actual['unclassified'],
      labels: actual['labels'],
      dry_run: true,
    });
    // Biggest class first, in both -- so the preview is not merely "a list of classes".
    expect(preview['labels']).toStrictEqual([
      { label: 'zzz', count: 4 },
      { label: 'aaa', count: 2 },
    ]);
    // And the version really is absent, rather than present as a guess.
    expect(Object.hasOwn(preview, 'version')).toBe(false);
    expect(Object.hasOwn(preview, 'pass')).toBe(false);
  });

  it('reports would-unchanged when the shape is already registered', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);

    const preview = reviewRun(dir, ['--dry-run', '--json']);

    expect(preview.status, preview.stderr).toBe(0);
    expect(one(preview.stdout)).toMatchObject({ outcome: 'would-unchanged' });
    // The first run's pass is the only one, so the preview wrote nothing.
    expect(column(dir, 'SELECT count(*) FROM annotations')).toStrictEqual([[6]]);
  });
});

/** A scheme registered with no pass at all, which `asc annotate` cannot produce. */
function schemeWithoutPass(dir: string): void {
  const store = openStore({ dir: join(dir, '.ascend') });
  try {
    registerScheme(
      store.db,
      'never_run',
      { labels: ['bug'], rules: [{ label: 'bug', kind: 'sql', query: '1 = 1' }] },
      { createdAt: '2026-01-01T00:00:00.000Z' },
    );
  } finally {
    store.close();
  }
}

describe('asc kappa: two schemes', () => {
  it('defaults each rater to its latest pass, not its first', () => {
    const dir = seeded();
    const first = reviewRun(dir, ['--json']);
    expect(first.status, first.stderr).toBe(0);
    const firstPass = one(first.stdout)['pass'] as string;

    // A SECOND pass under the same VERSION, which `--ids` is the way to get: hand labelling adds a
    // pass without changing the rules, so the shape is unchanged and no version is minted. Both
    // passes therefore sit under version 1, and which of them is read is visible in what got
    // compared -- the first pass labelled all six entries, this one labels one.
    //
    // Same version on purpose, though no longer because it has to be: before asc-nf4,
    // `annotationPasses` read only the scheme's LATEST version, so two passes under two versions
    // left the pass ordering untested -- one candidate in the list, first equal to last. It now
    // reads every version, so this case would survive a version bump; keeping both passes under
    // one version keeps this test about ordering alone.
    const second = asc(['annotate', '--scheme', 'review', '--ids', 'bug=e1', '--json'], dir);
    expect(second.status, second.stderr).toBe(0);
    const latest = one(second.stdout)['pass'] as string;
    expect(one(second.stdout)).toMatchObject({ version: 1, outcome: 'unchanged' });

    expect(
      asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1,e2', '--ids', 'docs=e3,e4,e5,e6'], dir)
        .status,
    ).toBe(0);

    const run = asc(['kappa', '--scheme', 'review', '--scheme', 'hand', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    const row = one(run.stdout);
    // The pass is asserted by name, so a failure names the pass rather than only reporting that a
    // number moved. `compared` is an integer and it is the one the LATEST pass implies -- one entry
    // labelled by both raters -- where reading the first pass would report six.
    expect(row['pass_a']).toBe(latest);
    expect(row['pass_a']).not.toBe(firstPass);
    // Both raters used one label over that one compared entry, so observed and expected are both 1
    // and kappa is 0/0: the degenerate denominator, a different fact from "the passes agree".
    expect(row).toMatchObject({ compared: 1, observed: 1, expected: 1, kappa: null });
  });

  it('measures agreement between the latest pass of each scheme', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    // The hand rater disagrees on e3 and did not label e4, so neither rater is a copy of the other.
    expect(
      asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1,e2', '--ids', 'docs=e3,e5,e6'], dir)
        .status,
    ).toBe(0);

    const run = asc(['kappa', '--scheme', 'review', '--scheme', 'hand', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    // The arithmetic, shown so a regression is a wrong number rather than a changed number:
    // compared = e1,e2,e3,e5,e6 = 5; agreed = 4 (e3 differs) so observed = 4/5 = 0.8.
    // Marginals: bug 3 by review and 2 by hand; docs 2 and 3.
    // expected = (3/5)(2/5) + (2/5)(3/5) = 6/25 + 6/25 = 0.48.
    // kappa = (0.8 - 0.48) / (1 - 0.48) = 0.32/0.52, whose closed form is 8/13 =
    // 0.6153846153846154. The literal below is one ulp above that, and it is the SHIPPED value:
    // `agreement.ts` divides the computed difference by the computed complement rather than reducing
    // the fraction, so the last bit differs from the hand arithmetic. Asserted exactly rather than
    // with a tolerance, because a tolerance would not notice the number changing.
    expect(one(run.stdout)).toMatchObject({
      scheme_a: 'review',
      scheme_b: 'hand',
      compared: 5,
      only_a: 1,
      only_b: 0,
      observed: 0.8,
      expected: 0.48,
      kappa: 0.6153846153846155,
      small_group: true,
      marginals: [
        { label: 'bug', a: 3, b: 2 },
        { label: 'docs', a: 2, b: 3 },
      ],
    });
  });

  it('reports the entries only one rater labelled instead of dropping them', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    expect(asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1,e2'], dir).status).toBe(0);

    const run = asc(['kappa', '--scheme', 'review', '--scheme', 'hand', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    // e1,e2 compared; e3,e4,e5,e6 only by review; nothing only by hand.
    expect(one(run.stdout)).toMatchObject({ compared: 2, only_a: 4, only_b: 0 });
  });

  it('omits the measure rather than reporting zero when the raters share no entry', () => {
    const dir = seeded();
    expect(asc(['annotate', '--scheme', 'crashy', '--rule', CRASH_IS_A_BUG], dir).status).toBe(0);
    expect(
      asc(['annotate', '--scheme', 'instally', '--rule', 'docs=fts: install'], dir).status,
    ).toBe(0);

    const run = asc(['kappa', '--scheme', 'crashy', '--scheme', 'instally', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    const row = one(run.stdout);
    // The counts are still there -- a caller parsing JSON can always see what was paired.
    expect(row).toMatchObject({ compared: 0, only_a: 4, only_b: 2 });
    // And the measurement is ABSENT, not zero. `observed: 0` would say the two raters disagreed
    // about every entry, which is a different and much worse claim than having nothing to compare.
    expect(Object.hasOwn(row, 'observed')).toBe(false);
    expect(Object.hasOwn(row, 'expected')).toBe(false);
    expect(Object.hasOwn(row, 'kappa')).toBe(false);
    expect(Object.hasOwn(row, 'small_group')).toBe(false);
    expect(flatten(run.stderr)).toContain('nothing to measure');
  });

  it('keeps a null kappa, and explains it, when the compared entries do not vary', () => {
    const dir = seeded();
    expect(asc(['annotate', '--scheme', 'a', '--ids', 'bug=e1,e2'], dir).status).toBe(0);
    expect(asc(['annotate', '--scheme', 'b', '--ids', 'bug=e1,e2'], dir).status).toBe(0);

    const run = asc(['kappa', '--scheme', 'a', '--scheme', 'b', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    // `null` rather than an omission, because this one IS computed: observed and expected are both
    // 1, so the ratio is 0/0. A perfect agreement between two raters who both used one label is a
    // fact about the entries, not an absent measurement.
    expect(one(run.stdout)).toMatchObject({
      compared: 2,
      observed: 1,
      expected: 1,
      kappa: null,
    });
    expect(flatten(run.stderr)).toContain('kappa is undefined here, not perfect');
  });

  it('names a scheme that is not registered, and the ones that are', () => {
    const dir = seeded();
    expect(asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1'], dir).status).toBe(0);

    const run = asc(['kappa', '--scheme', 'hand', '--scheme', 'nope', '--json'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("there is no annotation scheme named 'nope'");
    expect(flatten(run.stderr)).toContain("Registered schemes: 'hand'");
  });

  it('reads a scheme that has no pass at all, rather than dereferencing nothing', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    schemeWithoutPass(dir);

    const run = asc(['kappa', '--scheme', 'never_run', '--scheme', 'review', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    const row = one(run.stdout);
    // `pass_a` has no value to name, so it is null -- and the absence is stated rather than left as
    // a missing key, because the two raters were named and only one of them had anything to say.
    expect(row).toMatchObject({ scheme_a: 'never_run', pass_a: null, compared: 0, only_a: 0 });
    expect(Object.hasOwn(row, 'kappa')).toBe(false);
    expect(flatten(run.stderr)).toContain("scheme 'never_run' has no annotations");
  });

  it('finds a pass under an earlier version, rather than reporting no annotations, after a version bump that wrote none', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    expect(versionOf(dir, 'review')).toBe(1);

    // A rule change that matches nothing mints a new version -- the shape changed -- but writes no
    // pass (annotate.ts's own "empty pass is not written"). `review` is now on version 2, and
    // version 2 has zero rows in `annotations`; the six-entry pass from the run above is still
    // there, pinned to version 1.
    const bump = asc(['annotate', '--scheme', 'review', '--rule', 'none=sql: 0 = 1'], dir);
    expect(bump.status, bump.stderr).toBe(0);
    expect(versionOf(dir, 'review')).toBe(2);
    expect(
      column(
        dir,
        "SELECT count(*) FROM annotations WHERE scheme = 'review' AND scheme_version = 2",
      ),
    ).toStrictEqual([[0]]);

    expect(
      asc(['annotate', '--scheme', 'hand', '--ids', 'bug=e1,e2,e3,e4', '--ids', 'docs=e5,e6'], dir)
        .status,
    ).toBe(0);

    const run = asc(['kappa', '--scheme', 'review', '--scheme', 'hand', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    // "Each rater's latest pass" means the latest PASS review has ever written, not the (empty)
    // result of filtering to whichever version happens to be newest -- so this is version 1's pass,
    // compared against all six of hand's labels, agreeing on every one.
    expect(one(run.stdout)).toMatchObject({ scheme_a: 'review', compared: 6, kappa: 1 });
    expect(flatten(run.stderr)).not.toContain('has no annotations');
  });
});

describe('asc kappa: two passes of one scheme', () => {
  it('measures two runs of one scheme against each other', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    // The same scheme, the rules swapped: bug is now the install entries and docs the crash ones.
    expect(
      asc(
        [
          'annotate',
          '--scheme',
          'review',
          '--rule',
          "bug=sql: evidence_text LIKE '%install%'",
          '--rule',
          "docs=sql: evidence_text LIKE '%crash%'",
        ],
        dir,
      ).status,
    ).toBe(0);

    const passes = column(dir, 'SELECT DISTINCT created_at FROM annotations ORDER BY created_at');
    expect(passes).toHaveLength(2);
    const run = asc(
      [
        'kappa',
        '--scheme',
        'review',
        '--pass',
        String(passes[0]?.[0]),
        '--pass',
        String(passes[1]?.[0]),
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    // compared = 6, agreed = 0 so observed = 0. Marginals: bug 4 then 2; docs 2 then 4.
    // expected = (4/6)(2/6) + (2/6)(4/6) = 8/36 + 8/36 = 4/9 = 0.4444444444444444, which IS exactly
    // 4/9 as a double. kappa = -4/9 / (5/9) = -4/5, and the shipped value is one ulp above -0.8 for
    // the reason recorded at the two-scheme case: the ratio is taken from computed doubles.
    expect(one(run.stdout)).toMatchObject({
      scheme_a: 'review',
      scheme_b: 'review',
      compared: 6,
      only_a: 0,
      only_b: 0,
      observed: 0,
      expected: 4 / 9,
      kappa: -0.7999999999999999,
    });
  });

  it('reads a pass written under an older version without being told the version', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);
    const firstPass = String(column(dir, 'SELECT DISTINCT created_at FROM annotations')[0]?.[0]);
    // A rule change, so the scheme is on version 2 and `review`'s LATEST pass is version 2's.
    expect(asc(['annotate', '--scheme', 'review', '--rule', 'bug=sql: 0 = 1'], dir).status).toBe(0);
    expect(versionOf(dir, 'review')).toBe(2);

    const run = asc(
      ['kappa', '--scheme', 'review', '--pass', firstPass, '--pass', firstPass, '--json'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    // Version 1's pass, read without naming version 1 -- which is the documented refine-and-rerun
    // loop: you edit a rule, run again, and compare the two passes. It is the same pass twice here,
    // so agreement is total and the marginals are version 1's.
    expect(one(run.stdout)).toMatchObject({
      compared: 6,
      only_a: 0,
      only_b: 0,
      marginals: [
        { label: 'bug', a: 4, b: 4 },
        { label: 'docs', a: 2, b: 2 },
      ],
    });
  });

  it('names the passes that exist when --pass matches nothing', () => {
    const dir = seeded();
    expect(reviewRun(dir).status).toBe(0);

    const run = asc(
      ['kappa', '--scheme', 'review', '--pass', '1999-01-01T00:00:00.000Z', '--pass', 'x'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain(
      "scheme 'review' has no pass at 1999-01-01T00:00:00.000Z",
    );
    expect(flatten(run.stderr)).toContain('Its passes: 2');
  });
});

describe('asc kappa: the flag combinations', () => {
  const combos: readonly { readonly args: readonly string[]; readonly says: string }[] = [
    { args: [], says: 'no --scheme given' },
    { args: ['--scheme', 'a'], says: 'names one rater' },
    { args: ['--scheme', 'a', '--scheme', 'b', '--scheme', 'c'], says: 'given 3 times' },
    // asc-o9m: naming the same scheme twice is a single rater in disguise -- not caught by the
    // `schemes.length === 1` guard above, but the same defect and the same refusal.
    { args: ['--scheme', 'x', '--scheme', 'x'], says: 'compared with itself' },
    { args: ['--scheme', 'a', '--pass', 'x'], says: 'given 1 time(s)' },
    {
      args: ['--scheme', 'a', '--scheme', 'b', '--pass', 'x', '--pass', 'y'],
      says: 'two passes of ONE scheme',
    },
  ];

  for (const combo of combos) {
    it(`refuses ${combo.args.length === 0 ? 'no flags' : combo.args.join(' ')}`, () => {
      const dir = seeded();

      const run = asc(['kappa', ...combo.args], dir);

      expect(run.status).toBe(2);
      // A usage error rather than a refusal: every one of these is the caller having typed a
      // combination that names one rater, and none of them needs the store to have an opinion.
      expect(flatten(run.stderr)).toContain(combo.says);
    });
  }
});

describe('asc annotate and asc kappa: the surface', () => {
  it('documents both commands', () => {
    const dir = seeded();

    const annotate = asc(['annotate', '--help'], dir);
    const kappa = asc(['kappa', '--help'], dir);

    expect(annotate.status, annotate.stderr).toBe(0);
    expect(kappa.status, kappa.stderr).toBe(0);
    expect(annotate.stdout).toContain('--rule');
    expect(annotate.stdout).toContain('--scope');
    expect(kappa.stdout).toContain('--pass');
  });
});
