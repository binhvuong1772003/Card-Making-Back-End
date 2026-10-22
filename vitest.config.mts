import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 30_000,
    fileParallelism: false, // các file test dùng chung một database
  },
});
