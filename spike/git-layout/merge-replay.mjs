#!/usr/bin/env node
/**
 * Drives the RECORD LAYER through a real `git merge`.
 *
 * `spike/git-layout/run.mjs` measured how git merges these LAYOUTS, with its own reader. The
 * package tests measure the layer's reader and writer, but they cannot reproduce a merge -- so
 * between them the two halves were each measured and the JOIN was not. That join is where the
 * design's whole risk lives, and it is where the duplicated-record defect was hiding: the layout
 * spike used fixtures whose reader never deduped, so it reported 0 lost and 0 duplicated on a tree
 * a real merge had already made two copies of a record in.
 *
 * So this script does the one thing neither does: it writes a tree WITH the layer, merges it with
 * real git, and reads it back WITH the layer.
 *
 * The fixture is the case that matters rather than a convenient one. A derived entry's id comes from
 * its content, so two clones that ingest the same transcript derive the SAME id and write the SAME
 * bytes, and NEITHER clone has that record in its base commit -- each side genuinely adds it. The
 * base matters: putting the shared record in the base makes git merge it once, which is clean and
 * proves nothing, and that is exactly how the first version of this fixture fooled itself.
 *
 * Usage: node spike/git-layout/merge-replay.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openRecordWriter,
  readRecordTree,
  writeGitattributes,
} from '../../packages/store/dist/jsonl-files.js';

const dir = mkdtempSync(join(tmpdir(), 'asc-merge-replay-'));
const root = join(dir, '.ascend');
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

function entry(n, id) {
  return {
    kind: 'entry',
    id,
    type_name: 'note',
    type_version: 1,
    type_hash: 'a'.repeat(64),
    recorded_at: `2026-09-29T12:00:${String(n).padStart(2, '0')}.000Z`,
    source: 'self',
    run_id: null,
    workflow: null,
    actor: null,
    cwd: '.',
    repo: null,
    git_sha: null,
    branch: null,
    properties: { body: `note ${String(n)}` },
    na: [],
    evidence_text: null,
    ascend_version: '0.1.0',
    schema_version: 1,
  };
}

const TYPE = {
  kind: 'type',
  document: {
    name: 'note',
    properties: [{ name: 'body', type: 'text' }],
    description: 'a note',
  },
};

// The record BOTH clones derive from the same transcript: same id, same bytes, appended on both
// sides, and in NEITHER side's base commit.
const SHARED = entry(1, 'derived:claude-code:note:key-shared');
const sideA = entry(2, 'hand:a:1');
const sideB = entry(3, 'hand:b:1');
const SHARED_ID = 'derived:claude-code:note:key-shared';

/** The entry partition this fixture writes to, read from disk rather than recomputed, so the script
 *  never holds a second copy of the segment encoding. */
const partition = () => readdirSync(join(root, 'entries'))[0];
const headFile = () => join(root, 'entries', partition(), '0001.jsonl');
const recordsIn = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');

let mergeExit = 0;
let conflicts = 0;
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'probe@example.invalid');
  git('config', 'user.name', 'asc-probe');
  writeGitattributes(root);

  // Nothing under `entries/` yet: the shared record has to be ADDED by both sides for the merge to
  // be the case under test.
  openRecordWriter(root).append(TYPE);
  git('add', '-A');
  git('commit', '-qm', 'base');

  // The ORDER around the shared record is the point, not an accident. Git's union merge emits an
  // identical line ONCE when the two sides add it as the same aligned region -- and twice when the
  // sides interleaved it with their own work differently, so there is no common region to align.
  // Two clones that ingest one transcript at different moments in their own work is the ordinary
  // case, so the unaligned shape is the one to measure.
  for (const [branch, lines] of [
    ['side-a', [SHARED, sideA]],
    ['side-b', [sideB, SHARED]],
  ]) {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', branch);
    const writer = openRecordWriter(root);
    for (const line of lines) writer.append(line);
    git('add', '-A');
    git('commit', '-qm', branch);
  }

  git('checkout', '-q', 'side-a');
  try {
    git('merge', '--no-edit', 'side-b');
  } catch (error) {
    mergeExit = 1;
    conflicts = git('status', '--porcelain')
      .split('\n')
      .filter((line) => /^(UU|AA|U|.U)/.test(line)).length;
    console.log(`merge FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  const onDisk = recordsIn(headFile());
  const read = readRecordTree(root).filter((line) => line.kind === 'entry');
  const ids = new Set(read.map((line) => line.id));

  console.log(`merge exit code:              ${String(mergeExit)}`);
  console.log(`conflicts:                    ${String(conflicts)}`);
  console.log(`raw lines after merge:        ${String(onDisk.length)}`);
  console.log(
    `SHARED copies on disk:        ${String(onDisk.filter((line) => line.includes(SHARED_ID)).length)}`,
  );
  console.log(`distinct ids the layer reads: ${String(ids.size)}`);
  console.log(`entry lines the layer reads:  ${String(read.length)}`);
  console.log(`duplicate the layer removed:  ${String(onDisk.filter((line) => line.includes('"kind":"entry"')).length - read.length)}`);
  console.log(`no record lost:               ${String(ids.size === 3)}`);
  console.log(`no record duplicated:         ${String(ids.size === read.length)}`);
  rmSync(dir, { recursive: true, force: true });
}
