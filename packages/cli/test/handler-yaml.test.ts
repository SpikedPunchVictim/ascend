import { describe, expect, it } from 'vitest';
import { HandlerError } from '@ascend/core';
import { MAX_HANDLER_BYTES, loadHandler, parseHandlerYaml } from '../src/handler-yaml.js';

/**
 * The strict YAML front end (asc-6ola.13). The cases are the spike's measured hazards
 * (spike/handler-format/hazards.mjs), which all eight had to be refused, plus the YAML 1.1
 * traps the core schema must NOT reproduce.
 */

const refusal = (source: string): string => {
  try {
    loadHandler(source);
  } catch (error) {
    if (error instanceof HandlerError) return error.message;
    throw error;
  }
  return 'ACCEPTED';
};

const BEAD_CLOSE = `# bd close <ids>: one stage transition per id
on: command.run
where:
  is_error: false
  head: bd
  argv.1: close
each: { field: argv, from: 2, matches: '^[a-z]+-[a-z0-9]+(\\.[0-9]+)*$', as: bead }
emit:
  stage: '\${bead}'
  to_status: complete
`;

describe('parseHandlerYaml refuses the measured hazards', () => {
  it.each([
    [
      'anchor + alias',
      'on: command.run\nwhere: &w { is_error: true }\nemit: { x: *w }',
      /anchors|aliases/,
    ],
    [
      'merge key',
      'on: command.run\nwhere:\n  <<: { is_error: true }\nemit: { x: a }',
      /merge keys|<</,
    ],
    [
      'explicit standard tag',
      'on: command.run\nwhere: { head: !!str bd }\nemit: { x: a }',
      /explicit tags/,
    ],
    [
      'explicit custom tag',
      'on: command.run\nwhere: { head: !custom bd }\nemit: { x: a }',
      /explicit tags|tag/,
    ],
    [
      'a number where a string is required (1.10)',
      'on: command.run\nwhere: { head: 1.10 }\nemit: { x: a }',
      /is a number, the field is a string/,
    ],
    [
      'a word for a boolean (yes)',
      'on: command.run\nwhere: { is_error: yes }\nemit: { x: a }',
      /is a string, the field is a boolean/,
    ],
    [
      'a duplicate key',
      'on: command.run\nwhere: { is_error: true, is_error: false }\nemit: { x: a }',
      /[Dd]uplicate|unique/,
    ],
    [
      'an unknown key',
      'on: command.run\nwher: { is_error: true }\nemit: { x: a }',
      /unknown key wher/,
    ],
    [
      'an unknown field',
      'on: command.run\nwhere: { hed: bd }\nemit: { x: a }',
      /has no field "hed"/,
    ],
    ['invalid YAML', 'on: [command.run\n', /not valid YAML/],
  ])('refuses %s', (_name, source, message) => {
    expect(refusal(source)).toMatch(message);
  });

  it('refuses a file over the size cap unread', () => {
    expect(refusal(`# ${'x'.repeat(MAX_HANDLER_BYTES)}\non: command.run`)).toMatch(/over 65536/);
  });

  it('keeps on, yes and no as strings under YAML 1.2', () => {
    expect(parseHandlerYaml('on: x\nyes: on\nno: 1.1')).toEqual({ on: 'x', yes: 'on', no: 1.1 });
  });
});

describe('loadHandler', () => {
  it('loads the spike handler and hashes its meaning, not its text', () => {
    const original = loadHandler(BEAD_CLOSE);
    const reformatted = loadHandler(`emit: {to_status: "complete", stage: "\${bead}"}
each:
  as: bead
  matches: "^[a-z]+-[a-z0-9]+(\\\\.[0-9]+)*$"
  from: 2
  field: argv
where: {argv.1: "close", head: 'bd', is_error: false}
on: "command.run"
`);
    const changed = loadHandler(BEAD_CLOSE.replace('from: 2', 'from: 1'));
    expect(reformatted.hash).toBe(original.hash);
    expect(changed.hash).not.toBe(original.hash);
  });
});

/**
 * `judged` through the strict YAML front end (asc-6ola.9).
 *
 * The core compiler owns the refusals (`packages/core/test/handler.test.ts`); what this file has
 * to show is that the key survives the loader at all. A top-level key the front end dropped would
 * make every one of those refusals unreachable from a real handler file -- the loader is the only
 * way a project handler is ever parsed.
 */
describe('judged survives the strict YAML front end', () => {
  const HEAD = 'on: command.run\nemit: { head: bd }\n';

  it('parses the list in document order', () => {
    expect(loadHandler(`${HEAD}judged: [outcome, usable]\n`).judged).toEqual(['outcome', 'usable']);
  });

  it('is an empty list when the key is absent', () => {
    expect(loadHandler(HEAD).judged).toEqual([]);
  });

  it('refuses a judged name that is also emitted', () => {
    expect(refusal(`${HEAD}judged: [head]\n`)).toMatch(/judged: head is also emitted/);
  });

  it('refuses an empty list', () => {
    expect(refusal(`${HEAD}judged: []\n`)).toMatch(/judged: must be a non-empty list of names/);
  });

  it('hashes a declared judgment differently from no declaration', () => {
    expect(loadHandler(`${HEAD}judged: [outcome]\n`).hash).not.toBe(loadHandler(HEAD).hash);
  });
});
