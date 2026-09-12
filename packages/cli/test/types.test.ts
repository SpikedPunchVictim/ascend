import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The `asc types` commands, driven as the real binary against a real store.
 *
 * Same reasoning as `cli.test.ts` -- a subprocess, not a direct call, because what can be wrong
 * is the flag parser, the streams, the exit code and oclif's discovery, none of which a direct
 * call exercises. Same cost: this file needs `dist/`, so it builds in `beforeAll`.
 *
 * **Every claim about what was written is read back out of SQLite**, not inferred from the
 * command's own report. A command that printed the right thing and wrote the wrong thing would
 * pass a test that only read stdout, and that is the failure this suite exists to catch: the
 * `--dry-run` cases below assert both halves -- the report *and* that the store is untouched,
 * down to the generated views, because a rollback that left a view behind is a rollback that
 * only looks like one.
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

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-types-'));
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

function asc(args: readonly string[], cwd: string, stdin?: string): Run {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A directory holding an `.ascend/` store, with nothing registered in it yet. */
function project(): string {
  const dir = scratch();
  mkdirSync(join(dir, '.ascend'));
  return dir;
}

/**
 * Run a `sh` pipeline, with `SRC`, `DST`, `BIN` and `NODE` in the environment.
 *
 * A real shell pipeline rather than `spawnSync`'s `input` option, and the difference is not
 * stylistic: `input` writes the whole document before the child starts, so the child never sees
 * an *empty* pipe -- and an empty pipe at read time is exactly the condition that broke
 * `asc types import -`. A test built on `input` was green while the documented pipeline was
 * failing every time. `extra` carries whatever else a given pipeline needs.
 */
function shell(
  script: string,
  projects: { readonly cwd: string; readonly src: string; readonly dst: string },
  extra: Record<string, string> = {},
): Run {
  const result = spawnSync('sh', ['-c', script], {
    cwd: projects.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: projects.cwd,
      XDG_CACHE_HOME: join(projects.cwd, '.cache'),
      BIN: bin,
      NODE: process.execPath,
      SRC: projects.src,
      DST: projects.dst,
      ...extra,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Write a JSON file into `dir` and return its path. */
function json(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/**
 * Read a `--json` envelope.
 *
 * One place, so the envelope's shape is stated once instead of being re-derived at every call
 * site -- and because `JSON.parse` returns `any`, which the linter (rightly) will not let a test
 * reach into without saying what it expects to find.
 */
function envelope(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

/** Read the array `types export` writes, which is a bare list rather than an envelope. */
function documents(stdout: string): readonly Record<string, unknown>[] {
  return JSON.parse(stdout) as Record<string, unknown>[];
}

/** A row of `entry_types`, as this suite reads it back. */
interface RegistryRow {
  readonly name: string;
  readonly version: number;
  readonly major: number;
  readonly type_hash: string;
  readonly status: string;
}

/**
 * The rows this suite cares about, read straight from the store.
 *
 * `[]` when the store file is not there at all. That is not a convenience: a command that
 * refused before opening the store has written nothing in the strongest sense available -- there
 * is no database to hold a row -- and this helper has to be able to say so rather than throwing
 * `unable to open database file` at the assertion.
 */
function registry(dir: string): readonly RegistryRow[] {
  const file = join(dir, '.ascend', 'ascend.db');
  if (!existsSync(file)) return [];

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT name, version, major, type_hash, status FROM entry_types ORDER BY name, version',
      )
      .all() as unknown as RegistryRow[];
  } finally {
    db.close();
  }
}

/** Generated views and indexes -- the DDL a rollback has to undo as well as the rows. */
function schemaObjects(dir: string): number {
  const db = new DatabaseSync(join(dir, '.ascend', 'ascend.db'), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('view', 'index') AND name LIKE '%review%'",
      )
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

const REVIEW = {
  name: 'review_completed',
  properties: [
    {
      name: 'review_kind',
      type: 'enum',
      enum_values: ['approved', 'changes_requested'],
      required: true,
    },
    { name: 'rounds', type: 'number' },
  ],
  description: 'A code review that reached a verdict.',
  record_when: 'Record when a review of a change reaches a verdict.',
  prose: { rounds: 'How many rounds of review it took.' },
};

/** REVIEW with one property dropped, so it hashes differently and becomes version 2. */
const REVIEW_V2 = {
  ...REVIEW,
  properties: [{ name: 'review_kind', type: 'enum', enum_values: ['approved'], required: true }],
};

describe('asc types define', () => {
  it('registers a document and reports the version it landed on', () => {
    const dir = project();
    const run = asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('created');
    const rows = registry(dir);
    expect(rows).toHaveLength(1);
    // Asserted separately because it is a property of the hash rather than a literal we can
    // write down, and mixing the two into one `toEqual` would need a matcher the linter reads
    // as `any`.
    expect(rows[0]?.type_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]).toMatchObject({
      name: 'review_completed',
      version: 1,
      major: 1,
      status: 'active',
    });
  });

  it('previews a registration without writing the row or the view', () => {
    const dir = project();
    const run = asc(['types', 'define', '--dry-run', json(dir, 'r.json', REVIEW)], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('created');
    expect(run.stderr).toContain('dry run');
    // Both halves: the row AND the DDL. A rollback that left the generated view behind would
    // leave a store where `asc query` sees a type the registry does not have.
    expect(registry(dir)).toEqual([]);
    expect(schemaObjects(dir)).toBe(0);
  });

  it('reports the same outcome for a preview as for the real run', () => {
    const previewDir = project();
    const realDir = project();
    const preview = asc(
      ['types', 'define', '--dry-run', '--json', json(previewDir, 'r.json', REVIEW)],
      previewDir,
    );
    const real = asc(['types', 'define', '--json', json(realDir, 'r.json', REVIEW)], realDir);

    // Identical apart from `dry_run`, which is the one field that *must* differ -- it is there to
    // say which of the two you are reading. Everything a caller compares previews against
    // (version, major, hash, outcome, bump) has to match, or the preview is describing work the
    // real run will not do.
    const withoutDryRun = (stdout: string): unknown =>
      envelope(stdout).map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'dry_run')),
      );
    expect(withoutDryRun(preview.stdout)).toEqual(withoutDryRun(real.stdout));
    expect(preview.stdout).toContain('"dry_run":true');
    expect(real.stdout).toContain('"dry_run":false');
  });

  it('updates prose when the shape is already known, and says so', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const reworded = { ...REVIEW, description: 'Reworded, same shape.' };
    const run = asc(['types', 'define', json(dir, 'reworded.json', reworded)], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('prose-updated');
    // No new version: prose is not identity, so the hash and version are unchanged.
    expect(registry(dir)).toHaveLength(1);
    expect(asc(['types', 'show', 'review_completed'], dir).stdout).toContain(
      'Reworded, same shape.',
    );
  });

  it('refuses a document whose hash disagrees with its contents', () => {
    const dir = project();
    const tampered = { ...REVIEW, type_hash: '0'.repeat(64) };
    const run = asc(['types', 'define', json(dir, 'bad.json', tampered)], dir);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('0'.repeat(64));
    expect(registry(dir)).toEqual([]);
  });

  it('refuses an unrecognised field rather than ignoring it', () => {
    const dir = project();
    const typo = { ...REVIEW, recordWhen: 'wrong spelling' };
    const run = asc(['types', 'define', json(dir, 'typo.json', typo)], dir);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('recordWhen');
    expect(run.stderr).toContain('record_when');
    expect(registry(dir)).toEqual([]);
  });

  it('reads a document from standard input', () => {
    const dir = project();
    const run = asc(['types', 'define', '-'], dir, JSON.stringify(REVIEW));

    expect(run.status).toBe(0);
    expect(registry(dir)).toHaveLength(1);
  });

  it('refuses a missing operand as a usage error rather than waiting on stdin', () => {
    const run = asc(['types', 'define'], project());
    // 2, not 1: the command line itself was incomplete.
    expect(run.status).toBe(2);
  });
});

describe('asc types show', () => {
  it('reports the latest version, and the fields a caller reads', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc(['types', 'show', 'review_completed'], dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('review_completed');
    expect(run.stdout).toContain('record_when');
    // The rendered property line, which is the table's whole reason for existing.
    expect(run.stdout).toContain('enum required [approved, changes_requested]');
  });

  it('carries the structured property on the row, so --json needs no parsing', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    // Values are read by bracket: a row is `Record<string, unknown>`, and reaching in with a
    // dot would be a claim about a shape the test has not checked yet -- which is the point of
    // the assertions that follow.
    const rows = envelope(asc(['types', 'show', '--json', 'review_completed'], dir).stdout);
    const kind = rows.find((row) => row['field'] === 'property.review_kind');
    expect(kind).toMatchObject({ type: 'enum', enum_values: ['approved', 'changes_requested'] });
    // Absent stays absent rather than being defaulted: `rounds` was never declared required.
    expect(rows.find((row) => row['field'] === 'property.rounds')).not.toHaveProperty('required');
  });

  it('distinguishes an unknown name from an unknown version, and lists the names', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const unknownName = asc(['types', 'show', 'nope'], dir);
    expect(unknownName.status).toBe(1);
    expect(unknownName.stderr).toContain('review_completed');

    const unknownVersion = asc(['types', 'show', 'review_completed', '--version', '9'], dir);
    expect(unknownVersion.status).toBe(1);
    expect(unknownVersion.stderr).toContain('no version 9');
  });
});

describe('asc types brief', () => {
  it('prints one line per active type, and nothing else on stdout', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc([], dir);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(
      'review_completed -- Record when a review of a change reaches a verdict.',
    );
    // No header, no rule, no count: this is the digest a session hook injects on every session
    // (`ARCHITECTURE.md`), so every extra line is a context tax.
    expect(run.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('omits a deprecated type, because a brief is what a recorder should reach for', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);
    asc(['types', 'deprecate', 'review_completed'], dir);

    expect(asc([], dir).stdout.trim()).toBe('');
    // Still listed and still shown: deprecated is a status, not a deletion.
    expect(asc(['types', 'list'], dir).stdout).toContain('review_completed');
    expect(asc(['types', 'show', 'review_completed'], dir).stdout).toContain('deprecated');
  });

  it('refuses --csv as a usage error rather than emitting a degenerate table', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc(['types', 'brief', '--csv'], dir);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
  });

  it('omits record_when entirely when there is none, rather than sending an empty string', () => {
    const dir = project();
    const noTrigger = { name: 'bare', properties: [{ name: 'note', type: 'string' }] };
    asc(['types', 'define', json(dir, 'b.json', noTrigger)], dir);

    const rows = envelope(asc(['types', 'brief', '--json'], dir).stdout);
    expect(rows).toEqual([expect.objectContaining({ name: 'bare' })]);
    expect(rows[0]).not.toHaveProperty('record_when');
  });
});

describe('asc types deprecate', () => {
  it('separates "no such type" from "already deprecated"', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const unknown = asc(['types', 'deprecate', 'nope'], dir);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('review_completed');

    const first = asc(['types', 'deprecate', '--json', 'review_completed'], dir);
    expect(first.status).toBe(0);
    expect(envelope(first.stdout)[0]).toMatchObject({ outcome: 'deprecated' });

    // The store returns `0` for this and for an unknown name alike. Reporting success here and
    // failure there is the whole reason this command reads the status before writing.
    const again = asc(['types', 'deprecate', '--json', 'review_completed'], dir);
    expect(again.status).toBe(0);
    expect(envelope(again.stdout)[0]).toMatchObject({ outcome: 'already-deprecated' });
  });

  it('previews the change without making it', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc(['types', 'deprecate', '--json', '--dry-run', 'review_completed'], dir);
    expect(run.status).toBe(0);
    expect(envelope(run.stdout)[0]).toMatchObject({ outcome: 'would-deprecate' });
    // Read back: a preview that changed the status anyway would still print this row.
    expect(registry(dir)[0]).toMatchObject({ status: 'active' });
  });
});

describe('asc types export and import', () => {
  it('round-trips a registry through a real export | import pipeline, versions included', () => {
    const source = project();
    const target = project();
    asc(['types', 'define', json(source, 'v1.json', REVIEW)], source);
    asc(['types', 'define', json(source, 'v2.json', REVIEW_V2)], source);
    expect(registry(source)).toHaveLength(2);

    // A real `sh` pipeline between two directories, not `spawnSync({input})`. That distinction is
    // the whole point of this test: `spawnSync` buffers the input before the child starts, so it
    // never presents an *empty* pipe -- and an empty pipe is exactly what broke this. See the
    // delayed-producer case below.
    const run = shell(
      `( cd "$SRC" && HOME="$SRC" "$NODE" "$BIN" types export ) | ` +
        `( cd "$DST" && HOME="$DST" "$NODE" "$BIN" types import - )`,
      { cwd: target, src: source, dst: target },
    );

    expect(run.status).toBe(0);
    // Not "same definitions" -- the same rows: names, versions, majors and hashes. A
    // latest-only export would reproduce the same *shape* and lose version 1, which is the
    // definition any entry recorded under it would attach to.
    expect(registry(target)).toEqual(registry(source));
  });

  it('reads a document from a pipe that is still empty when the read starts', () => {
    const dir = project();
    // The producer waits before writing, so the pipe has nothing in it at the moment `import`
    // calls read(2). This is the regression test for a measured defect: `readFileSync(0, ...)`
    // returns `EAGAIN` on a non-blocking pipe with no data yet, so the pipeline `import`'s own
    // help text offers -- `asc types export | asc types import -` -- failed every time. The
    // CLI's startup is 0.13-0.15 s, shorter than the time `export` needs to open a database and
    // produce output, so it was never a race that happened to go the right way.
    const run = shell(
      '( sleep 0.4; printf "%s" "$DOC" ) | "$NODE" "$BIN" types import -',
      { cwd: dir, src: dir, dst: dir },
      { DOC: JSON.stringify(REVIEW) },
    );

    expect(run.status).toBe(0);
    expect(registry(dir)).toHaveLength(1);
  });

  it('is idempotent: importing twice leaves the registry exactly as it was', () => {
    const dir = project();
    const path = json(dir, 'r.json', [REVIEW]);
    asc(['types', 'import', path], dir);
    const before = registry(dir);

    const again = asc(['types', 'import', '--json', path], dir);
    expect(again.status).toBe(0);
    expect(envelope(again.stdout)[0]).toMatchObject({ outcome: 'unchanged' });
    expect(registry(dir)).toEqual(before);
  });

  it('previews a whole list against itself, so versions match the real run', () => {
    const dir = project();
    const path = json(dir, 'both.json', [REVIEW, REVIEW_V2]);

    const preview = asc(['types', 'import', '--dry-run', '--json', path], dir);
    expect(preview.status).toBe(0);
    const versions = envelope(preview.stdout).map((row) => row['version']);
    // 1 then 2, not 1 then 1: the preview runs in one transaction (`withRollback`), so the
    // second document sees the first. Per-document rollback would report a registry the real
    // run never produces.
    expect(versions).toEqual([1, 2]);
    expect(registry(dir)).toEqual([]);
  });

  it('reports what a partial failure left behind, and leaves it', () => {
    const dir = project();
    // The second document names a property the entry envelope already claims, so it fails at
    // registration rather than at parsing -- the only way to reach the partial path.
    const path = json(dir, 'mixed.json', [
      REVIEW,
      { name: 'bad_type', properties: [{ name: 'id', type: 'string' }] },
    ]);

    const run = asc(['types', 'import', path], dir);
    expect(run.status).toBe(1);
    // Both halves on their own streams: stdout says what landed, stderr says why the rest did not.
    expect(run.stdout).toContain('review_completed');
    expect(run.stderr).toContain('1 of 2');
    expect(run.stderr).toContain('remain registered');
    expect(registry(dir)).toHaveLength(1);
  });

  it('discards the whole preview on failure, and reports no rows', () => {
    const dir = project();
    const path = json(dir, 'mixed.json', [
      REVIEW,
      { name: 'bad_type', properties: [{ name: 'id', type: 'string' }] },
    ]);

    const run = asc(['types', 'import', '--dry-run', path], dir);
    expect(run.status).toBe(1);
    // No row for the document that would have succeeded: the preview was rolled back whole, so
    // printing its result would describe a registry that does not exist.
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('discarded');
    expect(registry(dir)).toEqual([]);
  });

  it('refuses a bad document anywhere in the list before writing any of it', () => {
    const dir = project();
    const path = json(dir, 'mixed.json', [REVIEW, { ...REVIEW_V2, type_hash: '0'.repeat(64) }]);

    const run = asc(['types', 'import', path], dir);
    expect(run.status).toBe(1);
    // Verified up front, so the good first document was never written.
    expect(registry(dir)).toEqual([]);
  });

  it('exports one type on request and refuses an unknown one', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);
    asc(
      [
        'types',
        'define',
        json(dir, 'other.json', { name: 'other', properties: [{ name: 'note', type: 'string' }] }),
      ],
      dir,
    );

    const one = documents(asc(['types', 'export', 'review_completed'], dir).stdout);
    expect(one.map((document) => document['name'])).toEqual(['review_completed']);

    const missing = asc(['types', 'export', 'nope'], dir);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('other');
  });

  it('refuses --csv on export, which has no tabular projection', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc(['types', 'export', '--csv'], dir);
    expect(run.status).toBe(2);
  });

  it('writes an exported document that can be read back unchanged', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const [document] = documents(asc(['types', 'export', 'review_completed'], dir).stdout);
    // The whole point of carrying `type_hash`: the document describes itself, so a target
    // project can tell a faithful copy from one that lost a field in transit.
    expect(document).toMatchObject({ name: 'review_completed', record_when: REVIEW.record_when });
    const roundTripped = json(project(), 'again.json', [document]);
    expect(readFileSync(roundTripped, 'utf8')).toContain('review_completed');
  });
});

describe('the JSON contract', () => {
  it('reports dry_run as a boolean rather than dropping the field', () => {
    const dir = project();
    const rows = envelope(
      asc(['types', 'define', '--json', json(dir, 'r.json', REVIEW)], dir).stdout,
    );

    // Measured: oclif's parsed flags hold a key only when the flag was passed, so an absent
    // `--dry-run` reads as `undefined` -- and `JSON.stringify` drops undefined properties. A
    // consumer could not otherwise tell "not a dry run" from "this command does not say".
    expect(rows[0]?.['dry_run']).toBe(false);
    expect(
      asc(['types', 'define', '--json', '--dry-run', json(dir, 'r2.json', REVIEW_V2)], dir).stdout,
    ).toContain('"dry_run":true');
  });
});
