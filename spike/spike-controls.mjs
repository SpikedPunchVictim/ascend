// asc-fwpe: the two controls `docs/evidence/EV-patterns.md:126-138` names as
// required additions to E7, measured against the real corpus. THROWAWAY: this
// reproduces the numbers the re-issued record cites, so they are regenerable
// rather than transcribed. It is not the implementation -- that is
// `packages/analysis/src/association.ts` (`functionalDependence`,
// `blockPermutationNull`), with its own anchors in `test/controls.test.ts`.
//
// WHAT IT ANSWERS, named before anything was run:
//   1. Is `project x repo` really "a deterministic mapping", as the published
//      prose says? (No -- and what the coefficients actually are.)
//   2. Does a threshold exist that separates it from every real finding?
//   3. Does permuting whole days' weekday labels collapse the weekday pairings?
//   4. After both controls, how many of `tool-denial`'s ten pairs survive?
//
// READ-ONLY over the frozen 2026-09-11 `spike/corpus.db`. It reproduces
// EV-patterns exactly (N=409, Thursday 168/409 = 41.1%, 2026-09-03 = 143/409),
// which is what makes the re-issue a clean before/after with no corpus-growth
// confound.

import { DatabaseSync } from 'node:sqlite';
import { chiSquare, chiSquarePValue, crosstab, mulberry32, permutationNull } from './lib/stats.mjs';

const db = new DatabaseSync('spike/corpus.db');
const all = (sql, ...params) => db.prepare(sql).all(...params);

const KIND = process.argv[2] ?? 'tool-denial';
const ITERATIONS = 5000;
const SEED = 20261005;

/**
 * The threshold the shipped constant carries. Duplicated here rather than
 * imported, because this file is the INDEPENDENT reproduction -- a spike that
 * read `DEFINITIONAL_AT` from the module it is checking could not notice the
 * constant being changed.
 */
const DEFINITIONAL_AT = 0.5;

const WEEKDAY = `CASE CAST(strftime('%w', recorded_at) AS INTEGER)
  WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
  WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END`;

const COLUMN = {
  denial_kind: 'denial_kind',
  tool_name: 'tool_name',
  project: 'project',
  skill_name: 'skill_name',
  agent_name: 'agent_name',
  trigger: 'trigger',
  has_stderr: 'CAST(has_stderr AS TEXT)',
  weekday: WEEKDAY,
  repo: "COALESCE(git_branch, '(none)')",
  day: "strftime('%Y-%m-%d', recorded_at)",
};

const DIMENSIONS = {
  'tool-denial': ['denial_kind', 'tool_name', 'project', 'weekday', 'repo'],
  'skill-activation': ['skill_name', 'project', 'agent_name', 'weekday'],
  'verification-run': ['tool_name', 'project', 'has_stderr', 'weekday'],
  'context-compaction': ['project', 'trigger', 'weekday'],
  'user-correction': ['project', 'weekday'],
};

const dims = DIMENSIONS[KIND];
if (!dims) {
  console.error(`no dimensions declared for '${KIND}'. Known: ${Object.keys(DIMENSIONS).join(', ')}`);
  process.exit(2);
}

const cols = [...new Set([...dims, 'day'])].map((d) => `${COLUMN[d]} AS ${d}`).join(', ');
const rows = all(`SELECT ${cols} FROM events WHERE kind = ? ORDER BY recorded_at`, KIND);
const n = rows.length;

const values = (dim) => rows.map((r) => r[dim] ?? '(not measured)');

// --- the arithmetic the shipped `functionalDependence` is, spelled out here ---
// U(a->b) = MI(a,b) / H(b), the share of b's uncertainty that knowing a removes.
// 1 means "a is a relabelling of b"; 0 means "a tells you nothing about b".
function entropy(cells) {
  const total = cells.reduce((sum, c) => sum + c, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of cells) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function mutualInformation(table) {
  const { rowKeys, colKeys, counts, rowTotals, colTotals, n: total } = table;
  let bits = 0;
  for (const r of rowKeys) {
    for (const c of colKeys) {
      const joint = (counts.get(`${r}\u0000${c}`) ?? 0) / total;
      if (joint === 0) continue;
      const expected = (rowTotals.get(r) / total) * (colTotals.get(c) / total);
      bits += joint * Math.log2(joint / expected);
    }
  }
  return {
    bits,
    entropyA: entropy(rowKeys.map((r) => rowTotals.get(r))),
    entropyB: entropy(colKeys.map((c) => colTotals.get(c))),
  };
}

function dependence(a, b) {
  const table = crosstab(a, b);
  const { bits, entropyA, entropyB } = mutualInformation(table);
  const aToB = entropyB > 0 ? Math.min(1, bits / entropyB) : 0;
  const bToA = entropyA > 0 ? Math.min(1, bits / entropyA) : 0;
  const determinism = Math.max(aToB, bToA);
  return { aToB, bToA, determinism, definitional: determinism >= DEFINITIONAL_AT };
}

/**
 * The block null: permute the BLOCK-LEVEL TEMPORAL LABEL among blocks. Each
 * block keeps its size and its rows, so the 143-row day draws a random weekday
 * and no row has to be invented or dropped for unequal sizes.
 *
 * Deliberately NOT marginal-preserving, and that is the whole point: the
 * marginal concentration the weekday shows is REAL, and it is the PAIRING over
 * time that is spurious. `permutationNull` destroys the marginals, which is why
 * it cannot see this and why this is a second control rather than a reuse.
 */
function blockPermutationNull(temporal, other, blocks, { iterations, seed }) {
  const order = [];
  const index = new Map();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === null) throw new Error(`row ${i} has no block`);
    if (!index.has(block)) {
      index.set(block, order.length);
      order.push({ id: block, rows: [] });
    }
    order[index.get(block)].rows.push(i);
  }
  for (const block of order) {
    const labels = new Set(block.rows.map((i) => temporal[i]));
    if (labels.size !== 1) {
      throw new Error(
        `block '${block.id}' carries two temporal values (${[...labels].join(', ')}): a block ` +
          `must refine the temporal label, and resampling this would mean inventing rows. ` +
          `Block at a finer grain.`,
      );
    }
    block.label = block.rows[0] !== undefined ? temporal[block.rows[0]] : null;
  }
  const labels = order.map((b) => b.label);
  const rand = mulberry32(seed);
  const stats = [];
  const permutedTemporal = [...temporal];
  const permutedLabels = [...labels];
  for (let i = 0; i < iterations; i++) {
    for (let j = permutedLabels.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [permutedLabels[j], permutedLabels[k]] = [permutedLabels[k], permutedLabels[j]];
    }
    for (let b = 0; b < order.length; b++) {
      for (const row of order[b].rows) permutedTemporal[row] = permutedLabels[b];
    }
    stats.push(chiSquare(crosstab(permutedTemporal, other)).chi2);
  }
  stats.sort((x, y) => x - y);
  const at = (q) => stats[Math.min(stats.length - 1, Math.floor(q * stats.length))];
  return {
    iterations,
    median: at(0.5),
    p95: at(0.95),
    max: stats[stats.length - 1],
    pValue(observed) {
      const ge = stats.filter((s) => s >= observed).length;
      return (ge + 1) / (iterations + 1);
    },
  };
}

const blockValues = rows.map((r) => r.day ?? null);
const distinctBlocks = new Set(blockValues).size;

console.log('='.repeat(78));
console.log(`${KIND.toUpperCase()}   N=${n}   days=${distinctBlocks}   (spike/corpus.db, frozen 2026-09-11)`);
console.log('='.repeat(78));

// --- the day-size distribution, which is the confound itself ---
const daySizes = new Map();
for (const day of blockValues) daySizes.set(day, (daySizes.get(day) ?? 0) + 1);
const sizes = [...daySizes].sort((a, b) => b[1] - a[1]);
console.log(`\n  day sizes: largest ${sizes[0][1]}/${n} (${sizes[0][0]}), ` +
  `median ${sizes[Math.floor(sizes.length / 2)][1]}, singleton days ` +
  `${sizes.filter(([, c]) => c === 1).length}/${sizes.length}`);

// --- TABLE 1: determinism across every pair ---
console.log('\n  --- TABLE 1: determinism U = 1 - H(Y|X)/H(Y), the stronger direction ---');
console.log(`  ${'pair'.padEnd(30)} ${'a->b'.padStart(7)} ${'b->a'.padStart(7)} ${'max'.padStart(7)}  verdict`);
const pairs = [];
for (let i = 0; i < dims.length; i++) {
  for (let j = i + 1; j < dims.length; j++) {
    const a = values(dims[i]);
    const b = values(dims[j]);
    const stat = chiSquare(crosstab(a, b));
    if (stat.df === 0) continue;
    const dep = dependence(a, b);
    const pair = `${dims[i]} x ${dims[j]}`;
    pairs.push({ pair, a: dims[i], b: dims[j], aValues: a, bValues: b, stat, dep });
    console.log(
      `  ${pair.padEnd(30)} ${dep.aToB.toFixed(3).padStart(7)} ${dep.bToA.toFixed(3).padStart(7)} ` +
        `${dep.determinism.toFixed(3).padStart(7)}  ${dep.definitional ? 'DEFINITIONAL' : ''}`,
    );
  }
}
pairs.sort((x, y) => y.dep.determinism - x.dep.determinism);
console.log(`\n  strongest ${pairs[0].pair} at ${pairs[0].dep.determinism.toFixed(3)}, ` +
  `next down ${pairs[1].pair} at ${pairs[1].dep.determinism.toFixed(3)}, ` +
  `ratio ${(pairs[0].dep.determinism / pairs[1].dep.determinism).toFixed(1)}x`);
console.log(`  threshold ${DEFINITIONAL_AT} sits inside that gap: ` +
  `${pairs.filter((p) => p.dep.definitional).length} pair(s) at or above it.`);

// The strict-functional arm: what a literal reading of the bead would have shipped.
const strict = pairs.filter((p) => p.dep.aToB === 1 || p.dep.bToA === 1);
console.log(`  a STRICT functional-dependency test (exactly 1.000) fires on ` +
  `${strict.length} pair(s): ${strict.map((p) => p.pair).join(', ') || '(none)'}`);

// --- TABLE 2: the block null, on every pair containing a temporal column ---
const TEMPORAL = ['weekday'];
console.log('\n  --- TABLE 2: block permutation of the weekday label among days ---');
console.log(`  ${'pair'.padEnd(30)} ${'observed'.padStart(9)} ${'null med'.padStart(9)} ` +
  `${'p95'.padStart(9)} ${'p'.padStart(7)}  verdict`);
const blocked = [];
for (const pair of pairs) {
  const which = TEMPORAL.includes(pair.a) ? pair.a : TEMPORAL.includes(pair.b) ? pair.b : null;
  if (which === null) continue;
  const other = which === pair.a ? pair.bValues : pair.aValues;
  const control = blockPermutationNull(values(which), other, blockValues, {
    iterations: ITERATIONS,
    seed: SEED,
  });
  const p = control.pValue(pair.stat.chi2);
  // A pairing is flagged when it does not clear the block structure's own noise.
  const flagged = p >= 0.05;
  blocked.push({ pair: pair.pair, p, flagged });
  console.log(
    `  ${pair.pair.padEnd(30)} ${pair.stat.chi2.toFixed(2).padStart(9)} ` +
      `${control.median.toFixed(2).padStart(9)} ${control.p95.toFixed(2).padStart(9)} ` +
      `${p.toFixed(4).padStart(7)}  ${flagged ? 'BLOCK CONFOUND' : 'survives'}`,
  );
}
console.log(`  ${ITERATIONS} iterations, seed ${SEED}, +1 corrected. Observed BELOW the null median ` +
  'means the day structure alone manufactures more than the data contains.');

// --- the survivor count, after BOTH controls ---
console.log('\n  --- survivors after both controls ---');
const shuffled = new Map(
  pairs.map((p) => {
    const nul = permutationNull(p.aValues, p.bValues, { iterations: 400, seed: 12345 });
    return [p.pair, nul.pValue(p.stat.chi2)];
  }),
);
const survivors = [];
for (const pair of pairs) {
  const pShuffled = shuffled.get(pair.pair);
  if (pair.dep.definitional) {
    console.log(`  SUPPRESSED (definitional)   ${pair.pair}  determinism ${pair.dep.determinism.toFixed(3)}`);
    continue;
  }
  if (pShuffled >= 0.05) {
    console.log(`  ARTIFACT of marginals       ${pair.pair}  shuffled p ${pShuffled.toFixed(4)}`);
    continue;
  }
  const block = blocked.find((b) => b.pair === pair.pair);
  if (block?.flagged) {
    console.log(`  BLOCK CONFOUND              ${pair.pair}  block p ${block.p.toFixed(4)}`);
    continue;
  }
  survivors.push(pair.pair);
  console.log(`  SURVIVES                    ${pair.pair}  V ${pair.stat.cramersV.toFixed(3)}` +
    `  shuffled p ${pShuffled.toFixed(4)}${block ? `  block p ${block.p.toFixed(4)}` : ''}`);
}
console.log(`\n  ${survivors.length} of ${pairs.length} pairs survive both controls: ` +
  `${survivors.join(', ')}`);
db.close();
