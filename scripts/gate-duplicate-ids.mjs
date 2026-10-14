#!/usr/bin/env node
/**
 * Refuse a commit whose `.ascend/` tree holds one entry id more than once.
 *
 * WHY THIS EXISTS. `buildIndex` (`packages/store/src/jsonl-index.ts`) refuses a tree in which one
 * entry id appears twice with different content, and every write that must rebuild the index fails
 * until the tree is hand-repaired. On 2026-10-14 such a tree was committed: two `asc ingest
 * claude-code` runs on two branch lines derived the same events, a rebase combined their appends, and
 * 70 ids were present twice, each pair differing only in `recorded_at` (`asc-jijx`, `dogfood/0098`).
 * Neither ingest could see the other's lines, so nothing refused at write time; the only place both
 * lines are in one tree for the first time is the commit that combines them.
 *
 * MIRRORED, NOT IMPORTED. The store's check lives in `onePerIdentity` (`jsonl-files.ts`), inside a
 * reader that needs the built `dist/` and the full corpus parser. The gate cannot assume a build
 * (`gate.mjs` documents a `dist/` that `tsc -b` cannot always repair), and this check needs one fact
 * per line -- `kind` and `id` -- so it reads those two fields directly. The cost of mirroring is that
 * the two can disagree, and they do in ONE deliberate place: the reader collapses byte-identical
 * lines (`merge=union` produces them routinely) and this check does not. A byte-identical pair is a
 * duplicate on disk that the index happens to tolerate; the owner asked for any id more than once, so
 * it is refused here, and the remedy is the same.
 *
 * WHAT IS CHECKED. The tree AS IT WILL BE COMMITTED -- the index, read blob by blob, the way
 * `asc store verify --staged` reads it -- not the working directory, which can be repaired after
 * staging while the commit still holds the duplicate. `--rev <rev>` reads a committed tree instead,
 * which is how this check is run against history. Only `kind: "entry"` lines are counted: an
 * annotation or a registration line may legitimately share an id with an entry. A line that is not
 * JSON is skipped, not judged: `store verify --staged` owns malformed records and names them better.
 *
 * Exit codes: 0 clean, 1 a duplicate was found, 2 the tree could not be read (nothing was compared,
 * which must not look like clean).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RECORD_DIR = '.ascend/';
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * @typedef {{ path: string, line: number }} Location
 * @typedef {{ id: string, locations: readonly Location[] }} Duplicate
 */

/**
 * Every entry id that appears on more than one line, with every place it appears, in path order and
 * then line order.
 *
 * @param {ReadonlyMap<string, string>} files `path -> text`
 * @returns {readonly Duplicate[]}
 */
export function duplicateIds(files) {
  /** @type {Map<string, Location[]>} */
  const seen = new Map();
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const id = entryId(lines[index] ?? '');
      if (id === null) continue;
      const places = seen.get(id) ?? [];
      places.push({ path, line: index + 1 });
      seen.set(id, places);
    }
  }
  return [...seen]
    .filter(([, places]) => places.length > 1)
    .map(([id, locations]) => ({ id, locations }));
}

/**
 * The id of an entry line, or `null` for anything else.
 *
 * @param {string} line
 * @returns {string | null}
 */
function entryId(line) {
  if (line === '' || !line.startsWith('{')) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { kind, id } = /** @type {{ kind?: unknown, id?: unknown }} */ (parsed);
  return kind === 'entry' && typeof id === 'string' ? id : null;
}

/**
 * @param {string} root
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/**
 * The `.jsonl` blobs named by an `ls-files -s` or `ls-tree -r` listing.
 *
 * @param {string} root
 * @param {string} listing NUL-separated `"<meta>\t<path>"` entries
 * @param {(meta: string[]) => { sha: string | undefined, merged: boolean }} parse
 * @returns {Map<string, string>}
 */
function blobs(root, listing, parse) {
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const [meta, path] = entry.split('\t');
    if (path === undefined || !path.endsWith('.jsonl')) continue;
    const { sha, merged } = parse((meta ?? '').split(' '));
    // Stages 1-3 are the sides of an unresolved conflict; a commit cannot proceed with them.
    if (!merged || sha === undefined) continue;
    files.set(path, git(root, ['cat-file', 'blob', sha]));
  }
  return files;
}

/**
 * The record files in the index (stage 0): the tree a commit would hold.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
export function readStaged(root) {
  const listing = git(root, ['ls-files', '-s', '-z', '--', RECORD_DIR]);
  return blobs(root, listing, ([, sha, stage]) => ({ sha, merged: stage === '0' }));
}

/**
 * The record files of a committed tree.
 *
 * @param {string} root
 * @param {string} rev
 * @returns {Map<string, string>}
 */
export function readTree(root, rev) {
  const listing = git(root, ['ls-tree', '-r', '-z', rev, '--', RECORD_DIR]);
  return blobs(root, listing, ([, , sha]) => ({ sha, merged: true }));
}

/**
 * The refusal, naming each id with every place it appears, and the remedy.
 *
 * @param {readonly Duplicate[]} found
 * @returns {string}
 */
export function refusal(found) {
  const lines = [
    `${String(found.length)} entry id${found.length === 1 ? '' : 's'} appear more than once in the .ascend/ tree this commit would hold:`,
  ];
  for (const { id, locations } of found) {
    lines.push(`  ${id}`);
    for (const { path, line } of locations) lines.push(`    ${path}:${String(line)}`);
  }
  lines.push(
    'One event was recorded twice (typically two ingests on two branches whose appends were combined), and `asc index build` refuses such a tree.',
    'Remedy: keep the line recorded earlier (the smaller recorded_at) for each id, delete the other line by hand, and stage the file again.',
  );
  return lines.join('\n');
}

/** @param {readonly string[]} argv */
function main(argv) {
  const at = argv.indexOf('--rev');
  const rev = at === -1 ? null : argv[at + 1];
  let files;
  try {
    if (at !== -1 && rev === undefined) throw new Error('--rev needs a revision');
    files = rev === null ? readStaged(process.cwd()) : readTree(process.cwd(), String(rev));
  } catch (error) {
    process.stderr.write(
      `duplicate ids: the tree could not be read, so nothing was compared: ${String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const found = duplicateIds(files);
  if (found.length > 0) {
    process.stderr.write(`${refusal(found)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`duplicate ids: none in ${String(files.size)} record files\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
