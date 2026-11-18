// Which pools a page lists and deposits into: those its network's own factory of their kind made,
// as `factoryPools` reads them from the factory's `PoolCreated` events. /api/config, the page's
// Trustless list, and every deposit and withdrawal apply the same check, all but the first through
// the page's own servers.
//
// Anyone can make a pool of the same code outside a factory, through a plain genesis with a second
// master kept back, which could later pay out real proofs of a tree of its own. A factory's `create`
// mints its `PoolCreated` in the transaction that makes the pool, and that transaction spends the
// pool's deployer coin, whose covenant (`Deploy<C>`) pins the pool's genesis on chain: one master at
// the pool's code, the empty state, the pool's own coins, and nothing else of its category. An NFT of
// the factory's category that reads as a `PoolCreated` is no proof by itself: only the factory's
// refusal of any other output of its category keeps a creation from minting a stray one, for anyone
// to move to the event address. So every check here goes through `factoryPools`, which takes an
// event only where the factory's own `create` minted it, in the creation, beside the factory's
// master and the new pool's. A pool it lists has no second master,
// as long as the factory's own genesis holds none: the deployment names the factory, and
// verify-deployment.ts and the indexer check its genesis.
//
// All of it is read through a Fulcrum server, which the page trusts for what the chain holds: one
// that lies about the chain could show a pool made outside a factory as the factory's.
//
// Nothing waits for blocks to bury a genesis. Until they do, a pool's creation can be dropped, or
// replaced by another that spends the same deployer coin, under the same covenant, so a replacement
// is pinned the same way; it may name another amount. Either way every deposit built on the replaced
// creation is undone with it, and its coins go back to the wallet that paid them. A page reads the
// events again before each deposit, so it deposits into the creation the chain holds then (the
// user's decision of 2026-11-10: no wait before a page uses a new pool). A factory's own genesis is
// top-level and is checked from the mempool on too (the user's decision of 2026-11-18): by
// verify-deployment.ts before the app bundles the deployment that names it, by the app's server as
// it starts, and by the indexer. Until it is buried, only the deployer who spent its coin could
// replace it, with a second master in the replacement.
//
// A withdrawal is checked the same way before it is built, through the server it goes out on, and
// the note's kind, amount and asset must be what the factory made the pool for: a pool made elsewhere
// can be emptied by whoever made it, and a note's text must not claim another pool's terms. So a
// note withdraws whoever lists its pool, or nobody, once its network's factory made that pool.
// scripts/withdraw-note.ts --unlisted-pool withdraws from a pool made elsewhere, for someone who
// chooses that risk.
import { factoryPools, type ChainReader, type PoolCreated } from './factory';
import { HistoryLimit } from './fulcrum';
import { isPoolDenomination, type PoolKind } from './pools';

export const POOL_KINDS: readonly PoolKind[] = ['bch', 'token'];

/** The categories of a network's pool factories: its deployment's, or BCH_FACTORY's and TOKEN_FACTORY's. */
export type Factories = Partial<Record<PoolKind, string>> | null | undefined;

/** What one factory's `PoolCreated` event names, and which kind of factory minted it. */
export interface MadePool extends PoolCreated { kind: PoolKind }

/** What a listing says of a pool. */
export interface ListedPool { kind: PoolKind; category: string; denomination: string | bigint; asset?: string }

const amountOf = (pool: ListedPool): bigint | undefined => {
  try { return BigInt(pool.denomination); } catch { return undefined; }
};

const CATEGORY = /^[0-9a-f]{64}$/i;
/** A pool's name in a deployment, as deploy-pool.ts requires it: lowercase letters and digits. */
const NAME = /^[a-z0-9]+$/;

/**
 * Whether `id` may name the pool of category `category`: its own category, in either case, or a name
 * that cannot be read as a category. An older note names its pool by an id or by a category, and is
 * looked up by id first (note-text.ts), so an id that read as another pool's category would take that
 * pool's notes.
 */
export function isPoolId(id: string, category: string): boolean {
  if (typeof id !== 'string' || typeof category !== 'string') return false;
  if (CATEGORY.test(id)) return id.toLowerCase() === category.toLowerCase();
  return NAME.test(id);
}

/** Whether `made` names this pool: its kind, category and amount, and a token pool's asset. */
export function isMadeAs(made: MadePool | undefined, pool: ListedPool): boolean {
  if (!made || made.kind !== pool.kind || made.category !== pool.category.toLowerCase()) return false;
  if (amountOf(pool) !== 10n ** BigInt(made.exponent)) return false;
  return pool.kind === 'bch' ? made.asset === undefined && !pool.asset : made.asset === pool.asset?.toLowerCase();
}

/**
 * Every pool `factoryPools` finds among the creations of a network's factories, read through
 * `reader`, by category. `unread` holds the kinds whose factory could not be read. A kind with no
 * factory named is in neither, since no pool of it can be checked. `limits` holds, by kind, why a
 * factory could not be read when the server is past its `max_history`: a retry on that server can
 * never read it, so the page asks for another, but only where that kind's factory decides.
 */
export async function factoriesMade(
  reader: ChainReader, factories: Factories, network: string, kinds: readonly PoolKind[] = POOL_KINDS,
): Promise<{ made: Map<string, MadePool>; unread: PoolKind[]; limits: Partial<Record<PoolKind, HistoryLimit>> }> {
  const made = new Map<string, MadePool>();
  const unread: PoolKind[] = [];
  const limits: Partial<Record<PoolKind, HistoryLimit>> = {};
  await Promise.all(kinds.map(async (kind) => {
    const factory = factories?.[kind];
    if (!factory) return;
    let created: PoolCreated[];
    try {
      created = await factoryPools(reader, kind, factory.toLowerCase(), network);
    } catch (error) {
      unread.push(kind);
      if (error instanceof HistoryLimit) limits[kind] = error;
      return;
    }
    // The pool's constructor bounds its exponent where the pool is born, so a factory names no other.
    for (const pool of created) {
      if (isPoolDenomination(kind, 10n ** BigInt(pool.exponent))) made.set(pool.category, { ...pool, kind });
    }
  }));
  return { made, unread, limits };
}
