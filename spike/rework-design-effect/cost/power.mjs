// asc-09wx.12 scoping (throwaway): days to power for each (population x rule) cell.
// Usage: node spike/rework-design-effect/cost/power.mjs
import { powerPlan } from '../../../packages/analysis/dist/index.js';

const DAYS = 48;
const cells = [
  // label, baseline, n (perDay = n/48), designEffect
  ['narrow 104  first', 0.5288, 104, 3.33613],
  ['wide   394  first', 0.7005, 394, 3.59610],
  ['wide   394  last',  0.6650, 394, 4.90490],
  ['wide   394  any',   0.7817, 394, 4.60581],
  ['wide   394  all',   0.5558, 394, 6.14392],
  ['ceil   489  first (imputed 0)', 0.5644, 489, 8.40880],
  ['ceil   489  first (imputed 1)', 0.7587, 489, 6.15217],
  ['ceil   489  first (neighbour)', 0.7260, 489, 9.36570],
];

const rows = [];
for (const [label, baseline, n, designEffect] of cells) {
  for (const reduction of [0.3, 0.5]) {
    const p = powerPlan({ baseline, reduction, holdout: 0.5, perDay: n / DAYS, designEffect });
    rows.push({ label, reduction, units: p.units, days: Math.round(p.days), effectiveN: null, minNDays: Math.round(p.minNDays) });
  }
}
for (const r of rows) console.log(JSON.stringify(r));

// the coordinator's stated reference points, re-derived
for (const [baseline, perDay, designEffect] of [[0.678, 8.21, 3.336], [0.540, 2.1667, 3.336], [0.7005, 8.2083, 3.336]]) {
  const p = powerPlan({ baseline, reduction: 0.3, holdout: 0.5, perDay, designEffect });
  console.log(JSON.stringify({ check: 'reference', baseline, perDay, designEffect, units: p.units, days: Math.round(p.days) }));
}
