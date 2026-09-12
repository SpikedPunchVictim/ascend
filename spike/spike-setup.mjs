// Spike harness - task 1: streaming read-only transcript access (asc-5f6).
//
// Proves the accept criterion (streams the whole corpus, memory-bounded) and
// reports the corpus's structural shape so later spike tasks can extract from
// it. Structure only -- no field values are printed.

import { streamCorpus, listTranscripts, TRANSCRIPT_ROOT } from './lib/reader.mjs';
import { collectShape, formatShape } from './lib/shape-probe.mjs';

const t0 = performance.now();

const paths = await listTranscripts(TRANSCRIPT_ROOT);
console.log(`root: ${TRANSCRIPT_ROOT}`);
console.log(`transcripts found: ${paths.length}`);

const shape = new Map();
let peakRss = 0;
let records = 0;

const totals = await streamCorpus((record) => {
  records += 1;
  collectShape(record, shape);
  if (records % 20000 === 0) {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
});

const elapsedMs = performance.now() - t0;
peakRss = Math.max(peakRss, process.memoryUsage().rss);

console.log(`\n--- stream result ---`);
console.log(`files:      ${totals.files}`);
console.log(`lines:      ${totals.lines}`);
console.log(`parsed:     ${totals.parsed}`);
console.log(`malformed:  ${totals.malformed}`);
console.log(`bytes:      ${totals.bytes} (${(totals.bytes / 1e9).toFixed(2)} GB)`);
console.log(`elapsed:    ${elapsedMs.toFixed(0)} ms`);
console.log(`throughput: ${(totals.bytes / 1e6 / (elapsedMs / 1000)).toFixed(1)} MB/s`);
console.log(`peak RSS:   ${(peakRss / 1e6).toFixed(0)} MB`);

// Fields the spike's corpus extraction depends on (named in ARCHITECTURE.md).
const WANTED = ['userFeedback', 'toolDenialKind', 'compactMetadata', 'attributionSkill'];
console.log(`\n--- target field presence (top-level occurrence counts) ---`);
for (const want of WANTED) {
  const hits = [...shape.entries()].filter(([path]) => path === want || path.endsWith(`.${want}`));
  if (hits.length === 0) {
    console.log(`${want}: NOT FOUND at any path`);
    continue;
  }
  const total = hits.reduce((a, [, v]) => a + v.count, 0);
  console.log(`${want}: ${total} occurrences across ${hits.length} path(s)`);
  for (const [path, v] of hits.slice(0, 5)) {
    const sigs = [...v.signatures.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, n]) => `${s}(${n})`)
      .join(' | ');
    console.log(`    ${path} :: ${sigs}`);
  }
}

console.log(`\n--- full shape map (paths appearing >= 200 times) ---`);
console.log(formatShape(shape, { minCount: 200, limit: 150 }));
