import { describe, expect, it } from 'vitest';
import {
  collapseNearDuplicates,
  jaccard,
  minHashSignature,
  NearDuplicateError,
  shingle,
  type DuplicateCandidate,
} from '../src/index.js';
import { mulberry32, seedOf } from '../src/random.js';

/**
 * `neardup.ts` -- collapse, checked against Jaccard arithmetic done by hand and against an exact
 * all-pairs clustering computed independently in this file.
 *
 * WHERE THE EXPECTED VALUES COME FROM. Every similarity asserted here is a small fraction written
 * out beside the assertion: three sets of ten one-token shingles give shared-over-union counts a
 * reader can check in their head. The MinHash assertions are the exception and are the one place a
 * tolerance appears, because a signature estimates a similarity rather than computing it; the
 * expectation there is the theorem (`P(min agrees) = J`) and the tolerance is a binomial standard
 * error, both written out below.
 *
 * THE TEST THAT MATTERS MOST IS "never merges a pair the exact clustering would not have merged".
 * The whole design of this module -- LSH proposes, exact Jaccard decides -- exists to make false
 * merges impossible from the index and possible only from the threshold and from chaining. That is
 * a claim about the code, not about a statistic, so it is checked differentially against a
 * brute-force all-pairs single-linkage clustering written independently in this file, over a corpus
 * with deliberate near-duplicates in it. A hand-written example cannot check it, because the failure
 * mode is a bucket collision that only appears at scale.
 */

/** The shingle separator, built without writing a NUL byte into this file. */
const NUL = String.fromCharCode(0);

/** `t01`..`tNN` -- fixed-width so the ids and tokens sort the way they read. */
function tokens(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `t${String(from + index).padStart(2, '0')}`);
}

describe('shingle', () => {
  it('builds overlapping k-grams', () => {
    // 4 tokens, k=3 -> 2 shingles: (a,b,c) and (b,c,d). Overlapping, so the count is n-k+1.
    expect(shingle(['a', 'b', 'c', 'd'], 3)).toEqual([`a${NUL}b${NUL}c`, `b${NUL}c${NUL}d`]);
  });

  it('degrades to the tokens themselves at k=1', () => {
    expect(shingle(['a', 'b', 'c'], 1)).toEqual(['a', 'b', 'c']);
  });

  it('makes one shingle of a document shorter than the window', () => {
    // Returning nothing here would give every short document an empty set, and an empty set is
    // identical to every other empty set -- the opposite of what "too short to compare" means.
    expect(shingle(['a', 'b'], 3)).toEqual([`a${NUL}b`]);
    expect(shingle(['a', 'b', 'c'], 3)).toEqual([`a${NUL}b${NUL}c`]);
  });

  it('gives an empty document no shingles', () => {
    expect(shingle([], 3)).toEqual([]);
  });

  it('refuses a window that is not a positive integer', () => {
    expect(() => shingle(['a'], 0)).toThrow(NearDuplicateError);
    expect(() => shingle(['a'], 1.5)).toThrow(NearDuplicateError);
  });

  it('cannot have a shingle boundary forged by a token', () => {
    // The separator is a NUL precisely so that no realistic token can contain one. Written through
    // `NUL` here rather than as a literal, because a literal NUL byte in a source file is invisible
    // in every diff a reviewer will ever look at.
    expect(shingle(['a', 'b'], 2)).toEqual([`a${NUL}b`]);
    expect(shingle([`a${NUL}b`, 'c'], 2)).toEqual([`a${NUL}b${NUL}c`]);
  });
});

describe('jaccard', () => {
  it('is shared over union', () => {
    // {1,2,3} and {2,3,4}: shared 2, union 4 -> 1/2.
    expect(jaccard(new Set(['1', '2', '3']), new Set(['2', '3', '4']))).toBe(0.5);
  });

  it('is 1 for two empty sets, by the usual convention', () => {
    // The set function keeps the convention. `collapseNearDuplicates` refuses to act on it -- see
    // the "holds empty documents out" test below, which is where the judgement lives.
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('is 0 when only one side is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('is 1 for equal sets and 0 for disjoint ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(1);
    expect(jaccard(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0);
  });
});

describe('minHashSignature', () => {
  it('is reproducible from its seed', () => {
    const set = new Set(tokens(1, 20));
    expect(minHashSignature(set, { permutations: 16, seed: 'fixed' })).toEqual(
      minHashSignature(set, { permutations: 16, seed: 'fixed' }),
    );
  });

  it('is identical for identical sets and differs for different ones', () => {
    const a = minHashSignature(new Set(tokens(1, 20)), { permutations: 16 });
    const b = minHashSignature(new Set(tokens(1, 20)), { permutations: 16 });
    const c = minHashSignature(new Set(tokens(50, 20)), { permutations: 16 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('agrees on about J of its positions', () => {
    // A = {t01..t09}, B = {t04..t12}: shared {t04..t09} = 6, union {t01..t12} = 12, J = 6/12 = 0.5.
    const a = new Set(tokens(1, 9));
    const b = new Set(tokens(4, 9));
    expect(jaccard(a, b)).toBe(0.5);

    const permutations = 128;
    const left = minHashSignature(a, { permutations });
    const right = minHashSignature(b, { permutations });
    const agreements = left.filter((value, index) => value === right[index]).length;
    const fraction = agreements / permutations;

    // The MinHash theorem says P(the two minima agree) = J, so the expectation is 0.5 exactly. The
    // observed fraction is a binomial mean over 128 draws with standard error
    // sqrt(0.5 * 0.5 / 128) = 0.0442; 0.15 is about 3.4 of those. This is the only tolerance in the
    // file, and it is a property of the estimator rather than slack for the implementation.
    expect(Math.abs(fraction - 0.5)).toBeLessThanOrEqual(0.15);
  });

  it('refuses a permutation count that is not a positive integer', () => {
    expect(() => minHashSignature(new Set(['a']), { permutations: 0 })).toThrow(NearDuplicateError);
  });
});

describe('collapseNearDuplicates', () => {
  it('merges a pair above the threshold and leaves it alone above its similarity', () => {
    // X = {t01..t10}, Y = {t01..t09, t11} with k=1 shingles: shared {t01..t09} = 9,
    // union {t01..t11} = 11, J = 9/11 = 0.8181818181818182.
    const documents: DuplicateCandidate[] = [
      { id: 'x', tokens: tokens(1, 10) },
      { id: 'y', tokens: [...tokens(1, 9), 't11'] },
    ];

    const merged = collapseNearDuplicates(documents, { shingleSize: 1, threshold: 0.8 });
    expect(merged.groups).toHaveLength(1);
    expect(merged.groups[0]?.members).toEqual(['x', 'y']);
    expect(merged.groups[0]?.minSimilarity).toBe(9 / 11);
    expect(merged.mergedPairs).toBe(1);
    expect(merged.collapsed).toBe(1);

    // 0.85 sits above 9/11, so the same pair is now two documents. The threshold is the decision,
    // and this is the test that says so.
    const apart = collapseNearDuplicates(documents, { shingleSize: 1, threshold: 0.85 });
    expect(apart.groups).toHaveLength(0);
    expect(apart.singletons).toEqual(['x', 'y']);
    expect(apart.mergedPairs).toBe(0);
    expect(apart.collapsed).toBe(2);
  });

  it('reports a chained group as chained, and prices the chain in minSimilarity', () => {
    // A = {t01..t10}, B = {t02..t11}, C = {t03..t12}, all at k=1.
    //   A,B: shared {t02..t10} = 9, union {t01..t11} = 11 -> 9/11 = 0.8181818181818182  (>= 0.8)
    //   B,C: shared {t03..t11} = 9, union {t02..t12} = 11 -> 9/11 = 0.8181818181818182  (>= 0.8)
    //   A,C: shared {t03..t10} = 8, union {t01..t12} = 12 -> 8/12 = 0.6666666666666666  (<  0.8)
    // Single linkage puts all three in one group. Nothing here is wrong -- but a reader told only
    // "3 near-duplicates" has been told that A and C are the same thing, and they are not.
    const report = collapseNearDuplicates(
      [
        { id: 'a', tokens: tokens(1, 10) },
        { id: 'b', tokens: tokens(2, 10) },
        { id: 'c', tokens: tokens(3, 10) },
      ],
      { shingleSize: 1, threshold: 0.8 },
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.members).toEqual(['a', 'b', 'c']);
    expect(report.groups[0]?.count).toBe(3);
    expect(report.groups[0]?.maxSimilarity).toBe(9 / 11);
    expect(report.groups[0]?.minSimilarity).toBe(8 / 12);
    expect(report.chainedGroups).toBe(1);
    // The weakest pair is the one the index never proposed -- two of the three pairs merged.
    expect(report.mergedPairs).toBe(2);
  });

  it('counts no chaining when every pair in the group clears the threshold', () => {
    // a = b = {t01..t05}, c = {t01..t06}, k=1.
    //   a,b: identical -> 1
    //   a,c and b,c: shared 5, union 6 -> 5/6 = 0.8333333333333334 (>= 0.8)
    const report = collapseNearDuplicates(
      [
        { id: 'b', tokens: tokens(1, 5) },
        { id: 'a', tokens: tokens(1, 5) },
        { id: 'c', tokens: tokens(1, 6) },
      ],
      { shingleSize: 1, threshold: 0.8 },
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.minSimilarity).toBe(5 / 6);
    expect(report.groups[0]?.maxSimilarity).toBe(1);
    expect(report.chainedGroups).toBe(0);
    // Longest wins: c has six tokens where a and b have five.
    expect(report.groups[0]?.representative).toBe('c');
  });

  it('breaks a tie for representative by id', () => {
    // Same content, same length -- so the only thing left to decide with is the id, and it has to
    // decide, or two runs over one store disagree about which row a reader sees.
    const report = collapseNearDuplicates(
      [
        { id: 'zebra', tokens: tokens(1, 5) },
        { id: 'aardvark', tokens: tokens(1, 5) },
      ],
      { shingleSize: 1, threshold: 0.8 },
    );
    expect(report.groups[0]?.representative).toBe('aardvark');
  });

  it('separates a reversed document at k=2 that a bag of words would call identical', () => {
    const forward: DuplicateCandidate = { id: 'f', tokens: ['a', 'b', 'c', 'd'] };
    const backward: DuplicateCandidate = { id: 'b', tokens: ['d', 'c', 'b', 'a'] };

    // As bags: both are {a,b,c,d}, J = 1.
    const asBags = collapseNearDuplicates([forward, backward], { shingleSize: 1, threshold: 0.8 });
    expect(asBags.groups).toHaveLength(1);

    // As bigrams: {ab, bc, cd} against {dc, cb, ba}, shared 0, union 6, J = 0. Word order is most of
    // what separates two similar sentences, and this is the setting that keeps it.
    const asBigrams = collapseNearDuplicates([forward, backward], {
      shingleSize: 2,
      threshold: 0.8,
    });
    expect(asBigrams.groups).toHaveLength(0);
    expect(asBigrams.singletons).toEqual(['b', 'f']);
  });

  it('holds empty documents out instead of collapsing them into one enormous group', () => {
    // Three documents with no tokens and one with tokens. Jaccard says the three empties are all
    // identical to one another; this module says an empty intersection is not evidence. On the real
    // store this is the difference between a truthful report and one whose largest finding is
    // "1,702 entries all say the same nothing".
    const report = collapseNearDuplicates(
      [
        { id: 'e1', tokens: [] },
        { id: 'e2', tokens: [] },
        { id: 'e3', tokens: [] },
        { id: 'full', tokens: tokens(1, 10) },
      ],
      { shingleSize: 1, threshold: 0.8 },
    );

    expect(report.groups).toHaveLength(0);
    expect(report.singletons).toEqual(['e1', 'e2', 'e3', 'full']);
    expect(report.emptyDocuments).toBe(3);
    expect(report.documents).toBe(4);
    expect(report.collapsed).toBe(4);
  });

  it('gives the same report whatever order the documents arrive in', () => {
    const documents: DuplicateCandidate[] = [
      { id: 'a', tokens: tokens(1, 10) },
      { id: 'b', tokens: tokens(2, 10) },
      { id: 'c', tokens: tokens(3, 10) },
      { id: 'd', tokens: tokens(40, 10) },
    ];
    const forward = collapseNearDuplicates(documents, { shingleSize: 1, threshold: 0.8 });
    const reversed = collapseNearDuplicates([...documents].reverse(), {
      shingleSize: 1,
      threshold: 0.8,
    });
    expect(reversed).toEqual(forward);
  });

  it('handles an empty corpus', () => {
    const report = collapseNearDuplicates([], {});
    expect(report.groups).toEqual([]);
    expect(report.singletons).toEqual([]);
    expect(report.documents).toBe(0);
    expect(report.collapsed).toBe(0);
    expect(report.candidatePairs).toBe(0);
  });

  it('refuses parameters it cannot honour', () => {
    const one: DuplicateCandidate[] = [{ id: 'a', tokens: ['x'] }];
    expect(() => collapseNearDuplicates(one, { threshold: 1.5 })).toThrow(NearDuplicateError);
    expect(() => collapseNearDuplicates(one, { threshold: -0.1 })).toThrow(NearDuplicateError);
    // 32 does not divide 100, so a band would straddle a row boundary.
    expect(() => collapseNearDuplicates(one, { permutations: 100, bands: 32 })).toThrow(
      NearDuplicateError,
    );
    expect(() =>
      collapseNearDuplicates([
        { id: 'a', tokens: ['x'] },
        { id: 'a', tokens: ['y'] },
      ]),
    ).toThrow(NearDuplicateError);
  });
});

/**
 * Exact single-linkage clustering, all pairs, no index -- the thing `collapseNearDuplicates` is
 * supposed to be a fast approximation of. Written here rather than imported so that a bug in the
 * module cannot also be a bug in its own oracle.
 */
function exactGroups(
  documents: readonly DuplicateCandidate[],
  shingleSize: number,
  threshold: number,
): string[][] {
  const sets = documents.map((document) => new Set(shingle(document.tokens, shingleSize)));
  const parent = documents.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    return root;
  };

  for (let i = 0; i < documents.length; i += 1) {
    for (let j = i + 1; j < documents.length; j += 1) {
      // The module holds empty documents out; the oracle must do the same, or the two are being
      // asked different questions.
      if ((sets[i] as Set<string>).size === 0 || (sets[j] as Set<string>).size === 0) continue;
      if (jaccard(sets[i] as Set<string>, sets[j] as Set<string>) >= threshold) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootJ] = rootI;
      }
    }
  }

  const byRoot = new Map<number, string[]>();
  for (let index = 0; index < documents.length; index += 1) {
    const root = find(index);
    const bucket = byRoot.get(root);
    const id = (documents[index] as DuplicateCandidate).id;
    if (bucket === undefined) byRoot.set(root, [id]);
    else bucket.push(id);
  }

  return [...byRoot.values()]
    .map((ids) => [...ids].sort())
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

describe('collapseNearDuplicates against an exact all-pairs clustering', () => {
  /**
   * 300 documents built from 20 templates, each mutated by replacing a few tokens. The mutation
   * count is what makes the corpus interesting: some mutated copies stay above the threshold and
   * some fall below it, so the clustering has real decisions to make rather than twenty obvious
   * blocks.
   */
  function corpus(): DuplicateCandidate[] {
    const next = mulberry32(seedOf('neardup-differential'));
    const templates = Array.from({ length: 20 }, (_, t) =>
      Array.from({ length: 24 }, (_, w) => `w${String(t)}_${String(w)}`),
    );

    return Array.from({ length: 300 }, (_, index) => {
      const template = templates[Math.floor(next() * templates.length)] as string[];
      const words = [...template];
      const mutations = Math.floor(next() * 7);
      for (let m = 0; m < mutations; m += 1) {
        words[Math.floor(next() * words.length)] = `x${String(Math.floor(next() * 40))}`;
      }
      return { id: `d${String(index).padStart(3, '0')}`, tokens: words };
    });
  }

  it('never merges a pair the exact clustering leaves apart', () => {
    const documents = corpus();
    const threshold = 0.8;
    const report = collapseNearDuplicates(documents, { shingleSize: 3, threshold });
    const exact = exactGroups(documents, 3, threshold);

    // CORRECTNESS. Every group the index produced must sit inside one exact group. A violation here
    // means a signature collision merged something the real similarity does not support -- the one
    // failure this module's whole design is built to exclude.
    const exactOf = new Map<string, number>();
    exact.forEach((group, groupIndex) => {
      for (const id of group) exactOf.set(id, groupIndex);
    });

    for (const group of report.groups) {
      const homes = new Set(group.members.map((id) => exactOf.get(id)));
      expect(homes.size).toBe(1);
    }
  });

  it('recovers the exact clustering, which is recall and not correctness', () => {
    const documents = corpus();
    const threshold = 0.8;
    const report = collapseNearDuplicates(documents, { shingleSize: 3, threshold });
    const exact = exactGroups(documents, 3, threshold);

    // A pair at J = 0.8 matches a band of 4 rows with probability 0.8^4 = 0.4096, and misses all 32
    // bands with probability (1 - 0.4096)^32 = 5.6e-9. Recovering the exact clustering is therefore
    // the expected outcome rather than a lucky one -- but it is a separate assertion from the one
    // above on purpose. If this fails while the one above passes, the index lost a pair it should
    // have proposed; nothing merged that should not have.
    const found = report.groups
      .map((group) => [...group.members].sort())
      .concat(report.singletons.map((id) => [id]))
      .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));

    expect(found).toEqual(exact);
  });
});
