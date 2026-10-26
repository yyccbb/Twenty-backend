import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Integration files share one Postgres container per file; run files one at a time to keep Docker load low.
    fileParallelism: false,
  },
});
