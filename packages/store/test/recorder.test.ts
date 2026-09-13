import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PropertySpec, TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DuplicateEntryError,
  EntryRejectedError,
  findEntry,
  openStore,
  recordEntry,
  registerType,
  SCHEMA_VERSION,
  UnknownTypeError,
  updateTypeProse,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * The recorder is the single entry write path, so these tests carry more weight than a
 * module's usual share: they are the specification of what a stored record IS.
 *
 * The three-state cases are the ones to read closely. A `0` that must survive as a
 * measured value, and a property that must stay ABSENT from both documents, are the two
 * failures the product exists to prevent -- and both are ordinary-looking tests that
 * would pass trivially against an implementation that had collapsed the states.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-recorder-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

/** The working type: two optional properties, one of each interesting kind. */
const SPEC: TypeSpec = {
  name: 'review_completed',
  properties: [
    { name: 'count', type: 'integer' },
    { name: 'summary', type: 'text' },
    { name: 'outcome', type: 'enum', enum_values: ['approved', 'rejected'] },
  ],
};

const context = (overrides: Partial<RecordContext> = {}): RecordContext => ({
  id: 'e1',
  recordedAt: AT,
  ascendVersion: '0.0.0',
  ...overrides,
});

/** A store with SPEC registered, plus the spec that was registered. */
const withStore = (body: (store: Store) => void, spec: TypeSpec = SPEC): void => {
  const store = openStore({ dir: tempDir() });
  try {
    registerType(store.db, spec, { registeredAt: AT });
    body(store);
  } finally {
    store.close();
  }
};

const countEntries = (store: Store): number =>
  (store.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;

const storedRow = (store: Store, id = 'e1'): { properties_json: string; na_json: string } =>
  store.db.prepare('SELECT properties_json, na_json FROM entries WHERE id = ?').get(id) as {
    properties_json: string;
    na_json: string;
  };

describe('the recorder builds the envelope', () => {
  it('records against the latest version when none is named', () => {
    withStore((store) => {
      const { entry } = recordEntry(store.db, { type: 'review_completed' }, context());
      expect(entry.typeName).toBe('review_completed');
      expect(entry.typeVersion).toBe(1);
      expect(entry.source).toBe('self');
      // Asserted against the constant, not a literal: a literal goes stale the moment a
      // migration lands -- which is how this test failed when migration 2 raised it to 2 --
      // and the invariant worth pinning is that an entry is stamped with the CURRENT store
      // schema, not that the current one happens to be some particular number.
      expect(entry.schemaVersion).toBe(SCHEMA_VERSION);
      expect(entry.schemaVersion).toBeGreaterThanOrEqual(2);
    });
  });

  it('pins a named version when one is given', () => {
    withStore((store) => {
      registerType(
        store.db,
        { ...SPEC, properties: [...SPEC.properties, { name: 'reviewer', type: 'string' }] },
        { registeredAt: AT },
      );

      const { entry } = recordEntry(store.db, { type: 'review_completed', version: 1 }, context());
      expect(entry.typeVersion).toBe(1);
    });
  });

  it('takes the type identity FROM THE STORE, never from the caller', () => {
    // The API has no parameter for type_hash or type_version, which is the point: those
    // three columns are one foreign key, and a caller able to set them independently is
    // how an entry ends up claiming a definition whose shape it does not have.
    withStore((store) => {
      const { entry } = recordEntry(store.db, { type: 'review_completed' }, context());
      const registered = store.db
        .prepare(
          "SELECT type_hash FROM entry_types WHERE name = 'review_completed' AND version = 1",
        )
        .get() as { type_hash: string };
      expect(entry.typeHash).toBe(registered.type_hash);
    });
  });

  it('leaves an entry on the version it was recorded against', () => {
    // A later minor version must not retroactively move earlier entries. The generated
    // view unions across versions precisely because each entry knows its own.
    withStore((store) => {
      recordEntry(store.db, { type: 'review_completed' }, context());
      registerType(
        store.db,
        { ...SPEC, properties: [...SPEC.properties, { name: 'reviewer', type: 'string' }] },
        { registeredAt: AT },
      );

      expect(findEntry(store.db, 'e1')?.typeVersion).toBe(1);
      expect(findEntry(store.db, 'e1')?.states['reviewer']).toBeUndefined();
    });
  });

  it('keeps every provenance field it was handed', () => {
    withStore((store) => {
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed' },
        context({
          runId: 'run-7',
          workflow: 'code-review',
          actor: 'agent',
          cwd: '/repo',
          repo: 'ascend',
          gitSha: 'abc123',
          branch: 'main',
          evidenceText: 'the review finished with 3 findings',
          source: 'derived:claude-code',
        }),
      );

      expect(entry).toMatchObject({
        runId: 'run-7',
        workflow: 'code-review',
        actor: 'agent',
        cwd: '/repo',
        repo: 'ascend',
        gitSha: 'abc123',
        branch: 'main',
        evidenceText: 'the review finished with 3 findings',
        source: 'derived:claude-code',
      });
      expect(findEntry(store.db, 'e1')).toEqual(entry);
    });
  });

  it('stores NULL, not an empty string, for provenance it was not handed', () => {
    withStore((store) => {
      recordEntry(store.db, { type: 'review_completed' }, context());
      expect(findEntry(store.db, 'e1')).toMatchObject({
        runId: null,
        cwd: null,
        repo: null,
        gitSha: null,
        branch: null,
        evidenceText: null,
      });
    });
  });
});

describe('the three states survive the round trip', () => {
  it('stores a MEASURED ZERO as a value', () => {
    // The single most important case in the store. `count: 0` is a measured zero, and an
    // implementation that treats a falsy value as absent would drop it -- which is how
    // the fold corpus ended up unable to distinguish "zero findings" from "not looked at".
    withStore((store) => {
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 0 } },
        context(),
      );

      expect(entry.states['count']).toBe('measured');
      expect(storedRow(store).properties_json).toBe('{"count":0}');
      expect(findEntry(store.db, 'e1')?.properties['count']).toBe(0);
    });
  });

  it('stores an explicit N/A in `na`, and NOT as a value', () => {
    withStore((store) => {
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed', na: ['count'] },
        context(),
      );

      expect(entry.states['count']).toBe('not_applicable');
      expect(storedRow(store)).toMatchObject({ properties_json: '{}', na_json: '["count"]' });
    });
  });

  it('leaves a NOT MEASURED property ABSENT from both documents', () => {
    // The third state has no encoding at all, and that is the encoding. Writing a `0`
    // or a null here -- or listing every unmentioned property in `na` -- would destroy
    // the distinction between "we did not measure this" and "this does not apply".
    withStore((store) => {
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed', properties: { summary: 'ok' } },
        context(),
      );

      expect(entry.states).toEqual({
        count: 'not_measured',
        outcome: 'not_measured',
        summary: 'measured',
      });
      expect(storedRow(store)).toMatchObject({
        properties_json: '{"summary":"ok"}',
        na_json: '[]',
      });
    });
  });

  it('resolves all three states at once, in one entry', () => {
    withStore((store) => {
      const { entry } = recordEntry(
        store.db,
        {
          type: 'review_completed',
          properties: { count: 3, outcome: 'approved' },
          na: ['summary'],
        },
        context(),
      );

      expect(entry.states).toEqual({
        count: 'measured',
        outcome: 'measured',
        summary: 'not_applicable',
      });
      // And the same three states come back off disk, derived from the definition this
      // entry names rather than from the type's latest version.
      expect(findEntry(store.db, 'e1')?.states).toEqual(entry.states);
    });
  });
});

describe('a rejected recording writes NOTHING', () => {
  it('refuses a value of the wrong type', () => {
    withStore((store) => {
      expect(() =>
        recordEntry(
          store.db,
          { type: 'review_completed', properties: { count: 'three' } },
          context(),
        ),
      ).toThrow(EntryRejectedError);
      expect(countEntries(store)).toBe(0);
    });
  });

  it('names the problem and the fix, so a recorder can correct itself', () => {
    // An error that only says "invalid" costs a round trip. This is the message an LLM
    // reads on stderr.
    withStore((store) => {
      try {
        recordEntry(
          store.db,
          { type: 'review_completed', properties: { outcome: 'maybe' } },
          context(),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('outcome');
        expect(message).toContain('asc record review_completed');
        expect(message).toMatch(/approved|rejected/);
      }
    });
  });

  it('refuses a required property with no decision', () => {
    // Required means a VALUE OR AN EXPLICIT N/A. Only silence is refused -- if it meant
    // "must have a value", a model facing an inapplicable property would invent one.
    const spec: TypeSpec = {
      name: 'review_completed',
      properties: [{ name: 'reviewer', type: 'string', required: true }],
    };

    withStore((store) => {
      expect(() => recordEntry(store.db, { type: 'review_completed' }, context())).toThrow(
        EntryRejectedError,
      );

      // ...and an explicit N/A satisfies it.
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed', na: ['reviewer'] },
        context(),
      );
      expect(entry.states['reviewer']).toBe('not_applicable');
    }, spec);
  });

  it('refuses a property that is both measured and not applicable', () => {
    // Storing this would put one entry in two states at once, which is the ambiguity
    // the whole three-state model exists to remove.
    withStore((store) => {
      expect(() =>
        recordEntry(
          store.db,
          { type: 'review_completed', properties: { count: 1 }, na: ['count'] },
          context(),
        ),
      ).toThrow(EntryRejectedError);
      expect(countEntries(store)).toBe(0);
    });
  });

  it('refuses an unregistered type, naming what IS registered', () => {
    withStore((store) => {
      try {
        recordEntry(store.db, { type: 'review_started' }, context());
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnknownTypeError);
        expect((error as Error).message).toContain('review_completed');
      }
    });
  });

  it('refuses a version of a registered type that does not exist', () => {
    withStore((store) => {
      expect(() =>
        recordEntry(store.db, { type: 'review_completed', version: 2 }, context()),
      ).toThrow(UnknownTypeError);
    });
  });

  it('refuses a duplicate id rather than overwriting the original', () => {
    // Entries are immutable, so a re-run under the same id must not silently replace a
    // record. The original is the record; the second attempt is the error.
    withStore((store) => {
      recordEntry(store.db, { type: 'review_completed', properties: { count: 1 } }, context());

      expect(() =>
        recordEntry(store.db, { type: 'review_completed', properties: { count: 999 } }, context()),
      ).toThrow(DuplicateEntryError);

      expect(countEntries(store)).toBe(1);
      expect(findEntry(store.db, 'e1')?.properties['count']).toBe(1);
    });
  });
});

describe('the envelope refuses what the schema would only fail on', () => {
  it('refuses an empty string where NULL means unknown', () => {
    // The schema CHECK would catch this too, but as a constraint failure naming a
    // column. Caught here, the message says what to do instead.
    withStore((store) => {
      for (const field of ['cwd', 'repo', 'gitSha', 'branch', 'evidenceText', 'runId']) {
        expect(
          () => recordEntry(store.db, { type: 'review_completed' }, context({ [field]: '' })),
          `${field} should reject ''`,
        ).toThrow(/empty string is a real value in SQLite/);
      }
      expect(countEntries(store)).toBe(0);
    });
  });

  it('refuses an empty id', () => {
    withStore((store) => {
      expect(() =>
        recordEntry(store.db, { type: 'review_completed' }, context({ id: '' })),
      ).toThrow(TypeError);
    });
  });

  it('refuses a timestamp that is not UTC', () => {
    // recorded_at is TEXT and ordered as text, so a +02:00 offset would sort before an
    // earlier Z instant. Mixed zones would make the ledger's chronology depend on which
    // zone each recorder ran in.
    withStore((store) => {
      for (const recordedAt of [
        '2026-09-11T12:00:00+02:00',
        '2026-09-11T10:00:00',
        '2026-09-11',
        'yesterday',
      ]) {
        expect(
          () => recordEntry(store.db, { type: 'review_completed' }, context({ recordedAt })),
          `${recordedAt} should be refused`,
        ).toThrow(/ISO-8601 UTC/);
      }
      expect(countEntries(store)).toBe(0);
    });
  });

  it('accepts a UTC timestamp with and without milliseconds', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: 'review_completed' },
        context({ id: 'a', recordedAt: '2026-09-11T10:00:00Z' }),
      );
      recordEntry(
        store.db,
        { type: 'review_completed' },
        context({ id: 'b', recordedAt: '2026-09-11T10:00:00.500Z' }),
      );
      expect(countEntries(store)).toBe(2);
    });
  });
});

describe('warnings annotate; they never block', () => {
  it('records an entry that offers an undeclared property, and reports the drop', () => {
    withStore((store) => {
      const { entry, warnings } = recordEntry(
        store.db,
        { type: 'review_completed', properties: { count: 1, nonsense: 'x' } },
        context(),
      );

      expect(warnings.map((w) => w.field)).toEqual(['nonsense']);
      expect(entry.properties).toEqual({ count: 1 });
      expect(countEntries(store)).toBe(1);
    });
  });

  it('records into a deprecated type, and says so', () => {
    // Deprecation means "prefer something else", not "invalid". Refusing here would
    // lose an observation in order to enforce a preference.
    withStore((store) => {
      store.db
        .prepare("UPDATE entry_types SET status = 'deprecated' WHERE name = 'review_completed'")
        .run();

      const { warnings } = recordEntry(store.db, { type: 'review_completed' }, context());

      expect(warnings.map((w) => w.problem)).toContain('review_completed is deprecated');
      expect(countEntries(store)).toBe(1);
    });
  });

  it('records an entry where every property is N/A, and flags it', () => {
    withStore((store) => {
      const { warnings } = recordEntry(
        store.db,
        { type: 'review_completed', na: ['count', 'outcome', 'summary'] },
        context(),
      );
      expect(warnings.map((w) => w.problem).join(' ')).toContain('every property');
      expect(countEntries(store)).toBe(1);
    });
  });
});

describe('stored bytes are a function of the observation alone', () => {
  it('serializes properties canonically, so key order cannot change the row', () => {
    // `asc export` writes these rows out and later tools diff them. Two recorders that
    // offered the same values in a different order must not produce different bytes.
    withStore((store) => {
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { summary: 'ok', count: 2, outcome: 'approved' } },
        context({ id: 'a' }),
      );
      recordEntry(
        store.db,
        { type: 'review_completed', properties: { outcome: 'approved', count: 2, summary: 'ok' } },
        context({ id: 'b' }),
      );

      expect(storedRow(store, 'a').properties_json).toBe(storedRow(store, 'b').properties_json);
      expect(storedRow(store, 'a').properties_json).toBe(
        '{"count":2,"outcome":"approved","summary":"ok"}',
      );
    });
  });

  it('sorts `na`, which is a set', () => {
    withStore((store) => {
      recordEntry(
        store.db,
        { type: 'review_completed', na: ['summary', 'count'] },
        context({ id: 'a' }),
      );
      expect(storedRow(store, 'a').na_json).toBe('["count","summary"]');
    });
  });
});

describe('reading entries back', () => {
  it('returns undefined for an id that was never recorded', () => {
    withStore((store) => {
      expect(findEntry(store.db, 'nope')).toBeUndefined();
    });
  });

  it('reports an integrity failure when a row violates its own definition', () => {
    // The foreign key guarantees the row names a real definition; it cannot guarantee
    // the row SATISFIES one. Reaching this state means something wrote an entry without
    // going through the recorder -- so it must be loud, not returned as data.
    withStore((store) => {
      recordEntry(store.db, { type: 'review_completed' }, context());
      // A required property is added to the definition the entry already names. The
      // trigger permits no such edit, so this has to bypass the API entirely.
      store.db.exec('DROP TRIGGER entry_types_identity_is_immutable');
      store.db.prepare("UPDATE entry_types SET spec_json = ? WHERE name = 'review_completed'").run(
        JSON.stringify({
          name: 'review_completed',
          properties: [{ name: 'ghost', type: 'string', required: true }],
        }),
      );

      expect(() => findEntry(store.db, 'e1')).toThrow(/does not satisfy review_completed/);
    });
  });
});

/**
 * A property named `constructor` end to end: definition, refusal, N/A, value, projection.
 *
 * Measured before the fix, through this same API: `validateEntry` resolved `constructor` to
 * `measured` from `Object.prototype` alone, so a REQUIRED `constructor` property was satisfied
 * by recording nothing -- the ledger held `properties_json = {"real":"yes"}` with
 * `json_extract(..., '$.constructor')` reading `null` while validation reported ok. The
 * correct repair was refused too: `--na constructor` came back as "both measured and listed
 * as not applicable". Both halves are asserted here, at the API a caller actually uses.
 *
 * It is not a synthetic name. `constructor` is an ordinary word in this product's own domain
 * (a code-analysis type records which constructor a finding was attributed to), and
 * `core/test/state.test.ts` proves it is the ONE `Object.prototype` member that survives
 * `canonicalName` -- so it is the whole reachable surface, not one example of it.
 */
describe('a property named `constructor` is an ordinary property', () => {
  const CONSTRUCTOR_SPEC: TypeSpec = {
    name: 'constructor_probe',
    properties: [{ name: 'constructor', type: 'string', required: true }],
  };

  it('registers, because the name is not reserved', () => {
    withStore(() => undefined, CONSTRUCTOR_SPEC);
  });

  it('refuses a recording that leaves a required `constructor` undecided', () => {
    withStore((store) => {
      expect(() => recordEntry(store.db, { type: 'constructor_probe' }, context())).toThrow(
        EntryRejectedError,
      );
      expect(countEntries(store)).toBe(0);
    }, CONSTRUCTOR_SPEC);
  });

  it('accepts an explicit N/A, and reads it back as not_applicable', () => {
    withStore((store) => {
      recordEntry(store.db, { type: 'constructor_probe', na: ['constructor'] }, context());
      expect(storedRow(store).properties_json).toBe('{}');
      expect(storedRow(store).na_json).toBe('["constructor"]');
      expect(findEntry(store.db, 'e1')?.states['constructor']).toBe('not_applicable');
    }, CONSTRUCTOR_SPEC);
  });

  it('stores a measured value the ledger and the read path both return', () => {
    withStore((store) => {
      const recorded = recordEntry(
        store.db,
        { type: 'constructor_probe', properties: { constructor: 'Widget' } },
        context(),
      );
      expect(recorded.entry.states['constructor']).toBe('measured');
      expect(storedRow(store).properties_json).toBe('{"constructor":"Widget"}');
      expect(findEntry(store.db, 'e1')?.properties['constructor']).toBe('Widget');
    }, CONSTRUCTOR_SPEC);
  });

  it('projects the value into the generated view, under its own name', () => {
    // The reserved-name vocabulary exists because a property whose name the envelope or the
    // `<property>_state` suffix already occupies would make the view read the wrong column.
    // `constructor` occupies neither, so the column must be the property's own -- and the
    // only way to know is to select it, since the name is also a JavaScript prototype member
    // and a projection built by string concatenation could quietly collide here.
    withStore((store) => {
      recordEntry(
        store.db,
        { type: 'constructor_probe', properties: { constructor: 'Widget' } },
        context(),
      );
      const row = store.db
        .prepare('SELECT constructor, constructor_state FROM v_constructor_probe_v1')
        .get() as { constructor: string; constructor_state: string };
      expect(row.constructor).toBe('Widget');
      expect(row.constructor_state).toBe('measured');
    }, CONSTRUCTOR_SPEC);
  });
});

/**
 * The one-recorder discipline, and the injected-clock rule, both enforced by reading the
 * package's own source. These are the two invariants that a future edit is most likely to
 * break silently -- a second `INSERT INTO entries` compiles and passes every behavioural
 * test in this file, and a `Date.now()` default is invisible until a test goes flaky.
 */
describe('exactly one write path, and no ambient clock', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));

  const sources = (): { file: string; source: string }[] =>
    readdirSync(SRC)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ file: name, source: readFileSync(join(SRC, name), 'utf8') }));

  /**
   * Remove comments, so prose ABOUT a banned token is not read as the token itself.
   *
   * Block comments first, then line comments. Deliberately not a full parser: it does not
   * track string literals, so a `//` inside a string would truncate a line and could hide
   * a violation after it. Checked against the sources in this package -- there is no `//`
   * in any string or expression here -- and the two tests below are what keep that
   * assumption honest: one proves a REAL violation is still caught, the other proves a
   * comment mentioning the token is not a false positive.
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const scan = (source: string, pattern: RegExp): number[] =>
    stripComments(source)
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => pattern.test(line))
      .map(({ index }) => index + 1);

  const CLOCK =
    /Date\.now\s*\(|new Date\s*\(|Math\.random\s*\(|randomUUID\s*\(|performance\.now|hrtime/;
  const WRITE = /INSERT\s+INTO\s+entries\b/i;

  it('catches a real violation, in code, not in a comment', () => {
    // The detection logic itself, shown to fire and shown not to over-fire. Without this,
    // the two assertions below would be indistinguishable from a scan that matches nothing.
    expect(scan('const t = Date.now();', CLOCK)).toEqual([1]);
    expect(scan('const r = Math.random();', CLOCK)).toEqual([1]);
    expect(scan('db.prepare("INSERT INTO entries (id) VALUES (?)");', WRITE)).toEqual([1]);
    expect(scan('// we never call Date.now() here\nconst ok = 1;', CLOCK)).toEqual([]);
    expect(
      scan('/* INSERT INTO entries is banned outside the recorder */\nconst ok = 1;', WRITE),
    ).toEqual([]);
    expect(scan('const sql = "SELECT * FROM entries";', WRITE)).toEqual([]);
  });

  it('writes entries from exactly one module', () => {
    const writers = sources()
      .filter(({ source }) => scan(source, WRITE).length > 0)
      .map(({ file }) => file);
    // Named, not counted: if this ever fails, the message should say where the second
    // write path appeared.
    expect(writers).toEqual(['recorder.ts']);
  });

  it('reads no clock and draws no randomness, in any module', () => {
    // Time and IDs are injected at the command boundary. A default here would make the
    // store's output depend on when it ran, which is exactly what an entry ledger must
    // not do -- and it would make this package's own tests time-dependent.
    const offenders = sources()
      .map(({ file, source }) => ({ file, lines: scan(source, CLOCK) }))
      .filter(({ lines }) => lines.length > 0);
    expect(offenders).toEqual([]);
  });
});

describe('prose is editable without touching recorded entries', () => {
  it('leaves an already-recorded entry attached through a prose rewrite', () => {
    // The identity exclusion seen from the storage side: because prose is not hashed,
    // improving the wording cannot detach the corpus that was recorded under it.
    withStore((store) => {
      const { entry } = recordEntry(store.db, { type: 'review_completed' }, context());

      updateTypeProse(store.db, 'review_completed', 1, { recordWhen: 'reworded' });

      expect(findEntry(store.db, 'e1')?.typeHash).toBe(entry.typeHash);
      expect(countEntries(store)).toBe(1);
    });
  });
});

describe('a property added in a later minor version', () => {
  it('records against the version whose property list declares it', () => {
    // The general case the views union across: v2 adds `reviewer`, and an entry naming v2
    // is validated by v2's definition while the entry already on v1 is untouched.
    const added: PropertySpec = { name: 'reviewer', type: 'string' };
    withStore((store) => {
      registerType(
        store.db,
        { ...SPEC, properties: [...SPEC.properties, added] },
        {
          registeredAt: AT,
        },
      );
      const { entry } = recordEntry(
        store.db,
        { type: 'review_completed', version: 2, properties: { reviewer: 'sam' } },
        context(),
      );
      expect(entry.typeVersion).toBe(2);
      expect(entry.states['reviewer']).toBe('measured');
    });
  });
});
