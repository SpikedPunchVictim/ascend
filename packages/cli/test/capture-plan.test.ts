import { describe, expect, it } from 'vitest';
import type { TranscriptFile } from '@ascend/adapter-claude-code';
import type { TypeSpec } from '@ascend/core';
import {
  createCapturePlanner,
  draftSayHandler,
  draftTableHandler,
  matchColumns,
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

function skill(name: string, session = 's-1') {
  n += 1;
  const id = `toolu_s${String(n)}`;
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
  ];
}

function plan(records: readonly Record<string, unknown>[]) {
  const planner = createCapturePlanner(SPEC);
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
      ['SEV1', 'sev1'],
      ['Sev 2', 'sev2'],
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
