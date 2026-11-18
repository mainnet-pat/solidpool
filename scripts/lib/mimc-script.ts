// circomlib's MiMCSponge(2, 1), two inputs, one output and 220 rounds, in BCH Script: the hash of
// the circuit's tree (tornado-core's merkleTree.circom, HashLeftRight).
//
// One 220-round permutation is 218 pushed constants, each followed by a call of the
// round function, so the bytes stay small enough for one input while each hash costs
// 5.35M of operation cost. The round constants come from web/src/mimc.ts, so the
// script and the tree the client rebuilds share one source.
import { encodeDataPush } from '@bitauth/libauth';
import { FIELD, ROUND_CONSTANTS } from '../../web/src/mimc.ts';

const OP = {
  ZERO: 0x00, N15: 0x5f, N16: 0x60, TOALT: 0x6b, FROMALT: 0x6c, DUP: 0x76, NIP: 0x77, OVER: 0x78, ROT: 0x7b,
  SWAP: 0x7c, CAT: 0x7e, SPLIT: 0x7f, NUM2BIN: 0x80, BIN2NUM: 0x81, DEFINE: 0x89, INVOKE: 0x8a, ADD: 0x93,
  MUL: 0x95, MOD: 0x97, LESSTHAN: 0x9f, VERIFY: 0x69,
};
const scriptNumber = (value: bigint): Uint8Array => {
  const bytes: number[] = [];
  for (let n = value; n > 0n; n >>= 8n) bytes.push(Number(n & 0xffn));
  if (bytes.length && bytes.at(-1)! & 0x80) bytes.push(0);
  return Uint8Array.from(bytes);
};
const push = (data: Uint8Array): number[] => [...encodeDataPush(data)];
const pushNumber = (value: bigint): number[] => (value === 0n ? [OP.ZERO] : push(scriptNumber(value)));
const SIZE32 = [0x01, 0x20];
const P = pushNumber(FIELD);

/** [32-byte little-endian] -> [number below the field] */
const decode = [0x01, 0x00, OP.CAT, OP.BIN2NUM, OP.DUP, ...P, OP.LESSTHAN, OP.VERIFY];

/** The precompile: [left || right] -> [hash], each value 32 bytes little-endian. */
export function mimcPrecompile(): Uint8Array {
  // Function ids the contract around it does not use.
  const round = OP.N16;
  const permutation = OP.N15;
  // [xR xL c] -> [xL (xR + (xL + c)^5)]
  const roundBody = Uint8Array.from([
    OP.OVER, OP.ADD, OP.DUP, OP.DUP, OP.MUL, ...P, OP.MOD, OP.DUP, OP.MUL, OP.MUL, ...P, OP.MOD, OP.ROT, OP.ADD,
  ]);
  // The last Feistel round does not swap, which the final SWAP undoes.
  const permutationBody = Uint8Array.from([
    ...ROUND_CONSTANTS.flatMap((constant) => [...pushNumber(constant), round, OP.INVOKE]), OP.SWAP,
  ]);
  return Uint8Array.from([
    ...push(roundBody), round, OP.DEFINE, ...push(permutationBody), permutation, OP.DEFINE,
    ...SIZE32, OP.SPLIT,
    ...decode, OP.TOALT,
    ...decode, OP.ZERO, OP.SWAP,
    permutation, OP.INVOKE,
    OP.FROMALT, OP.ADD,
    permutation, OP.INVOKE,
    OP.NIP, ...P, OP.MOD, ...SIZE32, OP.NUM2BIN,
  ]);
}
