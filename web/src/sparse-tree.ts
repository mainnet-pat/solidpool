// A sparse Merkle tree as the contracts walk it. A slot is the low `levels` bits of a 32-byte
// key read as a little-endian number; a pair hashes as sha256(0x03 || left || right); an empty
// subtree is that hash folded over 32 zero bytes. A pool's spent nullifiers are one of these,
// 64 levels deep, whose walk reads the key's lowest bit at the root; the token deployer's pools
// are another, 128 levels deep, whose walk halves the key from the leaf up, so it reads the
// lowest bit at the leaf.
import { sha256 } from './libauth';

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const pair = (left: Uint8Array, right: Uint8Array): Uint8Array => sha256.hash(concat(Uint8Array.of(0x03), left, right));
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** The empty subtree of each height, from a lone empty leaf up. */
const EMPTY: Uint8Array[] = [new Uint8Array(32)];
const emptyOf = (height: number): Uint8Array => {
  while (EMPTY.length <= height) EMPTY.push(pair(EMPTY[EMPTY.length - 1], EMPTY[EMPTY.length - 1]));
  return EMPTY[height];
};

export interface SparseEntry { key: Uint8Array; leaf: Uint8Array }

/** Bit `n` of a key read as a little-endian number. */
const bitOf = (key: Uint8Array, n: number): number => (key[n >> 3] >> (n & 7)) & 1;

/** Which end of the walk reads the key's lowest bit. */
export type LowBit = 'root' | 'leaf';

export class SparseTree {
  private readonly entries: SparseEntry[];

  constructor(readonly levels: number, entries: SparseEntry[] = [], readonly lowBit: LowBit = 'root') {
    this.entries = entries.slice();
  }

  /** A key's bit at depth `depth` from the root. */
  private bit(key: Uint8Array, depth: number): number {
    return bitOf(key, this.lowBit === 'root' ? depth : this.levels - 1 - depth);
  }

  private subtree(entries: SparseEntry[], depth: number): Uint8Array {
    if (entries.length === 0) return emptyOf(this.levels - depth);
    if (depth === this.levels) return entries[0].leaf;
    return pair(
      this.subtree(entries.filter((entry) => this.bit(entry.key, depth) === 0), depth + 1),
      this.subtree(entries.filter((entry) => this.bit(entry.key, depth) === 1), depth + 1),
    );
  }

  root(): Uint8Array {
    return this.subtree(this.entries, 0);
  }

  /** The entry whose key falls in the same slot as `key`, if any. */
  at(key: Uint8Array): SparseEntry | undefined {
    return this.entries.find((entry) => {
      for (let depth = 0; depth < this.levels; depth += 1) if (this.bit(entry.key, depth) !== this.bit(key, depth)) return false;
      return true;
    });
  }

  has(leaf: Uint8Array): boolean {
    return this.entries.some((entry) => same(entry.leaf, leaf));
  }

  /** The siblings of `key`'s slot, leaf first, as the contracts take them. */
  path(key: Uint8Array): Uint8Array[] {
    const siblings: Uint8Array[] = [];
    let remaining = this.entries;
    for (let depth = 0; depth < this.levels; depth += 1) {
      const side = this.bit(key, depth);
      siblings.push(this.subtree(remaining.filter((entry) => this.bit(entry.key, depth) !== side), depth + 1));
      remaining = remaining.filter((entry) => this.bit(entry.key, depth) === side);
    }
    return siblings.reverse();
  }

  /** The tree with one more entry. A slot holds one leaf, so a taken slot is refused. */
  with(entry: SparseEntry): SparseTree {
    if (this.at(entry.key)) throw new Error('That slot of the tree is taken.');
    return new SparseTree(this.levels, [...this.entries, entry], this.lowBit);
  }
}
