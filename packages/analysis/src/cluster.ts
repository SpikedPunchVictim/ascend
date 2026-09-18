/**
 * Lexical clustering -- turn "read 500 entries" into "read 12 clusters, three examples each".
 *
 * NO EMBEDDINGS, and that is a constraint rather than a shortcut: `mast` deleted its vector leg, so
 * this store has no model to call and no vectors to store. What it has is text, and TF-IDF over
 * token n-grams with cosine similarity is the thing that works without a model. It is also honest
 * about what it measures: shared WORDS, not shared meaning. Two entries about the same defect in
 * different vocabulary will not cluster here, and this module makes no claim that they should.
 *
 * THE CENTRAL PROBLEM: AGGLOMERATIVE CLUSTERING ALWAYS RETURNS CLUSTERS.
 *
 * Feed it pure noise and it returns a dendrogram, cut it anywhere and it returns groups, and the
 * groups have top terms that read like labels because any set of documents has terms that appear in
 * it more than elsewhere. This is the same failure `changepoint.ts` has -- both of its tests find a
 * break in a flat series every time -- and it gets the same answer: the structure is never the
 * finding on its own. Every cluster carries a SILHOUETTE, and the report carries the mean over
 * every document, so a caller can see the difference between "twelve clusters" and "twelve
 * clusters that are actually separated". `permutationNull` goes further and gives that mean a null
 * to be compared against, by reshuffling which document each token belongs to: the vocabulary and
 * every document length survive the shuffle, and only co-occurrence -- the thing clustering claims
 * to have found -- is destroyed. A clustering that scores no better than that null found nothing,
 * however good its top terms look.
 *
 * AVERAGE LINKAGE IS THE DEFAULT, AND THE OTHER TWO ARE OFFERED BECAUSE THEY LOSE DIFFERENTLY.
 * Single linkage chains: it merges on one close pair, so a thread of marginal similarities drags
 * unrelated documents into one cluster, and `neardup.ts` exists partly to price that same effect.
 * Complete linkage is the opposite failure -- it merges on the WORST pair, so one outlier keeps a
 * genuine cluster apart, and it tends to return clusters of near-equal size whether or not the data
 * has any. Average linkage sits between them and is what the text-clustering literature uses. All
 * three are Lance-Williams reducible, so all three run on the same algorithm; the caller picks, and
 * `docs/evidence/` records which one lost on this corpus.
 *
 * THE CUT IS A PARAMETER, NOT A DISCOVERY. A dendrogram is a hierarchy; a list of clusters is a
 * hierarchy cut at a height. There is no way to choose that height from the data alone without
 * smuggling in an assumption, so `threshold` is an explicit cosine distance and the report echoes
 * it. `sweepThreshold` evaluates a range of cuts and reports the silhouette at each, which is a
 * criterion a caller can apply deliberately -- not the module choosing for them and calling the
 * result a finding.
 *
 * IDF DROPS THE WORDS EVERY DOCUMENT USES, for free and without a stopword list. A term in all N
 * documents has `log(N/N) = 0` weight, so it contributes nothing to any similarity. That is why no
 * stopword list ships here: a hand-written list is a claim about English, and this corpus is not
 * English -- it is half identifiers and command names.
 *
 * COST. The distance matrix is O(n^2) in memory and the nearest-neighbour-chain algorithm is O(n^2)
 * in time, which is the good case for agglomerative clustering rather than the naive O(n^3). The
 * chain algorithm is subtle enough that it is checked in the tests against a naive implementation
 * written independently there, over a corpus large enough that a hand example could not have found
 * the difference.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`).
 */

import { MIN_N } from './proportion.js';
import { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

/** A caller handed this module something it will not cluster. */
export class ClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterError';
  }
}

/** How clusters are joined. See the header: these lose differently, which is why all three exist. */
export type Linkage = 'average' | 'complete' | 'single';

/** One document, already tokenised by the caller. */
export interface ClusterDocument {
  /** Stable identity. Ties in every ordering here are broken by it. */
  readonly id: string;
  /** The document's tokens. Order is irrelevant to TF-IDF; the caller may shingle first. */
  readonly tokens: readonly string[];
}

/** A term and the weight it carries in a cluster's centroid. */
export interface ClusterTerm {
  readonly term: string;
  /** Mean TF-IDF weight over the cluster's members. */
  readonly weight: number;
}

/** A set of documents joined below the cut, with the numbers needed to disbelieve it. */
export interface Cluster {
  /** The member closest to the cluster's centroid -- a real document, never a synthetic average. */
  readonly representative: string;
  /** Every member, by id, ascending. */
  readonly members: readonly string[];
  /** How many documents. */
  readonly size: number;
  /** The heaviest terms in the centroid, descending. A label to read, not a claim. */
  readonly terms: readonly ClusterTerm[];
  /** Mean pairwise cosine SIMILARITY inside the cluster. 1 for a singleton by convention. */
  readonly cohesion: number;
  /**
   * Mean silhouette over the members, in [-1, 1]. Above 0 the members are closer to their own
   * cluster than to the nearest other one; at or below 0 the cluster is not separated from its
   * neighbour and its top terms are decoration. 0 for a singleton, by the usual convention.
   */
  readonly silhouette: number;
}

/** How the clustering is asked for. */
export interface ClusterOptions {
  /** Cosine DISTANCE (1 - cosine similarity) at which to cut the dendrogram. Default 0.8. */
  readonly threshold?: number;
  /** How clusters are joined. Default `'average'`. */
  readonly linkage?: Linkage;
  /**
   * Use `1 + log(count)` in place of a raw count. Default true: a term used nine times is not nine
   * times as much evidence as a term used once, and on this corpus a repeated identifier in one
   * long entry would otherwise dominate its whole vector.
   */
  readonly sublinearTf?: boolean;
  /** Terms per cluster label. Default 5. */
  readonly topTerms?: number;
  /** Below this many documents the report is flagged `underpowered`. Default `MIN_N`. */
  readonly minDocuments?: number;
}

/** The clustering, with the numbers needed to judge whether it found anything. */
export interface ClusterReport {
  /** Clusters, largest first, then by descending silhouette, then by representative. */
  readonly clusters: readonly Cluster[];
  /** Documents in. */
  readonly documents: number;
  /** Distinct terms with non-zero IDF -- terms in every document weigh nothing and are excluded. */
  readonly vocabulary: number;
  /** Clusters of exactly one document. */
  readonly singletons: number;
  /**
   * Mean silhouette over EVERY document, singletons included at 0. The one number that says
   * whether the clustering is separated at all. Compare it against `permutationNull`.
   */
  readonly silhouette: number;
  /** The cut used, echoed so a report carries the parameter that produced it. */
  readonly threshold: number;
  /** The linkage used, echoed for the same reason. */
  readonly linkage: Linkage;
  /** Fewer documents than `minDocuments`: the clustering is an anecdote, whatever it scores. */
  readonly underpowered: boolean;
}

/** One cut evaluated, for a caller choosing a threshold deliberately. */
export interface ThresholdSweepPoint {
  readonly threshold: number;
  readonly clusters: number;
  readonly singletons: number;
  readonly largest: number;
  readonly silhouette: number;
}

/** What clustering scores when co-occurrence is destroyed and nothing else is. */
export interface ClusterNull {
  /** Mean silhouette from each shuffled corpus, ascending. */
  readonly silhouettes: readonly number[];
  /** Smallest, median and largest of them. */
  readonly min: number;
  readonly median: number;
  readonly max: number;
  /** `(shuffles scoring at least as high + 1) / (iterations + 1)`. */
  pValue(observed: number): number;
}

/** A document's L2-normalised TF-IDF vector, sparse. */
export interface DocumentVector {
  readonly id: string;
  readonly weights: ReadonlyMap<string, number>;
}

/** The vectorised corpus. */
export interface Vectorisation {
  readonly vectors: readonly DocumentVector[];
  /** Terms with non-zero IDF, ascending. */
  readonly vocabulary: readonly string[];
}

/**
 * TF-IDF vectors, L2-normalised so that cosine similarity is a plain dot product.
 *
 * `idf = log(N / df)`. The unsmoothed form is deliberate: it sends a term that appears in every
 * document to exactly zero, which is the stopword removal this module ships instead of a word list.
 * A smoothed `log(N / (df + 1)) + 1` would keep those terms at a small positive weight, and on a
 * corpus where every entry contains the same boilerplate that is the difference between clustering
 * the content and clustering the template.
 */
export function tfidf(
  documents: readonly ClusterDocument[],
  options: { readonly sublinearTf?: boolean } = {},
): Vectorisation {
  const sublinear = options.sublinearTf ?? true;
  const n = documents.length;
  const documentFrequency = new Map<string, number>();

  for (const document of documents) {
    for (const term of new Set(document.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, df] of documentFrequency) {
    const weight = Math.log(n / df);
    // Exactly zero for a term in every document. Kept out of the map entirely rather than stored as
    // 0, so `vocabulary` counts what can actually separate two documents.
    if (weight > 0) idf.set(term, weight);
  }

  const vectors = documents.map((document) => {
    const counts = new Map<string, number>();
    for (const term of document.tokens) counts.set(term, (counts.get(term) ?? 0) + 1);

    const weights = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of counts) {
      const inverse = idf.get(term);
      if (inverse === undefined) continue;
      const tf = sublinear ? 1 + Math.log(count) : count;
      const weight = tf * inverse;
      weights.set(term, weight);
      norm += weight * weight;
    }

    if (norm > 0) {
      const length = Math.sqrt(norm);
      for (const [term, weight] of weights) weights.set(term, weight / length);
    }

    return { id: document.id, weights };
  });

  return { vectors, vocabulary: [...idf.keys()].sort() };
}

/** Cosine similarity between two L2-normalised sparse vectors: the dot product. */
export function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) dot += weight * other;
  }
  // Rounding can push a dot product of two unit vectors a hair past 1; a similarity above 1 would
  // give a negative distance and a silhouette outside its own range.
  return dot > 1 ? 1 : dot < -1 ? -1 : dot;
}

/** One merge in the dendrogram: two clusters, and the distance at which they joined. */
interface Merge {
  readonly left: number;
  readonly right: number;
  readonly height: number;
  readonly size: number;
}

/**
 * The nearest-neighbour-chain algorithm (Murtagh), which builds the same dendrogram as the naive
 * repeated-minimum search in O(n^2) instead of O(n^3).
 *
 * It works by walking a chain of nearest neighbours until it finds a RECIPROCAL pair -- two
 * clusters that are each other's nearest -- and merging that pair. A reciprocal pair is merged by
 * the naive algorithm eventually and at the same height, which is why the two agree; the chain just
 * reaches it without rescanning every pair first. This holds only for reducible linkages, which
 * average, complete and single all are: merging two clusters never brings the result closer to a
 * third than both originals were.
 *
 * TIES ARE BROKEN BY INDEX, everywhere. Without that the chain can pick either of two equidistant
 * neighbours and two runs over one store return different clusters -- and the store's contract is
 * that they do not.
 */
function agglomerate(distance: number[][], linkage: Linkage): Merge[] {
  const n = distance.length;
  if (n === 0) return [];

  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const merges: Merge[] = [];
  const chain: number[] = [];
  let remaining = n;

  const distanceAt = (a: number, b: number): number => (distance[a] as number[])[b] as number;

  const nearestTo = (a: number): number => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let b = 0; b < n; b += 1) {
      if (b === a || !active[b]) continue;
      const d = distanceAt(a, b);
      if (d < bestDistance || (d === bestDistance && b < best)) {
        bestDistance = d;
        best = b;
      }
    }
    return best;
  };

  while (remaining > 1) {
    if (chain.length === 0) {
      let first = -1;
      for (let i = 0; i < n; i += 1)
        if (active[i]) {
          first = i;
          break;
        }
      chain.push(first);
    }

    const a = chain[chain.length - 1] as number;
    const b = nearestTo(a);

    if (chain.length >= 2 && (chain[chain.length - 2] as number) === b) {
      // Reciprocal pair. Merge the LOWER index into the higher-numbered slot's place -- the choice
      // is arbitrary but has to be fixed, or the tie-breaks above stop being reproducible.
      chain.pop();
      chain.pop();
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const height = distanceAt(left, right);
      const merged = size[left] as number;
      const other = size[right] as number;

      for (let m = 0; m < n; m += 1) {
        if (m === left || m === right || !active[m]) continue;
        const dLeft = distanceAt(left, m);
        const dRight = distanceAt(right, m);
        const updated =
          linkage === 'single'
            ? Math.min(dLeft, dRight)
            : linkage === 'complete'
              ? Math.max(dLeft, dRight)
              : (merged * dLeft + other * dRight) / (merged + other);
        (distance[left] as number[])[m] = updated;
        (distance[m] as number[])[left] = updated;
      }

      size[left] = merged + other;
      active[right] = false;
      remaining -= 1;
      merges.push({ left, right, height, size: merged + other });
    } else {
      chain.push(b);
    }
  }

  // Monotonic linkages produce no inversions, so sorting by height turns the merge list into the
  // dendrogram's own order. Ties by the merged indices, again for reproducibility.
  return merges.sort((x, y) => x.height - y.height || x.left - y.left || x.right - y.right);
}

/** Union-find over document indices, used to apply a cut to the merge list. */
function componentsBelow(merges: readonly Merge[], n: number, threshold: number): number[] {
  const parent = Array.from({ length: n }, (_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while ((parent[root] as number) !== root) root = parent[root] as number;
    let walk = index;
    while ((parent[walk] as number) !== walk) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (const merge of merges) {
    if (merge.height > threshold) break;
    const rootLeft = find(merge.left);
    const rootRight = find(merge.right);
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
  }
  return Array.from({ length: n }, (_, index) => find(index));
}

function assertOptions(threshold: number, topTerms: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 2)
    throw new ClusterError(
      `cluster: threshold must be a cosine distance in [0,2] (got ${String(threshold)})`,
    );
  if (!Number.isInteger(topTerms) || topTerms < 1)
    throw new ClusterError(
      `cluster: topTerms must be a positive integer (got ${String(topTerms)})`,
    );
}

function assertIds(documents: readonly ClusterDocument[]): void {
  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.id)) throw new ClusterError(`cluster: duplicate id '${document.id}'`);
    seen.add(document.id);
  }
}

/** The full cosine-distance matrix. Its own function because every entry point needs it. */
function distanceMatrix(vectors: readonly DocumentVector[]): number[][] {
  const n = vectors.length;
  const matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d =
        1 - cosine((vectors[i] as DocumentVector).weights, (vectors[j] as DocumentVector).weights);
      (matrix[i] as number[])[j] = d;
      (matrix[j] as number[])[i] = d;
    }
  }
  return matrix;
}

/**
 * Mean silhouette per document against a labelling.
 *
 * s(i) = (b - a) / max(a, b), where a is the mean distance to the rest of i's own cluster and b is
 * the smallest mean distance to any other cluster. A document alone in its cluster has no `a` at
 * all, and scores 0 by the usual convention rather than 1 -- a singleton is an absence of evidence
 * about separation, and scoring it as perfect separation would let a clustering that split every
 * document into its own cluster report the best silhouette available.
 */
function silhouettes(matrix: readonly number[][], labels: readonly number[]): number[] {
  const n = labels.length;
  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const bucket = byLabel.get(labels[i] as number);
    if (bucket === undefined) byLabel.set(labels[i] as number, [i]);
    else bucket.push(i);
  }

  return Array.from({ length: n }, (_, i) => {
    const own = byLabel.get(labels[i] as number) as number[];
    if (own.length === 1) return 0;

    let inside = 0;
    for (const j of own) if (j !== i) inside += (matrix[i] as number[])[j] as number;
    const a = inside / (own.length - 1);

    let b = Number.POSITIVE_INFINITY;
    for (const [label, members] of byLabel) {
      if (label === (labels[i] as number)) continue;
      let total = 0;
      for (const j of members) total += (matrix[i] as number[])[j] as number;
      const mean = total / members.length;
      if (mean < b) b = mean;
    }
    if (!Number.isFinite(b)) return 0;

    const largest = Math.max(a, b);
    return largest === 0 ? 0 : (b - a) / largest;
  });
}

/** Cluster a corpus by TF-IDF cosine distance, cut at `threshold`. */
export function cluster(
  documents: readonly ClusterDocument[],
  options: ClusterOptions = {},
): ClusterReport {
  const threshold = options.threshold ?? 0.8;
  const linkage = options.linkage ?? 'average';
  const topTerms = options.topTerms ?? 5;
  const minDocuments = options.minDocuments ?? MIN_N;
  assertOptions(threshold, topTerms);
  assertIds(documents);

  const ordered = [...documents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { vectors, vocabulary } = tfidf(
    ordered,
    options.sublinearTf === undefined ? {} : { sublinearTf: options.sublinearTf },
  );

  if (ordered.length === 0)
    return {
      clusters: [],
      documents: 0,
      vocabulary: 0,
      singletons: 0,
      silhouette: 0,
      threshold,
      linkage,
      underpowered: true,
    };

  const matrix = distanceMatrix(vectors);
  const merges = agglomerate(
    matrix.map((row) => [...row]),
    linkage,
  );
  const labels = componentsBelow(merges, ordered.length, threshold);
  const scores = silhouettes(matrix, labels);

  const byLabel = new Map<number, number[]>();
  for (let i = 0; i < ordered.length; i += 1) {
    const bucket = byLabel.get(labels[i] as number);
    if (bucket === undefined) byLabel.set(labels[i] as number, [i]);
    else bucket.push(i);
  }

  const clusters: Cluster[] = [];
  for (const indices of byLabel.values()) {
    const centroid = new Map<string, number>();
    for (const i of indices)
      for (const [term, weight] of (vectors[i] as DocumentVector).weights)
        centroid.set(term, (centroid.get(term) ?? 0) + weight);
    for (const [term, weight] of centroid) centroid.set(term, weight / indices.length);

    // The representative is the member closest to the centroid -- a real document, so a reader is
    // shown something that was actually written rather than an average of several things.
    let representative = indices[0] as number;
    let best = -Infinity;
    for (const i of indices) {
      const score = cosine((vectors[i] as DocumentVector).weights, centroid);
      const id = (ordered[i] as ClusterDocument).id;
      if (
        score > best ||
        (score === best && id < (ordered[representative] as ClusterDocument).id)
      ) {
        best = score;
        representative = i;
      }
    }

    let pairs = 0;
    let similarity = 0;
    for (let x = 0; x < indices.length; x += 1)
      for (let y = x + 1; y < indices.length; y += 1) {
        similarity +=
          1 - ((matrix[indices[x] as number] as number[])[indices[y] as number] as number);
        pairs += 1;
      }

    const terms = [...centroid.entries()]
      .filter(([, weight]) => weight > 0)
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, topTerms)
      .map(([term, weight]) => ({ term, weight }));

    clusters.push({
      representative: (ordered[representative] as ClusterDocument).id,
      members: indices.map((i) => (ordered[i] as ClusterDocument).id).sort(),
      size: indices.length,
      terms,
      cohesion: pairs === 0 ? 1 : similarity / pairs,
      silhouette: indices.reduce((total, i) => total + (scores[i] as number), 0) / indices.length,
    });
  }

  clusters.sort(
    (a, b) =>
      b.size - a.size ||
      b.silhouette - a.silhouette ||
      (a.representative < b.representative ? -1 : 1),
  );

  return {
    clusters,
    documents: ordered.length,
    vocabulary: vocabulary.length,
    singletons: clusters.filter((entry) => entry.size === 1).length,
    silhouette: scores.reduce((total, score) => total + score, 0) / ordered.length,
    threshold,
    linkage,
    underpowered: ordered.length < minDocuments,
  };
}

/**
 * Evaluate a range of cuts on ONE dendrogram.
 *
 * The clustering is built once and cut repeatedly, which is both far cheaper than re-clustering and
 * more honest: every point in the sweep is a cut of the same hierarchy, so the differences between
 * them are the threshold and nothing else.
 */
export function sweepThreshold(
  documents: readonly ClusterDocument[],
  thresholds: readonly number[],
  options: ClusterOptions = {},
): ThresholdSweepPoint[] {
  if (thresholds.length === 0)
    throw new ClusterError('sweepThreshold: at least one threshold is required');
  const linkage = options.linkage ?? 'average';
  assertIds(documents);
  if (documents.length === 0)
    return thresholds.map((threshold) => ({
      threshold,
      clusters: 0,
      singletons: 0,
      largest: 0,
      silhouette: 0,
    }));

  const ordered = [...documents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { vectors } = tfidf(
    ordered,
    options.sublinearTf === undefined ? {} : { sublinearTf: options.sublinearTf },
  );
  const matrix = distanceMatrix(vectors);
  const merges = agglomerate(
    matrix.map((row) => [...row]),
    linkage,
  );

  return thresholds.map((threshold) => {
    assertOptions(threshold, 1);
    const labels = componentsBelow(merges, ordered.length, threshold);
    const scores = silhouettes(matrix, labels);
    const counts = new Map<number, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return {
      threshold,
      clusters: counts.size,
      singletons: [...counts.values()].filter((count) => count === 1).length,
      largest: Math.max(...counts.values()),
      silhouette: scores.reduce((total, score) => total + score, 0) / ordered.length,
    };
  });
}

/**
 * What the same clustering scores when co-occurrence is destroyed and nothing else is.
 *
 * The shuffle pools every token in the corpus, permutes the pool, and deals it back out so each
 * document keeps its own LENGTH. The vocabulary survives exactly, every term's total frequency
 * survives exactly, and every document's size survives exactly. The only thing that does not is
 * which terms appear together -- which is the entire claim a clustering makes. A mean silhouette
 * that the shuffled corpora reach routinely is a mean silhouette that says nothing about this
 * corpus, however plausible the cluster labels look.
 */
export function permutationNull(
  documents: readonly ClusterDocument[],
  options: ClusterOptions & { readonly iterations?: number; readonly seed?: string } = {},
): ClusterNull {
  const iterations = options.iterations ?? 199;
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new ClusterError(
      `permutationNull: iterations must be a positive integer (got ${String(iterations)})`,
    );

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const pool: string[] = [];
  for (const document of documents) pool.push(...document.tokens);

  const silhouetteValues: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Fisher-Yates over a copy, so each iteration shuffles the original pool rather than the
    // previous iteration's arrangement -- otherwise the draws are a random walk, not independent.
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const swap = shuffled[i] as string;
      shuffled[i] = shuffled[j] as string;
      shuffled[j] = swap;
    }

    let cursor = 0;
    const dealt = documents.map((document) => {
      const tokens = shuffled.slice(cursor, cursor + document.tokens.length);
      cursor += document.tokens.length;
      return { id: document.id, tokens };
    });

    silhouetteValues.push(cluster(dealt, options).silhouette);
  }

  const sorted = [...silhouetteValues].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    silhouettes: sorted,
    min: sorted[0] as number,
    median:
      sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
    max: sorted[sorted.length - 1] as number,
    // The +1s are Davison and Hinkley's correction, the same one `association.ts` uses: the
    // observed value is itself one arrangement of the data, so a p of exactly 0 is not available
    // from a finite number of shuffles and claiming one would overstate what was run.
    pValue: (observed: number): number =>
      (sorted.filter((value) => value >= observed).length + 1) / (sorted.length + 1),
  };
}
