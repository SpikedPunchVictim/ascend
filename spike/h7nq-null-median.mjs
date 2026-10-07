// asc-h7nq: the null MEDIAN the shipped block control does not print.
//
// WHY THIS FILE EXISTS. `asc stats --assoc --temporal occurred_at:weekday --blocks
// occurred_at:day` reports `p_blocked` per pair, and a p-value alone cannot say how
// far into the null an observation sits -- the same p is reachable by an
// observation just above the null's centre and by one far below it. The spike's
// published table (`docs/evidence/EV-patterns.md`) carries both columns for the
// frozen corpus, so the Amendment's live re-run needs both or the two are not
// comparable. The command deliberately does not grow a column for it;
// `spike/spike-controls.mjs` cannot produce it either, because that file is the
// INDEPENDENT reproduction and duplicates the arithmetic with its own seed
// (20261005) and its own corpus (the frozen `spike/corpus.db`).
//
// WHAT MAKES THESE NUMBERS THE SHIPPED NUMBERS: it imports `blockPermutationNull`
// from the built `packages/analysis/dist/association.js` and passes nothing but
// the columns and the iterations, so the seed is the module's own `DEFAULT_SEED`
// and the 500 iterations are the CLI's `BLOCK_ITERATIONS`. Each pair gets a fresh
// generator inside the module, so the per-pair medians are independent of the
// order this file happens to visit them in.
//
// READ-ONLY over the live `.ascend/entries/tool_denial-*/0001.jsonl`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockPermutationNull,
  chiSquare,
  crosstab,
} from '../packages/analysis/dist/association.js';

const ITERATIONS = 500;
const ENTRY_DIR = 'tool_denial-e3f683d51501';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The same `weekdayOf` the CLI runs (`packages/cli/src/commands/stats.ts`). */
function weekdayOf(timestamp) {
  const day = new Date(`${timestamp.slice(0, 10)}T00:00:00.000Z`).getUTCDay();
  return WEEKDAYS[day];
}

function dayOf(timestamp) {
  return timestamp.slice(0, 10);
}

function readEntries() {
  const dir = join('.ascend', 'entries', ENTRY_DIR);
  const entries = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      entries.push(JSON.parse(line));
    }
  }
  return entries;
}

/** A declared categorical property, read the way `stats-text.ts`'s `valueColumn` reads one. */
function propertyColumn(entries, name) {
  return entries.map((entry) => {
    const value = entry.properties[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

/** A `LOCALITY_COLUMNS` name, read off the envelope. */
function envelopeColumn(entries, name) {
  return entries.map((entry) => {
    const value = entry[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

const entries = readEntries();
const occurredAt = propertyColumn(entries, 'occurred_at');
if (occurredAt.some((value) => value === null)) throw new Error('an entry has no occurred_at');

const blocks = occurredAt.map(dayOf);
const temporal = occurredAt.map(weekdayOf);

const OTHERS = {
  project: propertyColumn(entries, 'project'),
  branch: envelopeColumn(entries, 'branch'),
  cwd: envelopeColumn(entries, 'cwd'),
  denial_kind: propertyColumn(entries, 'denial_kind'),
  tool_name: propertyColumn(entries, 'tool_name'),
};

console.log(`entries ${entries.length}  blocks ${new Set(blocks).size}  iterations ${ITERATIONS}`);

for (const [name, other] of Object.entries(OTHERS)) {
  // No column here carries a null, which is what the command's own `excluded 0` reports -- so the
  // observed statistic is the plain crosstab, with no absent level to insert.
  const observed = chiSquare(crosstab(temporal, other)).chi2;
  const null_ = blockPermutationNull(temporal, other, blocks, { iterations: ITERATIONS });
  console.log(
    `${name.padEnd(12)} observed ${observed.toFixed(2).padStart(8)}` +
      `  null median ${null_.median.toFixed(2).padStart(8)}` +
      `  p95 ${null_.p95.toFixed(2).padStart(8)}` +
      `  max ${null_.max.toFixed(2).padStart(8)}` +
      `  p_blocked ${null_.pValue(observed).toFixed(6)}`,
  );
}
