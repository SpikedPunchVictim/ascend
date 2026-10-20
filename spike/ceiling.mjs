// The EV-16 harness's spend ceiling, as a decision rather than an after-the-fact check.
//
// The ceiling used to be tested against what had ALREADY been spent, so it bounded what to do once
// it was crossed rather than what it was meant to bound: EV-30 measured a total of $3.216935000
// against `EV16_MAX_USD=3`, and arm G's third repetition never ran, leaving the pre-registered n=3
// at n=2 (`asc-kzvi`). The fix is to ask the question BEFORE firing a session -- would one more
// session, at what this route has cost so far, cross the line? -- and to report the pairs it did
// not run so the denominator is never quietly short.
//
// The fallback is the one number this module cannot derive: with no sessions yet there is nothing
// to average, and the pre-registration's own figure (~$0.14/session) was taken on claude-haiku on a
// first-party route. EV-30 measured $0.4508-$0.82172 per session on the GLM gateway route this
// harness actually uses -- mean $0.64339 over n=5, 4.6x the inherited figure -- so that mean is the
// fallback here. A ceiling sized with the old number is not a ceiling on this route.

/** Mean cost of one session on this harness's route, from EV-30's n=5 measurement. */
export const ROUTE_MEAN_USD = 0.64339;

/**
 * What the next session is expected to cost: the mean of what sessions have cost, or the route's
 * fallback when none has run.
 *
 * The mean rather than the maximum, deliberately: the maximum of a handful of draws is a worse
 * estimate of the next draw than their mean, and the bead asks for a projection, not a guarantee.
 * Zero and non-finite costs are excluded because a failed session contributes no billable envelope
 * and would otherwise pull the projection toward zero.
 *
 * @param {readonly number[]} costs
 * @param {number} [fallback]
 * @returns {number}
 */
export function projectedNext(costs, fallback = ROUTE_MEAN_USD) {
  const paid = costs.filter((cost) => Number.isFinite(cost) && cost > 0);
  if (paid.length === 0) return fallback;
  return paid.reduce((sum, cost) => sum + cost, 0) / paid.length;
}

/**
 * Whether firing one more session would take the run PAST the ceiling.
 *
 * Strictly greater, so spent + projected == maxUsd is allowed: the ceiling is the line the run may
 * reach, and a run that stops one cent short of an explicit maximum has not used what it was given.
 *
 * @param {number} spent
 * @param {number} projected
 * @param {number} max
 * @returns {boolean}
 */
export function wouldCross(spent, projected, max) {
  return spent + projected > max;
}
