/**
 * Spike asc-igg8 / Q1 + Q4 — what the retained event-log shape costs.
 *
 * Read-only against the project's transcript directory. Scope is pinned by CUTOFF (see PREREG.md):
 * every line whose own `timestamp` is <= CUTOFF. Lines this session writes afterwards are excluded by
 * construction, which is what makes the number stable without the clone that was declined.
 *
 * Counts and byte totals only. A payload is never printed -- the same rule `secrets.ts` states for its
 * own report, and the reason shape (iii) can be measured at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { SECRET_PATTERNS } from '../../packages/cli/dist/secrets.js';

const CUTOFF = Date.parse('2026-10-03T09:08:02Z');
const DERIVE_VERSION = 11;
const DIR = join(homedir(), '.claude', 'projects', '-Users-spikedpunchvictim-projects-ascend');

/** Recursively replace secret-shaped text inside a value's strings. Only ever writes '[REDACTED]'. */
function redact(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const { pattern } of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
    return out;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v);
    return out;
  }
  return value;
}

/** `argv` cut to 4, the shape `asc-bolz`'s slim log actually kept (`replay.mjs:181-182`). */
function slim(input) {
  const out = { ...input };
  if (typeof out.command === 'string') {
    const parts = out.command.split(/\s+/);
    out.command = parts.slice(0, 4).join(' ') + (parts.length > 4 ? ' …' : '');
  }
  if (typeof out.file_path === 'string' && out.file_path.length > 80) {
    out.file_path = out.file_path.slice(0, 80) + '…';
  }
  return out;
}

/**
 * RECURSIVE, and that is load-bearing: a plain `readdirSync(DIR)` sees 9 top-level files and misses
 * the 123 subagent transcripts one level down, which is the whole scope error `dogfood/0047` records.
 * The first version of this script had it, under-counted the corpus by 4x, and every number below
 * would have been wrong while the script printed confidently.
 */
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.jsonl')) files.push(path);
  }
})(DIR);
const corpus = { files: 0, lines: 0, bytes: 0 };
const shapes = {
  'i   full tool inputs': { lines: [], inputs: 0 },
  'ii  slim (argv<=4)': { lines: [], inputs: 0 },
  'iii full, redacted': { lines: [], inputs: 0 },
};
let redactedBlocks = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  let fileUsed = false;
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
    fileUsed = true;
    corpus.lines += 1;
    corpus.bytes += Buffer.byteLength(raw, 'utf8');

    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const input = block.input ?? {};
      const envelope = {
        kind: 'tool.use.start',
        session_id: row.sessionId ?? '',
        agent_id: 'main',
        seq: 0,
        call: 0,
        ts: row.timestamp,
        derive_version: DERIVE_VERSION,
        tool_name: block.name,
      };
      const full = { ...envelope, input };
      const slimmed = { ...envelope, input: slim(input) };
      const safe = { ...envelope, input: redact(input) };

      shapes['i   full tool inputs'].lines.push(JSON.stringify(full));
      shapes['ii  slim (argv<=4)'].lines.push(JSON.stringify(slimmed));
      shapes['iii full, redacted'].lines.push(JSON.stringify(safe));
      for (const key of Object.keys(shapes)) shapes[key].inputs += 1;
      if (JSON.stringify(full) !== JSON.stringify(safe)) redactedBlocks += 1;
    }
  }
  if (fileUsed) corpus.files += 1;
}

console.log(`scope     : ts <= ${new Date(CUTOFF).toISOString()}`);
console.log(`corpus    : ${corpus.files} files, ${corpus.lines} lines, ${corpus.bytes} bytes\n`);

const measure = (lines) => {
  const raw = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
  const gz = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')).length;
  return { raw, gz };
};

console.log('shape                     inputs        raw       gz   gz/corpus');
const results = {};
for (const [name, s] of Object.entries(shapes)) {
  const { raw, gz } = measure(s.lines);
  results[name] = { raw, gz, inputs: s.inputs };
  console.log(
    `${name.padEnd(24)}${String(s.inputs).padStart(6)}${String(raw).padStart(11)}${String(gz).padStart(9)}   ${((100 * gz) / corpus.bytes).toFixed(3)}%`,
  );
}

console.log('\n--- Q4: the carried figure ---');
console.log('bead note 6 (carried):     16251    16380630  3937484   (no recoverable source)');
for (const [name, r] of Object.entries(results)) {
  console.log(
    `${name.padEnd(24)}${String(r.inputs).padStart(6)}${String(r.raw).padStart(11)}${String(r.gz).padStart(9)}   raw ${(r.raw / 16380630).toFixed(3)}x gz ${(r.gz / 3937484).toFixed(3)}x of carried`,
  );
}
console.log(`\nblocks changed by redaction: ${redactedBlocks} of ${shapes['i   full tool inputs'].inputs}`);
