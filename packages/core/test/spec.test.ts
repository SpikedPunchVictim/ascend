import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  canonicalizeProperty,
  canonicalizeTypeSpec,
  definitionShape,
  emptyPropertyName,
  ENVELOPE_PROPERTY_NAMES,
  reservedPropertyName,
  STATE_COLUMN_SUFFIX,
  unaddressablePropertyName,
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

describe('a unit that is not in canonical form is REFUSED, not rewritten', () => {
  // asc-bcv.18 (F7), and the counterpart to the block above. Those fields can be normalized
  // because `definitionShape` drops or folds them; `unit` on a bearing type is KEPT, so its
  // spelling is inside `type_hash` and there is no rewrite available. Trimming would change the
  // canonical form, which is the hash input -- so a definition already stored as `' ms '` would
  // hash differently the next time the same document was submitted and the store would mint the
  // very MAJOR version this rule exists to prevent. Refusing cannot change a hash already
  // computed, which is why this is an error and not a normalization.

  const errorsFor = (unit: string, type = 'duration'): readonly string[] =>
    canonicalizeProperty({ name: 'elapsed', type: type as never, unit }).errors;

  it('refuses surrounding whitespace, naming both spellings and the one to write', () => {
    const errors = errorsFor(' ms ');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unit ' ms '");
    expect(errors[0]).toContain("' ms ' and 'ms' are two definitions");
    expect(errors[0]).toContain("Write it as 'ms'");
  });

  it('refuses leading and trailing whitespace each on its own, not only both at once', () => {
    // Asserted separately because a `trimStart`-only or `trimEnd`-only rule passes a test built
    // from `' ms '` alone -- both ends move, so either half-trim still sees a difference. The two
    // one-sided spellings are what make each half observable.
    for (const unit of [' ms', 'ms ', '\tms', 'ms\n']) {
      expect(errorsFor(unit)).toHaveLength(1);
    }
  });

  it('refuses a unit that names no unit, whether empty or only whitespace', () => {
    // `''` and `'  '` are one problem stated twice: both name no unit, and an absent unit names
    // no unit too -- so all three spellings of the same meaning must not be three definitions.
    for (const unit of ['', '   ', '\t']) {
      const errors = errorsFor(unit);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('names no unit');
      expect(errors[0]).toContain('Omit the field');
    }
  });

  it('covers the whole ECMAScript whitespace set, not just the ASCII space', () => {
    // Measured before it was asserted: 16 of the 23 characters a reader might call invisible are
    // whitespace by the ECMAScript definition, and `trim()` removes exactly those. The other
    // seven (ZWSP, ZWNJ, ZWJ, soft hyphen, word joiner, Mongolian vowel separator, combining
    // grapheme joiner) are NOT refused -- that is a rule about invisible characters rather than
    // about whitespace, and ZWJ and ZWNJ are orthographically meaningful in Persian, Arabic and
    // Indic scripts, so refusing them would refuse a correctly written unit.
    for (const code of [
      0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
      0xfeff,
    ]) {
      expect(errorsFor(`ms${String.fromCodePoint(code)}`)).toHaveLength(1);
    }
    for (const code of [0x200b, 0x200c, 0x200d, 0x00ad, 0x2060, 0x180e, 0x034f]) {
      expect(errorsFor(`ms${String.fromCodePoint(code)}`)).toEqual([]);
    }
  });

  it('refuses NOTHING else, because a false refusal here is the same size of defect', () => {
    // Every one of these is a unit someone could have meant. Internal whitespace is the
    // interesting one: 'flight hours' is a unit, and the defect is whitespace at the EDGES.
    for (const unit of ['ms', 's', 'flight hours', 'µm', 'km/h', 'req/s', 'MB']) {
      expect(errorsFor(unit)).toEqual([]);
    }
  });

  it('leaves a whitespace unit on a NON-bearing type alone, where it is dropped anyway', () => {
    // The gate is not `unit !== canonical`; it is "the field is inside the hash". Measured: a
    // `string` with `unit: ' ms '` and one with no unit hash EQUAL, because `definitionShape`
    // drops the field. The warning above is the whole finding there, and refusing the spelling of
    // a field the store is about to discard would be a refusal with nothing behind it.
    const { errors, warnings } = canonicalizeProperty({
      name: 'elapsed',
      type: 'string',
      unit: ' ms ',
    });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('has a unit'))).toBe(true);
  });

  it('refuses exactly where definitionShape keeps the field, so guard and hash agree', () => {
    // The invariant the rule rests on, asserted rather than assumed. `unit` has ONE canonical
    // form -- non-empty and equal to its own trim -- and "names no unit" has exactly one spelling:
    // omitting the field. So the rule is `refused iff the field reaches the hash AND the spelling
    // is not canonical`. A guard firing wider would refuse a definition the store hashes
    // identically either way; one firing narrower would leave a hashed field unguarded, which is
    // the defect itself.
    const canonicalUnit = (unit: string): boolean => unit !== '' && unit === unit.trim();
    const reachesTheHash = (property: Record<string, unknown>): boolean => {
      const shape = definitionShape({ name: 't', properties: [property as never] });
      return 'unit' in (shape.properties[0] as object);
    };

    const mismatches: string[] = [];
    for (const type of ['duration', 'integer', 'number', 'string', 'text', 'boolean']) {
      for (const unit of ['ms', ' ms ', '', '  ', 'flight hours']) {
        const property = { name: 'x', type, unit };
        const refused = canonicalizeProperty(property as never).errors.length > 0;
        const expected = reachesTheHash(property) && !canonicalUnit(unit);
        if (refused !== expected) {
          mismatches.push(
            `${type} ${JSON.stringify(unit)}: refused=${String(refused)} expected=${String(expected)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('a property name the view can address by JSON path', () => {
  // asc-bcv.16 (F5). A view projects `json_extract(properties_json, '$.<name>')`, so a name that
  // is not ONE path segment addresses something else and the column reads NULL while the value sits
  // in the row. The predicate below is not read off the JSON path grammar: every code point in
  // Unicode was probed in four positions against a real SQLite, 4,448,256 probes, and exactly 12
  // failed. These are those 12, plus the names that measured SAFE -- the second half matters as
  // much as the first, because a guard that refuses a name which projects faithfully is the same
  // defect as one that passes a name which does not.
  const NUL = String.fromCharCode(0);

  const refused = (name: string): string => {
    const problem = unaddressablePropertyName(name);
    if (problem === undefined) throw new Error(`expected '${name}' to be refused`);
    return problem.reason;
  };

  it('refuses a dot anywhere, because the path descends into a nested object', () => {
    for (const name of ['a.b', '.ab', 'ab.', '.']) {
      expect(unaddressablePropertyName(name), name).toBeDefined();
    }
    expect(refused('a.b')).toContain('path separator');
  });

  it('refuses a bracket anywhere, because it begins a subscript', () => {
    for (const name of ['a[b', '[ab', 'ab[', '[']) {
      expect(unaddressablePropertyName(name), name).toBeDefined();
    }
  });

  it('refuses a quote only at the START, where it opens a key the path never closes', () => {
    // The POSITION is the finding. A leading quote opens a quoted key the path never closes and was
    // measured failing; a quote in the middle was measured returning its literal key, so refusing
    // it would be a false refusal.
    for (const name of ['"ab', '"']) expect(unaddressablePropertyName(name), name).toBeDefined();
    expect(unaddressablePropertyName('a"b')).toBeUndefined();
  });

  it('refuses a NUL ANYWHERE, because it breaks the statement rather than the path', () => {
    // asc-bcv.22 (F11). THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE for `a\0b`, and the assertion is
    // changed deliberately rather than deleted -- the same way F5's over-refusal proposal was
    // refuted by measurement, this is an under-refusal refuted the same way.
    //
    // The original entry read `anywhere: false` because `$.a\0b` was measured ADDRESSING its
    // literal key. That measurement is still correct and it is about the wrong thing: it passed the
    // path to `json_extract` as a bound VALUE. The generator INTERPOLATES it (`literal()` escapes
    // `'` and nothing else), so the SQL parser stops at the NUL and the statement is truncated
    // mid-literal. Measured through both generated-statement paths, one variable each:
    //   refreshTypeViews(db, '<clean type>') with property `a\0b`
    //     -> unrecognized token: ""idx_entries_nulprop_a"
    //   unionEntries(db, '<clean type>', ...) with the same property
    //     -> unrecognized token: "'$.a"
    // Both are hard errors naming neither the property nor the store. A name that cannot be carried
    // into a statement is unaddressable, whichever half of the trip it dies on.
    for (const name of [`${NUL}ab`, NUL, `a${NUL}b`, `ab${NUL}`]) {
      expect(unaddressablePropertyName(name), JSON.stringify(name)).toBeDefined();
    }
    expect(unaddressablePropertyName(`a${NUL}b`)?.reason).toContain('SQL statement text');
  });

  it('refuses an unpaired surrogate, and NOT a well-formed pair', () => {
    // The pair is the boundary: two UTF-16 units, one code point, so a scan by unit would report
    // every emoji. Measured: a lone surrogate leaves its key in the JSON -- `json_valid` still
    // returns 1 and a sibling property still reads -- but the path cannot carry the code unit.
    expect(unaddressablePropertyName('a\uD800b')).toBeDefined();
    expect(unaddressablePropertyName('a\uDFFFb')).toBeDefined();
    expect(unaddressablePropertyName('\uD800')).toBeDefined();

    expect(unaddressablePropertyName('a\u{1F600}b')).toBeUndefined();
    expect(unaddressablePropertyName('\u{1F600}')).toBeUndefined();
  });

  it('passes every character that measured addressing its own key', () => {
    // The over-refusal guard, and the reason this list is here rather than implied: the report
    // that found F5 suggested refusing a quote and a lone dollar sign. Both were measured working
    // -- `$.a"b` returns the key `a"b`, and it does so UNAMBIGUOUSLY even when a key `ab` is also
    // present in the same document.
    for (const name of [
      'reviewKind',
      'review_kind',
      'round-count',
      'a b',
      'a]b',
      'a$b',
      '123',
      'a*b',
      "a'b",
      'a?b',
      'café',
      '中文',
    ]) {
      expect(unaddressablePropertyName(name), name).toBeUndefined();
    }
  });

  it('offers the canonical folding, which is addressable by construction', () => {
    // Two spellings of the same defect fold to the same fix, and the folding is what makes the
    // suggestion safe: canonical names are `[a-z0-9_]` only, and no character of that set is
    // structural in a JSON path.
    expect(unaddressablePropertyName('a.b')?.suggestion).toBe('a_b');
    expect(unaddressablePropertyName('"ab')?.suggestion).toBe('ab');
    expect(unaddressablePropertyName('a\uD800b')?.suggestion).toBe('a_b');
  });

  it('reports the name AS WRITTEN, because that is the string the view interpolates', () => {
    // The one place this differs from `reservedPropertyName`, which canonicalizes first. Folding
    // here would HIDE the defect: `canonicalName('a.b')` is `'a_b'`, which is addressable, so a
    // check on the folded name would report every dotted name as fine.
    expect(unaddressablePropertyName('a.b')?.name).toBe('a.b');
    expect(unaddressablePropertyName('a.b')?.name).not.toBe(canonicalName('a.b'));
  });

  it('has a suggestion even for a name that folds away to nothing', () => {
    // `canonicalName('.')` is empty, and a suggestion of '' would print as `Rename it -- ''`.
    expect(unaddressablePropertyName('.')?.suggestion).toBe('value');
  });

  it('passes the names the registry already guarantees, so it never fires on normal use', () => {
    // This guard is the SECOND line -- every name `registerType` stores is canonical and therefore
    // addressable -- so a spec built through the registry never reaches it. Asserted rather than
    // assumed, because a guard that fires on ordinary documents would be a regression, not a catch.
    const spec = canonicalizeTypeSpec({
      name: 'review',
      properties: [
        { name: 'reviewKind', type: 'string' },
        { name: 'round-count', type: 'integer' },
      ],
    }).spec;
    for (const property of spec.properties) {
      expect(unaddressablePropertyName(property.name), property.name).toBeUndefined();
    }
  });
});

describe('a property name with no characters at all', () => {
  // `asc-0w9`, on this second line (`asc-bcv.21`). The rule above asks what is IN a name; this one
  // asks whether there is a name. They are separate predicates because they are about different
  // strings and refuse different sets -- see the overlap test below -- and the split is deliberate
  // rather than an oversight of the character scan.
  //
  // It is not a milder case of the rule above. A dotted name projects a path that reads NULL and
  // lets the statement run, so the consequence is a wrong NUMBER; `$.` is not a path, SQLite
  // REJECTS it, and because the index sits on `entries` rather than on one type it is evaluated for
  // EVERY insert -- measured end to end through the real CLI: one hand-inserted version declaring
  // `''` plus a clean sibling version made `asc types define` exit 0 and create
  // `idx_entries_byhand_ ON entries (type_name, json_extract(properties_json, '$.'))`, after which
  // `asc record review_completed --prop verdict=approved` -- a different, healthy type -- exited 1
  // with `bad JSON path: '$.'`. Dropping that one index made it exit 0 again.

  const NUL = String.fromCharCode(0);

  it('refuses the empty name, which is the only name whose path is not a path', () => {
    expect(emptyPropertyName('')).toBeDefined();
    expect(emptyPropertyName('')?.reason).toContain('`$.`');
    // The reason has to name the whole blast radius, because it is the surprising part: this
    // property is not the one that stops working first.
    expect(emptyPropertyName('')?.reason).toContain('every insert fails');
  });

  it('reports the name as written, with a suggestion that is itself a name', () => {
    // `reservedPropertyName` folds before answering; this one must not, for the same reason the
    // rule above must not: the view interpolates the RAW name. And the suggestion cannot be the
    // canonical folding, which for `''` is `''` -- an empty string would print as `Rename it -- ''`.
    expect(emptyPropertyName('')?.name).toBe('');
    expect(emptyPropertyName('')?.suggestion).toBe('value');
  });

  it('refuses NOTHING else -- including the names that fold away and still address their key', () => {
    // THE over-refusal boundary, and the reason this predicate is `raw === ''` rather than
    // `canonicalName(raw) === ''`. 25 of 31 probed names fold to the empty string, and 24 of them
    // were measured addressing their literal key correctly against a real SQLite -- `$.<name>`
    // returns the value stored under `<name>`. A predicate on the FOLD would refuse every one of
    // them, which is the same defect as passing `a.b`.
    //
    // `.`, `"`, `[` and NUL are in this list because THIS rule must not refuse them -- the rule
    // above does, each for its own reason, and a reader should not mistake this test for a claim
    // that they are safe. Several of these fold away when canonicalized, which is the whole point.
    for (const name of [
      '.',
      '..',
      '...',
      '-',
      '_',
      ' ',
      '  ',
      NUL,
      '"',
      "'",
      '\\',
      '/',
      ',',
      ';',
      ':',
      '*',
      '!',
      '?',
      '#',
      '%',
      '&',
      '(',
      ')',
      '+',
      '=',
      '@',
      '|',
      '~',
      '^',
      '$',
      '[',
      ']',
      '{',
      '}',
      '\t',
      '中文',
    ]) {
      expect(emptyPropertyName(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it('never overlaps the character rule, so the pair covers a name for every reason at once', () => {
    // Asserted because both guards run on every property and the comment beside them says they
    // cannot both report. `''` has no character for a scan to find, so only this rule can fire; a
    // name with a character in it is never empty, so only the other can. If a future rule breaks
    // that, the pair still reports BOTH (there is no `continue` between them) -- but this claim is
    // what makes the current shape correct rather than merely harmless.
    for (const name of ['', '.', 'a.b', '"', 'ab', '-', ' ', '中文', `a${NUL}b`]) {
      const empty = emptyPropertyName(name) !== undefined;
      const unaddressable = unaddressablePropertyName(name) !== undefined;
      expect(empty && unaddressable, JSON.stringify(name)).toBe(false);
    }
  });
});
