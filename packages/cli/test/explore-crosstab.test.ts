import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `asc explore --select`, `--filter` and `--group-by` -- driven as the real binary against a real
 * store (`asc-56k`).
 *
 * A subprocess, for the same reason `explore.test.ts` gives: what can be wrong is the flag parser,
 * the mode-conflict refusals, and the exit code, and a direct call exercises none of them.
 * `packages/store/test/crosstab.test.ts` and `packages/store/test/pages.test.ts` already cover
 * `groupEntries` and a filtered page's mechanism; this file covers the command surface a caller
 * actually reaches -- the three flags, their refusals, and the rendering rules `explore-select.ts`
 * and `explore-group.ts` implement.
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

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A `--select`-flattened page row: the three envelope columns, plus one per selected property. */
type SelectRow = Record<string, unknown>;

/** A `--group-by` row: a header row (`field`/`value`) or a cell row (the key columns and `count`). */
type GroupRow = Record<string, unknown>;

const SPEC = {
  name: 'crosstab_probe',
  properties: [
    { name: 'stage', type: 'enum', enum_values: ['draft', 'review', 'done'] },
    { name: 'flag', type: 'boolean' },
    { name: 'score', type: 'integer' },
    { name: 'notes', type: 'text' },
  ],
};

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-explore-crosstab-'));
  dirs.push(dir);
  expect(asc(['init'], dir).status).toBe(0);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
  expect(asc(['types', 'define', join(dir, 'spec.json')], dir).status).toBe(0);
  return dir;
}

function record(dir: string, stage: string, flag: boolean, score: number): void {
  expect(
    asc(
      [
        'record',
        SPEC.name,
        '--prop',
        `stage=${stage}`,
        '--prop',
        `flag=${String(flag)}`,
        '--prop',
        `score=${String(score)}`,
        '--json',
      ],
      dir,
    ).status,
  ).toBe(0);
}

describe('asc explore --select', () => {
  it('flattens named properties into top-level columns, keeping id and preserving order', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'done', false, 2);

    const run = asc(['explore', SPEC.name, '--select', 'stage,flag', '--json'], dir);
    expect(run.status).toBe(0);
    // `--json` never carries `columns` (`output.ts`'s `renderJson` -- `columns` is a `--table`/
    // `--csv` projection of the rows, not a definition of them); order is pinned by the CSV test
    // below instead, and this checks the rows themselves are flattened, not the column list.
    const parsed = JSON.parse(run.stdout) as { rows: SelectRow[] };

    expect(parsed.rows).toHaveLength(2);
    for (const row of parsed.rows) {
      expect(typeof row['id']).toBe('string');
      expect(typeof row['recorded_at']).toBe('string');
      expect(row['type_version']).toBe(1);
      expect(['draft', 'done']).toContain(row['stage']);
      expect(Object.keys(row)).toStrictEqual([
        'id',
        'recorded_at',
        'type_version',
        'stage',
        'flag',
      ]);
    }
  });

  it('renders a selected boolean as true/false, not 0/1 (matching --group-by and the default map)', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', false, 2);

    const run = asc(['explore', SPEC.name, '--select', 'flag', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: SelectRow[] };
    const flags = parsed.rows.map((row) => row['flag']);
    expect(flags.sort()).toStrictEqual(['false', 'true']);
  });

  /**
   * A property added in v2 has no key at all in a v1 entry's own recorded state -- `not_declared`,
   * not a blank cell and not `not_measured`. Built the same way `asc-5x7`'s own fixture is: record
   * under v1, redefine to add a property, record again under v2.
   */
  it('renders not_measured, not_applicable and not_declared, never a blank cell', () => {
    const dir = project();
    expect(
      asc(['record', SPEC.name, '--prop', 'stage=draft', '--na', 'flag', '--json'], dir).status,
    ).toBe(0);

    const v2 = {
      ...SPEC,
      properties: [...SPEC.properties, { name: 'extra', type: 'string' }],
    };
    writeFileSync(join(dir, 'spec2.json'), JSON.stringify(v2));
    expect(asc(['types', 'define', join(dir, 'spec2.json')], dir).status).toBe(0);
    expect(
      asc(['record', SPEC.name, '--prop', 'stage=done', '--prop', 'extra=x', '--json'], dir).status,
    ).toBe(0);
    // A third entry, still under v2, that never measured `extra`.
    expect(asc(['record', SPEC.name, '--prop', 'stage=review', '--json'], dir).status).toBe(0);

    const run = asc(['explore', SPEC.name, '--select', 'flag,extra', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: SelectRow[] };

    // `--select` does not name `stage` here, so the three records are read back in the page's own
    // order -- insertion order, ascending by `recorded_at` -- which is exactly the order they were
    // written in above.
    const sorted = parsed.rows;
    expect(sorted).toHaveLength(3);
    expect(sorted[0]?.['flag']).toBe('not_applicable');
    // v1 never declared `extra` -- not_declared, not a blank cell.
    expect(sorted[0]?.['extra']).toBe('not_declared');
    expect(sorted[1]?.['extra']).toBe('x');
    expect(sorted[2]?.['flag']).toBe('not_measured');
    expect(sorted[2]?.['extra']).toBe('not_measured');
  });

  it('refuses a name the type does not declare, listing the declared ones', () => {
    const dir = project();
    record(dir, 'draft', true, 1);

    const run = asc(['explore', SPEC.name, '--select', 'nonexistent', '--json'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("declares no property named 'nonexistent'");
    expect(flatten(run.stderr)).toContain('stage');
    expect(flatten(run.stderr)).toContain('flag');
  });

  it('implies --page: no --page flag is required', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const run = asc(['explore', SPEC.name, '--select', 'stage', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: SelectRow[]; coverage?: unknown };
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.coverage).toBeDefined();
  });

  it('produces a real CSV, not a JSON blob in a cell', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'review', false, 2);

    const run = asc(['explore', SPEC.name, '--select', 'stage,flag', '--csv'], dir);
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]).toBe('id,recorded_at,type_version,stage,flag');
    expect(lines).toHaveLength(3);
    expect(lines[1]).not.toContain('{');
  });

  it('refuses --select combined with --sample', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const run = asc(['explore', SPEC.name, '--select', 'stage', '--sample', 'random'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--sample cannot be combined with');
    expect(flatten(run.stderr)).toContain('--select');
  });

  it('refuses --select combined with --group-by', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const run = asc(['explore', SPEC.name, '--select', 'stage', '--group-by', 'flag'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--select cannot be combined with --group-by');
  });
});

describe('asc explore --filter', () => {
  it('narrows a page to matching rows', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'done', true, 2);
    record(dir, 'done', false, 3);

    const run = asc(['explore', SPEC.name, '--page', '--filter', "stage = 'done'", '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      rows: { properties: { stage: string } }[];
    };
    expect(parsed.rows).toHaveLength(2);
    for (const row of parsed.rows) expect(row.properties.stage).toBe('done');
  });

  /**
   * `--filter` runs over `typeFilterScope`'s bare-column projection (`stage`, not
   * `json_extract(properties_json,'$.stage')`) -- an envelope column is one of those bare columns
   * too, unaffected by which of the two scopes (this one, or `annotate --scope`'s raw-table one)
   * is running. Pinned separately from the declared-property case above because nothing else in
   * this file exercises an envelope column through `--filter`.
   */
  it('narrows a page by a bare envelope column', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'done', true, 2);

    const run = asc(
      ['explore', SPEC.name, '--page', '--filter', `type_name = '${SPEC.name}'`, '--json'],
      dir,
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(2);
  });

  /**
   * The measured trap this command's own docstring quotes numbers for: a boolean is stored, and
   * compared, as the integer the projection carries it as. `flag = 'false'` compares a string to
   * that integer and matches nothing -- silently, exit 0, zero rows -- which is exactly what this
   * test pins so a future change cannot quietly start throwing (or matching) instead.
   */
  it('compares a boolean as the stored integer -- a quoted boolean string matches nothing', () => {
    const dir = project();
    record(dir, 'draft', false, 1);
    record(dir, 'draft', true, 2);

    const quoted = asc(
      ['explore', SPEC.name, '--page', '--filter', "flag = 'false'", '--json'],
      dir,
    );
    expect(quoted.status).toBe(0);
    expect((JSON.parse(quoted.stdout) as { rows: unknown[] }).rows).toHaveLength(0);

    const bare = asc(['explore', SPEC.name, '--page', '--filter', 'flag = false', '--json'], dir);
    expect(bare.status).toBe(0);
    expect((JSON.parse(bare.stdout) as { rows: unknown[] }).rows).toHaveLength(1);
  });

  /**
   * `asc-qfk.1`: the refusal this test used to pin is gone -- `--filter` now applies to the
   * default map, and every number on it (not only the state denominators `asc-5x7` named) is
   * recomputed against the filtered population. `packages/store/test/profile.test.ts` pins the
   * denominator arithmetic directly (the asc-5x7 shape, filtered); this is the command-surface
   * check that the flag reaches the map at all and that the `filter` fact -- the same
   * `matched N of M entries` line `--page`, `--sample` and `--group-by` already print -- lands on
   * it.
   */
  it('applies to the default map, narrowing count and reporting the filter fact (asc-qfk.1)', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', true, 2);
    record(dir, 'done', true, 3);

    const run = asc(['explore', SPEC.name, '--filter', "stage = 'draft'", '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      filter?: { matched: number; unfiltered: number };
      rows: { field: string; value?: unknown; values?: unknown }[];
    };

    expect(parsed.filter).toStrictEqual({ matched: 2, unfiltered: 3 });
    const countRow = parsed.rows.find((row) => row.field === 'count');
    // `count` is the FILTERED population, not the type's whole recorded history.
    expect(countRow?.value).toBe(2);

    const stageRow = parsed.rows.find((row) => row.field === 'property.stage');
    // `values` (the top-K rendering) sees only 'draft': the one 'done' entry was excluded before
    // any property was summarised, not just before the state tally.
    expect(stageRow?.values).toBe('draft 2');
  });

  /**
   * The asc-5x7 shape, driven through the CLI: a property declared only in v2, entries recorded
   * under both v1 and v2, and a filter admitting some of each -- so `declared_entries` (a share of
   * the FILTERED declaring population) and `count` (the FILTERED total) genuinely differ on this
   * one map. `profile.test.ts` asserts the same shape directly against `profileType`; this checks
   * the numbers survive rendering onto the command's own rows.
   */
  it('recomputes a property’s declared_entries against the filtered population on the default map', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', true, 2);
    record(dir, 'done', true, 3);

    const v2 = { ...SPEC, properties: [...SPEC.properties, { name: 'extra', type: 'string' }] };
    writeFileSync(join(dir, 'spec2.json'), JSON.stringify(v2));
    expect(asc(['types', 'define', join(dir, 'spec2.json')], dir).status).toBe(0);
    // v2, 'draft', declares and measures `extra` -- admitted by the filter below.
    expect(
      asc(['record', SPEC.name, '--prop', 'stage=draft', '--prop', 'extra=x', '--json'], dir)
        .status,
    ).toBe(0);
    // v2, 'done' -- excluded by the filter, so it must not count toward anything on the map.
    expect(asc(['record', SPEC.name, '--prop', 'stage=done', '--json'], dir).status).toBe(0);

    const run = asc(['explore', SPEC.name, '--filter', "stage = 'draft'", '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      filter?: { matched: number; unfiltered: number };
      rows: {
        field: string;
        value?: unknown;
        declared_entries?: number;
        count?: number;
      }[];
    };

    // 3 of the 5 recorded entries are 'draft': the two v1 ones plus the one v2 one.
    expect(parsed.filter).toStrictEqual({ matched: 3, unfiltered: 5 });

    const filteredCount = parsed.rows.find((row) => row.field === 'count')?.value;
    expect(filteredCount).toBe(3);

    const extraRow = parsed.rows.find((row) => row.field === 'property.extra');
    // Filtered declared_entries is 1 (the one admitted v2 row) -- not 2 (the unfiltered declaring
    // count: both v2 rows) and not 3 (the filtered total). The two denominators this fixture is
    // built to keep apart, 1 and 3, are unequal.
    expect(extraRow?.declared_entries).toBe(1);
    expect(extraRow?.declared_entries).not.toBe(filteredCount);

    const notDeclaredRow = parsed.rows.find((row) => row.field === 'property.extra.not_declared');
    // The two admitted v1 rows never declared `extra`: not_declared is 2 of the filtered 3, not 2
    // of the filtered declared_entries (1) -- which would be over 100%.
    expect(notDeclaredRow?.count).toBe(2);
  });

  it('is refused combined with --dump', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const target = join(dir, 'dump-out');
    const run = asc(['explore', SPEC.name, '--dump', target, '--filter', "stage = 'draft'"], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--dump cannot be combined with --filter');
  });

  it('narrows a sample to the filtered population, and reports coverage against it', () => {
    const dir = project();
    for (let i = 0; i < 6; i += 1) record(dir, i < 3 ? 'draft' : 'done', true, i);

    const run = asc(
      [
        'explore',
        SPEC.name,
        '--sample',
        'random',
        '--limit',
        '3',
        '--filter',
        "stage = 'draft'",
        '--json',
      ],
      dir,
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      rows: { properties: { stage: string } }[];
      coverage: { shown: number; total: number };
    };
    expect(parsed.rows).toHaveLength(3);
    for (const row of parsed.rows) expect(row.properties.stage).toBe('draft');
    // Three drafts exist in total, and the sample drew all three of them.
    expect(parsed.coverage.total).toBe(3);
  });

  it('narrows a --group-by', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', false, 2);
    record(dir, 'done', true, 3);

    const run = asc(
      ['explore', SPEC.name, '--group-by', 'stage', '--filter', 'flag = true', '--json'],
      dir,
    );
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };
    const count = parsed.rows.find((row) => row['field'] === 'count');
    expect(count?.['value']).toBe(2);
  });

  /**
   * The trap found by probing shipped behaviour rather than a test: a filter that matches nothing
   * renders identically to a type that holds nothing -- `count: 0` either way -- and the two need
   * opposite fixes (a typo in the predicate, versus an empty corpus). `filter.unfiltered` is the
   * fact that tells them apart, on `--page` and `--group-by` alike.
   */
  describe('names both populations, the trap a matched-nothing filter would otherwise hide', () => {
    it('--page: a filter matching nothing still reports the real unfiltered population', () => {
      const dir = project();
      record(dir, 'draft', true, 1);
      record(dir, 'done', true, 2);
      record(dir, 'done', false, 3);

      const run = asc(
        ['explore', SPEC.name, '--page', '--filter', "stage = 'review'", '--json'],
        dir,
      );
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as {
        rows: unknown[];
        filter?: { matched: number; unfiltered: number };
      };
      expect(parsed.rows).toHaveLength(0);
      expect(parsed.filter).toStrictEqual({ matched: 0, unfiltered: 3 });
    });

    it('--page: a filter matching some rows reports both populations', () => {
      const dir = project();
      record(dir, 'draft', true, 1);
      record(dir, 'done', true, 2);
      record(dir, 'done', false, 3);

      const run = asc(
        ['explore', SPEC.name, '--page', '--filter', "stage = 'done'", '--json'],
        dir,
      );
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { filter?: { matched: number; unfiltered: number } };
      expect(parsed.filter).toStrictEqual({ matched: 2, unfiltered: 3 });
    });

    it('--page: a filter matching everything still reports the fact, not just its absence', () => {
      const dir = project();
      record(dir, 'draft', true, 1);
      record(dir, 'done', true, 2);

      const run = asc(
        ['explore', SPEC.name, '--page', '--filter', `type_name = '${SPEC.name}'`, '--json'],
        dir,
      );
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { filter?: { matched: number; unfiltered: number } };
      expect(parsed.filter).toStrictEqual({ matched: 2, unfiltered: 2 });
    });

    it('--page: an unfiltered run reports no filter fact at all', () => {
      const dir = project();
      record(dir, 'draft', true, 1);

      const run = asc(['explore', SPEC.name, '--page', '--json'], dir);
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { filter?: unknown };
      expect(parsed.filter).toBeUndefined();
    });

    it('--group-by: names both populations as a header row when the filter matches nothing', () => {
      const dir = project();
      record(dir, 'draft', true, 1);
      record(dir, 'draft', false, 2);
      record(dir, 'done', true, 3);
      record(dir, 'done', true, 4);

      const run = asc(
        ['explore', SPEC.name, '--group-by', 'flag', '--filter', "flag = 'false'", '--json'],
        dir,
      );
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };
      const count = parsed.rows.find((row) => row['field'] === 'count');
      expect(count?.['value']).toBe(0);
      const filterRow = parsed.rows.find((row) => row['field'] === 'filter');
      expect(filterRow?.['value']).toBe('matched 0 of 4 entries');
    });

    it('--group-by: an unfiltered run has no filter header row', () => {
      const dir = project();
      record(dir, 'draft', true, 1);

      const run = asc(['explore', SPEC.name, '--group-by', 'stage', '--json'], dir);
      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };
      expect(parsed.rows.find((row) => row['field'] === 'filter')).toBeUndefined();
    });
  });
});

describe('asc explore --group-by', () => {
  it('one key: counts plus a qualified proportion of total', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', true, 2);
    record(dir, 'done', false, 3);

    const run = asc(['explore', SPEC.name, '--group-by', 'stage', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };

    const csv = asc(['explore', SPEC.name, '--group-by', 'stage', '--csv'], dir);
    expect(csv.status).toBe(0);
    expect(csv.stdout.trim().split('\n')[0]).toBe('field,value,stage,count');

    const draft = parsed.rows.find((row) => row['stage'] === 'draft');
    expect(draft?.['count']).toBe(2);
    expect(draft?.['denominator']).toBe('total');
    expect(draft?.['proportion']).toMatchObject({ successes: 2, n: 3 });

    const countRow = parsed.rows.find((row) => row['field'] === 'count');
    expect(countRow?.['value']).toBe(3);
    const axisRow = parsed.rows.find((row) => row['field'] === 'axis.stage.distinct');
    expect(axisRow?.['value']).toBe(2);
  });

  it('two keys: counts only, with a stated denominator disclaimer', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'draft', false, 2);
    record(dir, 'done', true, 3);

    const run = asc(['explore', SPEC.name, '--group-by', 'stage,flag', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };

    const csv = asc(['explore', SPEC.name, '--group-by', 'stage,flag', '--csv'], dir);
    expect(csv.status).toBe(0);
    expect(csv.stdout.trim().split('\n')[0]).toBe('field,value,stage,flag,count');

    for (const row of parsed.rows) {
      if (row['field'] === undefined) {
        // A cell row: no proportion, no per-cell denominator.
        expect(row['proportion']).toBeUndefined();
        expect(row['denominator']).toBeUndefined();
      }
    }
    const disclaimer = parsed.rows.find((row) => row['field'] === 'denominator');
    expect(disclaimer).toBeDefined();
    expect(String(disclaimer?.['value'])).toContain('counts only');
  });

  it('refuses a property that is not a "top" summary, naming its type and summary', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const run = asc(['explore', SPEC.name, '--group-by', 'score', '--json'], dir);
    expect(run.status).toBe(1);
    expect(flatten(run.stderr)).toContain("'score' of 'crosstab_probe' is declared 'integer'");
    expect(flatten(run.stderr)).toContain("'range'");
  });

  it('refuses more than two keys', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    const run = asc(['explore', SPEC.name, '--group-by', 'stage,flag,score'], dir);
    expect(run.status).toBe(2);
    expect(flatten(run.stderr)).toContain('--group-by takes one or two properties');
  });

  it('marks a small result as an anecdote (MIN_N)', () => {
    const dir = project();
    record(dir, 'draft', true, 1);
    record(dir, 'done', false, 2);

    const run = asc(['explore', SPEC.name, '--group-by', 'stage', '--json'], dir);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { rows: GroupRow[] };
    const anecdote = parsed.rows.find((row) => row['field'] === 'small_group');
    expect(anecdote).toBeDefined();
    expect(String(anecdote?.['value'])).toContain('SMALL GROUP');
  });

  it('is refused combined with --page, --cursor, --sample and --dump', () => {
    const dir = project();
    record(dir, 'draft', true, 1);

    const withPage = asc(['explore', SPEC.name, '--group-by', 'stage', '--page'], dir);
    expect(withPage.status).toBe(2);
    expect(flatten(withPage.stderr)).toContain('--group-by cannot be combined with');

    const withSample = asc(
      ['explore', SPEC.name, '--group-by', 'stage', '--sample', 'random'],
      dir,
    );
    expect(withSample.status).toBe(2);
    expect(flatten(withSample.stderr)).toContain('--group-by cannot be combined with');

    const target = join(dir, 'dump-out');
    const withDump = asc(['explore', SPEC.name, '--group-by', 'stage', '--dump', target], dir);
    expect(withDump.status).toBe(2);
    expect(flatten(withDump.stderr)).toContain('--dump cannot be combined with');
  });
});
