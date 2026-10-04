import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main/**'],
      thresholds: {
        // §27: 100% of branches in the allocation engine, 80% overall.
        lines: 70,
        branches: 70,
        'src/modules/allocation/domain/**': {
          lines: 95,
          branches: 90,
        },
      },
    },
  },
});
