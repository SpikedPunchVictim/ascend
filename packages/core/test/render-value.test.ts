import { describe, expect, it } from 'vitest';
import { PROPERTY_TYPES, renderDeclaredValue, type PropertyType } from '../src/index.js';

/**
 * `renderDeclaredValue` -- the one place that decides how a value pulled through a lossy
 * `json_extract` projection is printed for its DECLARED type (`asc-6wn`).
 *
 * `boolean` is the only type SQLite's JSON functions cannot round-trip: it has no boolean storage
 * class, so a stored `true`/`false` comes back as the INTEGER `1`/`0`. Every other type in the
 * vocabulary is unaffected by that projection, so the coverage table below asserts the negative
 * for all nine of them -- unchanged is exactly as load-bearing as changed, and a future case that
 * quietly started transforming a `string` or a `json` value would fail one of these rows.
 */

/** One raw-input/expected-output pair per property type, covering every member with no gaps. */
const CASES: Record<PropertyType, { readonly raw: string | number; readonly rendered: string }> = {
  boolean: { raw: 1, rendered: 'true' },
  string: { raw: 'hello', rendered: 'hello' },
  number: { raw: 1.5, rendered: '1.5' },
  integer: { raw: 7, rendered: '7' },
  enum: { raw: 'approved', rendered: 'approved' },
  timestamp: { raw: '2026-09-11T10:00:00Z', rendered: '2026-09-11T10:00:00Z' },
  duration: { raw: 250, rendered: '250' },
  ref: { raw: 'asc-abc123', rendered: 'asc-abc123' },
  text: { raw: 'a long free-text note', rendered: 'a long free-text note' },
  json: { raw: '{"a":[1,2]}', rendered: '{"a":[1,2]}' },
};

describe('renderDeclaredValue: type coverage', () => {
  it('exercises every member of the vocabulary, with no gaps', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROPERTY_TYPES].sort());
  });

  it.each(PROPERTY_TYPES)('renders %s from its raw projected value', (type) => {
    const { raw, rendered } = CASES[type];
    expect(renderDeclaredValue(type, raw)).toBe(rendered);
  });
});

describe('renderDeclaredValue: boolean, the one lossy projection', () => {
  it('renders SQLite\'s integer 1 as true, not "1" (the asc-6wn defect)', () => {
    expect(renderDeclaredValue('boolean', 1)).toBe('true');
  });

  it('renders SQLite\'s integer 0 as false, not "0"', () => {
    expect(renderDeclaredValue('boolean', 0)).toBe('false');
  });

  // A real `false` is falsy in JavaScript, the same way SQLite's `0` is -- a naive
  // `if (!raw) return null` fix would swallow it and make a measured `false` indistinguishable
  // from nothing having been measured at all. Asserted with a strict `.toBe`, so a future change
  // that returns `undefined`/`null`/`''` for `0` fails this rather than reading as "falsy, close
  // enough".
  it('does not treat the falsy raw 0 as an absence', () => {
    expect(renderDeclaredValue('boolean', 0)).toBe('false');
    expect(renderDeclaredValue('boolean', 0)).not.toBeNull();
    expect(renderDeclaredValue('boolean', 0)).not.toBeUndefined();
  });

  it('renders the string forms "1" and "0" the same way as the numeric forms', () => {
    expect(renderDeclaredValue('boolean', '1')).toBe('true');
    expect(renderDeclaredValue('boolean', '0')).toBe('false');
  });

  it('passes an unrecognised raw value through rather than guessing true or false', () => {
    expect(renderDeclaredValue('boolean', 2)).toBe('2');
  });
});

describe('renderDeclaredValue: null is a state, never a value', () => {
  it('passes null through for boolean, rather than rendering a fabricated false', () => {
    expect(renderDeclaredValue('boolean', null)).toBeNull();
  });

  it('passes null through for every other type too', () => {
    for (const type of PROPERTY_TYPES) {
      expect(renderDeclaredValue(type, null), `${type} should pass null through`).toBeNull();
    }
  });
});
