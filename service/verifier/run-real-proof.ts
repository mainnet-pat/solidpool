// Run a real, production-key Tornado proof through the 3-input BCH verifier.
//
//   tsx service/verifier/run-real-proof.ts [proof.json]
//
// Runs the vendored verifier, packages/verifier. See README.md.
//
// The proof in proofs/proof-recipient.json was generated with Tornado's
// release proving key for the statement
//   [root, nullifierHash, recipient=0x1111…, relayer=0, fee=0, refund=0].
// This build binds the first three; the other three are fixed to zero.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERIFIER } from '../lib/config';

const here = dirname(fileURLToPath(import.meta.url));
const nInputs = 3;
const vkFile = join(here, 'tornado-bn254-3in.json');
const vk = JSON.parse(readFileSync(vkFile, 'utf8'));
if (vk.vk.ic.length !== nInputs + 1) throw new Error(`expected ${nInputs + 1} IC points`);

const proofFile = process.argv[2] ?? join(here, 'proofs', 'proof-recipient.json');
const proof = JSON.parse(readFileSync(proofFile, 'utf8'));
const blob = proof.proof.replace(/^0x/, '');
const word = (i) => BigInt('0x' + blob.slice(i * 64, i * 64 + 64)).toString();
const fixture = {
  fixture: 0,
  publicInputs: proof.publicSignals.slice(0, nInputs).map((h) => BigInt(h).toString()),
  proof: {
    a: { x: word(0), y: word(1) },
    b: { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } },
    c: { x: word(6), y: word(7) },
  },
};

// The production key, through the global math.mjs reads.
(globalThis as any).__BN_VK_FIXTURES__ = vk;
const { buildProgram } = await import(join(VERIFIER, 'bn-native-sound', 'script.mjs'));
const { transactionFor } = await import(join(VERIFIER, 'bn-native-sound', 'transaction.mjs'));
const { spendAll, VM_CHARGES_DEFINE } = await import(join(VERIFIER, 'bn-native-sound', 'vm.mjs'));
console.log(VM_CHARGES_DEFINE
  ? 'op costs below are BCHN\'s: this libauth charges OP_DEFINE bodies'
  : 'op costs below are libauth\'s: BCHN charges the OP_DEFINE bodies on top, which the fillers allow for');

const program = buildProgram();
const run = (fx) => {
  const { fills, unlockings, locking } = transactionFor(fx, program);
  const modes = Object.fromEntries(['consensus', 'standard'].map((mode) => [mode, spendAll(
    unlockings.map(() => locking), unlockings, mode,
  )]));
  const score = unlockings.reduce((a, u) => a + u.length, 0) + 3 * 35 + 8 + 2 + 10 + 3 * 43;
  return { fills, unlockings, score, modes };
};

const honest = run(fixture);
const table = (label, result) => {
  const cells = result.modes.standard.map((x, i) => `${x.accepted ? 'ok' : 'REJECT'} ${x.opCost}/${x.budget} ${x.length}B`);
  console.log(`${label.padEnd(16)} ${cells.join('  |  ')}`);
};
console.log('code', program.code.length, 'B; redeem', program.R.length, 'B; score', honest.score, 'B; fills', honest.fills.join('/'));
table('honest', honest);

const tamper = (label, mutate) => {
  const fx = JSON.parse(JSON.stringify(fixture));
  mutate(fx);
  try {
    const r = run(fx);
    table(label, r);
    return r.modes.standard.every((x) => x.accepted);
  } catch (error) {
    console.log(`${label.padEnd(16)} rejected before the VM: ${String(error.message).split('\n')[0].slice(0, 70)}`);
    return false;
  }
};

const accepted = [
  tamper('recipient+1', (f) => { f.publicInputs[2] = (BigInt(f.publicInputs[2]) + 1n).toString(); }),
  tamper('root+1', (f) => { f.publicInputs[0] = (BigInt(f.publicInputs[0]) + 1n).toString(); }),
  tamper('nullifier+1', (f) => { f.publicInputs[1] = (BigInt(f.publicInputs[1]) + 1n).toString(); }),
  tamper('proof A.x+1', (f) => { f.proof.a.x = (BigInt(f.proof.a.x) + 1n).toString(); }),
];

const honestOk = honest.modes.consensus.every((x) => x.accepted) && honest.modes.standard.every((x) => x.accepted);
const limitsOk = honest.modes.standard.every((x) => x.length <= 10_000 && x.opCost <= x.budget);
console.log('result', { honestOk, limitsOk, anyTamperAccepted: accepted.some(Boolean) });
if (!honestOk || !limitsOk || accepted.some(Boolean)) process.exit(1);
