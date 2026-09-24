// asc-6ola.13 (throwaway harness, kept with the spike it checks). Does the production runtime
// (normalizer + compileHandler + runHandler, via the strict YAML loader) reproduce the spike's
// reference rows for the 5 spike handlers, on the same frozen corpus?
//
//   node spike/handler-format/runtime-parity.mjs <frozen-corpus> <project-dir-name>
//
// Rows are compared as multisets keyed by (stream, trigger call, emitted fields). seq is not
// compared: the two normalizers emit different event sets, so their seqs differ by design.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvents } from './events.mjs';
import { handlers, runReference } from './reference.mjs';
import { createNormalizer, streamCorpus } from '../../packages/adapter-claude-code/dist/index.js';
import { runHandler } from '../../packages/core/dist/index.js';
import { loadHandler } from '../../packages/cli/dist/handler-yaml.js';

const here = dirname(fileURLToPath(import.meta.url));
const [corpus, project] = process.argv.slice(2);
const NAMES = Object.keys(handlers);

const streamOf = (file) => {
  const parts = file.split('/');
  const session = parts[1].replace(/\.jsonl$/, '');
  const agent = parts[2] === 'subagents' ? parts[3].replace(/^agent-/, '').replace(/\.jsonl$/, '') : 'main';
  return `${session}|${agent}`;
};
const sorted = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));

// Spike reference, call rule.
const files = await loadEvents(corpus, project);
const callOf = new Map(files.map((f) => [f.file, new Map(f.events.map((e) => [e.seq, e.call]))]));
const ref = runReference(files, { rule: 'calls' });

// Runtime.
const runs = Object.fromEntries(
  NAMES.map((n) => [n, runHandler(loadHandler(readFileSync(join(here, 'runtime', `${n}.yaml`), 'utf8')))]),
);
const got = Object.fromEntries(NAMES.map((n) => [n, []]));
const normalizer = createNormalizer();
const t0 = performance.now();
let events = 0;
const offer = (e) => {
  events += 1;
  for (const n of NAMES) for (const row of runs[n].accept(e)) got[n].push(row);
};
await streamCorpus((record, file) => {
  if (file.project !== project) return;
  for (const e of normalizer.accept(record, file)) offer(e);
}, { root: corpus, projects: new Set([project]) });
for (const e of normalizer.drain()) offer(e);
console.log(`runtime: ${events} events, ${(performance.now() - t0).toFixed(0)} ms, counters ${JSON.stringify(normalizer.counters)}`);

for (const n of NAMES) {
  const want = new Map();
  for (const r of ref.filter((x) => x.handler === n)) {
    const { handler, file, seq, ...fields } = r;
    const k = `${streamOf(file)}|${callOf.get(file).get(seq)}|${sorted(fields)}`;
    want.set(k, (want.get(k) ?? 0) + 1);
  }
  const extra = [];
  for (const r of got[n]) {
    const k = `${r.session_id}|${r.agent_id}|${r.call}|${sorted(r.fields)}`;
    if (want.get(k)) want.set(k, want.get(k) - 1);
    else extra.push(k);
  }
  const missing = [...want].flatMap(([k, c]) => Array(c).fill(k));
  const refCount = ref.filter((x) => x.handler === n).length;
  console.log(`${n}: reference ${refCount}, runtime ${got[n].length}, missing ${missing.length}, extra ${extra.length}, triggers ${runs[n].triggers}, unclosed ${runs[n].unclosed}`);
  for (const k of missing.slice(0, 3)) console.log(`  missing ${k}`);
  for (const k of extra.slice(0, 3)) console.log(`  extra   ${k}`);
}
