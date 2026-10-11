// Spike asc-gtnu.7 -- is a session's transcript `timestamp` a sound total order ACROSS streams?
//
// The question this answers was named by the bead before it was run. `asc-gtnu.7` refuses a
// cross-stream `before:` because "The event before this trigger' across two streams has no defined
// order", and its option 1 -- a total ordering key derived from `ts` with a deterministic tie-break
// -- is gated on exactly one thing: "It would still be ts-derived, so it inherits the timestamp skew
// between streams ... and a measurement of intra-session cross-stream skew is the prerequisite."
//
// PREDICTIONS, written before the run:
//
//   P1  Every subagent's first event is stamped at or after its parent `Task` spawn.
//       A violation means the two files do not share a clock, and `ts` cannot order them.
//   P2  Every parent `tool_result` for a subagent is stamped at or after that subagent's last event.
//   P3  The spawn -> first-event gap is small on the wall clock (seconds, not minutes), because the
//       subagent is a child process started by the parent rather than a stream written later.
//
// If P1 and P2 hold and P3 is tight, `ts` is a defensible cross-stream order for one session and the
// bead's option 1 is buildable. If any is violated, the refusal stands and option 1 is dead.
//
// Read-only. Reads ~/.claude/projects; writes nothing, copies nothing.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROJECTS = join(homedir(), '.claude', 'projects');

function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a partial trailing line is not a record; skip it rather than fail the run */
    }
  }
  /*
   * ORDER BY ts explicitly rather than trusting file order. The whole question is whether ts is a
   * sound order, so the file's own order cannot be the thing that decides it.
   */
  return out
    .filter((record) => typeof record.timestamp === 'string')
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
}

function blocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/** Sessions that have a `subagents/` directory beside their transcript. */
function sessionsWithSubagents() {
  const found = [];
  for (const project of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, project);
    let entries;
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const session = entry.slice(0, -'.jsonl'.length);
      const subagents = join(dir, session, 'subagents');
      if (existsSync(subagents)) found.push({ project, session, transcript: join(dir, entry), subagents });
    }
  }
  return found;
}

const rows = [];
for (const { project, session, transcript, subagents } of sessionsWithSubagents()) {
  const main = readJsonl(transcript);

  // spawn timestamp by tool_use id, for every Task/Agent call the main stream made.
  const spawn = new Map();
  for (const record of main)
    for (const block of blocks(record))
      if (block?.type === 'tool_use' && (block.name === 'Task' || block.name === 'Agent'))
        spawn.set(block.id, record.timestamp);

  /*
   * The tool_result that names an agentId binds a subagent FILE to its spawn -- but only the FIRST
   * one does. An agentId is mentioned again later (`Use SendMessage with to: 'a...'`), and a resumed
   * subagent keeps APPENDING to its own file, so taking the last mention maps a stream's last event
   * against a timestamp from days afterwards and manufactures a two-day negative gap out of a join
   * error. The result is therefore taken only where `tool_use_id` is a Task spawn this stream made,
   * and only the first such result is kept.
   */
  const result = new Map(); // agentId -> { ts, toolUseId }
  for (const record of main)
    for (const block of blocks(record))
      if (block?.type === 'tool_result' && spawn.has(block.tool_use_id)) {
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        const match = /agentId:\s*(a[0-9a-f]{16})/.exec(text);
        if (match && !result.has(match[1])) result.set(match[1], { ts: record.timestamp, toolUseId: block.tool_use_id });
      }

  for (const file of readdirSync(subagents)) {
    if (!file.endsWith('.jsonl')) continue;
    const agentId = file.slice('agent-'.length, -'.jsonl'.length);
    const stream = readJsonl(join(subagents, file));
    if (stream.length === 0) continue;
    const first = stream[0].timestamp;
    const last = stream[stream.length - 1].timestamp;
    const spawnTs = spawn.get(result.get(agentId)?.toolUseId);
    const resultTs = result.get(agentId)?.ts;
    rows.push({
      project,
      session,
      agentId,
      events: stream.length,
      startupMs: spawnTs ? Date.parse(first) - Date.parse(spawnTs) : null,
      teardownMs: resultTs ? Date.parse(resultTs) - Date.parse(last) : null,
    });
  }
}

const paired = rows.filter((row) => row.startupMs !== null);
const torn = rows.filter((row) => row.teardownMs !== null);
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

console.log(`sessions with subagents: ${new Set(rows.map((r) => r.session)).size}`);
console.log(`subagent streams:        ${rows.length}`);
console.log(`spawn-matched (P1):      ${paired.length}`);
console.log(`result-matched (P2):     ${torn.length}`);
console.log();

const startupNegative = paired.filter((r) => r.startupMs < 0);
const teardownNegative = torn.filter((r) => r.teardownMs < 0);

console.log(`P1 violated (first < spawn):      ${startupNegative.length} of ${paired.length} (${pct(startupNegative.length, paired.length)})`);
console.log(`P2 violated (result < last):      ${teardownNegative.length} of ${torn.length} (${pct(teardownNegative.length, torn.length)})`);
console.log();

const describe = (label, values) => {
  if (values.length === 0) return console.log(`${label}: no data`);
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(
    `${label}: min ${sorted[0]}  p50 ${at(0.5)}  p90 ${at(0.9)}  p99 ${at(0.99)}  max ${sorted[sorted.length - 1]}  (ms)`,
  );
};
describe('startup gap  (first - spawn) ', paired.map((r) => r.startupMs));
describe('teardown gap (result - last)', torn.map((r) => r.teardownMs));

// The worst case is the only one the ordering key has to survive: how far the two streams can
// disagree while still describing one causal pair.
const worstStartup = paired.reduce((worst, r) => (worst === null || r.startupMs < worst.startupMs ? r : worst), null);
const worstTeardown = torn.reduce((worst, r) => (worst === null || r.teardownMs < worst.teardownMs ? r : worst), null);
console.log();
if (worstStartup) console.log(`most negative startup:  ${worstStartup.startupMs} ms  (${worstStartup.agentId}, ${worstStartup.session})`);
if (worstTeardown) console.log(`most negative teardown: ${worstTeardown.teardownMs} ms  (${worstTeardown.agentId}, ${worstTeardown.session})`);

// Per-session, because a single bad session is enough to make a session-scoped key unsound.
console.log();
console.log('per session:');
for (const session of [...new Set(rows.map((r) => r.session))].sort()) {
  const mine = rows.filter((r) => r.session === session);
  const s = mine.filter((r) => r.startupMs !== null).map((r) => r.startupMs).sort((a, b) => a - b);
  const t = mine.filter((r) => r.teardownMs !== null).map((r) => r.teardownMs).sort((a, b) => a - b);
  console.log(
    `  ${session.slice(0, 8)}  streams ${String(mine.length).padStart(3)}  ` +
      `startup [${s.length ? `${s[0]} .. ${s[s.length - 1]}` : '-'}]  teardown [${t.length ? `${t[0]} .. ${t[t.length - 1]}` : '-'}]`,
  );
}
