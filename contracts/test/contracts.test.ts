import { describe, it } from 'vitest';

// Each file drives the contracts end to end on the mock network: the pool client the
// browser runs, real proofs under the production key, and every rule a hand-built
// transaction can break. They are imported one at a time because the mock's accounts
// and chain are shared, as the solidhat preset expects.
const suites = [
  ['client', () => import('./client.ts')],
  ['the native pool, end to end', () => import('./pool.ts')],
  ['the token pool', () => import('./token-pool.ts')],
  ['attacks on the proof-carrying pool', () => import('./pool-attacks.ts')],
  ['griefing the pool', () => import('./griefing.ts')],
  ['the tree\'s far ends', () => import('./tree-edges.ts')],
] as const;

describe('SolidPool contracts', () => {
  for (const [name, load] of suites) {
    it(name, async () => {
      await load();
    });
  }
});
