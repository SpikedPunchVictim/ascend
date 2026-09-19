import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    /**
     * Six workers, not the default one-per-core (12 here) -- `asc-3x1`.
     *
     * The default oversubscribes the machine AGAINST ITSELF. Two suites spawn REAL `asc` child
     * processes (`8pp-truncation.test.ts` alone does 12), so each worker is a worker PLUS its
     * children, and 12 workers on 12 cores is already double the hardware before any test does
     * I/O. Two more files then stream the whole live transcript corpus -- ~1.4 GiB today, and
     * growing on its own -- so the losers also evict each other's page cache.
     *
     * MEASURED 2026-09-18, full suite, same machine, on `derive-real-corpus.test.ts`'s shared
     * sweep and its 120,000 ms budget:
     *
     *   forks   sweep        of budget   wall-clock   verdict
     *      12   113,931 ms       94.9%    558-1152 s  RED (timed out on a LOADED machine)
     *       8    40,641 ms       33.9%        272 s   green
     *       6    24,094 ms       20.1%        292 s   green
     *       4    31,118 ms       25.9%        523 s   green
     *
     * Parallelism was LOSING, not trading off: the same pair of corpus files took 114 s racing
     * each other and 75 s run sequentially, and one competing file alone stretched the sweep
     * from ~10 s to 77 s. Fewer workers is both faster and safer, up to a point -- 4 is past it.
     *
     * Six over eight costs 7% of wall-clock and buys back 14 points of budget. That is the right
     * side of the trade because the headroom DEPRECIATES: the corpus is live and local, and grew
     * 18% in records over the three days to 2026-09-18. At 20% of budget it can grow 5x before
     * this reds; at 34%, only 3x. Raising the 120,000 ms budget instead was rejected -- it is
     * the tripwire for a real regression, and the sweep only does ~10 s of actual work.
     *
     * Not a fitted constant: 12 cores, and a worker with one live `asc` child is two processes,
     * so six workers is the hardware. The measurement agrees with the arithmetic.
     */
    poolOptions: {
      forks: {
        // `minForks` must not exceed `maxForks`, and it defaults to the core count -- setting
        // only the maximum throws `minThreads and maxThreads must not conflict` before a single
        // test runs.
        minForks: 1,
        maxForks: 6,
      },
    },
  },
  resolve: {
    alias: {
      /**
       * Modules Node exposes ONLY under the `node:` prefix cannot be imported from
       * test source under Vitest 2 / Vite 5.
       *
       * Measured, not guessed. `builtinModules` contains `node:sqlite` and does NOT
       * contain bare `sqlite`. Vite 5 identifies builtins with
       * `builtinModules.includes(id.replace(/^node:/, ''))` -- strip the prefix, test
       * the bare name -- so `node:sqlite` is never recognised. Vite then rewrites the
       * specifier to bare `sqlite` during SSR import analysis and the module graph
       * fails with `Failed to load url sqlite`. (Vite also does
       * `builtinModules.filter((id) => !id.includes(':'))`, discarding exactly these
       * entries, so this is a deliberate pre-`node:sqlite` filter, not version skew.)
       *
       * The failure is DOWNSTREAM of plugin resolution, which makes the obvious fixes
       * inert. Verified by experiment:
       *   - an `enforce: 'pre'` plugin returning `{ id }` / `{ id, external: true }` /
       *     `{ id, external: 'absolute' }` / a bare-id remap -- all four produce a
       *     byte-identical error, so the hook's result is discarded;
       *   - `test.server.deps.external: ['node:sqlite']` -- same, because vite-node
       *     externalizes on the id it receives, which is already stripped.
       * A standalone probe confirmed plain Vite resolves `node:sqlite` correctly via
       * `ssrLoadModule`, so this is specific to Vitest's pipeline, not Vite's.
       *
       * Aliasing runs before builtin detection, so it is the one hook that sees the
       * specifier intact. The shim reaches the real module through `createRequire`,
       * which is not a static specifier and so never enters the module graph.
       *
       * Deliberately confined to this file: production source says
       * `import { DatabaseSync } from 'node:sqlite'` and typechecks against
       * `@types/node`, unmodified. No source is contorted to work around a test tool.
       */
      'node:sqlite': fileURLToPath(new URL('./scripts/node-sqlite-shim.ts', import.meta.url)),
      // Tests run against TypeScript source, not built output, so `pnpm test`
      // does not require a prior `pnpm build`.
      '@ascend/core': pkg('core'),
      '@ascend/analysis': pkg('analysis'),
      '@ascend/store': pkg('store'),
      '@ascend/adapter-claude-code': pkg('adapter-claude-code'),
      '@ascend/cli': pkg('cli'),
    },
  },
});
