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

/**
 * Read the array `types export` writes for its DEFAULT output, which is a bare list rather than
 * an envelope -- because a round trip is this command's purpose and `import` parses this array.
 * `--json` is the envelope and is read with `envelope()` above, like every other command's.
 */
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

/**
 * REVIEW with one property dropped, so it hashes differently and becomes version 2.
 *
 * `rounds` is gone from the shape and its prose goes with it. Left in, this document would be
 * refusing itself: prose naming a property the definition does not declare is refused outright
 * (asc-bcv.15), so version 2 would never register. That is the right answer for a document whose
 * two halves disagree about what the type is, and it is why the drop is written down here rather
 * than inherited by spreading REVIEW.
 */
const REVIEW_V2 = {
  ...REVIEW,
  properties: [{ name: 'review_kind', type: 'enum', enum_values: ['approved'], required: true }],
  prose: { review_kind: 'The verdict that was reached.' },
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

describe('a piped value is never taken for an operand', () => {
  /**
   * oclif fills a MISSING positional argument from stdin unless the arg declares `ignoreStdin`
   * (`@oclif/core/lib/parser/parse.js`, `tryStdin`). Every operand in this file is a path or a
   * type name, so the fill read a document as a filename and a name as whatever a shell happened
   * to leave on stdin.
   *
   * **The suite was green before this fix, and why is worth recording.** Every test that pipes
   * into these commands passes `-` explicitly, and the one test that names this exact case -- the
   * "refuses a missing operand as a usage error rather than waiting on stdin" case just above --
   * passes no stdin at all. It asserts the right thing about a setup that cannot produce the bug.
   */
  const DOCUMENT = JSON.stringify(REVIEW);

  it('refuses a piped document instead of reading it as a path', () => {
    const dir = project();
    const run = asc(['types', 'define'], dir, DOCUMENT);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Missing 1 required arg');
    // The defect in one assertion: `ENOENT` is what "read as a path" looks like from outside.
    expect(run.stderr).not.toContain('ENOENT');
    expect(run.stderr).not.toContain('could not be read');
    // And nothing was registered, so the refusal is not merely a message.
    expect(registry(dir)).toEqual([]);
  });

  it('refuses a piped document for `import` too, which shares the operand shape', () => {
    const dir = project();
    const run = asc(['types', 'import'], dir, DOCUMENT);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('Missing 1 required arg');
    expect(run.stderr).not.toContain('ENOENT');
  });

  it('reads the same document when the caller says `-`, which is the whole difference', () => {
    const dir = project();
    const run = asc(['types', 'define', '-'], dir, DOCUMENT);

    expect(run.status).toBe(0);
    expect(registry(dir)).toHaveLength(1);
  });

  it('refuses a piped NAME where the operand is required', () => {
    // `deprecate` is a WRITE, which makes guessing its operand worse than guessing a read's.
    for (const command of ['show', 'deprecate']) {
      const run = asc(['types', command], project(), 'review');
      expect(run.status, `types ${command}`).toBe(2);
      expect(run.stderr, `types ${command}`).toContain('Missing 1 required arg');
    }
  });

  it('does not let an unrelated pipe narrow an export', () => {
    // The worst instance of the class, because it is the only silent one. `name` here is
    // `required: false`, so the fill did not fail -- it produced a DIFFERENT ANSWER. Measured
    // before the fix, in a project exporting 7 type entries: unpiped emitted all 7, `printf
    // 'decision' | asc types export` emitted 2, exit 0 both times, with nothing on stderr to say
    // a pipe had narrowed the result.
    const dir = project();
    const unpiped = asc(['types', 'export'], dir);
    const piped = asc(['types', 'export'], dir, 'review');

    expect(unpiped.status).toBe(0);
    expect(piped.status).toBe(0);
    expect(piped.stdout).toBe(unpiped.stdout);
  });
});

describe('asc types define, and how a prose key is spelled', () => {
  /**
   * End to end, because the store's fold is only half the fix: `define` of an already-known shape
   * reaches `updateTypeProse` directly, and the command compares the document's prose against what
   * is stored to decide whether to report `prose-updated`. Comparing raw keys against a folded map
   * reports a change on every run of an idempotent command -- the exact class of wrong answer
   * `register-document.ts` exists to prevent.
   */
  const SPELLED = { ...REVIEW, prose: { reviewKind: 'The verdict that was reached.' } };

  it('stores a camelCase key under the property it names, and reads it back', () => {
    const dir = project();
    const run = asc(['types', 'define', json(dir, 'r.json', SPELLED)], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('created');

    const rows = envelope(asc(['types', 'show', '--json', 'review_completed'], dir).stdout);
    expect(rows.find((row) => row['field'] === 'property.review_kind')).toMatchObject({
      description: 'The verdict that was reached.',
    });
  });

  it('reports `unchanged` on a second run of the same document, not `prose-updated`', () => {
    const dir = project();
    asc(['types', 'define', '--json', json(dir, 'r.json', SPELLED)], dir);

    const again = asc(['types', 'define', '--json', json(dir, 'r.json', SPELLED)], dir);

    expect(again.status).toBe(0);
    expect(envelope(again.stdout)[0]?.['outcome']).toBe('unchanged');
  });

  it('refuses a prose key that names no property, and registers nothing', () => {
    const dir = project();
    const run = asc(
      ['types', 'define', json(dir, 'r.json', { ...REVIEW, prose: { verdict: 'nope' } })],
      dir,
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("prose key 'verdict'");
    expect(run.stderr).toContain('review_kind');
    expect(registry(dir)).toEqual([]);
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

  it('renders a property description, which is stored in the prose column rather than the spec', () => {
    // Regression. `registry.ts` strips every prose field out of the spec before hashing and
    // storing it, so `row.spec.properties[].description` is always undefined -- which made
    // `renderProperty`'s description branch unreachable and `asc types show` silently omit
    // prose that `asc types export` was faithfully round-tripping. Silent, and load-bearing
    // the moment a property is `json`: the description is the only place the shape of what
    // goes INSIDE the array is written down.
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const run = asc(['types', 'show', 'review_completed'], dir);
    expect(run.stdout).toContain('-- How many rounds of review it took.');

    // And on the row, where the file comment says the machine-readable copy lives.
    const rows = envelope(asc(['types', 'show', '--json', 'review_completed'], dir).stdout);
    const rounds = rows.find((row) => row['field'] === 'property.rounds');
    expect(rounds).toMatchObject({ description: 'How many rounds of review it took.' });
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

  it('writes `[]` for an empty registry, so the pipeline its own help offers works', () => {
    // asc-bcv.13 (B10). `project()` here is a bare `.ascend/` directory -- the store exists and
    // migrates on first open, and no type was ever registered into it -- which is the empty
    // registry, reachable through the library and through any adapter that opens a store without
    // `asc init`'s starters.
    //
    // The command returned early for this case and wrote NOTHING, which is not JSON. Its own
    // `--help` offers `asc types export | asc types import -` as an example, and that pipeline
    // failed on an empty registry with `standard input is not valid JSON: Unexpected end of JSON
    // input` -- a failure that surfaces at restore time, which is the worst moment for a backup to
    // turn out not to have been readable. Measured before the fix (/tmp/probe-b10.mjs):
    // export exit=0 bytes=0, import exit=1.
    const dir = project();

    const run = asc(['types', 'export'], dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('[]\n');
    expect(documents(run.stdout)).toEqual([]);

    // The round trip is the reason this command exists, so it is asserted rather than inferred
    // from the bytes above: `[]` is only the right answer because `import` accepts it.
    const piped = shell('( "$NODE" "$BIN" types export ) | ( "$NODE" "$BIN" types import - )', {
      cwd: dir,
      src: dir,
      dst: dir,
    });
    expect(piped.status).toBe(0);
    expect(piped.stderr).not.toContain('not valid JSON');
    // And nothing was registered by importing nothing: the round trip is still a round trip.
    expect(registry(dir)).toEqual([]);
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

/**
 * What `--json` means on `types export` -- the one command whose default is the machine format.
 *
 * asc-qmn measured the defect: `asc types export --json` was byte-identical to the bare form
 * (the bead's fixture hashed `61b313eca9b75758b1dc6ba1b15d5219c07ec8ce` both ways), so a consumer
 * asking for "a versioned JSON envelope on stdout, the stable contract for scripts" -- `base.ts`'s
 * description of the flag -- received a bare array it could not tell from a future format change.
 * Every other command's `--json` is the envelope; this one now is too, which is `brief`'s rule
 * applied to the command that had not applied it: the line format is the command's own table, and
 * `--json` is where the rows become a contract.
 *
 * The four tests below are the four halves of that decision, including its cost. The cost one is
 * asserted rather than described, because a deliberately accepted regression that nothing tests is
 * indistinguishable from one nobody noticed.
 */
describe('asc types export, and what --json means', () => {
  it('renders the versioned envelope, as every other command does', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);

    const parsed = JSON.parse(asc(['types', 'export', '--json'], dir).stdout) as Record<
      string,
      unknown
    >;

    expect(Array.isArray(parsed)).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(['ascend_output', 'row_count', 'rows']);
    expect(parsed['ascend_output']).toBe(1);
    expect(parsed['row_count']).toBe(1);
  });

  it('keeps the bare form a document list, and wraps without losing a field', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);
    // A real shape change, not a prose edit: prose-only differences update the existing version
    // rather than minting one (`updates prose when the shape is already known`), so this fixture
    // is what makes the export two documents deep and gives the order something to preserve.
    asc(['types', 'define', json(dir, 'r2.json', REVIEW_V2)], dir);

    const bare = asc(['types', 'export'], dir);
    const wrapped = asc(['types', 'export', '--json'], dir);

    // The default is still the array `import` parses -- that is why the envelope is behind the
    // flag rather than around the default.
    expect(documents(bare.stdout).length).toBe(2);
    expect(bare.stdout).not.toBe(wrapped.stdout);
    // Not "the same definitions" -- the same bytes per document, in the same order. `rows` is
    // built from the same `documentsFor` the bare path writes, so a wrapper that reordered or
    // dropped a version would break the round trip it is meant to preserve.
    expect(envelope(wrapped.stdout)).toEqual(documents(bare.stdout));
  });

  it('counts the rows, so an empty registry is not a truncated answer', () => {
    // `project()` is a bare `.ascend/` with nothing registered -- the empty registry, and the case
    // where the bare form alone cannot say whether it is empty or cut short.
    const dir = project();

    expect(asc(['types', 'export'], dir).stdout).toBe('[]\n');
    const parsed = JSON.parse(asc(['types', 'export', '--json'], dir).stdout) as Record<
      string,
      unknown
    >;
    expect(parsed['rows']).toEqual([]);
    expect(parsed['row_count']).toBe(0);
  });

  it('refuses the envelope at import, which is the accepted cost of distinct spellings', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'r.json', REVIEW)], dir);
    const exported = asc(['types', 'export'], dir);

    // The control first: the documented pipeline -- no flag -- still round-trips. Without this,
    // the assertion below would pass for a project where `import` was broken outright.
    expect(asc(['types', 'import', '-'], dir, exported.stdout).status).toBe(0);

    // And the cost, named. `import` is deliberately not taught to unwrap an envelope: that would
    // give one pipeline two spellings differing only by a wrapper, which is the ambiguity this
    // change removes. The message has to name the field, because a caller who reached for
    // `--json` out of habit has to be able to see what they actually piped.
    const refused = asc(
      ['types', 'import', '-'],
      dir,
      asc(['types', 'export', '--json'], dir).stdout,
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('ascend_output');
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

/**
 * The define-time vocabulary check, as the user actually meets it.
 *
 * The store half is tested in `packages/store/test/vocabulary.test.ts`. What is asserted HERE is the
 * wiring: that a warning produced in `@ascend/store` reaches stderr through `asc types define`
 * without the CLI having to know the check exists. That is a claim about the `warnings` channel
 * being already general, and a claim like that is worth exactly as much as the test that drives it
 * -- `registerType` could return the warnings and the command could drop them, and every store test
 * would still pass.
 *
 * The fixtures are EV-drift's real drift: `review_stage` and `stage` are two names one author each
 * arrived at for the same slot, from the measurement's own corpus.
 */
const STAGE = {
  name: 'review_stage',
  properties: [{ name: 'stage', type: 'text' }],
};

/** A new type whose NAME shares the token `stage`, and whose property shares nothing. */
const OVERLAPPING = {
  name: 'stage',
  properties: [{ name: 'narrative', type: 'text' }],
};

describe('asc types define, and the vocabulary check', () => {
  it('carries the store warning to stderr, and still registers the type', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'a.json', STAGE)], dir);

    const run = asc(['types', 'define', json(dir, 'b.json', OVERLAPPING)], dir);

    // A warning is not a refusal. If this check ever blocked a definition it would be enforcing a
    // similarity threshold, and EV-drift measured that no such threshold can separate "same
    // concept, new name" from "different concept" at a 0.300 same-concept agreement.
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("shares 'stage'");
    expect(run.stderr).toContain('review_stage');

    // And the write actually landed, read back out of SQLite rather than inferred from the report:
    // a command that warned and then failed to register would satisfy the assertions above.
    expect(registry(dir).map((row) => row.name)).toEqual(['review_stage', 'stage']);
  });

  it('keeps the warning off stdout, so a pipeline still receives only data', () => {
    // `cli-best-practices` rule 1, asserted rather than assumed. `this.warn` is what routes it, so
    // this is the test that would fail if a future edit reached for `console.log`.
    const dir = project();
    asc(['types', 'define', json(dir, 'a.json', STAGE)], dir);

    const run = asc(['types', 'define', '--json', json(dir, 'b.json', OVERLAPPING)], dir);

    expect(run.stderr).toContain("shares 'stage'");
    expect(run.stdout).not.toContain('shares');
    // stdout is still parseable, which is the point of the separation.
    expect(envelope(run.stdout)[0]).toMatchObject({ name: 'stage', outcome: 'created' });
  });

  it('previews the warning on --dry-run, and registers nothing', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'a.json', STAGE)], dir);

    const run = asc(['types', 'define', '--dry-run', json(dir, 'b.json', OVERLAPPING)], dir);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("shares 'stage'");
    // A preview that carried the warning but wrote the type anyway would be the worst of both.
    expect(registry(dir).map((row) => row.name)).toEqual(['review_stage']);
  });

  it('says nothing when the definition reuses the registered vocabulary', () => {
    // The negative control, driven end to end. Without it, the three tests above would pass just as
    // well against a command that printed the warning unconditionally.
    const dir = project();
    asc(['types', 'define', json(dir, 'a.json', STAGE)], dir);

    const reuse = {
      name: 'note_alpha',
      properties: [{ name: 'stage', type: 'text' }],
    };
    const run = asc(['types', 'define', json(dir, 'b.json', reuse)], dir);

    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('shares');
  });
});

describe('the warning prefix is not doubled', () => {
  // A defect found by reading the real command's output, not by a test: `define.ts` and `import.ts`
  // both prefixed their own `warning: ` onto a string that `this.warn` already renders as
  // "Warning: ...", so every store warning reached the user as "Warning: warning: ...". A cosmetic
  // defect, and still one worth a test -- it shipped through a green suite because nothing asserted
  // the shape of the rendered line, only that it contained the warning's content.
  it('prints one "Warning:", not two, on define', () => {
    const dir = project();
    asc(['types', 'define', json(dir, 'a.json', STAGE)], dir);

    const run = asc(['types', 'define', json(dir, 'b.json', OVERLAPPING)], dir);

    expect(run.stderr).toContain("shares 'stage'");
    expect(run.stderr).not.toContain('warning: ');
  });

  it('prints one "Warning:", not two, on import', () => {
    const dir = project();
    const source = json(dir, 'src.json', [STAGE]);
    asc(['types', 'import', source], dir);

    // A second document against the same store, carrying a name that overlaps the first.
    const second = json(dir, 'second.json', [OVERLAPPING]);
    const run = asc(['types', 'import', second], dir);

    expect(run.stderr).toContain("shares 'stage'");
    expect(run.stderr).not.toContain('warning: ');
  });
});
