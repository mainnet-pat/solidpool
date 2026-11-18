// The two locks every pool spends coins of beside its master, which the pools pin in their
// code: MimcHash's, and the Groth16 verifier's. Neither names a pool, so every pool shares
// them, and a pool takes no argument a creator could get wrong.
//
// contracts/Sidecars.scash holds them as constants. It is written from MimcHash's source and
// the verifier's artifact, `tsx scripts/sidecar-locks.ts` rewrites it, and `npm run check`
// refuses a copy that differs, since a pool compiled against another lock could spend no coin.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cashAddressToLockingBytecode, hash256, hexToBin } from '@bitauth/libauth';
import { compileString } from '@solidcash/solidc';
import { Contract } from '@solidcash/solidcash';
import { mimcPrecompile } from './mimc-script.ts';

const root = new URL('../..', import.meta.url).pathname;
export const SIDECARS_FILE = join(root, 'contracts', 'Sidecars.scash');
const VERIFIER_ARTIFACT = join(root, 'service', 'verifier', 'verifier-artifact-3in.json');

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** The options every contract compiles with, as solidcash.config.ts gives them to solidhat. */
export const compilerOptions = {
  userLibraries: [{
    name: 'mimc',
    code: hex(mimcPrecompile()),
    abi: { inputs: [{ name: 'pair', type: 'bytes' }], outputs: [{ type: 'bytes32' }] },
  }],
  inlineLibraries: { mimc: true },
  commitmentLimit: 128,
  allowUnsafeOperations: true,
};

const resolver = (importPath: string, currentFile: string) => {
  const id = join(dirname(currentFile), importPath);
  return { id, source: readFileSync(id, 'utf8') };
};

/** MimcHash's locking bytecode, from its source: P2SH32 of its code, which takes no argument. */
export function workerLock(): Uint8Array {
  const file = join(root, 'contracts', 'MimcHash.scash');
  const artifact = compileString(readFileSync(file, 'utf8'), { ...compilerOptions, importResolver: resolver, rootFileId: file } as any);
  const contract = new Contract(artifact as any, [], { provider: { network: 'mock' } as any, addressType: 'p2sh32' });
  const decoded = cashAddressToLockingBytecode(contract.address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
}

/** The verifier's locking bytecode: P2SH32 of its redeem, which holds its code's sha256. */
export function verifierLock(): Uint8Array {
  const { redeemHex } = JSON.parse(readFileSync(VERIFIER_ARTIFACT, 'utf8')) as { redeemHex: string };
  return Uint8Array.from([0xaa, 0x20, ...hash256(hexToBin(redeemHex)), 0x87]);
}

/** contracts/Sidecars.scash for these locks. */
export function sidecarsSource(worker = workerLock(), verifier = verifierLock()): string {
  return `pragma solidcash ^0.51.0;

// Written by scripts/sidecar-locks.ts; \`npm run check\` refuses a copy that differs.
//
// The locks of the coins a pool spends beside its master, the same for every pool: MimcHash's,
// and the Groth16 verifier's (service/verifier/verifier-artifact-3in.json). A pool pins them, so
// it reads only coins that ran that code. Neither code names a pool: anyone can make a coin of
// either lock, and anyone can sweep one that has stood unmoved for 1,440 blocks, as its
// transaction's only input.

bytes constant WORKER_LOCK = 0x${hex(worker)};
bytes constant VERIFIER_LOCK = 0x${hex(verifier)};
`;
}
