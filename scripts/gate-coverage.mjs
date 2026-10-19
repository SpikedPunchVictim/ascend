/**
 * What content a gate run actually judged, and which commits no run has judged.
 *
 * WHY THIS EXISTS. `but commit` does not run the pre-commit hook (`dogfood/0095`, `asc-rzhr`), so a
 * commit can be created that no gate ever saw. The run record could not answer the obvious question
 * -- "did that commit pass?" -- because it named the checkout's `HEAD`, which under a `but` commit is
 * a workspace commit unrelated to the commit that was just made, and because `staged` holds counts
 * and top-level directories rather than content. `dogfood/0095` said the consequence plainly: the
 * log "is the only place the answer exists", and it did not hold the answer.
 *
 * TWO TREES, because the gate reads two things. `format:check`, `typecheck`, `lint` and `test` read
 * the WORKING TREE; `store verify --staged` and `duplicate entry ids` read the INDEX. Recording one
 * of them and calling it "the tree" would be wrong for half the steps, and this repository has
 * already paid for that shape of mistake in `gate-memo.mjs`'s own docblock, which states the bound
 * and leaves it there because a memo is a cost device. This module is not a cost device: its job is
 * to say what a verdict was about, so it records both.
 *
 * THE COVERAGE RULE IS PER-PATH, NOT PER-TREE. A commit is covered by a run when, for every path the
 * commit changes, both recorded trees hold the commit's blob there. Whole-tree equality would report
 * every path-limited commit (`but commit ... <files>`, which is most commits in this repository)
 * uncovered even when the gate demonstrably read that content, and the workspace checkout -- which
 * holds every applied branch at once -- would make the answer unsatisfiable rather than merely
 * imprecise.
 *
 * WHAT IT DOES NOT CLAIM. If two branches change the same path, the merged worktree matches neither
 * commit, and both are reported uncovered. That is not a false positive: the gate read the merge, not
 * either commit. It is the same defect `asc-n0if` names from the push side.
 *
 * A ROW WITHOUT THESE FIELDS COVERS NOTHING. Every row written before this existed answers "unknown",
 * and unknown is reported as uncovered with the reason said out loud, never quietly as covered.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs git and hands back its raw stdout, or `null` for any unclean answer.
 *
 * Raw rather than trimmed, because the callers parse NUL-separated output where a trailing byte is
 * part of the record; the one caller that wants a single line trims it itself.
 *
 * @param {string} root
 * @param {readonly string[]} args
 * @param {Record<string, string>} [env]
 * @returns {string | null}
 */
function git(root, args, env) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

/**
 * The working tree as a tree hash -- the content the test, lint, format and typecheck steps read.
 *
 * HASHED THROUGH A TEMPORARY INDEX, not through the checkout's own. `git add -A` into `GIT_INDEX_FILE`
 * reads every file `git` would track (so `.gitignore` is honoured, and machine-local state cannot
 * make the hash move), and `git write-tree` folds that into one sha. Measured on this repository:
 * 619 ms for 898 tracked files, against a gate that costs 226-672 s.
 *
 * `null` if any step fails -- no `HEAD`, no repository, an unreadable file. The caller records the
 * null rather than guessing, because a guessed tree would answer "covered" about content nobody read.
 *
 * @param {string} root
 * @returns {string | null}
 */
export function worktreeOf(root) {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-worktree-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    // `--empty` for a checkout whose HEAD is unborn, which is every fixture and every repository's
    // first commit: there is no HEAD to read a base from, and the working tree is still hashable.
    if (
      git(root, ['read-tree', 'HEAD'], env) === null &&
      git(root, ['read-tree', '--empty'], env) === null
    ) {
      return null;
    }
    if (git(root, ['add', '-A'], env) === null) return null;
    const written = git(root, ['write-tree'], env);
    const tree = written === null ? '' : written.trim();
    return tree === '' ? null : tree;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The run record's rows, tolerantly. A torn or non-object line is skipped rather than thrown on: the
 * log is append-only and machine-local, and one bad line must not make every commit look gated or
 * make the query crash.
 *
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
export function parseRows(text) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      rows.push(value);
    }
  }
  return rows;
}

/**
 * What one commit changes: the paths and the blobs it puts there, or that it removes them.
 *
 * A DELETION CARRIES `blob: null`, because the content the commit introduces is "absent" and a tree
 * that still holds the file did not read what the commit did. A MERGE COMMIT is reported as such and
 * carries no paths: it introduces no content of its own, and asking a run to cover it would ask for
 * something that does not exist. It is counted separately by `ungated` rather than dropped.
 *
 * `null` when the commit cannot be read at all.
 *
 * @param {string} root
 * @param {string} sha
 * @returns {{ merge: boolean, paths: { path: string, blob: string | null }[] } | null}
 */
export function changedOf(root, sha) {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sha]);
  if (parents === null) return null;
  const fields = parents
    .trim()
    .split(' ')
    .filter((field) => field !== '');
  if (fields.length > 2) return { merge: true, paths: [] };

  const out = git(root, ['diff-tree', '-r', '--no-renames', '--no-commit-id', '-z', '--root', sha]);
  if (out === null) return null;

  const tokens = out.split('\0');
  const paths = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const meta = tokens[index] ?? '';
    const path = tokens[index + 1] ?? '';
    if (!meta.startsWith(':') || path === '') break;
    // `:<old-mode> <new-mode> <old-sha> <new-sha> <status>`
    const fields2 = meta.slice(1).split(' ');
    const status = fields2[4] ?? '';
    const blob = status === 'D' ? null : (fields2[3] ?? null);
    paths.push({ path, blob: blob === '' ? null : blob });
  }
  return { merge: false, paths };
}

/**
 * Every blob in one tree, by path. Cached per tree sha by `ungated` because rows share trees: a stack
 * of commits made in one sitting is usually judged by a handful of distinct trees.
 *
 * @param {string} root
 * @param {string} tree
 * @returns {Map<string, string> | null}
 */
export function treeMap(root, tree) {
  const out = git(root, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  if (out === null) return null;
  const map = new Map();
  for (const entry of out.split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    map.set(entry.slice(tab + 1), meta[2] ?? '');
  }
  return map;
}

/**
 * Whether one run covers one commit, and why not when it does not.
 *
 * The reason is the first path that disagreed, said as which of the two trees disagreed -- "differs
 * at src/a.ts" would leave a reader unable to tell a dirty checkout from a stale index.
 *
 * @param {Record<string, unknown>} row
 * @param {{ merge: boolean, paths: { path: string, blob: string | null }[] }} changed
 * @param {(tree: string) => Map<string, string> | null} mapOf
 * @returns {{ covered: boolean, why: string }}
 */
export function covers(row, changed, mapOf) {
  if (row['outcome'] !== 'ok') return { covered: false, why: 'the run did not pass' };
  const work = typeof row['work'] === 'string' ? row['work'] : null;
  const tree = typeof row['tree'] === 'string' ? row['tree'] : null;
  if (work === null && tree === null) {
    return { covered: false, why: 'the run recorded no tree (it predates the field)' };
  }
  if (work === null) {
    // A judged run (`gate-memo` answered "already passed") executes no step, so it hands the coverage
    // query no working tree on purpose: the run whose verdict it repeats carries its own.
    return { covered: false, why: 'the run judged nothing (the memo answered it)' };
  }
  if (tree === null) return { covered: false, why: 'the run recorded no index tree' };
  const workMap = mapOf(work);
  const treeMapOf = mapOf(tree);
  if (workMap === null || treeMapOf === null) {
    return { covered: false, why: 'a tree the run recorded cannot be read' };
  }
  for (const entry of changed.paths) {
    const inWork = workMap.get(entry.path) ?? null;
    if (inWork !== entry.blob) {
      return { covered: false, why: `the working tree that run read differs at ${entry.path}` };
    }
    const inIndex = treeMapOf.get(entry.path) ?? null;
    if (inIndex !== entry.blob) {
      return { covered: false, why: `the index that run read differs at ${entry.path}` };
    }
  }
  return { covered: true, why: '' };
}

/**
 * Partitions commits into covered, uncovered and not-asked, with a reason for every uncovered one.
 *
 * The reason comes from the NEWEST row: an older row's explanation is about content from before the
 * commit existed, and reporting it would send a reader to the wrong run.
 *
 * @param {readonly Record<string, unknown>[]} rows
 * @param {{ root: string, shas: readonly string[] }} options
 * @returns {{ covered: string[], uncovered: { sha: string, why: string }[], skipped: { sha: string, why: string }[] }}
 */
export function ungated(rows, { root, shas }) {
  /** @type {Map<string, Map<string, string> | null>} */
  const maps = new Map();
  /** @param {string} tree */
  const mapOf = (tree) => {
    if (!maps.has(tree)) maps.set(tree, treeMap(root, tree));
    return maps.get(tree) ?? null;
  };

  const covered = [];
  const uncovered = [];
  const skipped = [];
  for (const sha of shas) {
    const changed = changedOf(root, sha);
    if (changed === null) {
      skipped.push({ sha, why: 'the commit could not be read' });
      continue;
    }
    if (changed.merge) {
      skipped.push({ sha, why: 'a merge commit introduces no content of its own' });
      continue;
    }
    let hit = false;
    for (const row of rows) {
      if (covers(row, changed, mapOf).covered) {
        hit = true;
        break;
      }
    }
    if (hit) {
      covered.push(sha);
      continue;
    }
    const newest = rows.filter((row) => row['outcome'] === 'ok').at(-1);
    const why =
      newest === undefined
        ? 'no passing gate run is recorded on this checkout'
        : covers(newest, changed, mapOf).why;
    uncovered.push({ sha, why });
  }
  return { covered, uncovered, skipped };
}
