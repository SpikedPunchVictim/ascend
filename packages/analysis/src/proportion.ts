/**
 * Proportions -- the only way a share of a group leaves this codebase.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION. `ARCHITECTURE.md`'s honesty section prescribes that
 * every proportion ascend reports carries a Wilson score interval and its n, and that a group below
 * `MIN_N` is flagged as an anecdote rather than printed as a seductive percentage. A convention
 * stated only in prose is one an author can forget, so the flag is a FIELD OF THE RESULT here:
 * there is no call that yields a point estimate without also yielding the interval and the
 * small-group judgement about it. The renderer (`packages/cli/src/output.ts`, `renderProportion`)
 * reads those fields, so a proportion that skipped the interval cannot be printed as though it had
 * one.
 *
 * WHAT THE INTERVAL IS FOR -- and therefore where the rule stops. A proportion presented as
 * EVIDENCE ABOUT A POPULATION is an estimate, and a reader shown `55%` will generalise from it; the
 * interval is how much the observed count actually constrains that generalisation. A proportion
 * that reports a COMPLETE ENUMERATION of something already in hand is not an estimate and gets no
 * interval: `showing 40 of 512, 7.8%` (`renderCoverage`) is a census of one output, and putting a
 * confidence interval on it would invent an uncertainty that does not exist. So the rule is
 * "evidence about a population", not "two numbers with a slash between them" -- which matters,
 * because a rule stated as "every proportion" invites exactly that misreading.
 *
 * PORTED, NOT WRITTEN. The Stage 0 spike validated this arithmetic against hand-computed worked
 * examples in `spike/lib/stats.mjs` + `spike/lib/stats.test.mjs`, and `index.ts` carried a note
 * asking for it to be ported rather than rewritten. The anchors are the reason the port is worth
 * anything: Wilson 25/100 -> (0.1754534, 0.3430444), and the 0/10 upper bound 0.2775328, which
 * matches the published table. Both are reproduced unchanged in `test/proportion.test.ts`, because
 * a statistic checked against its own output proves nothing.
 *
 * TWO DELIBERATE DEPARTURES FROM THE SPIKE, both recorded in the `asc-bmf` decision entry:
 *
 *   1. **The confidence LEVEL replaced the raw `z`.** The spike took `z` as a parameter while
 *      hardcoding the literal text `95% CI` in its output, so any other z printed a label that
 *      disagreed with the arithmetic beside it -- latent in a throwaway spike, a false claim in a
 *      shipped contract. Here the parameter IS the level and the quantile is looked up from it, so
 *      the number rendered and the number computed cannot diverge: they are one value.
 *
 *   2. **`n = 0` has no estimate at all.** The spike returned `{ p: 0, lower: 0, upper: 1, n: 0 }`,
 *      which states a point estimate of 0% for a group with nothing in it. `TASKS.md` #7 is
 *      explicit -- "omitted, never fabricated. When a value does not exist, omit it. Never write 0
 *      for unknown" -- and `--json` carries this structure, so the fabricated zero would have
 *      shipped as the contract. `wilson` returns `null` instead, and the spike's `n=0 (no
 *      estimate)` rendering becomes the rendering of an honest absence rather than a cover for a
 *      dishonest zero.
 *
 * Pure: no `fs`, no clock, no network, no Node builtin at all (enforced by `align check` and
 * `purity-enforcement.test.ts`). Nothing here draws a random number, so there is no seed.
 */

/** Minimum group size below which a proportion is an anecdote, not an estimate. */
export const MIN_N = 20;

/**
 * The confidence levels this port supports, and the two-sided normal quantile each one uses.
 *
 * The quantiles are the PUBLISHED values rather than computed here, deliberately. An inverse normal
 * CDF would be new mathematics in a module whose entire justification is that its arithmetic was
 * already validated against hand-computed anchors, and the anchors do not extend to it. Three
 * levels cover every use the CLI has; a level that is not here is refused rather than approximated,
 * because a quantile invented to fill a gap is a confidence interval that is wrong by an amount
 * nobody can see.
 */
const Z_BY_CONFIDENCE = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
} as const;

/** The confidence level an interval is estimated at, as a probability. */
export type ConfidenceLevel = keyof typeof Z_BY_CONFIDENCE;

/**
 * A caller asked for a proportion the arithmetic cannot produce.
 *
 * Thrown rather than clamped, in the style of `SampleSizeError`. `wilson(5, 3)` has no answer:
 * five successes out of three observations is not a large proportion, it is a caller that has
 * swapped which number is which, and a clamped result would be a confident-looking interval
 * computed from nonsense -- the severity-zero class this project treats as jumping the queue.
 */
export class ProportionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProportionError';
  }
}

/**
 * A proportion together with the interval that qualifies it.
 *
 * Every field is present on every instance: a proportion is either an estimate (all of it) or
 * absent entirely (`wilson` returned `null`). There is deliberately no state in which `p` exists
 * and `lower` does not, because that is the state a caller renders as a bare percentage.
 */
export interface Proportion {
  /** The count in the numerator. */
  readonly successes: number;
  /** The count in the denominator. */
  readonly n: number;
  /** The point estimate, `successes / n`. */
  readonly p: number;
  /** The lower bound of the interval, never below 0 -- Wilson's reason for being chosen. */
  readonly lower: number;
  /** The upper bound of the interval, never above 1. */
  readonly upper: number;
  /** The level `lower` and `upper` are bounds of, so the label cannot contradict them. */
  readonly confidence: ConfidenceLevel;
  /**
   * True when `n` is below `MIN_N`.
   *
   * On the result rather than computed by the caller, because the caller is the part that can
   * forget. The renderer appends the flag from this field, so the only way to print a proportion is
   * to print its qualification with it.
   */
  readonly smallGroup: boolean;
}

/**
 * Whether a group of `n` is too small to estimate from.
 *
 * A named predicate rather than `n < MIN_N` at each call site, so the threshold has one definition
 * and a change to it cannot reach some of the places that apply it. Exported because a group can be
 * reported WITHOUT a proportion -- "12 entries" needs the same judgement as "12 of 30" -- and that
 * call site has an n but no `Proportion` to read the flag from.
 */
export function isSmallGroup(n: number): boolean {
  return n < MIN_N;
}

/**
 * Whether a number is a level this port has a published quantile for.
 *
 * A type predicate rather than a lookup that returns `undefined`, and the parameter below is a plain
 * `number` for that reason -- the same choice `sample.ts` makes for a sample size, and for the same
 * reason. The level SELECTS an arithmetic constant, so an unsupported one would otherwise reach the
 * arithmetic as `undefined`, produce `NaN` bounds, and render as `NaN%`: a wrong answer shaped like
 * a right one. Typing the parameter as the union instead would move that refusal to the compiler and
 * leave nothing to test -- and it is not reachable from a caller who has only JavaScript.
 *
 * The predicate narrows, so everything downstream of the check still gets `ConfidenceLevel` and the
 * quantile lookup needs no second guard. `Object.hasOwn` rather than `in`, because `in` walks the
 * prototype chain and would accept `'toString'`.
 */
function isConfidenceLevel(value: number): value is ConfidenceLevel {
  return Object.hasOwn(Z_BY_CONFIDENCE, value);
}

/**
 * Refuse a pair of counts that is not a proportion.
 *
 * Validated in the order the arguments appear, so a caller given one message knows which argument it
 * is about by where it sits. The `successes > n` case is the one worth naming precisely: it is not a
 * boundary that needs clamping, it is two arguments in the wrong slots, and saying so is the
 * difference between a caller fixing it and a caller clamping the result.
 */
function checkCounts(successes: number, n: number): void {
  if (!Number.isInteger(successes) || successes < 0) {
    throw new ProportionError(`successes must be a non-negative integer, got ${String(successes)}`);
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new ProportionError(`n must be a non-negative integer, got ${String(n)}`);
  }
  if (successes > n) {
    throw new ProportionError(
      `successes (${String(successes)}) cannot exceed n (${String(n)}): a count of successes out of fewer observations means the two arguments are the wrong way round.`,
    );
  }
}

/**
 * Wilson score interval for a binomial proportion, or `null` when there is nothing to estimate.
 *
 * Chosen over the normal approximation because it stays inside [0,1] and behaves sanely at small n
 * and at proportions near 0 or 1 -- exactly the regime this project's counts live in (n in the
 * hundreds, categories in the single digits). The clamps are what enforce that, and
 * `test/proportion.test.ts` checks both ends against the published table rather than asserting the
 * clamp in the abstract.
 *
 * THE CLAMPS ARE FOUR, NOT TWO, AND NONE OF THEM IS DECORATION. Mathematically the interval always
 * contains `p` and always sits inside [0,1]. In IEEE-754 it can miss by one ulp, and the case that
 * reaches the edge is `p = 1`: the true upper bound is exactly 1, but `center + margin` evaluates to
 * 0.9999999999999999 -- MEASURED, that is the value the spike recorded and the failure this port
 * hit.
 *
 * All four were censused on 2026-09-17 over 53,118 (successes, n, level) combinations -- n to 400,
 * dense below 40, every level -- and they fire 487 times between them: `center + margin` above 1
 * sixty times, `center - margin` below 0 ninety-six times, the interval failing to contain `p` three
 * hundred and thirty-one times. EVERY one of those is at `p = 0` or `p = 1`; on an interior `p` all
 * four are no-ops, which is the mathematical claim above surviving contact with the arithmetic. The
 * smallest n reaching each is 14, 21, 3 and 1 respectively -- which is why the invariant tests walk
 * a GENERATED dense sweep rather than a hand-written list of regimes. `[10, 10]` is a case an author
 * thought of; `n = 14 at 90%` is a case the arithmetic has. The first version of these tests listed
 * regimes by hand and a mutation run caught it: dropping the upper outer clamp left every test green.
 *
 * An interval that does not contain its own estimate is a broken invariant whatever the renderer's
 * rounding hides, so all four make the RETURNED VALUE satisfy the property Wilson is chosen for,
 * rather than asserting it of the arithmetic behind it.
 *
 * `null` for `n = 0`, never a zero-valued interval. See the module comment, departure 2.
 */
export function wilson(successes: number, n: number, confidence: number = 0.95): Proportion | null {
  checkCounts(successes, n);
  if (!isConfidenceLevel(confidence)) {
    throw new ProportionError(
      `confidence must be one of ${Object.keys(Z_BY_CONFIDENCE).join(', ')}, got ${String(confidence)}`,
    );
  }

  if (n === 0) return null;

  const z = Z_BY_CONFIDENCE[confidence];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;

  return {
    successes,
    n,
    p,
    lower: Math.max(0, Math.min(p, center - margin)),
    upper: Math.min(1, Math.max(p, center + margin)),
    confidence,
    smallGroup: isSmallGroup(n),
  };
}
