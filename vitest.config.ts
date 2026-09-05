import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // config.ts selects TEST_DATABASE_URL when NODE_ENV is 'test', so the
    // integration suite can truncate freely without touching demo data.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    globalSetup: ['apps/api/src/test-support/global-setup.ts'],
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'apps/agent/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Integration tests share one Postgres instance and create/drop schemas;
    // running files sequentially keeps their setup honest and failures readable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
