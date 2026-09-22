import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flatten } from './helpers.js';

/**
 * `asc invalidate`, driven as the real binary against a real store -- same reasoning as
 * `annotations.test.ts`: a subprocess exercises the flag parser, the streams and the exit code,
 * none of which a direct call would touch.
 *
 * Every claim about what was written is read back out of SQLite, never inferred from the command's
 * own report, for the same reason `annotations.test.ts` gives: a command that printed the right
 * report and wrote the wrong rows would pass a test that only read stdout.
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

/** The `--json` envelope's rows. One place, so its shape is stated once. */
function rows(stdout: string): readonly Record<string, unknown>[] {
  return (JSON.parse(stdout) as { rows: Record<string, unknown>[] }).rows;
}

/**
 * Every invalidation row in the store, as `[entry_id, label, note, value_json, created_by,
 * created_at]`, ordered by rowid -- true write order, which is what the atomicity tests need.
 *
 * Read directly against `annotations` rather than through `listInvalidations`/`asc invalidate
 * --list`, so this file's assertions about what was WRITTEN do not depend on the same command
 * being tested for what it READS.
 */
function invalidationRows(dir: string): readonly unknown[][] {
  const file = join(dir, '.ascend', 'ascend.db');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (
      db
        .prepare(
          'SELECT entry_id, label, note, value_json, created_by, created_at FROM annotations ' +
            "WHERE scheme = 'invalidation' ORDER BY rowid",
        )
        .all() as unknown as Record<string, unknown>[]
    ).map((row) => Object.values(row));
  } finally {
    db.close();
  }
}

/** A type to record into. */
const NOTE = { name: 'note', properties: [{ name: 'body', type: 'string' }] };

/** A project with three entries recorded and nothing invalidated. */
function seeded(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-invalidate-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'note.json'), JSON.stringify(NOTE));
  expect(asc(['types', 'define', join(dir, 'note.json')], dir).status).toBe(0);

  for (const id of ['e1', 'e2', 'e3']) {
    const entry = { id, properties: { body: id }, evidence_text: id };
    const run = asc(['record', NOTE.name, '-', '--json'], dir, JSON.stringify(entry));
    expect(run.status, run.stderr).toBe(0);
  }
  return dir;
}

describe('asc invalidate: writing', () => {
  it('writes a single invalidation and reports it', () => {
    const dir = seeded();

    const run = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'unit mismatch', '--json'],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    const list = rows(run.stdout);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      entry_id: 'e1',
      label: 'wrong_value',
      outcome: 'wrote',
      reason: 'unit mismatch',
      superseded_by: null,
      actor: null,
      dry_run: false,
    });
    expect(typeof list[0]?.['id']).toBe('string');
    expect(typeof list[0]?.['created_at']).toBe('string');

    expect(invalidationRows(dir)).toStrictEqual([
      ['e1', 'wrong_value', 'unit mismatch', null, null, list[0]?.['created_at']],
    ]);
  });

  it('records --superseded-by and --actor', () => {
    const dir = seeded();

    const run = asc(
      [
        'invalidate',
        'e1',
        '--label',
        'superseded',
        '--reason',
        'e2 measures the same thing better',
        '--superseded-by',
        'e2',
        '--actor',
        'claude-code',
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(rows(run.stdout)[0]).toMatchObject({
      label: 'superseded',
      superseded_by: 'e2',
      actor: 'claude-code',
    });
    expect(invalidationRows(dir)).toStrictEqual([
      [
        'e1',
        'superseded',
        'e2 measures the same thing better',
        JSON.stringify({ superseded_by: 'e2' }),
        'claude-code',
        rows(run.stdout)[0]?.['created_at'],
      ],
    ]);
  });

  it('writes a batch under one shared createdAt, and reports one row per entry', () => {
    const dir = seeded();

    const run = asc(
      [
        'invalidate',
        'e1',
        'e2',
        'e3',
        '--label',
        'wrong_subject',
        '--reason',
        'bad ingest',
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    const list = rows(run.stdout);
    expect(list.map((row) => row['entry_id'])).toStrictEqual(['e1', 'e2', 'e3']);
    expect(list.every((row) => row['outcome'] === 'wrote')).toBe(true);

    const written = invalidationRows(dir);
    expect(written).toHaveLength(3);
    // One event, one timestamp, however many entries it struck.
    expect(new Set(written.map((row) => row[5]))).toStrictEqual(new Set([list[0]?.['created_at']]));
  });

  it('writes NOTHING when one id in the batch is invalid -- the whole batch is one transaction', () => {
    const dir = seeded();

    // e2 exists; 'nope' does not. The store refuses 'nope' -- see `annotations.ts`'s
    // `recordInvalidation` -- and that refusal must roll back e2's write too.
    const run = asc(
      ['invalidate', 'e2', 'nope', '--label', 'wrong_subject', '--reason', 'bad ingest'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("entry 'nope' does not exist");
    expect(invalidationRows(dir)).toStrictEqual([]);
  });

  it('reports created: false as "already" on an exact repeat within one batch', () => {
    const dir = seeded();

    // e1 named twice with identical label/reason/actor, in one invocation. `recordInvalidation`'s
    // id is a hash of the CLAIM (entryId, label, reason, supersededBy, createdBy) -- createdAt is
    // stored but does not participate in identity -- so the two calls collide regardless of
    // whether they'd share a timestamp. The first call writes; the second is the same
    // invalidation and writes nothing. The cross-invocation case (identity surviving a real
    // clock tick between two separate `asc invalidate` calls) is covered below.
    const run = asc(
      [
        'invalidate',
        'e1',
        'e1',
        '--label',
        'wrong_value',
        '--reason',
        'duplicate on purpose',
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    const list = rows(run.stdout);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ entry_id: 'e1', outcome: 'wrote' });
    expect(list[1]).toMatchObject({ entry_id: 'e1', outcome: 'already' });
    // Same content-derived id both times -- it is the SAME invalidation, reported twice.
    expect(list[0]?.['id']).toBe(list[1]?.['id']);
    // Only one row actually landed in the store.
    expect(invalidationRows(dir)).toHaveLength(1);
  });

  it("refuses 'superseded' with no --superseded-by, in the store's own words", () => {
    const dir = seeded();

    const run = asc(['invalidate', 'e1', '--label', 'superseded', '--reason', 'replaced'], dir);

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain(
      "invalidation of entry 'e1' has label 'superseded' but no 'supersededBy'",
    );
    expect(invalidationRows(dir)).toStrictEqual([]);
  });

  it("refuses --superseded-by on a label that isn't 'superseded', in the store's own words", () => {
    const dir = seeded();

    const run = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'x', '--superseded-by', 'e2'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("its label is 'wrong_value', not 'superseded'");
    expect(invalidationRows(dir)).toStrictEqual([]);
  });

  it('refuses a label outside the closed vocabulary, naming the valid set', () => {
    const dir = seeded();

    const run = asc(['invalidate', 'e1', '--label', 'nope', '--reason', 'x'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('wrong_subject');
    expect(flatten(run.stderr)).toContain('wrong_value');
    expect(flatten(run.stderr)).toContain('superseded');
  });

  it('refuses a run with no entry id', () => {
    const dir = seeded();

    const run = asc(['invalidate', '--label', 'wrong_value', '--reason', 'x'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('give at least one entry id');
  });

  it('refuses a run with no --label', () => {
    const dir = seeded();

    const run = asc(['invalidate', 'e1', '--reason', 'x'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--label is required');
  });

  it('refuses a run with no --reason', () => {
    const dir = seeded();

    const run = asc(['invalidate', 'e1', '--label', 'wrong_value'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--reason is required');
  });
});

describe('asc invalidate: identity is the claim, not the moment', () => {
  it(
    'reports "already" on a repeat across two SEPARATE invocations, and writes only one row -- ' +
      'the real-world case of a user re-running the same command',
    () => {
      const dir = seeded();

      const first = asc(
        ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'unit mismatch', '--json'],
        dir,
      );
      // A real clock tick between the two calls -- this is what a hash keyed on `createdAt` could
      // never collide across, and what a hash keyed on the claim (entryId, label, reason,
      // supersededBy, createdBy) collides on regardless.
      const second = asc(
        ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'unit mismatch', '--json'],
        dir,
      );

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(rows(first.stdout)[0]).toMatchObject({ entry_id: 'e1', outcome: 'wrote' });
      expect(rows(second.stdout)[0]).toMatchObject({ entry_id: 'e1', outcome: 'already' });
      // Same content-derived id both times: the second call named the same claim, not a new one.
      expect(rows(second.stdout)[0]?.['id']).toBe(rows(first.stdout)[0]?.['id']);
      // The stored created_at is when the claim was FIRST made -- the no-op repeat did not
      // refresh it.
      expect(rows(second.stdout)[0]?.['created_at']).toBe(rows(first.stdout)[0]?.['created_at']);

      // Only one row actually exists.
      expect(invalidationRows(dir)).toHaveLength(1);

      const list = asc(['invalidate', '--list', '--json'], dir);
      expect(list.status, list.stderr).toBe(0);
      expect(rows(list.stdout)).toHaveLength(1);
      expect(rows(list.stdout)[0]).toMatchObject({ entry_id: 'e1', reason: 'unit mismatch' });
    },
  );

  it('writes two rows across two invocations with a DIFFERENT --reason, and --list shows both newest-first', () => {
    const dir = seeded();

    const first = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'first reason', '--json'],
      dir,
    );
    const second = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'second reason', '--json'],
      dir,
    );

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    // Two different claims about the same entry -- both write.
    expect(rows(first.stdout)[0]).toMatchObject({ outcome: 'wrote' });
    expect(rows(second.stdout)[0]).toMatchObject({ outcome: 'wrote' });
    expect(rows(second.stdout)[0]?.['id']).not.toBe(rows(first.stdout)[0]?.['id']);
    expect(invalidationRows(dir)).toHaveLength(2);

    const list = asc(['invalidate', '--list', '--json'], dir);
    expect(list.status, list.stderr).toBe(0);
    const listed = rows(list.stdout);
    expect(listed).toHaveLength(2);
    // Newest first: the second call's invalidation reads back before the first's.
    expect(listed.map((row) => row['reason'])).toStrictEqual(['second reason', 'first reason']);
  });
});

describe('asc invalidate: --dry-run', () => {
  it('writes nothing and reports what would happen', () => {
    const dir = seeded();

    const run = asc(
      [
        'invalidate',
        'e1',
        'e2',
        '--label',
        'wrong_subject',
        '--reason',
        'previewed',
        '--dry-run',
        '--json',
      ],
      dir,
    );

    expect(run.status, run.stderr).toBe(0);
    expect(flatten(run.stderr)).toContain('dry run: nothing was written');
    const list = rows(run.stdout);
    expect(list).toHaveLength(2);
    expect(list.every((row) => row['dry_run'] === true)).toBe(true);
    expect(list.map((row) => row['outcome'])).toStrictEqual(['would-write', 'would-write']);
    expect(invalidationRows(dir)).toStrictEqual([]);
  });

  it('still refuses an invalid batch, and still writes nothing', () => {
    const dir = seeded();

    const run = asc(
      ['invalidate', 'e1', 'nope', '--label', 'wrong_subject', '--reason', 'x', '--dry-run'],
      dir,
    );

    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("entry 'nope' does not exist");
    expect(invalidationRows(dir)).toStrictEqual([]);
  });
});

describe('asc invalidate: --list', () => {
  it('reports invalidations newest-first', () => {
    const dir = seeded();
    expect(
      asc(['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'first'], dir).status,
    ).toBe(0);
    expect(
      asc(['invalidate', 'e2', '--label', 'wrong_subject', '--reason', 'second'], dir).status,
    ).toBe(0);

    const run = asc(['invalidate', '--list', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    const list = rows(run.stdout);
    expect(list).toHaveLength(2);
    // Newest first: the second invalidation (e2) is written after the first (e1).
    expect(list.map((row) => row['entry_id'])).toStrictEqual(['e2', 'e1']);
    expect(list[0]).toMatchObject({
      entry_id: 'e2',
      label: 'wrong_subject',
      reason: 'second',
      superseded_by: null,
      actor: null,
    });
  });

  it('filters by entry id when one is given', () => {
    const dir = seeded();
    expect(asc(['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'a'], dir).status).toBe(
      0,
    );
    expect(asc(['invalidate', 'e2', '--label', 'wrong_subject', '--reason', 'b'], dir).status).toBe(
      0,
    );

    const run = asc(['invalidate', '--list', 'e2', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    expect(rows(run.stdout)).toHaveLength(1);
    expect(rows(run.stdout)[0]).toMatchObject({ entry_id: 'e2', reason: 'b' });
  });

  it('reports nothing for an entry never invalidated, rather than an error', () => {
    const dir = seeded();

    const run = asc(['invalidate', '--list', 'e3', '--json'], dir);

    expect(run.status, run.stderr).toBe(0);
    expect(rows(run.stdout)).toStrictEqual([]);
  });

  it('refuses --list combined with --reason', () => {
    const dir = seeded();

    const run = asc(['invalidate', '--list', '--reason', 'x'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--list cannot be combined with --reason');
  });

  it('refuses --list combined with every write flag at once, naming all of them', () => {
    const dir = seeded();

    const run = asc(
      [
        'invalidate',
        '--list',
        '--label',
        'wrong_value',
        '--reason',
        'x',
        '--superseded-by',
        'e2',
        '--actor',
        'me',
        '--dry-run',
      ],
      dir,
    );

    expect(run.status).toBe(2);
    const message = flatten(run.stderr);
    expect(message).toContain('--label');
    expect(message).toContain('--reason');
    expect(message).toContain('--superseded-by');
    expect(message).toContain('--actor');
    expect(message).toContain('--dry-run');
  });

  it('refuses --list given more than one entry id', () => {
    const dir = seeded();

    const run = asc(['invalidate', '--list', 'e1', 'e2'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--list takes at most one entry id');
  });
});

describe('asc invalidate: --json carries what --table shows', () => {
  it('agrees with the table on the same run', () => {
    const dir = seeded();

    const json = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'consistency check', '--json'],
      dir,
    );
    expect(json.status, json.stderr).toBe(0);
    const row = rows(json.stdout)[0];
    expect(row).toBeDefined();

    const dir2 = seeded();
    const table = asc(
      ['invalidate', 'e1', '--label', 'wrong_value', '--reason', 'consistency check'],
      dir2,
    );
    expect(table.status, table.stderr).toBe(0);
    expect(table.stdout).toContain('e1');
    expect(table.stdout).toContain('wrong_value');
    expect(table.stdout).toContain('wrote');
    expect(table.stdout).toContain('consistency check');
  });
});

describe('asc invalidate: the surface', () => {
  it('documents the command', () => {
    const dir = seeded();

    const help = asc(['invalidate', '--help'], dir);

    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--label');
    expect(help.stdout).toContain('--reason');
    expect(help.stdout).toContain('--superseded-by');
    expect(help.stdout).toContain('--list');
  });

  // `--superseded-by` is refused for every label but `superseded` -- the store enforces it and the
  // refusal reaches the caller as-is. An EXAMPLE that breaks that rule is worse than a missing one:
  // it is the command teaching an invocation that exits non-zero, and nothing else here would catch
  // it, because examples are printed rather than run. One shipped for a while (asc-y7p), pairing
  // `--label wrong_value` with `--superseded-by e19`, and it was found by running it rather than by
  // reading it. This pins the invariant instead of the wording, so rephrasing an example is free
  // and contradicting the flag rule is not.
  it('shows no example that the flags themselves would refuse', () => {
    const dir = seeded();

    const help = asc(['invalidate', '--help'], dir);

    expect(help.status, help.stderr).toBe(0);
    const examples = help.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('$ ') && line.includes('invalidate'));
    expect(examples.length).toBeGreaterThan(0);

    for (const example of examples) {
      if (!example.includes('--superseded-by')) continue;
      expect(
        example,
        `example names --superseded-by without --label superseded: ${example}`,
      ).toContain('--label superseded');
    }
  });
});
