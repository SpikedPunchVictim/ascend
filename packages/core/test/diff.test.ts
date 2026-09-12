import { describe, expect, it } from 'vitest';
import {
  CHANGE_KINDS,
  canonicalizeTypeSpec,
  definitionShape,
  diffTypeSpec,
  typeHash,
  type Bump,
  type ChangeKind,
  type TypeSpec,
} from '../src/index.js';

/**
 * The bump classification decides whether two shapes may be UNIONED into one view.
 * A change wrongly classified minor would union incompatible data and call it one
 * type -- fold's confound #1 (schema drifting under the data) rebuilt from scratch.
 *
 * So the central test is not "does it produce a bump" but: does every rule agree with
 * the single question the axis is built on -- *can an entry recorded against the old
 * definition still be read correctly under the new one?*
 */

const BASE: TypeSpec = {
  name: 'review_completed',
  description: 'a review finished',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'comments', type: 'integer' },
    { name: 'elapsed', type: 'duration', unit: 'ms' },
  ],
};

const withProps = (
  properties: TypeSpec['properties'],
  description = 'a review finished',
): TypeSpec => ({
  name: 'review_completed',
  properties,
  description,
});

/** BASE with `comments` marked required -- the starting point for `became_optional`. */
const BASE_REQUIRED: TypeSpec = withProps(
  BASE.properties.map((p) => (p.name === 'comments' ? { ...p, required: true } : p)),
);

const mapProps = (
  fn: (p: TypeSpec['properties'][number]) => TypeSpec['properties'][number],
): TypeSpec => withProps(BASE.properties.map(fn));

/**
 * One example per change kind, so no classification rule goes unexercised.
 *
 * `from` is per-case rather than always BASE, because a change kind is only really
 * exercised if the input actually contains the condition it detects -- `became_optional`
 * diffed against BASE (where the property is already optional) would silently exercise
 * `became_required` instead and still produce a plausible bump.
 */
const CASES: Record<ChangeKind, { from?: TypeSpec; to: TypeSpec; bump: Bump }> = {
  property_added: {
    to: withProps([...BASE.properties, { name: 'note', type: 'text' }]),
    bump: 'minor',
  },
  property_removed: {
    to: withProps(BASE.properties.filter((p) => p.name !== 'comments')),
    bump: 'major',
  },
  property_retyped: {
    to: mapProps((p) => (p.name === 'comments' ? { name: 'comments', type: 'string' } : p)),
    bump: 'major',
  },
  became_required: {
    to: BASE_REQUIRED,
    bump: 'major',
  },
  became_optional: {
    from: BASE_REQUIRED,
    to: BASE,
    bump: 'minor',
  },
  enum_value_added: {
    to: mapProps((p) =>
      p.name === 'outcome'
        ? { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected', 'withdrawn'] }
        : p,
    ),
    bump: 'minor',
  },
  enum_value_removed: {
    to: mapProps((p) =>
      p.name === 'outcome' ? { name: 'outcome', type: 'enum', enum_values: ['approved'] } : p,
    ),
    bump: 'major',
  },
  unit_changed: {
    to: mapProps((p) => (p.name === 'elapsed' ? { ...p, unit: 's' } : p)),
    bump: 'major',
  },
  metadata_changed: { to: withProps(BASE.properties, 'a review that finished'), bump: 'none' },
};

describe('change kind coverage', () => {
  it('exercises every change kind, with no gaps', () => {
    // Same anti-rot shape as the property type table: a kind that is added to the
    // vocabulary without a case here fails, rather than passing unexercised.
    expect(Object.keys(CASES).sort()).toEqual([...CHANGE_KINDS].sort());
  });

  it.each(Object.keys(CASES) as ChangeKind[])('classifies %s as expected', (kind) => {
    const { from, to, bump: expected } = CASES[kind];
    const result = diffTypeSpec(from ?? BASE, to);

    expect(result.bump, `${kind} should be a ${expected} bump`).toBe(expected);
    // The kind must actually be REPORTED, not merely produce a bump that happens to
    // match. Without this, a case whose `from` does not contain the condition it means
    // to test still passes -- which is how the first draft of this table shipped a
    // `became_optional` row that really exercised `became_required`.
    expect(
      result.changes.map((c) => c.kind),
      `${kind} was never reported`,
    ).toContain(kind);
  });
});

describe('no bump: the same definition written differently', () => {
  it('reports nothing for an identical spec', () => {
    const { bump, changes } = diffTypeSpec(BASE, BASE);
    expect(bump).toBe('none');
    expect(changes).toEqual([]);
  });

  it('reports nothing when only the NAMES differ in spelling', () => {
    // The payoff of canonicalizing before diffing. These are one definition; treating
    // the second spelling as a new version is exactly the drift EV-drift measured.
    const snake = withProps([
      { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
      { name: 'comments', type: 'integer' },
      { name: 'elapsed', type: 'duration', unit: 'ms' },
    ]);
    const camel = {
      name: 'reviewCompleted',
      properties: [
        { name: 'comments', type: 'integer' },
        { name: 'outcome', type: 'enum', enum_values: ['rejected', 'approved'] },
        { name: 'elapsed', type: 'duration', unit: 'ms' },
      ],
    } satisfies TypeSpec;
    expect(diffTypeSpec(snake, camel).bump).toBe('none');
  });
});

describe('minor: backward compatible, so views union across it', () => {
  it('classifies an added optional property as minor and says why', () => {
    const { bump, changes } = diffTypeSpec(BASE, CASES.property_added.to);
    expect(bump).toBe('minor');
    const change = changes.find((c) => c.kind === 'property_added');
    // The reason it is safe: old entries read as 'not measured', which is the default
    // state rather than an error.
    expect(change?.detail).toContain('not measured');
  });

  it('classifies becoming optional as minor', () => {
    const required = withProps(BASE.properties.map((p) => ({ ...p, required: true })));
    const { bump } = diffTypeSpec(required, BASE);
    expect(bump).toBe('minor');
  });
});

describe('major: not unioned, because old rows are a different shape', () => {
  it('classifies an added REQUIRED property as major, not minor', () => {
    // The subtle one: it is an addition, like the minor case, but entries recorded
    // before it have no decision for the new property, so it cannot be unioned.
    const to = withProps([
      ...BASE.properties,
      { name: 'severity', type: 'integer', required: true },
    ]);
    const { bump, changes } = diffTypeSpec(BASE, to);
    expect(bump).toBe('major');
    expect(changes.find((c) => c.kind === 'property_added')?.detail).toContain('no decision');
  });

  it('explains that a retype REINTERPRETS stored values rather than converting them', () => {
    const to = withProps(
      BASE.properties.map((p) => (p.name === 'elapsed' ? { name: 'elapsed', type: 'number' } : p)),
    );
    const { bump, changes } = diffTypeSpec(BASE, to);
    expect(bump).toBe('major');
    expect(changes.find((c) => c.kind === 'property_retyped')?.detail).toContain('reinterpreted');
  });

  it('treats a unit change as major, since the magnitude still reads but means something else', () => {
    // 250 under `ms` and 250 under `s` are the same number and different facts. This is
    // the most dangerous change in the table because nothing about the stored data
    // looks wrong afterwards.
    const { bump, changes } = diffTypeSpec(BASE, CASES.unit_changed.to);
    expect(bump).toBe('major');
    expect(changes.find((c) => c.kind === 'unit_changed')?.detail).toContain('mean something else');
  });
});

describe('the worst change wins', () => {
  it('reports major when a minor change rides along with a major one', () => {
    const to = withProps([
      { name: 'outcome', type: 'string' },
      { name: 'comments', type: 'integer' },
      { name: 'elapsed', type: 'duration', unit: 'ms' },
      { name: 'note', type: 'text' },
    ]);
    const { bump, changes } = diffTypeSpec(BASE, to);
    expect(bump).toBe('major');
    // Every change is listed, not just the worst -- the bump is the summary, and a
    // caller showing the user "what changed" needs all of them.
    //
    // Two `enum_value_removed` entries, not one: each lost value is its own fact, and
    // `outcome` going enum->string drops both. Reporting one per value rather than
    // one per property is deliberate -- a collapsed entry would have to name a set,
    // and the caller could no longer tell which values are gone without parsing prose.
    expect(changes.map((c) => c.kind).sort()).toEqual([
      'enum_value_removed',
      'enum_value_removed',
      'property_added',
      'property_retyped',
    ]);
    expect(changes.filter((c) => c.kind === 'enum_value_removed').map((c) => c.subject)).toEqual([
      'outcome',
      'outcome',
    ]);
  });
});

describe('refuses to diff two different types', () => {
  it('throws rather than reporting a bump between unrelated names', () => {
    // A bump between two type names would create a version row belonging to the wrong
    // type. Better to fail loudly than to invent a relationship.
    expect(() => diffTypeSpec(BASE, { ...BASE, name: 'review_started' })).toThrow(
      /different type names/,
    );
  });
});

describe('no shape difference escapes classification', () => {
  /**
   * The invariant the registry depends on: if two definitions project to different
   * SHAPES, their hashes differ, so `diffTypeSpec` MUST report something. A shape
   * difference it stays silent about would force the registry to mint a version with
   * no change to justify it -- and, worse, would be a diff that reports "nothing
   * changed" about two things that are not the same.
   *
   * This is checked by enumeration rather than by argument, because the failure mode
   * is a field one of the two functions knows about and the other does not.
   */
  const VARIATIONS: Record<string, Record<string, unknown>[]> = {
    'property name': [
      { name: 'x', type: 'integer' },
      { name: 'y', type: 'integer' },
    ],
    'property type': [
      { name: 'x', type: 'integer' },
      { name: 'x', type: 'number' },
      { name: 'x', type: 'duration' },
      { name: 'x', type: 'string' },
      { name: 'x', type: 'text' },
      { name: 'x', type: 'boolean' },
      { name: 'x', type: 'timestamp' },
      { name: 'x', type: 'ref' },
    ],
    required: [
      { name: 'x', type: 'integer' },
      { name: 'x', type: 'integer', required: true },
      { name: 'x', type: 'integer', required: false },
    ],
    'enum values': [
      { name: 'x', type: 'enum', enum_values: ['a'] },
      { name: 'x', type: 'enum', enum_values: ['a', 'b'] },
      { name: 'x', type: 'enum', enum_values: ['b'] },
      { name: 'x', type: 'enum', enum_values: ['a', 'b', 'c'] },
    ],
    unit: [
      { name: 'x', type: 'integer' },
      { name: 'x', type: 'integer', unit: 'ms' },
      { name: 'x', type: 'integer', unit: 's' },
      { name: 'x', type: 'duration', unit: 'ms' },
      { name: 'x', type: 'duration' },
    ],
    presence: [{ name: 'x', type: 'integer' }],
  };

  it('reports a bump for every pair whose shape differs', () => {
    let compared = 0;
    for (const [label, variants] of Object.entries(VARIATIONS)) {
      // `presence` is paired against a differently-shaped spec, not against itself.
      const pool = label === 'presence' ? [...variants, { name: 'z', type: 'text' }] : variants;
      for (const a of pool) {
        for (const b of pool) {
          const specA = canonicalizeTypeSpec({
            name: 't',
            properties:
              label === 'property name' && a !== b ? [a as never, b as never] : [a as never],
          }).spec;
          const specB = canonicalizeTypeSpec({ name: 't', properties: [b as never] }).spec;

          const shapeA = definitionShape(specA);
          const shapeB = definitionShape(specB);
          const shapesDiffer = typeHash(shapeA) !== typeHash(shapeB);
          if (!shapesDiffer) continue;

          compared += 1;
          const diff = diffTypeSpec(specA, specB);
          expect(
            diff.bump,
            `${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)} hashes differently ` +
              `but diff reported ${diff.bump} with changes ${JSON.stringify(diff.changes.map((c) => c.kind))}`,
          ).not.toBe('none');
        }
      }
    }
    // The enumeration must actually compare something; a loop over an empty pool
    // would pass silently while proving nothing.
    expect(compared).toBeGreaterThan(50);
  });
});
