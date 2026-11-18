// Cost probe for the two operations that decide whether a zk verifier fits on
// BCH: 254-bit modular multiplication (the BN254 pairing hot loop) and SHA-256
// (the hash budget, and the only really cheap primitive).
//
//   tsx scripts/measure.ts
//
// Costs are measured with the 2026 libauth VM used by solidc's mock network,
// which implements the May 2025 "VM Limits" accounting: a 10,000-byte input
// script gets (10,000 + 41) * 800 = 8,032,800 operation-cost credits. The probes
// compile with the installed SolidCash; the pools' sizes are their committed
// artifacts', which `npm run contracts:check` holds to their sources.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bigIntToVmNumber, createVirtualMachineBch2026 } from '@bitauth/libauth';
import { compileString } from '@solidcash/solidc';
import { asmToBytecode } from '@solidcash/utils';

const here = dirname(fileURLToPath(import.meta.url));

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hx = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const vmNumberPush = (n) => {
  const b = bigIntToVmNumber(n);
  return Buffer.from([b.length, ...b]).toString('hex');
};

function run(asm, argHex) {
  const code = asmToBytecode(asm);
  const transaction = {
    version: 2,
    inputs: [{
      outpointTransactionHash: new Uint8Array(32),
      outpointIndex: 0,
      unlockingBytecode: hx(argHex),
      sequenceNumber: 0xffffffff,
    }],
    outputs: [{ lockingBytecode: hx('51' + '51'.repeat(20)), valueSatoshis: 1000n }],
    locktime: 0,
  };
  const program = {
    inputIndex: 0,
    sourceOutputs: [{ lockingBytecode: code, valueSatoshis: 1000n }],
    transaction,
  };
  const vm = createVirtualMachineBch2026(false);
  const ok = vm.verify(program) === true;
  const metrics = vm.debug(program).at(-1).metrics;
  if (!ok) throw new Error('probe script failed');
  return { cost: metrics.operationCost, iters: metrics.hashDigestIterations };
}

const repeat = (n, body) => Array.from({ length: n }, () => body).join('');
const big = P - 12345n;

const base = run(
  compileString('contract C(){ function f(bigint a){ require(a != 0); } }', {}).bytecode,
  vmNumberPush(big),
);
const mul10 = run(
  compileString(`contract C(){ function f(bigint a, bigint m){ ${repeat(10, 'a=(a*a)%m;')} require(a != 0); } }`, {}).bytecode,
  vmNumberPush(big) + vmNumberPush(P),
);
const mulmod = Math.round((mul10.cost - base.cost) / 10);

// One OP_SHA256 over N bytes. The May 2025 rules charge 64 bytes per digest
// iteration; 192 credits per iteration for relay-standard transactions, 64
// for a transaction a miner includes (non-standard).
const sha = (bytes) => {
  const prefix = bytes <= 75 ? bytes.toString(16).padStart(2, '0') : `4c${bytes.toString(16).padStart(2, '0')}`;
  return run('OP_SHA256 OP_DROP OP_1', `${prefix}${'aa'.repeat(bytes)}`);
};

const sha32 = sha(32);
const sha128 = sha(128);
const perIter = Math.round((sha128.cost - sha32.cost) / (sha128.iters - sha32.iters));

const budget = (10_000 + 41) * 800;
// The whole compiled code, with the bodies it defines: the artifact's debug bytecode.
const codeSize = (artifact) => artifact.debug.bytecode.length / 2;
const compiledPoolSize = (name) => codeSize(JSON.parse(readFileSync(join(here, '..', 'contracts', 'artifacts', 'solidcash', `${name}.json`), 'utf8')));
const compiledSize = (file) => codeSize(compileString(readFileSync(join(here, '..', 'contracts', file), 'utf8'), {}));

// Groth16 verification on BN254: three Miller loops plus a final
// exponentiation, about 20k-30k field multiplications, plus the G1
// multi-scalar multiplication for the public inputs.
const FP_MULS_LOW = 20_000;
const FP_MULS_HIGH = 30_000;
const inputsFor = (muls) => Math.ceil((muls * mulmod) / budget);

console.log('254-bit mulmod          ', mulmod, 'op cost (marginal)');
console.log('SHA-256 digest iteration', perIter, 'op cost / 64 bytes (non-standard)');
console.log('per-input op budget     ', budget, 'credits at a 10,000-byte scriptSig');
console.log('BchPool.scash           ', compiledPoolSize('BchPool'), 'bytes compiled');
console.log('TokenPool.scash         ', compiledPoolSize('TokenPool'), 'bytes compiled');
console.log('BN254.scash             ', compiledSize('BN254.scash'), 'bytes compiled');
console.log('');
console.log('Naive Groth16 projection (a Miller loop written straight-line; superseded by the real artifact)');
for (const muls of [FP_MULS_LOW, FP_MULS_HIGH]) {
  console.log(`  ${muls} Fp muls -> ${(muls * mulmod / 1e6).toFixed(1)}M op cost -> ${inputsFor(muls)} inputs at 10 KB each`);
}
console.log('');
console.log('Real reviewed artifact (bch-groth16-bn254-sound-native, verifier.cash):');
console.log('  27,624 B, 3 inputs in one standard transaction, 20.6M op, ~6% margin');
console.log('  rebuild for the circuit key: service/verifier/verifier-artifact.json (7,308 B code)');
console.log('');
console.log('Hashing capacity per input');
console.log(`  standard (relay):   ${Math.floor(budget / 192) * 64} bytes hashed`);
console.log(`  non-standard:       ${Math.floor(budget / 64) * 64} bytes hashed`);
