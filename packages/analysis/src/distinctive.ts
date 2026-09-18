/**
 * Distinctive terms -- what a group says that the rest of the corpus does not.
 *
 * WHAT THIS IS FOR, in the bead's own words (`asc-iyd`): it "hands the LLM a hypothesis instead of
 * asking it to find one". A reader given six hundred `tool_denial` entries and asked what is
 * different about the ones from July will invent an answer. A reader given the twelve terms whose
 * odds shifted most, each with the counts and the uncertainty behind it, is being asked to check
 * something instead.
 *
 * THE METHOD IS MONROE, COLARESI AND QUINN (2008), "Fightin' Words" -- the log-odds ratio with an
 * INFORMATIVE Dirichlet prior, reported as a z-score. Three parts, and each one is load-bearing:
 *
 *   1. **Log-odds, not raw frequency.** A term's share of a group says nothing on its own; what
 *      matters is its odds inside the group against its odds outside. `the` is everywhere and its
 *      log-odds ratio is near zero, which is why THIS METHOD NEEDS NO STOPWORD LIST. That is worth
 *      stating as a property rather than as a convenience: a stopword list is a corpus-specific
 *      judgement someone has to maintain and get wrong, and the estimator makes it unnecessary
 *      rather than optional.
 *
 *   2. **The prior is INFORMATIVE -- drawn from the background corpus, not flat.** Add-one
 *      smoothing gives a term seen once in the whole corpus the same prior weight as a term seen
 *      ten thousand times, which is the assumption that makes rare terms explode. Here each term's
 *      pseudo-count is proportional to its BACKGROUND frequency, so smoothing pulls each term
 *      toward what the corpus as a whole does with it.
 *
 *   3. **The z-score, not the ratio.** This is the part that answers the bead's parenthetical --
 *      "better than raw TF-IDF at small N". TF-IDF has no variance model at all, so a term
 *      appearing twice in a forty-token group scores like a term appearing two hundred times in a
 *      four-thousand-token group. Dividing the log-odds by its standard error is exactly the
 *      correction that difference calls for, and at small N it is the difference between a ranking
 *      and a list of accidents.
 *
 * THE VOCABULARY IS A FAMILY, AND IT IS A LARGE ONE. Every (term, group) pair is a hypothesis test,
 * so a corpus with a 3,000-word vocabulary and four groups runs twelve thousand of them; at
 * |z| > 1.96 that yields around six hundred "distinctive" terms from noise alone. Every term
 * therefore carries a Benjamini-Hochberg q-value over the whole family, computed by the same
 * `benjaminiHochberg` the association ranking uses. `family` is reported for the same reason it is
 * there: the correction depends on what was asked, and a reader should be able to see what that was.
 *
 * THE TWO-SIDED P COMES FROM THE CHI-SQUARE TAIL, WHICH IS NOT A SHORTCUT. P(|Z| > z) equals
 * P(X^2 > z^2) at one degree of freedom -- the same identity that makes `chi2 = 3.841458820694124`
 * and `z = 1.959963984540054` the same 5% point. So this module reuses `chiSquarePValue`, already
 * validated against published table values, rather than introducing a second normal-tail
 * approximation that would need its own anchors and could disagree with the first.
 *
 * WHAT IS DELIBERATELY NOT HERE. No tokenizer: the caller supplies tokens, because `analysis` is
 * pure statistics over plain arrays and what counts as a word in an evidence string is a decision
 * for whoever owns the text. No stemming, for the same reason plus a sharper one -- stemming merges
 * terms, and a merge that is wrong is invisible in the output.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin (enforced by `align check` and
 * `purity-enforcement.test.ts`). Nothing here draws a random number, so there is no seed.
 */

import { benjaminiHochberg, chiSquarePValue } from './association.js';
import { MIN_N } from './proportion.js';

/** A caller handed this module something it will not compute on. */
export class DistinctiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DistinctiveError';
  }
}

/** One group of documents, already tokenised by the caller. */
export interface DistinctiveGroup {
  /** What the group is called in the output. */
  readonly name: string;
  /** One token array per document. Order is irrelevant; repetition is not. */
  readonly documents: readonly (readonly string[])[];
}

/** One term, measured against everything outside its group. */
export interface DistinctiveTerm {
  /** The token. */
  readonly term: string;
  /** Occurrences inside the group. */
  readonly countInGroup: number;
  /** Occurrences everywhere else in the corpus. */
  readonly countElsewhere: number;
  /** Documents in the group containing it at least once -- the guard against one loud document. */
  readonly documentsInGroup: number;
  /** Log-odds ratio, group against the rest, regularised by the informative prior. */
  readonly logOddsRatio: number;
  /** The log-odds ratio divided by its standard error. The ranking key. */
  readonly z: number;
  /** Two-sided p for that z, via the identity P(|Z| > z) = P(X^2 > z^2) at df = 1. */
  readonly p: number;
  /** Benjamini-Hochberg q-value across every (term, group) pair in the request. */
  readonly pAdjusted: number;
}

/** One group's terms, with the reasons to doubt them. */
export interface DistinctiveGroupReport {
  /** The group's name. */
  readonly group: string;
  /** Documents in the group. */
  readonly documents: number;
  /** Tokens in the group, with repetition. */
  readonly tokens: number;
  /** Terms that most distinguish this group, most distinctive first. */
  readonly terms: readonly DistinctiveTerm[];
  /** True when the group holds fewer than `minDocuments` documents: an anecdote, not an estimate. */
  readonly underpowered: boolean;
}

/** How `distinctiveTerms` is asked for its ranking. */
export interface DistinctiveOptions {
  /**
   * Total prior weight, Monroe's alpha-zero. Defaults to the vocabulary size -- one pseudo-token
   * per distinct term on average, distributed across terms by their background frequency.
   */
  readonly prior?: number;
  /** Terms occurring fewer times than this across the whole corpus are ignored. Default 2. */
  readonly minCount?: number;
  /** Terms returned per group. Default 12. */
  readonly perGroup?: number;
  /** Groups with fewer documents than this are flagged `underpowered`. Default `MIN_N`. */
  readonly minDocuments?: number;
}

/** The ranking, with the family the q-values were corrected against. */
export interface DistinctiveReport {
  /** One entry per input group, in input order. */
  readonly groups: readonly DistinctiveGroupReport[];
  /** Distinct terms that cleared `minCount`. */
  readonly vocabulary: number;
  /** (term, group) pairs tested -- the denominator the FDR correction used. */
  readonly family: number;
  /** Tokens across the whole corpus, with repetition. */
  readonly tokens: number;
}

/** Counts of every term in a token stream, and the number of documents each appears in. */
function tally(documents: readonly (readonly string[])[]): {
  counts: Map<string, number>;
  documentCounts: Map<string, number>;
  tokens: number;
} {
  const counts = new Map<string, number>();
  const documentCounts = new Map<string, number>();
  let tokens = 0;

  for (const document of documents) {
    const seen = new Set<string>();
    for (const term of document) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      seen.add(term);
      tokens += 1;
    }
    for (const term of seen) documentCounts.set(term, (documentCounts.get(term) ?? 0) + 1);
  }

  return { counts, documentCounts, tokens };
}

/**
 * The terms that most distinguish each group from everything outside it.
 *
 * EACH GROUP IS COMPARED AGAINST THE REST OF THE CORPUS, not against one other group. That is the
 * comparison the bead asks for ("per group"), and it is also the one that stays meaningful as
 * groups are added: a pairwise design would need the caller to choose which pair, and the choice
 * would silently decide the answer.
 */
export function distinctiveTerms(
  groups: readonly DistinctiveGroup[],
  options: DistinctiveOptions = {},
): DistinctiveReport {
  if (groups.length < 2)
    throw new DistinctiveError(
      `distinctiveTerms: needs at least two groups to compare (got ${String(groups.length)})`,
    );

  const names = new Set<string>();
  for (const group of groups) {
    if (names.has(group.name))
      throw new DistinctiveError(`distinctiveTerms: duplicate group name '${group.name}'`);
    names.add(group.name);
  }

  const minCount = options.minCount ?? 2;
  const perGroup = options.perGroup ?? 12;
  const minDocuments = options.minDocuments ?? MIN_N;
  if (minCount < 1) throw new DistinctiveError(`distinctiveTerms: minCount must be at least 1`);
  if (perGroup < 1) throw new DistinctiveError(`distinctiveTerms: perGroup must be at least 1`);

  const perGroupTally = groups.map((group) => tally(group.documents));

  // The background: every group pooled. This is what the prior is drawn from and what each group is
  // compared against, so it is computed once rather than per group.
  const background = new Map<string, number>();
  let corpusTokens = 0;
  for (const group of perGroupTally) {
    corpusTokens += group.tokens;
    for (const [term, count] of group.counts)
      background.set(term, (background.get(term) ?? 0) + count);
  }

  const vocabulary = [...background.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([term]) => term)
    .sort();

  if (vocabulary.length === 0 || corpusTokens === 0)
    return {
      groups: groups.map((group, index) => ({
        group: group.name,
        documents: group.documents.length,
        tokens: perGroupTally[index]?.tokens ?? 0,
        terms: [],
        underpowered: group.documents.length < minDocuments,
      })),
      vocabulary: 0,
      family: 0,
      tokens: corpusTokens,
    };

  // Monroe's alpha-zero. The default is the vocabulary size, which spends one pseudo-token per
  // distinct term on average -- Laplace smoothing's total weight, but distributed by background
  // frequency instead of uniformly. Scale-free, so it does not need retuning per corpus. A larger
  // prior shrinks every log-odds toward zero and shrinks the rarest terms most, which is the knob a
  // caller reaches for when the tail is noisy.
  const priorTotal = options.prior ?? vocabulary.length;
  if (priorTotal <= 0) throw new DistinctiveError(`distinctiveTerms: prior must be positive`);

  type Scored = Omit<DistinctiveTerm, 'pAdjusted'> & { readonly groupIndex: number };
  const scored: Scored[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = perGroupTally[index] as {
      counts: Map<string, number>;
      documentCounts: Map<string, number>;
      tokens: number;
    };
    const insideTokens = group.tokens;
    const outsideTokens = corpusTokens - insideTokens;

    for (const term of vocabulary) {
      const corpusCount = background.get(term) as number;
      const inside = group.counts.get(term) ?? 0;
      const outside = corpusCount - inside;

      // alpha_w: the term's share of the prior, taken from its background frequency.
      const alpha = (priorTotal * corpusCount) / corpusTokens;

      const insideNumerator = inside + alpha;
      const outsideNumerator = outside + alpha;
      const insideDenominator = insideTokens + priorTotal - insideNumerator;
      const outsideDenominator = outsideTokens + priorTotal - outsideNumerator;

      // A group holding every occurrence of every term drives a denominator to zero. Skipping is
      // right rather than clamping: the odds are genuinely undefined there, and a clamped value
      // would be a number with no meaning sitting in a ranking.
      if (insideDenominator <= 0 || outsideDenominator <= 0) continue;

      const logOddsRatio =
        Math.log(insideNumerator / insideDenominator) -
        Math.log(outsideNumerator / outsideDenominator);

      // Monroe's variance: the two counts' reciprocals, which is what makes a small group's terms
      // fall down the ranking rather than to the top of it.
      const variance = 1 / insideNumerator + 1 / outsideNumerator;
      const z = logOddsRatio / Math.sqrt(variance);

      scored.push({
        groupIndex: index,
        term,
        countInGroup: inside,
        countElsewhere: outside,
        documentsInGroup: group.documentCounts.get(term) ?? 0,
        logOddsRatio,
        z,
        p: chiSquarePValue(z * z, 1),
      });
    }
  }

  const adjusted = benjaminiHochberg(scored.map((entry) => entry.p));

  const byGroup: DistinctiveTerm[][] = groups.map(() => []);
  for (let i = 0; i < scored.length; i += 1) {
    const entry = scored[i] as Scored;
    const bucket = byGroup[entry.groupIndex] as DistinctiveTerm[];
    bucket.push({
      term: entry.term,
      countInGroup: entry.countInGroup,
      countElsewhere: entry.countElsewhere,
      documentsInGroup: entry.documentsInGroup,
      logOddsRatio: entry.logOddsRatio,
      z: entry.z,
      p: entry.p,
      pAdjusted: adjusted[i] as number,
    });
  }

  return {
    groups: groups.map((group, index) => ({
      group: group.name,
      documents: group.documents.length,
      tokens: perGroupTally[index]?.tokens ?? 0,
      // Most distinctive first, and DISTINCTIVE MEANS OVER-REPRESENTED: the sort is on signed z
      // descending, not on |z|. A term the group avoids is a real finding, but it is a different
      // finding, and mixing the two into one list makes the list unreadable -- a caller who wants
      // the under-represented tail can sort the same numbers the other way.
      terms: [...(byGroup[index] as DistinctiveTerm[])]
        .sort((x, y) => y.z - x.z || (x.term < y.term ? -1 : x.term > y.term ? 1 : 0))
        .slice(0, perGroup),
      underpowered: group.documents.length < minDocuments,
    })),
    vocabulary: vocabulary.length,
    family: scored.length,
    tokens: corpusTokens,
  };
}
