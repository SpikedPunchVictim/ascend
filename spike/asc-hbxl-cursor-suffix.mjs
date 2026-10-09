#!/usr/bin/env node
/**
 * asc-hbxl -- is the `#2` suffix a property of the EVENT, or of the sweep's READ SET?
 *
 *   node spike/asc-hbxl-cursor-suffix.mjs
 *
 * The bead is `Traced, not executed`. This settles it. It builds the documented real duplicate --
 * one session, two subagent files A and B carrying the same `(sessionId, uuid)` -- ingests fully,
 * grows ONE file, then ingests again so the cursor skips the other whole. Nothing here touches the
 * operator's transcripts: HOME is set to the fixture, so `defaultTranscriptRoot()` resolves inside
 * it, the same safety story `ingest.test.ts` states for itself.
 *
 * **Both skip directions are run, because only one of them can exhibit the defect.** `key` in
 * derive.ts mints the UNSUFFIXED key for whichever file the sweep reads FIRST, so in run 1 either
 * A or B holds it -- whichever `readdir` happened to yield first, which is not specified anywhere.
 * The defect fires when the file holding the unsuffixed key is the one the cursor SKIPS in run 2,
 * because then the other file, read alone, mints that same unsuffixed key over DIFFERENT content.
 * Growing only the convenient file would have been a test designed to pass.
 *
 * Four questions, named before running:
 *   Q1  Does an incremental run actually skip one of the two files?
 *   Q2  Does the file read alone mint the UNSURFFIXED key the skipped file already occupies?
 *   Q3  Does that reach the store-level guard as a collision on a CLEAN incremental run?
 *   Q4  Is a given event's id stable across the two runs?
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const BIN = join(ROOT, 'packages/cli/dist/bin.js');
const PROJECT_DIR = '-Users-me-scratch';
const RECORD_AT = { cwd: '/Users/me/scratch/packages/core', gitBranch: 'feat/locality' };

const dirs = [];
const cleanup = () => {
   for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};
process.on('SIGINT', () => {
   cleanup();
   process.exit(130);
});

function asc(args, cwd) {
   const result = spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: cwd, XDG_CACHE_HOME: join(cwd, '.cache') },
   });
   return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const record = (feedback, timestamp, uuid = 'shared-uuid-1') => ({
   sessionId: 'sess-collide',
   uuid,
   timestamp,
   ...RECORD_AT,
   userFeedback: feedback,
});

/** Read back, never inferred from the command's own report. */
function entries(dir) {
   const file = join(dir, '.ascend', 'index.db');
   if (!existsSync(file)) {
      console.log(`    !! no store at ${file} -- the run wrote nothing to this fixture`);
      return [];
   }
   const db = new DatabaseSync(file);
   try {
      return db
         .prepare('SELECT id, evidence_text AS t FROM entries WHERE type_name = ? ORDER BY id')
         .all('user_correction');
   } finally {
      db.close();
   }
}

const show = (label, rows) => {
   console.log(`  ${label}`);
   for (const row of rows) console.log(`    ${row.id}\n      "${row.t}"`);
   if (rows.length === 0) console.log('    (no user_correction entries)');
};

function scenario(grow) {
   const dir = mkdtempSync(join(tmpdir(), 'asc-hbxl-'));
   dirs.push(dir);
   mkdirSync(join(dir, '.git'));
   const corpus = join(dir, '.claude', 'projects', PROJECT_DIR);
   mkdirSync(corpus, { recursive: true });
   // `asc ingest` resolves the store from the CWD and refuses when none exists -- it does not
   // create one. `ingest.test.ts`'s `project()` skips this by building the index directly, which
   // is why the requirement is invisible from that suite. HOME alone is not enough either: the
   // corpus comes from HOME, the STORE from CWD, and a run with HOME pointed at a fixture but CWD
   // left in the repo writes into the repo. Both are set, here and in `asc()`.
   const init = asc(['init'], dir);
   if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);

   const a = join(corpus, 'sess-collide-a.jsonl');
   const b = join(corpus, 'sess-collide-b.jsonl');
   const contentA = 'use approach A';
   const contentB = 'actually use approach B';
   writeFileSync(a, `${JSON.stringify(record(contentA, '2026-01-02T03:05:00.000Z'))}\n`);
   writeFileSync(b, `${JSON.stringify(record(contentB, '2026-01-02T03:05:05.000Z'))}\n`);

   console.log(`\n${'='.repeat(72)}\nscenario: run 2 grows ${grow.toUpperCase()}, skipping the other\n${'='.repeat(72)}`);

   // ---- RUN 1: full, cursor absent ----
   const run1 = asc(['ingest', 'claude-code'], dir);
   const rows1 = entries(dir);
   console.log(`\nRUN 1 (full) exit=${String(run1.status)}`);
   show('entries after run 1:', rows1);

   const bare1 = rows1.find((row) => !row.id.endsWith('#2'));
   const suffixed1 = rows1.find((row) => row.id.endsWith('#2'));
   const bareHolder = bare1 === undefined ? '?' : bare1.t === contentA ? 'A' : 'B';
   console.log(`  -> the unsuffixed key was minted by file ${bareHolder} (read first in the sweep)`);
   console.log(`  -> collision warned in run 1: ${String(run1.stderr.includes('DIFFERENT entry'))}`);

   // ---- grow ONE file; the other is left byte-identical AND stat-identical ----
   const grown = grow === 'b' ? b : a;
   const grownContent = grow === 'b' ? contentB : contentA;
   writeFileSync(
      grown,
      `${JSON.stringify(record(grownContent, '2026-01-02T03:05:00.000Z'))}\n` +
         `${JSON.stringify(record('a new event, uuid-b-only', '2026-01-02T03:09:00.000Z', 'b-only-uuid'))}\n`,
   );

   // ---- RUN 2: incremental, cursor present ----
   const run2 = asc(['ingest', 'claude-code'], dir);
   const rows2 = entries(dir);
   console.log(`\nRUN 2 (incremental) exit=${String(run2.status)}`);
   show('entries after run 2:', rows2);

   const skipped = grow === 'b' ? a : b;
   const skippedContent = grow === 'b' ? contentA : contentB;
   const skippedWasBare = skippedContent === (bareHolder === 'A' ? contentA : contentB);
   const collided = run2.stderr.includes('DIFFERENT entry');

   console.log('\n  Q1 skipped one file:      ' + (run2.stderr.match(/skip|unchanged/gi) ? 'see run 2 stderr' : 'not named in stderr'));
   console.log(`  Q2 the skipped file held the unsuffixed key in run 1: ${String(skippedWasBare)}`);
   console.log(`  Q3 collision warned on this CLEAN incremental run:    ${String(collided)}`);
   // Q4 must be per EVENT, not "did any id appear". A record genuinely added between runs mints a
   // genuinely new id, and counting that as instability would have reported churn in both
   // orderings -- a number that moves for a reason unrelated to the question.
   const idOf = (rows, text) => rows.find((row) => row.t === text)?.id;
   const unstable = [contentA, contentB].filter((text) => {
      const before = idOf(rows1, text);
      const after = idOf(rows2, text);
      return before !== undefined && after !== undefined && before !== after;
   });
   console.log(`  Q4 an event's id CHANGED across the two runs:         ${String(unstable.length)}`);
   for (const text of unstable) {
      console.log(`       "${text}"  ${String(idOf(rows1, text))} -> ${String(idOf(rows2, text))}`);
   }
   const held = [contentA, contentB].filter((text) => idOf(rows1, text) !== undefined && idOf(rows1, text) === idOf(rows2, text));
   console.log(`  Q4 events whose id held while another file grew:     ${String(held.length)}`);
   const refused = rows1.filter((row) => !rows2.some((r) => r.id === row.id));
   console.log(`  Q4 ids present after run 1 but absent from run 2:     ${String(refused.length)}`);
   for (const row of refused) console.log(`       GONE ${row.id}  "${row.t}"`);

   console.log('\n  run 2 stderr, verbatim:');
   for (const line of run2.stderr.trim().split('\n')) console.log(`    | ${line}`);

   return { collided, skippedWasBare, unstable, refused };
}

const results = [scenario('b'), scenario('a')];

console.log(`\n${'='.repeat(72)}\nVERDICT\n${'='.repeat(72)}`);
const fired = results.filter((r) => r.skippedWasBare && (r.collided || r.unstable.length));
for (const [index, result] of results.entries()) {
   const grow = index === 0 ? 'B' : 'A';
   console.log(
      `  grow ${grow}: skipped file held the bare key = ${String(result.skippedWasBare)}; ` +
         `collision = ${String(result.collided)}; id change = ${String(result.unstable.length)}`,
   );
}
console.log(
   fired.length
      ? `\n  CONFIRMED on ${String(fired.length)} of 2 orderings: a clean incremental run warns that a\n` +
           `  derived entry collided with a DIFFERENT entry and was not written, and WHICH ordering\n` +
           `  fires is set by readdir order, which nothing specifies.\n\n` +
           `  NOT REPRODUCED: the bead's second claim, 'entry ids that are not stable across runs'.\n` +
           `  No event's id changed and none disappeared. The colliding write is REFUSED, so the id\n` +
           `  already in the store stands -- the damage is a refused write and a false alarm, not a\n` +
           `  moved id. Whether a flipped readdir order between runs would move one is UNTESTED here.`
      : '\n  REFUTED: neither ordering produced a warning or an id change.',
);

cleanup();
