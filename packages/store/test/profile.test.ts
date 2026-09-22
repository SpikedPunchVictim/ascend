import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openStore,
  profileType,
  recordEntry,
  registerType,
  type RecordContext,
  type StateCounts,
  type Store,
  typeVersions,
} from '../src/index.js';

/**
 * `profileType` -- the map `asc explore` prints by default.
 *
 * The tests are grouped by the decision each one protects, because the failure this module can
 * have is not a crash: it is a profile that reads plausibly and answers a different question than
 * the one asked. Three are worth reading closely.
 *
 *   1. **An unregistered type and an empty type are different answers.** `undefined` vs a profile
 *      of zeros. A census that returned zeros for a name nobody registered would report "you have
 *      recorded nothing" to someone who is simply in the wrong project.
 *   2. **`not_declared` is not `not_measured`.** A property added in version 2 has no value in a
 *      version-1 entry, and that is a fact about the DEFINITION, not about the recording. Collapse
 *      the two and a corpus reports a property as unmeasured that could not have been measured.
 *   3. **`0` is a measurement.** The three-state model's whole point; a state tally that lost it
 *      would put a measured zero in the same bucket as an absent value.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-profile-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

/**
 * One property of each summary shape, so every branch of `summaryFor` is reachable from a
 * fixture and the "which summary" assertions are not passing for want of a case.
 */
const SPEC: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'reviewer', type: 'string' },
    { name: 'findings', type: 'integer' },
    { name: 'notes', type: 'text' },
    { name: 'labels', type: 'json' },
    { name: 'at', type: 'timestamp' },
  ],
};

const context = (id: string, overrides: Partial<RecordContext> = {}): RecordContext => ({
  id,
  recordedAt: AT,
  ascendVersion: '0.0.0',
  ...overrides,
});

/** A store with `spec` registered, and whatever `body` records into it. */
const withStore = <T>(body: (store: Store) => T, specs: readonly TypeSpec[] = [SPEC]): T => {
  const store = openStore({ dir: tempDir() });
  try {
    for (const spec of specs) registerType(store.db, spec, { registeredAt: AT });
    return body(store);
  } finally {
    store.close();
  }
};

const statesOf = (counts: StateCounts): string =>
  `measured=${String(counts.measured)} na=${String(counts.not_applicable)} ` +
  `nm=${String(counts.not_measured)} nd=${String(counts.not_declared)}`;

describe('profileType: an unknown name is not an empty type', () => {
  it('returns undefined for a type nobody registered', () => {
    withStore((store) => {
      expect(profileType(store.db, 'never_defined')).toBeUndefined();
    });
  });

  it('returns a real, all-zero profile for a registered type with no entries', () => {
    withStore((store) => {
      const profile = profileType(store.db, SPEC.name);

      // The distinction this test exists for: not `undefined`, and every number a MEASURED zero.
      expect(profile).toBeDefined();
      expect(profile?.count).toBe(0);
      expect(profile?.recordedAtMin).toBeNull();
      expect(profile?.recordedAtMax).toBeNull();
      // Every declared property is present, in the order the STORE holds them -- `canonicalizeType`
      // sorts a type's properties by name (`spec.ts`), so the order here is the registered
      // definition's and not this fixture's. Read back rather than retyped, so the assertion is
      // about the profile carrying the definition through and not about the sort rule.
      expect(profile?.properties.map((property) => property.name)).toStrictEqual(
        typeVersions(store.db, SPEC.name)[0]?.spec.properties.map((property) => property.name),
      );
      expect(profile?.properties).toHaveLength(SPEC.properties.length);
      for (const property of profile?.properties ?? []) {
        expect(statesOf(property.states)).toBe('measured=0 na=0 nm=0 nd=0');
        expect(property.distinct).toBe(0);
        expect(property.top).toStrictEqual([]);
        expect(property.min).toBeNull();
        expect(property.max).toBeNull();
      }
    });
  });

  it('resolves a type under any spelling that canonicalizes to the registered one (asc-pw2)', () => {
    // Before this fix, `typeVersions` (called first, to build the empty-profile shell) had
    // already been canonicalized, so a non-canonical spelling looked like an unregistered type
    // here too -- not the worse, silent failure this fix specifically targets (see the
    // `profile.ts` doc comment), but still the wrong half of the "unknown vs empty" distinction
    // this describe block exists to protect.
    const camelSpec: TypeSpec = { name: 'reviewKind', properties: [{ name: 'v', type: 'string' }] };
    withStore(
      (store) => {
        const byRaw = profileType(store.db, 'reviewKind');
        const byCanonical = profileType(store.db, 'review_kind');
        const byOtherSpelling = profileType(store.db, 'REVIEW-KIND');

        expect(byRaw).toBeDefined();
        expect(byRaw?.type).toBe('review_kind');
        expect(byCanonical).toStrictEqual(byRaw);
        expect(byOtherSpelling).toStrictEqual(byRaw);
      },
      [camelSpec],
    );
  });
});

describe('profileType: the state tally', () => {
  /**
   * One entry per state, and the `0` case is the one that matters.
   *
   * `findings = 0` is a MEASUREMENT -- "I looked and there were none" -- and the tally has to count
   * it as measured. This is `TASKS.md` #7's rule from the reading side: a profile that dropped it
   * would make zero findings indistinguishable from a property nobody looked at, which is exactly
   * the distinction the store was built to keep.
   */
  it('counts a measured zero as measured, and does not confuse the three states', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { findings: 0 } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, na: ['findings'] }, context('e2'));
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e3'));

      const profile = profileType(store.db, SPEC.name);
      const findings = profile?.properties.find((property) => property.name === 'findings');

      expect(statesOf(findings?.states as StateCounts)).toBe('measured=1 na=1 nm=1 nd=0');
      // A measured zero is a value, so it is the range and it is one distinct value.
      expect(findings?.min).toBe(0);
      expect(findings?.max).toBe(0);
      expect(findings?.distinct).toBe(1);
    });
  });

  it('distinguishes not_declared from not_measured across versions', () => {
    const v2: TypeSpec = {
      name: SPEC.name,
      properties: [...SPEC.properties, { name: 'added_later', type: 'string' }],
    };

    const store = openStore({ dir: tempDir() });
    try {
      // Version 1 first, and the entry recorded against it BEFORE version 2 exists -- otherwise
      // `recordEntry` selects the latest version and the entry would declare `added_later`,
      // making the case this test is about unreachable.
      registerType(store.db, SPEC, { registeredAt: AT });
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e1'));
      registerType(store.db, v2, { registeredAt: AT });

      const profile = profileType(store.db, SPEC.name);
      const added = profile?.properties.find((property) => property.name === 'added_later');

      // Not `not_measured`: the version-1 definition had no such property, so there was no
      // decision available to record. Collapsing this to `not_measured` would report a property
      // as unmeasured that could not have been measured.
      expect(statesOf(added?.states as StateCounts)).toBe('measured=0 na=0 nm=0 nd=1');
      expect(added?.declaringVersions).toStrictEqual([2]);
      // And the version-1 property is declared by both versions, so it has no `not_declared` rows.
      const outcome = profile?.properties.find((property) => property.name === 'outcome');
      expect(statesOf(outcome?.states as StateCounts)).toBe('measured=0 na=0 nm=1 nd=0');
    } finally {
      store.close();
    }
  });
});

describe('profileType: the summary a declared type earns', () => {
  it('reports top values for a categorical property, ordered by count then value', () => {
    withStore((store) => {
      const values = ['approved', 'approved', 'rejected', 'approved', 'rejected', 'approved'];
      values.forEach((outcome, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { outcome } },
          context(`e${String(index)}`),
        );
      });

      const profile = profileType(store.db, SPEC.name);
      const outcome = profile?.properties.find((property) => property.name === 'outcome');

      expect(outcome?.summary).toBe('top');
      expect(outcome?.distinct).toBe(2);
      expect(outcome?.top).toStrictEqual([
        { value: 'approved', count: 4 },
        { value: 'rejected', count: 2 },
      ]);
      // A `top` property has no range: reporting one would suggest the values are ordered.
      expect(outcome?.min).toBeNull();
      expect(outcome?.max).toBeNull();
    });
  });

  /**
   * The tiebreak is part of the contract, so it is asserted on a tie.
   *
   * Counts alone do not make an order total: `amy` and `zoe` occur once each, and a reader that
   * got them in different orders on two runs over one store would have two profiles that disagree.
   * The documented rule is ascending by value, and this is the assertion that pins its DIRECTION --
   * a mutation to `value DESC` returns `zoe` first and fails here.
   */
  it('breaks a count tie by ascending value, so the order is total', () => {
    withStore((store) => {
      ['zoe', 'amy'].forEach((reviewer, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer } },
          context(`e${String(index)}`),
        );
      });

      const profile = profileType(store.db, SPEC.name);
      const reviewer = profile?.properties.find((property) => property.name === 'reviewer');

      expect(reviewer?.top).toStrictEqual([
        { value: 'amy', count: 1 },
        { value: 'zoe', count: 1 },
      ]);
    });
  });

  /**
   * `distinct` is what makes the top-K's withholding visible, so it is asserted at the one place
   * the two numbers can disagree: when there are more distinct values than the K.
   */
  it('reports the full distinct count even when the top-K is truncated', () => {
    withStore((store) => {
      ['a', 'b', 'c', 'd', 'e'].forEach((reviewer, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { reviewer } },
          context(`e${String(index)}`),
        );
      });

      const profile = profileType(store.db, SPEC.name, { topK: 2 });
      const reviewer = profile?.properties.find((property) => property.name === 'reviewer');

      expect(reviewer?.top).toHaveLength(2);
      // Five values were counted and two were reported. Without this number a reader could not
      // tell a K of 2 from a property that holds only two values.
      expect(reviewer?.distinct).toBe(5);
    });
  });

  it('reports min and max for a numeric property and nothing else', () => {
    withStore((store) => {
      [7, 2, 9].forEach((findings, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { findings } },
          context(`e${String(index)}`),
        );
      });

      const profile = profileType(store.db, SPEC.name);
      const findings = profile?.properties.find((property) => property.name === 'findings');

      expect(findings?.summary).toBe('range');
      expect(findings?.min).toBe(2);
      expect(findings?.max).toBe(9);
      // Numbers are distinct by nature; a top-K here would be three singletons.
      expect(findings?.top).toStrictEqual([]);
      expect(findings?.distinct).toBe(3);
    });
  });

  it('reports min and max for a timestamp, where lexicographic order is chronological', () => {
    withStore((store) => {
      ['2026-09-11T12:00:00.000Z', '2026-09-11T09:00:00.000Z'].forEach((at, index) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { at } },
          context(`e${String(index)}`),
        );
      });

      const profile = profileType(store.db, SPEC.name);
      const at = profile?.properties.find((property) => property.name === 'at');

      expect(at?.summary).toBe('range');
      expect(at?.min).toBe('2026-09-11T09:00:00.000Z');
      expect(at?.max).toBe('2026-09-11T12:00:00.000Z');
    });
  });

  /**
   * Prose and compound values get a cardinality and no values at all.
   *
   * This is the assertion that keeps user content out of a caller's context: a profile of a
   * corpus full of prose returns none of it. A `cardinality` property that returned a top-K would
   * be returning near-duplicate prose, ranked.
   */
  it('reports only a distinct count for text and json -- no values, no range', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { notes: 'a long note', labels: ['x'] } },
        context('e1'),
      );
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { notes: 'another', labels: ['x', 'y'] } },
        context('e2'),
      );

      const profile = profileType(store.db, SPEC.name);
      for (const name of ['notes', 'labels']) {
        const property = profile?.properties.find((candidate) => candidate.name === name);
        expect(property?.summary).toBe('cardinality');
        expect(property?.distinct).toBe(2);
        expect(property?.top).toStrictEqual([]);
        expect(property?.min).toBeNull();
        expect(property?.max).toBeNull();
      }
    });
  });
});

describe('profileType: the envelope around the properties', () => {
  it('reports the total, the per-version tally and the recorded_at range', () => {
    // A MAJOR bump, not a minor one: dropping a property is a major change (`diff.ts`), so this
    // fixture is two major FAMILIES -- which is the case a per-version `major` field exists to
    // report, and which a fixture that only ever added a property could not reach.
    const v2: TypeSpec = {
      name: SPEC.name,
      properties: SPEC.properties.filter((property) => property.name !== 'labels'),
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { outcome: 'approved' } },
        context('e1', { recordedAt: '2026-09-11T10:00:00.000Z' }),
      );
      registerType(store.db, v2, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { outcome: 'approved' } },
        context('e2', { recordedAt: '2026-09-11T18:00:00.000Z' }),
      );

      const profile = profileType(store.db, SPEC.name);

      expect(profile?.count).toBe(2);
      expect(profile?.recordedAtMin).toBe('2026-09-11T10:00:00.000Z');
      expect(profile?.recordedAtMax).toBe('2026-09-11T18:00:00.000Z');
      // One entry per version, NOT the total twice. A reader uses this tally to see which
      // definition produced the corpus, and a per-version count that reported the total would
      // make every version look equally used.
      expect(profile?.versions.map((row) => [row.version, row.major, row.entries])).toStrictEqual([
        [1, 1, 1],
        [2, 2, 1],
      ]);
      // The hash is carried so a consumer can tell which definition produced this map; assert it
      // is a real hash rather than the empty string a missing read would leave behind.
      for (const row of profile?.versions ?? []) {
        expect(row.typeHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.status).toBe('active');
      }

      // The dropped property, seen from both sides: version 2 removed it, so a version-2 entry
      // never had it declared and a version-1 entry simply did not measure it.
      const labels = profile?.properties.find((property) => property.name === 'labels');
      expect(labels?.declaringVersions).toStrictEqual([1]);
      expect(statesOf(labels?.states as StateCounts)).toBe('measured=0 na=0 nm=1 nd=1');
    } finally {
      store.close();
    }
  });

  /**
   * The one assumption `topValues` rests on, checked rather than trusted.
   *
   * `topValues` reads values with `json_extract`, which collapses an absent path and a JSON `null`
   * into the same SQL NULL -- `state.ts` documents that collapse as the reason the three-state model
   * exists at all. The profile is safe from it only because no type in the vocabulary can store a
   * `null` VALUE, so a measured property is never a JSON null. That is a fact about core's
   * validation, one layer away, and this asserts it where a change to it would be noticed: if core
   * ever accepts `null` for a property, this fails rather than the profile quietly reporting an
   * absent value as a present one.
   */
  it('cannot be reached by a JSON null, because no property type accepts one', () => {
    withStore((store) => {
      for (const property of SPEC.properties) {
        expect(() => {
          recordEntry(
            store.db,
            { type: SPEC.name, properties: { [property.name]: null } },
            context(`e-${property.name}`),
          );
        }, `${property.name} (${property.type}) accepted null`).toThrow();
      }
    });
  });

  it('carries the declared type of every property', () => {
    withStore((store) => {
      const profile = profileType(store.db, SPEC.name);
      const outcome = profile?.properties.find((property) => property.name === 'outcome');
      expect(outcome?.declaredTypes).toStrictEqual(['enum']);
      // Not declared `required` in SPEC, and `required: false` is the absence of a claim -- the
      // profile states it as the boolean core's contract uses, rather than inventing a third value.
      expect(outcome?.required).toBe(false);
    });
  });

  /**
   * `required` follows the NEWEST declaring version, and both directions are asserted.
   *
   * A single-version fixture cannot tell "newest" from "oldest" apart -- the mutation that reads
   * the oldest version survives it -- so the case needs a property whose requirement differs
   * between two versions, in a store where both versions have been recorded against.
   */
  it('reads required from the newest version that declares the property, not the oldest', () => {
    const optional: TypeSpec = {
      name: SPEC.name,
      properties: [{ name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] }],
    };
    const required: TypeSpec = {
      name: SPEC.name,
      properties: [
        { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'], required: true },
      ],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, required, { registeredAt: AT });
      registerType(store.db, optional, { registeredAt: AT });

      const versions = typeVersions(store.db, SPEC.name);
      // The premise: dropping `required` really did register a second version rather than being
      // read as `unchanged`. If it had not, this test would be asserting the single-version case
      // again while looking like it asserted two.
      expect(versions.map((row) => row.version)).toStrictEqual([1, 2]);

      const profile = profileType(store.db, SPEC.name);
      expect(profile?.properties[0]?.declaringVersions).toStrictEqual([1, 2]);
      expect(profile?.properties[0]?.required).toBe(false);
    } finally {
      store.close();
    }
  });

  /**
   * `asc-ato`: a property retyped and then reverted must be summarised by its NEWEST type, not by
   * the last type the version scan happened to see for the first time.
   *
   * `declaredTypes` dedups by first occurrence, so `string -> integer -> string` leaves it as
   * `['string', 'integer']` -- correct as a history, but its last element is `integer`, which is
   * NOT what version 3 declares. A summary read from that element renders a string property as a
   * numeric range.
   */
  it('summarises a retyped-and-reverted property by the newest version, not the last new type seen', () => {
    const asString: TypeSpec = { name: SPEC.name, properties: [{ name: 'x', type: 'string' }] };
    const asInteger: TypeSpec = { name: SPEC.name, properties: [{ name: 'x', type: 'integer' }] };
    const backToString: TypeSpec = {
      name: SPEC.name,
      properties: [
        { name: 'x', type: 'string' },
        { name: 'y', type: 'boolean' },
      ],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, asString, { registeredAt: AT });
      registerType(store.db, asInteger, { registeredAt: AT });
      registerType(store.db, backToString, { registeredAt: AT });

      const versions = typeVersions(store.db, SPEC.name);
      // The premise: three distinct versions, not two changes collapsed into one registration.
      expect(versions.map((row) => row.version)).toStrictEqual([1, 2, 3]);

      recordEntry(
        store.db,
        { type: SPEC.name, properties: { x: 'hello world', y: true } },
        context('e-1'),
      );

      const profile = profileType(store.db, SPEC.name);
      const x = profile?.properties.find((property) => property.name === 'x');

      // The honest history is kept -- both types this property has ever held, not reduced to one.
      expect(x?.declaredTypes).toStrictEqual(['string', 'integer']);
      // But the SUMMARY strategy follows version 3's declaration, which is `string`: a `top`
      // summary of the measured value, never the `range` strategy version 2 would have earned.
      expect(x?.summary).toBe('top');
      expect(x?.top.map((entry) => entry.value)).toStrictEqual(['hello world']);
      expect(x?.min).toBeNull();
      expect(x?.max).toBeNull();
    } finally {
      store.close();
    }
  });

  it('reports required for a property the newest version requires', () => {
    const required: TypeSpec = {
      name: SPEC.name,
      properties: [
        { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'], required: true },
      ],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, required, { registeredAt: AT });
      const profile = profileType(store.db, SPEC.name);
      expect(profile?.properties).toHaveLength(1);
      expect(profile?.properties[0]?.required).toBe(true);
    } finally {
      store.close();
    }
  });

  /** The profile is of ONE type. A second type's entries must not appear in it. */
  it('profiles only the type it was asked for', () => {
    const other: TypeSpec = {
      name: 'other_type',
      properties: [{ name: 'outcome', type: 'enum', enum_values: ['approved'] }],
    };

    withStore(
      (store) => {
        recordEntry(
          store.db,
          { type: SPEC.name, properties: { outcome: 'approved' } },
          context('e1'),
        );
        recordEntry(
          store.db,
          { type: other.name, properties: { outcome: 'approved' } },
          context('e2'),
        );

        expect(profileType(store.db, SPEC.name)?.count).toBe(1);
        expect(profileType(store.db, other.name)?.count).toBe(1);
      },
      [SPEC, other],
    );
  });
});

/**
 * `asc-6wn`: a `boolean` property's `top` values, rendered by DECLARED type rather than by
 * whatever `json_extract` handed back.
 *
 * SQLite has no boolean storage class, so `json_extract` returns the stored `true`/`false` as the
 * INTEGER `1`/`0` -- and before this fix, `topValues` (`profile.ts`) printed exactly that,
 * `String`-ed, while `asc explore <type> --page` (which reads `properties_json` directly) printed
 * `true`/`false` for the same property in the same command. `SPEC` has no `boolean` property, so
 * this uses its own fixture rather than widening a spec every other test in this file shares.
 */
/**
 * `asc-qfk.1`: `--filter` lifted from a refusal to a real recomputation, and EVERY number on the
 * profile has to describe the filtered population -- not only `count` and the two state
 * denominators `explore.ts`'s `stateDenominator` names.
 *
 * The fixture is the asc-5x7 shape: `added_later` is declared only by v2, entries are recorded
 * under both v1 and v2, and the filter (`outcome = 'approved'`) admits some of each -- so
 * `declared_entries` (a share of the FILTERED declaring population, 2) and `count` (the FILTERED
 * total, 4) are two different numbers in one profile. A test -- or an implementation -- that
 * confused the two would not go unnoticed here the way it would in a fixture where they happened
 * to coincide.
 */
describe('profileType: --filter narrows every number, not just the denominators (asc-qfk.1)', () => {
  const v2: TypeSpec = {
    name: SPEC.name,
    properties: [...SPEC.properties, { name: 'added_later', type: 'string' }],
  };

  /**
   * Six entries, three per version, split two-'approved'/one-'rejected' within each version.
   * `outcome = 'approved'` then admits four rows (two per version) and excludes two (one per
   * version) -- a filter that narrows across BOTH the declaring and the non-declaring version,
   * rather than one that happens to line up with a version boundary.
   */
  const build = (): Store => {
    const store = openStore({ dir: tempDir() });
    registerType(store.db, SPEC, { registeredAt: AT });
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'approved', findings: 5 } },
      context('e1', { recordedAt: '2026-09-11T09:00:00.000Z' }),
    );
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'approved', findings: 1 } },
      context('e2', { recordedAt: '2026-09-11T10:00:00.000Z' }),
    );
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'rejected', findings: 100 } },
      context('e3', { recordedAt: '2026-09-11T11:00:00.000Z' }),
    );
    registerType(store.db, v2, { registeredAt: AT });
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'approved', findings: 3, added_later: 'x' } },
      context('e4', { recordedAt: '2026-09-11T12:00:00.000Z' }),
    );
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'approved', findings: 2 } },
      context('e5', { recordedAt: '2026-09-11T13:00:00.000Z' }),
    );
    recordEntry(
      store.db,
      { type: SPEC.name, properties: { outcome: 'rejected', findings: 999, added_later: 'y' } },
      context('e6', { recordedAt: '2026-09-11T14:00:00.000Z' }),
    );
    return store;
  };

  const declaredCount = (states: StateCounts): number =>
    states.measured + states.not_applicable + states.not_measured;

  it('computes declared_entries and not_declared against the FILTERED population, and the two denominators differ', () => {
    const store = build();
    try {
      const profile = profileType(store.db, SPEC.name, { filter: "outcome = 'approved'" });
      const addedLater = profile?.properties.find((property) => property.name === 'added_later');

      expect(profile?.count).toBe(4);
      expect(profile?.unfiltered).toBe(6);

      // 2 of the 4 admitted rows are v2 (declare `added_later`, one measured and one not); the
      // other 2 are v1, `not_declared`.
      expect(statesOf(addedLater?.states as StateCounts)).toBe('measured=1 na=0 nm=1 nd=2');

      const declared = declaredCount(addedLater?.states as StateCounts);
      // `declared_entries`: the FILTERED count of v2-declaring rows -- not the unfiltered
      // declaring count (3: e4, e5, e6) and not the filtered total (4).
      expect(declared).toBe(2);
      expect(declared).not.toBe(3);
      expect(declared).not.toBe(profile?.count);

      // The two denominators `not_declared`'s share and the other three states' share are drawn
      // from genuinely differ in this fixture (2 vs 4) -- a fixture where they coincided would
      // let a swapped denominator pass unnoticed.
      expect(declared).not.toBe(profile?.count);
    } finally {
      store.close();
    }
  });

  it('a filter admitting only v1 rows makes the v2-only property 100% not_declared, with declared_entries zero', () => {
    const store = build();
    try {
      const profile = profileType(store.db, SPEC.name, { filter: 'type_version = 1' });
      const addedLater = profile?.properties.find((property) => property.name === 'added_later');

      expect(profile?.count).toBe(3);
      expect(statesOf(addedLater?.states as StateCounts)).toBe('measured=0 na=0 nm=0 nd=3');
      expect(declaredCount(addedLater?.states as StateCounts)).toBe(0);
    } finally {
      store.close();
    }
  });

  it('describes the filtered population in top, distinct, min/max and the per-version tallies -- not just the states', () => {
    const store = build();
    try {
      const profile = profileType(store.db, SPEC.name, { filter: "outcome = 'approved'" });

      // Every admitted row is 'approved' -- the top-K and the distinct count see only that value,
      // even though 'rejected' exists elsewhere in the (unfiltered) type.
      const outcome = profile?.properties.find((property) => property.name === 'outcome');
      expect(outcome?.top).toStrictEqual([{ value: 'approved', count: 4 }]);
      expect(outcome?.distinct).toBe(1);

      // findings: 5, 1 (v1) and 3, 2 (v2) survive the filter; 100 and 999 (both 'rejected') do
      // not -- so the filtered range (1..5) is narrower than the unfiltered one (1..999).
      const findings = profile?.properties.find((property) => property.name === 'findings');
      expect(findings?.min).toBe(1);
      expect(findings?.max).toBe(5);

      // Two admitted rows per version (e1/e2 for v1, e4/e5 for v2), not the unfiltered three each.
      expect(profile?.versions.map((row) => [row.version, row.entries])).toStrictEqual([
        [1, 2],
        [2, 2],
      ]);

      // The envelope's own range is over the admitted rows only: e3 (11:00) and e6 (14:00), both
      // 'rejected', are excluded and would otherwise widen it.
      expect(profile?.recordedAtMin).toBe('2026-09-11T09:00:00.000Z');
      expect(profile?.recordedAtMax).toBe('2026-09-11T13:00:00.000Z');
    } finally {
      store.close();
    }
  });

  it('reports unfiltered equal to count with no filter, and the real unfiltered count when the filter matches nothing', () => {
    const store = build();
    try {
      const noFilter = profileType(store.db, SPEC.name);
      expect(noFilter?.count).toBe(6);
      expect(noFilter?.unfiltered).toBe(6);

      // The trap `PageResult.unfiltered`/`GroupResult.unfiltered` exist for: a filtered `count` of
      // zero does not by itself say whether the filter excluded everything or the type held
      // nothing to begin with.
      const matchesNothing = profileType(store.db, SPEC.name, { filter: 'type_version = 99' });
      expect(matchesNothing?.count).toBe(0);
      expect(matchesNothing?.unfiltered).toBe(6);
    } finally {
      store.close();
    }
  });
});

describe('profileType: a boolean property renders true/false, not 0/1 (asc-6wn)', () => {
  const BOOL_SPEC: TypeSpec = {
    name: 'flag_check',
    properties: [{ name: 'flag', type: 'boolean' }],
  };

  it("renders measured true and false by their declared type, not SQLite's 0/1", () => {
    withStore(
      (store) => {
        // Two `false`s and one `true`, so the top-K's count ordering is unambiguous and does not
        // rest on the tie-break rule a different test already covers.
        recordEntry(store.db, { type: BOOL_SPEC.name, properties: { flag: false } }, context('e1'));
        recordEntry(store.db, { type: BOOL_SPEC.name, properties: { flag: false } }, context('e2'));
        recordEntry(store.db, { type: BOOL_SPEC.name, properties: { flag: true } }, context('e3'));

        const profile = profileType(store.db, BOOL_SPEC.name);
        const flag = profile?.properties.find((property) => property.name === 'flag');

        expect(flag?.summary).toBe('top');
        // Not `[{ value: '0', count: 2 }, { value: '1', count: 1 }]` -- the raw SQLite
        // representation the pre-fix code rendered.
        expect(flag?.top).toStrictEqual([
          { value: 'false', count: 2 },
          { value: 'true', count: 1 },
        ]);
      },
      [BOOL_SPEC],
    );
  });

  /**
   * The other half of the fix: a NULL must never render as the string `'false'`. A property that
   * is absent, N/A, or not declared is a STATE, and the only way this test can tell "we recorded
   * a no" from "nobody looked" apart is if the not-measured entry contributes nothing to `top` at
   * all -- the same guarantee `topValues`'s own file comment already documents for a JSON null.
   */
  it('does not render a not-measured (absent) boolean as false', () => {
    withStore(
      (store) => {
        recordEntry(store.db, { type: BOOL_SPEC.name, properties: { flag: false } }, context('e1'));
        recordEntry(store.db, { type: BOOL_SPEC.name, properties: {} }, context('e2'));
        recordEntry(store.db, { type: BOOL_SPEC.name, na: ['flag'] }, context('e3'));

        const profile = profileType(store.db, BOOL_SPEC.name);
        const flag = profile?.properties.find((property) => property.name === 'flag');

        expect(statesOf(flag?.states as StateCounts)).toBe('measured=1 na=1 nm=1 nd=0');
        // Exactly the one MEASURED false -- the not-measured and not-applicable entries hold no
        // value at all, and must not be counted as though `false` had been recorded for them too.
        expect(flag?.top).toStrictEqual([{ value: 'false', count: 1 }]);
        expect(flag?.distinct).toBe(1);
      },
      [BOOL_SPEC],
    );
  });
});
