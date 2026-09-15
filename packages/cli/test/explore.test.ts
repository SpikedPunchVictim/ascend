import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc explore` -- driven as the real binary against a real store.
 *
 * A subprocess rather than a direct call, for the reason the other command suites give: what can
 * be wrong is the flag parser, the streams, the exit code and oclif's discovery, and a direct call
 * exercises none of them. `packages/store/test/profile.test.ts` already covers the profiling
 * itself; this file covers the command, which is the part a caller actually reaches.
 *
 * **What this file is really checking is that the profile is a MAP and not a page.** The command
 * exists so an LLM plans its own drill-down, so the assertions are about what the map states --
 * the count, the per-property tally, the summary -- and about the two ways a profile can be
 * read wrongly: an unregistered type reported as an empty one, and a state that was never
 * exercised rendered as though it had been omitted for a reason.
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** stderr with oclif's wrap decoration removed, so a substring assertion means what it reads like. */
function flatten(text: string): string {
  return text
    .replace(/^\s*›\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ProfileRow {
  readonly field: string;
  readonly value?: unknown;
  readonly tally?: string;
  readonly distinct?: number;
  readonly values?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly states?: {
    readonly measured: number;
    readonly not_applicable: number;
    readonly not_measured: number;
    readonly not_declared: number;
  };
  readonly declared_entries?: number;
  readonly top?: readonly { readonly value: string; readonly count: number }[];
  readonly min?: unknown;
  readonly max?: unknown;
}

function rows(stdout: string): readonly ProfileRow[] {
  return (JSON.parse(stdout) as { rows: ProfileRow[] }).rows;
}

const find = (list: readonly ProfileRow[], field: string): ProfileRow | undefined =>
  list.find((row) => row.field === field);

const fields = (list: readonly ProfileRow[], prefix: string): readonly string[] =>
  list.filter((row) => row.field.startsWith(prefix)).map((row) => row.field);

const property = (list: readonly ProfileRow[], name: string): ProfileRow => {
  const row = find(list, `property.${name}`);
  if (row === undefined) throw new Error(`no property row for '${name}'`);
  return row;
};

/** One property of every summary shape, so all three branches are reachable from one fixture. */
const SPEC = {
  name: 'attempt',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['ok', 'bad'] },
    { name: 'count', type: 'integer' },
    { name: 'note', type: 'text' },
    { name: 'at', type: 'timestamp' },
  ],
};

/** A directory holding an `.ascend/` store with SPEC registered and nothing recorded. */
function emptyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-explore-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);
  return dir;
}

describe('asc explore: the map', () => {
  it('reports the count, the versions, the properties and the recorded_at range', () => {
    const dir = emptyProject();
    for (const outcome of ['ok', 'ok', 'bad']) {
      expect(asc(['record', SPEC.name, '--prop', `outcome=${outcome}`, '--json'], dir).status).toBe(
        0,
      );
    }

    const run = asc(['explore', SPEC.name, '--json'], dir);

    expect(run.status).toBe(0);
    const list = rows(run.stdout);
    expect(find(list, 'type')?.value).toBe(SPEC.name);
    expect(find(list, 'count')?.value).toBe(3);
    expect(find(list, 'property_count')?.value).toBe(SPEC.properties.length);
    expect(find(list, 'version_count')?.value).toBe(1);
    // The `recorded_at` range is present for a non-empty type, and both ends are ISO 8601.
    expect(String(find(list, 'recorded_at_min')?.value)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(find(list, 'recorded_at_max')?.value)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(find(list, 'version.1')?.value).toBe('major 1, active, 3 entries');
    // EXACTLY the versions that are registered -- not merely "at least one". `version_count` is
    // computed from the profile rather than from the rows, so without this an extra or duplicated
    // version row reaches the reader while the header still reports the correct total.
    expect(fields(list, 'version.')).toStrictEqual(['version.1']);
  });

  it('tallies the three states, with the measured zero counted as measured', () => {
    const dir = emptyProject();
    // Three entries, one per state, and the `0` is a measurement rather than an absence.
    expect(asc(['record', SPEC.name, '--prop', 'count=0', '--json'], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--na', 'count', '--json'], dir).status).toBe(0);
    expect(
      asc(['record', SPEC.name, '-', '--json'], dir, JSON.stringify({ properties: {} })).status,
    ).toBe(0);

    const run = asc(['explore', SPEC.name, '--json'], dir);

    expect(run.status).toBe(0);
    const count = property(rows(run.stdout), 'count');
    expect(count.states).toStrictEqual({
      measured: 1,
      not_applicable: 1,
      not_measured: 1,
      not_declared: 0,
    });
    // The measured zero is a value, so it is the range.
    expect(count.min).toBe(0);
    expect(count.max).toBe(0);
    // Every state is named in the rendered tally, including the empty ones -- the JSON counts are
    // exact and the line must not invite a reader to believe a state went unused.
    expect(count.tally).toContain('measured 1 (33.3%)');
    expect(count.tally).toContain('not_applicable 1 (33.3%)');
    expect(count.tally).toContain('not_measured 1 (33.3%)');
    expect(count.tally).toContain('not_declared 0 (0.0%)');
    expect(count.declared_entries).toBe(3);
  });

  /**
   * The ratios are over the entries that DECLARED the property, so `declared_entries` is what the
   * percentages divide by -- reported next to the type's `count` rather than conflated with it.
   */
  it('reports the declared denominator beside the type total', () => {
    const dir = emptyProject();
    // Version 2 adds a property, so the version-1 entry never had a decision available for it.
    const v2 = {
      ...SPEC,
      properties: [...SPEC.properties, { name: 'added_later', type: 'string' }],
    };
    writeFileSync(join(dir, 'spec2.json'), JSON.stringify(v2));
    expect(asc(['record', SPEC.name, '--prop', 'outcome=ok', '--json'], dir).status).toBe(0);
    expect(asc(['types', 'define', join(dir, 'spec2.json')], dir).status).toBe(0);
    expect(asc(['record', SPEC.name, '--prop', 'outcome=bad', '--json'], dir).status).toBe(0);

    const run = asc(['explore', SPEC.name, '--json'], dir);

    expect(run.status).toBe(0);
    const list = rows(run.stdout);
    expect(find(list, 'count')?.value).toBe(2);
    // Both registered versions are on the map, oldest first, and nothing else is.
    expect(fields(list, 'version.')).toStrictEqual(['version.1', 'version.2']);

    const added = property(list, 'added_later');
    // One entry declared it, and that entry has no decision for it: 0 of 1, not 0 of 2.
    expect(added.declared_entries).toBe(1);
    expect(added.states?.measured).toBe(0);
    expect(added.states?.not_measured).toBe(1);
    // The version-1 entry never declared it -- a fact about the definition, not the recording.
    expect(added.states?.not_declared).toBe(1);

    // The property both versions declare is declared by both entries.
    expect(property(list, 'outcome').declared_entries).toBe(2);
  });

  it('summarises each property by its declared type', () => {
    const dir = emptyProject();
    expect(
      asc(
        [
          'record',
          SPEC.name,
          '--prop',
          'outcome=ok',
          '--prop',
          'count=7',
          '--prop',
          'note=prose',
          '--prop',
          'at=2026-09-11T10:00:00.000Z',
          '--json',
        ],
        dir,
      ).status,
    ).toBe(0);

    const list = rows(asc(['explore', SPEC.name, '--json'], dir).stdout);

    const outcome = property(list, 'outcome');
    expect(outcome.summary).toBe('top');
    expect(outcome.top).toStrictEqual([{ value: 'ok', count: 1 }]);

    const count = property(list, 'count');
    expect(count.summary).toBe('range');
    expect(count.min).toBe(7);
    expect(count.max).toBe(7);

    const at = property(list, 'at');
    expect(at.summary).toBe('range');
    expect(at.min).toBe('2026-09-11T10:00:00.000Z');

    // Prose is counted and NOT returned: a profile of a corpus full of prose must not put any of
    // it into a caller's context, and `values` says so rather than leaving a blank cell.
    const note = property(list, 'note');
    expect(note.summary).toBe('cardinality');
    expect(note.distinct).toBe(1);
    expect(note.top).toBeUndefined();
    expect(note.min).toBeUndefined();
    expect(note.values).toBe('not summarised');
  });

  /** Absent, never fabricated. Nothing exists to have an envelope range, so none is reported. */
  it('omits the recorded_at range entirely for a type with no entries', () => {
    const dir = emptyProject();
    const run = asc(['explore', SPEC.name, '--json'], dir);

    expect(run.status).toBe(0);
    const list = rows(run.stdout);
    expect(find(list, 'count')?.value).toBe(0);
    expect(find(list, 'recorded_at_min')).toBeUndefined();
    expect(find(list, 'recorded_at_max')).toBeUndefined();
    // Every property is still reported, at zero -- a registered type with no entries is a real
    // profile, and the difference between it and an unregistered name is the whole point.
    expect(fields(list, 'property.')).toStrictEqual([
      'property.at',
      'property.count',
      'property.note',
      'property.outcome',
    ]);
    expect(property(list, 'outcome').values).toBe('no value measured');
    // Nor is a version row invented for a version that has recorded nothing.
    expect(fields(list, 'version.')).toStrictEqual(['version.1']);
  });
});

describe('asc explore: a name nobody registered', () => {
  it('is a refusal that lists the names that do exist, not an empty profile', () => {
    const dir = emptyProject();
    const run = asc(['explore', 'no_such_type'], dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const message = flatten(run.stderr);
    expect(message).toContain("There is no entry type named 'no_such_type'");
    // The fix is in the message: the names that DO exist, so the caller's next command is a
    // correction rather than another guess.
    expect(message).toContain(SPEC.name);
  });

  /**
   * The same refusal in paging mode, and it is a separate test rather than a shared one because
   * paging answers the existence question with a DIFFERENT call -- `findType`, because asking the
   * profiler to answer a boolean costs 7.4 ms on the real corpus to throw the map away. Two checks
   * for one rule is exactly where the rule stops being one, so both are held to it.
   */
  it('refuses an unregistered name in paging mode too, and not with an empty page', () => {
    const dir = emptyProject();
    const run = asc(['explore', 'no_such_type', '--page'], dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    const message = flatten(run.stderr);
    expect(message).toContain("There is no entry type named 'no_such_type'");
    expect(message).toContain(SPEC.name);
  });
});

describe('asc explore --page: one page of entries', () => {
  /** The `--json` envelope, with the two fields these tests are about. */
  function envelope(stdout: string): {
    readonly rows: readonly Record<string, unknown>[];
    readonly coverage: { shown: number; total: number; has_more: boolean; percent?: number };
    readonly next_cursor?: string;
  } {
    return JSON.parse(stdout) as ReturnType<typeof envelope>;
  }

  /** Records `count` entries and returns their ids, in the order the store recorded them. */
  function record(dir: string, count: number): readonly string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const run = asc(['record', SPEC.name, '--prop', `count=${String(i)}`, '--json'], dir);
      expect(run.status).toBe(0);
      const recorded = JSON.parse(run.stdout) as { rows: { id: string }[] };
      ids.push((recorded.rows[0] as { id: string }).id);
    }
    return ids;
  }

  it('lists entries rather than the map, when asked', () => {
    const dir = emptyProject();
    record(dir, 3);

    const run = asc(['explore', SPEC.name, '--page', '--json'], dir);

    expect(run.status).toBe(0);
    const rows = envelope(run.stdout).rows;
    expect(rows).toHaveLength(3);
    // An entry row, not a profile row: the envelope shape is the whole difference between the two
    // modes, so it is asserted rather than inferred from the count.
    for (const row of rows) {
      expect(Object.keys(row)).toStrictEqual(['id', 'recorded_at', 'type_version', 'properties']);
    }
  });

  /**
   * A page is a SUBSET, so it owes the reader a denominator. This is the bead's core requirement.
   *
   * The fixture is three entries and a page of two ON PURPOSE. 2/3 is 66.666..., so this assertion
   * is the only one in the file that can tell a percent rounded to one decimal from the raw float --
   * and that was found the hard way rather than reasoned about: a first version of this test used
   * five entries and a page of two, where 2/5 = 0.4 reads the same rounded or not, and the mutation
   * that drops `Math.round` from `percentOf` survived against it.
   */
  it('reports its share of the whole scope, and the cursor that resumes it', () => {
    const dir = emptyProject();
    record(dir, 3);

    const first = envelope(
      asc(['explore', SPEC.name, '--page', '--limit', '2', '--json'], dir).stdout,
    );

    expect(first.coverage).toStrictEqual({
      shown: 2,
      total: 3,
      has_more: true,
      percent: 66.7,
    });
    expect(first.next_cursor).toMatch(/^asc1:/);
  });

  it('omits next_cursor entirely on the last page, instead of reporting null', () => {
    const dir = emptyProject();
    record(dir, 3);

    const last = envelope(
      asc(['explore', SPEC.name, '--page', '--limit', '10', '--json'], dir).stdout,
    );

    expect(last.coverage).toStrictEqual({ shown: 3, total: 3, has_more: false, percent: 100 });
    // Absent, not `null`. A key that is always present is a key a consumer can read without a
    // branch, and `null` would make "no next page" and "does not page" two spellings of one thing.
    expect('next_cursor' in last).toBe(false);
  });

  /**
   * The guarantee, driven through the real binary rather than through the store: following the
   * cursor reaches every entry exactly once. `packages/store/test/pages.test.ts` holds the same
   * property at the store layer; this is the one that proves the CLI hands the cursor back intact,
   * because a cursor that survives a store round trip can still be mangled by a table rendering or
   * a shell's quoting.
   */
  it('walks the whole type through the printed cursors, covering every entry once', () => {
    const dir = emptyProject();
    const recorded = record(dir, 5);

    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const args = ['explore', SPEC.name, '--limit', '2', '--json'];
      const run = asc(cursor === undefined ? args : [...args, '--cursor', cursor], dir);
      expect(run.status).toBe(0);
      const body = envelope(run.stdout);
      sizes.push(body.rows.length);
      seen.push(...body.rows.map((row) => String(row['id'])));
      if (body.next_cursor === undefined) break;
      cursor = body.next_cursor;
    }

    expect(sizes).toStrictEqual([2, 2, 1]);
    expect(seen).toHaveLength(5);
    // Exactly once each, and every recorded entry reached -- the two ways a walk can be wrong.
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toStrictEqual([...recorded].sort());
  });

  it('takes --limit or --cursor alone as the request to page', () => {
    const dir = emptyProject();
    record(dir, 3);

    const byLimit = asc(['explore', SPEC.name, '--limit', '1', '--json'], dir);
    expect(byLimit.status).toBe(0);
    expect(envelope(byLimit.stdout).rows[0]).toHaveProperty('recorded_at');

    const first = envelope(asc(['explore', SPEC.name, '--limit', '1', '--json'], dir).stdout);
    const byCursor = asc(
      ['explore', SPEC.name, '--cursor', String(first.next_cursor), '--json'],
      dir,
    );
    expect(byCursor.status).toBe(0);
    expect(envelope(byCursor.stdout).rows[0]).toHaveProperty('recorded_at');
  });

  /** Nothing to page is an answer, not a failure -- and it must not claim there is more. */
  it('reports an empty type as showing 0 of 0, with no percentage to invent', () => {
    const dir = emptyProject();

    const run = asc(['explore', SPEC.name, '--page', '--json'], dir);

    expect(run.status).toBe(0);
    const body = envelope(run.stdout);
    expect(body.rows).toStrictEqual([]);
    // No `percent` key at all: there is no fraction of nothing, and `0` would be an invention.
    expect(body.coverage).toStrictEqual({ shown: 0, total: 0, has_more: false });
    expect('percent' in body.coverage).toBe(false);
    expect('next_cursor' in body).toBe(false);
  });

  /**
   * A cursor is an operand the caller supplies, so a bad one is a usage error -- exit 2, not the
   * exit 1 that means "the command was understood and the answer is no". The classes are mapped in
   * one place (`errors.ts`), and this is the test that the mapping is reached from a command.
   */
  it('refuses a cursor from a different type as a usage error', () => {
    const dir = emptyProject();
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...SPEC, name: 'other_type' }));
    expect(asc(['types', 'define', join(dir, 'other.json')], dir).status).toBe(0);
    record(dir, 3);

    const issued = envelope(
      asc(['explore', SPEC.name, '--page', '--limit', '1', '--json'], dir).stdout,
    ).next_cursor as string;

    const run = asc(['explore', 'other_type', '--cursor', issued], dir);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The message names both scopes, which is what lets a caller notice it mixed two queries up.
    expect(flatten(run.stderr)).toContain('cursor was issued for a different query');
  });

  it.each([
    ['a cursor that is not a cursor', 'nonsense', "does not begin with 'asc1:'"],
    ['a page size below one', ['--limit', '0'], 'page size must be at least 1'],
  ])('refuses %s as a usage error', (_label, bad, expected) => {
    const dir = emptyProject();
    record(dir, 2);
    const args = ['explore', SPEC.name, ...(Array.isArray(bad) ? bad : ['--cursor', bad])];

    const run = asc(args, dir);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(flatten(run.stderr)).toContain(expected);
  });

  /**
   * The page's columns, asserted through CSV because CSV has no padding.
   *
   * `columns` is the projection for the table and the CSV and does NOT filter `--json`, so a
   * mutation that drops a column from it is invisible to every JSON assertion in this file -- one
   * did exactly that and survived. The CSV header is `columns` joined by commas with nothing
   * between, so it pins the list exactly rather than by substring.
   */
  it('projects the page through its column list, and writes no footer into CSV', () => {
    const dir = emptyProject();
    record(dir, 3);

    const csv = asc(['explore', SPEC.name, '--limit', '2', '--csv'], dir);

    expect(csv.status).toBe(0);
    const lines = csv.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('id,recorded_at,type_version,properties,evidence_text');
    // One header plus one line per row, and NOTHING else. A coverage line after the last CSV record
    // is a row with the wrong field count, which is why the footer is a table-only rule -- so this
    // is the assertion that keeps a well-meaning "every output reports coverage" from breaking CSV.
    expect(lines).toHaveLength(3);
    expect(csv.stdout).not.toContain('showing');
    // The id in the CSV is whole, not elided: the table is the lossy view and CSV is not. Asserted
    // on the FIELD rather than the line, so a quoted id would still be read as one field.
    const id = lines[1]?.split(',')[0] as string;
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toContain('…');
  });

  /**
   * The table's page footer, which is the only place a person meets the coverage rule.
   *
   * It is asserted together with the envelope's own `next_cursor`, because the two must be ONE
   * value: a footer that printed a cursor the JSON did not have would be a second rendering of the
   * same fact, free to disagree with the first.
   */
  it('prints the coverage line and the cursor on stdout, and neither on a complete page', () => {
    const dir = emptyProject();
    record(dir, 3);

    const first = asc(['explore', SPEC.name, '--limit', '2', '--json'], dir);
    const issued = envelope(first.stdout).next_cursor as string;

    const table = asc(['explore', SPEC.name, '--limit', '2'], dir);
    expect(table.status).toBe(0);
    expect(table.stdout).toContain('showing 2 of 3, 66.7%');
    // On stdout, verbatim, on a line of its own -- it is the operand of the next command, and
    // wrapping or eliding it would make it unusable. Asserted as an exact line so a change to the
    // shared cell-elision rule cannot quietly cut it.
    expect(table.stdout.split('\n')).toContain(issued);

    const whole = asc(['explore', SPEC.name, '--limit', '10'], dir);
    expect(whole.status).toBe(0);
    // Complete: "showing 3 of 3, 100%" is noise, so the footer is absent -- and so is the cursor,
    // because there is nothing to resume.
    expect(whole.stdout).not.toContain('showing');
    expect(whole.stdout).not.toContain('asc1:');
  });

  /**
   * The other half of "EVERY output reports coverage": the map, which withholds nothing, still
   * carries the field. A consumer that can always read it cannot mis-handle its absence.
   */
  it('reports complete coverage on the map, which is not a page', () => {
    const dir = emptyProject();
    record(dir, 4);

    const body = envelope(asc(['explore', SPEC.name, '--json'], dir).stdout);

    // The map is not a page, so its coverage is over its OWN rows -- the profile's, not the four
    // entries that went in. Asserted as an identity rather than a literal count so the test states
    // the rule (coverage describes the rows emitted) instead of today's row count.
    expect(body.coverage).toStrictEqual({
      shown: body.rows.length,
      total: body.rows.length,
      has_more: false,
      percent: 100,
    });
    expect(body.rows.length).toBeGreaterThan(4);
    expect('next_cursor' in body).toBe(false);
  });
});

describe('asc explore: the surfaces every command owes', () => {
  it('supports --help without a store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-explore-help-'));
    dirs.push(dir);
    const run = asc(['explore', '--help'], dir);

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Profile an entry type');
    // A runnable example, which `cli-best-practices` rule 4 asks every command to carry.
    expect(run.stdout).toContain('asc explore verification_run');
  });

  it('refuses two output formats at once', () => {
    const dir = emptyProject();
    const run = asc(['explore', SPEC.name, '--json', '--table'], dir);

    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('cannot be combined');
  });

  it('prints JSON on stdout with nothing else in it', () => {
    const dir = emptyProject();
    const run = asc(['explore', SPEC.name, '--json'], dir);

    expect(run.status).toBe(0);
    const envelope = JSON.parse(run.stdout) as {
      ascend_output: number;
      rows: readonly unknown[];
      row_count: number;
    };
    expect(envelope.ascend_output).toBe(1);
    expect(envelope.row_count).toBe(envelope.rows.length);
  });

  /**
   * The `ignoreStdin` guard `asc types show` carries.
   *
   * The name on stdin is a name that EXISTS, which is what makes this test discriminating: with
   * the guard, a missing required argument is a usage error (exit 2); without it, oclif reads
   * `attempt` off stdin and the command succeeds -- so this would go green on a run that silently
   * profiled whichever type happened to be piped in. A nonsense name on stdin would fail either
   * way and prove nothing.
   */
  it('profiles the type whose name is typed, never one taken from stdin', () => {
    const dir = emptyProject();
    const run = asc(['explore'], dir, SPEC.name);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    // The fix is in the message: the argument is missing, and that is what exit 2 is reporting.
    expect(flatten(run.stderr)).toContain('Missing 1 required arg: type');
  });
});
