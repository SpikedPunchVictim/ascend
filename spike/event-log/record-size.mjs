/**
 * Spike asc-igg8 / (d) — how large is the largest single event the log would hold?
 *
 * (d) asks whether the log is a store type or its own file. asc-8uzh landed a per-record cap of
 * `MAX_BYTES_PER_RECORD = 1 MiB` that REFUSES rather than rolls (`jsonl-files.ts:152`), so if a single
 * normalized event can exceed 1 MiB, a store type cannot hold it without hitting a refusal -- and the
 * answer decides (d) rather than being an implementation detail of it.
 *
 * Same scope and cutoff as cost.mjs. Counts and sizes only; no payload is printed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CUTOFF = Date.parse('2026-10-03T09:08:02Z');
const DERIVE_VERSION = 11;
const STORE_CAP = 1_048_576; // MAX_BYTES_PER_RECORD, packages/store/src/jsonl-files.ts:152
const DIR = join(homedir(), '.claude', 'projects', '-Users-spikedpunchvictim-projects-ascend');

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.jsonl')) files.push(path);
  }
})(DIR);

const sizes = [];
let over = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const raw of text.split('\n')) {
    if (raw === '') continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const ts = row.timestamp ? Date.parse(row.timestamp) : undefined;
    if (ts === undefined || ts > CUTOFF) continue;
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const envelope = {
        kind: 'tool.use.start',
        session_id: row.sessionId ?? '',
        agent_id: 'main',
        seq: 0,
        call: 0,
        ts: row.timestamp,
        derive_version: DERIVE_VERSION,
        tool_name: block.name,
        input: block.input ?? {},
      };
      const n = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
      sizes.push(n);
      if (n > STORE_CAP) over += 1;
    }
  }
}

sizes.sort((a, b) => a - b);
const at = (p) => sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))];
console.log(`events            : ${sizes.length}`);
console.log(`store per-record cap: ${STORE_CAP} B (MAX_BYTES_PER_RECORD, refused not rolled)`);
console.log(`max               : ${sizes[sizes.length - 1]} B`);
console.log(`p99.9             : ${at(0.999)} B`);
console.log(`p99               : ${at(0.99)} B`);
console.log(`p50               : ${sizes[Math.floor(sizes.length / 2)]} B`);
console.log(`over the cap      : ${over} of ${sizes.length}`);
console.log(`max / cap         : ${(sizes[sizes.length - 1] / STORE_CAP).toFixed(3)}x`);
