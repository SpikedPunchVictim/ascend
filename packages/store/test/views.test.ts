import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeTypeSpec,
  definitionShape,
  ENVELOPE_PROPERTY_NAMES,
  typeHash,
  type TypeSpec,
} from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findEntry,
  indexName,
  openStore,
  recordEntry,
  refreshTypeViews,
  registerType,
  viewName,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * Generated views are how a JSON document becomes something a human can GROUP BY. These
 * tests are written against REAL queries run through the view rather than against the DDL
 * text, because the DDL being right and the query working are different claims -- and the
 * `EXPLAIN QUERY PLAN` assertions exist for the same reason: EV-4 settled that a
 * composite expression index is required, and an index that exists but is not chosen by
 * the planner is indistinguishable from no index at all.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-views-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

const context = (id: string, at: string = AT): RecordContext => ({
  id,
  recordedAt: at,
  ascendVersion: '0.0.0',
});

const V1: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'count', type: 'integer' },
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'summary', type: 'text' },
  ],
};

/** V1 plus an optional property: a MINOR bump, so both live in major family 1. */
const V2_MINOR: TypeSpec = {
  ...V1,
  properties: [...V1.properties, { name: 'reviewer', type: 'string' }],
};

/** Retyping `count`: a MAJOR bump, so a new family that must not be unioned with the old. */
const V2_MAJOR: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'count', type: 'duration', unit: 'ms' },
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
    { name: 'summary', type: 'text' },
  ],
};

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
  }
};

interface Row {
  readonly id: string;
  readonly type_version: number;
  readonly count: number | null;
  readonly count_state: string;
  readonly outcome: string | null;
  readonly outcome_state: string;
  readonly reviewer: string | null;
  readonly reviewer_state: string;
}

const rows = (store: Store, view: string): readonly Row[] =>
  store.db.prepare(`SELECT * FROM ${view} ORDER BY id`).all() as unknown as Row[];

const one = (store: Store, view: string, id: string): Row => {
  const row = rows(store, view).find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no row '${id}' in ${view}`);
  return row;
};

/** The envelope columns every view carries, in order. Duplicated deliberately: a test that
 * imported the list from the module under test could not notice it changing. */
const ENVELOPE = [
  'id',
  'type_name',
  'type_version',
  'type_hash',
  'recorded_at',
  'run_id',
  'workflow',
  'actor',
  'source',
  'cwd',
  'repo',
  'git_sha',
  'branch',
  'evidence_text',
  'properties_json',
  'na_json',
];

/** A view's columns, in the order the view declares them. */
const columnNames = (store: Store, view: string): readonly string[] =>
  (store.db.prepare(`PRAGMA table_info(${view})`).all() as unknown as { name: string }[]).map(
    (column) => column.name,
  );

/**
 * Write a version row the way a store predating the envelope-name rule would already hold one.
 *
 * `registerType` refuses a property the view has claimed (asc-865.1), so a fixture for the
 * view generator's own refusal has to go in underneath the registry. Same shape, same hash --
 * the columns a view reads are `spec_json` and the version numbers.
 */
const insertVersionRow = (store: Store, spec: TypeSpec): void => {
  const shape = definitionShape(canonicalizeTypeSpec(spec).spec);
  store.db
    .prepare(
      `INSERT INTO entry_types (name, version, major, type_hash, spec_json, created_at)
       VALUES (?, 1, 1, ?, ?, ?)`,
    )
    .run(shape.name, typeHash(shape), JSON.stringify(shape), AT);
};

describe('naming', () => {
  it('names a view per major family and an index per property', () => {
    expect(viewName('review_completed', 2)).toBe('v_review_completed_v2');
    expect(indexName('review_completed', 'count')).toBe('idx_entries_review_completed_count');
  });
});

describe('the projected columns carry all four states', () => {
  it('projects a measured value and marks it measured', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed', properties: { count: 3 } }, context('e1'));

      const row = one(store, viewName('review_completed', 1), 'e1');
      expect(row.count).toBe(3);
      expect(row.count_state).toBe('measured');
    });
  });

  it('keeps a MEASURED ZERO distinguishable from absent', () => {
    // Through the view, `0` must be a value and not a NULL. This is the three-state model
    // surviving the json_extract projection, which is where a falsy value would vanish.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 0 } },
        context('zero'),
      );
      recordEntry(store.db, { type: 'review_completed' }, context('silent'));

      const view = viewName('review_completed', 1);
      expect(one(store, view, 'zero').count).toBe(0);
      expect(one(store, view, 'silent').count).toBeNull();

      // The query a human would actually write. `zero` must not be caught by it.
      const nulls = store.db
        .prepare(`SELECT id FROM ${view} WHERE count IS NULL`)
        .all() as unknown as { id: string }[];
      expect(nulls.map((row) => row.id)).toEqual(['silent']);
    });
  });

  it('marks an explicit N/A as not_applicable, with no value', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed', na: ['count'] }, context('e1'));

      const row = one(store, viewName('review_completed', 1), 'e1');
      expect(row.count).toBeNull();
      expect(row.count_state).toBe('not_applicable');
    });
  });

  it('marks silence as not_measured', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { summary: 'ok' } },
        context('e1'),
      );
      expect(one(store, viewName('review_completed', 1), 'e1').count_state).toBe('not_measured');
    });
  });

  it('distinguishes all three states in ONE query, which is the ergonomic claim', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      const view = viewName('review_completed', 1);

      recordEntry(store.db, { type: 'review_completed', properties: { count: 5 } }, context('m'));
      recordEntry(store.db, { type: 'review_completed', na: ['count'] }, context('n'));
      recordEntry(store.db, { type: 'review_completed' }, context('u'));

      const byState = store.db
        .prepare(`SELECT count_state, COUNT(*) AS n FROM ${view} GROUP BY 1 ORDER BY 1`)
        .all() as unknown as { count_state: string; n: number }[];

      expect(byState).toEqual([
        { count_state: 'measured', n: 1 },
        { count_state: 'not_applicable', n: 1 },
        { count_state: 'not_measured', n: 1 },
      ]);
    });
  });

  it('aggregates values with real GROUP BY semantics', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      const view = viewName('review_completed', 1);
      for (const [id, count] of [
        ['a', 1],
        ['b', 1],
        ['c', 4],
      ] as const) {
        recordEntry(store.db, { type: 'review_completed', properties: { count } }, context(id));
      }
      recordEntry(store.db, { type: 'review_completed', na: ['count'] }, context('d'));

      const grouped = store.db
        .prepare(
          `SELECT count, COUNT(*) AS n FROM ${view} WHERE count_state = 'measured' GROUP BY 1 ORDER BY 1`,
        )
        .all() as unknown as { count: number; n: number }[];

      // Hand-computed, and the N/A row is excluded rather than counted as a zero.
      expect(grouped).toEqual([
        { count: 1, n: 2 },
        { count: 4, n: 1 },
      ]);
    });
  });
});

describe('a minor version unions into the same view', () => {
  it('shows rows from both versions and projects the later property', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 1 } },
        context('v1row'),
      );
      registerType(store.db, V2_MINOR, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 2, reviewer: 'sam' } },
        context('v2row'),
      );

      const view = viewName('review_completed', 1);
      expect(rows(store, view).map((row) => [row.id, row.type_version])).toEqual([
        ['v1row', 1],
        ['v2row', 2],
      ]);
      expect(one(store, view, 'v2row').reviewer).toBe('sam');
    });
  });

  it('reports a property the earlier version never declared as not_declared, NOT not_measured', () => {
    // The fourth state, and the reason it exists. `reviewer` was not in version 1's
    // definition, so for a version-1 row it is not "we did not measure it" -- the question
    // was never askable. Counting it as not_measured would put that row into a coverage
    // denominator for a property its definition did not have.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed' }, context('v1row'));
      registerType(store.db, V2_MINOR, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed' }, context('v2row'));

      const view = viewName('review_completed', 1);
      expect(one(store, view, 'v1row').reviewer_state).toBe('not_declared');
      expect(one(store, view, 'v2row').reviewer_state).toBe('not_measured');

      // And the two are separable in one query, so a real denominator is computable.
      const declarers = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${view} WHERE reviewer_state <> 'not_declared'`)
        .get() as { n: number };
      expect(declarers.n).toBe(1);
    });
  });

  it('still reports not_applicable for a version-1 row on a version-1 property', () => {
    // The check above must not have turned every state into not_declared for old rows.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed', na: ['count'] }, context('v1row'));
      registerType(store.db, V2_MINOR, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed' }, context('v2row'));

      const view = viewName('review_completed', 1);
      expect(one(store, view, 'v1row').count_state).toBe('not_applicable');
      expect(one(store, view, 'v2row').count_state).toBe('not_measured');
    });
  });
});

describe('a major version NEVER unions with the old family', () => {
  it('gives each family its own view, each holding only its own rows', () => {
    // Unioning across a major bump is fold's confound #1 rebuilt: `count` means findings in
    // v1 and milliseconds in v2, and one result set mixing them is a plausible wrong answer
    // with nothing marking where the boundary was.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 3 } },
        context('v1row'),
      );

      registerType(store.db, V2_MAJOR, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 250 } },
        context('v2row'),
      );

      expect(rows(store, viewName('review_completed', 1)).map((row) => row.id)).toEqual(['v1row']);
      expect(rows(store, viewName('review_completed', 2)).map((row) => row.id)).toEqual(['v2row']);
    });
  });

  it('marks the new family declared and the old family not_declared for the same name', () => {
    // The two `count` columns are different properties that happen to share a name. The
    // state column is what keeps that from being invisible.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed' }, context('v1row'));
      registerType(store.db, V2_MAJOR, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed' }, context('v2row'));

      expect(one(store, viewName('review_completed', 1), 'v1row').count_state).toBe('not_measured');
      expect(one(store, viewName('review_completed', 2), 'v2row').count_state).toBe('not_measured');
      // Each family's view does not contain the other's rows at all.
      expect(rows(store, viewName('review_completed', 1))).toHaveLength(1);
      expect(rows(store, viewName('review_completed', 2))).toHaveLength(1);
    });
  });
});

describe('the index is chosen by the planner, not merely present', () => {
  const plan = (store: Store, sql: string): string =>
    (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ');

  it('drives a group-by from the composite expression index, applying the type filter', () => {
    // EV-4's required addition, asserted as behaviour. The failure it guards against is
    // measured: a BARE expression index makes SQLite scan the entire index instead, and
    // measures SLOWER THAN NO INDEX (449.6 ms vs 231.0 ms).
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      const view = viewName('review_completed', 1);
      const detail = plan(store, `SELECT count, COUNT(*) FROM ${view} GROUP BY count`);

      expect(detail).toContain('USING INDEX');
      expect(detail).toContain(indexName('review_completed', 'count'));
      // `type_name=?` is the point of the composite form: the predicate is usable.
      expect(detail).toContain('type_name=?');
      expect(detail).not.toMatch(/SCAN entries/);
    });
  });

  it('creates one index per distinct property, across versions', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      registerType(store.db, V2_MINOR, { registeredAt: AT });

      const names = (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_entries_review%'",
          )
          .all() as unknown as { name: string }[]
      ).map((row) => row.name);

      // `reviewer` came in with the minor version and still gets an index -- a property
      // added later is exactly the one new queries filter on.
      expect(names.sort()).toEqual([
        indexName('review_completed', 'count'),
        indexName('review_completed', 'outcome'),
        indexName('review_completed', 'reviewer'),
        indexName('review_completed', 'summary'),
      ]);
    });
  });
});

describe('refresh is derived and idempotent', () => {
  it('rebuilds the same views and creates no index twice', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      const second = refreshTypeViews(store.db, 'review_completed');

      expect(second.views).toEqual([viewName('review_completed', 1)]);
      expect(second.indexes).toEqual([]);
    });
  });

  it('is safe to run after a view was dropped by hand -- the repair path', () => {
    // A store whose views are missing must be recoverable without a migration. This is what
    // `asc doctor` calls.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(store.db, { type: 'review_completed', properties: { count: 7 } }, context('e1'));

      store.db.exec(`DROP VIEW ${viewName('review_completed', 1)}`);
      expect(() => rows(store, viewName('review_completed', 1))).toThrow();

      refreshTypeViews(store.db, 'review_completed');

      expect(one(store, viewName('review_completed', 1), 'e1').count).toBe(7);
    });
  });

  it('refuses to build views for a type that is not registered', () => {
    withStore((store) => {
      expect(() => refreshTypeViews(store.db, 'never_defined')).toThrow(/no entry type/);
    });
  });

  it('orders columns by name, not by the version that introduced the property', () => {
    // The load-bearing case for sorting. Canonicalization sorts WITHIN a version
    // (core/src/spec.ts), so a single-version store is sorted for free -- but a property
    // added by a later minor can sort BEFORE one the first version already had, and the
    // union is assembled version by version. Without the sort the column order would follow
    // registration history instead of the property set.
    withStore((store) => {
      registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'alpha', type: 'integer' },
            { name: 'gamma', type: 'integer' },
          ],
        },
        { registeredAt: AT },
      );
      registerType(
        store.db,
        {
          name: 'review_completed',
          properties: [
            { name: 'alpha', type: 'integer' },
            { name: 'beta', type: 'integer' },
            { name: 'gamma', type: 'integer' },
          ],
        },
        { registeredAt: AT },
      );

      const columns = columnNames(store, viewName('review_completed', 1));
      const projected = columns.filter((name) => !ENVELOPE.includes(name));

      expect(projected).toEqual([
        'alpha',
        'alpha_state',
        'beta',
        'beta_state',
        'gamma',
        'gamma_state',
      ]);
    });
  });

  it('gives the same column list to stores that reached the set by different version splits', () => {
    // The claim the sort exists for: column order is a function of the property SET, not of
    // registration history. These two stores hold the same family-1 property set, one of
    // them in two versions and one in a single version, so their DDL differs only in the
    // WHERE clause -- the columns must not.
    const columnsFor = (specs: readonly TypeSpec[]): readonly string[] => {
      let out: readonly string[] = [];
      withStore((store) => {
        for (const spec of specs) registerType(store.db, spec, { registeredAt: AT });
        out = columnNames(store, viewName('review_completed', 1));
      });
      return out;
    };

    // Version 1 contributes `beta` and `gamma`; version 2 is the one that adds `alpha`,
    // which sorts first. Assembled version by version the union reads beta, gamma, alpha --
    // so without the sort these two stores would report the same property set in two orders.
    const split = columnsFor([
      {
        name: 'review_completed',
        properties: [
          { name: 'beta', type: 'integer' },
          { name: 'gamma', type: 'integer' },
        ],
      },
      {
        name: 'review_completed',
        properties: [
          { name: 'alpha', type: 'integer' },
          { name: 'beta', type: 'integer' },
          { name: 'gamma', type: 'integer' },
        ],
      },
    ]);
    const whole = columnsFor([
      {
        name: 'review_completed',
        properties: [
          { name: 'alpha', type: 'integer' },
          { name: 'beta', type: 'integer' },
          { name: 'gamma', type: 'integer' },
        ],
      },
    ]);

    expect(split).toEqual(whole);
  });
});

describe('registration is atomic with the views it derives', () => {
  it('leaves no open transaction behind', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      expect(store.db.isTransaction).toBe(false);
    });
  });

  it('joins a caller transaction instead of nesting into it', () => {
    // SQLite rejects a nested BEGIN outright, so a registration inside a caller's
    // transaction must not attempt its own -- and must not commit the caller's work either.
    withStore((store) => {
      store.db.exec('BEGIN');
      registerType(store.db, V1, { registeredAt: AT });
      expect(store.db.isTransaction).toBe(true);
      recordEntry(store.db, { type: 'review_completed' }, context('e1'));
      store.db.exec('ROLLBACK');

      // The rollback took the type, the view and the entry together.
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM entry_types').get()).toEqual({ n: 0 });
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM entries').get()).toEqual({ n: 0 });
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").get(),
      ).toBeUndefined();
    });
  });

  it('leaves no version row behind when the views cannot be built', () => {
    // The claim the transaction exists for, exercised on the path where registration OWNS the
    // transaction -- the rollback test above runs nested, where a misplaced COMMIT is
    // invisible. A store missing `entries` is what an interrupted setup looks like, and the
    // failure it must not produce is a registered version whose view does not exist: `asc
    // types show` would report the type and `asc query` would fail on it.
    withStore((store) => {
      store.db.exec('DROP TABLE entries');
      expect(() => registerType(store.db, V1, { registeredAt: AT })).toThrow();
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM entry_types').get()).toEqual({ n: 0 });
    });
  });

  it('keeps the version row and its view consistent through the recorder', () => {
    withStore((store) => {
      const registered = registerType(store.db, V1, { registeredAt: AT });
      const recorded = recordEntry(store.db, { type: 'review_completed' }, context('e1'));

      // The entry names the definition the view was built from -- one hash, one family.
      expect(recorded.entry.typeHash).toBe(registered.typeHash);
      expect(recorded.entry.typeVersion).toBe(registered.version);
      expect(one(store, viewName('review_completed', registered.major), 'e1').type_version).toBe(1);
    });
  });
});

describe('a property can never want a column the view has already claimed', () => {
  // asc-865.1, measured on this path before the fix: a property named `source` produced a view
  // whose declared columns were [... "source", ..., "source:1", "source_state"], and
  // `SELECT source FROM v_note_v1` returned 'self' -- the ENVELOPE value, with no error. The
  // reservation lives in @ascend/core and the registry refuses on it, because a name that cannot
  // be projected has to be refused while the author can still cheaply rename it.

  it('claims exactly the names core reserves, and no others', () => {
    // The invariant that keeps the guard honest in BOTH directions. Deriving the claimed names
    // back out of a real view catches a column added to the projection without being reserved
    // (which would reopen the hole silently), and a name reserved that no view projects (which
    // would refuse a harmless property). Order included: the projection is built from the list.
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });

      const fromProperties = new Set(
        V1.properties.flatMap((property) => [property.name, `${property.name}_state`]),
      );
      const claimed = columnNames(store, viewName('review_completed', 1)).filter(
        (name) => !fromProperties.has(name),
      );

      expect(claimed).toEqual([...ENVELOPE_PROPERTY_NAMES]);
    });
  });

  it('projects a name that only LOOKS like an envelope column, keeping its own value', () => {
    // The boundary of the reservation rather than its centre. `ascend_version` is a column of
    // `entries` that no view projects, so it collides with nothing and must round-trip; `state`
    // is what a literal `_state` canonicalizes to, and the suffix is only taken when something
    // precedes it.
    withStore((store) => {
      registerType(
        store.db,
        {
          name: 'note',
          properties: [
            { name: 'ascend_version', type: 'string' },
            { name: 'state', type: 'string' },
          ],
        },
        { registeredAt: AT },
      );
      recordEntry(
        store.db,
        { type: 'note', properties: { ascend_version: 'from-the-llm', state: 'open' } },
        context('e1'),
      );

      const view = viewName('note', 1);
      const columns = columnNames(store, view);
      expect(columns).not.toContain('ascend_version:1');
      expect(columns).not.toContain('state:1');
      expect(store.db.prepare(`SELECT ascend_version, state FROM ${view}`).get()).toEqual({
        ascend_version: 'from-the-llm',
        state: 'open',
      });
    });
  });

  it('refuses a version that reached the store without the registry, rather than rename a column', () => {
    // The second line. A hand-written row, or a store created before the rule, still cannot get
    // a view whose `source` column is the envelope: the generator refuses and changes nothing.
    withStore((store) => {
      insertVersionRow(store, {
        name: 'note',
        properties: [{ name: 'source', type: 'string' }],
      });

      expect(() => refreshTypeViews(store.db, 'note')).toThrow(/asc-865\.1/);

      const objects = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('view', 'index')")
        .all() as unknown as { name: string }[];
      // Nothing was built -- not the view, and not the indexes either: the refusal precedes all DDL.
      expect(objects.filter((object) => object.name.includes('note'))).toEqual([]);
    });
  });
});

describe('the view carries the envelope through', () => {
  it('exposes provenance and evidence beside the projected columns', () => {
    withStore((store) => {
      registerType(store.db, V1, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 1 } },
        {
          ...context('e1'),
          runId: 'run-7',
          cwd: '/repo',
          evidenceText: 'the review finished',
        },
      );

      const row = store.db
        .prepare(
          `SELECT run_id, cwd, evidence_text, type_hash, recorded_at, source FROM ${viewName('review_completed', 1)}`,
        )
        .get() as Record<string, unknown>;

      expect(row).toMatchObject({
        run_id: 'run-7',
        cwd: '/repo',
        evidence_text: 'the review finished',
        source: 'self',
        recorded_at: AT,
      });
      expect(row['type_hash']).toBe(findEntry(store.db, 'e1')?.typeHash);
    });
  });
});
