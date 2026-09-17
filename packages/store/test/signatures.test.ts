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
  signatures,
  type RecordContext,
  type SignatureProperty,
  type Store,
} from '../src/index.js';

/**
 * `signatures` -- the projection a sampler chooses from.
 *
 * The failure this module can have is not a crash. It is a projection that reads like categorical
 * data and is not: a boolean flattened to `1`, a gap in the DEFINITION reported as a gap in the
 * DATA, a value the store never held passed off as measured. All three would be fed straight into a
 * stratum label and printed as a proportion, so each is asserted here rather than left to the
 * sampler's tests, where a wrong label would look like a wrong allocation.
 *
 * The second thing these tests protect is the projection's SHAPE: one row per entry, in id order,
 * with a cell for every property asked for -- because `explore-sample.ts` throws on a missing cell,
 * and a throw there means the CLI refuses a command that should have worked.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-signatures-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

/** A property of each shape a sampler cares about: two categorical, one numeric, one text. */
const SPEC: TypeSpec = {
  name: 'verification_run',
  properties: [
    { name: 'verdict', type: 'enum', enum_values: ['passed', 'failed'] },
    { name: 'flaky', type: 'boolean' },
    { name: 'duration_ms', type: 'integer' },
    { name: 'command', type: 'string' },
  ],
};

const context = (id: string): RecordContext => ({
  id,
  recordedAt: AT,
  ascendVersion: '0.0.0',
});

/** The projection for `type`'s named properties, read from the registered definition. */
const propertiesOf = (store: Store, type: string, ...names: string[]): SignatureProperty[] => {
  const profile = profileType(store.db, type);
  return names.map((property) => {
    const found = profile?.properties.find((candidate) => candidate.name === property);
    if (found === undefined) throw new Error(`fixture: '${property}' is not declared`);
    return { name: found.name, declaringVersions: found.declaringVersions };
  });
};

/** A store with `SPEC` registered, and whatever `body` records into it. */
const withStore = <T>(body: (store: Store) => T): T => {
  const store = openStore({ dir: tempDir() });
  try {
    registerType(store.db, SPEC, { registeredAt: AT });
    return body(store);
  } finally {
    store.close();
  }
};

describe('signatures: the projection is shaped for a caller', () => {
  it('returns one row per entry of the type, in id order', () => {
    withStore((store) => {
      for (const id of ['c', 'a', 'b']) {
        recordEntry(store.db, { type: SPEC.name, properties: { verdict: 'passed' } }, context(id));
      }

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'verdict'));

      expect(rows.map((row) => row.id)).toStrictEqual(['a', 'b', 'c']);
    });
  });

  it('returns a cell for every property asked for, and no others', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { verdict: 'failed', flaky: true } },
        context('e1'),
      );

      const rows = signatures(
        store.db,
        SPEC.name,
        propertiesOf(store, SPEC.name, 'flaky', 'duration_ms'),
      );

      // Exactly what was asked for, and nothing else -- a projection that returned every declared
      // property would make a sampler's signature wider than the property it was told to group by.
      expect(Object.keys(rows[0]?.values ?? {}).sort()).toStrictEqual(['duration_ms', 'flaky']);
      expect(rows[0]?.values['verdict']).toBeUndefined();
    });
  });

  /**
   * The empty projection still answers, in id order, because `--sample random` without `--by` asks
   * for no cells at all.
   *
   * Three entries recorded out of order, deliberately: this is the one path with its own statement,
   * and it is the path where an ordering clause is easiest to leave out. Measured -- without the
   * `ORDER BY`, the plan searches a per-property expression index rather than the primary key, so the
   * rows arrive in the order of whatever index SQLite picks. Asserting the order here rather than
   * only on the full projection is what keeps that clause from being deleted as redundant.
   */
  it('projects nothing but the ids when asked for no properties, in id order', () => {
    withStore((store) => {
      for (const id of ['c', 'a', 'b']) {
        recordEntry(store.db, { type: SPEC.name, properties: { verdict: 'passed' } }, context(id));
      }

      expect(signatures(store.db, SPEC.name, [])).toStrictEqual([
        { id: 'a', values: {} },
        { id: 'b', values: {} },
        { id: 'c', values: {} },
      ]);
    });
  });

  /** Entries of another type must not appear: a stratum counted across types is a wrong denominator. */
  it('does not project entries of a different type', () => {
    withStore((store) => {
      const other: TypeSpec = {
        name: 'tool_denial',
        properties: [{ name: 'tool', type: 'string' }],
      };
      registerType(store.db, other, { registeredAt: AT });
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e1'));
      recordEntry(store.db, { type: other.name, properties: { tool: 'Bash' } }, context('e2'));

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'verdict'));

      expect(rows.map((row) => row.id)).toStrictEqual(['e1']);
    });
  });

  it('returns nothing for a type with no entries', () => {
    withStore((store) => {
      expect(
        signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'verdict')),
      ).toStrictEqual([]);
    });
  });
});

describe('signatures: the four states, kept apart', () => {
  /**
   * `measured` carries its value; the two absent states carry a null.
   *
   * `not_applicable` and `not_measured` are the two the three-state model exists for, and a stratum
   * report that merged them would tell a reader a property was skipped when it was simply never
   * looked at -- the exact conflation `packages/core/src/state.ts` was written to prevent.
   */
  it('distinguishes measured, not_applicable and not_measured', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { verdict: 'passed' } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, na: ['verdict'] }, context('e2'));
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e3'));

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'verdict'));
      const cells = rows.map((row) => row.values['verdict']);

      expect(cells).toStrictEqual([
        { state: 'measured', value: 'passed' },
        { state: 'not_applicable', value: null },
        { state: 'not_measured', value: null },
      ]);
    });
  });

  /**
   * `not_declared` is the fourth state, and it is a fact about the definition rather than the row.
   *
   * The version-1 entry was recorded before `added_later` existed, so there was no decision
   * available to record -- and the projection has to say so, because the alternative is reporting
   * "this corpus did not measure it" about a property nobody could have measured. This is the state
   * `signatures` exists in `@ascend/store` rather than in `@ascend/core`: only a version-aware query
   * can produce it.
   */
  it('reports not_declared for an entry recorded before the property existed', () => {
    const v2: TypeSpec = {
      name: SPEC.name,
      properties: [...SPEC.properties, { name: 'added_later', type: 'string' }],
    };

    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, SPEC, { registeredAt: AT });
      recordEntry(store.db, { type: SPEC.name, properties: { verdict: 'passed' } }, context('e1'));
      registerType(store.db, v2, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { verdict: 'passed', added_later: 'yes' } },
        context('e2'),
      );

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'added_later'));

      // Version 2 declares it, so `declaringVersions` is `[2]` and only the version-1 row is in the
      // fourth state -- which is what makes this a relation between a row and a definition rather
      // than a property of the row.
      expect(rows.map((row) => row.values['added_later'])).toStrictEqual([
        { state: 'not_declared', value: null },
        { state: 'measured', value: 'yes' },
      ]);
      // And the version-1 property has no `not_declared` rows, since both versions declare it.
      const verdicts = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'verdict'));
      expect(verdicts.map((row) => row.values['verdict']?.state)).toStrictEqual([
        'measured',
        'measured',
      ]);
    } finally {
      store.close();
    }
  });
});

describe('signatures: values read as the type they were written as', () => {
  /**
   * A JSON boolean must read as `true`, not as `1`.
   *
   * `json_extract` returns SQLite's integer for a JSON boolean, so any coercion applied afterwards
   * in JavaScript has already lost the distinction between `true` and the number one. The CASE in
   * `valueExpr` asks `json_type` first, which is the only place the distinction is still available.
   * A stratum labelled `1` is a wrong answer of the quiet kind -- it looks like a number, and a
   * reader has no reason to doubt it.
   */
  it('projects a boolean as true or false rather than as 1 or 0', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { flaky: true } }, context('e1'));
      recordEntry(store.db, { type: SPEC.name, properties: { flaky: false } }, context('e2'));

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'flaky'));

      expect(rows.map((row) => row.values['flaky']?.value)).toStrictEqual(['true', 'false']);
      // `false` is a MEASUREMENT -- the store's rule -- so both rows are measured and neither is
      // mistaken for an absent value merely because the value stringifies to something falsy.
      expect(rows.map((row) => row.values['flaky']?.state)).toStrictEqual(['measured', 'measured']);
    });
  });

  /**
   * A measured `0` is a value, and it must survive as the string `"0"` rather than collapsing.
   *
   * `TASKS.md` #7 again, read from the projection's side: the sampler groups by this string, so if
   * `0` became `null` the number zero would file under the absent states.
   */
  it('projects a measured zero as the value "0"', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { duration_ms: 0 } }, context('e1'));

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'duration_ms'));

      expect(rows[0]?.values['duration_ms']).toStrictEqual({ state: 'measured', value: '0' });
    });
  });

  it('projects a string exactly as written, including its case and spacing', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { command: 'pnpm  test' } },
        context('e1'),
      );

      const rows = signatures(store.db, SPEC.name, propertiesOf(store, SPEC.name, 'command'));

      // No folding, trimming or canonicalising on the way out: two rows differing only in case are
      // two strata, and a projection that merged them would be inventing a rule about the data.
      expect(rows[0]?.values['command']).toStrictEqual({
        state: 'measured',
        value: 'pnpm  test',
      });
    });
  });

  it('projects two properties of one entry independently', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: SPEC.name, properties: { verdict: 'failed', flaky: true } },
        context('e1'),
      );
      recordEntry(store.db, { type: SPEC.name, na: ['verdict'] }, context('e2'));

      const rows = signatures(
        store.db,
        SPEC.name,
        propertiesOf(store, SPEC.name, 'verdict', 'flaky'),
      );

      expect(rows[0]?.values['verdict']?.value).toBe('failed');
      expect(rows[0]?.values['flaky']?.value).toBe('true');
      // The second row never declared `flaky` absent, so it is `not_measured` -- the two properties
      // of one row are read independently, which is what stops a gap in one becoming a gap in both.
      expect(rows[1]?.values['verdict']?.state).toBe('not_applicable');
      expect(rows[1]?.values['flaky']?.state).toBe('not_measured');
    });
  });
});

describe('signatures: the property name is refused rather than escaped', () => {
  /**
   * A name that is not canonical is a defect in the caller, not a value to be sanitised.
   *
   * Property names reach the generated SQL inside a `'$.<name>'` literal path, and they are safe
   * there only because `canonicalName` (`@ascend/core`) reduces every registered name to
   * `[a-z0-9_]`. This asserts that the guarantee is load-bearing rather than incidental: a name with
   * a quote in it would otherwise produce a statement that means something other than what it says.
   */
  it('throws for a name containing a quote, rather than building a broken statement', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: {} }, context('e1'));

      expect(() =>
        signatures(store.db, SPEC.name, [{ name: "x' OR 1=1 --", declaringVersions: [1] }]),
      ).toThrow(/not a canonical name/);
    });
  });

  it('throws for a name that is not lower-case, empty, or contains a dot', () => {
    withStore((store) => {
      for (const name of ['Verdict', '', 'a.b', 'a b', 'a-b']) {
        expect(() => signatures(store.db, SPEC.name, [{ name, declaringVersions: [1] }])).toThrow(
          /not a canonical name/,
        );
      }
    });
  });

  /**
   * The guard is on the NAME, not on the registration -- so a canonical name that no version
   * declares is projected anyway, and reads as `not_declared` for every row.
   *
   * That is the honest answer rather than a throw: `declaringVersions: []` means no version
   * declares it, and a row under no declaring version is in the fourth state. A caller that built
   * this from a real profile cannot reach it, and one that built it by hand gets a state rather
   * than a lie about the data.
   */
  it('reports every row as not_declared for a name no version declares', () => {
    withStore((store) => {
      recordEntry(store.db, { type: SPEC.name, properties: { verdict: 'passed' } }, context('e1'));

      const rows = signatures(store.db, SPEC.name, [
        { name: 'never_anywhere', declaringVersions: [] },
      ]);

      expect(rows[0]?.values['never_anywhere']?.state).toBe('not_declared');
    });
  });
});

describe('signatures: a type named under a non-canonical spelling (asc-pw2)', () => {
  it('projects the same rows regardless of which spelling of the type is asked for', () => {
    const CAMEL: TypeSpec = {
      name: 'reviewKind',
      properties: [{ name: 'verdict', type: 'enum', enum_values: ['passed', 'failed'] }],
    };
    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, CAMEL, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'reviewKind', properties: { verdict: 'passed' } },
        context('e1'),
      );

      const properties = propertiesOf(store, 'reviewKind', 'verdict');
      const byRaw = signatures(store.db, 'reviewKind', properties);
      const byCanonical = signatures(store.db, 'review_kind', properties);

      expect(byRaw).toHaveLength(1);
      expect(byCanonical).toStrictEqual(byRaw);
    } finally {
      store.close();
    }
  });
});
