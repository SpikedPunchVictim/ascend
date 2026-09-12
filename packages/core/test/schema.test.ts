import { describe, expect, it } from 'vitest';
import {
  PROPERTY_TYPES,
  buildSchema,
  propertySchema,
  type PropertySpec,
  type PropertyType,
  type TypeSpec,
} from '../src/index.js';

/**
 * ARCHITECTURE.md Stage 1 requires "buildSchema spec->zod coverage for EVERY property
 * type". The first test below enforces that literally -- it fails if a type is added
 * to the vocabulary and not exercised here, so the coverage claim cannot rot.
 */

const accepts = (spec: PropertySpec, value: unknown): boolean =>
  propertySchema(spec).safeParse(value).success;

/** One accepted and one rejected example per property type. */
const CASES: Record<PropertyType, { ok: unknown; bad: unknown }> = {
  string: { ok: 'hello', bad: 42 },
  number: { ok: 1.5, bad: '1.5' },
  integer: { ok: 3, bad: 1.5 },
  boolean: { ok: false, bad: 'false' },
  enum: { ok: 'approved', bad: 'maybe' },
  timestamp: { ok: '2026-09-11T10:00:00Z', bad: 'last tuesday' },
  duration: { ok: 250, bad: -1 },
  ref: { ok: 'asc-abc123', bad: '' },
  text: { ok: 'a long free-text note', bad: { not: 'a string' } },
};

describe('property type coverage', () => {
  it('exercises every member of the vocabulary, with no gaps', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROPERTY_TYPES].sort());
  });

  it.each(PROPERTY_TYPES)('accepts and rejects the right things for %s', (type) => {
    const spec: PropertySpec = {
      name: 'p',
      type,
      ...(type === 'enum' ? { enum_values: ['approved', 'rejected'] } : {}),
    };
    expect(accepts(spec, CASES[type].ok), `${type} should accept ${String(CASES[type].ok)}`).toBe(
      true,
    );
    expect(accepts(spec, CASES[type].bad), `${type} should reject ${String(CASES[type].bad)}`).toBe(
      false,
    );
  });
});

describe('propertySchema specifics', () => {
  it('accepts a real 0 for a number', () => {
    // The fold-corpus failure mode: 0 meaning "measured zero" AND "unknown" AND
    // "doesn't apply". A real 0 is a measurement and must be storable.
    expect(accepts({ name: 'count', type: 'number' }, 0)).toBe(true);
    expect(accepts({ name: 'count', type: 'integer' }, 0)).toBe(true);
    expect(accepts({ name: 'elapsed', type: 'duration' }, 0)).toBe(true);
  });

  it('rejects NaN and infinities for numeric types', () => {
    // A NaN recorded as a measurement is indistinguishable from a bug and poisons
    // every downstream statistic.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        accepts({ name: 'n', type: 'number' }, bad),
        `number should reject ${String(bad)}`,
      ).toBe(false);
      expect(
        accepts({ name: 'n', type: 'integer' }, bad),
        `integer should reject ${String(bad)}`,
      ).toBe(false);
      expect(
        accepts({ name: 'd', type: 'duration' }, bad),
        `duration should reject ${String(bad)}`,
      ).toBe(false);
    }
  });

  it('rejects a negative duration', () => {
    expect(accepts({ name: 'd', type: 'duration' }, -1)).toBe(false);
  });

  it('rejects an empty ref', () => {
    // No empty-string sentinels: a ref that points at nothing is not a ref.
    expect(accepts({ name: 'r', type: 'ref' }, '')).toBe(false);
  });

  it('makes an enum with no values impossible to satisfy', () => {
    const result = propertySchema({ name: 'e', type: 'enum' }).safeParse('anything');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('no enum_values');
    }
  });

  it('accepts a timestamp with an offset', () => {
    expect(accepts({ name: 't', type: 'timestamp' }, '2026-09-11T10:00:00+02:00')).toBe(true);
  });
});

describe('buildSchema', () => {
  const spec: TypeSpec = {
    name: 'review_completed',
    properties: [
      { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
      { name: 'reviewer', type: 'ref' },
      { name: 'comments', type: 'integer' },
    ],
  };

  it('treats a missing property as legal -- absence means "not measured"', () => {
    // The default state. Rejecting absence here would make every partial entry illegal,
    // and an entry that cannot be recorded is the product's primary failure mode.
    expect(buildSchema(spec).safeParse({}).success).toBe(true);
  });

  it('validates each present property against its declared type', () => {
    expect(buildSchema(spec).safeParse({ outcome: 'approved', comments: 0 }).success).toBe(true);
    expect(buildSchema(spec).safeParse({ outcome: 'maybe' }).success).toBe(false);
    expect(buildSchema(spec).safeParse({ comments: 'three' }).success).toBe(false);
  });

  it('strips undeclared keys rather than rejecting the entry', () => {
    // Deliberate: a stripped key is recoverable and reportable; a rejected entry is
    // lost work. validateEntry turns stripping into a visible warning.
    const result = buildSchema(spec).safeParse({ outcome: 'approved', surprise: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ outcome: 'approved' });
  });

  it('accepts a real 0 through the object schema, not just the property schema', () => {
    const result = buildSchema(spec).safeParse({ comments: 0 });
    expect(result.success).toBe(true);
    if (result.success) expect('comments' in result.data).toBe(true);
  });
});
