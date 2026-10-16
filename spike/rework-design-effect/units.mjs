// asc-lspj (throwaway): the cluster structure behind a commit-triggered handler's units.
//
// `asc handlers power` refuses a `say:` handler before it reaches any clustering arithmetic
// (asc-xg62, dogfood/0115), so the shape of the correction has to be read off the replay
// directly. This prints the unit -> cluster table and the `sizeFactor` half of
// `designEffect = 1 + (sizeFactor - 1) * rho` (`packages/analysis/src/design-effect.ts`).
//
// Predictions are in the bead `asc-lspj`, registered before this ran. `rho` itself needs an
// outcome, which is not this script's job.
//
//   node spike/rework-design-effect/units.mjs <handler.yaml>

import { readFileSync } from 'node:fs';
import { replayHandlers } from '../../packages/cli/dist/handler-replay.js';
import { loadHandler } from '../../packages/cli/dist/handler-yaml.js';
import { defaultTranscriptRoot } from '../../packages/adapter-claude-code/dist/index.js';

const handlerPath = process.argv[2];
if (handlerPath === undefined) {
  console.error('usage: node spike/rework-design-effect/units.mjs <handler.yaml>');
  process.exit(2);
}

const handler = loadHandler(readFileSync(handlerPath, 'utf8'));
const result = await replayHandlers([{ name: 'probe', handler }], {
  source: 'transcripts',
  root: defaultTranscriptRoot(),
  projects: 'all',
  includeEphemeral: false,
});

const replay = result.handlers[0];
const spans = result.units;

/** Units the handler actually triggered in -- `plan()`'s `triggered`, which is the population. */
const perCluster = new Map();
const dates = new Set();
let units = 0;
let triggers = 0;
let rows = 0;
let undated = 0;
for (const [unit, count] of replay.units) {
  if (count.triggers === 0) continue;
  units += 1;
  triggers += count.triggers;
  rows += count.rows;
  // `sessionOf` in handler-power.ts: the cluster is the part of the key before the first NUL.
  const cluster = unit.split('\u0000')[0] ?? unit;
  perCluster.set(cluster, (perCluster.get(cluster) ?? 0) + 1);
  const ts = spans.get(unit)?.first_ts;
  if (typeof ts === 'string') dates.add(ts.slice(0, 10));
  else undated += 1;
}

const sizes = [...perCluster.values()].sort((a, b) => b - a);
const n = units;
const k = sizes.length;
// sum(m_i^2) / N -- 1 when every cluster is a singleton, N when there is one cluster of N.
const sizeFactor = sizes.reduce((a, m) => a + m * m, 0) / n;
const activeDays = dates.size;

const out = {
  files: result.horizon.files,
  events: result.horizon.events,
  first_ts: result.horizon.first_ts,
  last_ts: result.horizon.last_ts,
  units: n,
  triggers,
  rows,
  undated,
  clusters: k,
  active_days: activeDays,
  units_per_day: activeDays === 0 ? null : Math.round((n / activeDays) * 1000) / 1000,
  mbar: Math.round((n / k) * 10) / 10,
  largest_cluster: sizes[0],
  median_cluster: sizes[Math.floor(k / 2)],
  smallest_cluster: sizes[k - 1],
  largest_share: Math.round((sizes[0] / n) * 10000) / 10000,
  size_factor: Math.round(sizeFactor * 1000) / 1000,
  // designEffect = 1 + (sizeFactor - 1) * rho, so these are what each rho would buy.
  deff_at_rho_002: Math.round((1 + (sizeFactor - 1) * 0.02) * 1000) / 1000,
  deff_at_rho_005: Math.round((1 + (sizeFactor - 1) * 0.05) * 1000) / 1000,
  deff_at_rho_013: Math.round((1 + (sizeFactor - 1) * 0.13) * 1000) / 1000,
  top_clusters: sizes.slice(0, 12),
  clusters_over_20_units: sizes.filter((m) => m >= 20).length,
};
console.log(JSON.stringify(out, null, 1));
