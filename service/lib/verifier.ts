// The Groth16 prover in Node, for tests and tooling. The browser has its own in
// web/src/prover.ts; both take the circuit's input as it stands.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CIRCUITS } from './config';

const require = createRequire(import.meta.url);
const websnarkUtils = require('websnark/src/utils');
const buildGroth16 = require('websnark/src/groth16');

const circuit = require(process.env.CIRCUIT_FILE ?? join(CIRCUITS, 'withdraw.json'));
const key = readFileSync(process.env.PROVING_KEY_FILE ?? join(CIRCUITS, 'withdraw_proving_key.bin'));
const provingKey = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength);
let groth16: any;

export async function proveStatement(input: Record<string, unknown>) {
  groth16 ??= await buildGroth16();
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, provingKey);
  const { proof, publicSignals } = websnarkUtils.toSolidityInput(proofData);
  const blob = proof.replace(/^0x/, '');
  const word = (i: number) => BigInt(`0x${blob.slice(i * 64, i * 64 + 64)}`).toString();
  return {
    publicInputs: publicSignals.slice(0, 3).map((value: string) => BigInt(value).toString()),
    proof: {
      a: { x: word(0), y: word(1) },
      b: { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } },
      c: { x: word(6), y: word(7) },
    },
  };
}
