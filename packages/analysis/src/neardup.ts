/**
 * Near-duplicate collapse -- one representative and a count, instead of forty rows that say the
 * same thing.
 *
 * WHY A CORPUS NEEDS THIS AT ALL. `sample.ts` opens with the measurement: one ingest run derives a
 * burst of entries from one transcript and stamps them all with the same instant, and the first
 * forty entries of a type are near-identical to one another. Sampling spends the reader's budget
 * deliberately; this spends it once per DISTINCT thing said. A profile showing "38 near-identical
 * denials of the same command" is a different fact from thirty-eight rows, and only one of the two
 * fits on a screen.
 *
 * THE CENTRAL DECISION: LSH FINDS CANDIDATES, EXACT JACCARD DECIDES.
 *
 * MinHash with banding is a probabilistic index -- it is fast because it can be wrong, and the
 * usual design accepts both false candidates and missed pairs in exchange for not comparing
 * everything to everything. Here the signature is used ONLY to propose pairs, and every proposed
 * pair is then scored by exact Jaccard over the real shingle sets before anything is merged. The
 * consequence is worth stating plainly, because it is what makes the false-merge measurement this
 * bead asks for meaningful:
 *
 *   **No pair is ever merged because two signatures collided.** Every reported similarity is the
 *   true one. So the only remaining source of a false merge is THE THRESHOLD ITSELF -- a genuine
 *   judgement about how similar is "the same" -- plus chaining, below. That is a defect the caller
 *   can reason about; a signature collision is not.
 *
 * The cost is that recall is still probabilistic: a truly similar pair whose bands never collide is
 * never proposed and never merged. That asymmetry is the right one. A missed merge leaves two rows
 * where one would do, which a reader notices; a false merge silently destroys a distinction, which
 * a reader cannot notice because the evidence is gone.
 *
 * CHAINING IS THE OTHER FALSE-MERGE SOURCE, AND IT IS REPORTED RATHER THAN PREVENTED. Near-duplicate
 * is not transitive: A and B at 0.85, B and C at 0.85, and A and C can sit at 0.55. Single-linkage
 * union-find puts all three in one group -- which is what "collapse" usually means and what a caller
 * usually wants, because the alternative (demanding every pair in a group clear the threshold) makes
 * a group of forty nearly impossible to form. So single linkage stays, and every group carries
 * `minSimilarity`, THE WORST EXACT PAIRWISE SIMILARITY INSIDE IT. A group whose `minSimilarity`
 * sits far below the threshold is a chained group, visibly. That field is the instrument the
 * false-merge rate is measured with, and it exists because the alternative -- asserting that
 * chaining is rare -- would be a claim with no number behind it.
 *
 * EMPTY DOCUMENTS ARE NEVER MERGED, WHICH IS A JUDGEMENT AND NOT AN OVERSIGHT. The Jaccard of two
 * empty sets is 1 by the usual convention, and `jaccard` returns 1 for them because that is what the
 * set function means. The collapse refuses to act on it: a document with no shingles is held out of
 * the index entirely and comes back a singleton, and `emptyDocuments` says how many there were. The
 * convention is an arbitrary tie-break over an empty intersection, not evidence -- and this corpus
 * makes the difference expensive, because most entries carry no `evidence_text` by design
 * (`derive.ts:92-95`). Taking the convention at face value would collapse the majority of a store
 * into one enormous group that says nothing, and report it as the largest finding in the data. A
 * caller who wants empty documents grouped can group them; a caller who does not would never have
 * seen it coming.
 *
 * SHINGLES, NOT TOKENS, and the caller chooses which. `shingle` builds overlapping k-grams from a
 * token array; a k of 1 degrades to a bag of words, which is right for very short texts and wrong
 * for anything longer, because word order is most of what distinguishes two similar sentences. This
 * module does not tokenize -- `analysis` is pure statistics over plain arrays, and what counts as a
 * word in an evidence string belongs to whoever owns the text.
 *
 * DETERMINISM. The permutations are derived from a seed, the representative is chosen by a total
 * order, groups come back in a fixed order and members within a group are sorted by id. Two runs
 * over one store agree, which is this store's contract.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`).
 */

import { DEFAULT_SEED, mulberry32, seedOf } from './random.js';

/** A caller handed this module something it will not compare. */
export class NearDuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearDuplicateError';
  }
}

/** One document, already tokenised by the caller. */
export interface DuplicateCandidate {
  /** Stable identity. Ties in every ordering here are broken by it. */
  readonly id: string;
  /** The document's tokens, in order. Order matters once `shingleSize` exceeds 1. */
  readonly tokens: readonly string[];
}

/** A set of documents judged to be saying the same thing. */
export interface NearDuplicateGroup {
  /** The id standing for the group. */
  readonly representative: string;
  /** Every member, including the representative, by id, ascending. */
  readonly members: readonly string[];
  /** How many documents the group collapses. */
  readonly count: number;
  /**
   * The LOWEST exact Jaccard similarity between any two members.
   *
   * At or above the threshold, every pair in the group is genuinely similar. Below it, the group
   * was formed by chaining and this number says how far the chain stretched. This is the field the
   * false-merge rate is measured on.
   */
  readonly minSimilarity: number;
  /** The highest exact Jaccard similarity between any two members. */
  readonly maxSimilarity: number;
}

/** How the collapse is asked for. */
export interface NearDuplicateOptions {
  /**
   * Exact Jaccard at or above which two documents are the same thing. Default 0.9.
   *
   * 0.9 rather than the 0.8 this shipped with first, on the measurement in `docs/evidence/EV-20.md`:
   * on the one arm of that record that produced merges to adjudicate, 0.8 measured a false-merge
   * rate of 0.000930 (28 wrong pairs of 30,112) and 0.9 measured 0.000000. The raise was free --
   * the same corpus's prose surface merges nothing at all between 0.5 and 0.9, so no real outcome
   * moved -- and a false merge is the failure that leaves no evidence behind that it happened.
   */
  readonly threshold?: number;
  /** Tokens per shingle. Default 3. */
  readonly shingleSize?: number;
  /** MinHash permutations. More permutations buy recall, not correctness. Default 128. */
  readonly permutations?: number;
  /** Bands for the LSH index. Must divide `permutations`. Default 32. */
  readonly bands?: number;
  /** Seed for the permutations. Default `DEFAULT_SEED`. */
  readonly seed?: string;
}

/** The collapse, with the numbers needed to judge the threshold that produced it. */
export interface NearDuplicateReport {
  /** Groups of two or more, largest first. */
  readonly groups: readonly NearDuplicateGroup[];
  /** Documents that joined no group, by id, ascending. */
  readonly singletons: readonly string[];
  /** Documents in. */
  readonly documents: number;
  /** Rows a reader would see after collapsing: `groups.length + singletons.length`. */
  readonly collapsed: number;
  /** Pairs the LSH index proposed. */
  readonly candidatePairs: number;
  /** Proposed pairs whose exact similarity cleared the threshold. */
  readonly mergedPairs: number;
  /** The threshold used, echoed so a report carries the parameter that produced it. */
  readonly threshold: number;
  /**
   * Groups whose `minSimilarity` falls below the threshold -- formed by chaining, not by every
   * member resembling every other.
   */
  readonly chainedGroups: number;
  /**
   * Documents with no shingles at all, held out of the comparison and returned as singletons. See
   * the header: this is the count that makes that decision visible rather than silent.
   */
  readonly emptyDocuments: number;
}

/** Overlapping k-grams of `tokens`, joined by a separator no token can contain. */
export function shingle(tokens: readonly string[], size = 3): string[] {
  if (!Number.isInteger(size) || size < 1)
    throw new NearDuplicateError(`shingle: size must be a positive integer (got ${String(size)})`);
  if (tokens.length === 0) return [];
  // A document shorter than one shingle becomes a single shingle of everything it has, rather than
  // nothing at all. Returning nothing would make every short document identical to every other,
  // which is the opposite of what an empty intersection should mean.
  if (tokens.length <= size) return [tokens.join('\u0000')];

  const out: string[] = [];
  for (let i = 0; i + size <= tokens.length; i += 1)
    out.push(tokens.slice(i, i + size).join('\u0000'));
  return out;
}

/** Exact Jaccard similarity: shared shingles over total distinct shingles. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** A 32-bit hash of a shingle. FNV-1a, the same one `seedOf` uses, for the same reason. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A MinHash signature: for each permutation, the smallest permuted hash in the set.
 *
 * The permutations are the usual `(a * h + b) mod 2^32` family, with `a` and `b` drawn from the
 * seeded generator, so a signature is reproducible from its parameters. `a` is forced odd, because
 * an even multiplier is not a permutation modulo a power of two -- it collapses the space and would
 * quietly make some permutations far weaker than others.
 */
export function minHashSignature(
  shingles: ReadonlySet<string>,
  options: { readonly permutations?: number; readonly seed?: string } = {},
): number[] {
  const permutations = options.permutations ?? 128;
  if (!Number.isInteger(permutations) || permutations < 1)
    throw new NearDuplicateError(
      `minHashSignature: permutations must be a positive integer (got ${String(permutations)})`,
    );

  const next = mulberry32(seedOf(options.seed ?? DEFAULT_SEED));
  const signature = new Array<number>(permutations).fill(0xffffffff);
  const hashes = [...shingles].map(hashOf);

  for (let p = 0; p < permutations; p += 1) {
    const a = (Math.floor(next() * 0xffffffff) | 1) >>> 0;
    const b = Math.floor(next() * 0xffffffff) >>> 0;
    let smallest = 0xffffffff;
    for (const hash of hashes) {
      const permuted = (Math.imul(hash, a) + b) >>> 0;
      if (permuted < smallest) smallest = permuted;
    }
    signature[p] = smallest;
  }

  return signature;
}

/** Union-find over document indices -- single linkage, which is what collapsing means. */
class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while ((this.parent[root] as number) !== root) root = this.parent[root] as number;
    // Path compression, so a long chain does not cost the same twice.
    let walk = index;
    while ((this.parent[walk] as number) !== walk) {
      const next = this.parent[walk] as number;
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

/**
 * Collapse near-duplicates into groups, each with a representative and the count it stands for.
 *
 * THE REPRESENTATIVE IS THE LONGEST DOCUMENT, ties broken by id. Longest because it retains the
 * most of what the group said, and a representative that is a truncation of its members is a
 * representative that loses the very information the group was collapsed to preserve. Ties by id so
 * the choice is total and two runs agree.
 */
export function collapseNearDuplicates(
  documents: readonly DuplicateCandidate[],
  options: NearDuplicateOptions = {},
): NearDuplicateReport {
  const threshold = options.threshold ?? 0.9;
  const shingleSize = options.shingleSize ?? 3;
  const permutations = options.permutations ?? 128;
  const bands = options.bands ?? 32;

  if (threshold < 0 || threshold > 1)
    throw new NearDuplicateError('collapseNearDuplicates: threshold must be a similarity in [0,1]');
  if (!Number.isInteger(bands) || bands < 1 || permutations % bands !== 0)
    throw new NearDuplicateError(
      `collapseNearDuplicates: bands (${String(bands)}) must be a positive divisor of permutations (${String(permutations)})`,
    );

  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.id))
      throw new NearDuplicateError(`collapseNearDuplicates: duplicate id '${document.id}'`);
    seen.add(document.id);
  }

  const ordered = [...documents].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sets = ordered.map((document) => new Set(shingle(document.tokens, shingleSize)));
  const signatures = ordered.map((_, index) =>
    minHashSignature(sets[index] as Set<string>, {
      permutations,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    }),
  );

  // BANDING. Two documents become candidates when any one band of their signatures matches exactly.
  // Fewer, wider bands demand more agreement and propose fewer pairs; more, narrower bands propose
  // more. Neither setting can cause a false merge, because every candidate is scored exactly below
  // -- they trade recall against work, and nothing else.
  const rowsPerBand = permutations / bands;
  const candidates = new Set<string>();
  for (let band = 0; band < bands; band += 1) {
    const buckets = new Map<string, number[]>();
    for (let index = 0; index < ordered.length; index += 1) {
      // Held out here, once, rather than filtered out of every downstream step.
      if ((sets[index] as Set<string>).size === 0) continue;
      const signature = signatures[index] as number[];
      const key = signature.slice(band * rowsPerBand, (band + 1) * rowsPerBand).join(',');
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [index]);
      else bucket.push(index);
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1)
        for (let j = i + 1; j < bucket.length; j += 1)
          candidates.add(`${String(bucket[i])},${String(bucket[j])}`);
    }
  }

  const union = new DisjointSet(ordered.length);
  const similarities = new Map<string, number>();
  let mergedPairs = 0;

  for (const pair of candidates) {
    const [left, right] = pair.split(',').map(Number) as [number, number];
    const similarity = jaccard(sets[left] as Set<string>, sets[right] as Set<string>);
    similarities.set(pair, similarity);
    if (similarity >= threshold) {
      union.union(left, right);
      mergedPairs += 1;
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let index = 0; index < ordered.length; index += 1) {
    const root = union.find(index);
    const bucket = byRoot.get(root);
    if (bucket === undefined) byRoot.set(root, [index]);
    else bucket.push(index);
  }

  const groups: NearDuplicateGroup[] = [];
  const singletons: string[] = [];

  for (const indices of byRoot.values()) {
    if (indices.length === 1) {
      singletons.push((ordered[indices[0] as number] as DuplicateCandidate).id);
      continue;
    }

    // EVERY pair inside the group is scored, including pairs the index never proposed. That is the
    // point: a chained group's weakest link is exactly the pair LSH did not propose, so computing
    // only the proposed pairs would report a `minSimilarity` that hides the chaining it exists to
    // expose. The cost is quadratic in group size, which is affordable because groups are small --
    // and if they are not, the threshold is wrong and the report should say so loudly.
    let lowest = 1;
    let highest = 0;
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const similarity = jaccard(
          sets[indices[i] as number] as Set<string>,
          sets[indices[j] as number] as Set<string>,
        );
        if (similarity < lowest) lowest = similarity;
        if (similarity > highest) highest = similarity;
      }
    }

    const members = indices.map((index) => ordered[index] as DuplicateCandidate);
    const representative = members.reduce((best, candidate) =>
      candidate.tokens.length > best.tokens.length ||
      (candidate.tokens.length === best.tokens.length && candidate.id < best.id)
        ? candidate
        : best,
    );

    groups.push({
      representative: representative.id,
      members: members.map((member) => member.id).sort(),
      count: members.length,
      minSimilarity: lowest,
      maxSimilarity: highest,
    });
  }

  groups.sort(
    (a, b) =>
      b.count - a.count ||
      b.minSimilarity - a.minSimilarity ||
      (a.representative < b.representative ? -1 : 1),
  );
  singletons.sort();

  return {
    groups,
    singletons,
    documents: ordered.length,
    collapsed: groups.length + singletons.length,
    candidatePairs: candidates.size,
    mergedPairs,
    threshold,
    chainedGroups: groups.filter((group) => group.minSimilarity < threshold).length,
    emptyDocuments: sets.filter((set) => set.size === 0).length,
  };
}
