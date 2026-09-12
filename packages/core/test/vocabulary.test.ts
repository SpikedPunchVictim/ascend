import { describe, expect, it } from 'vitest';
import { PROPERTY_TYPES, type PropertyType } from '../src/index.js';

describe('bounded property vocabulary', () => {
  it('is exactly the ten types settled in ARCHITECTURE.md', () => {
    expect(PROPERTY_TYPES).toEqual([
      'string',
      'number',
      'integer',
      'boolean',
      'enum',
      'timestamp',
      'duration',
      'ref',
      'text',
      'json',
    ]);
  });

  it('admits no duplicates', () => {
    expect(new Set(PROPERTY_TYPES).size).toBe(PROPERTY_TYPES.length);
  });

  it('every member is assignable to PropertyType', () => {
    const first: PropertyType = PROPERTY_TYPES[0];
    expect(first).toBe('string');
  });
});
