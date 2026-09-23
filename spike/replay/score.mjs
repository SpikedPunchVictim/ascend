// Spike asc-bolz: score replay matches against hand-recorded ground truth.
//   node spike/replay/score.mjs <replay-out-dir>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const outDir = process.argv[2];
const matches = JSON.parse(readFileSync(join(outDir, 'matches.json'), 'utf8'));
const asc = (sql) => JSON.parse(execFileSync('node', ['packages/cli/dist/bin.js', 'query', '--json', sql], { encoding: 'utf8' })).rows;

const WINDOW_MS = 60 * 60 * 1000;
const hand = asc("SELECT recorded_at, properties_json FROM entries WHERE type_name='stage_transition' ORDER BY recorded_at")
  .map((r) => ({ at: Date.parse(r.recorded_at), ...JSON.parse(r.properties_json) }));
const auto = [...matches['stage_transition/bead-close'], ...matches['stage_transition/bead-claim']]
  .map((m) => ({ ...m, at: Date.parse(m.ts) }));

// P1: recall of hand entries
let recovered = 0, noId = 0;
const missed = [];
for (const h of hand) {
  const ids = h.stage.match(/\basc-[a-z0-9]+(\.[0-9]+)*/g) ?? [];
  if (!ids.length) { noId++; missed.push(['no bead id', h.stage]); continue; }
  const hit = auto.find((a) => ids.includes(a.stage) && Math.abs(a.at - h.at) <= WINDOW_MS);
  if (hit) recovered++;
  else {
    const anyTime = auto.filter((a) => ids.includes(a.stage)).map((a) => new Date(a.at).toISOString().slice(0, 16));
    missed.push([new Date(h.at).toISOString().slice(0, 16), h.stage.slice(0, 70), 'auto events for id at: ' + (anyTime.join(', ') || 'none')]);
  }
}
console.log(`P1 hand stage_transition recovered: ${recovered} of ${hand.length} (no bead id in stage: ${noId})`);
for (const m of missed) console.log('   missed:', ...m);

// P2: over the hand-recording period, how many transitions did the matcher see?
const lo = hand[0].at - WINDOW_MS, hi = hand.at(-1).at + WINDOW_MS;
const inPeriod = auto.filter((a) => a.at >= lo && a.at <= hi);
const distinct = new Set(inPeriod.map((a) => a.stage + '|' + a.to_status));
console.log(`P2 period ${new Date(lo).toISOString().slice(0, 16)} .. ${new Date(hi).toISOString().slice(0, 16)}: matcher events ${inPeriod.length}, distinct (bead,status) ${distinct.size}; hand ${hand.length}; ratio ${(distinct.size / hand.length).toFixed(2)}x`);
const closes = inPeriod.filter((a) => a.to_status === 'complete');
console.log(`   of which complete: ${closes.length} events, ${new Set(closes.map((a) => a.stage)).size} distinct beads; in_progress: ${inPeriod.length - closes.length}`);

// P3
console.log(`P3 plan-status edits: ${matches['stage_transition/plan-status-edit'].length} vs bead transitions: ${auto.length}`);
for (const p of matches['stage_transition/plan-status-edit']) console.log('   ', p.ts.slice(0, 16), p.from_status, '->', p.to_status);

// P4 / P5
const hsm = asc("SELECT recorded_at, properties_json FROM entries WHERE type_name='search_miss'").map((r) => JSON.parse(r.properties_json));
const cands = matches['search_miss/empty-then-found'];
const p4 = hsm.filter((h) => cands.some((c) => h.command && h.command.includes(c.pattern.split(' ').find((t) => t.length > 3) ?? '\u0000')));
console.log(`P4 hand search_miss recovered: ${p4.length} of ${hsm.length}`);
console.log(`P5 candidates (${cands.length}) for eyeballing:`);
for (const c of cands) console.log(`   ${c.ts.slice(0, 16)} [${c.search_tool}] 0 hits: ${c.pattern.slice(0, 90)}\n        then: ${c.corrected_by.slice(0, 90)}`);
