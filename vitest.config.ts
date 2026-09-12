import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
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
