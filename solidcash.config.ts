import { defineConfig } from '@solidcash/solidhat/config';
import { mimcPrecompile } from './scripts/lib/mimc-script.ts';

/** The MiMC precompile MimcHash runs: circomlib's tree hash in BCH Script. */
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * The solidhat project: the contracts compile beneath `contracts/`, their artifacts and
 * contract tests live there too, and the mock network enforces BCH 2026's production
 * limits so a test judges what a real node would.
 */
export default defineConfig({
  paths: {
    contracts: 'contracts',
    artifacts: 'contracts/artifacts',
    tests: 'contracts/test',
  },
  compiler: {
    userLibraries: [{
      name: 'mimc',
      code: hex(mimcPrecompile()),
      abi: { inputs: [{ name: 'pair', type: 'bytes' }], outputs: [{ type: 'bytes32' }] },
    }],
    inlineLibraries: { mimc: true },
    commitmentLimit: 128,
    // The pool deployers are permissionless by design: they hold no funds, and the pools they
    // create pin the shared hashing and verifier locks themselves (contracts/Sidecars.scash), so a
    // caller supplies none. The compiler's lifecycle signature check is a warning.
    allowUnsafeOperations: true,
  },
  composition: 'direct',
  networks: {
    mock: {
      type: 'mock',
      consensus: {
        maximumInputBytes: 10_000,
        maximumStackItemBytes: 10_000,
        maximumTransactionBytes: 1_000_000,
        maximumNftCommitmentBytes: 128,
        operationCostBudgetPerByte: 800,
        hashDigestIterationsPerByte: 1,
        maximumMoney: 2_100_000_000_000_000n,
      },
      policy: { enforceDust: true },
    },
  },
  defaultNetwork: 'mock',
  mnemonic: 'test test test test test test test test test test test junk',
  accounts: { count: 8, satoshis: 1_000_000_000n },
});
