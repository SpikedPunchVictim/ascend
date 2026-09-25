import { describe, expect, it } from 'vitest';
import {
  HandlerError,
  MAX_REGEX_LENGTH,
  compileHandler,
  runHandler,
  type HandlerRow,
  type NormalizedEvent,
} from '../src/index.js';

/**
 * The handler compiler and evaluator (asc-6ola.13), against hand-built event streams.
 *
 * The same code is driven over the frozen corpus by spike/handler-format/runtime-parity.mjs,
 * which reproduces the spike's reference rows for all five spike handlers.
 */

let seq = 0;
/** An event in stream (s1, main). `seq` increases across calls; reset per test by `stream`. */
function ev(kind: string, call: number, fields: Record<string, unknown> = {}): NormalizedEvent {
  const event = {
    kind,
    session_id: 's1',
    agent_id: 'main',
    seq,
    call,
    derive_version: 1,
    ...fields,
  };
  seq += 1;
  return event;
}
function stream(...events: (() => NormalizedEvent)[]): NormalizedEvent[] {
  seq = 0;
  return events.map((make) => make());
}

function run(
  spec: unknown,
  events: readonly NormalizedEvent[],
): { rows: HandlerRow[]; unclosed: number } {
  const handler = runHandler(compileHandler(spec));
  const rows = events.flatMap((event) => [...handler.accept(event)]);
  return { rows, unclosed: handler.unclosed };
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

describe('compileHandler refuses what would silently match nothing', () => {
  const base = { on: 'command.run', emit: { x: 'a' } };

  it.each([
    ['an unknown top-level key', { ...base, wher: {} }, /unknown key wher/],
    ['an unknown event kind', { ...base, on: 'command.ran' }, /not an event kind/],
    ['a field the kind does not carry', { ...base, where: { hed: 'bd' } }, /has no field "hed"/],
    ['a field of another kind', { ...base, where: { path: 'x' } }, /has no field "path"/],
    [
      'a number where the field is a string',
      { ...base, where: { head: 1.1 } },
      /is a number, the field is a string/,
    ],
    [
      'a string where the field is a boolean',
      { ...base, where: { is_error: 'yes' } },
      /is a string, the field is a boolean/,
    ],
    [
      'two operators in one matcher',
      { ...base, where: { head: { eq: 'a', ne: 'b' } } },
      /exactly one operator/,
    ],
    ['an unknown operator', { ...base, where: { head: { like: 'a' } } }, /exactly one operator/],
    ['gt on a string field', { ...base, where: { head: { gt: 1 } } }, /compares numbers/],
    [
      'matches on an array field',
      { ...base, where: { argv: { matches: 'x' } } },
      /needs a string field/,
    ],
    [
      'contains on a string field',
      { ...base, where: { head: { contains: 'x' } } },
      /needs an array field/,
    ],
    ['indexing a non-array', { ...base, where: { 'head.1': 'x' } }, /not an array/],
    ['an unknown $ reference', { ...base, where: { head: '$nope' } }, /has no field "nope"/],
    [
      'a bad regex',
      { ...base, where: { head: { matches: '(' } } },
      /Invalid regular expression|Unterminated group/,
    ],
    [
      'an oversized regex',
      { ...base, where: { head: { matches: 'a'.repeat(MAX_REGEX_LENGTH + 1) } } },
      /over 300/,
    ],
    [
      'a regex flag other than i, m, s',
      { ...base, where: { head: { matches: 'a', flags: 'g' } } },
      /flags may be/,
    ],
    [
      'flags on a non-regex operator',
      { ...base, where: { head: { eq: 'a', flags: 'i' } } },
      /flags apply only/,
    ],
    ['a missing emit', { on: 'command.run' }, /emit: is required/],
    ['an emit value that is not a string', { ...base, emit: { x: 1 } }, /string template/],
    [
      'a template naming an unknown field',
      { ...base, emit: { x: '${nope}' } },
      /has no field "nope"/,
    ],
    ['an unknown filter', { ...base, emit: { x: '${head|upper}' } }, /unknown filter upper/],
    [
      'a capture shadowing a field',
      { ...base, capture: { head: { field: 'head', regex: 'x' } } },
      /shadows/,
    ],
    ['each over a string field', { ...base, each: { field: 'head', as: 'b' } }, /array field/],
    ['each.as shadowing a field', { ...base, each: { field: 'argv', as: 'id' } }, /shadows/],
    [
      'a window with no end',
      { ...base, window: { first: { on: 'command.run' } } },
      /never decided/,
    ],
    [
      'a window with two modes',
      { ...base, window: { calls: 2, first: { on: 'command.run' }, count: { on: 'command.run' } } },
      /exactly one of/,
    ],
    [
      'at_least outside count',
      { ...base, window: { calls: 2, at_least: 2, first: { on: 'command.run' } } },
      /applies only to count/,
    ],
    [
      'window.count outside a count window',
      {
        ...base,
        window: { calls: 2, first: { on: 'command.run' } },
        emit: { x: '${window.count}' },
      },
      /not available/,
    ],
    [
      'a window field of the wrong kind',
      { ...base, window: { calls: 2, first: { on: 'search.run', where: { head: 'x' } } } },
      /search.run has no field "head"/,
    ],
  ])('refuses %s', (_name, spec, message) => {
    expect(refused(spec)).toMatch(message);
  });

  it('accepts a $ reference to a trigger field inside a window', () => {
    expect(
      refused({
        ...base,
        window: {
          calls: 3,
          count: { on: 'command.run', where: { head: '$head', call: { gt: '$call' } } },
        },
        emit: { n: '${window.count}' },
      }),
    ).toBe('ACCEPTED');
  });
});

describe('the handler hash', () => {
  it('ignores key order and changes with any value', () => {
    const one = compileHandler({
      on: 'command.run',
      where: { head: 'bd', is_error: false },
      emit: { a: 'x' },
    });
    const reordered = compileHandler({
      emit: { a: 'x' },
      where: { is_error: false, head: 'bd' },
      on: 'command.run',
    });
    const changed = compileHandler({
      on: 'command.run',
      where: { head: 'bd', is_error: true },
      emit: { a: 'x' },
    });
    expect(reordered.hash).toBe(one.hash);
    expect(changed.hash).not.toBe(one.hash);
    expect(one.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('matching a single event', () => {
  const close = {
    on: 'command.run',
    where: { is_error: false, head: 'bd', 'argv.1': 'close' },
    each: { field: 'argv', from: 2, matches: '^[a-z]+-\\d+$', as: 'bead' },
    emit: { stage: '${bead}', to_status: 'complete' },
  };

  it('fans out one row per matching array element', () => {
    const { rows } = run(
      close,
      stream(() =>
        ev('command.run', 1, {
          head: 'bd',
          argv: ['bd', 'close', 'a-1', '--x', 'b-2'],
          is_error: false,
        }),
      ),
    );
    expect(rows.map((row) => row.fields)).toEqual([
      { stage: 'a-1', to_status: 'complete' },
      { stage: 'b-2', to_status: 'complete' },
    ]);
    expect(rows[0]).toMatchObject({ session_id: 's1', agent_id: 'main', call: 1 });
    expect(rows[0]?.closed_by).toBeUndefined();
  });

  it('treats an absent field as not equal: eq false, ne true', () => {
    const events = stream(() => ev('command.run', 1, { head: 'bd', argv: ['bd', 'close', 'a-1'] }));
    expect(run(close, events).rows).toEqual([]);
    expect(
      run({ on: 'command.run', where: { is_error: { ne: true } }, emit: { h: '${head}' } }, events)
        .rows,
    ).toHaveLength(1);
  });

  it('captures from a field and compares captures with $', () => {
    const spec = {
      on: 'file.changed',
      capture: {
        to: { field: 'after', regex: 'Status:\\s*(\\w+)', flags: 'i' },
        from: { field: 'before', regex: 'Status:\\s*(\\w+)', flags: 'i' },
      },
      where: { path: { matches: 'PLAN\\.md$' }, $to: { exists: true }, $from: { ne: '$to' } },
      emit: { stage: '${path|basename}', from: '${from|snake}', to: '${to|snake}' },
    };
    const { rows } = run(
      spec,
      stream(
        () =>
          ev('file.changed', 1, {
            path: '/a/PLAN.md',
            before: 'status: Draft',
            after: 'Status: Complete',
          }),
        () =>
          ev('file.changed', 2, {
            path: '/a/PLAN.md',
            before: 'Status: Complete',
            after: 'Status: Complete',
          }),
      ),
    );
    expect(rows.map((row) => row.fields)).toEqual([
      { stage: 'PLAN.md', from: 'draft', to: 'complete' },
    ]);
  });

  it('omits a field whose single reference is absent, and renders it empty inside text', () => {
    const { rows } = run(
      { on: 'search.run', emit: { hits: '${hits}', label: 'n=${hits}' } },
      stream(() => ev('search.run', 1, { via: 'rg', pattern: 'x' })),
    );
    expect(rows[0]?.fields).toEqual({ label: 'n=' });
  });

  it('supports any, all, not, in, contains, any_matches, followed_by', () => {
    const spec = {
      on: 'command.run',
      where: {
        any: [
          { argv: { contains: '--claim' } },
          { argv: { followed_by: ['--status', 'in_progress'] } },
        ],
        not: { head: { in: ['git', 'ls'] } },
        argv: { any_matches: '^asc-' },
      },
      emit: { h: '${head}' },
    };
    const events = stream(
      () =>
        ev('command.run', 1, {
          head: 'bd',
          argv: ['bd', 'update', 'asc-1', '--status', 'in_progress'],
        }),
      () => ev('command.run', 2, { head: 'bd', argv: ['bd', 'update', 'asc-2', '--claim'] }),
      () =>
        ev('command.run', 3, { head: 'bd', argv: ['bd', 'update', 'asc-3', '--status', 'done'] }),
      () => ev('command.run', 4, { head: 'git', argv: ['git', 'asc-4', '--claim'] }),
    );
    expect(run(spec, events).rows.map((row) => row.call)).toEqual([1, 2]);
  });
});

describe('windows', () => {
  const searchMiss = {
    on: 'search.run',
    where: { hits: 0 },
    window: {
      calls: 2,
      first: {
        on: 'search.run',
        where: { hits: { gt: 0 }, pattern: { shares_token: '$pattern' } },
      },
    },
    emit: { pattern: '${pattern}', corrected_by: '${window.first.pattern}' },
  };

  it('first: emits at the match, carrying the matched event', () => {
    const { rows } = run(
      searchMiss,
      stream(
        () => ev('search.run', 1, { pattern: 'createDeriver', hits: 0 }),
        () => ev('search.run', 2, { pattern: 'function createDeriver', hits: 3 }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call: 1,
      closed_by: 'match',
      fields: { corrected_by: 'function createDeriver' },
    });
  });

  it('first: an event past the call limit is outside the window', () => {
    const { rows } = run(
      searchMiss,
      stream(
        () => ev('search.run', 1, { pattern: 'createDeriver', hits: 0 }),
        () => ev('search.run', 4, { pattern: 'createDeriver', hits: 3 }),
      ),
    );
    expect(rows).toEqual([]);
  });

  it('first: the window kind is part of the match, not only the where', () => {
    // A where with no condition is true of every kind's event; the earlier tool.use.start must
    // not be taken as the match even though it carries the same-named field.
    const spec = {
      on: 'file.changed',
      window: { calls: 3, first: { on: 'check.run' } },
      emit: { at: '${window.first.ts}' },
    };
    const { rows } = run(
      spec,
      stream(
        () => ev('file.changed', 1, { path: 'a.ts' }),
        () => ev('tool.use.start', 2, { ts: 'early' }),
        () =>
          ev('check.run', 2, {
            ts: 'late',
            runner: 'r',
            verdict_state: 'measured',
            verdict: 'passed',
          }),
      ),
    );
    expect(rows[0]?.fields['at']).toBe('late');
  });

  it('never lets the trigger match its own window', () => {
    const { rows } = run(
      {
        on: 'search.run',
        window: { calls: 2, first: { on: 'search.run' } },
        emit: { p: '${pattern}' },
      },
      stream(
        () => ev('search.run', 1, { pattern: 'a', hits: 0 }),
        () => ev('session.end', 1),
      ),
    );
    expect(rows).toEqual([]);
  });

  it('holds a calls window open while a call inside the limit is still running', () => {
    const spec = {
      on: 'command.run',
      where: { head: 'a' },
      window: { calls: 1, count: { on: 'command.run', where: { head: 'b' } } },
      emit: { n: '${window.count}' },
    };
    // Calls 1 and 2 start together; call 3 starts before call 2 ends. Call 2 is inside the
    // limit (1 + 1), so its late event still counts; call 3's does not.
    const { rows } = run(
      spec,
      stream(
        () => ev('tool.use.start', 1),
        () => ev('tool.use.start', 2),
        () => ev('tool.use.end', 1),
        () => ev('command.run', 1, { head: 'a' }),
        () => ev('tool.use.start', 3),
        () => ev('tool.use.end', 3),
        () => ev('command.run', 3, { head: 'b' }),
        () => ev('tool.use.end', 2),
        () => ev('command.run', 2, { head: 'b' }),
        () => ev('tool.use.start', 4),
      ),
    );
    expect(rows).toEqual([expect.objectContaining({ closed_by: 'calls', fields: { n: '1' } })]);
  });

  it('count: emits at close only when at_least is reached', () => {
    const spec = {
      on: 'command.run',
      where: { is_error: true },
      window: {
        calls: 5,
        count: { on: 'command.run', where: { head: '$head', is_error: true } },
        at_least: 2,
      },
      emit: { command: '${head}', again: '${window.count}' },
    };
    const events = stream(
      () => ev('command.run', 1, { head: 'pnpm', is_error: true }),
      () => ev('command.run', 2, { head: 'pnpm', is_error: true }),
      () => ev('command.run', 3, { head: 'pnpm', is_error: true }),
      () => ev('command.run', 9, { head: 'ls', is_error: false }),
    );
    // Call 1 sees 2 repeats (at_least met); call 2 sees 1 (not met); call 3 sees 0.
    const { rows } = run(spec, events);
    expect(rows.map((row) => [row.call, row.fields['again']])).toEqual([[1, '2']]);
  });

  it('absent + until: emits when nothing matched before the until kind', () => {
    const spec = {
      on: 'file.changed',
      window: { until: 'prompt.submit', absent: { on: 'check.run' } },
      emit: { path: '${path}' },
    };
    const { rows, unclosed } = run(
      spec,
      stream(
        () => ev('file.changed', 1, { path: 'a.ts' }),
        () => ev('prompt.submit', 1, { text: 'next' }),
        () => ev('file.changed', 2, { path: 'b.ts' }),
        () =>
          ev('check.run', 3, { runner: 'pnpm test', verdict_state: 'measured', verdict: 'passed' }),
        () => ev('prompt.submit', 3, { text: 'next' }),
      ),
    );
    expect(rows.map((row) => [row.fields['path'], row.closed_by])).toEqual([['a.ts', 'until']]);
    expect(unclosed).toBe(0);
  });

  it('counts an undecided window at session end as unclosed, and emits nothing for it', () => {
    const absentSpec = {
      on: 'file.changed',
      window: { until: 'prompt.submit', absent: { on: 'check.run' } },
      emit: { path: '${path}' },
    };
    const { rows, unclosed } = run(
      absentSpec,
      stream(
        () => ev('file.changed', 1, { path: 'a.ts' }),
        () => ev('session.end', 1),
      ),
    );
    expect(rows).toEqual([]);
    expect(unclosed).toBe(1);
  });

  it('absent + until: session.end emits at stream end when nothing matched', () => {
    // read.unused (asc-6ola.8): the stream's end is the window's own end, so it decides the
    // verdict instead of leaving it unclosed.
    const spec = {
      on: 'file.read',
      window: {
        until: 'session.end',
        absent: { on: 'file.changed', where: { path: { eq: '$path' } } },
      },
      emit: { path: '${path}' },
    };
    const { rows, unclosed } = run(
      spec,
      stream(
        () => ev('file.read', 1, { path: '/a/x.ts' }),
        () => ev('check.run', 2, { runner: 't', verdict_state: 'measured', verdict: 'passed' }),
        () => ev('session.end', 2),
      ),
    );
    expect(rows.map((row) => [row.fields['path'], row.closed_by])).toEqual([
      ['/a/x.ts', 'session.end'],
    ]);
    expect(unclosed).toBe(0);
  });

  it('absent + until: session.end stays silent when a watcher matched first', () => {
    const spec = {
      on: 'file.read',
      window: {
        until: 'session.end',
        absent: { on: 'file.changed', where: { path: { eq: '$path' } } },
      },
      emit: { path: '${path}' },
    };
    const { rows, unclosed } = run(
      spec,
      stream(
        () => ev('file.read', 1, { path: '/a/x.ts' }),
        () => ev('file.changed', 2, { path: '/a/x.ts' }),
        () => ev('session.end', 2),
      ),
    );
    expect(rows).toEqual([]);
    expect(unclosed).toBe(0);
  });

  it('any: a list of per-kind watchers, each where checked against its own kind', () => {
    const spec = {
      on: 'file.read',
      capture: { base: { field: 'path', regex: '([^/\\\\]+)$' } },
      window: {
        until: 'session.end',
        absent: {
          any: [
            { on: 'file.changed', where: { path: { eq: '$path' } } },
            { on: 'command.run', where: { argv: { contains: '$base' } } },
            { on: 'search.run', where: { pattern: { shares_token: '$base' } } },
          ],
        },
      },
      emit: { path: '${path}' },
    };
    const { rows } = run(
      spec,
      stream(
        // used: an edit to the same path.
        () => ev('file.read', 1, { path: '/a/x.ts' }),
        () => ev('file.changed', 2, { path: '/a/x.ts' }),
        () => ev('session.end', 2),
        // used: a command whose argv names the basename.
        () => ev('file.read', 3, { path: '/a/y.test.ts' }),
        () => ev('command.run', 4, { head: 'pnpm', argv: ['pnpm', 'test', 'y.test.ts'] }),
        () => ev('session.end', 4),
        // used: a search for a token of the basename.
        () => ev('file.read', 5, { path: '/a/z-handlers.ts' }),
        () => ev('search.run', 6, { via: 'Grep', pattern: 'z-handlers export', hits: 2 }),
        () => ev('session.end', 6),
        // unused: nothing later relates to it. A check.run and an edit to another file decide
        // nothing; a RE-READ is not a use either (asc-6ola.8 PREREG).
        () => ev('file.read', 7, { path: '/a/never-used.ts' }),
        () => ev('check.run', 8, { runner: 't', verdict_state: 'not_measured' }),
        () => ev('file.changed', 9, { path: '/a/other.ts' }),
        () => ev('file.read', 10, { path: '/a/never-used.ts' }),
        () => ev('session.end', 10),
      ),
    );
    expect(rows.map((row) => row.fields['path'])).toEqual(['/a/never-used.ts', '/a/never-used.ts']);
  });

  it('shares_token matches an array field by any element', () => {
    // A basename whose tokens are all shorter than 4 has none, so the exact-element `contains`
    // alongside is what saves it; a longer basename matches through a shared token.
    const spec = {
      on: 'file.read',
      capture: { base: { field: 'path', regex: '([^/\\\\]+)$' } },
      window: {
        until: 'session.end',
        absent: {
          any: [
            {
              on: 'command.run',
              where: {
                any: [{ argv: { contains: '$base' } }, { argv: { shares_token: '$base' } }],
              },
            },
          ],
        },
      },
      emit: { path: '${path}' },
    };
    const { rows } = run(
      spec,
      stream(
        () => ev('file.read', 1, { path: '/a/handler-yaml.ts' }),
        () =>
          ev('command.run', 2, {
            head: 'node',
            argv: ['node', 'packages/cli/src/handler-yaml.ts'],
          }),
        () => ev('session.end', 2),
        () => ev('file.read', 3, { path: '/p/cli.ts' }),
        () => ev('session.end', 3),
        () => ev('file.read', 4, { path: '/p/cli.ts' }),
        () => ev('command.run', 5, { head: 'npx', argv: ['npx', 'tsx', 'cli.ts'] }),
        () => ev('session.end', 5),
      ),
    );
    expect(rows.map((row) => row.fields['path'])).toEqual(['/p/cli.ts']);
  });

  it('refuses window shapes that would silently match nothing', () => {
    const base = { on: 'file.read', emit: { x: '${path}' } };
    const absent = (inner: unknown): object => ({
      ...base,
      window: { until: 'session.end', absent: inner },
    });
    expect(refused(absent({ any: [] }))).toMatch(/non-empty list/);
    expect(refused(absent({ any: [{ on: 'file.read' }], on: 'check.run' }))).toMatch(/either|both/);
    expect(refused(absent({ any: [{ on: 'file.ran' }] }))).toMatch(/not an event kind/);
    expect(refused(absent({ any: [{ on: 'file.read', pat: 'x' }] }))).toMatch(/unknown key pat/);
    expect(refused(absent({ any: [{ on: 'file.read', where: { hed: 'x' } }] }))).toMatch(
      /has no field "hed"/,
    );
    // A trigger $reference that names nothing is refused inside a watcher too.
    expect(
      refused(absent({ any: [{ on: 'file.read', where: { path: { eq: '$nope' } } }] })),
    ).toMatch(/has no field "nope"/);
    // The matched event's fields are not addressable from an any-window: the kinds differ.
    expect(
      refused({
        ...base,
        window: {
          until: 'session.end',
          first: { any: [{ on: 'file.changed', where: { path: { eq: '$path' } } }] },
        },
        emit: { at: '${window.first.ts}' },
      }),
    ).toMatch(/not available/);
    // shares_token keeps refusing fields that are neither string nor array.
    expect(refused({ ...base, where: { call: { shares_token: 'x' } } })).toMatch(
      /string or array field/,
    );
  });

  it('still emits a count that reached at_least before session end', () => {
    const spec = {
      on: 'command.run',
      window: { calls: 10, count: { on: 'command.run' } },
      emit: { n: '${window.count}' },
    };
    const { rows, unclosed } = run(
      spec,
      stream(
        () => ev('command.run', 1, { head: 'a' }),
        () => ev('command.run', 2, { head: 'b' }),
        () => ev('session.end', 2),
      ),
    );
    // Call 1's window saw call 2 (count 1, decided); call 2's saw nothing (undecided).
    expect(rows.map((row) => [row.call, row.closed_by, row.fields['n']])).toEqual([
      [1, 'session.end', '1'],
    ]);
    expect(unclosed).toBe(1);
  });

  it('keeps interleaved streams apart', () => {
    const spec = {
      on: 'file.changed',
      window: { until: 'prompt.submit', absent: { on: 'check.run' } },
      emit: { path: '${path}' },
    };
    const handler = runHandler(compileHandler(spec));
    const at = (
      agent: string,
      kind: string,
      s: number,
      fields: Record<string, unknown> = {},
    ): NormalizedEvent => ({
      kind,
      session_id: 's1',
      agent_id: agent,
      seq: s,
      call: 1,
      derive_version: 1,
      ...fields,
    });
    const rows = [
      at('main', 'file.changed', 0, { path: 'a.ts' }),
      at('sub', 'check.run', 0, { runner: 'x', verdict_state: 'not_measured' }),
      at('main', 'prompt.submit', 1, { text: 'go' }),
    ].flatMap((event) => [...handler.accept(event)]);
    // The subagent's check is not the main stream's verification.
    expect(rows.map((row) => row.fields['path'])).toEqual(['a.ts']);
  });
});
