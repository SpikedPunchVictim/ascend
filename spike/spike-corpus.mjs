// EV-1: can a single entry type be extracted from existing transcripts at N in
// the hundreds? (asc-spike-corpus)
//
// Emits counts, date ranges and population rates. No free-text content.

import { buildCorpus } from './lib/corpus.mjs';

const t0 = performance.now();
const { totals, inserted, summary } = await buildCorpus({
  dbPath: 'spike/corpus.db',
  onProgress: (n) => process.stderr.write(`  …${n} rows\r`),
});
const ms = performance.now() - t0;

console.log(`\n--- extraction ---`);
console.log(`files streamed: ${totals.files}`);
console.log(`lines:          ${totals.lines} (malformed skipped: ${totals.malformed})`);
console.log(`rows inserted:  ${inserted}`);
console.log(`elapsed:        ${ms.toFixed(0)} ms`);

console.log(`\n--- N per candidate entry type ---`);
console.log('kind'.padEnd(20), 'N'.padStart(7), 'projects'.padStart(9), 'sessions'.padStart(9), '  date range');
for (const r of summary) {
  console.log(
    r.kind.padEnd(20),
    String(r.n).padStart(7),
    String(r.projects).padStart(9),
    String(r.sessions).padStart(9),
    `  ${String(r.first_at).slice(0, 10)} .. ${String(r.last_at).slice(0, 10)}`,
  );
}
