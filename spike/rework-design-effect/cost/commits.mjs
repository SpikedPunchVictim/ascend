// asc-09wx.12: segment-level vs commit-level analysis, through the package's own arithmetic.
//
// `rho.py` collapses each randomized unit to one 0/1 (cluster-level); `commits.py` emits every
// (unit, commit) observation behind those units (individual-level). This runs `clusterDesign` over
// both, and `powerPlan` for each cell, so the two analyses are compared by the repository's own
// estimator and its own power model rather than by a second implementation of either.
//
// The segment-level row is a CROSS-CHECK: it must reproduce EV-71's widened `any`
// (n 394, rho 0.09588, designEffect 4.60581, rate 0.78173) or the two levels are not comparable.
//
//   node spike/rework-design-effect/cost/commits.mjs <commits.json>
import { readFileSync } from 'node:fs';
import { clusterDesign, powerPlan } from '../../../packages/analysis/dist/index.js';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// handler-power.ts's sessionOf: the part of the unit key before the first NUL.
const sessionOf = (unit) => unit.split('\u0000')[0] ?? unit;
// EV-71 measured 8.2083 units per active day over 48 active days, which is 394/48.
const UNIT_ACTIVE_DAYS = 48;

const design = (label, pairs, activeDays) => {
  const outcomes = pairs.map(([, o]) => o);
  const clusters = pairs.map(([, , c]) => c);
  const d = clusterDesign(outcomes, clusters);
  // EV-71 reports this term by hand; printed here so the reader is not asked to divide.
  const sizeOf = new Map();
  for (const c of clusters) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1);
  const sizeFactor = [...sizeOf.values()].reduce((a, m) => a + m * m, 0) / d.n;
  const baseline = outcomes.reduce((a, b) => a + b, 0) / outcomes.length;
  const perDay = d.n / activeDays;
  const plan = (reduction) => {
    const p = powerPlan({ baseline, reduction, holdout: 0.5, perDay, designEffect: d.designEffect });
    return { reduction, units: p.units, days: Math.round(p.days) };
  };
  console.log(JSON.stringify({
    label, n: d.n, clusters: d.clusters, largestCluster: d.largestCluster, rho: d.rho,
    rhoSource: d.rhoSource, sizeFactor: Math.round(sizeFactor * 1e3) / 1e3,
    designEffect: Math.round(d.designEffect * 1e5) / 1e5,
    effectiveN: Math.round(d.effectiveN * 1e3) / 1e3, rate: Math.round(baseline * 1e5) / 1e5,
    perDay: Math.round(perDay * 1e4) / 1e4, activeDays,
    plan30: plan(0.3), plan50: plan(0.5),
  }));
};

// ---- the cross-check: what EV-71 already published ----
design('segment  any     cluster=session', data.units_any.map(([u, o]) => [u, o, sessionOf(u)]), UNIT_ACTIVE_DAYS);

// ---- the commit level, at both admissible cluster keys ----
// The ASSIGNMENT is the segment, so `cluster=unit` is the design-based key for a commit-level ITT.
// `cluster=session` is a superset of it and therefore the conservative one, kept because a session
// effect exists whether or not the assignment does: EV-71 measures rho 0.0959 BETWEEN segments in
// one session, which is exactly the correlation a segment-level key cannot see.
//
// Both are run on EV-71's 48-day denominator, because `perDay` is units accrued per active day of
// the SAME working period, and the two levels must be compared on one clock. The 41 days the
// commit observations actually landed on is reported beside it as a sensitivity, not as the basis.
const landedDays = new Set(data.commits.map(([, ts]) => ts.slice(0, 10))).size;
const commitPairs = data.commits.map(([u, , o]) => [u, o]);
for (const label of ['unit', 'session']) {
  const pairs = commitPairs.map(([u, o]) => [u, o, label === 'unit' ? u : sessionOf(u)]);
  design(`commit   cluster=${label}`, pairs, UNIT_ACTIVE_DAYS);
  design(`commit   cluster=${label}   (landed days)`, pairs, landedDays);
}

// ---- sensitivity: one observation per distinct commit, first unit to carry it wins ----
const firstByKey = new Map();
for (const [u, , o, key] of data.commits) if (!firstByKey.has(key)) firstByKey.set(key, [u, o]);
const dedup = [...firstByKey.values()];
for (const label of ['unit', 'session']) {
  const pairs = dedup.map(([u, o]) => [u, o, label === 'unit' ? u : sessionOf(u)]);
  design(`commit   cluster=${label}   (dedup key)`, pairs, UNIT_ACTIVE_DAYS);
}
