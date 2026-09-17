import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURSOR_PREFIX,
  CursorError,
  DEFAULT_PAGE_SIZE,
  PageSizeError,
  type TypeSpec,
} from '@ascend/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openStore,
  pageEntries,
  recordEntry,
  registerType,
  type PageResult,
  type RecordContext,
  type Store,
} from '../src/index.js';

/**
 * `pageEntries` -- paging by `(recorded_at, id)`.
 *
 * The failure this module can have is not a crash. It is a page that looks entirely ordinary
 * and repeats or skips rows, which a reader cannot notice from a single page -- so the tests
 * that matter here walk the WHOLE type and check the walk, rather than checking one page in
 * isolation.
 *
 *   1. **The walk covers everything exactly once.** Every id present, none twice.
 *   2. **Writes during the walk do not disturb it.** Rows inserted before the cursor stay out
 *      (already passed), rows inserted after it are reached. This is the property offset
 *      paging lacks, and the test below demonstrates that it lacks it -- without that
 *      contrast, the stability assertion would pass even if the implementation were offset
 *      based and simply never raced.
 *   3. **A cursor belongs to one question.** Replaying it against another scope is refused.
 */

const dirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-pages-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const SPEC: TypeSpec = {
  name: 'note',
  properties: [{ name: 'body', type: 'string' }],
};

const OTHER: TypeSpec = {
  name: 'other',
  properties: [{ name: 'body', type: 'string' }],
};

const context = (id: string, recordedAt: string): RecordContext => ({
  id,
  recordedAt,
  ascendVersion: '0.0.0',
});

/** A store with both specs registered. */
const withStore = <T>(body: (store: Store) => T): T => {
  const store = openStore({ dir: tempDir() });
  try {
    for (const spec of [SPEC, OTHER])
      registerType(store.db, spec, { registeredAt: '2026-01-01T00:00:00.000Z' });
    return body(store);
  } finally {
    store.close();
  }
};

/**
 * Records `count` entries whose `recorded_at` is ALL THE SAME instant, inserted in DESCENDING
 * id order, and returns the ids in the order a correct page must produce them.
 *
 * Two deliberate properties, and both were forced by watching a mutation survive without them.
 *
 * **One shared timestamp** is what the real corpus looks like: a single `asc ingest` run stamps
 * every entry of a type with the same instant (measured -- every derived type has exactly one
 * distinct `recorded_at`). So the `id` tiebreak carries the ENTIRE order, and a fixture with
 * distinct timestamps would let a missing tiebreak pass.
 *
 * **Insertion order different from page order** is the part that is easy to miss. `entries` has
 * a rowid, so `ORDER BY recorded_at` alone returns rows in INSERTION order -- verified directly:
 * inserting `c, a, b` under one timestamp gives `c,a,b` from `ORDER BY recorded_at` and `a,b,c`
 * from `ORDER BY recorded_at, id`. A fixture seeded in ascending id order therefore makes the two
 * coincide, and dropping the `id` from the ORDER BY is undetectable. That is exactly what happened
 * here: the mutation survived until this helper inserted backwards.
 */
function seed(store: Store, count: number, at = '2026-09-11T10:00:00.000Z'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(`e-${String(i).padStart(3, '0')}`);
  }

  for (const id of [...ids].reverse()) {
    recordEntry(store.db, { type: SPEC.name, properties: { body: `body ${id}` } }, context(id, at));
  }

  return ids;
}

/** Collects every id reachable from a cursor chain, reporting the page sizes it saw. */
function walk(
  store: Store,
  limit: number,
  onPage?: (page: PageResult, index: number) => void,
): { ids: string[]; sizes: number[]; pages: number } {
  const ids: string[] = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = pageEntries(store.db, {
      type: SPEC.name,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages += 1;
    if (pages > 1000) throw new Error('walk did not terminate');
    sizes.push(page.rows.length);
    onPage?.(page, pages);
    ids.push(...page.rows.map((row) => row.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  return { ids, sizes, pages };
}

describe('paging: the walk', () => {
  it('covers every entry exactly once, across pages', () => {
    withStore((store) => {
      const seeded = seed(store, 25);
      const { ids, pages } = walk(store, 10);

      expect(pages).toBe(3);
      expect(ids).toHaveLength(25);
      expect(new Set(ids).size).toBe(25);
      // And in the order the definition of the cursor promises: by id, since every
      // recorded_at is identical.
      expect(ids).toStrictEqual([...seeded].sort());
    });
  });

  it('reports the whole-scope total on every page, and has_more only while there is more', () => {
    withStore((store) => {
      seed(store, 25);
      const seen: { total: number; hasMore: boolean; rows: number; next: string | null }[] = [];
      walk(store, 10, (page) => {
        seen.push({
          total: page.total,
          hasMore: page.hasMore,
          rows: page.rows.length,
          next: page.nextCursor,
        });
      });

      // 25 entries, pages of 10: 10, 10, 5.
      expect(seen.map((page) => page.rows)).toStrictEqual([10, 10, 5]);
      expect(seen.map((page) => page.hasMore)).toStrictEqual([true, true, false]);
      expect(seen.map((page) => page.next)).toStrictEqual([
        expect.any(String),
        expect.any(String),
        null,
      ]);
      // `total` is the scope, not the page -- it does not shrink as the walk proceeds.
      expect(seen.map((page) => page.total)).toStrictEqual([25, 25, 25]);
    });
  });

  it('stops after one page when the scope fits inside it', () => {
    withStore((store) => {
      seed(store, 3);
      const { ids, pages } = walk(store, 10);

      expect(pages).toBe(1);
      expect(ids).toHaveLength(3);
    });
  });

  /** Nothing to page is not an error, and it must not claim there is more. */
  it('reports an empty scope as zero rows and no cursor, not as a failure', () => {
    withStore((store) => {
      const page = pageEntries(store.db, { type: SPEC.name, limit: 10 });

      expect(page.rows).toStrictEqual([]);
      expect(page.total).toBe(0);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
    });
  });

  it('refuses a page size below one rather than serving an empty page', () => {
    withStore((store) => {
      expect(() => pageEntries(store.db, { type: SPEC.name, limit: 0 })).toThrow(PageSizeError);
      expect(() => pageEntries(store.db, { type: SPEC.name, limit: -1 })).toThrow(PageSizeError);
    });
  });

  /**
   * The default page size, which is the one number a caller who omits `--limit` receives.
   *
   * Asserted against the exported constant rather than a literal 40, and the scope of that claim
   * was measured rather than assumed. Mutating `DEFAULT_PAGE_SIZE` to 10 leaves this test GREEN
   * (both sides move together), while mutating the store to hardcode `10` instead of the constant
   * KILLS it. So what is pinned here is that the store HONOURS the shared constant -- the one
   * thing that can drift, since the CLI prints this number in `--limit`'s help text from the same
   * export. The value 40 itself is a design choice argued in `packages/core/src/cursor.ts`, and
   * pinning it with a test would be a change detector rather than a behaviour check.
   */
  it('serves DEFAULT_PAGE_SIZE rows when the caller does not ask for a size', () => {
    withStore((store) => {
      seed(store, DEFAULT_PAGE_SIZE + 5);

      const page = pageEntries(store.db, { type: SPEC.name });

      expect(page.rows).toHaveLength(DEFAULT_PAGE_SIZE);
      expect(page.total).toBe(DEFAULT_PAGE_SIZE + 5);
      expect(page.hasMore).toBe(true);
    });
  });
});

describe('paging: stability while the store is being written', () => {
  /**
   * The property the bead asks for: a walk must not repeat or skip rows when entries are
   * written underneath it.
   *
   * Both directions of drift are exercised, because they fail differently. An insert with an
   * EARLIER `recorded_at` sorts before the cursor and must not appear (it has been passed). An
   * insert with a LATER one sorts after and must appear. An offset walk gets both wrong in the
   * same way -- it shifts -- which is why the contrast test below exists.
   */
  it('neither repeats nor skips, when entries are inserted during the walk', () => {
    withStore((store) => {
      const seeded = seed(store, 25);

      const walked = walk(store, 10, (_page, index) => {
        if (index === 1) {
          // Before the cursor: sorts first, already passed, must NOT show up later.
          recordEntry(
            store.db,
            { type: SPEC.name, properties: { body: 'early' } },
            context('e-early', '2026-01-01T00:00:00.000Z'),
          );
          // After the cursor: sorts last, must show up.
          recordEntry(
            store.db,
            { type: SPEC.name, properties: { body: 'late' } },
            context('e-late', '2026-12-31T00:00:00.000Z'),
          );
        }
      });

      // Every seeded id, exactly once. Newly written entries may or may not be reached
      // depending on where they sort -- that is correct -- but no PRE-EXISTING row may be
      // lost or duplicated, which is the guarantee.
      expect(walked.ids).toHaveLength(new Set(walked.ids).size);
      for (const id of seeded) expect(walked.ids).toContain(id);
      // The one that sorts after the cursor is reached; the one that sorts before is not.
      expect(walked.ids).toContain('e-late');
      expect(walked.ids).not.toContain('e-early');
    });
  });

  /**
   * The contrast, and the reason the test above is not vacuous.
   *
   * The same interleaving against an OFFSET walk duplicates a row -- the classic failure. If
   * `pageEntries` were offset based, the walk above would have failed this way. Running the
   * offset version here proves the fixture can actually detect it, so a green result above
   * means the keyset is doing the work rather than the fixture being too gentle.
   */
  it('shows that an OFFSET walk over the same interleaving duplicates a row', () => {
    withStore((store) => {
      seed(store, 25);

      const ids: string[] = [];
      for (let page = 0; page < 3; page += 1) {
        const rows = store.db
          .prepare(
            'SELECT id FROM entries WHERE type_name = ? ORDER BY recorded_at, id LIMIT ? OFFSET ?',
          )
          .all(SPEC.name, 10, page * 10) as { id: string }[];
        ids.push(...rows.map((row) => row.id));
        if (page === 0) {
          recordEntry(
            store.db,
            { type: SPEC.name, properties: { body: 'early' } },
            context('e-early', '2026-01-01T00:00:00.000Z'),
          );
        }
      }

      // The insert shifted the window, so a row was served twice and another never was.
      expect(ids.length).toBeGreaterThan(new Set(ids).size);
    });
  });
});

describe('paging: the cursor as a token', () => {
  it('refuses a cursor issued for a different type, instead of paging the wrong rows', () => {
    withStore((store) => {
      seed(store, 12);
      const first = pageEntries(store.db, { type: SPEC.name, limit: 5 });
      expect(first.nextCursor).not.toBeNull();

      // Same position, wrong question. The rows would look completely ordinary.
      expect(() =>
        pageEntries(store.db, { type: OTHER.name, limit: 5, cursor: first.nextCursor as string }),
      ).toThrow(CursorError);
    });
  });

  it('carries the scope it was issued for', () => {
    withStore((store) => {
      seed(store, 12);
      const first = pageEntries(store.db, { type: SPEC.name, limit: 5 });
      const cursor = first.nextCursor as string;

      expect(cursor.startsWith(CURSOR_PREFIX)).toBe(true);
      // The same scope resolves; that is what makes the refusal above a scope check rather
      // than a blanket rejection of every cursor.
      expect(() => pageEntries(store.db, { type: SPEC.name, limit: 5, cursor })).not.toThrow();
    });
  });

  it.each([
    ['an empty string', ''],
    ['a bare position with no prefix', 'abc123'],
    ['the prefix with nothing after it', CURSOR_PREFIX],
    ['a prefix with unreadable payload', `${CURSOR_PREFIX}not-json`],
    ['payload that is not an object', `${CURSOR_PREFIX}${encodeURIComponent('[]')}`],
    ['payload missing its position', `${CURSOR_PREFIX}${encodeURIComponent('{"s":"abc"}')}`],
    [
      'payload with an empty id',
      `${CURSOR_PREFIX}${encodeURIComponent('{"r":"x","i":"","s":"abc"}')}`,
    ],
  ])('refuses %s', (_label, cursor) => {
    withStore((store) => {
      seed(store, 3);
      expect(() => pageEntries(store.db, { type: SPEC.name, limit: 2, cursor })).toThrow(
        CursorError,
      );
    });
  });
});

describe('paging: a type named under a non-canonical spelling (asc-pw2)', () => {
  const CAMEL: TypeSpec = {
    name: 'reviewKind',
    properties: [{ name: 'body', type: 'string' }],
  };

  it('pages a type by any spelling that canonicalizes to the registered name, and one scope', () => {
    const store = openStore({ dir: tempDir() });
    try {
      registerType(store.db, CAMEL, { registeredAt: '2026-01-01T00:00:00.000Z' });
      recordEntry(
        store.db,
        { type: 'reviewKind', properties: { body: 'a' } },
        context('e-000', '2026-09-11T10:00:00.000Z'),
      );

      const byRaw = pageEntries(store.db, { type: 'reviewKind', limit: 5 });
      const byCanonical = pageEntries(store.db, { type: 'review_kind', limit: 5 });

      expect(byRaw.total).toBe(1);
      expect(byCanonical.total).toBe(1);
      // Same identity, so the same scope fingerprint -- a cursor issued under one spelling
      // resumes under the other instead of being refused as a mismatch (see the `pages.ts`
      // doc comment on `pageEntries`).
      expect(byCanonical.scope).toBe(byRaw.scope);
    } finally {
      store.close();
    }
  });
});
