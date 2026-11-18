// A note's text: what it names and how it is written, without the hashes of its secret, so the
// page can tell which pool a note is for before the engine loads. note.ts adds the hashes.
//
// A note names everything a withdrawal needs besides a chain server: the network, the pool's kind
// and category, a token pool's asset, the amount, and the secret. So any page, or a script with
// this project's modules, can withdraw it, whatever pools it lists.
//
//   bchnote-<network>-bch-<category>-<amount>-0x<secret>
//   bchnote-<network>-token-<category>-<asset>-<amount>-0x<secret>
//
// The network is the page's id for it (mainnet, chipnet, devnet). The category and asset are 64
// lowercase hex digits, the amount is the pool's denomination in its base units, satoshis or token
// units, and the secret is the note's 62-byte preimage: the nullifier, then the secret, 31 bytes
// each, little-endian.
//
// A note written before notes named their pool's kind named the pool by an id: a deployment's own,
// or for a pool a page made or an indexer found, its category. It named no network, kind or asset:
//
//   bchnote-<pool>-<amount>-0x<secret>          (and tornado-bch-…, from before the rename)
//
// Those still read. A page finds such a pool in its list by its id, or by its category among the
// pools its network's factories made.
import { LEGACY_NOTE_PREFIXES, NOTE_PREFIX } from './brand';
import type { PoolKind } from './pools';

export interface NoteText {
  /** What the note names its pool by: its category, or in an older note a deployment's id or a category. */
  poolId: string;
  /** The network its pool is on. An older note names none. */
  network?: string;
  /** The pool's kind, category and, for a token pool, asset. An older note names none of these. */
  kind?: PoolKind;
  category?: string;
  asset?: string;
  /** The pool's denomination, in its base units. */
  amount: bigint;
  /** The note's 62-byte preimage, in hex. */
  preimageHex: string;
}

/** The pool a note is written for. */
export interface NotePool {
  kind: PoolKind;
  category: string;
  asset?: string;
  denomination: bigint | string;
}

const HEX64 = '[0-9a-fA-F]{64}';
const SECRET = '0x(?<secret>[0-9a-fA-F]{124})';
const NETWORK = /^[a-z][a-z0-9]*$/;
const CATEGORY = /^[0-9a-f]{64}$/;
const CURRENT = new RegExp(
  `^${NOTE_PREFIX}-(?<network>[a-z][a-z0-9]*)-(?:bch-(?<bch>${HEX64})|token-(?<token>${HEX64})-(?<asset>${HEX64}))`
  + `-(?<amount>[1-9][0-9]*)-${SECRET}$`,
);
const OLDER = new RegExp(`^(?:${[NOTE_PREFIX, ...LEGACY_NOTE_PREFIXES].join('|')})-(?<pool>[a-z0-9]+)-(?<amount>\\d+)-${SECRET}$`);

/** What a note's text names, or undefined for text that is no note. */
export function readNoteText(text: string): NoteText | undefined {
  const trimmed = text.trim();
  const current = CURRENT.exec(trimmed)?.groups;
  if (current) {
    const kind: PoolKind = current.bch ? 'bch' : 'token';
    const category = (current.bch ?? current.token).toLowerCase();
    return {
      poolId: category,
      network: current.network,
      kind,
      category,
      ...(kind === 'token' ? { asset: current.asset.toLowerCase() } : {}),
      amount: BigInt(current.amount),
      preimageHex: current.secret.toLowerCase(),
    };
  }
  const older = OLDER.exec(trimmed)?.groups;
  if (!older) return undefined;
  return { poolId: older.pool, amount: BigInt(older.amount), preimageHex: older.secret.toLowerCase() };
}

/** A note's text, for a pool on `network`. */
export function writeNoteText(pool: NotePool, network: string, preimageHex: string): string {
  if (!NETWORK.test(network)) throw new Error(`A note names its network, and "${network}" is none.`);
  const category = pool.category.toLowerCase();
  const asset = pool.asset ? pool.asset.toLowerCase() : undefined;
  if (!CATEGORY.test(category)) throw new Error('A note names its pool by category: 64 hex digits.');
  if (pool.kind !== 'bch' && pool.kind !== 'token') throw new Error(`A pool is of kind bch or token, not ${pool.kind}.`);
  if (pool.kind === 'token' ? !CATEGORY.test(asset ?? '') : asset !== undefined) throw new Error('A token pool, and only a token pool, has an asset.');
  if (!/^[0-9a-fA-F]{124}$/.test(preimageHex)) throw new Error('A note\'s secret is 62 bytes.');
  const amount = BigInt(pool.denomination);
  if (amount < 1n) throw new Error('A note\'s amount is a whole number of base units.');
  const named = pool.kind === 'bch' ? `bch-${category}` : `token-${category}-${asset}`;
  return `${NOTE_PREFIX}-${network}-${named}-${amount}-0x${preimageHex.toLowerCase()}`;
}

/** Whether a note names its pool's category: every note does now, and an older one may, by its id. */
export const namesCategory = (note: NoteText): boolean => note.category !== undefined || CATEGORY.test(note.poolId);

/**
 * The pool a note is for among `pools`: by category, or for an older note by the id it carries,
 * then by that id as a category.
 */
export function poolOfNote<T extends { id: string; category?: string }>(note: NoteText, pools: readonly T[]): T | undefined {
  if (note.category !== undefined) return pools.find((pool) => pool.category?.toLowerCase() === note.category);
  return pools.find((pool) => pool.id === note.poolId)
    ?? (CATEGORY.test(note.poolId) ? pools.find((pool) => pool.category?.toLowerCase() === note.poolId) : undefined);
}
