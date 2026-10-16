// asc-lspj: the design effect, from packages/analysis/dist/index.js.
//
// Usage: node spike/rework-design-effect/design.mjs <effect.json>
//
// Reads the per-unit outcomes effect.py wrote and runs the package's own clusterDesign. The
// cluster is handler-power.ts's sessionOf: the part of the unit key before the first NUL.

import { readFileSync } from 'node:fs';
import { clusterDesign } from '../../packages/analysis/dist/index.js';

const effect = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sessionOf = (unit) => unit.split('\u0000')[0] ?? unit;

const run = (label, pairs) => {
  const outcomes = pairs.map(([, o]) => o);
  const clusters = pairs.map(([u]) => sessionOf(u));
  const d = clusterDesign(outcomes, clusters);
  console.log(JSON.stringify({
    rule: label, n: d.n, clusters: d.clusters, largestCluster: d.largestCluster,
    rho: d.rho, rhoSource: d.rhoSource, designEffect: d.designEffect, effectiveN: d.effectiveN,
    rate: outcomes.length === 0 ? null : outcomes.reduce((a, b) => a + b, 0) / outcomes.length,
  }));
};

for (const rule of ['first', 'any', 'last', 'all', 'first_sha', 'any_sha']) {
  if (!effect.outcomes[rule]) continue;
  run(rule, effect.outcomes[rule]);
}
