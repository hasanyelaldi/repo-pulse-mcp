import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests spawn real git processes; give them some headroom on slow CI runners.
    testTimeout: 20_000,
  },
});
