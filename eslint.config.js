import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // Stage 0 harness, deliberately throwaway-quality and never built. KEPT, not
      // deleted: it is the reproducible basis for the EV records the architecture
      // rests on, and re-litigating those decisions requires re-running it. Its
      // 29MB corpus.db is derived from ~/.claude/projects and is gitignored.
      'spike/**',
      '.beads/**',
      '.mast/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated types-only project (see tsconfig.eslint.json) rather than
        // the build projects: tests, configs and bin scripts are linted but are
        // deliberately not part of any build.
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The purity contract in one place. `asc-core-purity` and `align check`
    // are the enforcement of record; these rules catch it at edit time.
    //
    // test/fixtures is included on purpose: it holds deliberate violations that
    // purity-enforcement.test.ts asserts still fail. Without that, a broken
    // lint config would silently pass and every "pure core" claim with it.
    files: [
      'packages/core/src/**/*.ts',
      'packages/analysis/src/**/*.ts',
      'packages/*/test/fixtures/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:fs', message: 'core/analysis are pure: no fs.' },
            { name: 'node:fs/promises', message: 'core/analysis are pure: no fs.' },
            { name: 'node:sqlite', message: 'Only @ascend/store may touch SQLite.' },
            { name: 'node:net', message: 'core/analysis are pure: no network.' },
            { name: 'node:http', message: 'core/analysis are pure: no network.' },
            { name: 'node:https', message: 'core/analysis are pure: no network.' },
            { name: 'node:os', message: 'core/analysis are pure: no ambient environment.' },
            { name: 'node:child_process', message: 'core/analysis are pure: no process access.' },
            {
              name: 'node:crypto',
              message:
                'core/analysis are pure: hashing must be deterministic and identical everywhere. Use src/hash.ts.',
            },
          ],
          patterns: [
            {
              group: ['@ascend/store', '@ascend/adapter-*'],
              message: 'Core never imports store or adapter.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Time is injected, never read. Use a clock parameter.' },
        { name: 'process', message: 'core/analysis are pure: no ambient environment.' },
        {
          name: 'performance',
          message: 'Time is injected, never read. A monotonic clock is still a clock.',
        },
        {
          name: 'crypto',
          message: 'IDs and randomness are injected, never drawn from the ambient environment.',
        },
      ],
      // `Math` itself cannot be banned -- core legitimately uses Math.floor and Math.ceil
      // (see hash.ts) -- so nondeterminism is banned by property instead.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'core/analysis are deterministic: a random value makes a result unreproducible. Inject the value.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Tests assert against literal fixtures; non-null assertions on known
      // shapes keep them readable.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Node globals for the repo's own tooling scripts. These are plain .mjs, so
    // they get `no-undef` from js.configs.recommended with no ambient `types`
    // to satisfy it -- TypeScript files get that from their project, JS does not.
    //
    // Declared by hand rather than pulling in the `globals` package: it is two
    // names, and a dependency needs a stronger justification than that (align's
    // newDependencyGate asks for one). Add to this list when a script reaches
    // for another global; the failure is loud, which is the point.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
);
