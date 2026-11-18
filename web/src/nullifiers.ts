// The 64-level sparse tree of spent nullifiers, as the contracts walk it. A slot is
// the low 64 bits of sha256(nullifierHash) and holds the nullifier hash; the path
// runs from the leaf up.
import { sha256 } from './libauth';
import { SparseTree } from './sparse-tree';

const LEVELS = 64;

export const nullifierKey = (nullifierHash: Uint8Array): Uint8Array => sha256.hash(nullifierHash);
export const EMPTY_NULLIFIER_ROOT = new SparseTree(LEVELS).root();

export class NullifierTree {
  private readonly tree: SparseTree;

  /** `spent` holds nullifier hashes as the contract stores them: 32 bytes, little-endian. */
  constructor(spent: Uint8Array[]) {
    this.tree = new SparseTree(LEVELS, spent.map((leaf) => ({ key: nullifierKey(leaf), leaf })));
  }

  root(): Uint8Array {
    return this.tree.root();
  }

  has(nullifierHash: Uint8Array): boolean {
    return this.tree.has(nullifierHash);
  }

  /** The 64 siblings of a nullifier's slot, leaf first, as `withdraw` takes them. */
  path(nullifierHash: Uint8Array): Uint8Array[] {
    return this.tree.path(nullifierKey(nullifierHash));
  }
}
