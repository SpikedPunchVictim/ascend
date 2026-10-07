// asc-jpka: what `--permutations N` will cost, and what it will say, before the flag exists.
//
// WHY THIS FILE EXISTS. Three numbers the flag's design depends on, none of which can be read off
// the source: (1) the wall-clock cost of `permutationNull` at a given iteration count over the live
// store, because a control that runs while the user waits has to be sized, not guessed; (2) what p
// the control returns for the live pairs; (3) whether it actually FAILS to flag the definitional
// pair -- the acceptance requires the module to carry that limitation as a comment, and a limitation
// asserted from reasoning is worth less than one measured. `rankAssociations` never reached the
// shuffled control before this bead, so there was no command output to quote for any of the three.
//
// WHAT MAKES THESE NUMBERS THE SHIPPED NUMBERS: it reads the entries through `openIndex`, which is
// the command's own read path -- including the staleness check -- and passes the columns and the
// iteration count to `permutationNull` from the built package, so the seed is the module's own
// `DEFAULT_SEED` and the arithmetic is the code's own. Read-only over the live store.
//
// THE SHIPPED READ IS NOT THE FILE ORDER, AND THAT IS NOT COSMETIC. `permutationNull` is
// order-sensitive: Fisher-Yates walks the array it is GIVEN, so the same multiset in a different
// order draws a different set of permutations and reports a different p. The command reads
// `ORDER BY recorded_at, id`; scanning the JSONL tree gives append order. Both are printed below
// for every pair, and they differ -- which is why the first draft of this file, reading the tree,
// did not reproduce the command's own output. A published p is reproducible only from (seed, row
// order); see the same point made on `permutationNull` in `packages/analysis/src/association.ts`.
//
// The 400-iteration arm is the one that matters for reproduction: `spike/spike-patterns.mjs:86`
// produced every shuffled p in `docs/evidence/EV-patterns.md` at `{ iterations: 400, seed: 12345 }`,
// which is why that table's floor is 0.0025 = 1/401 and not the 1/5001 the record's own Confidence
// section states.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { permutationNull, chiSquare, crosstab } from '../packages/analysis/dist/association.js';
import { INDEX_FILE, STORE_DIR, entryIds, findEntry, openIndex } from '../packages/store/dist/index.js';

const ROOT = resolve('.');
const ENTRY_DIR = 'tool_denial-e3f683d51501';
const TYPE = 'tool_denial';
const ARMS = [400, 5000];

function readTree() {
  const dir = join(STORE_DIR, 'entries', ENTRY_DIR);
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

function readStore() {
  const tree = join(ROOT, STORE_DIR);
  const store = openIndex(tree, join(tree, INDEX_FILE));
  return entryIds(store.db, TYPE)
    .map((id) => findEntry(store.db, id))
    .filter((entry) => entry !== undefined);
}

/** The command's `valueColumn`: a property, or the envelope for a locality column. */
function column(entries, name) {
  return entries.map((entry) => {
    const value = name === 'cwd' || name === 'branch' ? entry[name] : entry.properties[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

const orders = [
  ['store', readStore()],
  ['tree ', readTree()],
];

// Only the pairs the live `--assoc` ranking actually forms, and only the rows it keeps: no column
// here carries a null, which is what the command's own `excluded 0` reports.
const PAIRS = [
  ['denial_kind', 'project'],
  ['denial_kind', 'tool_name'],
  ['project', 'tool_name'],
  ['project', 'branch'],
  ['project', 'cwd'],
];

const n = orders[0][1].length;
console.log(`entries ${n} (store: ${String(orders[0][1].length)}, tree: ${String(orders[1][1].length)})`);

for (const [left, right] of PAIRS) {
  console.log(`${left} x ${right}`);
  for (const [label, entries] of orders) {
    const a = column(entries, left);
    const b = column(entries, right);
    const observed = chiSquare(crosstab(a, b)).chi2;
    const parts = [];
    for (const iterations of ARMS) {
      // The 5,000 arm is timed once, on the shipped order only: the cost does not depend on the
      // order, and repeating the slowest measurement would triple this file's runtime for nothing.
      if (iterations !== ARMS[0] && label !== 'store') continue;
      const started = Date.now();
      const nul = permutationNull(a, b, { iterations });
      const elapsed = Date.now() - started;
      parts.push(
        `${String(iterations).padStart(4)}it p=${nul.pValue(observed).toFixed(6)}` +
          ` (floor ${(1 / (iterations + 1)).toFixed(6)}, ${String(elapsed).padStart(5)} ms)`,
      );
    }
    console.log(`  ${label} observed ${observed.toFixed(2)}  ${parts.join('  ')}`);
  }
}
