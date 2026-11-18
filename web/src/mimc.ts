// MiMC over the BN254 scalar field, as the withdrawal circuit hashes its tree: a sponge of rate
// and capacity one around a 220-round Feistel permutation with x^5 as its round function. Native
// BigInt keeps the browser bundle free of field-arithmetic libraries. scripts/lib/mimc-script.ts
// computes the same permutation on chain.
import { keccak_256 } from '@noble/hashes/sha3.js';

/** The BN254 scalar field's prime: every value here lies below it. */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ROUNDS = 220;
// keccak256("tornado") % FIELD: the empty leaf, a constant of the deposit tree.
const ZERO = 21663839004416932945382355908790599225266501822907911457504978515578255421292n;

const reduce = (value: bigint): bigint => ((value % FIELD) + FIELD) % FIELD;
const bigEndian = (bytes: Uint8Array): bigint => bytes.reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);

/**
 * One constant per round. The first and the last are zero. Between them, a keccak-256 chain that
 * starts from the text "mimcsponge" supplies the rest: each takes the next digest of the chain,
 * beginning with the digest of the text's digest, as a big-endian number reduced into the field.
 */
export const ROUND_CONSTANTS: readonly bigint[] = (() => {
  const chained: bigint[] = [];
  let digest = keccak_256(new TextEncoder().encode('mimcsponge'));
  while (chained.length < ROUNDS - 2) {
    digest = keccak_256(digest);
    chained.push(reduce(bigEndian(digest)));
  }
  return [0n, ...chained, 0n];
})();

/**
 * The permutation, keyed by k. Each round adds (left + k + c)^5 to the right half and then swaps
 * the halves; the last round's swap is undone at the end, as the on-chain script's final SWAP does.
 */
const permute = (left: bigint, right: bigint, k: bigint): [bigint, bigint] => {
  let pair: [bigint, bigint] = [left, right];
  for (const c of ROUND_CONSTANTS) {
    const sum = reduce(pair[0] + k + c);
    pair = [reduce(pair[1] + sum ** 5n), pair[0]];
  }
  return [pair[1], pair[0]];
};

/** The sponge: each value is added to the rate cell, then both cells are permuted with key zero. */
export const mimcSponge = (values: bigint[]): bigint => {
  let rate = 0n;
  let capacity = 0n;
  for (const value of values) [rate, capacity] = permute(reduce(rate + value), capacity, 0n);
  return rate;
};

export class MimcTree {
  readonly levels: number;
  readonly layers: bigint[][];
  readonly zeros: bigint[];

  constructor(levels: number, leaves: bigint[] = []) {
    this.levels = levels;
    this.zeros = [ZERO];
    for (let depth = 1; depth <= levels; depth += 1) {
      this.zeros.push(mimcSponge([this.zeros[depth - 1], this.zeros[depth - 1]]));
    }
    this.layers = Array.from({ length: levels + 1 }, () => []);
    this.append(leaves);
  }

  /** Add leaves. Only the nodes they change are hashed again. */
  append(leaves: bigint[]): void {
    const from = this.size;
    for (const leaf of leaves) this.layers[0].push(leaf);
    for (let depth = 1; depth <= this.levels; depth += 1) {
      const previous = this.layers[depth - 1];
      const current = this.layers[depth];
      for (let i = from >> depth; i < Math.ceil(previous.length / 2); i += 1) {
        current[i] = mimcSponge([
          previous[2 * i] ?? this.zeros[depth - 1],
          previous[2 * i + 1] ?? this.zeros[depth - 1],
        ]);
      }
    }
  }

  /** A tree that can grow without changing this one. */
  copy(): MimcTree {
    const tree = new MimcTree(this.levels);
    this.layers.forEach((layer, depth) => { tree.layers[depth] = layer.slice(); });
    return tree;
  }

  root(): bigint {
    return this.layers[this.levels][0] ?? this.zeros[this.levels];
  }

  path(index: number): { pathElements: bigint[]; pathIndices: number[] } {
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    for (let depth = 0; depth < this.levels; depth += 1) {
      pathElements.push(this.layers[depth][(index >> depth) ^ 1] ?? this.zeros[depth]);
      pathIndices.push((index >> depth) & 1);
    }
    return { pathElements, pathIndices };
  }

  get size(): number { return this.layers[0].length; }

  /**
   * The frontier a contract holds: for each level, the node the next left-hand
   * insertion overwrote last, or the empty subtree where none has happened.
   */
  frontier(): bigint[] {
    return this.zeros.slice(0, this.levels).map((zero, level) => (this.size === 0
      ? zero
      : this.layers[level][((this.size - 1) >> level) & ~1]));
  }

  /** The root once the first `count` leaves were in. */
  rootAt(count: number): bigint {
    if (count === 0) return this.zeros[this.levels];
    let node = this.layers[0][count - 1];
    for (let level = 0, index = count - 1; level < this.levels; level += 1, index >>= 1) {
      node = index & 1 ? mimcSponge([this.layers[level][index - 1], node]) : mimcSponge([node, this.zeros[level]]);
    }
    return node;
  }

  /** The last `count` roots, oldest first, padded with the empty root. */
  recentRoots(count: number): bigint[] {
    return Array.from({ length: count }, (_, i) => this.rootAt(Math.max(0, this.size - count + 1 + i)));
  }
}
