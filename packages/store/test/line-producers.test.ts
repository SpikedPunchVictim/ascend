import type { TypeSpec } from '@ascend/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  corpusLines,
  deprecateType,
  DuplicateEntryError,
  openStore,
  produceLines,
  recordAnnotations,
  recordEntry,
  recordInvalidation,
  registerScheme,
  registerType,
  serializeCorpus,
  typeVersions,
  type CorpusLine,
  type EntryLine,
  type Store,
} from '../src/index.js';

/**
 * The producers: the lines a write WOULD produce, with nothing written.
 *
 * **The claim under test is an equivalence, and it is the one that makes E12.4b survivable**: the
 * producer's line and the line `corpusLines` reads back after the same write has really happened are
 * the same bytes. If they can differ, then the tree a write appends and the corpus an export
 * reproduces are two answers to one question, and the failure is invisible -- both paths report
 * success, and the disagreement surfaces later as records that will not round-trip.
 *
 * **"Nothing was written" is asserted on the STORE, not on a return value.** A producer that wrote
 * the row and reported only the line would pass every equivalence test in this file while making
 * every write a duplicate -- which the last test of each block is what turns into a failure rather
 * than a theory: the real write after a probe must not meet `DuplicateEntryError`.
 *
 * **The first block is the one this file was missing.** Every other test here makes a SINGLE
 * production, and a single-call equivalence test cannot fail for the reason the first version of
 * `line-producers.ts` was broken: five producers that each opened their own `withRollback` are
 * perfectly equivalent one call at a time and cannot be sequenced, which is the only way any real
 * write site calls them. The failures it was green through, verbatim:
 *
 * ```
 * asc annotate    SchemeError: annotation scheme 'screening' has no version 1. Its versions: (none).
 * asc import      expected [ 1, 1 ] to deeply equal [ 1, 2 ]
 * asc invalidate  expected [ 2, 2 ] to deeply equal [ 2, 1 ]
 * ```
 *
 * Each is reproduced below as a passing test. They are the reason `produceLines` exists and the five
 * single-production functions are private: the defect was not "a case is untested", it was "the
 * public shape permits a sequence that cannot work", and only a shape change retires it.
 */

const stores: Store[] = [];
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asc-line-producers-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const AT = '2026-09-29T10:00:00.000Z';

const uuid = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** A store with a schema and nothing in it: the fixture a type producer needs. */
function empty(): Store {
  const store = openStore({ dir: scratch(), ascendVersion: '0.1.0' });
  stores.push(store);
  return store;
}

/** A store with one type registered and no entries -- built through its own writers. */
function seeded(): Store {
  const store = empty();
  registerType(
    store.db,
    { name: 'note', properties: [{ name: 'body', type: 'text' }] },
    { registeredAt: AT },
  );
  return store;
}

/** A store with one type and one entry -- the least a pass or an invalidation can name. */
function recorded(): Store {
  const store = seeded();
  recordEntry(store.db, request, context);
  return store;
}

/** A store with one entry and a scheme to label it under. */
function annotated(): Store {
  const store = recorded();
  registerScheme(store.db, 'screening', SCHEME_SPEC, { createdAt: AT });
  return store;
}

const request = { type: 'note', version: 1, properties: { body: 'the body' } };
const context = { id: uuid(1), recordedAt: AT, ascendVersion: '0.1.0' };

// Annotated rather than inferred: written inline at the call the literal is contextually typed, but
// held in a `const` its `type: 'text'` widens to `string` and stops being a `TypeSpec`.
const TODO: TypeSpec = { name: 'todo', properties: [{ name: 'body', type: 'text' }] };
const TODO_V2: TypeSpec = {
  name: 'todo',
  properties: [
    { name: 'body', type: 'text' },
    { name: 'done', type: 'boolean' },
  ],
};
const options = { registeredAt: AT };

/**
 * The ENTRY lines in a store's corpus.
 *
 * `corpusLines` answers with every kind, and the fixture's registered type is a line of its own, so
 * `corpusLines(db)` is never empty -- an assertion written against it would pass for a producer that
 * inserted nothing and fail for one that inserted nothing but did so after a type was registered.
 */
function entriesOf(store: Store): readonly EntryLine[] {
  return corpusLines(store.db).filter((line): line is EntryLine => line.kind === 'entry');
}

/** The one entry line in a corpus, or a failure that says so rather than an `undefined` later. */
function onlyEntry(lines: readonly CorpusLine[]): EntryLine {
  const found = lines.filter((line): line is EntryLine => line.kind === 'entry');
  expect(found).toHaveLength(1);
  return found[0] as EntryLine;
}

/** A line's bytes, the unit the tree holds and the export prints. */
function bytesOf(lines: readonly CorpusLine[]): readonly string[] {
  return lines.map((line) => serializeCorpus([line]));
}

/**
 * The lines `after` holds that `before` did not, in the order `after` holds them.
 *
 * The equivalence below is asserted against this rather than against the whole corpus, because the
 * fixtures register a type and record an entry before the producer is asked for anything -- so "the
 * lines the write added" is the only statement that means the same thing for all five producers. It
 * is a multiset difference rather than a filter on kind, so a producer that emitted an extra line of
 * a kind the fixture happens to have would be caught rather than absorbed.
 */
function added(before: readonly string[], after: readonly string[]): readonly string[] {
  const pool = [...before];
  const fresh: string[] = [];

  for (const line of after) {
    const at = pool.indexOf(line);
    if (at === -1) fresh.push(line);
    else pool.splice(at, 1);
  }

  return fresh;
}

/**
 * What the producer said, next to what the same write actually added to the corpus.
 *
 * Both directions of the equivalence in one call, so neither can hold alone: a producer that emitted
 * a line the export would not is a difference here, and so is a write that added a line the producer
 * never mentioned -- which is the shape a producer missing a case would take.
 */
function expectSameLines(
  store: Store,
  before: readonly string[],
  lines: readonly CorpusLine[],
): void {
  expect(bytesOf(lines)).toEqual(added(before, bytesOf(corpusLines(store.db))));
}

const SCHEME_SPEC = { labels: ['yes', 'no'], rules: [] };

const pass = {
  scheme: 'screening',
  schemeVersion: 1,
  annotations: [{ id: uuid(11), entryId: uuid(1), label: 'yes' }],
};
const passContext = { createdAt: '2026-09-29T11:00:00.000Z', createdBy: 'claude-code' };

const invalidation = {
  entryId: uuid(1),
  label: 'wrong_value',
  reason: 'the measurement was unusable',
  createdAt: AT,
} as const;

describe('a sequence of productions', () => {
  it('gives each production the state the one before it left, so versions count up', () => {
    const store = empty();

    const produced = produceLines(store.db, (produce) => [
      produce.type(TODO, options).version,
      produce.type(TODO_V2, options).version,
    ]);

    // `[ 1, 1 ]` is the failure this replaced, and it is what a rollback per production computes:
    // the second registration reads a store where the first never happened.
    expect(produced.result).toEqual([1, 2]);
    expect(produced.lines).toHaveLength(2);
    expect(produced.lines.map((line) => line.kind)).toEqual(['type', 'type']);
  });

  it('lets a pass see the scheme registered earlier in the same sequence', () => {
    const store = recorded();

    const produced = produceLines(store.db, (produce) => {
      produce.scheme('screening', SCHEME_SPEC, { createdAt: AT });
      return produce.annotation(pass, passContext);
    });

    // `asc annotate` does exactly this, and it is why the fix is a shape rather than a test: the
    // SchemeError it raised named a scheme that this same body had just registered.
    expect(produced.result.schemeVersion).toBe(1);
    expect(produced.lines.map((line) => line.kind)).toEqual(['scheme', 'annotation']);
  });

  it('appends the reserved scheme line once, however many claims a batch carries', () => {
    const store = recorded();
    recordEntry(store.db, request, { ...context, id: uuid(2) });

    const produced = produceLines(store.db, (produce) => [
      produce.invalidation(invalidation),
      produce.invalidation({
        ...invalidation,
        entryId: uuid(2),
        reason: 'a different claim entirely',
      }),
    ]);

    // `[ 'scheme', 'annotation', 'scheme', 'annotation' ]` is the failure this replaced -- measured
    // by reverting `produceLines` to a rollback per production, not guessed. A duplicate scheme line
    // is permanent: the tree is a `merge=union` file and nothing collapses it.
    expect(produced.lines.map((line) => line.kind)).toEqual(['scheme', 'annotation', 'annotation']);
    expect(produced.result.map((claim) => claim.created)).toEqual([true, true]);
  });

  it('discards the whole sequence, so the writes that follow it are not duplicates', () => {
    const store = recorded();
    const before = corpusLines(store.db);

    produceLines(store.db, (produce) => {
      produce.type(TODO, options);
      produce.entry(request, { ...context, id: uuid(2) });
      produce.scheme('screening', SCHEME_SPEC, { createdAt: AT });
      produce.annotation(pass, passContext);
      produce.invalidation(invalidation);
    });

    // Every one of the five, in one transaction: the corpus is unchanged in every kind, not just in
    // the kind the last production touched.
    expect(corpusLines(store.db)).toEqual(before);

    // And the negative control the equality above cannot give -- a probe that committed would leave
    // the corpus looking right here and fail at the next real write, with `DuplicateEntryError`.
    expect(() => recordEntry(store.db, request, { ...context, id: uuid(2) })).not.toThrow();
  });
});

describe('an entry producer', () => {
  it('writes nothing, and leaves the corpus exactly as it was', () => {
    const store = seeded();

    const produced = produceLines(store.db, (produce) => produce.entry(request, context));

    // The whole store, as lines: a producer that inserted and rolled back a DIFFERENT row would be
    // caught here, where a count of entries would not.
    expect(entriesOf(store)).toEqual([]);
    expect(produced.lines).toHaveLength(1);
  });

  it('returns the same bytes the export produces for the same write, once it is made', () => {
    const store = seeded();

    const produced = produceLines(store.db, (produce) => produce.entry(request, context));
    recordEntry(store.db, request, context);
    const readBack = onlyEntry(corpusLines(store.db));

    // Byte-for-byte through the serializer, not a field-by-field comparison: `serializeCorpus` is
    // what a tree file contains and what an export prints, so a difference it does not see is not
    // one the round trip will find either.
    expect(serializeCorpus(produced.lines)).toBe(serializeCorpus([readBack]));
  });

  it('hands back what the writer reported, warnings included', () => {
    const store = seeded();
    deprecateType(store.db, 'note');

    const produced = produceLines(store.db, (produce) => produce.entry(request, context));

    // A deprecated type is a warning rather than a refusal (`recorder.ts`), so the entry is still
    // produced -- and `result` is where the caller learns to mention it. That is the half a
    // lines-only producer would drop, and it is why `ProducedLines` carries the result at all.
    expect(produced.result.entry.id).toBe(uuid(1));
    expect(produced.result.warnings.map((issue) => issue.problem)).toContain('note is deprecated');
    expect(produced.lines).toHaveLength(1);
  });

  it('leaves the id available, so the write that follows is not a duplicate', () => {
    const store = seeded();

    produceLines(store.db, (produce) => produce.entry(request, context));

    // The negative control for "nothing was written": the row a rolled-back probe inserted is gone,
    // so the real write succeeds. A producer that committed would fail here with the same error a
    // genuine double-record produces, which is exactly what a caller must never see from a preview.
    expect(() => recordEntry(store.db, request, context)).not.toThrow();
    expect(() => recordEntry(store.db, request, context)).toThrow(DuplicateEntryError);
  });

  it('refuses exactly what the writer refuses, before anything has been written', () => {
    const store = seeded();

    // Validation is the writer's, not a second copy of it -- so an unknown type refuses here for the
    // same reason and with the same error it would at the write.
    expect(() =>
      produceLines(store.db, (produce) => produce.entry({ type: 'absent', version: 1 }, context)),
    ).toThrow(/no entry type/i);
    expect(entriesOf(store)).toEqual([]);
  });
});

describe('a type producer', () => {
  it('returns the same bytes the export produces for the same registration, once it is made', () => {
    const store = empty();
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.type(TODO, options));
    registerType(store.db, TODO, options);

    expectSameLines(store, before, produced.lines);
  });

  it('produces no line for a definition the store already holds', () => {
    const store = empty();
    registerType(store.db, TODO, options);
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.type(TODO, options));

    // `unchanged` is the writer's answer, and the export already carries that version's line -- so
    // emitting one here would append a duplicate on every re-run of a script that registers its own
    // definitions. The tree is a `merge=union` file; duplicates accumulate rather than collapse.
    expect(produced.result.outcome).toBe('unchanged');
    expect(produced.lines).toEqual([]);
    expect(bytesOf(corpusLines(store.db))).toEqual(before);
  });
});

describe('a deprecation producer', () => {
  it('returns the same bytes the export produces for the same retirement, once it is made', () => {
    const store = seeded();
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.deprecate('note'));
    deprecateType(store.db, 'note');

    // The retirement is a LINE, and this is the equivalence every other producer here earns: the
    // bytes the producer hands the tree are the bytes the export reads back out of the store. A
    // status the row carried and `documentFromRow` did not was exactly the defect (2026-09-29): the
    // index said `deprecated`, the tree had nothing, and a rebuild gave the type back `active`.
    expect(produced.result.changed).toBe(1);
    expectSameLines(store, before, produced.lines);
  });

  it('emits a repeat of a version the tree already holds, so no version is minted', () => {
    const store = seeded();
    const registration = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.deprecate('note'));

    // One line, and it is a SECOND line for version 1 rather than a line for version 2 -- which is
    // the whole mechanism. `deprecateType` mints nothing (a retirement is not a shape change), so the
    // only way the fact can reach the tree is a repeat of a pair the tree already carries, exactly as
    // a prose edit is (`typeLines`, and `replayType`'s `pendingProseUpdate` on the way back in).
    const line = produced.lines[0] as { document: { name: string; status?: string } };
    expect(produced.lines).toHaveLength(1);
    expect(produced.lines[0]?.kind).toBe('type');
    expect(line.document.name).toBe('note');
    expect(line.document.status).toBe('deprecated');
    // The identity is untouched: `documentSpec` is name and properties, so a retirement cannot
    // invalidate an entry recorded under the type. Asserted rather than argued, because the failure
    // would be silent -- a retirement that minted a version would leave `type_hash` different from
    // the one three thousand entries were recorded against.
    expect(typeVersions(store.db, 'note').map((row) => row.version)).toEqual([1]);
    expect(bytesOf(corpusLines(store.db))).toEqual(registration);
  });

  it('produces no line for a type that is already retired', () => {
    const store = seeded();
    deprecateType(store.db, 'note');
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.deprecate('note'));

    // `deprecateType` answers the same `0` for this and for an unknown name, and both mean the same
    // thing to a producer: there is nothing this write added, so there is no line. A caller that
    // needs to tell the two apart reads the status itself (`asc types deprecate` does, and that is
    // why its refusal names the types that exist).
    expect(produced.result.changed).toBe(0);
    expect(produced.lines).toEqual([]);
    expect(bytesOf(corpusLines(store.db))).toEqual(before);
  });
});

describe('a scheme producer', () => {
  it('returns the same bytes the export produces for the same registration, once it is made', () => {
    const store = empty();
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) =>
      produce.scheme('screening', SCHEME_SPEC, { createdAt: AT }),
    );
    registerScheme(store.db, 'screening', SCHEME_SPEC, { createdAt: AT });

    // This one reads no row back -- `RegisteredScheme` carries the spec the hash is taken over -- so
    // the equivalence it has to earn is that the spec it returns is the spec the export reads back.
    // A normalization applied on the way in and not on the way out would show up exactly here.
    expectSameLines(store, before, produced.lines);
  });

  it('produces no line for a shape the store already holds', () => {
    const store = empty();
    registerScheme(store.db, 'screening', SCHEME_SPEC, { createdAt: AT });

    const produced = produceLines(store.db, (produce) =>
      produce.scheme('screening', SCHEME_SPEC, { createdAt: AT }),
    );

    expect(produced.result.outcome).toBe('unchanged');
    expect(produced.lines).toEqual([]);
  });
});

describe('an annotation producer', () => {
  it('returns the same bytes the export produces for the same pass, once it is made', () => {
    const store = annotated();
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.annotation(pass, passContext));
    recordAnnotations(store.db, pass, passContext);

    expectSameLines(store, before, produced.lines);
  });

  it('refuses a pass the store already has, exactly as the writer does', () => {
    const store = annotated();
    recordAnnotations(store.db, pass, passContext);
    const before = bytesOf(corpusLines(store.db));

    // A pass IS its timestamp, so the second write at one timestamp is refused by the writer rather
    // than being a producer-specific rule -- and the refusal reaches the producer because the
    // producer is the writer, run and undone.
    expect(() =>
      produceLines(store.db, (produce) => produce.annotation(pass, passContext)),
    ).toThrow(/already has a pass/i);
    expect(bytesOf(corpusLines(store.db))).toEqual(before);
  });
});

describe('an invalidation producer', () => {
  it('carries the reserved scheme line the first invalidation brings with it', () => {
    const store = recorded();
    const before = bytesOf(corpusLines(store.db));

    const produced = produceLines(store.db, (produce) => produce.invalidation(invalidation));
    recordInvalidation(store.db, invalidation);

    // TWO lines, and the tree cannot be built from one: the annotation names the reserved scheme,
    // and `import` rebuilds that scheme from a scheme LINE (`restoreInvalidationScheme`). A producer
    // that emitted only the annotation would produce a tree the store's own import refuses.
    expect(produced.lines.map((line) => line.kind)).toEqual(['scheme', 'annotation']);
    expectSameLines(store, before, produced.lines);
  });

  it('carries no second scheme line once the reserved scheme is registered', () => {
    const store = recorded();
    recordEntry(store.db, request, { ...context, id: uuid(2) });
    recordInvalidation(store.db, invalidation);
    const before = bytesOf(corpusLines(store.db));

    const second = { ...invalidation, entryId: uuid(2), reason: 'a different claim entirely' };
    const produced = produceLines(store.db, (produce) => produce.invalidation(second));
    recordInvalidation(store.db, second);

    // The scheme line is the one this write ADDED, not "the reserved scheme exists" -- so the answer
    // is empty here, and stays empty for every invalidation after the first.
    expect(produced.lines.map((line) => line.kind)).toEqual(['annotation']);
    expectSameLines(store, before, produced.lines);
  });

  it('produces nothing for a claim the store already holds', () => {
    const store = recorded();
    recordInvalidation(store.db, invalidation);

    const produced = produceLines(store.db, (produce) => produce.invalidation(invalidation));

    // The id is derived from the CLAIM and not from the clock, so recording the same claim at a
    // different moment is the no-op `RecordedInvalidation.created` exists to report. Nothing was
    // written, so nothing is appended.
    expect(produced.result.created).toBe(false);
    expect(produced.lines).toEqual([]);
  });
});
