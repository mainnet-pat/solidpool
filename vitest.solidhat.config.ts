import { defineConfig } from 'vitest/config';
import { solidhatPreset } from '@solidcash/solidhat/vitest-preset';

/**
 * The contracts' suite, as solidhat runs it: the solidhat preset supplies the mock
 * network's setup and the Hardhat-shaped compatibility aliases, and `solidhat test`
 * compiles the project before this config starts.
 *
 * The files are the browser client and the contracts it drives, so coverage measures
 * the code the page runs rather than the test scaffold.
 */
export default defineConfig(solidhatPreset({ hardhat: 3, ethers: 6 }, {
  test: {
    include: ['contracts/test/**/*.test.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    // The devnet and its accounts are shared, so one file at a time.
    fileParallelism: false,
    silent: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'web/src/pool-client.ts',
        'web/src/mimc.ts',
        'web/src/note.ts',
        'web/src/nullifiers.ts',
        'web/src/history.ts',
        'web/src/pools.ts',
        'web/src/verifier.ts',
        'scripts/lib/deploy.ts',
        'scripts/lib/genesis.ts',
      ],
      exclude: ['**/*.test.ts'],
      // The suite drives every contract rule and both pool kinds end to end; the floor
      // keeps a new branch from landing without one of those rules exercising it.
      thresholds: {
        statements: 92,
        branches: 85,
        functions: 90,
        lines: 95,
      },
    },
  },
}));
