#!/usr/bin/env node
/**
 * asc-hbxl, part two -- can a file that APPEARS between two runs move an id, or duplicate an event?
 *
 *   node spike/asc-hbxl-suffix-newfile.mjs
 *
 * Part one (`asc-hbxl-cursor-suffix.mjs`) settled two of the bead's three questions and retired a
 * third. It is worth restating what it left open, because this file exists only for that gap:
 *
 *   - CONFIRMED  a clean incremental run warns that a derived entry collided with a DIFFERENT entry
 *                and was not written, when the cursor skips the file holding the unsuffixed key.
 *   - REFUTED    "entry ids are not stable across runs", for an UNEDITED directory: the colliding
 *                write is refused, so the id already in the store stands and nothing moves.
 *   - MEASURED   the sweep order is decided by the file NAME, not creation order. Deterministic for a
 *                given corpus. So an id can only move if the ordering CHANGES.
 *
 * A changed ordering is a rename or a newly appeared file. Both are caller actions, and the bead
 * names the newly appeared subagent transcript as the realistic one. Neither was run.
 *
 * THE MECHANISM THIS TESTS. An id is `claude-code:<type>:<raw>` and `raw` is `${sessionId}:${uuid}`,
 * with `#n` appended when the sweep has already issued that raw key for that type. So an event is
 * written under a SECOND, free id exactly when two files carry its raw key AND its own file is read
 * second. The suffix is not the damage by itself -- the damage is the second id, because a re-run
 * that mints it writes the event again instead of recognising it.
 *
 * Four probes, named before running. Each builds the same fixture, ingests fully, changes the
 * directory in ONE way, ingests again, and reads the store back -- never the command's own report.
 *
 *   N1  new file carries a copy of the holder's event, AND the holder grows
 *       -> does the holder's event end up under a second, suffixed id?
 *   N2  new file carries a copy of the holder's event, holder UNCHANGED (control)
 *       -> the holder is skipped, so nothing should move. This is the boundary N1 needs: it says
 *          whether the second id comes from the new file or from re-reading the old one.
 *   N3  new file carries a FRESH uuid, holder grows (control)
 *       -> a new file that shares no key is the ordinary case, and must stay inert.
 *   N4  the ordering flips by RENAME -- the other file is moved to sort first, and grows
 *       -> the bead's literal remaining question. Part one's Q5 says the name decides, so this
 *          changes which file holds the bare key without adding a file.
 *
 * HOME and CWD are both set to the fixture, so the operator's transcripts are never read -- the same
 * safety story part one states at its own top.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const BIN = join(ROOT, 'packages/cli/dist/bin.js');
const PROJECT_DIR = '-Users-me-scratch';
const RECORD_AT = { cwd: '/Users/me/scratch/packages/core', gitBranch: 'feat/locality' };
const SHARED_UUID = 'shared-uuid-1';

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

const record = (feedback, uuid, timestamp) => ({
  sessionId: 'sess-collide',
  uuid,
  timestamp,
  ...RECORD_AT,
  userFeedback: feedback,
});

const line = (feedback, uuid, timestamp) => `${JSON.stringify(record(feedback, uuid, timestamp))}\n`;

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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'asc-hbxl2-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  const corpus = join(dir, '.claude', 'projects', PROJECT_DIR);
  mkdirSync(corpus, { recursive: true });
  const init = asc(['init'], dir);
  if (init.status !== 0) throw new Error(`asc init failed: ${init.stderr}`);
  return { dir, corpus };
}

const show = (rows) => {
  for (const row of rows) console.log(`      ${row.id}\n        "${row.t}"`);
  if (rows.length === 0) console.log('      (no user_correction entries)');
};

/**
 * One probe: full ingest, one change, incremental ingest, read back.
 *
 * `mutate` receives the fixture's corpus directory and does the single thing this probe is about.
 * The store is read after each run so the question is answered from `entries`, not from the
 * command's report -- a run that reports success while writing nothing is the exact false green
 * this whole line of work exists to catch.
 */
function probe(label, question, mutate, withPartner = true) {
  const { dir, corpus } = fixture();
  // A holds the event this probe is about. B is a duplicate partner, present in N1-N4 so the fixture
  // reproduces the documented real duplicate (two files, one `(sessionId, uuid)`) that the suffix
  // exists for.
  //
  // N5/N6 drop B, and that is not a variant for completeness -- it is the case N1 could not reach.
  // With B present, run 1 leaves something at `#2`, so a re-derivation in run 2 has nowhere free to
  // land and the store refuses it. With A ALONE, `#2` is unoccupied, and the first probe of this file
  // was written with B in the fixture throughout: it would have reported the defect absent while the
  // mechanism sat in the one arrangement the fixture excluded. The same shape of mistake part one
  // calls out for `which file grows`, one file over.
  const a = join(corpus, 'sess-collide-a.jsonl');
  const b = join(corpus, 'sess-collide-b.jsonl');
  const CONTENT_A = 'use approach A';
  const CONTENT_B = 'actually use approach B';
  writeFileSync(a, line(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z'));
  if (withPartner) writeFileSync(b, line(CONTENT_B, SHARED_UUID, '2026-01-02T03:05:05.000Z'));

  console.log(`\n${'='.repeat(74)}\n${label}\n  ${question}\n${'='.repeat(74)}`);

  const run1 = asc(['ingest', 'claude-code'], dir);
  const rows1 = entries(dir);
  console.log(`\n  RUN 1 (full) exit=${String(run1.status)}  collision warned: ${String(run1.stderr.includes('DIFFERENT entry'))}`);
  show(rows1);
  const holder = rows1.find((row) => !row.id.endsWith('#2'));
  console.log(`  -> ${holder === undefined ? '?' : holder.t} holds the unsuffixed key`);

  mutate({ dir, corpus, a, b, line, CONTENT_A, CONTENT_B });

  const run2 = asc(['ingest', 'claude-code'], dir);
  const rows2 = entries(dir);
  const collided = run2.stderr.includes('DIFFERENT entry');
  console.log(`\n  RUN 2 (incremental) exit=${String(run2.status)}  collision warned: ${String(collided)}`);
  show(rows2);

  // The decision question, measured on CONTENT rather than on ids: an event stored twice is the
  // damage, and "an id moved" is only one of the ways that shows up.
  const copies = (text) => rows2.filter((row) => row.t === text).length;
  const added = rows2.filter((row) => !rows1.some((r) => r.id === row.id));
  const gone = rows1.filter((row) => !rows2.some((r) => r.id === row.id));
  console.log(`\n  entries after run 2 holding "${CONTENT_A}": ${String(copies(CONTENT_A))}`);
  console.log(`  entries after run 2 holding "${CONTENT_B}": ${String(copies(CONTENT_B))}`);
  console.log(`  ids added by run 2:   ${String(added.length)}`);
  console.log(`  ids gone after run 2: ${String(gone.length)}`);
  console.log(`  run 2 stderr, verbatim:`);
  for (const l of run2.stderr.trim().split('\n')) console.log(`    | ${l}`);

  return { label, copies: copies(CONTENT_A), added: added.length, collided, gone: gone.length };
}

const results = [];

results.push(
  probe(
    'N1 -- a new file copies the holder’s event, and the holder grows',
    'Does the holder’s event end up written a second time, under a suffixed id?',
    ({ corpus, a, line: mk, CONTENT_A }) => {
      // The new file sorts FIRST, so the sweep reaches it before the holder.
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z'));
      // The holder grows, so the cursor cannot skip it: a fresh event with a fresh uuid.
      writeFileSync(a, mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z') + mk('a later event', 'fresh-uuid-a', '2026-01-02T03:09:00.000Z'));
    },
  ),
);

results.push(
  probe(
    'N2 -- a new file copies the holder’s event, holder UNCHANGED (control)',
    'With the holder skipped, does the new file alone write anything?',
    ({ corpus, line: mk, CONTENT_A }) => {
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z'));
    },
  ),
);

results.push(
  probe(
    'N3 -- a new file with a FRESH uuid, holder grows (control)',
    'A new file sharing no key is the ordinary case; it must stay inert.',
    ({ corpus, a, line: mk, CONTENT_A }) => {
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk('a genuinely new event', 'fresh-uuid-0', '2026-01-02T03:09:00.000Z'));
      writeFileSync(a, mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z') + mk('a later event', 'fresh-uuid-a', '2026-01-02T03:10:00.000Z'));
    },
  ),
);

results.push(
  probe(
    'N4 -- the ordering flips by RENAME, and the renamed file grows',
    'Part one’s Q5 says the name decides; does renaming the other file to sort first move an id?',
    ({ corpus, b, line: mk, CONTENT_B }) => {
      renameSync(b, join(corpus, 'sess-collide-0.jsonl'));
      writeFileSync(
        join(corpus, 'sess-collide-0.jsonl'),
        mk(CONTENT_B, SHARED_UUID, '2026-01-02T03:05:05.000Z') + mk('a later event', 'fresh-uuid-b', '2026-01-02T03:09:00.000Z'),
      );
    },
  ),
);

results.push(
  probe(
    'N5 -- a new file copies the event, and there is NO duplicate partner',
    'With #2 unoccupied, does the re-derivation in run 2 land on a free suffixed id?',
    ({ corpus, a, line: mk, CONTENT_A }) => {
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z'));
      writeFileSync(
        a,
        mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z') + mk('a later event', 'fresh-uuid-a', '2026-01-02T03:09:00.000Z'),
      );
    },
    false,
  ),
);

results.push(
  probe(
    'N7 -- the new file shares the key with DIFFERENT content, and the holder grows',
    'The modelled real duplicate. Does the event still get a second id, and does anything warn?',
    ({ corpus, a, line: mk, CONTENT_A }) => {
      // `-0` carries the same `(sessionId, uuid)` as A's event but different text -- which is what
      // the duplicate in the live corpus looks like, and the only shape part one's fixture models.
      // N5 used a byte-identical copy, so if the two diverge here it is this probe that says which
      // shape of duplicate the defect needs.
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk('a different event, same key', SHARED_UUID, '2026-01-02T03:05:02.000Z'));
      writeFileSync(
        a,
        mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z') + mk('a later event', 'fresh-uuid-a', '2026-01-02T03:09:00.000Z'),
      );
    },
    false,
  ),
);

results.push(
  probe(
    'N6 -- a new file copies the event, no partner, holder UNCHANGED (control)',
    'The holder is skipped, so only the new file is read. It must recognise the event.',
    ({ corpus, line: mk, CONTENT_A }) => {
      writeFileSync(join(corpus, 'sess-collide-0.jsonl'), mk(CONTENT_A, SHARED_UUID, '2026-01-02T03:05:00.000Z'));
    },
    false,
  ),
);

console.log(`\n${'='.repeat(74)}\nVERDICT\n${'='.repeat(74)}`);
for (const r of results) {
  console.log(
    `  ${r.label.split(' -- ')[0]}: holder's event stored ${String(r.copies)}x; ` +
      `ids added ${String(r.added)}; ids gone ${String(r.gone)}; collision warned ${String(r.collided)}`,
  );
}
const duplicated = results.filter((r) => r.copies > 1);
console.log(
  duplicated.length
    ? `\n  A SECOND ID IS REACHABLE. ${String(duplicated.length)} of ${String(results.length)} probes\n` +
        `  wrote an event that was already in the store under a different id, so the store holds one\n` +
        `  event twice and a later run cannot recognise it. That reinstates the bead's id claim in a\n` +
        `  narrower form -- and it means any fix owes a compatibility rule for the ids already\n` +
        `  written, because the duplicate is already in the corpus of anyone who ran the ingest twice\n` +
        `  over a directory that gained a subagent transcript.`
    : `\n  NO SECOND ID IN ANY PROBE. Every event stayed under exactly the id it was first written\n` +
        `  with, in all ${String(results.length)} orderings. The defect is a refused write plus a false\n` +
        `  alarm; it is not id instability and not duplicate data, and no migration is owed for ids\n` +
        `  already written.`,
);

cleanup();
