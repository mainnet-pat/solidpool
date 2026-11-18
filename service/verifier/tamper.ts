// A real production-key proof through the composed verifier, then every way of changing
// what it was given: one bit in each kind of witness, each rule of composing with a pool,
// and each shape of the sweep. Every case runs in the BCH VM and must be refused by some input.
//
//   tsx service/verifier/tamper.ts
//
// It recommits nothing, so it tests the checks in front of the pairing. The verifier's
// red-team suite does the rest, with a test key: see README.md.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERIFIER } from '../lib/config';

const here = dirname(fileURLToPath(import.meta.url));
// The production key, through the global math.mjs reads.
(globalThis as any).__BN_VK_FIXTURES__ = JSON.parse(readFileSync(join(here, 'tornado-bn254-3in.json'), 'utf8'));
const dir = join(VERIFIER, 'bn-native-sound');
const { buildProgram } = await import(join(dir, 'script.mjs'));
const { transactionFor } = await import(join(dir, 'transaction.mjs'));
const { encodeUnlocking, spendAll, VMS } = await import(join(dir, 'vm.mjs'));
const { STMT_LAYOUT, SWEEP_AGE } = await import(join(dir, 'protocol.mjs'));

const proof = JSON.parse(readFileSync(join(here, 'proofs', 'proof-recipient.json'), 'utf8'));
const blob = proof.proof.replace(/^0x/, '');
const word = (i: number) => BigInt(`0x${blob.slice(i * 64, i * 64 + 64)}`).toString();
const fixture = {
  fixture: 0,
  publicInputs: proof.publicSignals.slice(0, 3).map((value: string) => BigInt(value).toString()),
  proof: {
    a: { x: word(0), y: word(1) },
    b: { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } },
    c: { x: word(6), y: word(7) },
  },
};

// One program for every pool: the code names none.
const program = buildProgram();
const { pushes, unlockings, locking } = transactionFor(fixture, program);
const lock = Uint8Array.from(locking);

let failures = 0;
const accepted = (runs: any[]) => runs.every((run) => run.accepted);
const expectRefused = (label: string, runs: any[]) => {
  if (accepted(runs)) { failures += 1; console.log('ACCEPTED', label); } else console.log('refused ', label);
};
const honest = spendAll([lock, lock, lock], unlockings, 'standard');
if (!accepted(honest)) throw new Error(`the honest proof was refused: ${honest.map((run: any) => run.error).join('; ')}`);
console.log('accepted', 'the honest proof', honest.map((run: any) => `${run.opCost}/${run.budget}`).join(' '));

// ---- one bit of each kind of witness ----
const INPUTS = { S0: [0, 0], DS0: [0, 1], C0: [0, 2], F0: [0, 3], R0: [0, 4], S1: [1, 0], H1: [1, 1], DS1: [1, 2], C1: [1, 3], F1: [1, 4], R1: [1, 5], DG: [2, 0], STMT: [2, 1], S2: [2, 2], H2: [2, 3], DS2: [2, 4], F2: [2, 5], WQ: [2, 6], R2: [2, 7] };
const cases: Array<[string, keyof typeof INPUTS, number]> = [
  ['a stream witness in input 0', 'S0', 5], ['a state in input 0', 'S0', 164], ['a delta slope in input 0', 'DS0', 700],
  ['code in input 0', 'C0', 1000], ['the filler of input 0', 'F0', 0], ['the redeem of input 0', 'R0', 20],
  ['a stream witness in input 1', 'S1', 40], ['the handover to input 1', 'H1', 3], ['the running R in that handover', 'H1', 195],
  ['a delta slope in input 1', 'DS1', 1500], ['code in input 1', 'C1', 1000], ['the filler of input 1', 'F1', 0], ['the redeem of input 1', 'R1', 20],
  ['the digest list', 'DG', 40], ['proof point A', 'STMT', 5], ['proof point B', 'STMT', 165], ['proof point C', 'STMT', 200],
  ['the root', 'STMT', STMT_LAYOUT.n0], ['the nullifier hash', 'STMT', STMT_LAYOUT.n1], ['the recipient', 'STMT', STMT_LAYOUT.n2],
  ['the nibbles of the root', 'STMT', STMT_LAYOUT.N0 + 30], ['the nibbles of the nullifier', 'STMT', STMT_LAYOUT.N1 + 30], ['the nibbles of the recipient', 'STMT', STMT_LAYOUT.N2 + 30],
  ['the residue root', 'STMT', STMT_LAYOUT.sc + 70], ['a state in input 2', 'S2', 600], ['the handover to input 2', 'H2', 163],
  ['a delta slope in input 2', 'DS2', 900], ['the filler of input 2', 'F2', 0], ['the quotient\'s lead', 'WQ', 3], ['the quotient\'s middle', 'WQ', pushes[2][6].length >> 1], ['the redeem of input 2', 'R2', 20],
];
for (const [label, name, offset] of cases) {
  const [input, push] = INPUTS[name];
  if (!pushes[input][push]?.length) continue;
  const changed = pushes.map((list: Uint8Array[]) => list.map((item) => Buffer.from(item)));
  changed[input][push][offset] ^= 1;
  expectRefused(`a bit of ${label}`, spendAll([lock, lock, lock], changed.map((list: Uint8Array[]) => Buffer.from(encodeUnlocking(list))), 'standard'));
}

// ---- composition ----
// The verifier reads none of the inputs in front of its three: any pool's master can stand at
// input 0, and the pool judges the statement against its own state.
const master = (category: Uint8Array, capability = 'minting') => ({
  lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 1_000n,
  token: { category, amount: 0n, nft: { capability, commitment: new Uint8Array() } },
});
const coin = (lockingBytecode: Uint8Array, valueSatoshis = 1_000n) => ({ lockingBytecode, valueSatoshis });

function evaluate({ sources, unlocking, outputs, sequenceNumber = 0, version = 2 }: {
  sources: any[]; unlocking: Uint8Array[]; outputs: any[]; sequenceNumber?: number; version?: number;
}) {
  const transaction = {
    version, locktime: 0,
    inputs: sources.map((_, n) => ({
      outpointIndex: n, outpointTransactionHash: new Uint8Array(32).fill(n + 1), sequenceNumber,
      unlockingBytecode: Uint8Array.from(unlocking[n] ?? new Uint8Array()),
    })),
    outputs,
  };
  return sources.map((source, inputIndex) => {
    if (source.lockingBytecode.length !== lock.length || source.lockingBytecode.some((byte: number, i: number) => byte !== lock[i])) return { accepted: true };
    const state = VMS.standard.evaluate({ inputIndex, sourceOutputs: sources, transaction });
    return { accepted: state.error === undefined && state.stack.length === 1 && state.stack[0][0] === 1 };
  });
}
const pool = master(new Uint8Array(32).fill(7));
const plain = coin(Uint8Array.of(0x51));
const padded = (...items: Uint8Array[]) => [new Uint8Array(), ...items];
const recreate = [coin(lock), coin(lock), coin(lock)];
const honestGraph = { sources: [pool, coin(lock), coin(lock), coin(lock)], unlocking: padded(...unlockings), outputs: [coin(Uint8Array.of(0x6a), 0n), ...recreate] };
for (const [label, front] of [['a pool\'s master', pool], ['another pool\'s master', master(new Uint8Array(32).fill(9))], ['a plain coin', plain]] as const) {
  if (!accepted(evaluate({ ...honestGraph, sources: [front, ...honestGraph.sources.slice(1)] }))) throw new Error(`the honest composition beside ${label} was refused`);
  console.log('accepted', `the honest composition beside ${label}`);
}
expectRefused('the verifier coins in the wrong order', evaluate({ ...honestGraph, unlocking: padded(unlockings[1], unlockings[0], unlockings[2]) }));
expectRefused('a foreign coin among the last three', evaluate({ ...honestGraph, sources: [pool, coin(lock), plain, coin(lock)] }));
expectRefused('a fourth verifier coin before the last three', evaluate({
  sources: [pool, coin(lock), coin(lock), coin(lock), coin(lock)],
  unlocking: padded(unlockings[0], ...unlockings),
  outputs: [coin(Uint8Array.of(0x6a), 0n), coin(Uint8Array.of(0x6a), 0n), ...recreate],
}));
expectRefused('a verifier coin not recreated', evaluate({ ...honestGraph, outputs: [coin(Uint8Array.of(0x6a), 0n), coin(lock), coin(lock), coin(Uint8Array.of(0x51))] }));
expectRefused('a verifier coin recreated smaller', evaluate({ ...honestGraph, outputs: [coin(Uint8Array.of(0x6a), 0n), coin(lock), coin(lock, 999n), coin(lock)] }));
expectRefused('the recreated coins not last', evaluate({ ...honestGraph, outputs: [...recreate, coin(Uint8Array.of(0x6a), 0n)] }));

// ---- the sweep ----
// A coin takes R's sweep branch only as its transaction's only input, SWEEP_AGE blocks old, with
// the redeem alone. So no sweep stands among the three, and no pool reads a statement nobody proved.
const sweepOnly = Uint8Array.from(encodeUnlocking([program.R]));
const lone = { sources: [coin(lock)], unlocking: [sweepOnly], outputs: [coin(Uint8Array.of(0x51), 900n)], sequenceNumber: SWEEP_AGE };
if (!accepted(evaluate(lone))) throw new Error('a lone coin unmoved for SWEEP_AGE blocks was not swept');
console.log('accepted', `a lone coin unmoved for ${SWEEP_AGE} blocks, swept`);
expectRefused(`a lone coin unmoved for ${SWEEP_AGE - 1} blocks`, evaluate({ ...lone, sequenceNumber: SWEEP_AGE - 1 }));
expectRefused('a lone coin in a version 1 transaction', evaluate({ ...lone, version: 1 }));
expectRefused('two coins swept together', evaluate({ ...lone, sources: [coin(lock), coin(lock)], unlocking: [sweepOnly, sweepOnly] }));
expectRefused('a sweep beside a pool\'s master', evaluate({ ...lone, sources: [pool, coin(lock)], unlocking: [new Uint8Array(), sweepOnly] }));
for (const at of [0, 1, 2]) {
  const unlocking = padded(...unlockings);
  unlocking[1 + at] = sweepOnly;
  expectRefused(`the sweep's unlocking as verifier input ${at} of a withdrawal`, evaluate({ ...honestGraph, unlocking, sequenceNumber: SWEEP_AGE }));
}

console.log(failures === 0 ? 'PASS' : `${failures} ACCEPTED`);
process.exit(failures === 0 ? 0 : 1);
