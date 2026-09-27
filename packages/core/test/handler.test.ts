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

/**
 * `judged` -- the declaration that a field is deliberately not measured (asc-6ola.9).
 *
 * The store's third state is the default one: `not_measured` needs no encoding (`state.ts`), so a
 * judgment field's value is simply ABSENT from `fields`, and the handler's whole job is to say the
 * absence was intended rather than forgotten. Both halves are pinned here -- that nothing is
 * invented for a judged name, and that a handler without the key is untouched by any of this.
 */
describe('judged declares a field the handler deliberately does not measure', () => {
  const base = { on: 'command.run', emit: { head: '${head}' } };

  it('carries the declared names on every row it emits', () => {
    const { rows } = run(
      { ...base, judged: ['outcome', 'usable'] },
      stream(() => ev('command.run', 1, { head: 'bd' })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.judged).toEqual(['outcome', 'usable']);
  });

  it('invents no value for a judged name', () => {
    const { rows } = run(
      { ...base, judged: ['outcome'] },
      stream(() => ev('command.run', 1, { head: 'bd' })),
    );
    // Declared and absent at the same time, which is the point: the row says the field exists and
    // that no one measured it, rather than saying the handler never heard of it.
    expect(rows[0]?.judged).toEqual(['outcome']);
    expect(rows[0]?.fields).toEqual({ head: 'bd' });
    expect(Object.hasOwn(rows[0]?.fields ?? {}, 'outcome')).toBe(false);
  });

  it('leaves a handler that declares none byte-identical', () => {
    const { rows } = run(
      base,
      stream(() => ev('command.run', 1, { head: 'bd' })),
    );
    expect(rows[0]?.judged).toBeUndefined();
    expect('judged' in (rows[0] as object)).toBe(false);
  });

  it('rides on a window row, which is the shape asc-6ola.9 uses', () => {
    // `until: session.end`, NOT `until: agent.return`. An until equal to the kind the window
    // watches closes it on the very event it waits for and emits nothing (handler.ts:808-815),
    // so this test fails with an empty `rows` under that shape -- which is the defect that was
    // in the first draft of this plan, pinned here so it cannot come back.
    const { rows, unclosed } = run(
      {
        on: 'agent.spawn',
        window: {
          until: 'session.end',
          first: {
            on: 'agent.return',
            where: { child_agent_id: { eq: '$child_agent_id' } },
          },
        },
        emit: { child: '${child_agent_id}', status: '${window.first.status}' },
        judged: ['outcome'],
      },
      stream(
        () => ev('agent.spawn', 1, { id: 't1', child_agent_id: 'a1', agent_type: 'Explore' }),
        () => ev('agent.return', 2, { id: 't1', child_agent_id: 'a1', status: 'completed' }),
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closed_by).toBe('match');
    expect(rows[0]?.fields).toEqual({ child: 'a1', status: 'completed' });
    expect(rows[0]?.judged).toEqual(['outcome']);
    expect(unclosed).toBe(0);
  });

  it('counts a spawn whose return never came as unclosed, not as a row', () => {
    // The absent-trigger-field case: `child_agent_id` is absent on a launch failure, `eq` needs
    // both sides present (handler.ts:302), so nothing can match. The window must end up unclosed
    // rather than emitting a row claiming a return that never happened.
    const { rows, unclosed } = run(
      {
        on: 'agent.spawn',
        window: {
          until: 'session.end',
          first: {
            on: 'agent.return',
            where: { child_agent_id: { eq: '$child_agent_id' } },
          },
        },
        emit: { child: '${child_agent_id}' },
        judged: ['outcome'],
      },
      stream(
        () => ev('agent.spawn', 1, { id: 't1' }),
        () => ev('agent.return', 2, { id: 't1', child_agent_id: 'a1', status: 'completed' }),
        () => ev('session.end', 2),
      ),
    );
    expect(rows).toEqual([]);
    expect(unclosed).toBe(1);
  });

  it('changes the hash, so declaring a judgment is a different handler', () => {
    expect(compileHandler({ ...base, judged: ['outcome'] }).hash).not.toBe(
      compileHandler(base).hash,
    );
  });

  it.each([
    ['an empty list', [], /judged: must be a non-empty list of names/],
    ['a string instead of a list', 'outcome', /judged: must be a non-empty list of names/],
    ['a name that is not a name', ['Outcome'], /judged\[0\]: "Outcome" is not a name/],
    ['a duplicate name', ['outcome', 'outcome'], /judged: outcome appears twice/],
    [
      'a name that is also emitted',
      ['head'],
      /judged: head is also emitted -- a field is either measured or it is not/,
    ],
  ])('refuses %s', (_name, judged, message) => {
    expect(refused({ ...base, judged })).toMatch(message);
  });
});

/**
 * An `until` that is a kind the window itself watches can never decide anything, and the shape
 * that does it -- `until: agent.return` with `first: {on: agent.return}` -- was the first draft
 * of asc-6ola.9's handler. It loaded, ran, and reported `rows: []` with `unclosed: 0`: a handler
 * green over its entire signal. Refused at compile time so it cannot be written down at all.
 */
describe('compileWindow refuses an until that is a kind the window watches', () => {
  const emit = { x: 'a' };
  it.each([
    [
      'first',
      {
        on: 'agent.spawn',
        window: { until: 'agent.return', first: { on: 'agent.return' } },
        emit,
      },
    ],
    [
      'count',
      {
        on: 'agent.spawn',
        window: { until: 'agent.return', count: { on: 'agent.return' } },
        emit,
      },
    ],
    [
      'absent',
      {
        on: 'agent.spawn',
        window: { until: 'agent.return', absent: { on: 'agent.return' } },
        emit,
      },
    ],
    [
      'an any-form alternative',
      {
        on: 'agent.spawn',
        window: {
          until: 'agent.return',
          absent: { any: [{ on: 'check.run' }, { on: 'agent.return' }] },
        },
        emit,
      },
    ],
  ])('refuses %s', (_name, spec) => {
    expect(refused(spec)).toMatch(/window\.until: agent\.return is a kind this window watches/);
  });

  it('allows an until that is a different kind from the watched one', () => {
    expect(
      refused({
        on: 'agent.spawn',
        window: { until: 'session.end', first: { on: 'agent.return' } },
        emit,
      }),
    ).toBe('ACCEPTED');
  });
});

/**
 * `scope` and `before`, the two constructs asc-gtnu.4 adds (Stage 0: spike/review-join).
 *
 * Stage 0 measured the finding-to-implementer join as 58.1% cross-stream (483 of 831 subagent read
 * pairs), which is what `scope: session` exists for, and 23.3% unsatisfiable (194 of 831), which is
 * what `unsatisfiedBefore` exists for -- an unsatisfiable join must be REPORTED, never emitted as a
 * zero-valued row.
 *
 * Every event here is hand-built. No transcript in the corpus holds a reviewer: `ReportFindings`
 * has been called 0 times across 1,236 files (asc-gtnu.1), so nothing in this block is evidence
 * about reviewers -- it is evidence about the constructs.
 */
describe('scope: session merges a session’s streams, and scope: stream does not', () => {
  /** An event in a named stream. `seq` is the caller's, because a merged partition is the point. */
  const at = (
    kind: string,
    stream: { session: string; agent: string },
    seq: number,
    fields: Record<string, unknown> = {},
  ): NormalizedEvent => ({
    kind,
    session_id: stream.session,
    agent_id: stream.agent,
    seq,
    call: 1,
    derive_version: 4,
    ...fields,
  });

  const MAIN = { session: 's1', agent: 'main' };
  const SUB = { session: 's1', agent: 'agent-x' };
  const OTHER_SESSION = { session: 's2', agent: 'main' };

  const emit = { p: '${path}', r: '${window.first.runner}' };
  /** The finding's shape: an edit in one stream, the check that followed it in another. */
  const crossStream = (scope?: string): unknown => ({
    ...(scope === undefined ? {} : { scope }),
    on: 'file.changed',
    window: { until: 'prompt.submit', first: { on: 'check.run', where: { runner: 'pnpm' } } },
    emit,
  });

  const CHANGED = at('file.changed', MAIN, 0, { path: '/a.ts', tool: 'Edit' });
  const CHECKED = at('check.run', SUB, 0, { runner: 'pnpm', verdict: 'pass' });
  const PROMPT = at('prompt.submit', MAIN, 1, { text: 'next' });

  const drive = (
    spec: unknown,
    events: readonly NormalizedEvent[],
  ): { rows: HandlerRow[]; noMatch: number; unclosed: number } => {
    const handler = runHandler(compileHandler(spec));
    const rows = events.flatMap((event) => [...handler.accept(event)]);
    handler.finish();
    return { rows, noMatch: handler.noMatch, unclosed: handler.unclosed };
  };

  it('matches an event of another stream in the same session', () => {
    const { rows } = drive(crossStream('session'), [CHANGED, CHECKED, PROMPT]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe('main');
    expect(rows[0]?.closed_by).toBe('match');
    expect(rows[0]?.fields).toEqual({ p: '/a.ts', r: 'pnpm' });
  });

  it('does NOT match it under the default scope, and reports the decided miss instead', () => {
    // The same three events and the same handler minus one line. Under `stream` the check.run is a
    // different partition, so the window never sees it; `prompt.submit` closes it with no match,
    // and that verdict is counted rather than dropped.
    const { rows, noMatch, unclosed } = drive(crossStream(), [CHANGED, CHECKED, PROMPT]);
    expect(rows).toEqual([]);
    expect({ noMatch, unclosed }).toEqual({ noMatch: 1, unclosed: 0 });
  });

  it('keeps two sessions apart even at session scope', () => {
    const other = at('check.run', OTHER_SESSION, 0, { runner: 'pnpm' });
    const prompt = at('prompt.submit', OTHER_SESSION, 1, { text: 'next' });
    const { rows } = drive(crossStream('session'), [CHANGED, other, PROMPT, prompt]);
    expect(rows).toEqual([]);
  });

  it('does not let a stream’s session.end close a session-scoped window', () => {
    // `session.end` is one event per STREAM (normalize.ts `end()` runs on every transcript file),
    // so honoring it here would close the window on the subagent file that ended while the main
    // stream -- which is where the check lands -- was still unread. Counted as unclosed instead.
    const end = at('session.end', SUB, 1);
    const { rows, noMatch, unclosed } = drive(crossStream('session'), [CHANGED, end, CHECKED]);
    expect(rows).toHaveLength(1);
    expect({ noMatch, unclosed }).toEqual({ noMatch: 0, unclosed: 0 });
  });

  it('counts a session-scoped window the log ended inside, at finish', () => {
    // Without `finish()` this trigger would leave no trace at all: not emitted, not counted.
    const { rows, unclosed } = drive(crossStream('session'), [CHANGED]);
    expect(rows).toEqual([]);
    expect(unclosed).toBe(1);
  });

  it('refuses a scope that is not one of the two', () => {
    expect(refused(crossStream('global'))).toMatch(/scope: "global" -- expected stream or session/);
  });

  it.each([
    [
      'calls, because call numbers count within one stream',
      'session',
      { calls: 2, first: { on: 'check.run' } },
      /session-scoped window cannot count calls/,
    ],
    [
      'until: session.end, because it is one event per stream',
      'session',
      { until: 'session.end', first: { on: 'check.run' } },
      /session\.end is one event per STREAM/,
    ],
    [
      'a window with no until at all',
      'session',
      { first: { on: 'check.run' } },
      /session-scoped window needs until:/,
    ],
  ])('refuses %s under scope: session', (_name, scope, window, message) => {
    expect(refused({ scope, on: 'file.changed', window, emit })).toMatch(message);
  });

  it('still allows calls and until: session.end under the default scope', () => {
    expect(
      refused({
        on: 'file.changed',
        window: { calls: 2, first: { on: 'check.run' } },
        emit: { r: '${window.first.runner}' },
      }),
    ).toBe('ACCEPTED');
    expect(
      refused({
        on: 'file.changed',
        window: { until: 'session.end', absent: { on: 'check.run' } },
        emit: { p: '${path}', r: '${before.path}' },
      }),
    ).toMatch(/declares no before:/);
  });

  it('leaves the handler hash alone when the default scope is declared explicitly', () => {
    // `scope: stream` and no `scope` mean the same thing at run time, and the hash is over the
    // parsed form, so it must NOT mean the same thing there -- a handler whose partition changed
    // has to hash differently or a stored row cannot be traced to the handler that emitted it.
    expect(compileHandler(crossStream('stream')).hash).not.toBe(compileHandler(crossStream()).hash);
  });
});

describe('before: the most recent match earlier in the partition', () => {
  const emit = { runner: '${runner}', prior: '${before.path}' };
  /** Every `check.run` carrying the path of the `file.changed` that preceded it. */
  const spec = {
    on: 'check.run',
    before: { on: 'file.changed' },
    emit,
  };

  const drive = (
    s: unknown,
    events: readonly NormalizedEvent[],
  ): { rows: HandlerRow[]; unsatisfiedBefore: number } => {
    const handler = runHandler(compileHandler(s));
    const rows = events.flatMap((event) => [...handler.accept(event)]);
    handler.finish();
    return { rows, unsatisfiedBefore: handler.unsatisfiedBefore };
  };

  it('emits the earlier event’s field, not the trigger’s', () => {
    const { rows, unsatisfiedBefore } = drive(
      spec,
      stream(
        () => ev('file.changed', 1, { path: '/a.ts', tool: 'Edit' }),
        () => ev('check.run', 2, { runner: 'pnpm', verdict: 'pass' }),
      ),
    );
    expect(rows.map((one) => one.fields)).toEqual([{ runner: 'pnpm', prior: '/a.ts' }]);
    expect(unsatisfiedBefore).toBe(0);
  });

  it('reads the MOST RECENT match, so the second edit wins', () => {
    const { rows } = drive(
      spec,
      stream(
        () => ev('file.changed', 1, { path: '/first.ts' }),
        () => ev('file.changed', 2, { path: '/second.ts' }),
        () => ev('check.run', 3, { verdict: 'pass' }),
      ),
    );
    expect(rows[0]?.fields['prior']).toBe('/second.ts');
  });

  it('never resolves to the trigger itself', () => {
    // `record` runs AFTER the trigger body. If it ran before, this would read `/self.ts`.
    const { rows, unsatisfiedBefore } = drive(
      {
        on: 'file.changed',
        before: { on: 'file.changed' },
        emit: { p: '${path}', prior: '${before.path}' },
      },
      stream(() => ev('file.changed', 1, { path: '/self.ts' })),
    );
    expect(rows[0]?.fields).toEqual({ p: '/self.ts' });
    expect(unsatisfiedBefore).toBe(1);
  });

  it('omits the field and COUNTS the trigger when nothing precedes it', () => {
    // Stage 0's (d): 194 of 831 subagent pairs had nothing to join to, so an unsatisfiable
    // reference is a quarter of the join. The field is ABSENT, never filled with a zero.
    const { rows, unsatisfiedBefore } = drive(
      spec,
      stream(() => ev('check.run', 1, { verdict: 'pass' })),
    );
    expect(rows).toHaveLength(1);
    expect(Object.hasOwn(rows[0]?.fields ?? {}, 'prior')).toBe(false);
    expect(unsatisfiedBefore).toBe(1);
  });

  it('applies before.where while recording, so it is the most recent MATCH', () => {
    const onlyEdits = {
      on: 'check.run',
      before: { on: 'file.changed', where: { tool: 'Write' } },
      emit,
    };
    const { rows, unsatisfiedBefore } = drive(
      onlyEdits,
      stream(
        () => ev('file.changed', 1, { path: '/written.ts', tool: 'Write' }),
        () => ev('file.changed', 2, { path: '/edited.ts', tool: 'Edit' }),
        () => ev('check.run', 3, { verdict: 'pass' }),
      ),
    );
    // The most recent `file.changed` is the Edit, which does not match; the Write does. A
    // reference that only filtered at resolve time would find nothing here.
    expect(rows[0]?.fields['prior']).toBe('/written.ts');
    expect(unsatisfiedBefore).toBe(0);
  });

  it('resolves the reference at the TRIGGER, so a window row carries the trigger’s', () => {
    // The window opens on the first `file.changed` and is decided by the check.run. The reference
    // on that row is that trigger's -- and nothing preceded the first edit, so it is ABSENT and
    // counted, even though the row is emitted 2 events later, when `/late.ts` has been seen.
    // Storing the matched event's reference instead would be a different question answered
    // silently: "what preceded the thing that ended the window".
    const { rows, unsatisfiedBefore } = drive(
      {
        on: 'file.changed',
        before: { on: 'file.changed' },
        window: { until: 'session.end', first: { on: 'check.run' } },
        emit: { p: '${path}', prior: '${before.path}', r: '${window.first.runner}' },
      },
      stream(
        () => ev('file.changed', 1, { path: '/early.ts' }),
        () => ev('file.changed', 2, { path: '/late.ts' }),
        () => ev('check.run', 3, { runner: 'pnpm' }),
      ),
    );
    expect(rows[0]?.fields).toEqual({ p: '/early.ts', r: 'pnpm' });
    expect(unsatisfiedBefore).toBe(1);
  });

  it('does not reach across streams under the default scope', () => {
    const handler = runHandler(
      compileHandler({ on: 'check.run', before: { on: 'file.changed' }, emit }),
    );
    const changed: NormalizedEvent = {
      kind: 'file.changed',
      session_id: 's1',
      agent_id: 'main',
      seq: 0,
      call: 1,
      derive_version: 4,
      path: '/main.ts',
    };
    const check: NormalizedEvent = { ...changed, kind: 'check.run', agent_id: 'agent-x', seq: 0 };
    expect([...handler.accept(changed)]).toEqual([]);
    const rows = [...handler.accept(check)];
    expect(rows[0]?.fields['prior']).toBeUndefined();
    expect(handler.unsatisfiedBefore).toBe(1);
  });

  it.each([
    ['a before that is not a map', 'nope', /before: must be a map/],
    ['an unknown key', { on: 'file.changed', when: 'x' }, /before: unknown key when/],
    ['a kind that does not exist', { on: 'file.change' }, /is not an event kind/],
    ['a missing on', { where: { path: 'x' } }, /is not an event kind/],
    [
      'a field the before kind does not carry',
      { on: 'check.run' },
      /check\.run has no field "path"/,
    ],
    [
      'a $ reference in before.where',
      { on: 'file.changed', where: { path: { eq: '$path' } } },
      /a \$ reference names a field of the TRIGGER/,
    ],
    [
      'a $ reference on the right of before.where',
      { on: 'file.changed', where: { path: { eq: '$tool' } } },
      /a \$ reference names a field of the TRIGGER/,
    ],
  ])('refuses %s', (_name, before, message) => {
    // `${before.path}` is on `check.run`'s own template, so a refusal here is the `before` block
    // and not a template naming a field the kind lacks.
    expect(refused({ on: 'check.run', before, emit: { x: '${before.path}...' } })).toMatch(message);
  });

  it('refuses a ${before.…} template on a handler that declares no before', () => {
    expect(refused({ on: 'check.run', emit: { x: '${before.path}' } })).toMatch(
      /declares no before:/,
    );
  });

  it('refuses before under scope: session, and says what the order would have been', () => {
    expect(
      refused({
        scope: 'session',
        on: 'check.run',
        before: { on: 'file.changed' },
        emit: { x: '${before.path}' },
      }),
    ).toMatch(/before: is not available under scope: session/);
  });

  it('names the reference in the handler hash', () => {
    expect(compileHandler(spec).hash).not.toBe(
      compileHandler({ on: 'check.run', before: { on: 'file.read' }, emit }).hash,
    );
  });
});

/**
 * `noMatch`: windows DECIDED with "no match" as the verdict by a bound other than the stream's end.
 *
 * The silence this closes predates asc-gtnu.4 and is measured, not reasoned: on
 * `handlers/edit-verified.yaml` over this project's log, 488 of its 3,326 triggers (`rows` 2782 +
 * `unclosed` 56 leaves 488 unaccounted) were this case and incremented nothing, so a reader could
 * not tell them from windows that never opened.
 */
describe('a window decided with no match is counted, not dropped', () => {
  const emit = { x: 'a' };

  it('counts a first closed by its until', () => {
    const handler = runHandler(
      compileHandler({
        on: 'agent.spawn',
        window: { until: 'agent.return', first: { on: 'check.run' } },
        emit,
      }),
    );
    handler.accept(ev('agent.spawn', 1, { child_agent_id: 'c1' }));
    handler.accept(ev('agent.return', 2, { child_agent_id: 'c1' }));
    expect({ noMatch: handler.noMatch, unclosed: handler.unclosed }).toEqual({
      noMatch: 1,
      unclosed: 0,
    });
  });

  it('still counts a stream’s own end as unclosed, not as a decided miss', () => {
    const handler = runHandler(
      compileHandler({
        on: 'agent.spawn',
        window: { until: 'agent.return', first: { on: 'check.run' } },
        emit,
      }),
    );
    handler.accept(ev('agent.spawn', 1, { child_agent_id: 'c1' }));
    handler.accept(ev('session.end', 2, {}));
    expect({ noMatch: handler.noMatch, unclosed: handler.unclosed }).toEqual({
      noMatch: 0,
      unclosed: 1,
    });
  });

  it('counts a count window closed below at_least', () => {
    const handler = runHandler(
      compileHandler({
        on: 'agent.spawn',
        window: { until: 'agent.return', count: { on: 'check.run' }, at_least: 2 },
        emit,
      }),
    );
    handler.accept(ev('agent.spawn', 1, { child_agent_id: 'c1' }));
    handler.accept(ev('check.run', 2, { runner: 'pnpm' }));
    handler.accept(ev('agent.return', 3, { child_agent_id: 'c1' }));
    expect({ rows: 0, noMatch: handler.noMatch, unclosed: handler.unclosed }).toEqual({
      rows: 0,
      noMatch: 1,
      unclosed: 0,
    });
  });

  it('counts an absent window as a verdict with a row, not as a miss', () => {
    // `absent` EMITS on its until -- "nothing matched" is the row. Counting it as a miss too would
    // count the same decision twice, once as a row and once as its absence.
    const handler = runHandler(
      compileHandler({
        on: 'agent.spawn',
        window: { until: 'agent.return', absent: { on: 'check.run' } },
        emit,
      }),
    );
    handler.accept(ev('agent.spawn', 1, { child_agent_id: 'c1' }));
    const rows = [...handler.accept(ev('agent.return', 2, { child_agent_id: 'c1' }))];
    expect(rows).toHaveLength(1);
    expect({ noMatch: handler.noMatch, unclosed: handler.unclosed }).toEqual({
      noMatch: 0,
      unclosed: 0,
    });
  });

  it('leaves finish() a no-op for a stream-scoped handler, whose windows a session.end decides', () => {
    const handler = runHandler(
      compileHandler({
        on: 'agent.spawn',
        window: { until: 'agent.return', first: { on: 'check.run' } },
        emit,
      }),
    );
    handler.accept(ev('agent.spawn', 1, { child_agent_id: 'c1' }));
    handler.accept(ev('session.end', 2, {}));
    const before = handler.unclosed;
    handler.finish();
    expect(handler.unclosed).toBe(before);
  });
});
