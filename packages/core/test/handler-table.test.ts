import { describe, expect, it } from 'vitest';
import {
  HandlerError,
  compileHandler,
  runHandler,
  type HandlerRow,
  type NormalizedEvent,
} from '../src/index.js';

/**
 * Typed handlers (asc-tuur.3): a handler that declares the entry `type:` its rows become, a
 * `table` fan-out over a markdown table held in a string field, and `maps:` that normalise a
 * cell onto a closed vocabulary. Hand-built events; the report text is synthetic.
 */

const changed = (after: string, id = 'toolu_1'): NormalizedEvent => ({
  kind: 'file.changed',
  session_id: 's1',
  agent_id: 'main',
  seq: 3,
  call: 2,
  derive_version: 5,
  id,
  tool: 'Write',
  path: '.agents/research/2026-09-27-bug-hunt-core.md',
  before: '',
  after,
});

const REPORT = [
  '# Bug hunt',
  '',
  '## Guard Map',
  '',
  '| File | Why |',
  '|------|-----|',
  '| src/guard.ts | validates input |',
  '',
  '## Issue Rating Table',
  '',
  '| # | Finding | Lens | Confidence |',
  '|---|---------|------|-----------|',
  '| 1 | src/state.ts:412 — the writer accepts a trailing separator | Write/Read | Confirmed |',
  '| 2 | `src/clock.ts:9` — a retry reads the wall clock | 6 | Traced |',
  '| 3 | src/io.ts — an error is swallowed \\| twice | Error Paths, Cross-Impl | Confirmed |',
  '| 4 | a row with a cell missing | Boundary |',
  '| 5 | src/a.ts:1 — a lens nobody named | Vibes | Suspected |',
].join('\n');

const LENSES = {
  'write/read': 'write_read_asymmetry',
  'error paths': 'error_paths',
  boundary: 'boundary_conditions',
  '6': 'time_concurrency',
};

const TABLE_HANDLER = {
  type: 'review_finding',
  on: 'file.changed',
  where: { tool: 'Write' },
  each: { table: 'after', header: ['finding', 'lens'], as: 'row' },
  capture: {
    file: { field: 'row.finding', regex: '^`?([^\\s`:]+\\.[A-Za-z0-9]+)' },
    line: { field: 'row.finding', regex: '^`?[^\\s`:]+\\.[A-Za-z0-9]+:(\\d+)' },
  },
  maps: { lens: LENSES },
  emit: {
    class: '${row.lens|map.lens}',
    file: '${file}',
    line: '${line}',
    summary: '${row.finding}',
    verdict: '${row.confidence}',
  },
};

function run(spec: unknown, events: readonly NormalizedEvent[]) {
  const handler = runHandler(compileHandler(spec));
  const rows: HandlerRow[] = events.flatMap((event) => [...handler.accept(event)]);
  return { rows, handler };
}

const refused = (spec: unknown): string => {
  try {
    compileHandler(spec);
  } catch (error) {
    if (error instanceof HandlerError) return error.message;
    throw error;
  }
  return 'ACCEPTED';
};

describe('each: table fans out over the rows of a markdown table', () => {
  it('emits one row per body row of the table whose header names the columns', () => {
    const { rows } = run(TABLE_HANDLER, [changed(REPORT)]);
    // The Guard Map table has no Finding or Lens column, so it is not the table asked for.
    expect(rows.map((row) => row.item)).toEqual([0, 1, 2, 4]);
    expect(rows[0]?.fields).toEqual({
      class: 'write_read_asymmetry',
      file: 'src/state.ts',
      line: '412',
      summary: 'src/state.ts:412 — the writer accepts a trailing separator',
      verdict: 'Confirmed',
    });
  });

  it('reads cells by the header, snake-cased, so a reordered table still parses', () => {
    const reordered = [
      '| # | Urgency | Lens | Finding |',
      '|---|---|---|---|',
      '| 1 | High | Boundary | src/b.ts:7 — off by one |',
    ].join('\n');
    const { rows } = run(TABLE_HANDLER, [changed(reordered)]);
    expect(rows[0]?.fields).toMatchObject({ class: 'boundary_conditions', file: 'src/b.ts' });
  });

  it('keeps an escaped pipe inside its cell', () => {
    const { rows } = run(TABLE_HANDLER, [changed(REPORT)]);
    expect(rows[2]?.fields['summary']).toBe('src/io.ts — an error is swallowed | twice');
  });

  it('counts a row whose cells do not match the header, and skips it, keeping later indexes', () => {
    const { rows, handler } = run(TABLE_HANDLER, [changed(REPORT)]);
    expect(handler.malformedItems).toBe(1);
    expect(rows.map((row) => row.item)).not.toContain(3);
  });

  it('leaves a capture absent when its regex does not match the cell', () => {
    const { rows } = run(TABLE_HANDLER, [changed(REPORT)]);
    expect(rows[2]?.fields).not.toHaveProperty('line');
    expect(rows[2]?.fields['file']).toBe('src/io.ts');
  });

  it('emits nothing from a text with no table carrying the header', () => {
    const { rows, handler } = run(TABLE_HANDLER, [changed('# notes\n\nno table here\n')]);
    expect(rows).toEqual([]);
    expect(handler.triggers).toBe(1);
  });
});

describe('maps: normalising a cell onto a closed vocabulary', () => {
  const classes = (text: string): (string | undefined)[] =>
    run(TABLE_HANDLER, [changed(text)]).rows.map((row) => row.fields['class']);

  it('maps a name case-insensitively, and a lens number', () => {
    expect(classes(REPORT).slice(0, 2)).toEqual(['write_read_asymmetry', 'time_concurrency']);
  });

  it('takes the FIRST lens of a cell that names several', () => {
    expect(classes(REPORT)[2]).toBe('error_paths');
  });

  it('takes the first of several numbers, and keeps a name that itself holds a slash', () => {
    const text = [
      '| # | Finding | Lens |',
      '|---|---|---|',
      '| 1 | src/a.ts:1 — x | 6/3 |',
      '| 2 | src/a.ts:2 — y | write/read |',
    ].join('\n');
    expect(classes(text)).toEqual(['time_concurrency', 'write_read_asymmetry']);
  });

  it('leaves the value ABSENT when nothing maps, rather than passing the raw cell through', () => {
    const { rows } = run(TABLE_HANDLER, [changed(REPORT)]);
    expect(rows[3]?.fields).not.toHaveProperty('class');
  });
});

describe('type: a handler whose rows become entries', () => {
  it('carries the trigger event’s id on every row, which is what an entry is keyed on', () => {
    const { rows } = run(TABLE_HANDLER, [changed(REPORT, 'toolu_9')]);
    expect(rows.every((row) => row.event_id === 'toolu_9')).toBe(true);
  });

  it('exposes the type on the compiled handler', () => {
    expect(compileHandler(TABLE_HANDLER).type).toBe('review_finding');
  });

  it('adds neither event_id nor item to an untyped handler without a table', () => {
    const { rows } = run({ on: 'file.changed', emit: { p: '${path}' } }, [changed(REPORT)]);
    expect(rows[0]).not.toHaveProperty('event_id');
    expect(rows[0]).not.toHaveProperty('item');
  });
});

describe('compileHandler refuses a typed or table handler that would silently match nothing', () => {
  it('refuses a table over a field that is not a string', () => {
    expect(
      refused({
        on: 'command.run',
        each: { table: 'argv', header: ['a'], as: 'row' },
        emit: { a: '${row.a}' },
      }),
    ).toMatch(/each\.table: must name a string field/);
  });

  it('refuses each with both a table and an array field', () => {
    expect(
      refused({ ...TABLE_HANDLER, each: { table: 'after', field: 'after', as: 'row' } }),
    ).toMatch(/each: table and field are two different fan-outs/);
  });

  it('refuses a table header that is not a non-empty list of names', () => {
    expect(refused({ ...TABLE_HANDLER, each: { table: 'after', header: [], as: 'row' } })).toMatch(
      /each\.header: must be a non-empty list/,
    );
  });

  it('refuses a type on a trigger kind that carries no id to key an entry on', () => {
    expect(refused({ type: 'x', on: 'prompt.submit', emit: { t: '${text}' } })).toMatch(
      /type: prompt\.submit carries no id/,
    );
  });

  it('refuses a type that is not a type name', () => {
    expect(refused({ ...TABLE_HANDLER, type: 'Review Finding' })).toMatch(
      /type: .* is not a type name/,
    );
  });

  it('refuses a where that reads a per-row capture, which does not exist until the fan-out', () => {
    expect(refused({ ...TABLE_HANDLER, where: { file: { exists: true } } })).toMatch(/file/);
  });

  it('refuses a map filter naming a map the handler does not declare', () => {
    expect(
      refused({ ...TABLE_HANDLER, emit: { ...TABLE_HANDLER.emit, class: '${row.lens|map.nope}' } }),
    ).toMatch(/map\.nope/);
  });

  it('refuses a map whose values are not strings', () => {
    expect(refused({ ...TABLE_HANDLER, maps: { lens: { boundary: 3 } } })).toMatch(/maps\.lens/);
  });

  it('refuses a row reference outside a table handler', () => {
    expect(refused({ on: 'file.changed', emit: { a: '${row.lens}' } })).toMatch(/no field "row"/);
  });
});
