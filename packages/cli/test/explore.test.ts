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
