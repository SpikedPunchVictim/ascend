// Spike asc-gtnu.7 -- how far BACKWARD does a reviewer's finding sit from the edit it concerns?
//
// The bead's reopen condition is: "a session in which a reviewer reports on an implementer's live
// edits ... and a real reviewer's finding-to-edit distance is measured." Re-measured 2026-10-10,
// 157 review_finding rows exist across 5 sessions and 4 projects (v_review_finding_v1), so the
// first half is answered by a count. This probe answers the second half.
//
// The finding carries `file` and `occurred_at` as declared properties, so the join needs no
// regex: match `file` against the Edit/Write tool_use file_path of the SAME session's main
// stream, and measure the wall-clock distance in each direction.
//
// PREDICTIONS, written before the run:
//
//   P1  Most findings have at least one edit on a file they name (the join is resolvable).
//   P2  The nearest edit STRICTLY BEFORE the finding is closer than the nearest edit strictly
//       AFTER it -- the join is backward, as the bead's title asserts.
//   P3  The backward distance is small (seconds to minutes), not hours -- the reviewer is
//       reading a live edit, not a finished tree.
//
// If P1 holds and P2 holds, the bead's premise ("the join is BACKWARD") is confirmed on real
// reviewer data rather than on Stage 0's explorer corpus, and option 1 is the shape to build.
// If P2 fails, the forward window the reader already has is enough and nothing needs building.
//
// Read-only. Reads ~/.claude/projects and the local store; writes nothing, copies nothing.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const PROJECTS = join(homedir(), '.claude', 'projects');
const REPO = '/Users/spikedpunchvictim/projects/ascend';

/** The finding rows, straight out of the store's own generated view. */
function findings() {
  const raw = execFileSync(
    'asc',
    [
      'query',
      'SELECT session_id, project, file, occurred_at FROM v_review_finding_v1 WHERE file IS NOT NULL',
      '--json',
    ],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw).rows;
}

function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partial trailing line is not a record */
    }
  }
  return out;
}

const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Every file the main stream touched, with the edit's own timestamp. */
function edits(path) {
  const found = [];
  for (const record of readJsonl(path)) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content)
      if (block?.type === 'tool_use' && EDITORS.has(block.name)) {
        const file = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof file === 'string' && typeof record.timestamp === 'string')
          found.push({ file, ts: Date.parse(record.timestamp) });
      }
  }
  return found;
}

/*
 * A finding's `file` is repo-relative and an edit's `file_path` is absolute; matching the tail is
 * what makes them comparable. Suffix rather than basename, because two files can share a basename
 * and a wrong match would manufacture a distance out of a different file.
 */
function matches(findingFile, editFile) {
  return editFile === findingFile || editFile.endsWith(`/${findingFile}`);
}

const rows = [];
let unresolved = 0;
const sessions = new Map();
for (const finding of findings()) {
  const transcript = join(PROJECTS, finding.project, `${finding.session_id}.jsonl`);
  if (!existsSync(transcript)) {
    unresolved += 1;
    continue;
  }
  if (!sessions.has(finding.session_id)) sessions.set(finding.session_id, edits(transcript));
  const touched = sessions.get(finding.session_id).filter((edit) => matches(finding.file, edit.file));
  if (touched.length === 0) {
    unresolved += 1;
    continue;
  }
  const at = Date.parse(finding.occurred_at);
  const before = touched.filter((edit) => edit.ts <= at).map((edit) => at - edit.ts);
  const after = touched.filter((edit) => edit.ts > at).map((edit) => edit.ts - at);
  rows.push({
    session: finding.session_id,
    file: finding.file,
    beforeMs: before.length ? Math.min(...before) : null,
    afterMs: after.length ? Math.min(...after) : null,
    // The direction claim is about the NEAREST edit of any kind, not about which side has any.
    nearest: (before.length ? Math.min(...before) : Infinity) <= (after.length ? Math.min(...after) : Infinity) ? 'backward' : 'forward',
  });
}

const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const before = rows.filter((r) => r.beforeMs !== null);
const after = rows.filter((r) => r.afterMs !== null);
const backward = rows.filter((r) => r.nearest === 'backward');

console.log(`findings with a file property: ${findings().length}`);
console.log(`  transcript present, file matched: ${rows.length}`);
console.log(`  unresolved (no transcript, or no edit on that file): ${unresolved}`);
console.log();
console.log(`P1 at least one edit on a named file:        ${rows.length} (${pct(rows.length, rows.length + unresolved)} of all findings)`);
console.log(`P2 nearest edit is BEFORE the finding:       ${backward.length} of ${rows.length} (${pct(backward.length, rows.length)})`);
console.log(`   ... and a strictly-before edit exists:    ${before.length} of ${rows.length} (${pct(before.length, rows.length)})`);
console.log(`   ... and a strictly-after edit exists:     ${after.length} of ${rows.length} (${pct(after.length, rows.length)})`);
console.log();

const describe = (label, values) => {
  if (values.length === 0) return console.log(`${label}: no data`);
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(
    `${label}: min ${sorted[0]}  p50 ${at(0.5)}  p90 ${at(0.9)}  max ${sorted[sorted.length - 1]}  (ms)`,
  );
};
describe('backward gap (finding - last edit)', before.map((r) => r.beforeMs));
describe('forward gap  (first edit - finding)', after.map((r) => r.afterMs));
console.log();

console.log('per session:');
for (const session of [...new Set(rows.map((r) => r.session))].sort()) {
  const mine = rows.filter((r) => r.session === session);
  console.log(
    `  ${session.slice(0, 8)}  findings ${String(mine.length).padStart(3)}  ` +
      `backward ${String(mine.filter((r) => r.nearest === 'backward').length).padStart(3)}  ` +
      `median backward ${(() => {
        const b = mine.filter((r) => r.beforeMs !== null).map((r) => r.beforeMs).sort((x, y) => x - y);
        return b.length ? b[Math.floor(b.length / 2)] : '-';
      })()} ms`,
  );
}
