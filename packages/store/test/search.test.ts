import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TypeSpec } from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countSearchMatches,
  indexedDocumentCount,
  MIGRATIONS,
  migrate,
  openStore,
  propertyValueMatches,
  recordEntry,
  registerType,
  searchEntries,
  searchScope,
  toFtsMatch,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * Search over `evidence_text`.
 *
 * EV-fts measured two things this suite has to keep true, and both are asserted here rather than
 * assumed: that a hostile query CANNOT throw, and that a multi-word query still RETURNS rows. The
 * second is the one a naive fix breaks -- wrapping the raw query in a single quoted phrase makes
 * the throws go away and returns empty for 9-13 of 14 real queries, which converts a loud failure
 * into the silent zero-result EV-fts calls the worse of the two.
 *
 * The suite is therefore written so that a "fix" which simply stops the errors fails.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-search-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const AT = '2026-09-11T10:00:00.000Z';

const context = (id: string, evidenceText?: string): RecordContext => ({
  id,
  recordedAt: AT,
  ascendVersion: '0.0.0',
  ...(evidenceText === undefined ? {} : { evidenceText }),
});

const NOTE: TypeSpec = {
  name: 'note',
  properties: [{ name: 'summary', type: 'text' }],
};

/**
 * A type whose entries are recorded with no evidence text at all -- the shape that makes four of the
 * five populated types on the real corpus unsearchable, and the reason `searchScope` reports two
 * numbers rather than one.
 */
const BARE: TypeSpec = {
  name: 'bare',
  properties: [{ name: 'summary', type: 'text' }],
};

const withStore = (body: (store: Store) => void): void => {
  const store = openStore({ dir: tempDir(), ascendVersion: '0.0.0' });
  try {
    body(store);
  } finally {
    store.close();
  }
};

/**
 * The inputs EV-fts passed to `MATCH` that threw, verbatim from its table, plus the shapes it
 * named. Every one is ordinary text a user could type.
 */
const HOSTILE = [
  '"unbalanced quote',
  'foo -bar',
  'col:value',
  'NEAR(a b)',
  'a AND b OR c',
  'error (timeout)',
  'why did it fail?',
  'C++ templates',
  'a OR',
  'NOT',
  'x AND',
  '*',
  '**',
  '"',
  '""',
  '""""',
  'a"b',
  "'",
  '\\',
  '%',
  '_',
  '^',
  'a:b:c',
  "col:'quoted'",
  '{a b}',
  '[a b]',
  'a NEAR/3 b',
  'NOT a',
  'a NOT b',
  '-',
  '--',
  'a -b -c',
  'AND OR NOT NEAR',
  '((()))',
  'a(b)c',
  'foo:',
  ':foo',
  'foo bar baz',
  '  ',
  '',
  '\n\t',
  'trigram',
  'ünïcödé',
  '日本語のテキスト',
  'a\u0000b',
];

describe('toFtsMatch turns text into query syntax, never into syntax errors', () => {
  it('quotes each term and joins with OR, not AND', () => {
    // OR is mast's measured F15: ANDing means every term must appear in one document, which
    // returned zero rows for 6 of 20 real queries whose target was plainly in the corpus.
    expect(toFtsMatch('error (timeout)')).toBe('"error" OR "timeout"');
    expect(toFtsMatch('why did it fail?')).toBe('"why" OR "did" OR "fail"');
  });

  it('drops terms below the trigram floor, which cannot match anyway', () => {
    expect(toFtsMatch('a bc def')).toBe('"def"');
  });

  it('returns null when no term can match, so the caller asks nothing rather than something invalid', () => {
    expect(toFtsMatch('a bc')).toBeNull();
    expect(toFtsMatch('')).toBeNull();
    expect(toFtsMatch('   \n\t ')).toBeNull();
    expect(toFtsMatch('a -b (c)')).toBeNull();
  });

  it('lets no quote from the input through as syntax, for ANY hostile input', () => {
    // The property that makes the escape work: every `"` in the output is one of the phrase
    // delimiters this function wrote, so an input quote can never close a phrase early or open
    // one. Odd counts are the signature of a leak; a bare input quote would produce one.
    for (const input of HOSTILE) {
      const match = toFtsMatch(input);
      if (match === null) continue;
      const quotes = match.split('"').length - 1;
      expect(quotes % 2, `unbalanced quoting for ${JSON.stringify(input)} -> ${match}`).toBe(0);
      expect(match.startsWith('"') && match.endsWith('"')).toBe(true);
      // Every term is separately quoted, joined by ` OR ` and nothing else.
      for (const term of match.split(' OR ')) {
        expect(term.startsWith('"') && term.endsWith('"')).toBe(true);
      }
    }
  });

  it('drops a short word inside quotes like any other short word', () => {
    expect(toFtsMatch('say "hi" now')).toBe('"say" OR "now"');
  });

  it('takes terms from any script, not only from ASCII', () => {
    // asc-bcv.8. The class was `[A-Za-z0-9_]`, so a query written in another script produced no
    // terms at all and `searchEntries` answered it with an empty array.
    expect(toFtsMatch('ошибка')).toBe('"ошибка"');
    expect(toFtsMatch('日本語')).toBe('"日本語"');
    expect(toFtsMatch('таймаута')).toBe('"таймаута"');
    expect(toFtsMatch('naïve')).toBe('"naïve"');
    // And punctuation still SPLITS rather than being swallowed -- it is query shaping, not a
    // model of the index.
    expect(toFtsMatch('ошибка: таймаут')).toBe('"ошибка" OR "таймаут"');
    // `_` stays a word character, so a code identifier is still one term.
    expect(toFtsMatch('entries_fts')).toBe('"entries_fts"');
    // Digits outside ASCII, so the class is pinned whole. This one is a completeness pin rather
    // than a repair -- no user was observed querying fullwidth digits -- and it is stated that way
    // so the assertion is not read as more evidence than it is.
    expect(toFtsMatch('１２３４')).toBe('"１２３４"');
  });

  it('counts the trigram floor in CODE POINTS, which is the unit the tokenizer itself uses', () => {
    // Measured against a real FTS5 table (/tmp/probe-b3-edge.mjs): `日本語` (3 points) matches and
    // `日本` (2) does not; `𐐷𐐷𐐷` (3 points, 6 UTF-16 units) matches and `𐐷a` (2 points, 3
    // units) does not. `token.length` counts UTF-16 units, so under it one astral letter carried a
    // 2-point term past the floor as a phrase that could never match anything -- a silent zero of
    // exactly the kind this module exists to refuse.
    expect(toFtsMatch('日本語')).toBe('"日本語"');
    expect(toFtsMatch('日本')).toBeNull();
    expect(toFtsMatch('𐐷𐐷𐐷')).toBe('"𐐷𐐷𐐷"');
    expect(toFtsMatch('𐐷a')).toBeNull();
    // The case the old unit got wrong, stated as the pair of numbers it disagrees on.
    expect('𐐷a'.length).toBe(3);
    expect(Array.from('𐐷a').length).toBe(2);
  });

  it('handles the whole hostile corpus without throwing', () => {
    for (const input of HOSTILE) expect(() => toFtsMatch(input)).not.toThrow();
  });
});

describe('the hostile corpus is genuinely hostile', () => {
  it('shows the RAW string reaches FTS5 and throws, so the fuzz below is not vacuous', () => {
    // A fuzz test that cannot fail is not a test. This one asserts the baseline the sanitizer
    // exists to prevent -- if FTS5 ever stopped rejecting these, the fuzz test would go quiet and
    // this test would say so.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      const raw = (query: string): void => {
        store.db.prepare('SELECT * FROM entries_fts WHERE entries_fts MATCH ?').all(query);
      };

      let threw = 0;
      for (const input of HOSTILE) {
        try {
          raw(input);
        } catch {
          threw += 1;
        }
      }
      expect(threw).toBeGreaterThan(0);
    });
  });
});

describe('a hostile query cannot fail the query path', () => {
  it('never throws, for any input in the corpus', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      for (const input of HOSTILE) {
        expect(
          () => searchEntries(store.db, input),
          `query: ${JSON.stringify(input)}`,
        ).not.toThrow();
      }
    });
  });

  it('returns an empty array rather than throwing when nothing can match', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      const hits = searchEntries(store.db, 'a bc (d)');
      expect(hits).toEqual([]);
    });
  });
});

describe('a hostile query still finds real rows', () => {
  it('matches on a multi-word query, which the one-phrase fix would return empty for', () => {
    // EV-fts's second requirement, and the reason the sanitizer tokenizes. `error (timeout)` is
    // one of the inputs that throws raw; the naive fix makes it return nothing.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      const hits = searchEntries(store.db, 'error (timeout)');
      expect(hits.map((hit) => hit.entryId)).toEqual(['e1']);
    });
  });

  it('matches when only SOME of the terms are present — the OR behaviour', () => {
    // AND would return nothing here. The document contains `build` and `timeout` but not `error`.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      expect(searchEntries(store.db, 'build timeout error').map((hit) => hit.entryId)).toEqual([
        'e1',
      ]);
    });
  });

  it('finds a partial token, which is why trigram was chosen', () => {
    // unicode61 and porter retrieve NOTHING for 40% of partial-token queries.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'note' },
        context('e1', 'claude-sonnet-5 rejected the Bash permission rule'),
      );

      expect(searchEntries(store.db, 'permis').map((hit) => hit.entryId)).toEqual(['e1']);
      expect(searchEntries(store.db, 'sonnet').map((hit) => hit.entryId)).toEqual(['e1']);
    });
  });
});

describe('a query in a script the ASCII class does not cover finds its rows (asc-bcv.8)', () => {
  it('matches Cyrillic, CJK and accented terms, which used to return zero', () => {
    // Measured on a real store built from the real transcripts (/tmp/probe-b3.mjs): the index held
    // every one of these -- a raw quoted MATCH returned a hit for each -- while `toFtsMatch`
    // returned null and `searchEntries` returned 0 rows. The index was never the problem.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('ru', 'the transcript says ошибка here'));
      recordEntry(store.db, { type: 'note' }, context('ja', 'the transcript says 日本語 here'));
      recordEntry(store.db, { type: 'note' }, context('fr', 'the transcript says naïve here'));

      expect(searchEntries(store.db, 'ошибка').map((hit) => hit.entryId)).toEqual(['ru']);
      expect(searchEntries(store.db, '日本語').map((hit) => hit.entryId)).toEqual(['ja']);
      expect(searchEntries(store.db, 'naïve').map((hit) => hit.entryId)).toEqual(['fr']);
    });
  });

  it('is a SHORT-RUN defect, not a non-ASCII one: café used to work while naïve did not', () => {
    // The reason this went unseen for so long. `café` was split into `caf` -- long enough to match
    // -- so it returned a hit and looked correct; `naïve` split into `na` and `ve`, neither long
    // enough, and returned nothing. Asserted as a pair so that narrowing the class again fails on
    // both, not only on the term that happened to be easy to notice.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('fr', 'the transcript says café here'));
      recordEntry(store.db, { type: 'note' }, context('fr2', 'the transcript says naïve here'));

      expect(searchEntries(store.db, 'café').map((hit) => hit.entryId)).toEqual(['fr']);
      expect(searchEntries(store.db, 'naïve').map((hit) => hit.entryId)).toEqual(['fr2']);
    });
  });

  it('answers case-insensitively in every script, because trigram folds case', () => {
    // Measured, not assumed: stored `ошибка` is found by `ОШИБКА`. Widening the class must not
    // have introduced a case-sensitive path for the scripts it newly reaches.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('ru', 'the transcript says ошибка here'));

      expect(searchEntries(store.db, 'ОШИБКА').map((hit) => hit.entryId)).toEqual(['ru']);
    });
  });
});

describe('the index is maintained by the write path', () => {
  it('makes a newly recorded entry searchable immediately', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      expect(searchEntries(store.db, 'timeout')).toEqual([]);

      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      expect(searchEntries(store.db, 'timeout').map((hit) => hit.entryId)).toEqual(['e1']);
      expect(indexedDocumentCount(store.db)).toBe(1);
    });
  });

  it('does not index an entry that carries no evidence, rather than indexing an empty string', () => {
    // `''` is a real value in SQLite (the no-empty-string-sentinel rule). An indexed empty
    // document would be a row that matches nothing but counts as coverage.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('no-evidence'));
      expect(indexedDocumentCount(store.db)).toBe(0);
    });
  });

  it('ranks a document matching more terms first', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('one', 'the build failed'));
      recordEntry(
        store.db,
        { type: 'note' },
        context('both', 'the build failed and the build stalled'),
      );

      const hits = searchEntries(store.db, 'build stalled');
      expect(hits.length).toBeGreaterThan(1);
      expect(hits[0]?.entryId).toBe('both');
    });
  });

  it('cannot desynchronise, because the entry it indexes can never be deleted or edited', () => {
    // The reason migration 2 needs no UPDATE or DELETE trigger. If an entry could be removed the
    // index would keep a row pointing at nothing; the immutability triggers are what make that
    // unreachable, so this asserts the dependency rather than trusting it.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('e1', 'the build failed with a timeout'));

      expect(() => store.db.prepare("DELETE FROM entries WHERE id = 'e1'").run()).toThrow(
        /entries are immutable/,
      );
      expect(() =>
        store.db.prepare("UPDATE entries SET evidence_text = 'other' WHERE id = 'e1'").run(),
      ).toThrow(/entries are immutable/);

      // So the index still resolves.
      expect(searchEntries(store.db, 'timeout').map((hit) => hit.entryId)).toEqual(['e1']);
    });
  });
});

describe('options', () => {
  it('restricts to one type without scanning the FTS index', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      registerType(store.db, { ...NOTE, name: 'other' }, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('n1', 'shared token here'));
      recordEntry(store.db, { type: 'other' }, context('o1', 'shared token here'));

      expect(
        searchEntries(store.db, 'shared')
          .map((hit) => hit.entryId)
          .sort(),
      ).toEqual(['n1', 'o1']);
      expect(
        searchEntries(store.db, 'shared', { type: 'other' }).map((hit) => hit.entryId),
      ).toEqual(['o1']);
    });
  });

  it('honours the limit', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      for (let i = 0; i < 5; i++) {
        recordEntry(
          store.db,
          { type: 'note' },
          context(`e${String(i)}`, 'repeated searchable text'),
        );
      }
      expect(searchEntries(store.db, 'searchable')).toHaveLength(5);
      expect(searchEntries(store.db, 'searchable', { limit: 2 })).toHaveLength(2);
    });
  });
});

describe('migration 2 backfills entries that predate it', () => {
  it('makes a pre-migration entry findable, rather than silently invisible', () => {
    // The failure this prevents is invisible by construction: an index built only from future
    // inserts leaves every existing entry unsearchable, with no error anywhere. That is the
    // silent-zero-result mode EV-fts ranked WORSE than a crash, arriving via the migration path.
    const dir = tempDir();
    const store = openStore({ dir, migrate: false });
    try {
      migrate(store.db, [MIGRATIONS[0] as (typeof MIGRATIONS)[number]]);
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('old', 'an entry from before the index'));

      // No FTS table exists yet, so nothing can find it.
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'entries_fts'").get(),
      ).toBeUndefined();

      const result = migrate(store.db);
      expect(result.from).toBe(1);
      expect(result.to).toBe(2);
      expect(result.applied).toEqual(['full-text search over evidence_text']);

      // The row that already existed is in the index.
      expect(indexedDocumentCount(store.db)).toBe(1);
      expect(searchEntries(store.db, 'before').map((hit) => hit.entryId)).toEqual(['old']);
    } finally {
      store.close();
    }
  });

  it('is idempotent — re-running applies nothing and changes no row', () => {
    const dir = tempDir();
    const store = openStore({ dir, migrate: false });
    try {
      migrate(store.db, [MIGRATIONS[0] as (typeof MIGRATIONS)[number]]);
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('old', 'an entry from before the index'));

      migrate(store.db);
      const second = migrate(store.db);

      expect(second.applied).toEqual([]);
      // Backfilling twice would duplicate every row, and a duplicated document double-counts in
      // `indexedDocumentCount` -- so the count being exactly 1 is the assertion that matters.
      expect(indexedDocumentCount(store.db)).toBe(1);
    } finally {
      store.close();
    }
  });

  it('leaves a store that reopens at the current version fully migrated', () => {
    const dir = tempDir();
    const first = openStore({ dir });
    try {
      registerType(first.db, NOTE, { registeredAt: AT });
      recordEntry(first.db, { type: 'note' }, context('e1', 'a durable searchable entry'));
      expect(first.migrations.to).toBe(2);
    } finally {
      first.close();
    }

    const second = openStore({ dir });
    try {
      expect(second.migrations.applied).toEqual([]);
      expect(searchEntries(second.db, 'durable').map((hit) => hit.entryId)).toEqual(['e1']);
    } finally {
      second.close();
    }
  });
});

describe('the snippet returned is the text a user matches on', () => {
  it('wraps the matching terms for a terminal to bold', () => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'note' },
        context('e1', 'the reviewer rejected the change because the tests were missing'),
      );

      const hit = searchEntries(store.db, 'rejected')[0];
      expect(hit?.snippet).toContain('**rejected**');
    });
  });
});

describe('searchScope reports what a search could have looked over', () => {
  /**
   * The two numbers answer different questions and the whole value of the function is that they can
   * disagree. A type whose entries carry no evidence has entries and no indexed documents, and a
   * search over it is an unconditional zero -- for every query, including `""`. Nothing else in the
   * API reports that, so a caller who gets the empty array cannot tell it from a poor query.
   */
  const withTwoTypes = (body: (store: Store) => void): void => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      registerType(store.db, BARE, { registeredAt: AT });
      recordEntry(store.db, { type: 'note' }, context('n1', 'the tests were missing'));
      recordEntry(store.db, { type: 'note' }, context('n2', 'a second note'));
      recordEntry(store.db, { type: 'bare' }, context('b1'));
      body(store);
    });
  };

  it('counts the type and the indexed part of it separately', () => {
    withTwoTypes((store) => {
      expect(searchScope(store.db, 'note')).toEqual({ entries: 2, indexed: 2 });
      expect(searchScope(store.db, 'bare')).toEqual({ entries: 1, indexed: 0 });
    });
  });

  it('reports a type with no entries as zero and zero', () => {
    withTwoTypes((store) => {
      expect(searchScope(store.db, 'nothing_here')).toEqual({ entries: 0, indexed: 0 });
    });
  });

  it('never sees an entry with EMPTY evidence, because the recorder refuses to write one', () => {
    // Written to pin a boundary that turned out not to exist, which is worth recording rather than
    // deleting. The first version of this test recorded `evidenceText: ''` and asserted the index
    // held it; it failed, and the failure is the better fact: `requireNonEmpty` rejects an empty
    // string outright, on the grounds that "an empty string is a real value in SQLite, not
    // unknown -- omit the field instead so it is stored as NULL". So the gap between "no evidence"
    // and "evidence the index cannot match" does not exist at this layer, and `indexed` counts
    // entries that hold text rather than entries that hold a row.
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      expect(() => recordEntry(store.db, { type: 'note' }, context('empty', ''))).toThrow(
        /evidenceText is empty/,
      );
      expect(searchScope(store.db, 'note')).toEqual({ entries: 0, indexed: 0 });
    });
  });
});

describe('countSearchMatches counts the answer, not the page', () => {
  /**
   * The number a `LIMIT` destroys. `searchEntries` at `--limit 1` returns one row whether the corpus
   * matches once or a hundred times, and the row list cannot tell those apart -- which is why this
   * exists rather than a caller reading `rows.length`.
   */
  const withMatches = (body: (store: Store) => void): void => {
    withStore((store) => {
      registerType(store.db, NOTE, { registeredAt: AT });
      registerType(store.db, BARE, { registeredAt: AT });
      for (let i = 0; i < 5; i += 1) {
        recordEntry(store.db, { type: 'note' }, context(`n${String(i)}`, `disk full ${String(i)}`));
      }
      recordEntry(store.db, { type: 'bare' }, context('b1', 'disk full too'));
      body(store);
    });
  };

  it('counts every match, not the limited page', () => {
    withMatches((store) => {
      expect(searchEntries(store.db, 'disk', { type: 'note', limit: 1 })).toHaveLength(1);
      expect(countSearchMatches(store.db, 'disk', { type: 'note' })).toBe(5);
    });
  });

  it('applies the type filter, so the count belongs to the type asked about', () => {
    // Without the filter the count would be 6 -- the number of `disk` matches in the store, which
    // is not the number in the type a caller searched.
    withMatches((store) => {
      expect(countSearchMatches(store.db, 'disk')).toBe(6);
      expect(countSearchMatches(store.db, 'disk', { type: 'note' })).toBe(5);
    });
  });

  it('counts a term that matches nothing as zero rather than as an unanswerable query', () => {
    withMatches((store) => {
      expect(countSearchMatches(store.db, 'zzzqqq', { type: 'note' })).toBe(0);
    });
  });

  it('agrees with searchEntries about whether a query is answerable at all', () => {
    // The two must not disagree: a query `searchEntries` refuses to run is one this must not count
    // as a corpus that matches zero times.
    withMatches((store) => {
      expect(searchEntries(store.db, 'ab')).toEqual([]);
      expect(countSearchMatches(store.db, 'ab')).toBe(0);
    });
  });
});

describe('propertyValueMatches finds values that exist, and only those', () => {
  const RUNNER: TypeSpec = {
    name: 'run',
    properties: [{ name: 'runner', type: 'enum', enum_values: ['npm_run_build', 'cargo test'] }],
  };

  const withRunners = (body: (store: Store) => void): void => {
    withStore((store) => {
      registerType(store.db, RUNNER, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'run', properties: { runner: 'npm_run_build' } },
        context('r1'),
      );
      recordEntry(
        store.db,
        { type: 'run', properties: { runner: 'npm_run_build' } },
        context('r2'),
      );
      recordEntry(store.db, { type: 'run', properties: { runner: 'cargo test' } }, context('r3'));
      body(store);
    });
  };

  it('returns the values that occur, with the count of entries carrying each', () => {
    withRunners((store) => {
      expect(propertyValueMatches(store.db, { type: 'run', terms: ['run'], limit: 5 })).toEqual([
        { property: 'runner', value: 'npm_run_build', entries: 2 },
      ]);
    });
  });

  it('treats an underscore in a term as a literal, not as a wildcard', () => {
    // THE ESCAPE, at the level the hazard lives. `LIKE '%___%'` matches any value of three or more
    // characters, so an unescaped pattern reports every value in the type as a place the caller's
    // nonsense query occurs. Verified by mutation: with the JS escaping removed and the SQL ESCAPE
    // clause kept, this returns both values and the assertion fails.
    withRunners((store) => {
      expect(propertyValueMatches(store.db, { type: 'run', terms: ['___'], limit: 5 })).toEqual([]);
    });
  });

  it('still matches a term that genuinely contains an underscore', () => {
    // The other half: escaping must not make `_` unmatchable, which would pass the test above and
    // silently break every query holding one.
    withRunners((store) => {
      expect(
        propertyValueMatches(store.db, { type: 'run', terms: ['npm_run_build'], limit: 5 }),
      ).toEqual([{ property: 'runner', value: 'npm_run_build', entries: 2 }]);
    });
  });

  it('escapes a backslash so a term cannot consume the character after it', () => {
    withRunners((store) => {
      expect(propertyValueMatches(store.db, { type: 'run', terms: ['\\'], limit: 5 })).toEqual([]);
    });
  });

  it('is bounded by the limit, and ordered by count so the bound keeps the common values', () => {
    withRunners((store) => {
      const all = propertyValueMatches(store.db, {
        type: 'run',
        terms: ['run', 'cargo'],
        limit: 5,
      });
      expect(all.map((hit) => hit.value)).toEqual(['npm_run_build', 'cargo test']);
      expect(
        propertyValueMatches(store.db, { type: 'run', terms: ['run', 'cargo'], limit: 1 }),
      ).toEqual([{ property: 'runner', value: 'npm_run_build', entries: 2 }]);
    });
  });

  it('asks the store nothing when there is no term to ask about', () => {
    // `IN ()` and an empty WHERE are both invalid SQL, so the empty case returns before the
    // statement is prepared rather than relying on the driver to accept an empty disjunction.
    withRunners((store) => {
      expect(propertyValueMatches(store.db, { type: 'run', terms: [], limit: 5 })).toEqual([]);
    });
  });

  it('finds nothing for a term that occurs nowhere, rather than failing', () => {
    withRunners((store) => {
      expect(propertyValueMatches(store.db, { type: 'run', terms: ['zzz'], limit: 5 })).toEqual([]);
    });
  });

  it('answers identically twice, so an assist is reproducible', () => {
    withRunners((store) => {
      const once = JSON.stringify(
        propertyValueMatches(store.db, { type: 'run', terms: ['run'], limit: 5 }),
      );
      const twice = JSON.stringify(
        propertyValueMatches(store.db, { type: 'run', terms: ['run'], limit: 5 }),
      );
      expect(twice).toBe(once);
    });
  });
});

describe('a type named under a non-canonical spelling (asc-pw2)', () => {
  const CAMEL: TypeSpec = {
    name: 'reviewKind',
    properties: [{ name: 'runner', type: 'string' }],
  };

  const withCamel = (body: (store: Store) => void): void => {
    withStore((store) => {
      registerType(store.db, CAMEL, { registeredAt: AT });
      recordEntry(
        store.db,
        { type: 'reviewKind', properties: { runner: 'npm_run_build' } },
        context('c1', 'built with npm'),
      );
      body(store);
    });
  };

  it('searchEntries matches entries whether the type filter is given canonical or not', () => {
    withCamel((store) => {
      const byRaw = searchEntries(store.db, 'npm', { type: 'reviewKind' });
      const byCanonical = searchEntries(store.db, 'npm', { type: 'review_kind' });
      expect(byRaw.map((hit) => hit.entryId)).toEqual(['c1']);
      expect(byCanonical.map((hit) => hit.entryId)).toEqual(['c1']);
    });
  });

  it('countSearchMatches counts the same regardless of the type filter spelling', () => {
    withCamel((store) => {
      expect(countSearchMatches(store.db, 'npm', { type: 'reviewKind' })).toBe(1);
      expect(countSearchMatches(store.db, 'npm', { type: 'review_kind' })).toBe(1);
    });
  });

  it('searchScope reports the same counts under any spelling of the type', () => {
    withCamel((store) => {
      expect(searchScope(store.db, 'reviewKind')).toEqual({ entries: 1, indexed: 1 });
      expect(searchScope(store.db, 'review_kind')).toEqual({ entries: 1, indexed: 1 });
    });
  });

  it('propertyValueMatches resolves entries under any spelling of the type', () => {
    withCamel((store) => {
      const byRaw = propertyValueMatches(store.db, {
        type: 'reviewKind',
        terms: ['npm'],
        limit: 5,
      });
      const byCanonical = propertyValueMatches(store.db, {
        type: 'review_kind',
        terms: ['npm'],
        limit: 5,
      });
      expect(byRaw).toEqual([{ property: 'runner', value: 'npm_run_build', entries: 1 }]);
      expect(byCanonical).toEqual(byRaw);
    });
  });
});
