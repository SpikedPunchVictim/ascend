/**
 * Gate the commits being pushed, not the directory they happen to be checked out in.
 *
 * THE DEFECT THIS REPLACES. The pre-push hook used to typecheck and test the shared checkout
 * (`asc-n0if`, `dogfood/0096`). Two measured consequences: an uncommitted edit in another session
 * blocked a push that carried none of it -- releasing it took a one-character edit to a file owned by
 * someone else -- and the row the run wrote named the checkout's `HEAD`, not the commit being pushed.
 * Under GitButler the checkout was the merge of every applied branch, so it was never any pushed
 * commit; with vanilla git it is closer, but it still holds whatever is unfinished in the working
 * tree.
 *
 * WHAT IT DOES INSTEAD. For each distinct local oid git hands the hook, it materialises the commit
 * with `git worktree add --detach`, installs (`pnpm install --offline --frozen-lockfile`), runs the
 * CHECKOUT'S OWN gate script with the worktree as its working directory, and removes the worktree
 * again. The verdict is then a fact about that commit: the row's `head` is the pushed sha, and its
 * `tree`/`work` are the commit's own tree, which is exactly what `scripts/gate-coverage.mjs` and
 * `pnpm ungated` compare against.
 *
 * THE GATE SCRIPT IS THE CHECKOUT'S, THE FILES ARE THE COMMIT'S. A pushed commit therefore cannot
 * weaken the gate that judges it, and a branch older than the gate can still be pushed. Every file
 * the steps read is the worktree's, because `scripts/gate.mjs` takes `root` from `process.cwd()`.
 *
 * MEASURED ON THIS REPOSITORY: the offline install of a fresh worktree is 11.3 s including its
 * `prepare: tsc -b`, and the full gate inside one is 3,859 collected / 3,857 passed in 164 files,
 * 420.55 s -- against 447 s for the same gate in the checkout. A push of N refs costs N of those,
 * because each tip is proven on its own content rather than once for the directory. That cost was
 * chosen deliberately over scoped runs: see `asc-n0if`.
 *
 * FAIL CLOSED, EVERYWHERE. A worktree that cannot be created, an install that fails, a gate that
 * refuses -- each blocks the push and says which. A push that could not be gated must never be
 * reported as gated, which is the same rule the gate itself applies to its own steps.
 *
 * Usage: `node scripts/push-gate.mjs [refs-file]` (git's pre-push lines; stdin if no file is given).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A deletion announces itself with the zero object id. */
const ZERO = /^0+$/;

/**
 * The lines git writes to a pre-push hook's stdin.
 *
 * `<local ref> <local oid> <remote ref> <remote oid>`. A malformed line is kept rather than dropped:
 * a line this file cannot read is a ref whose commit nobody gated, and silently skipping it is the
 * failure mode the whole module exists to refuse.
 *
 * @param {string} text
 * @returns {{ localRef: string, localOid: string, remoteRef: string, remoteOid: string }[]}
 */
export function parseRefs(text) {
  /** @type {{ localRef: string, localOid: string, remoteRef: string, remoteOid: string }[]} */
  const refs = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.trim().split(/\s+/u);
    const [localRef, localOid, remoteRef, remoteOid] = fields;
    refs.push({
      localRef: localRef ?? '',
      localOid: localOid ?? '',
      remoteRef: remoteRef ?? '',
      remoteOid: remoteOid ?? '',
    });
  }
  return refs;
}

/**
 * The commits to gate: one per distinct local oid.
 *
 * A zero oid is a ref DELETION and carries no content, so there is nothing to gate and nothing to
 * report. A ref appearing twice (two remotes, one branch) is gated once: the tree is the same tree.
 *
 * @param {readonly { localRef: string, localOid: string, remoteRef: string, remoteOid: string }[]} refs
 * @returns {{ oid: string, refs: string[] }[]}
 */
export function tipsOf(refs) {
  /** @type {Map<string, string[]>} */
  const byOid = new Map();
  for (const ref of refs) {
    if (ref.localOid === '' || ZERO.test(ref.localOid)) continue;
    const named = byOid.get(ref.localOid) ?? [];
    named.push(ref.localRef);
    byOid.set(ref.localOid, named);
  }
  return [...byOid].map(([oid, names]) => ({ oid, refs: names }));
}

/**
 * @param {string} root
 * @param {readonly string[]} args
 * @returns {string | null}
 */
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.trim();
}

/**
 * The commit an oid names. A tag is pushed by its tag object, and the commit is what a worktree can
 * be created from; an oid that is not a commit at all is refused rather than gated as something else.
 *
 * @param {string} root
 * @param {string} oid
 * @returns {string | null}
 */
export function commitOf(root, oid) {
  return git(root, ['rev-parse', '--verify', `${oid}^{commit}`]);
}

/**
 * A detached worktree holding exactly the commit's content.
 *
 * `--detach` and not a branch: the commit may already be checked out, or belong to no branch at all.
 * The path is a child of a fresh temp directory -- `git worktree add` creates the directory it is
 * given, and `mkdtempSync` creates one, so passing the temp directory itself would fail.
 *
 * @param {string} root
 * @param {string} sha
 * @returns {{ base: string, dir: string } | null}
 */
export function materialize(root, sha) {
  const base = mkdtempSync(join(tmpdir(), 'ascend-push-'));
  const dir = join(base, 'wt');
  if (git(root, ['worktree', 'add', '--detach', dir, sha]) === null) {
    rmSync(base, { recursive: true, force: true });
    return null;
  }
  return { base, dir };
}

/**
 * Removes the worktree and the temp directory around it. Reported rather than trusted: a failed
 * removal leaves a 249 MB checkout and an entry in `git worktree list`, and the next reader deserves
 * to know that happened.
 *
 * @param {string} root
 * @param {{ base: string, dir: string }} spot
 * @returns {boolean}
 */
export function tearDown(root, spot) {
  const removed = git(root, ['worktree', 'remove', '--force', spot.dir]) !== null;
  rmSync(spot.base, { recursive: true, force: true });
  if (!removed) git(root, ['worktree', 'prune']);
  return removed;
}

/**
 * The environment a child needs to gate a worktree without being pointed back at the checkout.
 *
 * `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` are deleted rather than overridden: git hands a
 * commit hook a temporary index, and any inherited git variable would make the steps read the
 * checkout's metadata while believing they read the commit's. That is the failure that would turn
 * this whole arrangement into a lie.
 *
 * @param {Record<string, string | undefined>} base
 * @param {string} root
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(base, root) {
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...base,
    ASCEND_GATE_HOOK: 'pre-push',
    ASCEND_PRECOMMIT_FULL: '1',
    // The checkout's state, unless the caller already named one -- which a test does, so a driven
    // run records into its own log instead of this repository's.
    ASCEND_GATE_STATE_ROOT: base['ASCEND_GATE_STATE_ROOT'] ?? root,
  };
  // Named rather than looped: `delete obj[key]` for a computed key is exactly how this would become
  // a list that silently stops covering a variable somebody adds later.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

/**
 * Gates one commit, and always leaves the worktree removed.
 *
 * @param {object} options
 * @param {string} options.root The checkout -- the gate script's home and the shared state's.
 * @param {string} options.sha
 * @param {Record<string, string | undefined>} options.env
 * @param {string[]} [options.steps] For a test: the commands to run instead of install and gate.
 * @returns {{ ok: boolean, why: string }}
 */
export function gateTip({ root, sha, env, steps }) {
  const spot = materialize(root, sha);
  if (spot === null) return { ok: false, why: 'a worktree of the commit could not be created' };
  try {
    const commands = steps ?? [
      ['pnpm', ['install', '--offline', '--frozen-lockfile']],
      [process.execPath, [join(root, 'scripts', 'gate.mjs')]],
    ];
    const [install, gate] = commands;
    const installed = spawnSync(install[0], install[1], {
      cwd: spot.dir,
      env,
      stdio: 'inherit',
      shell: false,
    });
    if (installed.status !== 0) {
      return { ok: false, why: "the commit's dependencies could not be installed" };
    }
    const ran = spawnSync(gate[0], gate[1], { cwd: spot.dir, env, stdio: 'inherit', shell: false });
    return ran.status === 0 ? { ok: true, why: '' } : { ok: false, why: 'the gate refused' };
  } finally {
    tearDown(root, spot);
  }
}

/**
 * @param {object} options
 * @param {string} options.root
 * @param {readonly { oid: string, refs: string[] }[]} options.tips
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {{ ok: boolean, results: { oid: string, refs: string[], ok: boolean, why: string }[] }}
 */
export function gateTips({ root, tips, env = process.env }) {
  const results = [];
  const child = childEnv(env, root);
  for (const tip of tips) {
    const sha = commitOf(root, tip.oid);
    if (sha === null) {
      results.push({ ...tip, ok: false, why: `not a commit: ${tip.oid}` });
      continue;
    }
    process.stdout.write(`[pre-push] gating ${sha.slice(0, 7)} for ${tip.refs.join(', ')}\n`);
    const verdict = gateTip({ root, sha, env: child });
    results.push({ ...tip, ok: verdict.ok, why: verdict.why });
    if (!verdict.ok) {
      process.stderr.write(`[pre-push] ${sha.slice(0, 7)} ${verdict.why}\n`);
      break;
    }
  }
  return { ok: results.every((entry) => entry.ok), results };
}

/** The text a hook was handed: a file if one was named, stdin otherwise.
 *
 * @param {readonly string[]} argv
 * @returns {string}
 */
function refText(argv) {
  const path = argv[0];
  try {
    return path === undefined ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (root === null) {
    process.stderr.write('[pre-push] this is not a git checkout; refusing to report a gate\n');
    process.exitCode = 1;
    return;
  }
  const tips = tipsOf(parseRefs(refText(argv)));
  if (tips.length === 0) {
    // A person running the hook by hand, or a push that carries only deletions: the commit in front
    // of us is the only thing there is to gate.
    const head = git(root, ['rev-parse', 'HEAD']);
    if (head !== null) tips.push({ oid: head, refs: ['HEAD'] });
  }
  if (tips.length === 0) {
    process.stdout.write('[pre-push] nothing to gate\n');
    return;
  }
  const { ok } = gateTips({ root, tips });
  if (!ok) process.exitCode = 1;
}

// The guard is what lets `scripts/push-gate.test.ts` import `parseRefs`, `tipsOf` and `materialize`
// without gating anything. Same rule as `scripts/gate.mjs`: true when node was asked to run this file.
if (import.meta.main) main();
