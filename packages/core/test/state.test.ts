import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalName, validateEntry, type TypeSpec } from '../src/index.js';

/**
 * The three-state model is the reason this product exists. The fold corpus it was
 * derived from collapsed "measured zero", "unknown" and "doesn't apply" into a single
 * `0`, and no downstream statistic could recover which one any row meant.
 *
 * So the central test here is not "does validation work" but: can a real 0 and an
 * explicit N/A EVER be confused? If they can, the model has failed and nothing built
 * on top of it is trustworthy.
 */

const SPEC: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'comments', type: 'integer' },
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'elapsed', type: 'duration', unit: 'ms' },
    { name: 'reviewer', type: 'ref', required: true },
  ],
};

const state = (input: { properties?: Record<string, unknown>; na?: string[] }, name: string) =>
  validateEntry(SPEC, input).states[name];

describe('the three states are three distinct things', () => {
  it('distinguishes a measured 0 from an explicit N/A from silence', () => {
    // The fold-corpus failure in one assertion. Three inputs that all meant the same
    // thing in the old corpus must now be three different answers.
    expect(state({ properties: { comments: 0 } }, 'comments')).toBe('measured');
    expect(state({ na: ['comments'] }, 'comments')).toBe('not_applicable');
    expect(state({}, 'comments')).toBe('not_measured');
  });

  it('keeps a measured 0 as a real value, not a coerced absence', () => {
    // `reviewer` is supplied because SPEC marks it required; leaving it out would make
    // this fail for an unrelated reason and hide what it is testing.
    const result = validateEntry(SPEC, {
      properties: { comments: 0 },
      na: ['reviewer'],
    });
    expect(result.ok).toBe(true);
    expect('comments' in result.properties).toBe(true);
    expect(result.properties['comments']).toBe(0);
  });

  it('never lets silence become zero', () => {
    const result = validateEntry(SPEC, {});
    expect('comments' in result.properties).toBe(false);
    expect(result.states['comments']).toBe('not_measured');
  });

  it('reports a state for EVERY declared property', () => {
    // So three-state ratios are computable straight off a validation result rather
    // than re-derived by every consumer that needs them.
    const result = validateEntry(SPEC, { properties: { comments: 1 }, na: ['elapsed'] });
    expect(Object.keys(result.states).sort()).toEqual(SPEC.properties.map((p) => p.name).sort());
    expect(result.states).toEqual({
      comments: 'measured',
      outcome: 'not_measured',
      elapsed: 'not_applicable',
      reviewer: 'not_measured',
    });
  });
});

describe('required means "must have a decision"', () => {
  it('accepts an explicit N/A as satisfying a required property', () => {
    // THE load-bearing case. If N/A did not satisfy `required`, a recorder with
    // nothing to say would be forced to invent a value -- exactly how the corpus
    // acquired its ambiguity.
    const result = validateEntry(SPEC, { na: ['reviewer'] });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.states['reviewer']).toBe('not_applicable');
  });

  it('rejects a required property that has no decision at all', () => {
    const result = validateEntry(SPEC, {});
    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.field === 'reviewer');
    expect(error?.problem).toContain('has no decision recorded');
  });

  it('names BOTH ways to satisfy a required property in the fix', () => {
    // Prescriptive: a fix that only offered a value would re-create the pressure this
    // rule exists to remove.
    const result = validateEntry(SPEC, {});
    const error = result.errors.find((e) => e.field === 'reviewer');
    expect(error?.fix).toMatch(/--prop=reviewer=/);
    expect(error?.fix).toMatch(/--na reviewer/);
  });

  it('does not require an optional property', () => {
    const result = validateEntry(SPEC, { na: ['reviewer'] });
    expect(result.ok).toBe(true);
    expect(result.states['outcome']).toBe('not_measured');
  });
});

describe('a property cannot be in two states at once', () => {
  it('rejects a property that is both measured and not applicable', () => {
    const result = validateEntry(SPEC, {
      properties: { comments: 3 },
      na: ['comments'],
    });
    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.field === 'comments');
    expect(error?.problem).toContain('both measured and listed as not applicable');
    expect(error?.fix).toContain('Choose one');
  });
});

describe('prescriptive errors', () => {
  it('names the accepted values for a bad enum value', () => {
    const result = validateEntry(SPEC, { properties: { outcome: 'maybe' } });
    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.field === 'outcome');
    expect(error?.fix).toContain('approved');
    expect(error?.fix).toContain('rejected');
  });

  it('gives a runnable corrected command for an enum', () => {
    // An enum is the one case where the spec names real values, so the example is a
    // command that would actually work -- not a placeholder.
    const result = validateEntry(SPEC, { properties: { outcome: 'maybe' } });
    expect(result.errors[0]?.fix).toContain('asc record review_completed --prop=outcome=approved');
  });

  it('does NOT invent a plausible-looking value for a numeric property', () => {
    // `--prop=comments=1` would be a fabricated measurement presented as advice.
    // A placeholder is the honest option.
    const result = validateEntry(SPEC, { properties: { comments: 'three' } });
    const error = result.errors.find((e) => e.field === 'comments');
    expect(error?.fix).toContain('--prop=comments=<integer>');
  });
});

describe('undeclared input', () => {
  it('strips an undeclared key and says so, rather than rejecting the entry', () => {
    // A stripped key is recoverable; a rejected entry is lost work.
    const result = validateEntry(SPEC, {
      properties: { comments: 1, surprise: true },
      na: ['reviewer'],
    });
    expect(result.ok).toBe(true);
    expect('surprise' in result.properties).toBe(false);
    expect(result.warnings.some((w) => w.field === 'surprise')).toBe(true);
  });

  it('drops an undeclared name from na and says so', () => {
    const result = validateEntry(SPEC, { na: ['reviewer', 'nonexistent'] });
    expect(result.ok).toBe(true);
    expect(result.na).toEqual(['reviewer']);
    expect(result.warnings.some((w) => w.field === 'nonexistent')).toBe(true);
  });

  it('reports a duplicate na rather than storing it twice', () => {
    const result = validateEntry(SPEC, { na: ['reviewer', 'reviewer'] });
    expect(result.na).toEqual(['reviewer']);
    expect(result.warnings.some((w) => w.problem.includes('more than once'))).toBe(true);
  });
});

describe('warnings never block, errors always do', () => {
  it('leaves ok true when only warnings are present', () => {
    const result = validateEntry(SPEC, { na: ['reviewer'], properties: { extra: 1 } });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('flags an entry where nothing applies, without refusing it', () => {
    const allNa = SPEC.properties.map((p) => p.name);
    const result = validateEntry(SPEC, { na: allNa });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.problem.includes('every property'))).toBe(true);
  });
});

describe('purity', () => {
  it('does not mutate the input it was given', () => {
    const properties = { comments: 1, surprise: true };
    const na = ['reviewer'];
    validateEntry(SPEC, { properties, na });
    expect(properties).toEqual({ comments: 1, surprise: true });
    expect(na).toEqual(['reviewer']);
  });
});

/**
 * A property name is a KEY, not a slot on `Object.prototype`.
 *
 * The defect this pins, measured before the fix: `properties` was an object literal, so
 * `'constructor' in properties` was true for an empty recording. A required property named
 * `constructor` therefore resolved to `measured` with nothing recorded for it, the entry
 * persisted with no value for a required property, and the correct repair
 * (`asc record <type> --na constructor`) was refused as "both measured and listed as not
 * applicable" -- so there was no way to record the truth either.
 *
 * The class is enumerated from `Object.prototype` rather than hard-coded, because the set of
 * names that can reach `validateEntry` is "`Object.prototype`'s members, filtered by what
 * `canonicalName` leaves alone", and that filter moves if the canonicalizer's renaming rules
 * change. A test that named `constructor` would keep passing while the class grew.
 */
describe('an inherited name is not a recorded value', () => {
  const INHERITED = Object.getOwnPropertyNames(Object.prototype).filter(
    (name) => canonicalName(name) === name,
  );

  const specFor = (name: string): TypeSpec => ({
    name: 'proto_probe',
    properties: [{ name, type: 'string', required: true }],
  });

  it('is not vacuous: at least one Object.prototype name survives canonicalization', () => {
    // A loop over an empty list passes without testing anything, and a test that cannot fail
    // is the exact failure mode this file exists to prevent.
    expect(INHERITED).toContain('constructor');
  });

  it.each(INHERITED)('reads an unrecorded `%s` as not_measured, not as measured', (name) => {
    const result = validateEntry(specFor(name), {});
    expect(result.states[name]).toBe('not_measured');
    // And because it is required with no decision, the recording is refused.
    expect(result.ok).toBe(false);
    expect(result.errors.map((issue) => issue.field)).toEqual([name]);
  });

  it.each(INHERITED)(
    'accepts an explicit N/A for `%s` instead of calling it a contradiction',
    (name) => {
      const result = validateEntry(specFor(name), { na: [name] });
      expect(result.states[name]).toBe('not_applicable');
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it.each(INHERITED)('stores a measured `%s` as a real own key', (name) => {
    const result = validateEntry(specFor(name), { properties: { [name]: 'v' } });
    expect(result.states[name]).toBe('measured');
    expect(Object.hasOwn(result.properties, name)).toBe(true);
    // The store's identity function for a recording: a value that vanishes here is a value
    // the ledger never holds, however green validation reported.
    expect(canonicalJson(result.properties)).toBe(`{"${name}":"v"}`);
  });

  it('stores a value under a name that is an inherited ACCESSOR, not a data property', () => {
    // The write half of the same defect, and the half no canonical name can reach:
    // `canonicalName('__proto__')` is 'proto', so this is not a spec the registry would ever
    // store -- but `validateEntry` is an exported pure function and its contract does not
    // require a canonical spec, so this is a legal call. On an object literal the assignment
    // below is swallowed by `Object.prototype`'s `__proto__` setter (a non-object is ignored)
    // and the value disappears with no error and no warning; on a null-prototype map it is an
    // ordinary key. This is the assertion that fails if the accumulator goes back to a
    // literal, which is why the three tests above (all discriminating on `Object.hasOwn`)
    // are not the whole fix.
    const result = validateEntry(
      { name: 'proto_write', properties: [{ name: '__proto__', type: 'string' }] },
      { properties: { ['__proto__']: 'v' } },
    );
    expect(result.states['__proto__']).toBe('measured');
    expect(canonicalJson(result.properties)).toBe('{"__proto__":"v"}');
  });
});
