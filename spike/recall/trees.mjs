/**
 * asc-gtnu.8: the reviewer's working tree, built as an ALLOWLIST SLICE of this repo.
 *
 * WHY A SLICE AND NEVER `cp -r`. This repository describes the experiment everywhere: `.beads/`
 * holds the prereg including the seed classes, `.agents/research/` holds two earlier bug-hunt
 * reports of this very code, and `dogfood/`, `docs/evidence/` and `spike/` all discuss reviewers.
 * A tree is therefore built from a list of what IS allowed, so a new directory in the repo can
 * never leak into a reviewer's view by default.
 *
 * NARROWER THAN THE PLAN, deliberately: the plan named "the `packages/` source and tests". The
 * subject (`packages/core/src/handler.ts`) and its test file both live in `packages/core`, which
 * depends only on `zod`, while the other four packages carry the reviewer feature's own prose (the
 * nine lens slugs in `adapter-claude-code/src/derived-types.ts`, the EV-27 commentary). So the
 * slice is `packages/core` alone. The root `vitest.config.ts` is NOT copied either: it aliases
 * the four absent packages and its comments describe the live transcript corpus. A trimmed config
 * is written in its place, and the root `package.json` is replaced by one naming only what the
 * core tests need.
 *
 * WHERE, AND WHY NOT `spike/tmp/`. The plan put the trees under `spike/tmp/`. That is INSIDE this
 * repository, and a session started there inherits ascend's own `CLAUDE.md` (auto-discovered by
 * walking up) and a `bd` that walks up to the parent `.beads/` -- which holds this bead's
 * predictions and seed classes. So trees go under the OS temp root, as `spike/ev16-arms.mjs`
 * already does, with a NEUTRAL name (`rv-XXXXXX`): the directory name becomes the transcript's
 * project label and is visible to the reviewer, so it must not say which arm or class it is.
 * The cost is that `asc ingest claude-code` skips OS-temp projects unless `--include-ephemeral`
 * is passed -- measured 2026-09-27 to fail LOUDLY here ("No transcripts found ... other than 1
 * skipped as ephemeral"), not silently.
 *
 * THE ARMS DIFFER IN ONE THING. A and C get `node_modules` (vitest runs); B does not (the tests
 * are present and readable, the runner is not). `npx` could otherwise fetch the runner back, so
 * every arm -- identically -- runs with `npm_config_offline=true` and an EMPTY npm cache
 * (`recallEnv`), which leaves A and C unaffected (their vitest is local) and leaves B unable to
 * download one.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export const REPO = process.cwd();
export const SUBJECT = 'packages/core/src/handler.ts';
export const SUBJECT_TEST = 'packages/core/test/handler.test.ts';

/** Copied verbatim from the repo. Everything else in the tree is generated below. */
export const ALLOWLIST = [
  'packages/core/src',
  'packages/core/test',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'tsconfig.base.json',
  'LICENSE',
];

const ROOT_PACKAGE = {
  name: 'subject',
  version: '0.0.0',
  private: true,
  type: 'module',
  scripts: { test: 'vitest run', typecheck: 'tsc -p packages/core' },
  devDependencies: { '@types/node': '22.20.2', typescript: '5.9.3', vitest: '2.1.9' },
};

// pnpm 11 reads `allowBuilds` (the repo's own workspace file carries both keys); without it the
// install exits non-zero on esbuild's ignored build script.
const WORKSPACE = `packages:\n  - packages/*\n\nallowBuilds:\n  esbuild: true\n\nonlyBuiltDependencies:\n  - esbuild\n`;

const VITEST_CONFIG = `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
`;

/** Identical in every arm; see the header for why B needs it and A and C do not notice it. */
export function recallEnv(cacheDir) {
  return { ...process.env, npm_config_offline: 'true', npm_config_cache: cacheDir };
}

function run(cmd, args, cwd, env = process.env) {
  const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Every file under `dir`, relative to it, sorted -- the tree's manifest, for the record. */
export function manifest(dir) {
  const files = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else files.push(relative(dir, p));
    }
  };
  walk(dir);
  return files.sort();
}

/**
 * Build one tree. `apply(dir)` mutates the copied source before the commit (the seeds); `runnable`
 * decides whether `node_modules` is installed. Returns the directory and what was done to it.
 */
export function buildTree({ runnable, apply = () => {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-'));
  for (const rel of ALLOWLIST) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO, rel), dest, { recursive: true });
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(ROOT_PACKAGE, null, 2)}\n`);
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), WORKSPACE);
  writeFileSync(join(dir, 'vitest.config.ts'), VITEST_CONFIG);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  apply(dir);

  let install = null;
  if (runnable) {
    install = run('pnpm', ['install', '--prefer-offline', '--config.confirmModulesPurge=false'], dir);
    if (install.status !== 0) {
      throw new Error(`pnpm install --prefer-offline failed in ${dir}:\n${install.stderr}${install.stdout}`);
    }
  }

  // ONE commit, no upstream: `git diff` is clean and `git log -p` shows the seeded source as the
  // only version that ever existed, so version control holds nothing to read the seeds out of.
  const git = (args) => run('git', ['-c', 'user.name=subject', '-c', 'user.email=subject@example.invalid', ...args], dir);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'Initial import']]) {
    const res = git(args);
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${res.stderr}`);
  }
  return { dir, runnable, installed: install !== null };
}

/** Does the subject's own test file run in this tree? The observed difference between arms. */
export function probeRunner(dir) {
  const cache = mkdtempSync(join(tmpdir(), 'rv-cache-'));
  const res = spawnSync('npx', ['vitest', 'run', SUBJECT_TEST], {
    cwd: dir,
    env: recallEnv(cache),
    encoding: 'utf8',
    timeout: 180_000,
  });
  const text = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const tests = /Tests\s+(\d+) passed/.exec(text);
  return { status: res.status, passed: tests ? Number(tests[1]) : null, tail: text.slice(-600) };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain && process.argv.includes('--dry-run')) {
  const a = buildTree({ runnable: true });
  const b = buildTree({ runnable: false });
  const files = manifest(a.dir);
  const probeA = probeRunner(a.dir);
  const probeB = probeRunner(b.dir);
  const subjectSame =
    readFileSync(join(a.dir, SUBJECT), 'utf8') === readFileSync(join(REPO, SUBJECT), 'utf8');
  console.log(
    JSON.stringify(
      {
        files: files.length,
        topLevel: [...new Set(files.map((f) => f.split('/')[0]))],
        subjectUnchanged: subjectSame,
        armA: { passed: probeA.passed, status: probeA.status },
        armB: { passed: probeB.passed, status: probeB.status, tail: probeB.tail.slice(-300) },
      },
      null,
      2,
    ),
  );
}
