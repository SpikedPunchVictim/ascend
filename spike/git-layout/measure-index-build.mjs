/**
 * EV-33: re-time the REAL index build path, which EV-32 could only time through a proxy.
 *
 * EV-32 measured `asc import` and said, in its own "what this does NOT measure": *"The proxy is not
 * the real code path ... the real build path must be re-timed once it exists."* It exists now
 * (`packages/store/src/jsonl-index.ts`), so this is that measurement.
 *
 * Quarantined spike: throwaway quality is allowed and is the point. Nothing imports this file.
 *
 * Usage:
 *   node packages/cli/dist/bin.js export > /tmp/corpus-1x.jsonl
 *   node spike/git-layout/measure-index-build.mjs /tmp/corpus-1x.jsonl [--scale 10]
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  buildIndex,
  openIndex,
  openRecordWriter,
  parseCorpus,
  readRecordTree,
  serializeCorpus,
  recordFiles,
  treeFingerprint,
  INDEX_FILE,
} = await import('../../packages/store/dist/index.js');

const corpusPath = process.argv[2];
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const scale = Number(flag('--scale', 1));
const repeat = Number(flag('--repeat', 3));
/**
 * Also write the replicated corpus as ONE flat JSONL file, in `asc export`'s own order.
 *
 * This is what makes the head-to-head honest. EV-32's 40.27 s was `asc import` on a corpus built
 * from the same real store -- but on a different day, and a 2.3x gap is too large to accept or
 * reject on a number taken a day earlier on an unknown machine state. Emitting the identical bytes
 * lets both paths be timed now, back to back, from one replication rule.
 */
const emit = flag('--emit-jsonl', undefined);

/** Wall-clock seconds for one call, to the millisecond, as `/usr/bin/time -p` would report it. */
function timed(label, fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  console.log(`${label}  real ${seconds.toFixed(2)}`);
  return { value, seconds };
}

function dirBytes(dir) {
  let total = 0;
  for (const { relative } of recordFiles(dir)) total += statSync(join(dir, relative)).size;
  return total;
}

const text = readFileSync(corpusPath, 'utf8');
const parsed = parseCorpus(text, corpusPath);
const byKind = {};
for (const { line } of parsed) byKind[line.kind] = (byKind[line.kind] ?? 0) + 1;
console.log(`corpus: ${parsed.length} lines, ${(text.length / 1e6).toFixed(2)} MB`, byKind);

// ---- Lay the corpus out as a record TREE, which is what buildIndex actually consumes. ----
// Definitions once, records replicated with fresh ids when scaling -- the same shape EV-32 used, so
// the two sizes are comparable.
const root = mkdtempSync(join(tmpdir(), 'ev33-'));
const treeStart = process.hrtime.bigint();
{
  const writer = openRecordWriter(root);
  const flat = [];

  for (let copy = 0; copy < scale; copy++) {
    for (const { line } of parsed) {
      // Definitions are content-addressed, so they are emitted once, by copy 0 -- for the tree and
      // for the flat file alike. Duplicating a type would mint a second version of it.
      if (line.kind === 'type' || line.kind === 'scheme') {
        if (copy === 0) {
          writer.append(line);
          flat.push(line);
        }
        continue;
      }
      if (copy === 0) {
        writer.append(line);
        flat.push(line);
        continue;
      }
      // Distinct id per copy, and the sha256 derivation is EV-32's so the two runs are alike.
      const salt = createHash('sha256').update(`${String(copy)}:${line.id}`).digest('hex');
      const id = `${salt.slice(0, 8)}-${salt.slice(8, 12)}-7${salt.slice(13, 16)}-8${salt.slice(17, 20)}-${salt.slice(20, 32)}`;
      // Each copy moves back one day, so copies interleave in time rather than appending in a
      // block -- EV-32's shape, kept so the two measurements are comparable.
      const back = (iso) => new Date(Date.parse(iso) - copy * 86400000).toISOString();
      const shifted = { ...line, id };
      // An entry's clock is `recorded_at`; an annotation's is `created_at`, and it MUST move with
      // the copy: `created_at` is part of the pass identity, so ten copies sharing one would make
      // the second `recordAnnotations` call hit the store's own "a pass already exists at this
      // timestamp" refusal.
      if (line.kind === 'entry') shifted.recorded_at = back(line.recorded_at);
      if (line.kind === 'annotation') {
        shifted.created_at = back(line.created_at);
        const entrySalt = createHash('sha256')
          .update(`${String(copy)}:${line.entry_id}`)
          .digest('hex');
        shifted.entry_id = `${entrySalt.slice(0, 8)}-${entrySalt.slice(8, 12)}-7${entrySalt.slice(13, 16)}-8${entrySalt.slice(17, 20)}-${entrySalt.slice(20, 32)}`;
      }
      writer.append(shifted);
      flat.push(shifted);
    }
  }

  if (emit !== undefined) {
    // Through `serializeCorpus`, NOT `JSON.stringify`. A `TypeLine` is nested (`document: {...}`)
    // in memory and FLAT on the wire, and `orderedLine` is what renders the wire form. Measured
    // while writing this: raw `JSON.stringify` emits the nested shape, which `asc import` refuses
    // with "line 1 has no such field 'document'" -- a harness bug that looked exactly like a
    // product one, and would have been reported as one without the probe.
    writeFileSync(emit, `${serializeCorpus(flat)}\n`);
    console.log(`${String(flat.length)} lines -> ${emit}`);
  }
}
const treeSeconds = Number(process.hrtime.bigint() - treeStart) / 1e9;
const files = recordFiles(root);
console.log(
  `tree: ${String(files.length)} files, ${(dirBytes(root) / 1e6).toFixed(2)} MB ` +
    `(laid out in ${treeSeconds.toFixed(2)} s, not part of any number below)`,
);

const db = join(root, INDEX_FILE);
const opts = { now: '2026-09-29T00:00:00.000Z' };

// ---- The three paths EV-32 could not separate. ----
// Repeated, because a single run cannot tell a 10% difference from noise -- and EV-32's proxy was
// itself a single run. The spread is reported rather than a best-of, so the reader sees the noise.
const colds = [];
for (let i = 0; i < repeat; i++) {
  rmSync(db, { force: true });
  colds.push(timed(`cold build #${String(i + 1)} (buildIndex):`, () => buildIndex(root, db, opts)).seconds);
}
console.log(`        -> ${String(statSync(db).size)} B index`);

const prints = [];
for (let i = 0; i < repeat; i++) {
  prints.push(timed(`fingerprint #${String(i + 1)}:`, () => treeFingerprint(root)).seconds);
}

const hits = [];
for (let i = 0; i < repeat; i++) {
  hits.push(
    timed(`open, index current #${String(i + 1)}:`, () => {
      const opened = openIndex(root, db, opts);
      if (opened.rebuilt) throw new Error('expected a cache HIT, got a rebuild');
    }).seconds,
  );
}

// A rebuild through openIndex, which is the path a stale index actually takes.
rmSync(db);
const rebuilt = openIndex(root, db, opts);
if (!rebuilt.rebuilt) throw new Error('expected a REBUILD, got a hit');

// ---- Equivalence: the index built here must hold exactly what the tree says. ----
const lines = readRecordTree(root);
const store = openIndex(root, db, opts).store;
const counts = {};
for (const table of ['entry_types', 'entries', 'annotation_schemes', 'annotations']) {
  counts[table] = store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
}
const expected = {
  entry_types: byKind.type ?? 0,
  entries: byKind.entry * scale,
  annotation_schemes: byKind.scheme ?? 0,
  annotations: byKind.annotation * scale,
};
console.log('index counts:', counts);
console.log('tree  counts:', expected);
for (const table of Object.keys(expected)) {
  if (counts[table] !== expected[table]) {
    throw new Error(`${table}: index has ${counts[table]}, tree says ${expected[table]}`);
  }
}
console.log(`readRecordTree agrees: ${String(lines.length)} lines`);

const fmt = (xs) => xs.map((x) => x.toFixed(2)).join(' ');
console.log(`SUMMARY scale=${String(scale)} cold=[${fmt(colds)}] fp=[${fmt(prints)}] hit=[${fmt(hits)}]`);

rmSync(root, { recursive: true, force: true });
