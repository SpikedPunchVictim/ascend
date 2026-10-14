/**
 * Which tests a staged set can reach.
 *
 * WHY THIS IS A TABLE AND NOT A LIST OF EXTENSIONS. `asc-09wx.14` warns that the skip rule "must be
 * strict: JSON fixtures and `package.json` can break tests," and this repo makes that warning
 * concrete twice over. A `.md`-only commit is NOT inert: `derived-types.test.ts` reads the real
 * `CLAUDE.md` off disk and asserts on its wording. Neither is a `dogfood/` or `docs/evidence/`
 * commit: `purity-enforcement.test.ts` reads both real trees and fails a record that cites a
 * source file by line number. A rule that asked "is this a source file?" would skip both.
 *
 * SO THE RULE IS DERIVED, COMPLETENESS-CHECKED, AND FAILS CLOSED.
 *
 *   - Derived: the dependents closure is read out of the `packages/<name>/package.json` files, so an
 *     edge added there is picked up without editing this file.
 *   - Completeness-checked: `TOP_LEVEL` names every entry `git ls-files` reports at the top level,
 *     and `gate-scope.test.ts` asserts the two sets are equal in both directions. A directory added
 *     later cannot silently become skippable -- it cannot be classified at all until someone writes
 *     the line, and `full` is the honest default for anything nobody has looked at.
 *   - Fail-closed: unrecognised means `full`. There is exactly one way to reach `inert`, and it is
 *     two anchored patterns with a receipt each.
 *
 * WHAT "REACHES" MEANS, AND WHY IT IS WIDER THAN THE DEPENDENCY GRAPH. The obvious closure -- a
 * package's own tests plus those of anything that depends on it -- is right and is not sufficient,
 * because four tests here read OUTSIDE their own package:
 *
 *   - `packages/cli/test/index-build-is-explicit.test.ts`, `packages/cli/test/store-names.test.ts`
 *     and `packages/store/test/writer-callers.test.ts` each walk `readdirSync` over the packages directory and
 *     assert over EVERY package's source, with no dependency edge involved. That is why a change to
 *     `packages/analysis`, which nothing depends on, still reaches `store`'s and `cli`'s tests.
 *   - `packages/core/test/purity-enforcement.test.ts` sweeps `git ls-files` over the whole
 *     repository, and `packages/cli/test/skill-drift.test.ts` runs `tsc -b` over the workspace, so a
 *     source change anywhere reaches `core` and `cli`.
 *
 * Those four are `PACKAGE_SCANNERS`, and the test re-derives the list from the corpus rather than
 * trusting the paragraph above. The consequence is honest and worth stating: a change under
 * `packages/core` or `packages/adapter-claude-code` selects every package, so there is no cut for
 * those two -- what the cut buys is that a `store`, `analysis` or `cli` change does not pay for the
 * adapter's corpus sweep.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES_DIR = join(ROOT, 'packages');
const WORKSPACE_PREFIX = '@ascend/';

/**
 * @typedef {'tests' | 'partial' | 'full'} TreeClass
 *
 * `tests`   -- per-package; the closure decides.
 * `partial` -- some paths under it are inert (`isInert` decides which) and the rest are not.
 * `full`    -- at least one test reads it, or nobody has established otherwise.
 *
 * There is deliberately no `inert` class for a whole tree. Neither record tree is wholly inert,
 * and a class with no instance is a branch nothing can reach -- a tree that really were inert
 * would be `partial` with a pattern that matches the whole of it.
 */

/**
 * What a staged set can reach.
 *
 * `packages` is what the run's record names, and `files` is what vitest is handed -- one directory
 * filter per package, which is the positional form `vitest run <filter>` matches as a substring of
 * the test file's path.
 *
 * @typedef {{ kind: 'inert', paths: readonly string[] }
 *   | { kind: 'tests', packages: readonly string[], files: readonly string[] }
 *   | { kind: 'full', why: string }} Scope
 */

/**
 * Every top-level entry the repository tracks, and what the skip rule makes of it.
 *
 * The three non-`full` entries are the whole of the rule; everything else is `full` because a test
 * reads it, or because nothing has established that one does not. Several `full` entries here are
 * surprising and are the reason this table exists rather than a suffix test -- `CLAUDE.md`,
 * `dogfood/`, `docs/`, `ARCHITECTURE.md` and `README.md` are all read by real tests.
 *
 * @type {Readonly<Record<string, TreeClass>>}
 */
export const TOP_LEVEL = {
  'packages/': 'tests',

  // The record tree and beads' export. See `isInert` for the anchored patterns and their receipts.
  '.ascend/': 'partial',
  '.beads/': 'partial',

  // Read by tests, so never skippable:
  //   CLAUDE.md    -- adapter-claude-code/test/derived-types.test.ts reads it off disk.
  //   dogfood/     -- core/test/purity-enforcement.test.ts sweeps the real tree (RECORD_PATH).
  //   docs/        -- the same sweep, over docs/evidence/.
  //   .githooks/   -- cli/test/dev-hooks.test.ts drives the real pre-commit source.
  //   .testcount/  -- cli/test/dev-hooks.test.ts and cli/test/test-baseline.test.ts read it.
  //   handlers/    -- cli/test/project-handlers.test.ts and friends read the real YAML.
  //   .agents/     -- core/test/handler-table.test.ts and two cli tests read the real skills.
  //   .claude/     -- the adapter's tests reach the real skill and settings files.
  'CLAUDE.md': 'full',
  'dogfood/': 'full',
  'docs/': 'full',
  '.githooks/': 'full',
  '.testcount/': 'full',
  'handlers/': 'full',
  '.agents/': 'full',
  '.claude/': 'full',

  // The build, the lint, the test runner and the gate's own machinery: a change here can change
  // how every test is collected, run or judged.
  'package.json': 'full',
  'pnpm-lock.yaml': 'full',
  'pnpm-workspace.yaml': 'full',
  'tsconfig.json': 'full',
  'tsconfig.base.json': 'full',
  'tsconfig.eslint.json': 'full',
  'vitest.config.ts': 'full',
  'vitest.test-count.ts': 'full',
  'vitest.failure-log.ts': 'full',
  'eslint.config.js': 'full',
  'align.config.ts': 'full',
  'scripts/': 'full',

  // Tracked, and read by the repo-wide sweeps above or by nothing anyone has checked.
  '.align/': 'full',
  '.codex/': 'full',
  '.gitignore': 'full',
  '.mcp.json': 'full',
  '.prettierignore': 'full',
  '.prettierrc.json': 'full',
  'AGENTS.md': 'full',
  'ARCHITECTURE.md': 'full',
  'IMPLEMENTATION_PLAN.md': 'full',
  'KICKOFF.md': 'full',
  LICENSE: 'full',
  'README.md': 'full',
  'TASKS.md': 'full',
  'spike/': 'full',
};

/**
 * The packages whose tests read OUTSIDE their own package, so that a change to ANY package reaches
 * them. Each is a receipt, and `gate-scope.test.ts` re-derives the list from the corpus:
 *
 *   core  -- `purity-enforcement.test.ts` sweeps `git ls-files`; `skill-drift.test.ts` runs `tsc -b`.
 *   store -- `writer-callers.test.ts` walks every `packages/<name>/src`.
 *   cli   -- `index-build-is-explicit.test.ts` and `store-names.test.ts` walk the same set.
 *
 * @type {readonly string[]}
 */
export const PACKAGE_SCANNERS = ['core', 'store', 'cli'];

/**
 * The variable the gate sets on the step it narrows, and the one value that means "not the whole
 * suite". It lives here because two files that must agree on it cannot both import each other:
 * `scripts/gate.mjs` sets it and `vitest.test-count.ts` reads it.
 *
 * WHY THE REPORTER HAS TO KNOW. `vitest.test-count.ts` rewrites `.testcount/scan.json` on every
 * run, and `scripts/test-baseline.mjs` compares that against the tracked baseline. A subset run
 * that wrote its own scan would shrink it to a few files, and the baseline check would then report
 * a breach on EVERY commit -- a false red that would be blamed on the tests rather than on the
 * skip. The seam is named in that reporter's own docblock: *"only the gate knows the run it just
 * watched was the full one."*
 *
 * ABSENT MEANS FULL, deliberately. A person typing `pnpm test` gets a scan written; only the gate,
 * which knows it narrowed the run, says otherwise.
 */
export const TEST_SCOPE_ENV = 'ASCEND_TEST_SCOPE';
export const SUBSET_SCOPE = 'subset';

/**
 * Whether the run about to be recorded is the whole suite.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function recordsWholeSuite(env) {
  return env[TEST_SCOPE_ENV] !== SUBSET_SCOPE;
}

/** `@ascend/<name>` package names that have a directory under `packages/`. */
function packageNames() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(PACKAGES_DIR, name, 'package.json')))
    .sort();
}

/**
 * Whether a parsed value is a plain object. `JSON.parse` returns `any`, and this file does not let
 * that escape: the parse lands in an `unknown`, and this is what makes it readable. The same
 * narrowing, for the same reason, as `gate-lock.mjs`.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `@ascend/x` -> `['x', ...]`. A manifest that will not parse is not this module's to report; the
 * gate's own `lint` and `typecheck` steps own that, and here an unreadable edge is simply no edge.
 *
 * @param {string} name
 * @returns {readonly string[]}
 */
function ascendDependenciesOf(name) {
  /** @type {unknown} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, name, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(manifest)) return [];
  const { dependencies } = manifest;
  if (!isRecord(dependencies)) return [];
  return Object.keys(dependencies)
    .filter((dependency) => dependency.startsWith(WORKSPACE_PREFIX))
    .map((dependency) => dependency.slice(WORKSPACE_PREFIX.length));
}

/**
 * `name -> the packages that depend on it`, read from the manifests rather than written down here,
 * so an edge added to a `package.json` is picked up without editing this file.
 *
 * @returns {Map<string, string[]>}
 */
function dependentsGraph() {
  const names = packageNames();
  const known = new Set(names);
  /** @type {Map<string, string[]>} */
  const dependents = new Map(names.map((name) => [name, []]));
  for (const name of names) {
    for (const dependency of ascendDependenciesOf(name)) {
      if (known.has(dependency)) dependents.get(dependency)?.push(name);
    }
  }
  return dependents;
}

const DEPENDENTS = dependentsGraph();
const KNOWN_PACKAGES = new Set(packageNames());

/**
 * `name`, everything that depends on it transitively, and every package whose tests read outside
 * itself. The last set is why a change to `analysis` reaches `store`.
 *
 * @param {string} name
 * @returns {readonly string[]}
 */
function reaches(name) {
  const seen = new Set([name, ...PACKAGE_SCANNERS]);
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const dependent of DEPENDENTS.get(current) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return [...seen].sort();
}

/**
 * The one way to be skippable. Two anchored patterns, each with the evidence that it is safe:
 *
 *   `.ascend/` holding a `.jsonl` -- the record tree. No test file references a repo-root `.ascend`; every
 *     `.ascend` in the corpus is a `join(dir, '.ascend', ...)` fixture under a temporary directory.
 *     `.jsonl` is also absent from `purity-enforcement.test.ts`'s SOURCE_EXTENSIONS (`ts|tsx|js|
 *     mjs|cjs|json|md|ya?ml|sql|sh|css|html`), so the repo-wide sweep does not read it either.
 *   `.beads/` at its top level, holding a `.jsonl`  -- beads' export (`.beads/interactions.jsonl` is tracked-adjacent and about
 *     half a megabyte). Anchored at the top level ON PURPOSE: `.beads/hooks/pre-commit` is the
 *     spliced GATE, and a commit that changes it must run everything.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isInert(path) {
  if (path.startsWith('.ascend/') && path.endsWith('.jsonl')) return true;
  return /^\.beads\/[^/]+\.jsonl$/u.test(path);
}

/**
 * The package a path belongs to, or `null`. A name with no directory under `packages/` is not a
 * package, so a path under it falls through to `full`.
 *
 * @param {string} path
 * @returns {string | null}
 */
function packageOf(path) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[0] !== 'packages') return null;
  const name = parts[1];
  return name !== undefined && KNOWN_PACKAGES.has(name) ? name : null;
}

/**
 * What the tests a commit needs are, given the paths it stages.
 *
 * `full` is the answer for anything unmapped, for anything staged that belongs to no package, and
 * for an empty staged set -- `git commit --amend` with nothing staged still runs the hook, and
 * "nothing staged" is not "nothing reachable".
 *
 * THE TABLE IS THE RULE, and this function reads it. `TOP_LEVEL` decides a path's class from its
 * top-level entry; `isInert` then decides within the two `partial` trees. That ordering is what
 * makes `gate-scope.test.ts`'s completeness check a guard on the RULE rather than on a comment: a
 * top-level entry nobody classified has no class, and no class is the `full` branch below.
 *
 * @param {readonly string[]} paths  repo-relative, as `git diff --cached --name-only` prints them
 * @returns {Scope}
 */
export function scopeOf(paths) {
  if (paths.length === 0) return { kind: 'full', why: 'nothing staged' };

  /** @type {string[]} */
  const inert = [];
  /** @type {string[]} */
  const packages = [];
  for (const path of paths) {
    const slash = path.indexOf('/');
    const tree = slash === -1 ? path : `${path.slice(0, slash)}/`;
    const kind = TOP_LEVEL[tree];

    if (kind === 'partial') {
      // The two record trees: their `.jsonl` is inert, everything else under them is not.
      if (isInert(path)) inert.push(path);
      else return { kind: 'full', why: path };
      continue;
    }

    if (kind !== 'tests') {
      // Either the entry is `full`, or nobody has classified it. Both run everything, which is the
      // safe direction and the reason an unmapped directory cannot silently become skippable.
      return { kind: 'full', why: path };
    }

    const name = packageOf(path);
    // `packages/<name>` where `<name>` has no manifest: a path that looks like a package and is not
    // one. Nothing can say what reaches it, so nothing is cut.
    if (name === null) return { kind: 'full', why: path };
    packages.push(name);
  }

  if (packages.length === 0) return { kind: 'inert', paths: inert };

  const selected = [...new Set(packages.flatMap((name) => reaches(name)))].sort();
  return {
    kind: 'tests',
    packages: selected,
    files: selected.map((name) => `packages/${name}/test`),
  };
}
