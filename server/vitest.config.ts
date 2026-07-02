import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only run source tests — dist/ holds stale compiled copies of the same
    // suites and double-runs (or worse, runs old assertions against new code).
    include: ['src/**/*.test.ts'],
  },
});
