/**
 * The learnability gate for `asc-asq`, run BEFORE either sampling arm: can a model classify a
 * finding into its lens at all, when it is shown labelled examples of every lens?
 *
 * EV-22 recorded three conditions a corpus must satisfy before the accuracy question can be put
 * to it. Condition (3) -- "content the label is inferable from" -- was the one this corpus could
 * not meet in September, because the volume lived in machine-derived types carrying no prose. The
 * reported route now carries prose on every row, so (3) is testable rather than assumed: if a
 * stratified prompt of three examples per lens does not beat the majority-class rate on held-out
 * findings, then the labels are not inferable from the text and neither sampling arm could mean
 * anything.
 *
 * This is a GATE, not the experiment: it draws one prompt (no arm comparison) and reports
 * accuracy against the majority-class baseline.
 *
 *   node spike/asq/pilot.mjs [--examples 3] [--test 5] [--seed 20261020]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MODEL = 'deepseek-v4.1-flash:cloud';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const EXAMPLES_PER_CLASS = arg('examples', 3);
const TEST_PER_CLASS = arg('test', 5);
const SEED = arg('seed', 20261020);

const doc = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));

// Deterministic PRNG: the split has to be reproducible from the seed alone.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const rand = mulberry32(SEED);
const byClass = {};
for (const f of doc.findings) (byClass[f.class] ??= []).push(f);
const classes = Object.keys(byClass).sort();
const examples = [];
const test = [];
for (const cls of classes) {
  const pool = shuffle(byClass[cls], rand);
  examples.push(...pool.slice(0, Math.min(EXAMPLES_PER_CLASS, pool.length - 1)));
  test.push(...pool.slice(Math.min(EXAMPLES_PER_CLASS, pool.length - 1), Math.min(EXAMPLES_PER_CLASS, pool.length - 1) + TEST_PER_CLASS));
}

const block = (f) => `SUMMARY: ${f.summary}\nFAILURE: ${f.failure_scenario}`;
const prompt = [
  'You are classifying code-review findings into the review lens that produced each one.',
  'The nine lenses:',
  'assumption_audit, state_machine, boundary_conditions, data_lifecycle, error_paths,',
  'time_concurrency, environment_divergence, cross_implementation_divergence, write_read_asymmetry',
  '',
  'Here are labelled examples.',
  ...examples.map((f) => `---\nCLASS: ${f.class}\n${block(f)}`),
  '',
  `Now classify the ${test.length} findings below. Answer with ONE JSON array and nothing else,`,
  'of the form [{"id": 1, "class": "<lens>"}, ...], one object per finding, in order.',
  ...test.map((f, i) => `---\nID: ${i + 1}\n${block(f)}`),
].join('\n');

const run = spawnSync('claude', ['-p', '--bare', '--tools', '', '--model', MODEL, '--output-format', 'json'], {
  input: prompt,
  encoding: 'utf8',
  timeout: 600_000,
});

let envelope;
try {
  envelope = JSON.parse(run.stdout);
} catch {
  console.error(run.stdout.slice(0, 1000));
  console.error(run.stderr.slice(0, 1000));
  process.exit(1);
}

const text = envelope.result ?? '';
const start = text.indexOf('[');
const end = text.lastIndexOf(']');
let answers = [];
if (start !== -1 && end > start) {
  try {
    answers = JSON.parse(text.slice(start, end + 1));
  } catch {
    answers = [];
  }
}
const predicted = new Map();
for (const a of answers) {
  const id = Number(a.id ?? a.ID ?? a.index);
  if (Number.isFinite(id)) predicted.set(id, String(a.class ?? a.category ?? '').trim());
}

const confusion = {};
let correct = 0;
const perClass = {};
for (const [i, f] of test.entries()) {
  const p = predicted.get(i + 1) ?? '(none)';
  perClass[f.class] ??= { n: 0, correct: 0 };
  perClass[f.class].n += 1;
  if (p === f.class) {
    perClass[f.class].correct += 1;
    correct += 1;
  }
  confusion[`${f.class} -> ${p}`] = (confusion[`${f.class} -> ${p}`] ?? 0) + 1;
}
const counts = {};
for (const f of test) counts[f.class] = (counts[f.class] ?? 0) + 1;
const majority = Math.max(...Object.values(counts));

const report = {
  model: MODEL,
  seed: SEED,
  examples: examples.length,
  test: test.length,
  answered: predicted.size,
  accuracy: correct / test.length,
  majority_baseline: majority / test.length,
  per_class: perClass,
  confusion,
  cost_usd: envelope.total_cost_usd,
  prompt_chars: prompt.length,
};
writeFileSync(new URL('./pilot.json', import.meta.url), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));
