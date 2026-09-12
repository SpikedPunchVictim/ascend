import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  canonicalizeProperty,
  canonicalizeTypeSpec,
  type TypeSpec,
} from '../src/index.js';

/**
 * The vocabulary bounds what an LLM can invent. EV-drift measured that this is NOT
 * sufficient by itself: across 44 real LLM-authored property names the
 * intersection/union was 0.091 against a 0.70 threshold, with Jaccard 0.300 against
 * 0.60. Names arrived in snake_case and camelCase interchangeably. Canonicalization
 * is the required remedy, so these tests are about convergence, not formatting taste.
 *
 * The names below are the real ones EV-drift measured.
 */

describe('canonicalName', () => {
  it('folds the separator variants that actually appeared in the corpus', () => {
    // EV-drift: 'review_kind' and 'reviewKind' were both observed. They must not be
    // two different properties.
    expect(canonicalName('reviewKind')).toBe('review_kind');
    expect(canonicalName('review_kind')).toBe('review_kind');
    expect(canonicalName('review-kind')).toBe('review_kind');
    expect(canonicalName('Review Kind')).toBe('review_kind');
    expect(canonicalName('review.kind')).toBe('review_kind');
  });

  it('splits acronym runs without shredding them', () => {
    expect(canonicalName('HTTPServer')).toBe('http_server');
    expect(canonicalName('parseJSONBody')).toBe('parse_json_body');
  });

  it('is idempotent -- canonical form is a fixed point', () => {
    // This is what lets the registry treat canonical form as the definition's identity.
    for (const raw of ['reviewKind', 'HTTPServer', '  spaced  ', 'a--b', 'outcome']) {
      const once = canonicalName(raw);
      expect(canonicalName(once)).toBe(once);
    }
  });

  it('collapses separators and trims edges', () => {
    expect(canonicalName('__a__b__')).toBe('a_b');
    expect(canonicalName('a/b\\c')).toBe('a_b_c');
  });
});

describe('canonicalizeProperty', () => {
  it('reports the renames it applied, rather than silently rewriting', () => {
    const { spec, renames } = canonicalizeProperty({ name: 'reviewKind', type: 'string' });
    expect(spec.name).toBe('review_kind');
    expect(renames).toEqual([{ from: 'reviewKind', to: 'review_kind' }]);
  });

  it('reports nothing when the input was already canonical', () => {
    const { renames, warnings } = canonicalizeProperty({ name: 'outcome', type: 'string' });
    expect(renames).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('treats an enum with no values as a warning, not a crash', () => {
    const { warnings } = canonicalizeProperty({ name: 'outcome', type: 'enum' });
    expect(warnings.some((w) => w.includes('no enum_values'))).toBe(true);
  });

  it('flags enum_values on a non-enum, and a unit on a non-unit-bearing type', () => {
    const { warnings } = canonicalizeProperty({
      name: 'count',
      type: 'boolean',
      enum_values: ['a'],
      unit: 'ms',
    });
    expect(warnings.some((w) => w.includes('enum_values but its type is'))).toBe(true);
    expect(warnings.some((w) => w.includes('has a unit'))).toBe(true);
  });
});

describe('canonicalizeTypeSpec', () => {
  it('catches two properties that canonicalize to the same name', () => {
    // The drift failure mode itself, caught at define time rather than months later.
    const { warnings } = canonicalizeTypeSpec({
      name: 'review-completed',
      properties: [
        { name: 'reviewKind', type: 'string' },
        { name: 'review_kind', type: 'string' },
      ],
    });
    expect(warnings.some((w) => w.includes("both canonicalize to 'review_kind'"))).toBe(true);
  });

  it('applies the required sanity rule from EV-drift', () => {
    // Every one of the modelled definitions in EV-drift marked ALL properties required.
    const { warnings } = canonicalizeTypeSpec({
      name: 'review-completed',
      properties: [
        { name: 'outcome', type: 'string', required: true },
        { name: 'reviewer', type: 'ref', required: true },
      ],
    });
    expect(warnings.some((w) => w.includes('every property required'))).toBe(true);
  });

  it('does not fire the required rule when at least one property is optional', () => {
    const { warnings } = canonicalizeTypeSpec({
      name: 'review-completed',
      properties: [
        { name: 'outcome', type: 'string', required: true },
        { name: 'note', type: 'text' },
      ],
    });
    expect(warnings.some((w) => w.includes('every property required'))).toBe(false);
  });

  it('canonicalizes the type name and every property name together', () => {
    const input: TypeSpec = {
      name: 'Review Completed',
      properties: [{ name: 'reviewKind', type: 'enum', enum_values: ['a'] }],
    };
    const { spec, renames } = canonicalizeTypeSpec(input);
    expect(spec.name).toBe('review_completed');
    expect(spec.properties[0]?.name).toBe('review_kind');
    expect(renames.map((r) => r.to)).toEqual(['review_completed', 'review_kind']);
  });

  it('sorts properties, so declaration order cannot masquerade as a different definition', () => {
    const { spec } = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [
        { name: 'zeta', type: 'string' },
        { name: 'alpha', type: 'string' },
      ],
    });
    expect(spec.properties.map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });

  it('sorts enum values, which are a set rather than a sequence', () => {
    const { spec } = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [{ name: 'outcome', type: 'enum', enum_values: ['rejected', 'approved'] }],
    });
    expect(spec.properties[0]?.enum_values).toEqual(['approved', 'rejected']);
  });

  it('is idempotent on a whole spec', () => {
    const once = canonicalizeTypeSpec({
      name: 'Review Completed',
      properties: [{ name: 'parseJSONBody', type: 'string' }],
    });
    const twice = canonicalizeTypeSpec(once.spec);
    expect(twice.renames).toEqual([]);
    expect(twice.spec).toEqual(once.spec);
  });
});
