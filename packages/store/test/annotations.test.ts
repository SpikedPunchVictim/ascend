import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnnotationError,
  annotationPasses,
  annotationRows,
  INVALIDATION_LABELS,
  listInvalidations,
  listSchemes,
  matchingEntryIds,
  openStore,
  recordAnnotations,
  recordEntry,
  recordInvalidation,
  registerScheme,
  registerType,
  RESERVED_SCHEME,
  schemeCensus,
  schemeHash,
  SchemeError,
  withTransaction,
  type InvalidationLabel,
  type SchemeRuleKind,
  type SchemeSpec,
  type Store,
} from '../src/index.js';

/**
 * The annotation store, against a real file store.
 *
 * A real file rather than an in-memory stand-in for the same reason `registry.test.ts` gives, plus
 * one of its own: the properties this module claims are API-level guarantees -- version on shape
 * change, append-only, one pass per millisecond -- are exactly the ones the DDL does NOT enforce
 * (`annotation_schemes` carries no immutability trigger and `annotations` carries no uniqueness
 * constraint). If the DDL silently grew one of those while the API kept its own version, the tests
 * here would keep passing and the two would have diverged. They run against the same schema the
 * shipped store has.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-annotations-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-17T10:00:00.000Z';
const LATER = '2026-09-17T11:00:00.000Z';

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir() });
  try {
    body(store);
  } finally {
    store.close();
  }
};

const type: TypeSpec = { name: 'note', properties: [{ name: 'text', type: 'text' }] };

/** A registered type and N recorded entries, ids `e1`..`eN`. Annotations need something to be about. */
const seed = (store: Store, count: number): readonly string[] => {
  registerType(store.db, type, { registeredAt: AT });
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = `e${String(index + 1)}`;
    ids.push(id);
    recordEntry(
      store.db,
      { type: 'note', properties: { text: `entry ${String(index + 1)}` } },
      { id, recordedAt: AT, ascendVersion: '0.0.0' },
    );
  }

  return ids;
};

const spec = (labels: readonly string[], rules: SchemeSpec['rules'] = []): SchemeSpec => ({
  labels,
  rules,
});

describe('registering a scheme', () => {
  it('creates version 1, and re-registering the same shape creates nothing', () => {
    withStore((store) => {
      const first = registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });

      expect(first.version).toBe(1);
      expect(first.outcome).toBe('created');

      const again = registerScheme(store.db, 'review', spec(['bug']), { createdAt: LATER });

      expect(again.version).toBe(1);
      expect(again.outcome).toBe('unchanged');
      // The original registration time, not the second call's: nothing was written, so nothing
      // recorded that a later call ever happened.
      expect(again.createdAt).toBe(AT);
    });
  });

  it('mints a new version when a rule changes, and keeps the old one', () => {
    // The API guarantee this module exists for. A rule edit that reused a version number would
    // silently re-describe every classification already reported under it.
    withStore((store) => {
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });
      const second = registerScheme(
        store.db,
        'review',
        spec(['bug'], [{ label: 'bug', kind: 'sql', query: "text LIKE '%crash%'" }]),
        { createdAt: LATER },
      );

      expect(second.version).toBe(2);
      expect(second.outcome).toBe('created');
      // `listSchemes` reports the LATEST version, so a reader sees the rules in force rather than
      // every version the scheme has ever had.
      expect(listSchemes(store.db)).toEqual([
        { name: 'review', version: 2, createdAt: LATER, spec: second.spec },
      ]);
    });
  });

  it('treats a REVERT to an older shape as a new version, not as the old one', () => {
    // The departure from `registerType`, and the reason is visible here: v1's spec comes back, but
    // as v3. Returning v1 instead would adopt every annotation ever written under v1 -- which
    // described the corpus before the intervening change -- into a scheme that has moved since.
    withStore((store) => {
      const one = spec(['bug']);
      registerScheme(store.db, 'review', one, { createdAt: AT });
      registerScheme(store.db, 'review', spec(['bug', 'docs']), { createdAt: LATER });

      const reverted = registerScheme(store.db, 'review', one, { createdAt: LATER });

      expect(reverted.version).toBe(3);
      expect(reverted.outcome).toBe('created');
      expect(reverted.spec).toEqual({ labels: ['bug'], rules: [] });
    });
  });

  it('hashes the label set as a set and the rule list as a list', () => {
    // Labels are a vocabulary, so their order is the author's habit; rules are applied in order and
    // the first match wins, so their order decides what a scheme classifies.
    const a = { label: 'bug', kind: 'sql', query: '1=1' } as const;
    const b = { label: 'docs', kind: 'sql', query: '1=1' } as const;

    expect(schemeHash(spec(['docs', 'bug']))).toBe(schemeHash(spec(['bug', 'docs'])));
    expect(schemeHash(spec(['bug', 'docs'], [a, b]))).not.toBe(
      schemeHash(spec(['bug', 'docs'], [b, a])),
    );
  });

  it('refuses the reserved scheme name, and names the bead that owns it', () => {
    withStore((store) => {
      expect(() =>
        registerScheme(store.db, RESERVED_SCHEME, spec(['x']), { createdAt: AT }),
      ).toThrow(SchemeError);
      expect(() =>
        registerScheme(store.db, RESERVED_SCHEME, spec(['x']), { createdAt: AT }),
      ).toThrow(/asc-88m/);
    });
  });

  it('refuses a shape a rule could not be run from', () => {
    withStore((store) => {
      const bad =
        (value: unknown): (() => unknown) =>
        () =>
          registerScheme(store.db, 'review', value as SchemeSpec, { createdAt: AT });

      // A rule whose label is not in the vocabulary would write a label the scheme does not declare.
      expect(bad(spec(['bug'], [{ label: 'docs', kind: 'sql', query: '1=1' }]))).toThrow(
        /not in the scheme's vocabulary/,
      );
      // An empty predicate matches nothing, which reads as a rule that ran and found nothing.
      expect(bad(spec(['bug'], [{ label: 'bug', kind: 'sql', query: '' }]))).toThrow(
        /matches nothing/,
      );
      // The cast is the point: `regex` is outside `SchemeRuleKind`, so the type system would refuse
      // this rule before `registerScheme` ever saw it. The run-time check exists for the caller whose
      // scheme arrives as JSON, where no compiler is watching -- and that caller is the reason the
      // refusal is in `normalizeSpec` rather than in the type.
      expect(
        bad(spec(['bug'], [{ label: 'bug', kind: 'regex' as SchemeRuleKind, query: 'x' }])),
      ).toThrow(/which is not one of 'sql' or 'fts'/);
      // An empty label is a missing value wearing a value's clothes.
      expect(bad(spec(['']))).toThrow(/label is empty/);
      expect(bad(spec([], [{ label: 'bug', kind: 'sql', query: '1=1' }]))).toThrow(
        /not in the scheme's vocabulary/,
      );
    });
  });

  it('joins a caller transaction instead of nesting into one', () => {
    // `asc annotate` registers and writes in one transaction, so a nested BEGIN would be a hard
    // SQLite error on the command that needs this most.
    withStore((store) => {
      withTransaction(store.db, () => {
        const registered = registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });
        expect(registered.version).toBe(1);
      });

      expect(listSchemes(store.db).map((scheme) => scheme.name)).toEqual(['review']);
    });
  });

  it('rolls a registration back with the caller transaction that opened it', () => {
    // The other half of joining: if the caller rolls back, the scheme must not survive. A version
    // number that outlived its own transaction would be an annotation target with no rules behind
    // it.
    withStore((store) => {
      try {
        withTransaction(store.db, () => {
          registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });
          throw new Error('caller changed their mind');
        });
      } catch {
        // The caller's own error, expected.
      }

      expect(listSchemes(store.db)).toEqual([]);
    });
  });
});

describe('writing annotations', () => {
  it('writes a pass and reads it back with its value, confidence and note', () => {
    withStore((store) => {
      const ids = seed(store, 2);
      registerScheme(store.db, 'review', spec(['bug', 'docs']), { createdAt: AT });

      const written = recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [
            {
              id: 'a1',
              entryId: ids[0] as string,
              label: 'bug',
              value: { severity: 2 },
              confidence: 0.8,
            },
            {
              id: 'a2',
              entryId: ids[1] as string,
              label: 'docs',
              note: 'looked like a doc change',
            },
          ],
        },
        { createdAt: LATER, createdBy: 'claude-code' },
      );

      expect(written).toEqual({
        scheme: 'review',
        schemeVersion: 1,
        createdAt: LATER,
        count: 2,
      });

      const rows = annotationRows(store.db, { scheme: 'review' });

      expect(rows.map((row) => row.label)).toEqual(['bug', 'docs']);
      expect(rows[0]?.value).toEqual({ severity: 2 });
      expect(rows[0]?.confidence).toBe(0.8);
      expect(rows[1]?.value).toBeUndefined();
      expect(rows[1]?.confidence).toBeNull();
      expect(rows[1]?.note).toBe('looked like a doc change');
      expect(rows[0]?.createdBy).toBe('claude-code');
    });
  });

  it('keeps two passes apart, which is what makes them comparable', () => {
    withStore((store) => {
      const ids = seed(store, 2);
      registerScheme(store.db, 'review', spec(['bug', 'docs']), { createdAt: AT });

      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [
            { id: 'a1', entryId: ids[0] as string, label: 'bug' },
            { id: 'a2', entryId: ids[1] as string, label: 'bug' },
          ],
        },
        { createdAt: AT },
      );
      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [
            { id: 'b1', entryId: ids[0] as string, label: 'bug' },
            { id: 'b2', entryId: ids[1] as string, label: 'docs' },
          ],
        },
        { createdAt: LATER },
      );

      expect(annotationPasses(store.db, 'review')).toEqual([
        { createdAt: AT, count: 2, createdBy: null },
        { createdAt: LATER, count: 2, createdBy: null },
      ]);
      // The first pass's labels survive the second pass being written. Append-only is the whole
      // reason a scheme can be scored against itself.
      expect(
        annotationRows(store.db, { scheme: 'review', pass: AT }).map((row) => row.label),
      ).toEqual(['bug', 'bug']);
      expect(
        annotationRows(store.db, { scheme: 'review', pass: LATER }).map((row) => row.label),
      ).toEqual(['bug', 'docs']);
      // Ordered by pass before entry, which is what keeps a reader from seeing two passes
      // interleaved: ordering by `entry_id` first would emit AT's e1, LATER's e1, then AT's e2 --
      // each row still correct, and the sequence no longer a list of passes.
      expect(annotationRows(store.db, { scheme: 'review' }).map((row) => row.createdAt)).toEqual([
        AT,
        AT,
        LATER,
        LATER,
      ]);
    });
  });

  it('refuses two labels for one entry inside one pass', () => {
    // `annotations` has no uniqueness constraint, so this is writable and the refusal is an API
    // guarantee. It exists for the reader: `cohenKappa` pairs two raters by entry id and refuses a
    // rater who labelled an entry twice, so a stored pass with a duplicate is one nothing can read.
    withStore((store) => {
      const ids = seed(store, 1);
      registerScheme(store.db, 'review', spec(['bug', 'docs']), { createdAt: AT });

      expect(() =>
        recordAnnotations(
          store.db,
          {
            scheme: 'review',
            annotations: [
              { id: 'a1', entryId: ids[0] as string, label: 'bug' },
              { id: 'a2', entryId: ids[0] as string, label: 'docs' },
            ],
          },
          { createdAt: LATER },
        ),
      ).toThrow(/appears twice in one pass/);

      // And across passes it is ordinary, which is the line this draws: what is refused is one pass
      // disagreeing with itself, not a scheme being re-run.
      recordAnnotations(
        store.db,
        { scheme: 'review', annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }] },
        { createdAt: AT },
      );
      recordAnnotations(
        store.db,
        { scheme: 'review', annotations: [{ id: 'a2', entryId: ids[0] as string, label: 'docs' }] },
        { createdAt: LATER },
      );

      expect(annotationPasses(store.db, 'review').map((pass) => pass.count)).toEqual([1, 1]);
    });
  });

  it('finds a pass by its timestamp alone, without being told which version wrote it', () => {
    // A pass IS its timestamp (`recordAnnotations`), and that identity is only useful if a read can
    // be driven by it: a scheme that has been edited has passes under more than one version, so a
    // caller holding a pass timestamp would otherwise have to know the version to read back the pass
    // it already has.
    withStore((store) => {
      const ids = seed(store, 2);
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });
      recordAnnotations(
        store.db,
        { scheme: 'review', annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }] },
        { createdAt: AT },
      );

      // A rule change mints version 2, so AT's pass now sits under a version that is no longer
      // latest -- which is exactly the state the resolution exists for.
      registerScheme(
        store.db,
        'review',
        spec(['bug'], [{ label: 'bug', kind: 'sql', query: '1=1' }]),
        { createdAt: LATER },
      );
      recordAnnotations(
        store.db,
        { scheme: 'review', annotations: [{ id: 'b1', entryId: ids[1] as string, label: 'bug' }] },
        { createdAt: LATER },
      );

      expect(listSchemes(store.db)[0]?.version).toBe(2);
      expect(
        annotationRows(store.db, { scheme: 'review', pass: AT }).map((row) => row.entryId),
      ).toEqual([ids[0]]);
      // An explicit version still wins, so pinning stays possible and the resolution cannot quietly
      // override a caller who named one.
      expect(annotationRows(store.db, { scheme: 'review', version: 2, pass: AT })).toEqual([]);
      // With no pass and no version the answer is the latest version, unchanged.
      expect(annotationRows(store.db, { scheme: 'review' }).map((row) => row.entryId)).toEqual([
        ids[1],
      ]);
    });
  });

  it('refuses a second pass in the same millisecond as the first', () => {
    // A pass IS its timestamp -- there is no run column -- so two passes sharing one are one pass as
    // far as any reader can tell, and `asc kappa` comparing them would compare a pass with itself
    // and report perfect agreement.
    withStore((store) => {
      const ids = seed(store, 1);
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });
      const pass = {
        scheme: 'review',
        annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }],
      };

      recordAnnotations(store.db, pass, { createdAt: AT });

      expect(() =>
        recordAnnotations(
          store.db,
          {
            scheme: 'review',
            annotations: [{ id: 'a2', entryId: ids[0] as string, label: 'bug' }],
          },
          { createdAt: AT },
        ),
      ).toThrow(/already has a pass at/);
    });
  });

  it('writes nothing at all when one row of the batch is refused', () => {
    // A pass is one transaction. A half-written pass would be compared by `asc kappa` as though it
    // were a whole one, and its agreement would be computed from a set of labels nobody produced.
    withStore((store) => {
      const ids = seed(store, 2);
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });

      expect(() =>
        recordAnnotations(
          store.db,
          {
            scheme: 'review',
            annotations: [
              { id: 'a1', entryId: ids[0] as string, label: 'bug' },
              { id: 'a2', entryId: ids[1] as string, label: 'not-in-the-vocabulary' },
            ],
          },
          { createdAt: LATER },
        ),
      ).toThrow(AnnotationError);

      expect(annotationPasses(store.db, 'review')).toEqual([]);
    });
  });

  it('refuses a label the scheme does not declare, and lists what it does', () => {
    withStore((store) => {
      const ids = seed(store, 1);
      registerScheme(store.db, 'review', spec(['bug', 'docs']), { createdAt: AT });

      expect(() =>
        recordAnnotations(
          store.db,
          {
            scheme: 'review',
            annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'typo' }],
          },
          { createdAt: LATER },
        ),
      ).toThrow(/'bug', 'docs'/);
    });
  });

  it('refuses an annotation of an entry that does not exist', () => {
    withStore((store) => {
      seed(store, 1);
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });

      expect(() =>
        recordAnnotations(
          store.db,
          { scheme: 'review', annotations: [{ id: 'a1', entryId: 'nope', label: 'bug' }] },
          { createdAt: LATER },
        ),
      ).toThrow(/does not exist/);
    });
  });

  it('names the registered schemes when asked for one that is not', () => {
    withStore((store) => {
      seed(store, 1);

      expect(() =>
        recordAnnotations(
          store.db,
          { scheme: 'reviw', annotations: [{ id: 'a1', entryId: 'e1', label: 'bug' }] },
          { createdAt: LATER },
        ),
      ).toThrow(/no annotation scheme named 'reviw' is registered/);
    });
  });

  it('refuses what the column would refuse anyway, but with a reason', () => {
    // Each of these is a CHECK in the DDL. They are checked here because a constraint failure is a
    // message about a column, and a caller needs a message about their input.
    withStore((store) => {
      const ids = seed(store, 1);
      registerScheme(store.db, 'review', spec(['bug']), { createdAt: AT });

      const write =
        (annotation: Record<string, unknown>): (() => unknown) =>
        () =>
          recordAnnotations(
            store.db,
            { scheme: 'review', annotations: [annotation as never] },
            { createdAt: LATER },
          );

      expect(write({ id: 'a1', entryId: ids[0], label: 'bug', confidence: 1.5 })).toThrow(
        /outside \[0, 1\]/,
      );
      // Both ends, and a non-number. The upper bound alone left the lower bound unpinned: a mutation
      // run changed `confidence < 0` to `confidence < -1` and every test in this file stayed green,
      // because -0.1 was never written. The column's CHECK refuses it too -- as a constraint failure
      // naming a column, which is why these assert the message rather than only the throw.
      expect(write({ id: 'a1', entryId: ids[0], label: 'bug', confidence: -0.1 })).toThrow(
        /outside \[0, 1\]/,
      );
      // NaN compares false against both bounds, so the CHECK refuses it as well; catching it here is
      // about the message, and about not depending on a comparison that is false for reasons having
      // nothing to do with the range.
      expect(write({ id: 'a1', entryId: ids[0], label: 'bug', confidence: Number.NaN })).toThrow(
        /outside \[0, 1\]/,
      );
      expect(write({ id: 'a1', entryId: ids[0], label: 'bug', value: () => undefined })).toThrow(
        /is a function/,
      );
      expect(write({ id: 'a1', entryId: ids[0], label: 'bug', note: '' })).toThrow(/empty note/);
      expect(write({ id: '', entryId: ids[0], label: 'bug' })).toThrow(/id is empty/);
      expect(() =>
        recordAnnotations(
          store.db,
          {
            scheme: 'review',
            annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }],
          },
          { createdAt: '2026-09-17T11:00:00+02:00' },
        ),
      ).toThrow(/must be an ISO-8601 UTC timestamp/);
    });
  });
});

describe('applying a rule to the corpus', () => {
  /** Entries whose `text` property and evidence text are both the same word, so a rule can name one. */
  const ruleStore = (body: (store: Store) => void): void => {
    withStore((store) => {
      registerType(store.db, type, { registeredAt: AT });
      const words = ['crash', 'install', 'crash'];
      words.forEach((word, index) => {
        recordEntry(
          store.db,
          { type: 'note', properties: { text: word } },
          {
            id: `e${String(index + 1)}`,
            recordedAt: AT,
            ascendVersion: '0.0.0',
            evidenceText: `the ${word} happened`,
          },
        );
      });
      body(store);
    });
  };

  it('selects the entries a SQL predicate matches', () => {
    ruleStore((store) => {
      expect(
        matchingEntryIds(store.db, {
          label: 'bug',
          kind: 'sql',
          query: "evidence_text LIKE '%crash%'",
        }),
      ).toEqual(['e1', 'e3']);
    });
  });

  it('searches evidence text only, which is what the index covers', () => {
    // Stated rather than discovered: a `fts:` rule cannot see a property value, so `install` is a
    // match in the evidence text above and NOT a match on `properties.text`, which says the same
    // word. A rule that silently missed half the corpus would read as a taxonomy that does not fit.
    ruleStore((store) => {
      const ids = matchingEntryIds(store.db, { label: 'docs', kind: 'fts', query: 'install' });
      expect(ids).toEqual(['e2']);
      expect(
        matchingEntryIds(store.db, { label: 'docs', kind: 'fts', query: 'properties.text' }),
      ).toEqual([]);
    });
  });

  it('refuses a stored predicate carrying a second statement, at application time too', () => {
    // The guard has to hold for text this package did not write: a scheme registered by a newer
    // ascend, or by an older one, is a legitimate thing to read.
    ruleStore((store) => {
      expect(() =>
        matchingEntryIds(store.db, {
          label: 'bug',
          kind: 'sql',
          query: '1=1); DELETE FROM annotations; --',
        }),
      ).toThrow(/must be a single condition/);
    });
  });

  it('refuses a text rule with no searchable term, so it can never be stored or run', () => {
    // `fts: !!` is non-empty and matches nothing -- the empty query's defect wearing a non-empty
    // string. Refused at registration (so a dead rule is not storable) and again at application
    // (so a stored one cannot run).
    ruleStore((store) => {
      expect(() =>
        registerScheme(
          store.db,
          'review',
          spec(['docs'], [{ label: 'docs', kind: 'fts', query: '!!' }]),
          { createdAt: AT },
        ),
      ).toThrow(/no term long enough/);

      expect(() => matchingEntryIds(store.db, { label: 'docs', kind: 'fts', query: 'ab' })).toThrow(
        /no term long enough/,
      );
    });
  });
});

describe('the census, and the remainder that is the signal', () => {
  const censusStore = (body: (store: Store, ids: readonly string[]) => void): void => {
    withStore((store) => {
      const ids = seed(store, 5);
      // One vocabulary for every census test, so a test can pick the labels that make its own point.
      registerScheme(store.db, 'review', spec(['aaa', 'bug', 'docs', 'zzz']), { createdAt: AT });
      body(store, ids);
    });
  };

  it('reports the unclassified remainder as a count, biggest class first', () => {
    censusStore((store, ids) => {
      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [
            { id: 'a1', entryId: ids[0] as string, label: 'zzz' },
            { id: 'a2', entryId: ids[1] as string, label: 'zzz' },
            { id: 'a3', entryId: ids[2] as string, label: 'aaa' },
          ],
        },
        { createdAt: LATER },
      );

      // The labels are chosen so that the two plausible orders disagree: `zzz` has the bigger count
      // and `aaa` sorts first. Ordered by count, which is the order a reader wants -- the biggest
      // class is the headline. An alphabetical order passes every other assertion in this file.
      expect(schemeCensus(store.db, { scheme: 'review' })).toEqual({
        considered: 5,
        labelled: 3,
        unclassified: 2,
        labels: [
          { label: 'zzz', count: 2 },
          { label: 'aaa', count: 1 },
        ],
      });
    });
  });

  it('narrows the scope to a predicate, so a per-type scheme reports its own remainder', () => {
    censusStore((store, ids) => {
      recordAnnotations(
        store.db,
        { scheme: 'review', annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }] },
        { createdAt: LATER },
      );

      // Over the whole store, five entries were considered and four are unclassified. Over just the
      // one entry the rule looked at, none is.
      expect(schemeCensus(store.db, { scheme: 'review', scope: "id = 'e1'" })).toEqual({
        considered: 1,
        labelled: 1,
        unclassified: 0,
        labels: [{ label: 'bug', count: 1 }],
      });
    });
  });

  it('counts only the labels inside the scope, so the remainder cannot come out negative', () => {
    // The scope narrows `labelled` as well as `considered`. Without that, a pass that labelled four
    // entries reports four against a scope of one, and the remainder -- the number this function
    // exists to produce -- comes out as 1 - 4. The labels are chosen so a filter on `considered`
    // alone cannot pass: four entries carry a label, one of them is in scope, and only that one may
    // be counted or listed.
    censusStore((store, ids) => {
      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [
            { id: 'a1', entryId: ids[0] as string, label: 'bug' },
            { id: 'a2', entryId: ids[1] as string, label: 'zzz' },
            { id: 'a3', entryId: ids[2] as string, label: 'zzz' },
            { id: 'a4', entryId: ids[3] as string, label: 'docs' },
          ],
        },
        { createdAt: LATER },
      );

      expect(schemeCensus(store.db, { scheme: 'review', scope: "id = 'e2'" })).toEqual({
        considered: 1,
        labelled: 1,
        unclassified: 0,
        labels: [{ label: 'zzz', count: 1 }],
      });
    });
  });

  it('counts DISTINCT entries, so a second pass over one entry is not a second labelled entry', () => {
    // Distinct entries, not rows -- and this is now the ONLY way to reach the difference, because
    // `recordAnnotations` refuses two labels for one entry inside a single pass. Across passes it is
    // ordinary: a re-run labels the same entries again, and a census over all passes answers "what
    // has this scheme ever said" with as many rows as there have been passes.
    censusStore((store, ids) => {
      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [{ id: 'a1', entryId: ids[0] as string, label: 'bug' }],
        },
        { createdAt: AT },
      );
      recordAnnotations(
        store.db,
        {
          scheme: 'review',
          annotations: [{ id: 'a2', entryId: ids[0] as string, label: 'docs' }],
        },
        { createdAt: LATER },
      );

      const census = schemeCensus(store.db, { scheme: 'review' });

      // Two rows, one entry. A row count would report 2 of 5 labelled and a remainder of 3.
      expect(census.labelled).toBe(1);
      expect(census.unclassified).toBe(4);
      expect(census.labels).toEqual([
        { label: 'bug', count: 1 },
        { label: 'docs', count: 1 },
      ]);
      // And the same facts over one pass, where the remainder is about that run rather than the
      // scheme's history: one entry considered out of the five in scope.
      expect(schemeCensus(store.db, { scheme: 'review', pass: LATER })).toEqual({
        considered: 5,
        labelled: 1,
        unclassified: 4,
        labels: [{ label: 'docs', count: 1 }],
      });
    });
  });

  it('refuses a scope carrying a second statement', () => {
    // The scope arrives from a stored rule in the common case, so this is the path a truncated
    // predicate would take -- and a census computed from a truncated scope describes a rule that was
    // never applied.
    censusStore((store) => {
      expect(() =>
        schemeCensus(store.db, { scheme: 'review', scope: '1=1); DELETE FROM annotations; --' }),
      ).toThrow(/must be a single condition/);
    });
  });
});

describe('invalidation', () => {
  it('registers the reserved scheme on first use, with the closed vocabulary and no rules', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      const written = recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'the measured value was contaminated by a retry',
        createdAt: AT,
      });

      expect(written.scheme).toBe(RESERVED_SCHEME);
      expect(written.schemeVersion).toBe(1);
      expect(written.label).toBe('wrong_value');
      expect(listSchemes(store.db)).toEqual([
        {
          name: RESERVED_SCHEME,
          version: 1,
          createdAt: AT,
          spec: { labels: [...INVALIDATION_LABELS].sort(), rules: [] },
        },
      ]);
    });
  });

  it('reuses the existing scheme version on a second invalidation, rather than minting a new one', () => {
    withStore((store) => {
      const ids = seed(store, 2);

      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_subject',
        reason: 'this entry was never about the claimed subject',
        createdAt: AT,
      });
      const second = recordInvalidation(store.db, {
        entryId: ids[1] as string,
        label: 'wrong_subject',
        reason: 'same mistake, a different entry',
        createdAt: LATER,
      });

      expect(second.schemeVersion).toBe(1);
      expect(listSchemes(store.db).map((scheme) => scheme.version)).toEqual([1]);
    });
  });

  it('still refuses the reserved name through the public registerScheme, unchanged', () => {
    // Rule 1's other half: the store's own internal registration path must not have taught
    // `requireName` an exception for `recordInvalidation`.
    withStore((store) => {
      const ids = seed(store, 1);
      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'contaminated',
        createdAt: AT,
      });

      expect(() =>
        registerScheme(
          store.db,
          RESERVED_SCHEME,
          { labels: ['x'], rules: [] },
          { createdAt: LATER },
        ),
      ).toThrow(SchemeError);
    });
  });

  it('refuses a label outside the closed vocabulary at runtime, for a caller with no compiler watching', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'duplicate' as InvalidationLabel,
          reason: 'not part of the vocabulary',
          createdAt: AT,
        }),
      ).toThrow(/is not one of/);
    });
  });

  it('refuses an entryId that does not exist, rather than creating a tombstone', () => {
    withStore((store) => {
      expect(() =>
        recordInvalidation(store.db, {
          entryId: 'nope',
          label: 'wrong_value',
          reason: 'does not matter',
          createdAt: AT,
        }),
      ).toThrow(/does not exist/);
      expect(() =>
        recordInvalidation(store.db, {
          entryId: 'nope',
          label: 'wrong_value',
          reason: 'does not matter',
          createdAt: AT,
        }),
      ).toThrow(/tombstone/);
    });
  });

  it('refuses a reason that is empty, or only whitespace', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'wrong_value',
          reason: '',
          createdAt: AT,
        }),
      ).toThrow(/no reason/);
      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'wrong_value',
          reason: '   ',
          createdAt: AT,
        }),
      ).toThrow(/no reason/);
    });
  });

  it('requires supersededBy when the label is superseded', () => {
    withStore((store) => {
      const ids = seed(store, 2);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'superseded',
          reason: 'a later entry measured this better',
          createdAt: AT,
        }),
      ).toThrow(/no 'supersededBy'/);
    });
  });

  it('refuses supersededBy on a label other than superseded', () => {
    withStore((store) => {
      const ids = seed(store, 2);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'wrong_value',
          reason: 'contaminated',
          supersededBy: ids[1] as string,
          createdAt: AT,
        }),
      ).toThrow(/not 'superseded'/);
    });
  });

  it('refuses supersededBy naming an entry that does not exist', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'superseded',
          reason: 'a later entry measured this better',
          supersededBy: 'nope',
          createdAt: AT,
        }),
      ).toThrow(/supersededBy names entry 'nope', which does not exist/);
    });
  });

  it('refuses an entry superseding itself', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'superseded',
          reason: 'a later entry measured this better',
          supersededBy: ids[0] as string,
          createdAt: AT,
        }),
      ).toThrow(/cannot supersede itself/);
    });
  });

  it('stores supersededBy as value_json, and reads it back through listInvalidations', () => {
    withStore((store) => {
      const ids = seed(store, 2);

      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'superseded',
        reason: 'a later entry measured this better',
        supersededBy: ids[1] as string,
        createdAt: AT,
      });

      const rows = listInvalidations(store.db, ids[0]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.supersededBy).toBe(ids[1]);
      expect(rows[0]?.reason).toBe('a later entry measured this better');

      const raw = annotationRows(store.db, { scheme: RESERVED_SCHEME });
      expect(raw[0]?.value).toEqual({ superseded_by: ids[1] });
    });
  });

  it('allows invalidating an already-invalidated entry, without deduping', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'first pass: value looked off',
        createdAt: AT,
      });
      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_subject',
        reason: 'second pass: actually the wrong subject entirely',
        createdAt: LATER,
      });

      const rows = listInvalidations(store.db, ids[0]);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.label)).toEqual(['wrong_subject', 'wrong_value']);
    });
  });

  it('omits createdBy rather than storing it as an empty string', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'contaminated',
        createdAt: AT,
      });

      expect(listInvalidations(store.db, ids[0] as string)[0]?.createdBy).toBeNull();

      expect(() =>
        recordInvalidation(store.db, {
          entryId: ids[0] as string,
          label: 'wrong_value',
          reason: 'contaminated again',
          createdBy: '',
          createdAt: LATER,
        }),
      ).toThrow(/createdBy is empty/);
    });
  });

  it('stores createdBy when given', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'contaminated',
        createdBy: 'claude-code',
        createdAt: AT,
      });

      expect(listInvalidations(store.db, ids[0] as string)[0]?.createdBy).toBe('claude-code');
    });
  });

  it('lists invalidations newest-first, with same-timestamp ties broken by insertion order', () => {
    withStore((store) => {
      const ids = seed(store, 2);

      // Two different entries invalidated at the exact same millisecond, so `created_at` alone
      // cannot order them -- exactly the tie `listInvalidations`'s `rowid DESC` exists to break.
      // `first` was written before `second`, so "latest" must place `second` ahead of `first`.
      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'first entry, same millisecond',
        createdAt: AT,
      });
      recordInvalidation(store.db, {
        entryId: ids[1] as string,
        label: 'wrong_subject',
        reason: 'second entry, same millisecond',
        createdAt: AT,
      });
      recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_subject',
        reason: 'a later pass on the first entry',
        createdAt: LATER,
      });

      const rows = listInvalidations(store.db);
      expect(rows.map((row) => row.createdAt)).toEqual([LATER, AT, AT]);
      // Within the tied pair (both at AT), the one written SECOND (`ids[1]`) sorts first --
      // insertion order, not a property of the ids themselves.
      expect(rows.slice(1).map((row) => row.entryId)).toEqual([ids[1], ids[0]]);
    });
  });

  it('records the identical claim again at a LATER createdAt as a no-op: the real retry case', () => {
    // This is the case that mattered: a real `asc invalidate` re-run reads the wall clock fresh
    // each time, so `createdAt` differs between the two calls even though the claim is identical.
    // An id keyed on `createdAt` would make `created` always `true` and this a silent second row.
    withStore((store) => {
      const ids = seed(store, 1);
      const claim = {
        entryId: ids[0] as string,
        label: 'wrong_value' as const,
        reason: 'the measured value was contaminated by a retry',
      };

      const first = recordInvalidation(store.db, { ...claim, createdAt: AT });
      expect(first.created).toBe(true);

      const second = recordInvalidation(store.db, { ...claim, createdAt: LATER });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(second.schemeVersion).toBe(first.schemeVersion);

      // Exactly one row, not two -- the whole point of treating the repeat as a no-op rather than
      // a duplicate write.
      expect(listInvalidations(store.db, ids[0] as string)).toHaveLength(1);
    });
  });

  it('writes a second row when the invalidation differs, even for the same entry and label', () => {
    withStore((store) => {
      const ids = seed(store, 1);

      const first = recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'first reason',
        createdAt: AT,
      });
      const second = recordInvalidation(store.db, {
        entryId: ids[0] as string,
        label: 'wrong_value',
        reason: 'a different reason, so this is not the same invalidation',
        createdAt: LATER,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
      expect(second.id).not.toBe(first.id);
      expect(listInvalidations(store.db, ids[0] as string)).toHaveLength(2);
    });
  });

  it("keeps the FIRST call's createdAt on the stored row when a later call repeats the claim", () => {
    withStore((store) => {
      const ids = seed(store, 1);
      const claim = {
        entryId: ids[0] as string,
        label: 'wrong_value' as const,
        reason: 'the measured value was contaminated by a retry',
      };

      recordInvalidation(store.db, { ...claim, createdAt: AT });
      const second = recordInvalidation(store.db, { ...claim, createdAt: LATER });

      expect(second.created).toBe(false);
      const rows = listInvalidations(store.db, ids[0]);
      expect(rows).toHaveLength(1);
      // The stored timestamp names when the claim was FIRST made -- the no-op repeat at `LATER`
      // does not refresh it.
      expect(rows[0]?.createdAt).toBe(AT);
    });
  });
});
