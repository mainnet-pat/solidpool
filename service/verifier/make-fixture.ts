// Turn a websnark/Tornado proof JSON into the benchmark fixture shape.
//
//   tsx service/verifier/make-fixture.ts proof.json out.json [numPublicInputs]
//
// The proof blob is 8 big-endian words: A.x, A.y, B.x1(imag), B.x0(real),
// B.y1(imag), B.y0(real), C.x, C.y. Public signals are big-endian hex.
// `numPublicInputs` (default 2) selects how many of Tornado's six public
// inputs the verifier consumes.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile, nArg] = process.argv;
if (!inFile || !outFile) throw new Error('usage: tsx service/verifier/make-fixture.ts proof.json out.json [n]');
const n = Number(nArg ?? 2);
const proof = JSON.parse(readFileSync(inFile, 'utf8'));
const blob = proof.proof.replace(/^0x/, '');
const word = (i) => BigInt('0x' + blob.slice(i * 64, i * 64 + 64)).toString();
const a = { x: word(0), y: word(1) };
const b = { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } };
const c = { x: word(6), y: word(7) };
const publicInputs = proof.publicSignals.slice(0, n).map((h) => BigInt(h).toString());
const fixture = {
  fixture: 0,
  publicInputs,
  proof: { a, b, c },
};
writeFileSync(outFile, JSON.stringify([fixture], null, 1) + '\n');
console.log('wrote', outFile, 'publicInputs', publicInputs.length);
