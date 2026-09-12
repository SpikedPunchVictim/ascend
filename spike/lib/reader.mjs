// Streaming, read-only access to Claude Code session transcripts.
//
// Design constraints (see TASKS.md asc-spike-setup):
//   - NEVER write to the transcript directory. This module only ever reads.
//   - Memory-bounded: 1.3 GB of JSONL must never be fully resident. We stream
//     line-by-line via readline and hand each parsed record to a visitor.
//   - Self-healing: a malformed line is counted and skipped, never fatal.
//     (align's rule: one bad line must not abort a 809-file sweep.)
//   - Emits aggregates only. No raw transcript text is ever returned to a
//     caller that prints; this keeps user content out of agent context.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const TRANSCRIPT_ROOT = join(homedir(), '.claude', 'projects');

/** Recursively collect every .jsonl transcript path under root. */
export async function listTranscripts(root = TRANSCRIPT_ROOT) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, do not abort the sweep
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(path);
      }
    }
  };
  await walk(root);
  return out.sort();
}

/**
 * Stream one transcript, invoking `visit(record, lineNumber)` per JSON line.
 * Returns counters. Never throws on malformed input.
 */
export async function streamTranscript(path, visit, signal) {
  const counters = { lines: 0, parsed: 0, malformed: 0, bytes: 0 };
  const input = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      counters.lines += 1;
      counters.bytes += line.length + 1;
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        counters.malformed += 1;
        continue;
      }
      counters.parsed += 1;
      visit(record, counters.lines);
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return counters;
}

/** Stream every transcript in the corpus sequentially (bounded memory). */
export async function streamCorpus(visit, { root = TRANSCRIPT_ROOT, signal } = {}) {
  const paths = await listTranscripts(root);
  const totals = { files: 0, lines: 0, parsed: 0, malformed: 0, bytes: 0 };
  for (const path of paths) {
    if (signal?.aborted) break;
    const c = await streamTranscript(path, (r, n) => visit(r, n, path), signal);
    totals.files += 1;
    totals.lines += c.lines;
    totals.parsed += c.parsed;
    totals.malformed += c.malformed;
    totals.bytes += c.bytes;
  }
  return totals;
}
