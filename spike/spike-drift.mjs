// EV-2: does LLM-authored type definition actually drift? (asc-spike-drift)
//
// Five independent agent sessions, no shared context, one identical brief,
// same requested type name (`review-completed`). This is the cheapest possible
// test of the project's core structural risk: if five samples of one type name
// against one paragraph produce five incompatible shapes, then the registry
// will fill with unusable half-corpora without a strict dedupe at define time.

import { readFile } from 'node:fs/promises';

const files = [1, 2, 3, 4, 5].map((n) => `spike/drift/spec-${n}.json`);

/** Normalizes a property name for cross-sample comparison: reviewStage == review_stage. */
const norm = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const specs = [];
for (const file of files) {
  const raw = await readFile(file, 'utf8');
  specs.push({ file, spec: JSON.parse(raw) });
}

console.log('=== per-sample shape ===');
for (const { file, spec } of specs) {
  const names = spec.properties.map((p) => p.name);
  const camel = names.filter((n) => /[a-z][A-Z]/.test(n)).length;
  const snake = names.filter((n) => n.includes('_')).length;
  console.log(`${file}: ${spec.properties.length} properties`);
  console.log(`   naming: ${camel} camelCase, ${snake} snake_case`);
  console.log(`   types:  ${[...new Set(spec.properties.map((p) => p.type))].sort().join(', ')}`);
  console.log(`   required: ${spec.properties.filter((p) => p.required === true).length}`);
  console.log(`   optional: ${spec.properties.filter((p) => p.required !== true).length}`);
}

// --- property-name overlap ---
const normalized = specs.map(({ spec }) => new Set(spec.properties.map((p) => norm(p.name))));
const union = new Set(normalized.flatMap((s) => [...s]));
const counts = new Map();
for (const set of normalized) {
  for (const name of set) counts.set(name, (counts.get(name) ?? 0) + 1);
}
const inAll5 = [...counts].filter(([, c]) => c === 5).map(([n]) => n);
const in4 = [...counts].filter(([, c]) => c === 4).map(([n]) => n);
const in3 = [...counts].filter(([, c]) => c === 3).map(([n]) => n);
const in2 = [...counts].filter(([, c]) => c === 2).map(([n]) => n);
const in1 = [...counts].filter(([, c]) => c === 1).map(([n]) => n);

console.log(`\n=== property-name agreement (normalized) ===`);
console.log(`union cardinality:        ${union.size}`);
console.log(`in ALL 5 samples:         ${inAll5.length}  ${inAll5.join(', ')}`);
console.log(`in 4 of 5:                ${in4.length}  ${in4.join(', ')}`);
console.log(`in 3 of 5:                ${in3.length}  ${in3.join(', ')}`);
console.log(`in 2 of 5:                ${in2.length}  ${in2.join(', ')}`);
console.log(`in exactly 1:             ${in1.length}  ${in1.join(', ')}`);

// Jaccard: pairwise and against the "consensus" set.
const jaccard = (a, b) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
};
const pairs = [];
for (let i = 0; i < normalized.length; i++) {
  for (let j = i + 1; j < normalized.length; j++) {
    pairs.push(jaccard(normalized[i], normalized[j]));
  }
}
const consensus = new Set(inAll5);
const consensusJ = normalized.map((s) => jaccard(s, consensus));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

console.log(`\npairwise Jaccard:  mean ${mean(pairs).toFixed(3)}, min ${Math.min(...pairs).toFixed(3)}, max ${Math.max(...pairs).toFixed(3)}`);
console.log(`vs the 5/5 consensus set: mean ${mean(consensusJ).toFixed(3)}`);
if (consensus.size > 0) {
  console.log(`intersection / union:      ${consensus.size} / ${union.size} = ${(consensus.size / union.size).toFixed(3)}`);
} else {
  console.log(`intersection / union:      0 / ${union.size} = 0.000  (no property appears in all five)`);
}

// --- type disagreement on shared properties ---
console.log(`\n=== type disagreements on shared properties ===`);
let disagreements = 0;
for (const [name, c] of [...counts].sort((a, b) => b[1] - a[1])) {
  if (c < 2) continue;
  const seen = new Set();
  for (const { spec } of specs) {
    const p = spec.properties.find((x) => norm(x.name) === name);
    if (p) seen.add(p.type);
  }
  if (seen.size > 1) {
    disagreements += 1;
    console.log(`  ${name}: ${[...seen].sort().join(' vs ')}  (present in ${c}/5)`);
  }
}
console.log(`shared properties with >1 declared type: ${disagreements}`);

// --- enum-value drift on shared enum properties ---
console.log(`\n=== enum vocabulary drift ===`);
for (const [name, c] of [...counts].sort((a, b) => b[1] - a[1])) {
  if (c < 2) continue;
  const vocabs = [];
  for (const { spec } of specs) {
    const p = spec.properties.find((x) => norm(x.name) === name && x.type === 'enum');
    if (p?.enum_values) vocabs.push(p.enum_values);
  }
  if (vocabs.length < 2) continue;
  const vUnion = new Set(vocabs.flat());
  const vInter = vocabs.reduce((acc, v) => acc.filter((x) => v.includes(x)), vocabs[0]);
  if (vUnion.size !== vInter.length) {
    console.log(`  ${name}: union ${vUnion.size} (${[...vUnion].join(', ')})`);
    console.log(`     intersection across ${vocabs.length} enum declarations: ${vInter.length}`);
  }
}
