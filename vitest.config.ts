import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    // Tests run against TypeScript source, not built output, so `pnpm test`
    // does not require a prior `pnpm build`.
    alias: {
      '@ascend/core': pkg('core'),
      '@ascend/analysis': pkg('analysis'),
      '@ascend/store': pkg('store'),
      '@ascend/adapter-claude-code': pkg('adapter-claude-code'),
      '@ascend/cli': pkg('cli'),
    },
  },
});
