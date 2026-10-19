import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_SCANNERS, TOP_LEVEL, recordsWholeSuite, scopeOf } from './gate-scope.mjs';

/**
 * Which tests a staged set can reach (`asc-09wx.14`, cuts 1 and 3).
 *
 * THE TWO CLASSES BELOW ARE PINNED AS REFUTATIONS, not as preferences. The bead's own warning --
 * "the rule must be strict: JSON fixtures and `package.json` can break tests" -- is true, and in
 * this repo it is true of two things that look obviously safe, so both get a test that would go
 * red if someone "tidied" them into the inert set:
 *
 *   - `CLAUDE.md` is read off disk by
 *     `packages/adapter-claude-code/test/derived-types.test.ts`, which asserts on its wording.
 *   - `dogfood/**` and `docs/evidence/**` are the input of
 *     `packages/core/test/purity-enforcement.test.ts`'s `RECORD_PATH` sweep.
 *
 * A hand-written allow-list of "safe file kinds" was therefore never available, which is why the
 * rule is a table plus a derived closure rather than a set of extensions.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The `packages/<name>` half of a path, or `null`. */
const pkgOf = (path: string): string | null => {
  const parts = path.split('/');
  return parts[0] === 'packages' && parts.length > 2 ? (parts[1] ?? null) : null;
};

/** Every tracked top-level entry, as `git ls-files` names it (directories keep their slash). */
function trackedTopLevel(): string[] {
  const result = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const entries = result
    .split('\0')
    .filter((path) => path !== '')
    .map((path) => (path.includes('/') ? `${path.slice(0, path.indexOf('/'))}/` : path));
  return [...new Set(entries)].sort();
}

describe('the inert class', () => {
  it('treats a record-tree jsonl as inert, in both record trees', () => {
    // The evidence for this, as a receipt rather than an impression: no test file references a
    // repo-root `.ascend` (every `.ascend` in the corpus is a `join(dir, '.ascend', ...)` fixture
    // under a temp directory), and `.jsonl` is not one of `purity-enforcement.test.ts`'s
    // SOURCE_EXTENSIONS, so the repo-wide sweep does not read it either.
    for (const path of [
      '.ascend/entries/note-1a2b/0001.jsonl',
      '.ascend/annotations/hand-denial-1a2b/0001.jsonl',
      '.beads/interactions.jsonl',
    ]) {
      expect(scopeOf([path]), path).toEqual({ kind: 'inert', paths: [path] });
    }
  });

  it('does not treat the installed hook as inert, though it lives in .beads', () => {
    // `.beads/hooks/pre-commit` is the SPLICED GATE. A commit that changes it is a commit that
    // changes the thing under test, so it runs everything -- the `*.jsonl` rule is anchored at the
    // top level of `.beads/` for exactly this reason.
    expect(scopeOf(['.beads/hooks/pre-commit']).kind).toBe('full');
    expect(scopeOf(['.beads/config.yaml']).kind).toBe('full');
  });

  it('does not treat .ascend/.gitattributes as inert', () => {
    expect(scopeOf(['.ascend/.gitattributes']).kind).toBe('full');
  });

  it('does not treat a dogfood record as inert (purity-enforcement reads the real tree)', () => {
    expect(scopeOf(['dogfood/0089-2026-10-13-a-verdict.md']).kind).toBe('full');
  });

  it('does not treat an evidence record as inert (same sweep)', () => {
    expect(scopeOf(['docs/evidence/EV-64.md']).kind).toBe('full');
  });

  it('does not treat CLAUDE.md as inert (derived-types reads it off disk)', () => {
    expect(scopeOf(['CLAUDE.md']).kind).toBe('full');
  });
});

describe('the tests class', () => {
  it('selects a core change to every package, because every package can reach it', () => {
    // `core` is depended on by `store`, `adapter-claude-code` and `cli`, so its closure is
    // everything -- and the plan predicted exactly this set.
    const scope = scopeOf(['packages/core/src/cursor.ts']);
    expect(scope.kind).toBe('tests');
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual([
      'adapter-claude-code',
      'cli',
      'core',
      'store',
    ]);
  });

  it('selects a cli change to core, store and cli -- but not adapter', () => {
    const scope = scopeOf(['packages/cli/src/streams.ts']);
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual(['cli', 'core', 'store']);
  });

  it('selects a store change to core, store and cli -- but not adapter', () => {
    const scope = scopeOf(['packages/store/src/pages.ts']);
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual(['cli', 'core', 'store']);
  });

  it('selects an adapter change to every package', () => {
    const scope = scopeOf(['packages/adapter-claude-code/src/derived-types.ts']);
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual([
      'adapter-claude-code',
      'cli',
      'core',
      'store',
    ]);
  });

  it('selects an analysis change to analysis and the three packages that read every package', () => {
    // NOT just `analysis` + `cli`, which is what the plan's prose predicted. `store` and `cli`
    // each hold tests that read EVERY `packages/*/src`, so an analysis source change is reachable
    // from them without any dependency edge -- see PACKAGE_SCANNERS, and the test below that
    // re-derives that list from the corpus rather than trusting it.
    const scope = scopeOf(['packages/analysis/src/rules.ts']);
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual([
      'analysis',
      'cli',
      'core',
      'store',
    ]);
  });

  it('hands vitest one directory filter per selected package, and nothing else', () => {
    const scope = scopeOf(['packages/cli/src/streams.ts']);
    expect(scope.kind === 'tests' ? scope.files : []).toEqual([
      'packages/cli/test',
      'packages/core/test',
      'packages/store/test',
    ]);
  });

  it('lets a package change win over an inert one in the same commit', () => {
    const scope = scopeOf(['.ascend/entries/note-1a2b/0001.jsonl', 'packages/store/src/pages.ts']);
    expect(scope.kind).toBe('tests');
  });

  it('runs a package change staged inside a test file too', () => {
    const scope = scopeOf(['packages/store/test/pages.test.ts']);
    expect(scope.kind === 'tests' ? scope.packages : []).toEqual(['cli', 'core', 'store']);
  });
});

describe('everything else fails closed', () => {
  it('runs everything for a root manifest, which can change any package', () => {
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      expect(scopeOf([path]).kind, path).toBe('full');
    }
  });

  it('runs everything for the build and test configuration', () => {
    for (const path of [
      'tsconfig.json',
      'tsconfig.base.json',
      'vitest.config.ts',
      'eslint.config.js',
      'align.config.ts',
    ]) {
      expect(scopeOf([path]).kind, path).toBe('full');
    }
  });

  it("runs everything for the gate's own machinery", () => {
    for (const path of [
      'scripts/gate.mjs',
      'scripts/gate-scope.mjs',
      '.githooks/pre-commit',
      'handlers/review-finding-nudge.yaml',
    ]) {
      expect(scopeOf([path]).kind, path).toBe('full');
    }
  });

  it('runs everything for a top-level tree it has never seen', () => {
    // The default is `full`, so an unmapped path is never the skippable direction. This is also
    // what makes the completeness check a guard on the RULE rather than on a comment: `scopeOf`
    // reads `TOP_LEVEL`, so an entry nobody classified lands here.
    expect(scopeOf(['vendor/thing.ts']).kind).toBe('full');
    expect(scopeOf(['.brand-new-dir/x.jsonl']).kind).toBe('full');
  });

  it('runs everything for a path under packages/ that names no package', () => {
    // The table says `packages/` is `tests`, and then the package has to exist: the closure is
    // built from the manifests, so a directory with no manifest has no edges and nothing can say
    // what reaches it. Two shapes, both `full`: a half-created package, and a path too shallow to
    // name one.
    expect(scopeOf(['packages/not-a-package/src/x.ts']).kind).toBe('full');
    expect(scopeOf(['packages/core']).kind).toBe('full');
  });

  it('runs everything for an empty staged set', () => {
    // `git commit --amend` with nothing staged still runs the hook. Nothing staged is not the
    // same as nothing reachable.
    expect(scopeOf([]).kind).toBe('full');
  });
});

describe('PACKAGE_SCANNERS is derived, not asserted from memory', () => {
  it('names only packages that exist', () => {
    for (const name of PACKAGE_SCANNERS) {
      const manifest = join(ROOT, 'packages', name, 'package.json');
      expect(JSON.parse(readFileSync(manifest, 'utf8')), name).toBeTruthy();
    }
  });

  it("holds the packages whose tests read every package's source", () => {
    // The four receipts. Two of these are the reason `PACKAGE_SCANNERS` exists at all: each reads
    // `packages/*/src` for EVERY package, so a change to any package reaches them even when no
    // dependency edge runs that way. The other two are whole-repo: `purity-enforcement.test.ts`
    // sweeps `git ls-files`, and `skill-drift.test.ts` runs `tsc -b` over the workspace.
    const receipts: ReadonlyArray<readonly [string, RegExp]> = [
      ['packages/cli/test/index-build-is-explicit.test.ts', /readdirSync\(PACKAGES\b/u],
      ['packages/cli/test/store-names.test.ts', /readdirSync\(PACKAGES\b/u],
      ['packages/store/test/writer-callers.test.ts', /readdirSync\(PACKAGES\b/u],
      ['packages/core/test/purity-enforcement.test.ts', /'ls-files'/u],
    ];

    for (const [file, pattern] of receipts) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(pattern);
    }

    // Every package that a receipt lives in must be in the scanning set, or the closure above
    // would omit it. This is the half that goes red when a scanner moves to a new package.
    const fromReceipts = [...new Set(receipts.map(([file]) => pkgOf(file)))].filter(
      (name): name is string => name !== null,
    );
    for (const name of fromReceipts) expect(PACKAGE_SCANNERS, name).toContain(name);
  });
});

describe('the reporter contract', () => {
  it('records only a run that SAYS it collected the suite (`asc-19x2`)', () => {
    expect(recordsWholeSuite({ ASCEND_TEST_SCOPE: 'full' })).toBe(true);
    // Silence is not the word. `pnpm vitest run <one file>` sets nothing either, and it is not the
    // suite -- measured 2026-10-13 as a 1-file scan the baseline check read as 3,026 below the floor.
    expect(recordsWholeSuite({})).toBe(false);
    expect(recordsWholeSuite({ PATH: '/usr/bin' })).toBe(false);
    expect(recordsWholeSuite({ ASCEND_TEST_SCOPE: '' })).toBe(false);
  });

  it('does not record a narrowed run, which cannot speak for the suite', () => {
    expect(recordsWholeSuite({ ASCEND_TEST_SCOPE: 'subset' })).toBe(false);
  });

  it('compares against any other value rather than testing for a suffix', () => {
    // `subsetted`, `subset-of-one` and `SUBSET` are not the gate's word. The check is an equality
    // on the whole value, the same shape `isSet` uses for `ASCEND_PRECOMMIT_FULL`.
    for (const value of ['subsetted', 'SUBSET', 'Subset', ' subset ', 'FULL']) {
      expect(recordsWholeSuite({ ASCEND_TEST_SCOPE: value }), value).toBe(false);
    }
  });
});

describe('completeness', () => {
  it('classifies every top-level entry the repository tracks', () => {
    // The invariant, in the repo's own "every referenced name must resolve" shape: a directory
    // added later cannot silently become skippable, because it cannot be classified at all until
    // someone writes the entry. `full` is a legitimate classification -- most of this table is
    // `full` -- but it has to be a decision.
    const tracked = trackedTopLevel();
    const missing = tracked.filter((entry) => !(entry in TOP_LEVEL));
    expect(missing).toEqual([]);
  });

  it('carries no entry for a tree the repository does not track', () => {
    // The other direction, so the table cannot rot into a list of things that used to exist.
    const tracked = new Set(trackedTopLevel());
    const stale = Object.keys(TOP_LEVEL).filter((entry) => !tracked.has(entry));
    expect(stale).toEqual([]);
  });

  it('is exhaustive: only packages/ is a per-package tree, and only two trees are partial', () => {
    const byClass = Object.entries(TOP_LEVEL).reduce<Record<string, string[]>>(
      (acc, [entry, kind]) => ({ ...acc, [kind]: [...(acc[kind] ?? []), entry] }),
      {},
    );
    expect(byClass['tests']).toEqual(['packages/']);
    expect(byClass['partial']?.sort()).toEqual(['.ascend/', '.beads/']);
  });
});
