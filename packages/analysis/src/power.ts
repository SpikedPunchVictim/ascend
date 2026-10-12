/**
 * How long an experiment has to run before its answer means anything (asc-6ola.3).
 *
 * WHY THIS EXISTS. `MIN_N` is a floor on REPORTING, not a readiness test. `spike/power/FINDINGS.md`
 * measured the gap on the frozen corpus and it is not small: in all eight cells it computed, every
 * arm cleared `MIN_N` within **0.1–1.7 active days**, while the same comparisons needed **13.5–265.6
 * days** to resolve. A workflow that read "each arm has n >= 20" as readiness would have reported
 * between 57x and 204x too early, every time. The gate that decides whether an experiment can answer
 * its question is this one, and it has to be computed BEFORE collecting, from a replayed base rate —
 * which is the one thing a post-hoc comparison of two arms can never be.
 *
 * THE FORMULA IS THE TEXTBOOK ONE, and it was validated rather than assumed. `power.mjs` ran 10,000
 * seeded simulations at the analytic n for the pooled search-miss rate and measured 81.0% power from
 * the two-proportion z-test and 80.8% from the Newcombe hybrid interval built on `wilson` — the only
 * interval ascend reports. So the closed form and the decision rule the analysis actually applies
 * agree to within a fifth of a point, and there is no second power model to disagree with this one.
 *
 * THE ESTIMATOR IS NOT HERE, DELIBERATELY. The one-way ANOVA intraclass correlation and the design
 * effect it produces are `design-effect.ts`'s (asc-0hys), already ported, tested, and possessed of the
 * one property this module needs from it: where `rho` cannot be estimated it returns the conservative
 * bound `rho = 1` and says `rhoSource: 'assumed-perfect'`, rather than clamping to 0. The spike did
 * clamp — `Math.max(0, ...)` in `describe()` — and the consequence is worth keeping in view: at
 * M1/this-project, four sessions over 1,236 units gives a cluster mean of 309, so the honest design
 * effect is about 309 and the clamped one is 1. The spike's own headline, *answerable here in about
 * two months*, is the clamped number, and its own addendum is what says not to trust it ("an ICC from
 * 3–4 clusters is not an estimate"). This module takes the design effect as an INPUT, so the caller
 * passes the corrected one and the difference is visible at the call site.
 *
 * NO FUNCTION HERE REPORTS DAYS TO `MIN_N` ALONE. `minNDays` is on the plan, and it is on the plan
 * beside `multiple`, which is how many times further away the real answer is. A reader given only the
 * first would read this module's whole purpose backwards.
 *
 * This file is pure: no `fs`, no clock, no network, no Node builtin, no seed (enforced by
 * `align check` and `packages/core/test/purity-enforcement.test.ts`).
 */

import { MIN_N, Z_BY_CONFIDENCE, type ConfidenceLevel } from './proportion.js';

/**
 * The normal quantile for 80% power, one-sided.
 *
 * Published rather than computed, for the reason `Z_BY_CONFIDENCE` gives: an inverse normal CDF would
 * be new, unchecked mathematics in a module whose arithmetic was validated against a simulation.
 * `pnorm` at this value returns 0.8000000 to seven places, which is the anchor.
 */
const Z_POWER_80 = 0.8416212335729143;

/**
 * A caller asked for a plan the arithmetic cannot produce.
 *
 * Thrown rather than clamped, in the style of `ProportionError` and `ClusterDesignError`, and every
 * one of these is a 0/0 that would otherwise become a confident-looking day count: a baseline of 0
 * or 1 has no variance to detect a change in; a reduction of 0 asks for infinite units and a
 * reduction of 1 asks for a treated arm of exactly zero; a holdout share of 0 or 1 leaves one arm
 * empty; a rate of 0 units per active day never reaches any sample size at all.
 */
export class PowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerError';
  }
}

/** What a plan is computed from. Every field is a measurement or a choice, never a default. */
export interface PowerInput {
  /** The outcome's success proportion in the arm that is NOT shown the guidance, in (0, 1) exclusive. */
  readonly baseline: number;
  /**
   * The RELATIVE reduction the plan is for, in (0, 1) exclusive — `0.5` asks for a halving.
   *
   * Relative and not absolute because that is the quantity `spike/power/FINDINGS.md` reports and the
   * quantity a reader can state before seeing the base rate.
   */
  readonly reduction: number;
  /** The share of units the hook holds back, in (0, 1) exclusive. `0.5` is the least units for the money. */
  readonly holdout: number;
  /** Units per ACTIVE day — a day the unit's work happened on, not a calendar day. Must be positive. */
  readonly perDay: number;
  /**
   * The variance inflation from clustering, from `clusterDesign().designEffect`. Never below 1.
   *
   * A caller who has not clustered anything passes 1 and says so; a caller who has passes the
   * measured effect and its `rhoSource` travels with it in the caller's own output, because a design
   * effect of 1 that was ASSUMED and one that was MEASURED are different claims.
   */
  readonly designEffect: number;
  /** The confidence the significance rule will be read at. Defaults to 0.95. */
  readonly confidence?: ConfidenceLevel;
}

/** The plan, and the numbers it is made of. */
export interface PowerPlan {
  /** The baseline, echoed so a rendered plan cannot drift from the number it used. */
  readonly baseline: number;
  /** The reduced proportion the plan is powered to detect: `baseline * (1 - reduction)`. */
  readonly treated: number;
  readonly reduction: number;
  readonly holdout: number;
  readonly perDay: number;
  readonly designEffect: number;
  /** Units per day in the SMALLER arm — `perDay * min(holdout, 1 - holdout)`. */
  readonly armPerDay: number;
  /** Total units needed, clustering included. The unclustered count times `designEffect`, rounded up. */
  readonly units: number;
  /** Units the smaller arm must hold. `units` is split by the holdout share. */
  readonly perArm: number;
  /** Active days to reach `units`. The answer to "how long does this take". */
  readonly days: number;
  /** Active days for each arm to clear `MIN_N` — the floor, NOT the answer. Read with `multiple`. */
  readonly minNDays: number;
  /** `days / minNDays`. How many times further away the real answer is than the floor. */
  readonly multiple: number;
}

/**
 * What the plan says about a horizon the caller has in mind.
 *
 * Three outcomes and no fourth, because the third is the one a reader has to be told: an experiment
 * that cannot answer the stated question can still be worth running, but only if someone says which
 * smaller effect it WOULD answer.
 */
export type PowerVerdict =
  /** `days` is at or under the horizon. */
  | { readonly kind: 'answerable'; readonly days: number }
  /**
   * The chosen unit cannot put `MIN_N` units in each arm over the horizon at all, whatever the effect
   * size. A different unit — a finer one — is the remedy, and naming it is the caller's job.
   */
  | { readonly kind: 'too-few-units'; readonly arm: number; readonly horizon: number }
  /** Too few units to detect the stated effect in time. `smallest` is what they would detect. */
  | {
      readonly kind: 'not-answerable';
      readonly horizon: number;
      readonly smallest: number | null;
    };

function check(input: PowerInput): void {
  const { baseline, reduction, holdout, perDay, designEffect } = input;
  if (!(baseline > 0 && baseline < 1)) {
    throw new PowerError(
      `baseline is ${String(baseline)}; it must be strictly between 0 and 1. A base rate of 0 or 1 ` +
        `has no variance, so no sample size detects a change in it.`,
    );
  }
  if (!(reduction > 0 && reduction < 1)) {
    throw new PowerError(
      `reduction is ${String(reduction)}; it must be strictly between 0 and 1. 0 asks for an ` +
        `infinite sample, and 1 asks for a treated arm of exactly zero.`,
    );
  }
  if (!(holdout > 0 && holdout < 1)) {
    throw new PowerError(
      `holdout is ${String(holdout)}; it must be strictly between 0 and 1, because 0 and 1 each ` +
        `leave one arm with no units in it.`,
    );
  }
  if (!(perDay > 0)) {
    throw new PowerError(
      `perDay is ${String(perDay)}; units per active day must be positive. At 0 no horizon reaches ` +
        `any sample size, and the days it would take are not a large number but no number.`,
    );
  }
  if (!(designEffect >= 1)) {
    throw new PowerError(
      `designEffect is ${String(designEffect)}; a design effect below 1 is arithmetic that cannot be ` +
        `right. It inflates variance, so clustering can only cost units.`,
    );
  }
}

/**
 * Total units for a two-proportion z-test at the stated power, clustering included.
 *
 * The standard normal approximation, with the pooled variance in the first term (the test's null) and
 * the unpooled variances in the second (the alternative). The holdout share is tied to the CONTROL
 * arm, deliberately: `holdout` is the fraction of units held back, those units carry `baseline`, and
 * the rest carry the reduced rate. So this is NOT symmetric in `holdout` — 30% held out costs 4,996
 * units where 70% costs 5,551, because the two arrange the same two rates over the same total
 * differently — and the even split is the cheapest design, which is the only reason it is the default.
 */
export function requiredUnits(input: PowerInput): number {
  check(input);
  const { baseline, reduction, holdout, designEffect } = input;
  const zAlpha = Z_BY_CONFIDENCE[input.confidence ?? 0.95];
  const treated = baseline * (1 - reduction);
  const other = 1 - holdout;
  const pooled = holdout * baseline + other * treated;
  const difference = baseline - treated;
  const numerator =
    zAlpha * Math.sqrt(pooled * (1 - pooled) * (1 / holdout + 1 / other)) +
    Z_POWER_80 *
      Math.sqrt((baseline * (1 - baseline)) / holdout + (treated * (1 - treated)) / other);
  return (numerator / difference) ** 2 * designEffect;
}

/**
 * The plan for one outcome, one effect size and one holdout share.
 *
 * `multiple` is computed here rather than left to a renderer because it is the module's whole reason
 * for existing. A caller that prints `days` and drops `multiple` has printed the number the spike
 * measured to be 57–204x wrong, which is the failure this file was written to prevent.
 */
export function powerPlan(input: PowerInput): PowerPlan {
  const units = requiredUnits(input);
  const armPerDay = input.perDay * Math.min(input.holdout, 1 - input.holdout);
  const clustered = Math.ceil(units);
  const days = clustered / input.perDay;
  const minNDays = MIN_N / armPerDay;
  return {
    baseline: input.baseline,
    treated: input.baseline * (1 - input.reduction),
    reduction: input.reduction,
    holdout: input.holdout,
    perDay: input.perDay,
    designEffect: input.designEffect,
    armPerDay,
    units: clustered,
    perArm: Math.ceil(clustered * Math.min(input.holdout, 1 - input.holdout)),
    days,
    minNDays,
    multiple: days / minNDays,
  };
}

/**
 * The smallest relative reduction the available units could detect, or `null` for none.
 *
 * `null` is not a large effect size. It is the statement that at this many units the arithmetic has
 * no answer, which is a different thing from a small one and has to be printable as such — the same
 * refusal `wilson(0, 0)` makes by returning `null` rather than a zero-width interval.
 *
 * Bisection rather than an inversion, because `requiredUnits` is not invertible in closed form: the
 * effect size sits inside both the pooled variance and the difference. It is monotone decreasing in
 * the reduction, which is all a bisection needs, and it is deterministic and unseeded, which is what
 * `packages/analysis` requires.
 */
export function detectableReduction(
  input: Omit<PowerInput, 'reduction'>,
  units: number,
): number | null {
  if (!(units > 0)) return null;
  // The interval is open at both ends — a reduction of 0 has infinite requirement and a reduction of
  // 1 has a degenerate arm — so the search runs strictly inside it and never evaluates either end.
  let low = 1e-9;
  let high = 1 - 1e-9;
  if (requiredUnits({ ...input, reduction: high }) > units) return null;
  if (requiredUnits({ ...input, reduction: low }) <= units) return low;
  // 200 halvings is far below the precision of a day count, and the bound is fixed rather than
  // tolerance-checked so the function is a pure function of its arguments with no epsilon to tune.
  for (let step = 0; step < 200; step += 1) {
    const middle = (low + high) / 2;
    if (requiredUnits({ ...input, reduction: middle }) > units) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/**
 * The verdict for a horizon, and the refusal the bead asks for.
 *
 * The two are checked in order, and the order is the point: a unit that cannot fill `MIN_N` in each
 * arm over the horizon is refused as a UNIT — "this one will not work, choose a finer one" — before
 * anything is said about effect sizes. Reporting `smallest detectable` for such a unit would be
 * reporting a number computed at a sample size that will never be reached.
 */
export function powerVerdict(input: PowerInput, horizon: number): PowerVerdict {
  const plan = powerPlan(input);
  const arm = plan.armPerDay * horizon;
  if (arm < MIN_N) return { kind: 'too-few-units', arm, horizon };
  if (plan.days <= horizon) return { kind: 'answerable', days: plan.days };
  return {
    kind: 'not-answerable',
    horizon,
    smallest: detectableReduction(input, plan.perDay * horizon),
  };
}
