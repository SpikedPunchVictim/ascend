// asc-qt6r: what a pseudoreplication check would see on the live store, before any of it is built.
//
// THE QUESTIONS THIS FILE EXISTS TO ANSWER, named before it was written:
//
//   Q1. Does ANY live column actually repeat in long consecutive runs within a session? The bead's
//       anchor (6,395 `attributionSkill` lines collapsing to 87 activations) is a measurement of the
//       TRANSCRIPT CORPUS, and the adapter already collapses that run at ingest (`flushRun`,
//       derive.ts:1279; derived-types.ts:37 records the 87). So the anchor shows the mechanism is
//       real, not that the live store still contains the defect. If no live column has the structure,
//       the check has no live case to fire on and the acceptance has to be anchored differently.
//
//   Q2. Can the threshold be DERIVED rather than invented? The repo's precedent is the variance
//       gate's "a fact about the data rather than a hardcoded belief about it"
//       (packages/cli/src/stats-text.ts). For a column of `rows` observations, a random arrangement
//       of the SAME multiset has a exactly-known expected number of runs:
//
//           E[R] = 1 + (rows - 1) * (1 - sum_i p_i^2)
//
//       computed per session and summed. That is the number of runs the MARGINALS alone predict --
//       precisely the quantity the shuffled control is blind to, because it holds the marginals
//       fixed. The observed-to-expected runs ratio is therefore a threshold-free statistic: no
//       constant to pick, and it measures the one thing the existing controls cannot see.
//
//   Q3. Does the ORDER matter? `recorded_at` is when ascend INGESTED the entry; `occurred_at` is
//       when the event happened, and during a backfill of two years of transcripts the two are
//       wildly different (derived-types.ts:76-82). Runs are a property of an order, so if the two
//       orders disagree the detector must say which one it used.
//
// READ PATH: `openIndex` / `entryIds` / `findEntry`, the command's own path. Read-only.
//
// REGENERATE: node spike/qt6r-run-structure.mjs

import { join, resolve } from 'node:path';
import { INDEX_FILE, STORE_DIR, entryIds, findEntry, openIndex } from '../packages/store/dist/index.js';

const ROOT = resolve('.');
const TYPES = ['tool_denial', 'skill_activation', 'review_finding'];

function readStore(type) {
  const tree = join(ROOT, STORE_DIR);
  const store = openIndex(tree, join(tree, INDEX_FILE));
  return entryIds(store.db, type)
    .map((id) => findEntry(store.db, id))
    .filter((entry) => entry !== undefined);
}

function column(entries, name) {
  return entries.map((entry) => {
    const value = name === 'cwd' || name === 'branch' ? entry[name] : entry.properties[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}

/**
 * Runs of a column over rows already restricted to one partition.
 *
 * `null` is treated as a value here rather than dropped: "no value" repeating is still the same
 * fact repeating, and dropping it would silently shorten the run that carries the signal.
 */
function runCount(values) {
  let runs = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (i === 0 || values[i] !== values[i - 1]) runs += 1;
  }
  return runs;
}

/** Runs the marginals alone predict for one partition: E[R] = 1 + (m-1)(1 - sum p_i^2). */
function expectedRuns(values) {
  const m = values.length;
  if (m === 0) return 0;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let sumSquares = 0;
  for (const count of counts.values()) sumSquares += (count / m) ** 2;
  return 1 + (m - 1) * (1 - sumSquares);
}

const stats = (values) => ({ runs: runCount(values), expected: expectedRuns(values) });

/**
 * Every column's run structure, partitioned by session and ordered by `orderBy`.
 *
 * A run that straddles two sessions is not a run: two consecutive entries in different sessions are
 * not evidence that a value persisted, they are two sessions that happen to be adjacent in the read.
 * So the partition is the unit, and the runs are summed over partitions.
 */
function runStructure(entries, name, orderBy) {
  const sessions = column(entries, 'session_id');
  const values = column(entries, name);
  const time = column(entries, orderBy);

  const bySession = new Map();
  for (let i = 0; i < entries.length; i += 1) {
    if (sessions[i] === null || values[i] === null) continue;
    const at = bySession.get(sessions[i]) ?? [];
    at.push({ value: values[i], time: time[i] ?? '', index: i });
    bySession.set(sessions[i], at);
  }

  let rows = 0;
  let runs = 0;
  let expected = 0;
  let longest = 0;
  for (const rowsOfSession of bySession.values()) {
    rowsOfSession.sort((left, right) =>
      left.time === right.time ? left.index - right.index : left.time < right.time ? -1 : 1,
    );
    const values_ = rowsOfSession.map((row) => row.value);
    const measured = stats(values_);
    rows += values_.length;
    runs += measured.runs;
    expected += measured.expected;
    longest = Math.max(longest, longestRun(values_));
  }
  return { rows, runs, expected, longest, sessions: bySession.size };
}

function longestRun(values) {
  let best = 0;
  let current = 0;
  for (let i = 0; i < values.length; i += 1) {
    current = i > 0 && values[i] === values[i - 1] ? current + 1 : 1;
    best = Math.max(best, current);
  }
  return best;
}

const COLUMNS = ['skill', 'agent', 'project', 'cwd', 'branch', 'tool_name', 'denial_kind', 'kind'];

console.log('ratio = runs / runs-the-marginals-predict; <1 means the order carries structure');
console.log('        that the marginals do not, which is what the shuffled control cannot see.');
console.log('');

for (const type of TYPES) {
  const entries = readStore(type);
  console.log(`== ${type} (${entries.length} entries)`);
  for (const name of COLUMNS) {
    for (const orderBy of ['occurred_at', 'recorded_at']) {
      const structure = runStructure(entries, name, orderBy);
      if (structure.rows === 0) continue;
      const ratio = structure.runs / structure.expected;
      console.log(
        `${name.padEnd(12)} by ${orderBy.padEnd(12)} rows ${String(structure.rows).padStart(4)}` +
          ` sessions ${String(structure.sessions).padStart(3)}` +
          ` runs ${String(structure.runs).padStart(4)}` +
          ` E[R] ${structure.expected.toFixed(1).padStart(7)}` +
          ` ratio ${ratio.toFixed(3).padStart(6)}` +
          ` longest ${String(structure.longest).padStart(4)}`,
      );
    }
  }
  console.log('');
}
