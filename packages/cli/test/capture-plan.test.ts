import { describe, expect, it } from 'vitest';
import type { TranscriptFile } from '@ascend/adapter-claude-code';
import { runHandler, type NormalizedEvent, type TypeSpec } from '@ascend/core';
import {
  createCapturePlanner,
  draftSayHandler,
  draftTableHandler,
  matchColumns,
  numberedHeadings,
} from '../src/capture-plan.js';
import { loadHandler } from '../src/handler-yaml.js';

/**
 * The capture planner (asc-tuur.5), over hand-built records. The type is a user's own, not a
 * derived one: the planner must work from nothing but a spec's names and descriptions.
 */

const SPEC: TypeSpec = {
  name: 'incident',
  properties: [
    { name: 'service', type: 'string', required: true, description: 'The service that failed.' },
    {
      name: 'severity',
      type: 'enum',
      enum_values: ['sev1', 'sev2', 'sev3'],
      required: true,
      description: 'How bad it was, as the pager level.',
    },
    {
      name: 'summary',
      type: 'text',
      required: true,
      description: 'What the outage did, in one line.',
    },
    { name: 'owner', type: 'string', required: true, description: 'Who was paged first.' },
    { name: 'tool_use_id', type: 'ref', required: true, description: 'The Write this came from.' },
    { name: 'session_id', type: 'string', description: 'The session.' },
  ],
};

const FILE: TranscriptFile = {
  path: '/root/-p/s-1.jsonl',
  project: '-p',
  session: 's-1',
  kind: 'session',
};

const TABLE = [
  '| Service | Pager Level | Outage | Notes |',
  '|---|---|---|---|',
  '| billing | SEV1 | invoices stalled | - |',
  '| search | Sev 2 | slow queries | - |',
  '| auth | P0 | logins failed | - |',
].join('\n');

let n = 0;
function write(content: string, session = 's-1') {
  n += 1;
  const id = `toolu_w${String(n)}`;
  return [
    {
      type: 'assistant',
      sessionId: session,
      message: {
        id: `m${String(n)}`,
        content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: 'r.md', content } }],
      },
    },
    {
      type: 'user',
      sessionId: session,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    },
  ];
}

function skill(name: string, session = 's-1', text?: string) {
  n += 1;
  const id = `toolu_s${String(n)}`;
  // A skill's load puts its text in the transcript as a meta user record, after the tool result.
  const loaded =
    text === undefined
      ? []
      : [
          {
            type: 'user',
            isMeta: true,
            sessionId: session,
            message: {
              content: [
                { type: 'text', text: `Base directory for this skill: /s/${name}\n\n${text}` },
              ],
            },
          },
        ];
  return [
    {
      type: 'assistant',
      sessionId: session,
      message: {
        id: `m${String(n)}`,
        content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }],
      },
    },
    {
      type: 'user',
      sessionId: session,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    },
    ...loaded,
  ];
}

function plan(records: readonly Record<string, unknown>[], spec: TypeSpec = SPEC) {
  const planner = createCapturePlanner(spec);
  for (const record of records) planner.accept(record, FILE);
  return planner.finish();
}

describe('matchColumns', () => {
  it('matches a column by name, and by its words in the first sentence of a description', () => {
    expect(matchColumns(['service', 'pager_level', 'outage', 'notes'], SPEC)).toEqual([
      { column: 'service', property: 'service', how: 'name' },
      { column: 'pager_level', property: 'severity', how: 'description' },
      { column: 'outage', property: 'summary', how: 'description' },
    ]);
  });

  it('never proposes a provenance property from a column', () => {
    expect(matchColumns(['session_id', 'service'], SPEC).map((one) => one.property)).toEqual([
      'service',
    ]);
  });

  it('gives a column to the property whose first sentence names it earliest, once', () => {
    const spec: TypeSpec = {
      name: 't',
      properties: [
        { name: 'a', type: 'string', description: 'The file the finding is in.' },
        { name: 'b', type: 'string', description: 'The finding in its own words.' },
      ],
    };
    expect(matchColumns(['finding'], spec)).toEqual([
      { column: 'finding', property: 'b', how: 'description' },
    ]);
  });
});

describe('createCapturePlanner', () => {
  it('finds a table whose columns match, with its sessions, rows and the skills before it', () => {
    const [table] = plan([...skill('postmortem'), ...write(TABLE)]).tables;
    expect(table).toMatchObject({
      sessions: 1,
      writes: 1,
      rows: 3,
      missing: ['owner', 'tool_use_id'],
    });
    expect(table?.skills).toEqual([{ skill: 'postmortem', sessions: 1 }]);
  });

  it('credits a table to the skill loaded last before it, not every skill in the session', () => {
    const [table] = plan([...skill('find-skills'), ...skill('postmortem'), ...write(TABLE)]).tables;
    expect(table?.skills).toEqual([{ skill: 'postmortem', sessions: 1 }]);
  });

  it('maps an enum cell by folding case and separators, and leaves the rest unmapped', () => {
    const [table] = plan(write(TABLE)).tables;
    expect([...(table?.values.get('severity') ?? [])]).toEqual([
      ['SEV1', { key: 'sev1', value: 'sev1', by: 'name' }],
      ['Sev 2', { key: 'sev 2', value: 'sev2', by: 'name' }],
      ['P0', undefined],
    ]);
  });

  it('ignores a table with fewer than two matching columns', () => {
    expect(plan(write('| Service | Notes |\n|---|---|\n| a | b |')).tables).toEqual([]);
  });

  it('reports a tool call whose input carries property names, including in an array of objects', () => {
    const records = [
      {
        type: 'assistant',
        sessionId: 's-1',
        message: {
          id: 'm-t',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Page',
              input: { incidents: [{ service: 'a', owner: 'b' }] },
            },
          ],
        },
      },
    ];
    expect(plan(records).tools).toEqual([
      {
        tool: 'Page',
        at: 'input.incidents[]',
        properties: ['owner', 'service'],
        sessions: 1,
        calls: 1,
      },
    ]);
  });
});

describe('drafts', () => {
  const [table] = plan([...skill('postmortem'), ...write(TABLE)]).tables;
  if (table === undefined) throw new Error('fixture has a table');

  it('drafts a table handler that the strict loader accepts, as a typed handler', () => {
    const handler = loadHandler(draftTableHandler(SPEC, table, '1 session'));
    expect(handler.type).toBe('incident');
    expect(handler.each?.mode).toBe('table');
  });

  it('names the required property it cannot fill, and fills a missing ref with the Write id', () => {
    const text = draftTableHandler(SPEC, table, '1 session');
    expect(text).toMatch(/REQUIRED AND NOT IN THE TABLE: owner\./);
    expect(text).toContain('tool_use_id: "${id}"');
    expect(text).toMatch(/severity: these cell values map to no enum value and are refused: "P0"/);
  });

  it('drafts a say handler that asks the skill behind the table for the missing column', () => {
    const text = draftSayHandler(SPEC, table) ?? '';
    expect(loadHandler(text).say).toBe(true);
    expect(text).toMatch(/in: \[postmortem\]/);
    expect(text).toMatch(/a column for each of: owner\./);
  });

  it('drafts no say handler when nothing is missing', () => {
    expect(draftSayHandler(SPEC, { ...table, missing: ['tool_use_id'] })).toBeUndefined();
  });
});

describe('reading a real report: a file in a section, a lens by number (asc-tuur.8)', () => {
  // The enum is alphabetical, as review_finding's is, and the skill numbers its lenses in another
  // order -- so a number read as a position in the enum would map every one of these wrongly.
  const FINDING: TypeSpec = {
    name: 'finding',
    properties: [
      { name: 'file', type: 'string', required: true, description: 'The file the finding is in.' },
      { name: 'line', type: 'integer', description: 'The line it is anchored to.' },
      { name: 'summary', type: 'text', required: true, description: 'The finding in its words.' },
      {
        name: 'class',
        type: 'enum',
        enum_values: ['boundary_conditions', 'error_paths', 'time_concurrency'],
        required: true,
        description: 'Which lens found this.',
      },
    ],
  };
  const SKILL = [
    '### Lens 1: Time & Concurrency',
    '### Lens 2: Boundary Conditions *(new)*',
    '### Lens 3: Error Path Exerciser',
    '### Step 4: Boundary Conditions',
  ].join('\n');
  const REPORT = [
    '| # | Finding | Lens |',
    '|---|---|---|',
    '| 1 | `src/a.ts:3` — the cell names the file | 2 |',
    '| 2 | the cell names none | 1 |',
    '| 3 | nothing anywhere | 3, 1 |',
    '',
    '### 2. The section names it',
    '',
    'At src/b.ts:9, the value is read twice.',
  ].join('\n');
  const [table] = plan([...skill('hunt', 's-1', SKILL), ...write(REPORT)], FINDING).tables;
  if (table === undefined) throw new Error('fixture has a table');

  it('maps a number through the numbered headings of the skill loaded before the table', () => {
    const values = table.values.get('class');
    expect(values?.get('2')).toEqual({
      key: '2',
      value: 'boundary_conditions',
      by: 'skill',
      skill: 'hunt',
    });
    expect(values?.get('3, 1')?.value).toBe('error_paths');
  });

  it('leaves a number unmapped when no loaded skill numbers the column', () => {
    const [bare] = plan(write(REPORT), FINDING).tables;
    expect(bare?.values.get('class')?.get('2')).toBeUndefined();
  });

  it('reads only headings led by the column name, each fitting exactly one value', () => {
    const numbered = numberedHeadings(
      `${SKILL}\n### Lens 4: Boundary Time Concurrency Conditions`,
      'lens',
      ['boundary_conditions', 'time_concurrency'],
    );
    expect([...numbered]).toEqual([
      ['1', 'time_concurrency'],
      ['2', 'boundary_conditions'],
    ]);
  });

  it('finds the file at the start of a cell, and else in the row’s own section', () => {
    expect(table.paths).toEqual([
      { property: 'file', line: 'line', column: 'finding', fromCell: 1, fromSection: 1, rows: 3 },
    ]);
  });

  it('drafts a handler that reads both, and writes the rows that have a file', () => {
    const text = draftTableHandler(FINDING, table, '1 session');
    expect(text).toContain('section: section');
    const run = runHandler(loadHandler(text));
    const event: NormalizedEvent = {
      kind: 'file.changed',
      session_id: 's-1',
      agent_id: 'main',
      seq: 1,
      call: 1,
      derive_version: 5,
      id: 'toolu_w',
      tool: 'Write',
      path: 'r.md',
      before: '',
      after: REPORT,
    };
    const rows = run.accept(event).map((row) => row.fields);
    expect(rows.map((row) => [row['file'], row['line'], row['class']])).toEqual([
      ['src/a.ts', '3', 'boundary_conditions'],
      ['src/b.ts', '9', 'time_concurrency'],
      [undefined, undefined, 'error_paths'],
    ]);
  });

  it('asks for no column the draft already fills', () => {
    expect(draftSayHandler(FINDING, table)).toBeUndefined();
  });

  it('names a capture so it never shadows a field of the trigger', () => {
    const spec: TypeSpec = {
      ...FINDING,
      properties: FINDING.properties.map((one) =>
        one.name === 'file' ? { ...one, name: 'path' } : one,
      ),
    };
    const [withPath] = plan(write(REPORT), spec).tables;
    if (withPath === undefined) throw new Error('fixture has a table');
    const text = draftTableHandler(spec, withPath, '1 session');
    expect(text).toContain('path: "${path_found}"');
    expect(loadHandler(text).type).toBe('finding');
  });
});
