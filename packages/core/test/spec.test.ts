import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  canonicalizeProperty,
  canonicalizeTypeSpec,
  definitionShape,
  ENVELOPE_PROPERTY_NAMES,
  reservedPropertyName,
  STATE_COLUMN_SUFFIX,
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

  it('makes an empty canonical name an ERROR, and stops warning about it', () => {
    // asc-0w9. It was a warning, and the warning was the whole defect: the store refuses on
    // `errors` and registers on `warnings`, so this definition landed with exit 0, `views.ts`
    // built `json_extract(properties_json, '$.')` into an index ON `entries`, and every later
    // INSERT of ANY type failed. Asserting the absence from `warnings` is half the test -- an
    // implementation that pushed to both would still refuse, but would also keep printing a
    // definition as though it had been accepted.
    const { errors, warnings } = canonicalizeProperty({ name: '', type: 'text' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('canonicalizes to empty');
    expect(errors[0]).toContain('$.');
    expect(warnings).toEqual([]);
  });
});

describe('canonicalizeTypeSpec', () => {
  it('REFUSES two properties that canonicalize to the same name, rather than warning', () => {
    // The drift failure mode itself, caught at define time rather than months later -- and caught
    // is the word. It was a warning until asc-4if, and a warning did not catch it: the registry
    // kept the last declaration, so the store's own record disagreed with the submitted document.
    const { errors, warnings } = canonicalizeTypeSpec({
      name: 'review-completed',
      properties: [
        { name: 'reviewKind', type: 'string' },
        { name: 'review_kind', type: 'string' },
      ],
    });
    expect(errors).toHaveLength(1);
    expect(warnings.some((w) => w.includes('canonicalize to'))).toBe(false);
  });

  it('names both declarations as the author SPELLED them, in the order they submitted them', () => {
    // The fold is the reason the two are one name, so a message quoting only 'review_kind' twice
    // would name a string the author typed once and leave them hunting for the other. The PAIRING
    // and the ORDER are both part of the claim: index 0 is the declaration the author wrote first,
    // and a message that quoted the folded name, or listed the two backwards, would send them to
    // the wrong line of their own document. Asserted as one clause because both halves are the
    // claim -- mutation-tested by quoting the fold, and separately by swapping the two.
    const { errors } = canonicalizeTypeSpec({
      name: 'review-completed',
      properties: [
        { name: 'reviewKind', type: 'string' },
        { name: 'review_kind', type: 'string' },
      ],
    });
    expect(errors[0]).toContain(
      "properties 0 ('reviewKind') and 1 ('review_kind') are the same name",
    );
    expect(errors[0]).toContain('Rename one of them');
  });

  it('makes an empty TYPE name an error, where the store could only say CHECK constraint failed', () => {
    // asc-0w9, the smaller half of the same defect. Nothing checked the type name at all, so it
    // reached the store's `name <> ''` CHECK and the user read `Error: CHECK constraint failed:
    // name <> ''` -- naming neither canonicalization, nor which name, nor the fix.
    const { errors, warnings } = canonicalizeTypeSpec({
      name: '',
      properties: [{ name: 'count', type: 'integer' }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("type name '' canonicalizes to empty");
    expect(warnings).toEqual([]);
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

describe('the reserved property vocabulary', () => {
  // asc-865.1. The names below are not a style preference: a generated per-type view projects
  // every property beside the envelope's columns, and SQLite resolves a duplicate by keeping the
  // first and renaming the later one to `source:1` -- silently. The query ARCHITECTURE.md
  // prescribes then reads the ENVELOPE value under the property's name.

  it('refuses every column a generated view projects for the envelope', () => {
    // Driven from the constant rather than retyped, so a name added to the envelope is covered
    // here the moment it is added -- the test cannot fall behind the vocabulary it guards.
    for (const name of ENVELOPE_PROPERTY_NAMES) {
      const reserved = reservedPropertyName(name);
      expect(reserved?.name, `${name} should be reserved`).toBe(name);
      expect(reserved?.reason, `${name} needs a reason`).toContain(name);
    }
  });

  it('offers a suggestion that is itself free, for every refusal it can produce', () => {
    // A suggestion that is also refused is worse than none: it sends the caller round a loop.
    const refused = [...ENVELOPE_PROPERTY_NAMES, 'error_state', 'count_state', 'state_state'];
    for (const name of refused) {
      const reserved = reservedPropertyName(name);
      expect(reserved, `${name} should be reserved`).toBeDefined();
      const suggestion = reserved?.suggestion ?? '';
      expect(reservedPropertyName(suggestion), `suggestion for ${name}`).toBeUndefined();
      expect(canonicalName(suggestion)).toBe(suggestion);
    }
  });

  it('reserves the state-column SUFFIX, naming the property it would collide with', () => {
    // The collision needs two properties to be visible (`error_state` beside `error`), but the
    // rule is unconditional because versions arrive one at a time: allowing `error_state` in
    // version 1 would leave a family that version 2 could never extend with `error`.
    const reserved = reservedPropertyName('error_state');
    expect(reserved?.name).toBe('error_state');
    expect(reserved?.reason).toContain("state of property 'error'");
    expect(STATE_COLUMN_SUFFIX).toBe('_state');
  });

  it('decides on the CANONICAL name, so no spelling gets around it', () => {
    // Canonical form is a property's identity, so it is the form the view would project.
    expect(reservedPropertyName('Source')?.name).toBe('source');
    expect(reservedPropertyName('gitSHA')?.name).toBe('git_sha');
    expect(reservedPropertyName('Recorded At')?.name).toBe('recorded_at');

    const { errors } = canonicalizeProperty({ name: 'Source', type: 'string' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("property 'source'");
  });

  it('leaves a name alone when it collides with nothing', () => {
    // The other direction, and the one that would be easy to overreach on. `_state` is the case
    // asc-865.1 named literally: leading underscores are stripped like any other separator, so it
    // canonicalizes to `state`, which no column claims -- the suffix is only taken when something
    // precedes it. `ascend_version` and `schema_version` are columns of `entries` that no view
    // projects, so a property may use them.
    for (const name of [
      'state',
      '_state',
      'ascend_version',
      'schema_version',
      'properties',
      'na',
      'source_of',
      'id_value',
      'error_status',
      'sourced',
      'count_state_of_mind',
    ]) {
      expect(reservedPropertyName(name), `${name} should be free`).toBeUndefined();
    }
  });

  it('reports a reserved name as an ERROR, not a warning, and still canonicalizes the spec', () => {
    // Errors block; warnings never do. The spec is still returned in canonical form, so a caller
    // can show the author what they wrote and what to rename it to.
    const { spec, renames, warnings, errors } = canonicalizeTypeSpec({
      name: 'note',
      properties: [
        { name: 'summary', type: 'text' },
        { name: 'source', type: 'string' },
      ],
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("property 'source'");
    expect(errors[0]).toContain("'source_value'");
    expect(spec.properties.map((property) => property.name)).toEqual(['source', 'summary']);
    expect(renames).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('reports nothing at all for an ordinary spec', () => {
    const { errors } = canonicalizeTypeSpec({
      name: 'review_completed',
      properties: [
        { name: 'outcome', type: 'enum', enum_values: ['approved'] },
        { name: 'count', type: 'integer' },
      ],
    });
    expect(errors).toEqual([]);
  });

  it('collects one error per offending property, so a rename round trip fixes them all', () => {
    const { errors } = canonicalizeTypeSpec({
      name: 'note',
      properties: [
        { name: 'id', type: 'string' },
        { name: 'workflow', type: 'string' },
        { name: 'error_state', type: 'string' },
        { name: 'summary', type: 'text' },
      ],
    });
    expect(errors).toHaveLength(3);
    expect(errors.map((error) => /property '([^']+)'/.exec(error)?.[1])).toEqual([
      'id',
      'workflow',
      'error_state',
    ]);
  });
});

describe('definitionShape', () => {
  it('drops prose at every level', () => {
    // The rule the whole identity model rests on: prose is not part of what a stored
    // value is validated against, so it is not part of what makes two definitions the
    // same definition.
    const shape = definitionShape({
      name: 'review_completed',
      description: 'a review finished',
      record_when: 'when a code review completes',
      properties: [
        { name: 'count', type: 'integer', description: 'how many findings' },
        { name: 'outcome', type: 'enum', enum_values: ['approved'], description: 'the verdict' },
      ],
    });

    expect(shape).toEqual({
      name: 'review_completed',
      properties: [
        { name: 'count', type: 'integer' },
        { name: 'outcome', type: 'enum', enum_values: ['approved'] },
      ],
    });
  });

  it('keeps every field a validator reads', () => {
    // The other half of the rule, and the one that would be dangerous to get wrong:
    // dropping too much would let two genuinely different shapes hash equal.
    const shape = definitionShape({
      name: 'review_completed',
      properties: [
        { name: 'count', type: 'integer', required: true, unit: 'ms' },
        { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
      ],
    });
    expect(shape.properties[0]).toEqual({
      name: 'count',
      type: 'integer',
      required: true,
      unit: 'ms',
    });
    expect(shape.properties[1]?.enum_values).toEqual(['approved', 'rejected']);
  });

  it('is idempotent', () => {
    const once = definitionShape({
      name: 'review_completed',
      properties: [{ name: 'count', type: 'integer', description: 'drop me' }],
    });
    expect(definitionShape(once)).toEqual(once);
  });

  it('distinguishes shapes that differ only in a field the validator reads', () => {
    // Each pair differs in exactly one shape field, and each must survive the
    // projection. A projection that dropped `unit`, say, would make the first pair
    // identical -- and 250ms and 250s would share a type_hash.
    const base = (property: Record<string, unknown>): TypeSpec => ({
      name: 't',
      properties: [property as never],
    });
    const differ = (a: Record<string, unknown>, b: Record<string, unknown>): void => {
      expect(definitionShape(base(a))).not.toEqual(definitionShape(base(b)));
    };
    differ({ name: 'x', type: 'integer', unit: 'ms' }, { name: 'x', type: 'integer', unit: 's' });
    differ({ name: 'x', type: 'integer' }, { name: 'x', type: 'integer', required: true });
    differ({ name: 'x', type: 'integer' }, { name: 'x', type: 'number' });
    differ(
      { name: 'x', type: 'enum', enum_values: ['a'] },
      { name: 'x', type: 'enum', enum_values: ['a', 'b'] },
    );
    differ({ name: 'x', type: 'integer' }, { name: 'y', type: 'integer' });
  });
});

describe('definitionShape normalizes the fields that constrain nothing', () => {
  // Each of these pairs differs textually but constrains a value identically, so each
  // must project to the same shape. If one did not, two spellings of one definition
  // would hash differently and report as drift.
  const shapeOf = (property: Record<string, unknown>): unknown =>
    definitionShape({ name: 't', properties: [property as never] }).properties[0];

  it('treats required:false and an omitted required as the same rule', () => {
    expect(shapeOf({ name: 'x', type: 'integer', required: false })).toEqual(
      shapeOf({ name: 'x', type: 'integer' }),
    );
  });

  it('drops enum_values from a non-enum, where they validate nothing', () => {
    // canonicalizeProperty warns about this, so it must not also silently split one
    // definition into two.
    expect(shapeOf({ name: 'x', type: 'string', enum_values: ['a'] })).toEqual(
      shapeOf({ name: 'x', type: 'string' }),
    );
  });

  it('drops a unit from a type that cannot carry one', () => {
    expect(shapeOf({ name: 'x', type: 'boolean', unit: 'ms' })).toEqual(
      shapeOf({ name: 'x', type: 'boolean' }),
    );
  });
});
