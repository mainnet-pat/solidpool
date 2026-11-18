// Build the reviewed BCH-native Groth16 verifier for Tornado's BN254 verifying key.
//
//   tsx service/verifier/build.ts            write verifier-artifact-3in.json
//   tsx service/verifier/build.ts --check    compare it with the source, and write nothing
//
// Builds the vendored verifier, packages/verifier, and checks that the key it ships is this one. See README.md.
//
// Tornado's circuit has 6 public inputs: [root, nullifierHash, recipient,
// relayer, fee, refund]. This build binds the first three as runtime inputs
// (IC0 + n0*IC1 + n1*IC2 + n2*IC3) and fixes the last three to 0, so IC4..IC6
// vanish. The payout is bound to the proof; no trusted relayer is needed.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERIFIER } from '../lib/config';

const here = dirname(fileURLToPath(import.meta.url));
const vkFile = join(here, 'tornado-bn254-3in.json');
const fixtures = JSON.parse(readFileSync(vkFile, 'utf8'));
if (fixtures.vk.ic.length !== 4) throw new Error('expected 3 runtime public inputs (IC0..IC3)');
if (fixtures.allIc.length !== 7) throw new Error('expected 6 Tornado public inputs (IC0..IC6)');

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (b) => createHash('sha256').update(b).digest();
const shaHex = (b) => sha256(b).toString('hex');

// The browser takes the key the verifier package ships (vk-3in.json) and cannot be told another, so that key must be
// this one. The build itself is told this key, through the global math.mjs reads.
const shipped = JSON.parse(readFileSync(join(VERIFIER, 'vk-3in.json'), 'utf8'));
if (JSON.stringify(shipped.vk) !== JSON.stringify(fixtures.vk)) {
  throw new Error(`${join(VERIFIER, 'vk-3in.json')} is not tornado-bn254-3in.json's key; the browser would prove under it`);
}
console.log('the verifier package ships this key (vk-3in.json)');
(globalThis as any).__BN_VK_FIXTURES__ = fixtures;
const { buildProgram } = await import(join(VERIFIER, 'bn-native-sound', 'script.mjs'));
const { SWEEP_AGE } = await import(join(VERIFIER, 'bn-native-sound', 'protocol.mjs'));
const program = buildProgram();
const again = buildProgram();
if (hex(program.code) !== hex(again.code) || hex(program.R) !== hex(again.R)) throw new Error('non-deterministic build');

// The code names no pool, so this is the one verifier every pool spends: its lock is pinned in
// the pools' code (contracts/Sidecars.scash, written from redeemHex).
const p2sh32 = (redeem: Uint8Array) => Buffer.concat([Buffer.from([0xaa, 0x20]), sha256(sha256(redeem)), Buffer.from([0x87])]);
const artifact = {
  curve: 'BN254',
  proofSystem: 'Groth16',
  statement: ['root', 'nullifierHash', 'recipient'],
  foldedConstants: { relayer: 0, fee: 0, refund: 0 },
  sourceVk: 'tornado-core/contracts/Verifier.sol',
  vkDigest: shaHex(Buffer.from(JSON.stringify(fixtures.vk))),
  codeBytes: program.code.length,
  codeSha256: shaHex(program.code),
  codePieces: program.pieces.map((x, i) => ({ host: i, bytes: x.length, hex: hex(x) })),
  redeemBytes: program.R.length,
  redeemHex: hex(program.R),
  lockingHex: hex(p2sh32(program.R)),
  // A coin unmoved for this many blocks can be swept by anyone, as its transaction's only input.
  sweepAge: SWEEP_AGE,
  stmtOffset: program.lay.off[2].STMT.data,
  roles: program.info.roles,
  prologueBytes: program.info.prologue,
  notes: {
    shape: 'the last 3 inputs of any transaction, P2SH32 of one lock for every pool, ~29.8 kB; recreated by the last 3 outputs; a lone coin unmoved for sweepAge blocks can be swept',
    // service/verifier/run-real-proof.ts gives the score and libauth's count; BCHN also charges the
    // OP_DEFINE bodies, as measured on a node beside a real pool.
    measured: 'a real production-key proof is accepted: 29,899 B score, 22.33M op as libauth counts it and 22.38M as BCHN does, 3 inputs under 10 KB',
  },
};
const out = join(here, 'verifier-artifact-3in.json');
const text = JSON.stringify(artifact, null, 1) + '\n';
console.log(`code ${artifact.codeBytes} B sha256 ${artifact.codeSha256}`);
console.log(`pieces ${program.pieces.map((x) => x.length).join(' + ')}; redeem ${artifact.redeemBytes} B`);
console.log(`roles ${program.info.roles.join(' / ')}; prologue ${program.info.prologue} B`);
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== text) {
    console.error('verifier-artifact-3in.json does not match the source. Run service/verifier/build.ts.');
    process.exit(1);
  }
  console.log('verifier-artifact-3in.json matches the source');
} else writeFileSync(out, text);
