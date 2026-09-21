import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalizeTypeSpec, definitionShape, typeHash, type TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachHeadroom,
  attachStore,
  detachStore,
  DuplicateProjectError,
  IncompatibleDefinitionsError,
  NotAnAscendStoreError,
  openStore,
  recordEntry,
  recordInvalidation,
  registerType,
  STORE_DIR,
  STORE_FILE,
  TypeNotInAnyProjectError,
  unionEntries,
  UnknownTypeHashError,
  type InvalidationLabel,
  type ProjectSource,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * The cross-project union is the one place ascend reads databases it did not write, so these tests
 * exist mostly to pin what it REFUSES.
 *
 * The load-bearing case is `IncompatibleDefinitionsError`: EV-drift measured five independently
 * authored specs of one concept sharing 9.1 % of their property names, so two projects naming one
 * type differently is the expected state of the world, not an edge case. Measured on two real
 * stores, unioning by name alone returned `count: 3` beside `count: 250` in a single result set --
 * findings next to milliseconds -- with nothing marking where the boundary was. Every test below
 * that concerns the refusal asserts that NO rows came back, because a refusal that still returns a
 * partial result set is the failure it was written to prevent.
 *
 * Two of these tests exist because their absence was a measured false green elsewhere in this
 * package: the union must leave no attachment behind on the THROWING path (a `finally` that only
 * runs when nothing goes wrong is not a `finally`), and the attach ceiling must be exceeded
 * (one project is attached at a time, so 12 projects work -- a later "optimisation" into a single
 * statement would break at 11 and this suite is what would catch it).
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-union-'));
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

const DENIAL: TypeSpec = {
  name: 'tool_denial',
  properties: [
    { name: 'count', type: 'integer' },
    { name: 'tool_name', type: 'string' },
  ],
};

/** `count` retyped to a duration: the same NAME, a genuinely different definition. */
const DENIAL_OTHER: TypeSpec = {
  name: 'tool_denial',
  properties: [
    { name: 'count', type: 'duration', unit: 'ms' },
    { name: 'tool_name', type: 'string' },
  ],
};

let projectCount = 0;

/** One entry to record into a fixture project. */
interface FixtureEntry {
  id: string;
  at?: string;
  type?: string;
  version?: number;
  properties?: Record<string, unknown>;
  na?: readonly string[];
}

/** Build a project store through `register`, then record its entries through the real recorder. */
function projectWith(
  register: (db: DatabaseSync, spec: TypeSpec) => void,
  specs: readonly TypeSpec[],
  entries: readonly FixtureEntry[] = [],
): ProjectSource {
  projectCount += 1;
  const label = `p${String(projectCount)}`;
  // The real on-disk layout, from the constants rather than retyped: `<project>/.ascend/ascend.db`.
  const dir = join(tempDir(), label, STORE_DIR);
  const store = openStore({ dir });
  try {
    for (const spec of specs) register(store.db, spec);
    for (const entry of entries) {
      recordEntry(
        store.db,
        {
          type: entry.type ?? (specs[0] as TypeSpec).name,
          ...(entry.version === undefined ? {} : { version: entry.version }),
          ...(entry.properties === undefined ? {} : { properties: entry.properties }),
          ...(entry.na === undefined ? {} : { na: entry.na }),
        },
        context(entry.id, entry.at ?? AT),
      );
    }
  } finally {
    store.close();
  }
  return { label, file: join(dir, STORE_FILE) };
}

/**
 * A real project store on disk, with the specs registered and entries recorded.
 *
 * A store rather than a bare database on purpose: the union's first job is to check that what it
 * attached is an ascend store at all, so a fixture it could not have written itself would not test
 * the path that matters.
 */
function project(specs: readonly TypeSpec[], entries: readonly FixtureEntry[] = []): ProjectSource {
  return projectWith((db, spec) => registerType(db, spec, { registeredAt: AT }), specs, entries);
}

/**
 * A project whose version rows were written WITHOUT the registry.
 *
 * `registerType` refuses a property named `id`, `source` or `id_state` (asc-865.1), so the
 * colliding definition below cannot be registered at all. The union still has to read such a
 * store -- it is documented as the one place ascend reads databases it did not write, and a store
 * written by an earlier ascend is exactly that -- so the collision stays reachable here. The row
 * is the same row the registry would have written: same canonical shape, same hash.
 */
function projectBypassingTheRegistry(
  specs: readonly TypeSpec[],
  entries: readonly FixtureEntry[] = [],
  options: { readonly fold?: boolean } = {},
): ProjectSource {
  return projectWith(
    (db, spec) => {
      // `fold: false` keeps the name as written, which one fixture needs: `canonicalName('a.b')`
      // is `'a_b'`, so folding a dotted name before inserting it would store an addressable name
      // and prove nothing about the guard that refuses one.
      const shape = definitionShape(
        options.fold === false ? spec : canonicalizeTypeSpec(spec).spec,
      );
      db.prepare(
        `INSERT INTO entry_types (name, version, major, type_hash, spec_json, created_at)
       VALUES (?, 1, 1, ?, ?, ?)`,
      ).run(shape.name, typeHash(shape), JSON.stringify(shape), AT);
    },
    specs,
    entries,
  );
}

/** The connection a union runs through. Its own `main` database must never be consulted. */
const withConnection = (body: (db: DatabaseSync, store: Store) => void): void => {
  const store = openStore({ dir: join(tempDir(), 'local') });
  try {
    body(store.db, store);
  } finally {
    store.close();
  }
};

const attachedNames = (db: DatabaseSync): readonly string[] =>
  (db.prepare('PRAGMA database_list').all() as unknown as { name: string }[]).map(
    (row) => row.name,
  );

describe('rows from several projects read as one corpus', () => {
  it('returns every project’s rows, labelled with where each came from', () => {
    const first = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const second = project([DENIAL], [{ id: 'b1', properties: { count: 250, tool_name: 'Read' } }]);

    withConnection((db) => {
      const result = unionEntries(db, 'tool_denial', [first, second]);

      expect(result.rows.map((row) => [row.project, row.id])).toEqual([
        [first.label, 'a1'],
        [second.label, 'b1'],
      ]);
      expect(result.rows.map((row) => row.properties['count'])).toEqual([3, 250]);
      expect(result.typeHash).toBe(result.projects[0]?.hashes[0]);
    });
  });

  it('orders the union by time, not by project', () => {
    // An ORDER BY inside each project's own statement would order each share and leave the
    // concatenation unsorted -- plausible-looking output in the wrong order.
    const first = project(
      [DENIAL],
      [{ id: 'late', at: '2026-09-11T12:00:00.000Z', properties: { count: 1, tool_name: 'Bash' } }],
    );
    const second = project(
      [DENIAL],
      [
        {
          id: 'early',
          at: '2026-09-11T09:00:00.000Z',
          properties: { count: 2, tool_name: 'Read' },
        },
      ],
    );

    withConnection((db) => {
      expect(unionEntries(db, 'tool_denial', [first, second]).rows.map((row) => row.id)).toEqual([
        'early',
        'late',
      ]);
    });
  });

  it('carries the envelope, so a cross-project row is as readable as a local one', () => {
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);

    withConnection((db) => {
      const row = unionEntries(db, 'tool_denial', [only]).rows[0];
      expect(row?.typeName).toBe('tool_denial');
      expect(row?.typeVersion).toBe(1);
      // 'self' is the recorder's default source -- the entry was recorded here, not derived.
      expect(row?.source).toBe('self');
      expect(row?.recordedAt).toBe(AT);
      expect(row?.runId).toBeNull();
      expect(row?.repo).toBeNull();
    });
  });

  it('does not read the connection’s own database, even when it holds the same type', () => {
    // `--across` means "these projects". A union that quietly added the current project would
    // answer a question the caller did not ask, and the extra rows would look like real ones.
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);

    withConnection((db) => {
      registerType(db, DENIAL, { registeredAt: AT });
      recordEntry(
        db,
        { type: 'tool_denial', properties: { count: 99, tool_name: 'local' } },
        context('local-row'),
      );

      expect(unionEntries(db, 'tool_denial', [only]).rows.map((row) => row.id)).toEqual(['a1']);
    });
  });
});

describe('the union keys on type_hash, never on version numbers', () => {
  it('unions one definition held at different local versions, when the hash names it', () => {
    // `type_version` is assigned by LOCAL registration order, so one definition can sit at v1 in
    // one project and v2 in another -- a union that joined on the version number would silently
    // drop one of them. This is the shape that produces it: the two projects registered the
    // name's two definitions in opposite orders, so each holds the SAME hash at a DIFFERENT
    // version. That history is also why the name means two things here, and therefore why the
    // hash has to be pinned -- the two facts have one cause.
    const reference = project([DENIAL], []);
    const first = project(
      [DENIAL, DENIAL_OTHER],
      [{ id: 'a1', version: 1, properties: { count: 3, tool_name: 'Bash' } }],
    );
    const second = project(
      [DENIAL_OTHER, DENIAL],
      [{ id: 'b1', at: '2026-09-11T11:00:00.000Z', properties: { count: 250, tool_name: 'Read' } }],
    );

    withConnection((db) => {
      const hash = unionEntries(db, 'tool_denial', [reference]).typeHash;

      expect(() => unionEntries(db, 'tool_denial', [first, second])).toThrow(
        IncompatibleDefinitionsError,
      );

      const result = unionEntries(db, 'tool_denial', [first, second], { typeHash: hash });

      expect(result.rows.map((row) => row.id)).toEqual(['a1', 'b1']);
      expect(result.projects.map((entry) => entry.versions)).toEqual([[1], [2]]);
      expect(result.projects.map((entry) => entry.entryCount)).toEqual([1, 1]);
      // Each project holds both definitions; the pinned one is what makes them comparable.
      expect(result.projects.map((entry) => entry.hashes.length)).toEqual([2, 2]);
    });
  });
});

describe('a property name the union cannot address by JSON path', () => {
  // asc-bcv.16 (F5), on the boundary this path has instead of the view generator's. A view is
  // built once under the local registry, which canonicalizes every name it stores; a union is
  // assembled at QUERY time from specs read out of other projects, so it inherits no guard and the
  // comment that used to stand here asserted the invariant ("a property name is canonical") rather
  // than checking it. Without the check a property named `a.b` projects `json_extract(..., '$.a.b')`
  // -- measured reading NULL while the value sits in the row -- and the union reports a null column
  // as a measured absence. Refused, and the refusal names the store to go fix.

  it('refuses a dotted property name rather than projecting a null column', () => {
    const dotted = projectBypassingTheRegistry(
      [{ name: 'tool_denial', properties: [{ name: 'a.b', type: 'string' }] }],
      [],
      { fold: false },
    );

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [dotted]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("property 'a.b'");
      expect(message).toContain('path separator');
      // The fix is in the OTHER project -- a union cannot rename anything it reads -- so the
      // message has to say which name to go change, not merely that something is wrong.
      expect(message).toContain("'a_b' is addressable");
    });
  });

  it('refuses a NUL anywhere in the name rather than dying inside its own statement', () => {
    // asc-bcv.22 (F11). The union builds the path with `literal()`, which escapes `'` and nothing
    // else, and INTERPOLATES it rather than binding it, so the SQL parser stops at the NUL and the
    // SELECT is truncated mid-literal. Measured through the real function before the fix:
    // `unrecognized token: "'$.a"` -- an error naming neither the property nor the project to go
    // fix. Position matters not at all: the NUL breaks the STATEMENT, not the PATH.
    const NUL = String.fromCharCode(0);
    const nuled = projectBypassingTheRegistry(
      [{ name: 'tool_denial', properties: [{ name: `a${NUL}b`, type: 'string' }] }],
      [],
      { fold: false },
    );

    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [nuled])).toThrow(/SQL statement text/);
      expect(() => unionEntries(db, 'tool_denial', [nuled])).toThrow(
        /cannot read type 'tool_denial'/,
      );
    });
  });

  it('does not refuse a name that reads correctly, so a real store is never blocked', () => {
    // The other half, and the reason it is here: a guard on a READ path that fires on a working
    // store would make a corpus unreadable with no way to repair it. `reviewKind` addresses
    // correctly (`$.reviewKind`), so it must cross the union untouched.
    const camel = projectBypassingTheRegistry(
      [{ name: 'tool_denial', properties: [{ name: 'reviewKind', type: 'string' }] }],
      [{ id: 'a1', properties: { reviewKind: 'approved' } }],
      { fold: false },
    );

    withConnection((db) => {
      const result = unionEntries(db, 'tool_denial', [camel]);
      expect(result.rows.map((row) => row.properties['reviewKind'])).toEqual(['approved']);
    });
  });
});

describe('a property name with nothing in it', () => {
  // asc-bcv.21, the empty name, on this boundary too. The union asks the same two questions the
  // view generator does, and this is the rule it was missing. It fails differently here than a
  // dotted name does: `$.a.b` reads NULL and the statement runs, so the union would return a
  // plausible wrong number, but `$.` is not a path at all -- SQLite REJECTS it, and the union dies
  // with `bad JSON path: '$.'` raised from inside a statement it generated itself -- an error naming
  // neither the property nor the store to go fix, which is the failure mode the refusal exists to
  // replace. A NUL in the name fails the same way one rule over (`unrecognized token: "'$.a"`,
  // asc-bcv.22) and is refused by the guard above, not by this one.

  it('refuses an empty property name rather than dying inside its own statement', () => {
    const nameless = projectBypassingTheRegistry(
      [{ name: 'tool_denial', properties: [{ name: '', type: 'string' }] }],
      [],
      { fold: false },
    );

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [nameless]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      // The union's OWN refusal, not SQLite's: this is the whole difference the guard makes.
      expect(message).toContain("cannot read type 'tool_denial'");
      expect(message).toContain("property ''");
      expect(message).toContain("'value' is addressable");
      // Citing the finding where the blast radius was measured, not the one about a renamed column.
      expect(message).toContain('(asc-0w9)');
    });
  });

  it('does not refuse a name that folds away to nothing yet addresses its own key', () => {
    // The over-refusal half. `canonicalName('-')` is empty, so a predicate written on the FOLD
    // would refuse this -- and `$.-` was measured returning the value stored under `-`. A union
    // cannot rename what it reads, so refusing a working name here would make a corpus unreadable
    // with nothing the reader could do about it.
    const folded = projectBypassingTheRegistry(
      [{ name: 'tool_denial', properties: [{ name: '-', type: 'string' }] }],
      [{ id: 'a1', properties: { '-': 'from-the-llm' } }],
      { fold: false },
    );

    withConnection((db) => {
      const result = unionEntries(db, 'tool_denial', [folded]);
      expect(result.rows.map((row) => row.properties['-'])).toEqual(['from-the-llm']);
    });
  });
});

describe('incompatible definitions are refused, not unioned', () => {
  it('refuses when one name means two definitions, and returns no rows', () => {
    const first = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const second = project(
      [DENIAL_OTHER],
      [{ id: 'b1', properties: { count: 250, tool_name: 'Read' } }],
    );

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [first, second]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(IncompatibleDefinitionsError);
      const refusal = error as IncompatibleDefinitionsError;
      expect(refusal.groups).toHaveLength(2);
      expect(refusal.groups.map((group) => group.projects)).toEqual([
        [first.label],
        [second.label],
      ]);
      // The hashes are printed in full: the message's advice is to re-run naming one of them, and
      // a truncated hash cannot be named.
      expect(refusal.message).toContain(refusal.groups[0]?.typeHash as string);
      expect(refusal.message).toContain(refusal.groups[1]?.typeHash as string);
    });
    // Nothing partial escaped: the throw is the whole of the result, and no attachment survived it.
    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [first, second])).toThrow(
        IncompatibleDefinitionsError,
      );
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('refuses a single project that has drifted across its own majors', () => {
    // One project holding two shapes is the same hazard as two projects disagreeing, and the
    // generated views already refuse to union across majors for exactly this reason.
    const drifted = project(
      [DENIAL, DENIAL_OTHER],
      [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }],
    );

    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [drifted])).toThrow(
        IncompatibleDefinitionsError,
      );
    });
  });

  it('unions only the named definition when the hash is pinned, and says what it left out', () => {
    // The way through the refusal. The count is what makes this safe: without a per-project count,
    // a hash-pinned union over two projects reads as the whole corpus when it is half of it.
    const first = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const second = project(
      [DENIAL_OTHER],
      [{ id: 'b1', properties: { count: 250, tool_name: 'Read' } }],
    );

    withConnection((db) => {
      let hash = '';
      try {
        unionEntries(db, 'tool_denial', [first, second]);
      } catch (caught) {
        hash = (caught as IncompatibleDefinitionsError).groups[0]?.typeHash as string;
      }
      expect(hash).not.toBe('');

      const result = unionEntries(db, 'tool_denial', [first, second], { typeHash: hash });

      expect(result.typeHash).toBe(hash);
      expect(result.rows.map((row) => row.id)).toEqual(['a1']);
      expect(result.projects.map((entry) => [entry.label, entry.entryCount])).toEqual([
        [first.label, 1],
        [second.label, 0],
      ]);
      // The project that contributed nothing is still described, with the hash it holds instead.
      expect(result.projects[1]?.hashes).toHaveLength(1);
      expect(result.projects[1]?.hashes).not.toEqual([hash]);
      expect(result.projects[1]?.versions).toEqual([]);
    });
  });

  it('excludes the rows a project recorded against the definition it did not name', () => {
    // The case only a drifted project can produce: ONE project holding entries against both
    // definitions of the name. The per-project filter cannot exclude those rows -- the project
    // holds the pinned hash, so it contributes -- so this is what the `type_hash` predicate in the
    // query is for. Without it the two definitions mix inside a single project's contribution,
    // which is the whole hazard arriving through the one door the refusal does not watch.
    const reference = project([DENIAL], []);
    const drifted = project(
      [DENIAL, DENIAL_OTHER],
      [
        { id: 'old', version: 1, properties: { count: 3, tool_name: 'Bash' } },
        { id: 'new', version: 2, properties: { count: 250, tool_name: 'Read' } },
      ],
    );

    withConnection((db) => {
      const hash = unionEntries(db, 'tool_denial', [reference]).typeHash;
      const result = unionEntries(db, 'tool_denial', [drifted], { typeHash: hash });

      expect(result.rows.map((row) => row.id)).toEqual(['old']);
      expect(result.projects[0]?.entryCount).toBe(1);
      expect(result.projects[0]?.versions).toEqual([1]);
    });
  });

  it('refuses a hash no project holds, rather than returning an empty corpus', () => {
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [only], { typeHash: 'f'.repeat(64) });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UnknownTypeHashError);
      const refusal = error as UnknownTypeHashError;
      expect(refusal.requested).toBe('f'.repeat(64));
      // It offers the hashes that DO exist, so the next attempt can name one.
      expect(refusal.message).toContain(refusal.groups[0]?.typeHash as string);
    });
  });

  it('refuses a type no project defines, naming what it searched', () => {
    const first = project([DENIAL]);
    const second = project([DENIAL]);

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'not_a_type', [first, second]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TypeNotInAnyProjectError);
      expect((error as TypeNotInAnyProjectError).projects).toEqual([first.label, second.label]);
      expect((error as Error).message).toContain('not_a_type');
    });
  });

  it('refuses an empty project list, rather than reporting an empty corpus', () => {
    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [])).toThrow(/no projects given/);
    });
  });
});

describe('a project that is not an ascend store is refused clearly', () => {
  it('names the missing table instead of crashing on the first query', () => {
    const dir = tempDir();
    const file = join(dir, 'not-a-store.db');
    const other = new DatabaseSync(file);
    other.exec('CREATE TABLE unrelated (x)');
    other.close();

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [{ label: 'stray', file }]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NotAnAscendStoreError);
      expect((error as Error).message).toContain("has no 'entries' table");
      expect((error as Error).message).toContain('stray');
      // The refusal happens INSIDE the attach, which is the only path that proves the detach is
      // in a `finally` rather than after the body.
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('refuses a file that does not exist without creating one', () => {
    // Measured: ATTACH creates an empty database when the path is absent and its directory
    // exists. Without this guard a read-only query would leave a stray file wherever the caller
    // mistyped -- and then report the corpus as empty.
    const dir = tempDir();
    const file = join(dir, 'typo.db');

    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [{ label: 'typo', file }])).toThrow(
        NotAnAscendStoreError,
      );
      expect(existsSync(file)).toBe(false);
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('refuses an ascend store whose entries table was written differently', () => {
    // Every envelope column but one, so the column the guard names is the only one it could
    // name. The list is duplicated here deliberately: a test that imported it could not notice
    // the envelope changing.
    const dir = tempDir();
    const file = join(dir, 'old.db');
    const other = new DatabaseSync(file);
    other.exec(
      `CREATE TABLE entries (
         id TEXT PRIMARY KEY, type_name TEXT, type_version INTEGER, type_hash TEXT,
         recorded_at TEXT, run_id TEXT, workflow TEXT, actor TEXT, source TEXT, cwd TEXT,
         repo TEXT, git_sha TEXT, branch TEXT, evidence_text TEXT, na_json TEXT)`,
    );
    other.exec('CREATE TABLE entry_types (name TEXT)');
    other.close();

    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [{ label: 'old', file }])).toThrow(
        /has no 'properties_json' column/,
      );
      expect(attachedNames(db)).toEqual(['main']);
    });
  });
});

describe('the same store twice is refused', () => {
  it('catches two paths that resolve to one file, which would double every count', () => {
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const link = join(tempDir(), 'alias.db');
    symlinkSync(only.file, link);

    withConnection((db) => {
      let error: unknown;
      try {
        unionEntries(db, 'tool_denial', [only, { label: 'aliased', file: link }]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(DuplicateProjectError);
      expect((error as DuplicateProjectError).firstLabel).toBe(only.label);
      expect((error as DuplicateProjectError).label).toBe('aliased');
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('accepts the same file twice when the caller did not ask for it twice', () => {
    // The negative control: the guard keys on the RESOLVED path, so two genuinely different
    // projects are not refused, and a union over them still returns both.
    const first = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const second = project([DENIAL], [{ id: 'b1', properties: { count: 4, tool_name: 'Read' } }]);

    withConnection((db) => {
      expect(unionEntries(db, 'tool_denial', [first, second]).rows).toHaveLength(2);
    });
  });
});

describe('attachments are the union’s own business', () => {
  it('leaves no attachment behind after a successful union', () => {
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);

    withConnection((db) => {
      unionEntries(db, 'tool_denial', [only]);
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('leaves no attachment behind when a project is refused mid-read', () => {
    // The throwing path, which is the one a `finally` is for. A leak here keeps the project's file
    // open and its snapshot readable for the rest of the process.
    const good = project([DENIAL], []);
    const second = project([DENIAL_OTHER], []);

    withConnection((db) => {
      expect(() => unionEntries(db, 'tool_denial', [good, second])).toThrow(
        IncompatibleDefinitionsError,
      );
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('does not clobber an attachment the caller already had', () => {
    // The alias is namespaced AND checked against `database_list`, so a caller that happens to hold
    // `asc_union_0` gets `database is already in use` only if this module stopped checking.
    const only = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const held = project([DENIAL], []);

    withConnection((db) => {
      db.exec(`ATTACH DATABASE '${held.file}' AS asc_union_0`);

      const result = unionEntries(db, 'tool_denial', [only]);

      expect(result.rows.map((row) => row.id)).toEqual(['a1']);
      expect(attachedNames(db)).toEqual(['main', 'asc_union_0']);
      // Still usable under the caller's own name.
      expect(db.prepare('SELECT count(*) AS n FROM asc_union_0.entry_types').get()).toEqual({
        n: 1,
      });
    });
  });

  it('unions more projects than SQLite will attach at once', () => {
    // SQLITE_MAX_ATTACHED defaults to 10 (measured: `too many attached databases - max 10` on the
    // eleventh). One project is attached at a time precisely so this case works; a rewrite into a
    // single statement over all projects would fail here, which is why the test goes past the
    // ceiling instead of stopping just under it.
    const projects = Array.from({ length: 12 }, (_, index) =>
      project(
        [DENIAL],
        [
          {
            id: `e${String(index)}`,
            at: `2026-09-11T10:${String(index).padStart(2, '0')}:00.000Z`,
            properties: { count: index, tool_name: 'Bash' },
          },
        ],
      ),
    );

    withConnection((db) => {
      const result = unionEntries(db, 'tool_denial', projects);

      expect(result.rows).toHaveLength(12);
      expect(result.rows.map((row) => row.properties['count'])).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(result.projects).toHaveLength(12);
      expect(attachedNames(db)).toEqual(['main']);
    });
  });
});

describe('the attach ceiling is measured rather than assumed', () => {
  /**
   * The number is never written down here.
   *
   * A literal `10` in these tests would be the same belief the function was written to avoid, and it
   * would pass whether or not `attachHeadroom` measured anything -- the value and the assertion would
   * be the same guess. So the tests USE the number instead: they attach exactly that many real
   * projects, and then one more, and require SQLite to accept the first batch and refuse the next.
   * That is a property of the number itself, and it is what makes `attachHeadroom`'s result
   * trustworthy rather than merely non-zero. It also means a driver whose ceiling moves makes these
   * tests still correct rather than newly wrong.
   */
  it('returns a number that is exactly the headroom: that many attach, and one more does not', () => {
    withConnection((db) => {
      const headroom = attachHeadroom(db, 64);
      expect(headroom).toBeGreaterThan(1);

      const projects = Array.from({ length: headroom }, (_, index) =>
        project(
          [DENIAL],
          [{ id: `h${String(index)}`, properties: { count: index, tool_name: 'Bash' } }],
        ),
      );

      // Every one of them fits. If `attachHeadroom` under-reported, this is where it shows.
      for (const [index, source] of projects.entries()) {
        expect(() => attachStore(db, source, `a${String(index)}`)).not.toThrow();
      }

      // And the next one does not. If it over-reported, THIS is where it shows -- and the failure is
      // SQLite's own message, which is the raw text the caller is supposed to be spared and which
      // therefore must not be reachable here.
      const overflow = project(
        [DENIAL],
        [{ id: 'overflow', properties: { count: 0, tool_name: 'Bash' } }],
      );
      expect(() => attachStore(db, overflow, 'overflow')).toThrow(/too many attached databases/);

      for (const [index] of projects.entries()) detachStore(db, `a${String(index)}`);
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('probes no further than the caller asked, and reports only what it saw', () => {
    withConnection((db) => {
      // `wanted` is the caller's own count. A caller with two projects has no use for the exact
      // capacity above that, and this is the assertion that the probe does not go looking for it.
      expect(attachHeadroom(db, 2)).toBe(2);
      expect(attachHeadroom(db, 4)).toBe(4);
      expect(attachedNames(db)).toEqual(['main']);

      // Zero is not a special case with its own branch: the loop simply does not run, and reporting
      // 0 is the truth -- there is nothing this connection was asked to hold.
      expect(attachHeadroom(db, 0)).toBe(0);
      expect(attachedNames(db)).toEqual(['main']);
    });
  });

  it('counts what is already attached against the headroom', () => {
    withConnection((db) => {
      const empty = attachHeadroom(db, 64);

      const three = Array.from({ length: 3 }, (_, index) =>
        project(
          [DENIAL],
          [{ id: `p${String(index)}`, properties: { count: index, tool_name: 'Bash' } }],
        ),
      );
      for (const [index, source] of three.entries()) attachStore(db, source, `t${String(index)}`);

      // The ceiling is a property of the CONNECTION, not of the process, so three already attached
      // is three fewer available. A probe that reported the fresh-connection number here would tell
      // `--across` it had room it does not have, and the caller would attach until SQLite refused --
      // which is precisely the bug, arriving one level down.
      expect(attachHeadroom(db, 64)).toBe(empty - 3);

      for (const index of three.keys()) detachStore(db, `t${String(index)}`);
    });
  });

  it('works on the read-only handle that `asc query` holds', () => {
    // The whole point of the measurement is that the CLI can take it. `openQueryProject` opens with
    // `readOnly: true`, so an ATTACH that only works writable would be no use at all.
    //
    // Built first and reopened second, because a read-only open does not create the store: it does
    // not even create the directory (measured in `openStore`), so a read-only handle on a path that
    // does not exist fails to open rather than reporting an empty store.
    const dir = join(tempDir(), 'readonly', STORE_DIR);
    openStore({ dir }).close();

    const store = openStore({ dir, readOnly: true });
    try {
      expect(attachHeadroom(store.db, 64)).toBeGreaterThan(1);
      expect(attachedNames(store.db)).toEqual(['main']);
    } finally {
      store.close();
    }
  });

  it('leaves the connection and the filesystem exactly as it found them', () => {
    // A probe that mutates is a probe that can change the answer it is measuring, so both halves are
    // asserted: the database names, and the directory listing. The second is the one that would
    // catch a probe that attached a FILE -- `ATTACH` creates an empty database when the path does
    // not exist, so a mis-spelled probe path is a stray file left in someone's project.
    const dir = join(tempDir(), 'untouched', STORE_DIR);
    const store = openStore({ dir });
    try {
      const before = readdirSync(dir).sort();
      expect(attachHeadroom(store.db, 64)).toBeGreaterThan(1);
      expect(attachedNames(store.db)).toEqual(['main']);
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      store.close();
    }
  });

  it('does not mistake a name it cannot use for the ceiling', () => {
    withConnection((db) => {
      // `asc_probe_0` is the first name the probe reaches for. A caller that already attached under
      // it must not turn an ATTACH that fails for THAT reason into a reported capacity of zero --
      // which would refuse every query on a connection that in fact has room.
      const blocker = project(
        [DENIAL],
        [{ id: 'blocker', properties: { count: 0, tool_name: 'Bash' } }],
      );
      attachStore(db, blocker, 'asc_probe_0');

      expect(attachHeadroom(db, 64)).toBeGreaterThan(1);
    });
  });
});

describe('the three value states survive the crossing', () => {
  // The third property was called `actor` until asc-865.1: that is an envelope column, so it is
  // now refused at registration and the name had to move. Kept as a note rather than renamed
  // silently -- `actor` is a name a person reaches for, and the cost of the reservation is that
  // they cannot have it.
  const THREE: TypeSpec = {
    name: 'tool_denial',
    properties: [
      { name: 'count', type: 'integer' },
      { name: 'tool_name', type: 'string' },
      { name: 'denier', type: 'string' },
    ],
  };

  it('keeps a measured zero measured, an N/A not applicable, and silence not measured', () => {
    // The state column is generated by `sql.ts` and shared with the generated views, so what this
    // pins is that the shared CASE still reads a cross-database row the same way. A measured 0 is
    // the case that a falsy check collapses into "absent" -- and `count: 0` is a real observation.
    const measured = project(
      [THREE],
      [
        { id: 'zero', properties: { count: 0, tool_name: 'Bash', denier: 'user' } },
        { id: 'na', properties: { count: 5, tool_name: 'Bash' }, na: ['denier'] },
      ],
    );
    const quiet = project([THREE], [{ id: 'silent', properties: { tool_name: 'Read' } }]);

    withConnection((db) => {
      const rows = unionEntries(db, 'tool_denial', [measured, quiet]).rows;
      const byId = (id: string) => rows.find((row) => row.id === id);

      expect(byId('zero')?.properties['count']).toBe(0);
      expect(byId('zero')?.states).toEqual({
        denier: 'measured',
        count: 'measured',
        tool_name: 'measured',
      });
      expect(byId('na')?.states['denier']).toBe('not_applicable');
      expect(byId('silent')?.states['count']).toBe('not_measured');
      expect(byId('silent')?.states['denier']).toBe('not_measured');
    });
  });

  it('never reports not_declared, because every row shares one definition', () => {
    // The fourth state belongs to a view that spans minor versions. The union refuses to mix
    // hashes, so it cannot reach that case -- and reporting `not_declared` here would mean it had
    // started unioning definitions that differ.
    const only = project(
      [THREE],
      [
        { id: 'a1', properties: { count: 1, tool_name: 'Bash', denier: 'user' } },
        { id: 'a2', properties: { tool_name: 'Read' } },
      ],
    );

    withConnection((db) => {
      const states = unionEntries(db, 'tool_denial', [only]).rows.flatMap((row) =>
        Object.values(row.states),
      );
      expect(states).not.toContain('not_declared');
      expect(new Set(states)).toEqual(new Set(['measured', 'not_measured']));
    });
  });

  it('gives properties and states exactly the same keys', () => {
    const only = project([THREE], [{ id: 'a1', properties: { tool_name: 'Bash' } }]);

    withConnection((db) => {
      for (const row of unionEntries(db, 'tool_denial', [only]).rows) {
        expect(Object.keys(row.properties).sort()).toEqual(Object.keys(row.states).sort());
        expect(Object.keys(row.properties).sort()).toEqual(['count', 'denier', 'tool_name']);
      }
    });
  });

  it('keeps a property whose name collides with an envelope column', () => {
    // Without the `p.`/`s.` prefixes, a property called `id` or `source` collides with the envelope
    // column of that name, and SQLite renames the loser to `id:1` in `SELECT *` (measured) -- so
    // the property would come back under a name the caller never wrote, or be read as the envelope
    // value. Both are plausible wrong answers rather than errors.
    //
    // Registration now REFUSES these names (asc-865.1), so this fixture goes in underneath the
    // registry. The union's own defence is still worth pinning: it reads stores ascend did not
    // write, including ones written before the refusal existed.
    const collision: TypeSpec = {
      name: 'tool_denial',
      properties: [
        { name: 'id', type: 'string' },
        { name: 'source', type: 'string' },
        { name: 'id_state', type: 'string' },
      ],
    };
    const only = projectBypassingTheRegistry(
      [collision],
      [{ id: 'a1', properties: { id: 'prop-id', source: 'prop-source', id_state: 'prop-state' } }],
    );

    withConnection((db) => {
      const row = unionEntries(db, 'tool_denial', [only]).rows[0];

      expect(row?.id).toBe('a1');
      expect(row?.source).toBe('self');
      expect(row?.properties).toEqual({
        id: 'prop-id',
        source: 'prop-source',
        id_state: 'prop-state',
      });
      expect(row?.states).toEqual({
        id: 'measured',
        source: 'measured',
        id_state: 'measured',
      });
    });
  });
});

/**
 * `asc-88m`: the union projects `invalidated` through the SAME correlated subquery a per-project
 * view uses (`sql.ts`'s `invalidatedColumnSql`), qualified to the ATTACHed project's own
 * `annotations` table rather than `main`'s -- so the two must agree exactly on one entry, which
 * is what the last test below pins directly.
 */
describe('the invalidated column agrees with the per-project view (asc-88m)', () => {
  const DENIABLE: TypeSpec = {
    name: 'tool_denial',
    properties: [
      { name: 'count', type: 'integer' },
      { name: 'tool_name', type: 'string' },
    ],
  };

  /**
   * Build one project, optionally invalidate one of its entries, and report what that project's
   * OWN per-project view (`v_tool_denial_v1`) says about it -- read before the store is closed,
   * so a test can compare it against what the union says about the very same row.
   */
  function projectWithLocalView(
    entries: readonly FixtureEntry[],
    invalidation?: {
      readonly entryId: string;
      readonly label: InvalidationLabel;
      readonly reason: string;
    },
  ): { readonly source: ProjectSource; readonly localInvalidated: string | null } {
    projectCount += 1;
    const label = `p${String(projectCount)}`;
    const dir = join(tempDir(), label, STORE_DIR);
    const store = openStore({ dir });
    let localInvalidated: string | null = null;
    try {
      registerType(store.db, DENIABLE, { registeredAt: AT });
      for (const entry of entries) {
        recordEntry(
          store.db,
          { type: 'tool_denial', properties: entry.properties ?? {} },
          context(entry.id, entry.at ?? AT),
        );
      }
      if (invalidation !== undefined) {
        recordInvalidation(store.db, {
          entryId: invalidation.entryId,
          label: invalidation.label,
          reason: invalidation.reason,
          createdAt: AT,
        });
        const row = store.db
          .prepare(`SELECT invalidated FROM v_tool_denial_v1 WHERE id = ?`)
          .get(invalidation.entryId) as { invalidated: string | null };
        localInvalidated = row.invalidated;
      }
    } finally {
      store.close();
    }
    return { source: { label, file: join(dir, STORE_FILE) }, localInvalidated };
  }

  it('projects NULL for an entry that has never been invalidated', () => {
    const { source } = projectWithLocalView([
      { id: 'a1', properties: { count: 3, tool_name: 'Bash' } },
    ]);

    withConnection((db) => {
      const row = unionEntries(db, 'tool_denial', [source]).rows[0];
      expect(row?.invalidated).toBeNull();
    });
  });

  it('projects the label of a single invalidation', () => {
    const { source } = projectWithLocalView(
      [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }],
      { entryId: 'a1', label: 'wrong_value', reason: 'count was miscounted' },
    );

    withConnection((db) => {
      const row = unionEntries(db, 'tool_denial', [source]).rows[0];
      expect(row?.invalidated).toBe('wrong_value');
    });
  });

  it('keeps an invalidated row IN the union rather than filtering it out', () => {
    // The same design point `views.ts` makes: dropping the row would make the union's own count
    // disagree with `entries`' with nothing explaining the gap, so exclusion stays a WHERE clause
    // a caller opts into, not something the union does silently.
    const { source } = projectWithLocalView(
      [
        { id: 'a1', properties: { count: 3, tool_name: 'Bash' } },
        { id: 'a2', properties: { count: 4, tool_name: 'Read' } },
      ],
      { entryId: 'a1', label: 'wrong_value', reason: 'struck, but still on record' },
    );

    withConnection((db) => {
      const rows = unionEntries(db, 'tool_denial', [source]).rows;
      expect(rows.map((row) => row.id)).toEqual(['a1', 'a2']);
      expect(rows.filter((row) => row.invalidated === null).map((row) => row.id)).toEqual(['a2']);
    });
  });

  it('agrees with the per-project view for the same entry', () => {
    const { source, localInvalidated } = projectWithLocalView(
      [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }],
      { entryId: 'a1', label: 'wrong_subject', reason: 'this was never about a1 at all' },
    );

    // Not vacuous: the per-project view really did see an invalidation, so agreeing with it and
    // agreeing that both are NULL are different claims.
    expect(localInvalidated).toBe('wrong_subject');

    withConnection((db) => {
      const row = unionEntries(db, 'tool_denial', [source]).rows[0];
      expect(row?.invalidated).toBe(localInvalidated);
    });
  });
});

describe('projects that do not define the type are part of the answer', () => {
  it('reports a non-defining project as contributing nothing, and still returns the rest', () => {
    const withType = project([DENIAL], [{ id: 'a1', properties: { count: 3, tool_name: 'Bash' } }]);
    const without = project([{ name: 'something_else', properties: [] }]);

    withConnection((db) => {
      const result = unionEntries(db, 'tool_denial', [withType, without]);

      expect(result.rows.map((row) => row.id)).toEqual(['a1']);
      expect(result.projects.map((entry) => [entry.label, entry.entryCount])).toEqual([
        [withType.label, 1],
        [without.label, 0],
      ]);
      expect(result.projects[1]?.hashes).toEqual([]);
      expect(result.projects[1]?.versions).toEqual([]);
    });
  });

  it('lists the selected definition’s properties, sorted, so two stores agree on the columns', () => {
    const only = project([DENIAL]);
    withConnection((db) => {
      expect(unionEntries(db, 'tool_denial', [only]).properties).toEqual(['count', 'tool_name']);
    });
  });
});

describe('a type named under a non-canonical spelling (asc-pw2)', () => {
  const CAMEL: TypeSpec = {
    name: 'reviewKind',
    properties: [{ name: 'outcome', type: 'string' }],
  };

  it('unions a project’s rows when asked for the type under the spelling it was authored with', () => {
    const only = project(
      [CAMEL],
      [{ id: 'a1', type: 'reviewKind', properties: { outcome: 'ok' } }],
    );

    withConnection((db) => {
      const byRaw = unionEntries(db, 'reviewKind', [only]);
      const byCanonical = unionEntries(db, 'review_kind', [only]);

      expect(byRaw.rows.map((row) => row.id)).toEqual(['a1']);
      // Reported identity is the canonical spelling (matches `TypeVersionRow.name` and
      // `TypeProfile.type` precedent), so the two calls answer with the same value here even
      // though they were asked under different spellings.
      expect(byRaw.type).toBe('review_kind');
      expect(byCanonical).toStrictEqual(byRaw);
    });
  });

  it(
    'agrees between the two queries a single call makes: the bound-parameter project read and ' +
      'the literal-embedded per-row selection (asc-pw2)',
    () => {
      // `unionEntries` runs two different kinds of query against one type name: `readProject`
      // resolves membership through a bound parameter, and the per-project `select` builds its
      // WHERE clause by embedding the name with `literal()` rather than binding it. Both must
      // canonicalize the same way, or a project that defines the type under a non-canonical
      // spelling would count as "in scope" (the bound-parameter check passes) while contributing
      // zero rows (the literal-embedded check, searching for a different string, matches nothing)
      // -- silently reporting less data than the union actually has, rather than throwing.
      const only = project(
        [CAMEL],
        [{ id: 'a1', type: 'reviewKind', properties: { outcome: 'ok' } }],
      );

      withConnection((db) => {
        const result = unionEntries(db, 'reviewKind', [only]);
        expect(result.rows).toHaveLength(1);
        expect(result.projects[0]?.entryCount).toBe(1);
      });
    },
  );
});
