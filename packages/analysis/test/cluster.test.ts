import { describe, expect, it } from 'vitest';
import {
  cluster,
  ClusterError,
  cosine,
  clusterPermutationNull as permutationNull,
  sweepThreshold,
  tfidf,
  type ClusterDocument,
  type Linkage,
} from '../src/index.js';
import { mulberry32, seedOf } from '../src/random.js';

/**
 * `cluster.ts` -- TF-IDF cosine agglomerative clustering, checked against arithmetic small enough
 * to do by hand and against a naive clustering written independently in this file.
 *
 * WHERE THE EXPECTED VALUES COME FROM. The weights are `log(N/df)` on corpora of three and four
 * documents, so every one of them is a logarithm of a small integer written out beside its
 * assertion. The clustering anchors use corpora built from disjoint vocabularies, where every
 * cosine is exactly 0 or exactly 1 and the silhouette is therefore exactly 1 or exactly 0 -- no
 * tolerance anywhere in this file.
 *
 * THE TEST THAT MATTERS MOST IS "agrees with the naive algorithm on all three linkages". The
 * nearest-neighbour chain is the one piece of this module a reader cannot check by inspection: it
 * reaches the same dendrogram as repeated-minimum search by an argument about reducible linkages,
 * not by doing the same thing faster. So it is checked differentially against a naive
 * repeated-minimum implementation written in this file, over a pseudo-random corpus, for every
 * linkage. A hand example cannot check it, because a chain bug shows up as a slightly wrong merge
 * height deep in a dendrogram rather than as an obviously wrong cluster.
 *
 * THE SECOND MOST IMPORTANT TEST IS "finds clusters in a corpus that has none". Agglomerative
 * clustering always returns something; the silhouette is what says whether the something is real,
 * and there is a test below asserting it is exactly 0 on a corpus of mutually disjoint documents.
 */

describe('tfidf', () => {
  it('gives a term in every document exactly no weight', () => {
    // N=3. 'a' appears in all three: idf = log(3/3) = 0, so it cannot separate anything and is not
    // in the vocabulary at all. 'b', 'c', 'd' appear once each: idf = log(3) = 1.0986122886681098.
    // Each document then has ONE weighted term, so after L2 normalisation its weight is exactly 1.
    const { vectors, vocabulary } = tfidf([
      { id: 'd1', tokens: ['a', 'b'] },
      { id: 'd2', tokens: ['a', 'c'] },
      { id: 'd3', tokens: ['a', 'd'] },
    ]);

    expect(vocabulary).toEqual(['b', 'c', 'd']);
    expect(vectors[0]?.weights.get('a')).toBeUndefined();
    expect(vectors[0]?.weights.get('b')).toBe(1);
    expect(vectors[1]?.weights.get('c')).toBe(1);
    // Nothing shared, so nothing in common -- which is the whole point of dropping 'a'.
    expect(cosine(vectors[0]!.weights, vectors[1]!.weights)).toBe(0);
  });

  it('damps a repeated term, and does not when asked not to', () => {
    // 'x' three times and 'y' once, in a corpus where both have the same idf, so the idf cancels
    // out of the ratio entirely and the ratio is the tf rule alone.
    //   sublinear: (1 + log 3) / 1
    //   raw:                    3 / 1 = 3
    //
    // The sublinear side is written as the expression rather than as a transcribed decimal. Both
    // weights pass through an L2 normalisation before the ratio is taken, and dividing by a norm
    // and then dividing the results is not bit-for-bit the same as not doing either -- a decimal
    // copied from a calculator lands one ulp away and the test fails for a reason that has nothing
    // to do with the tf rule it is checking.
    const corpus: ClusterDocument[] = [
      { id: 'a', tokens: ['x', 'x', 'x', 'y'] },
      { id: 'b', tokens: ['x', 'y'] },
      { id: 'c', tokens: ['q', 'r'] },
    ];

    const damped = tfidf(corpus).vectors[0]!.weights;
    expect(damped.get('x')! / damped.get('y')!).toBe(1 + Math.log(3));

    const raw = tfidf(corpus, { sublinearTf: false }).vectors[0]!.weights;
    expect(raw.get('x')! / raw.get('y')!).toBe(3);
  });

  it('normalises each vector to unit length', () => {
    // 'p' and 'q' each appear in 2 of 4 documents: idf = log(2) = 0.6931471805599453 for both.
    // Equal weights, so after normalisation each is 1/sqrt(2) -- asserted as `Math.SQRT1_2`, which
    // is that number to the bit. Written `1 / Math.sqrt(2)` it is one ulp lower and this fails:
    // the module reaches the value as `w / sqrt(2 * w * w)`, and the three spellings of the same
    // quantity do not all round the same way.
    const { vectors } = tfidf([
      { id: 'a', tokens: ['p', 'q'] },
      { id: 'b', tokens: ['p', 'q'] },
      { id: 'c', tokens: ['r', 's'] },
      { id: 'd', tokens: ['r', 's'] },
    ]);
    expect(vectors[0]?.weights.get('p')).toBe(Math.SQRT1_2);
    expect(vectors[0]?.weights.get('q')).toBe(Math.SQRT1_2);
    // Two identical documents, so their cosine is exactly 1: 0.5 + 0.5.
    expect(cosine(vectors[0]!.weights, vectors[1]!.weights)).toBe(1);
  });

  it('gives a document with no weighted terms an empty vector', () => {
    // Every term is in every document, so every idf is 0 and no document has anything to compare.
    const { vectors, vocabulary } = tfidf([
      { id: 'a', tokens: ['z'] },
      { id: 'b', tokens: ['z'] },
    ]);
    expect(vocabulary).toEqual([]);
    expect(vectors[0]?.weights.size).toBe(0);
    expect(cosine(vectors[0]!.weights, vectors[1]!.weights)).toBe(0);
  });
});

describe('cosine', () => {
  it('is the dot product of two unit vectors', () => {
    // 0.6 * 1 + 0.8 * 0 = 0.6.
    expect(
      cosine(
        new Map([
          ['x', 0.6],
          ['y', 0.8],
        ]),
        new Map([['x', 1]]),
      ),
    ).toBe(0.6);
  });

  it('is 0 when nothing is shared', () => {
    expect(cosine(new Map([['x', 1]]), new Map([['y', 1]]))).toBe(0);
    expect(cosine(new Map(), new Map([['y', 1]]))).toBe(0);
  });
});

describe('cluster', () => {
  /** Two pairs of identical documents over disjoint vocabularies. Every cosine is 0 or 1. */
  const twoTightClusters: ClusterDocument[] = [
    { id: 'a1', tokens: ['p', 'q'] },
    { id: 'a2', tokens: ['p', 'q'] },
    { id: 'b1', tokens: ['r', 's'] },
    { id: 'b2', tokens: ['r', 's'] },
  ];

  it('separates two tight clusters exactly', () => {
    // Within a pair the distance is 1 - 1 = 0; across pairs it is 1 - 0 = 1. So at the default cut
    // of 0.8 the two pairs merge and the two clusters do not. Every document then has a = 0 and
    // b = 1, so every silhouette is (1 - 0) / 1 = 1 exactly, and so is the mean.
    const report = cluster(twoTightClusters);

    expect(report.clusters).toHaveLength(2);
    expect(report.clusters.map((entry) => entry.members)).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
    expect(report.silhouette).toBe(1);
    expect(report.clusters[0]?.silhouette).toBe(1);
    expect(report.clusters[0]?.cohesion).toBe(1);
    expect(report.singletons).toBe(0);
    expect(report.documents).toBe(4);
    // Every term is in exactly half the corpus, so all four survive with idf log(2).
    expect(report.vocabulary).toBe(4);
    // Four documents is under MIN_N, and the report says so however clean the arithmetic is.
    expect(report.underpowered).toBe(true);
  });

  it('scores a corpus with no structure at exactly zero', () => {
    // Four documents sharing nothing. Every distance is 1, so nothing merges below 0.8 and every
    // document is a singleton. A singleton scores 0, not 1 -- and the mean is therefore 0, which
    // is the number that distinguishes "four clusters" from "four clusters that mean something".
    //
    // This is the test that keeps the module honest: it still returns clusters. It has to. What it
    // must not do is report them as separated.
    const report = cluster([
      { id: 'a', tokens: ['p', 'q'] },
      { id: 'b', tokens: ['r', 's'] },
      { id: 'c', tokens: ['t', 'u'] },
      { id: 'd', tokens: ['v', 'w'] },
    ]);

    expect(report.clusters).toHaveLength(4);
    expect(report.singletons).toBe(4);
    expect(report.silhouette).toBe(0);
  });

  it('merges everything when the cut is wide enough, and nothing when it is not', () => {
    // Distance across the pairs is exactly 1, so a cut at 1 takes it and a cut just under does not.
    expect(cluster(twoTightClusters, { threshold: 1 }).clusters).toHaveLength(1);
    expect(cluster(twoTightClusters, { threshold: 0.999 }).clusters).toHaveLength(2);
    // And a cut below the within-pair distance of 0 leaves every document alone.
    expect(cluster(twoTightClusters, { threshold: -0 }).clusters).toHaveLength(2);
  });

  it('labels a cluster with its heaviest centroid terms', () => {
    const report = cluster(twoTightClusters, { topTerms: 2 });
    const first = report.clusters[0]!;
    expect(first.terms.map((entry) => entry.term).sort()).toEqual(['p', 'q']);
    // Both members are identical, so the centroid is that document and each weight is 1/sqrt(2).
    expect(first.terms[0]?.weight).toBe(Math.SQRT1_2);
  });

  it('picks a real document as the representative', () => {
    const report = cluster(twoTightClusters);
    for (const entry of report.clusters) expect(entry.members).toContain(entry.representative);
    // Identical members, so the tie falls to the smaller id.
    expect(report.clusters[0]?.representative).toBe('a1');
  });

  it('gives the same report whatever order the documents arrive in', () => {
    const forward = cluster(twoTightClusters);
    const reversed = cluster([...twoTightClusters].reverse());
    expect(reversed).toEqual(forward);
  });

  it('handles an empty corpus', () => {
    const report = cluster([]);
    expect(report.clusters).toEqual([]);
    expect(report.documents).toBe(0);
    expect(report.vocabulary).toBe(0);
    expect(report.silhouette).toBe(0);
    expect(report.underpowered).toBe(true);
  });

  it('refuses parameters it cannot honour', () => {
    expect(() => cluster(twoTightClusters, { threshold: 2.5 })).toThrow(ClusterError);
    expect(() => cluster(twoTightClusters, { threshold: -1 })).toThrow(ClusterError);
    expect(() => cluster(twoTightClusters, { topTerms: 0 })).toThrow(ClusterError);
    expect(() =>
      cluster([
        { id: 'a', tokens: ['x'] },
        { id: 'a', tokens: ['y'] },
      ]),
    ).toThrow(ClusterError);
  });
});

describe('sweepThreshold', () => {
  it('cuts one dendrogram repeatedly', () => {
    const points = sweepThreshold(
      [
        { id: 'a1', tokens: ['p', 'q'] },
        { id: 'a2', tokens: ['p', 'q'] },
        { id: 'b1', tokens: ['r', 's'] },
        { id: 'b2', tokens: ['r', 's'] },
      ],
      [0, 0.5, 1],
    );

    // At 0 the within-pair merges (height 0) already apply, so there are 2 clusters, not 4.
    expect(points.map((point) => point.clusters)).toEqual([2, 2, 1]);
    expect(points[0]?.silhouette).toBe(1);
    expect(points[1]?.largest).toBe(2);
    // Everything in one cluster has no other cluster to be compared with: silhouette 0.
    expect(points[2]?.silhouette).toBe(0);
  });

  it('refuses an empty sweep', () => {
    expect(() => sweepThreshold([{ id: 'a', tokens: ['x'] }], [])).toThrow(ClusterError);
  });
});

/** A structured corpus: 6 topics of 8 documents each, drawn from per-topic vocabularies. */
function structuredCorpus(): ClusterDocument[] {
  const next = mulberry32(seedOf('cluster-structured'));
  const documents: ClusterDocument[] = [];
  for (let topic = 0; topic < 6; topic += 1) {
    const vocabulary = Array.from({ length: 12 }, (_, w) => `t${String(topic)}_${String(w)}`);
    for (let index = 0; index < 8; index += 1) {
      const tokens = Array.from(
        { length: 9 },
        () => vocabulary[Math.floor(next() * vocabulary.length)] as string,
      );
      documents.push({ id: `d${String(topic)}_${String(index)}`, tokens });
    }
  }
  return documents;
}

/** The same six topics, plus one token per document from four terms every topic shares. */
function chainableCorpus(): ClusterDocument[] {
  const next = mulberry32(seedOf('cluster-structured'));
  const documents: ClusterDocument[] = [];
  for (let topic = 0; topic < 6; topic += 1) {
    const vocabulary = Array.from({ length: 12 }, (_, w) => `t${String(topic)}_${String(w)}`);
    for (let index = 0; index < 8; index += 1) {
      const tokens = Array.from(
        { length: 9 },
        () => vocabulary[Math.floor(next() * vocabulary.length)] as string,
      );
      tokens.push(`shared${String(Math.floor(next() * 4))}`);
      documents.push({ id: `d${String(topic)}_${String(index)}`, tokens });
    }
  }
  return documents;
}

describe('permutationNull', () => {
  it('scores a real structure above the shuffles that destroy it', () => {
    const documents = structuredCorpus();
    const observed = cluster(documents, { threshold: 0.9 }).silhouette;
    const control = permutationNull(documents, { threshold: 0.9, iterations: 99 });

    // The shuffle keeps the vocabulary, every term's total frequency and every document's length,
    // and destroys only which terms appear together. Six disjoint topic vocabularies are exactly
    // the structure that cannot survive that, so the observed silhouette should clear the whole
    // null. The assertion is against the null's MAXIMUM rather than its mean, because clearing an
    // average is a much weaker claim than clearing every draw.
    expect(observed).toBeGreaterThan(control.max);
    expect(control.pValue(observed)).toBe(1 / 100);
    expect(control.min).toBeLessThanOrEqual(control.median);
    expect(control.median).toBeLessThanOrEqual(control.max);
    expect(control.silhouettes).toHaveLength(99);
  });

  it('is reproducible from its seed', () => {
    const documents = structuredCorpus();
    const first = permutationNull(documents, { threshold: 0.9, iterations: 9, seed: 'fixed' });
    const again = permutationNull(documents, { threshold: 0.9, iterations: 9, seed: 'fixed' });
    expect(again.silhouettes).toEqual(first.silhouettes);
  });

  it('refuses an iteration count that is not a positive integer', () => {
    expect(() => permutationNull([{ id: 'a', tokens: ['x'] }], { iterations: 0 })).toThrow(
      ClusterError,
    );
  });
});

/**
 * Naive agglomerative clustering: scan every pair, merge the closest, repeat. O(n^3) and obviously
 * correct, which is the only property wanted of an oracle. Written here rather than imported so a
 * bug in the chain algorithm cannot also be a bug in the thing checking it.
 */
function naiveLabels(
  documents: readonly ClusterDocument[],
  linkage: Linkage,
  threshold: number,
): string[][] {
  const ordered = [...documents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { vectors } = tfidf(ordered);
  const n = ordered.length;
  const d: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1)
    for (let j = i + 1; j < n; j += 1) {
      const value = 1 - cosine(vectors[i]!.weights, vectors[j]!.weights);
      d[i]![j] = value;
      d[j]![i] = value;
    }

  const members: string[][] = ordered.map((document) => [document.id]);
  const alive = new Array<boolean>(n).fill(true);

  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j += 1) {
        if (!alive[j]) continue;
        if (d[i]![j]! < best) {
          best = d[i]![j]!;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1 || best > threshold) break;

    const sizeI = members[bestI]!.length;
    const sizeJ = members[bestJ]!.length;
    for (let m = 0; m < n; m += 1) {
      if (!alive[m] || m === bestI || m === bestJ) continue;
      const left = d[bestI]![m]!;
      const right = d[bestJ]![m]!;
      const updated =
        linkage === 'single'
          ? Math.min(left, right)
          : linkage === 'complete'
            ? Math.max(left, right)
            : (sizeI * left + sizeJ * right) / (sizeI + sizeJ);
      d[bestI]![m] = updated;
      d[m]![bestI] = updated;
    }
    members[bestI] = [...members[bestI]!, ...members[bestJ]!];
    alive[bestJ] = false;
  }

  return members
    .filter((_, index) => alive[index])
    .map((ids) => [...ids].sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

describe('cluster against a naive agglomerative clustering', () => {
  for (const linkage of ['average', 'complete', 'single'] as const) {
    it(`agrees with repeated-minimum search on ${linkage} linkage`, () => {
      const documents = structuredCorpus();
      for (const threshold of [0.5, 0.7, 0.9]) {
        const fast = cluster(documents, { linkage, threshold }).clusters.map((entry) =>
          [...entry.members].sort(),
        );
        fast.sort((a, b) => a[0]!.localeCompare(b[0]!));
        expect(fast).toEqual(naiveLabels(documents, linkage, threshold));
      }
    });
  }

  it('fragments under complete linkage where the other two have found the topics', () => {
    // The header claims complete linkage merges on the WORST pair and so lets one outlier hold a
    // genuine cluster apart. Measured on this corpus at a cut of 0.7: average and single linkage
    // have both recovered exactly the six planted topics, and complete linkage is still holding 16
    // pieces. That is the failure, in the direction the header says it goes.
    const documents = structuredCorpus();
    expect(cluster(documents, { linkage: 'average', threshold: 0.7 }).clusters).toHaveLength(6);
    expect(cluster(documents, { linkage: 'single', threshold: 0.7 }).clusters).toHaveLength(6);
    expect(
      cluster(documents, { linkage: 'complete', threshold: 0.7 }).clusters.length,
    ).toBeGreaterThan(6);
  });

  it('chains everything into one cluster under single linkage, and scores it 0', () => {
    // On `structuredCorpus` the six topic vocabularies are disjoint, so there is no thread for
    // single linkage to walk and all three linkages agree -- a corpus too clean to tell them
    // apart. `chainableCorpus` adds ONE token per document drawn from four terms every topic
    // shares, which is all it takes: at a cut of 0.95 single linkage collapses all 48 documents
    // into one cluster while average linkage still holds the six topics of eight.
    //
    // And this is what the silhouette is for. Single linkage returns an answer -- one cluster,
    // with top terms that will read like a label. Its silhouette is exactly 0, because a single
    // cluster has nothing to be separated from. The clustering is not wrong so much as empty, and
    // only the score says so.
    const documents = chainableCorpus();
    const chained = cluster(documents, { linkage: 'single', threshold: 0.95 });
    const averaged = cluster(documents, { linkage: 'average', threshold: 0.95 });

    expect(chained.clusters).toHaveLength(1);
    expect(chained.clusters[0]?.size).toBe(48);
    expect(chained.silhouette).toBe(0);

    expect(averaged.clusters).toHaveLength(6);
    expect(averaged.clusters[0]?.size).toBe(8);
    expect(averaged.silhouette).toBeGreaterThan(0);
  });
});
