/**
 * `asc-asq`: does a stratified sample teach a model more than a random one of the SAME size?
 *
 * The population is every finding a reviewer reported through `ReportFindings`
 * (`spike/asq/extract.mjs`, n=379). A held-out test set is fixed first and never enters the
 * sampler's store; the rest is recorded into a scratch store as `asq_item`, and each draw is taken
 * through the REAL `asc explore --sample` -- the mode under test, not a reimplementation of it.
 *
 * Arms, paired on the draw index so the only difference is the sampler:
 *   random      `--sample random --limit 20`
 *   stratified  `--sample stratified --by class --limit 20`
 * Both prompts enumerate the nine lenses and are handed the same test list in the same order; the
 * model is asked for one label per item. `score.mjs` reads `results.json`.
 *
 *   node spike/asq/harness.mjs --build                 # split + scratch store, no model calls
 *   node spike/asq/harness.mjs --dry-run --draws 3    # prompt sizes, still no model calls
 *   node spike/asq/harness.mjs --draws 10 --max-usd 25
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../recall/trees.mjs';

const BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const MODEL = 'deepseek-v4.1-flash:cloud';
const WORK = join(REPO, 'spike', 'tmp', 'asq');
const STORE = join(WORK, 'store-pool');
const SPLIT_FILE = join(WORK, 'split.json');
const RESULTS = join(WORK, 'results.json');

const LENSES = [
  'assumption_audit',
  'boundary_conditions',
  'cross_implementation_divergence',
  'data_lifecycle',
  'environment_divergence',
  'error_paths',
  'state_machine',
  'time_concurrency',
  'write_read_asymmetry',
];

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const DRAW = flag('draws', 10);
const LIMIT = Number(flag('limit', 20));
const TEST_FRACTION = Number(flag('test-fraction', 0.5));
const SEED = Number(flag('seed', 20261020));
const MAX_USD = Number(flag('max-usd', Number.NaN));
const ESTIMATE_USD = Number(flag('estimate-usd', 0.6));
const DRY = flag('dry-run', false) === true;
const BUILD_ONLY = flag('build', false) === true;

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
const text = (f) => `SUMMARY: ${f.summary}\nFAILURE: ${f.failure_scenario}`;

/** Fixed split: a per-class hold-out that always leaves at least one item in the pool. */
function buildSplit(corpus) {
  const rand = mulberry32(SEED);
  const byClass = {};
  for (const f of corpus.findings) (byClass[f.class] ??= []).push(f);
  const pool = [];
  const test = [];
  for (const cls of Object.keys(byClass).sort()) {
    const items = shuffle(byClass[cls], rand);
    // Smallest classes give one item to the test set and keep one in the pool.
    const hold = Math.max(1, Math.min(items.length - 1, Math.round(items.length * TEST_FRACTION)));
    test.push(...items.slice(0, hold));
    pool.push(...items.slice(hold));
  }
  return {
    seed: SEED,
    corpus_sha256: corpus.sha256,
    test_fraction: TEST_FRACTION,
    test,
    pool,
  };
}

function asc(cwd, args, input) {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input, timeout: 120_000 });
  if (res.status !== 0) throw new Error(`asc ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  return res.stdout;
}

function ensureStore(pool) {
  mkdirSync(WORK, { recursive: true });
  if (existsSync(join(STORE, '.ascend'))) return;
  mkdirSync(STORE, { recursive: true });
  asc(STORE, ['init', '--json']);
  const typeDoc = {
    name: 'asq_item',
    description:
      'One reviewer finding, held in a scratch store for the asc-asq sampling experiment. The ' +
      'class is the lens the reviewer reported it under; text is the finding as the reviewer wrote it.',
    properties: [
      { name: 'class', type: 'enum', required: true, enum_values: LENSES },
      { name: 'text', type: 'text', required: true },
    ],
  };
  writeFileSync(join(WORK, 'asq_item.json'), `${JSON.stringify(typeDoc, null, 1)}\n`);
  asc(STORE, ['types', 'define', join(WORK, 'asq_item.json'), '--no-capture', '--json']);
  for (const f of pool) {
    asc(STORE, ['record', 'asq_item', '-', '--json'], JSON.stringify({ properties: { class: f.class, text: text(f) } }));
  }
}

function draw(arm, seed) {
  const args = ['explore', 'asq_item', '--sample', arm, '--by', 'class', '--limit', String(LIMIT), '--seed', String(seed), '--json'];
  const out = JSON.parse(asc(STORE, args));
  return out.rows.map((row) => ({ class: row.properties.class, text: row.properties.text, id: row.id }));
}

function promptFor(examples, test) {
  return [
    'You are classifying code-review findings into the review lens that produced each one.',
    'The nine lenses:',
    LENSES.join(', '),
    '',
    'Here are labelled examples.',
    ...examples.map((e) => `---\nCLASS: ${e.class}\n${e.text}`),
    '',
    `Now classify the ${test.length} findings below. Answer with ONE JSON array and nothing else,`,
    'of the form [{"id": 1, "class": "<lens>"}, ...], one object per finding, in order, ids as given.',
    ...test.map((f, i) => `---\nID: ${i + 1}\n${text(f)}`),
  ].join('\n');
}

function callModel(prompt) {
  const res = spawnSync(
    'claude',
    ['-p', '--bare', '--tools', '', '--model', MODEL, '--output-format', 'json'],
    { input: prompt, encoding: 'utf8', timeout: 900_000 },
  );
  const envelope = JSON.parse(res.stdout);
  const raw = envelope.result ?? '';
  const predicted = parseAnswers(raw);
  return {
    predicted,
    answered: Object.keys(predicted).length,
    cost_usd: envelope.total_cost_usd ?? 0,
    usage: envelope.usage ?? null,
    result_chars: raw.length,
    raw_tail: raw.slice(-400),
  };
}

/**
 * A reply that does not parse is a failed call, not a measurement. Draws 3 and 4 of the first run
 * came back with zero answers because the reply was not the array the prompt asked for, so the
 * parser now takes the three shapes a model actually emits: the asked-for array, an object keyed
 * by id, and a bare "id label" / "id: label" list.
 */
function parseAnswers(raw) {
  const out = {};
  const take = (list) => {
    for (const a of Array.isArray(list) ? list : []) {
      const id = Number(a?.id ?? a?.ID ?? a?.index ?? a?.n);
      const cls = String(a?.class ?? a?.category ?? a?.label ?? '').trim();
      if (Number.isFinite(id) && LENSES.includes(cls)) out[id] = cls;
    }
  };
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      take(JSON.parse(raw.slice(start, end + 1)));
    } catch {
      // fall through to the other shapes
    }
  }
  if (Object.keys(out).length === 0) {
    const brace = raw.indexOf('{');
    const close = raw.lastIndexOf('}');
    if (brace !== -1 && close > brace) {
      try {
        const obj = JSON.parse(raw.slice(brace, close + 1));
        take(Object.entries(obj).map(([id, cls]) => ({ id, class: cls })));
      } catch {
        // fall through
      }
    }
  }
  if (Object.keys(out).length === 0) {
    for (const m of raw.matchAll(/(\d{1,4})\s*[:.\-=)\]]*\s*"?([a-z_]{6,})"?/g)) {
      const id = Number(m[1]);
      const cls = m[2];
      if (Number.isFinite(id) && LENSES.includes(cls) && out[id] === undefined) out[id] = cls;
    }
  }
  return out;
}

// ---- build -----------------------------------------------------------------------------------

const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
if (!existsSync(SPLIT_FILE)) {
  const split = buildSplit(corpus);
  mkdirSync(WORK, { recursive: true });
  writeFileSync(SPLIT_FILE, `${JSON.stringify(split, null, 1)}\n`);
  console.log(`split: test ${split.test.length}, pool ${split.pool.length} -> ${SPLIT_FILE}`);
}
const split = JSON.parse(readFileSync(SPLIT_FILE, 'utf8'));

const splitSha = createHash('sha256').update(JSON.stringify(split.test)).digest('hex');
console.log(`corpus ${corpus.n} (sha ${corpus.sha256.slice(0, 12)}), test ${split.test.length} (sha ${splitSha.slice(0, 12)}), pool ${split.pool.length}`);

if (DRY) {
  for (const arm of ['random', 'stratified']) {
    const n = (arm === 'random' ? LIMIT : LIMIT) * 440 + split.test.length * 440;
    console.log(`prompt(${arm}, ${LIMIT}): ~${Math.round(n / 4)} tokens`);
  }
  console.log(`would record ${split.pool.length} pool items into ${STORE}`);
  process.exit(0);
}

ensureStore(split.pool);
if (BUILD_ONLY) {
  console.log(`store built: ${split.pool.length} items in ${STORE}`);
  process.exit(0);
}

// ---- run -------------------------------------------------------------------------------------

const prior = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { pairs: [] };
const done = new Set(prior.pairs.map((p) => `${p.draw}:${p.arm}`));
let spent = prior.pairs.reduce((sum, p) => sum + (p.cost_usd ?? 0), 0);
const estimate = prior.pairs.length > 0 ? Math.max(...prior.pairs.map((p) => p.cost_usd ?? 0)) : ESTIMATE_USD;

for (let d = 1; d <= DRAW; d += 1) {
  for (const arm of ['random', 'stratified']) {
    if (done.has(`${d}:${arm}`)) continue;
    if (Number.isFinite(MAX_USD) && spent + estimate > MAX_USD) {
      console.log(`CEILING: spent $${spent.toFixed(2)}, next call projected $${estimate.toFixed(2)} > $${MAX_USD}; stopping.`);
      writeFileSync(RESULTS, `${JSON.stringify({ ...prior, spent_usd: spent }, null, 1)}\n`);
      process.exit(0);
    }
    const examples = draw(arm, SEED + d);
    const prompt = promptFor(examples, split.test);
    let r = callModel(prompt);
    spent += r.cost_usd;
    if (r.answered < split.test.length) {
      // A reply that labels fewer items than were asked for is a failed call, not a draw: an
      // unlabelled item is not an incorrect one, and counting it as wrong would score the
      // sampler on the model's truncation. Retry once, same prompt; keep the retry if it is
      // more complete.
      console.log(`  retry draw ${d} ${arm}: ${r.answered}/${split.test.length} labelled (${r.result_chars} chars)`);
      const retry = callModel(prompt);
      spent += retry.cost_usd;
      if (retry.answered > r.answered) r = retry;
    }
    prior.pairs.push({
      draw: d,
      arm,
      sample_seed: SEED + d,
      strata: examples.reduce((m, e) => ({ ...m, [e.class]: (m[e.class] ?? 0) + 1 }), {}),
      omitted: LENSES.filter((l) => !examples.some((e) => e.class === l)),
      predicted: r.predicted,
      answered: r.answered,
      cost_usd: r.cost_usd,
      usage: r.usage,
      result_chars: r.result_chars,
      raw_tail: r.raw_tail,
    });
    writeFileSync(RESULTS, `${JSON.stringify({ ...prior, spent_usd: spent }, null, 1)}\n`);
    console.log(
      `draw ${d} ${arm.padEnd(10)} omitted=${String(LENSES.length - Object.keys(prior.pairs.at(-1).strata).length)} answered=${r.answered}/${split.test.length} $${r.cost_usd.toFixed(3)} spent=$${spent.toFixed(2)}`,
    );
  }
}
console.log(`done: ${prior.pairs.length} pairs, $${spent.toFixed(2)}`);
