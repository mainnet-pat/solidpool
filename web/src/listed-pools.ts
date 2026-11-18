// The pools /api/config serves, every one checked on chain. A deployment names its own and an
// indexer finds the rest from the factories' PoolCreated events, but neither's word proves a pool is
// a factory's: anyone can make a pool of the same code outside a factory, through a plain genesis with
// a second master kept back, and a page that listed it would expose depositors to it. So a pool is
// served only once `factoryPools` finds it, with its amount and asset, among the creations of the
// deployment's own factory of its kind, read here from the chain through the deployment's Fulcrum
// server (listing.ts has why). What a read showed is kept and read again in the background once a
// minute, so a request reads nothing itself once the first read is in; while the chain cannot be
// read, only pools seen made before are served, and a pool never seen made is never served. The page
// checks the same again by its own reads before every deposit and withdrawal, and in Trustless
// before it lists anything. The app's server runs this, for /api/config.
//
// It reads the server as the page does: the factory's own chain, back by txid from the coins that
// hold its master now, and an event address's history only where the server lists none of them,
// vouched for by the address's first transaction (`wholeHistory`). Anyone can pad that address past
// the server's `max_history`, and past it Fulcrum answers as if it had no history: read without
// those, a padded address emptied this list for everyone.
import { Fulcrum } from './fulcrum';
import type { ChainReader } from './factory';
import { POOL_KINDS, factoriesMade, isMadeAs, isPoolId, type Factories, type MadePool } from './listing';
import type { PoolKind } from './pools';

/** A pool as a deployment or an indexer lists it. */
export interface DeploymentPool {
  id: string;
  kind: PoolKind;
  name: string;
  symbol: string;
  decimals: number;
  denomination: string;
  category: string;
  asset?: string;
}

/** What the merge needs of a network's config. */
export interface ListingConfig {
  network: string;
  fulcrumUrl: string;
  factories?: Factories;
  pools: DeploymentPool[];
}

const HEX64 = /^[0-9a-f]{64}$/i;

/** A pool from an indexer's /pools, before anything trusts it. */
function isPool(value: unknown): value is DeploymentPool {
  const pool = value as Partial<DeploymentPool> | null;
  return Boolean(pool)
    && typeof pool!.id === 'string' && typeof pool!.category === 'string' && HEX64.test(pool!.category)
    && (pool!.kind === 'bch' || pool!.kind === 'token')
    && typeof pool!.name === 'string' && typeof pool!.symbol === 'string'
    && Number.isInteger(pool!.decimals)
    && typeof pool!.denomination === 'string' && /^\d+$/.test(pool!.denomination)
    && (pool!.kind === 'bch' || (typeof pool!.asset === 'string' && HEX64.test(pool!.asset)));
}

/**
 * A pool as this app lists it: its category and a token pool's asset in lowercase, as the chain
 * names them, and an id that names no other pool (isPoolId). Undefined for a pool whose id would.
 */
function listedForm<T extends DeploymentPool>(pool: T): T | undefined {
  if (!isPoolId(pool.id, pool.category)) return undefined;
  const category = pool.category.toLowerCase();
  return {
    ...pool, id: HEX64.test(pool.id) ? category : pool.id, category,
    ...(pool.asset === undefined ? {} : { asset: pool.asset.toLowerCase() }),
  };
}

/** The pools an indexer's /pools names, in the form this app lists them, or none when it cannot say in time. */
export async function indexerPools(indexerUrl: string): Promise<DeploymentPool[]> {
  try {
    const response = await fetch(`${indexerUrl.replace(/\/+$/, '')}/pools`, {
      cache: 'no-store', signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return [];
    const body = await response.json() as { pools?: unknown };
    return Array.isArray(body.pools)
      ? body.pools.filter(isPool).map(listedForm).filter((pool): pool is DeploymentPool => pool !== undefined)
      : [];
  } catch { return []; }
}

/** How long what a read showed is served before it is read again, and how soon a failed read is tried again. */
const FRESH_MS = 60_000;
const RETRY_MS = 10_000;
/** How long a request waits for the first read through a server, when nothing was seen before. */
const FIRST_WAIT_MS = 10_000;
/**
 * The bytes of transactions kept from one server. A factory's own transactions are few, but a
 * transaction can be large, and anyone can pad an event address a fallback read has to go through.
 */
const MOST_KEPT_BYTES = 16_000_000;

const readers = new Map<string, ChainReader>();

/** What the factories of one deployment, read through one server, were last seen to have made. */
interface Seen {
  /** The pools seen made, by category; undefined until a read succeeds. */
  made?: Map<string, MadePool>;
  /** When to read again. */
  next: number;
  reading?: Promise<void>;
}
const seen = new Map<string, Seen>();

const timeout = (ms: number) => new Promise<undefined>((resolve) => {
  const timer = setTimeout(() => resolve(undefined), ms);
  (timer as { unref?: () => void }).unref?.();
});

/**
 * Transactions by txid, read once each while they fit: once those read hold more than `budget`
 * bytes, the oldest are dropped first. A read that fails is not kept.
 */
export class KeptTransactions {
  private readonly kept = new Map<string, Promise<string>>();
  private readonly sizes = new Map<string, number>();
  /** The bytes of the transactions kept now. */
  bytes = 0;

  constructor(private readonly budget: number) {}

  get(txid: string, read: (txid: string) => Promise<string>): Promise<string> {
    const known = this.kept.get(txid);
    if (known) return known;
    const reading = read(txid);
    this.kept.set(txid, reading);
    reading.then((hex) => {
      if (this.kept.get(txid) !== reading) return;
      const size = typeof hex === 'string' ? hex.length / 2 : 0;
      this.sizes.set(txid, size);
      this.bytes += size;
      for (const oldest of this.kept.keys()) {
        if (this.bytes <= this.budget) break;
        // A read still under way has no size yet, and stays.
        if (oldest === txid || !this.sizes.has(oldest)) continue;
        this.bytes -= this.sizes.get(oldest)!;
        this.sizes.delete(oldest);
        this.kept.delete(oldest);
      }
    }, () => {
      if (this.kept.get(txid) === reading) this.kept.delete(txid);
    });
    return reading;
  }
}

/**
 * One server's reads for this process, every one the page's own readers make: a lock's history,
 * its mempool part and its first transaction, its coins, and transactions by txid and height. A
 * transaction never changes, so each is read once while it fits (KeptTransactions).
 */
function serverReader(url: string): ChainReader {
  let reader = readers.get(url);
  if (!reader) {
    const fulcrum = new Fulcrum(url);
    const kept = new KeptTransactions(MOST_KEPT_BYTES);
    reader = {
      history: (scripthash, fromHeight) => fulcrum.history(scripthash, fromHeight),
      firstUse: (scripthash) => fulcrum.firstUse(scripthash),
      mempool: (scripthash) => fulcrum.mempool(scripthash),
      listUnspent: (scripthash) => fulcrum.listUnspent(scripthash),
      transactionHeight: (txid) => fulcrum.transactionHeight(txid),
      transaction: (txid) => kept.get(txid, (id) => fulcrum.transaction(id)),
    };
    readers.set(url, reader);
  }
  return reader;
}

/**
 * Read the factories again. A factory that cannot be read keeps what it was seen to have made, and
 * a read that reaches none changes nothing; either is tried again soon.
 */
function readAgain(entry: Seen, config: ListingConfig, reader: ChainReader): Promise<void> {
  entry.reading ??= factoriesMade(reader, config.factories, config.network).then(({ made, unread }) => {
    const named = POOL_KINDS.filter((kind) => config.factories?.[kind]);
    if (unread.length >= named.length) {
      entry.next = Date.now() + RETRY_MS;
      return;
    }
    for (const pool of entry.made?.values() ?? []) if (unread.includes(pool.kind)) made.set(pool.category, pool);
    entry.made = made;
    entry.next = Date.now() + (unread.length > 0 ? RETRY_MS : FRESH_MS);
  }, () => { entry.next = Date.now() + RETRY_MS; }).finally(() => { entry.reading = undefined; });
  return entry.reading;
}

/**
 * What the deployment's factories were seen to have made. A request waits for a read only when
 * nothing was seen before, or when it asks for a `refresh`; otherwise it takes what was, and a read
 * due by then runs beside it.
 */
async function factoriesSeen(config: ListingConfig, reader: ChainReader, refresh: boolean): Promise<Map<string, MadePool> | undefined> {
  const key = JSON.stringify([config.network, config.fulcrumUrl, config.factories]);
  let entry = seen.get(key);
  if (!entry) {
    entry = { next: 0 };
    seen.set(key, entry);
  }
  if (refresh || Date.now() >= entry.next) {
    const reading = readAgain(entry, config, reader);
    if (refresh) await reading;
    else if (!entry.made) await Promise.race([reading, timeout(FIRST_WAIT_MS)]);
  }
  return entry.made;
}

/**
 * The pools to serve: the deployment's, then those an indexer `discovered`, each only once it was
 * seen, with its amount and asset, among the creations of the deployment's own factory of its kind,
 * one for each category and each id, in the form this app lists them (listedForm). Nothing is served
 * with no factory to check against, and nothing that was never seen made. `refresh` reads the
 * factories again now, whatever was seen, and waits for that read.
 */
export async function poolsToServe(
  config: ListingConfig, discovered: DeploymentPool[],
  { reader = serverReader(config.fulcrumUrl), refresh = false }: { reader?: ChainReader; refresh?: boolean } = {},
): Promise<DeploymentPool[]> {
  if (!config.factories?.bch && !config.factories?.token) return [];
  const made = await factoriesSeen(config, reader, refresh);
  if (!made) return [];
  const served = new Set<string>();
  return [...config.pools, ...discovered].flatMap((listed) => {
    const pool = listedForm(listed);
    if (!pool || served.has(pool.category) || served.has(pool.id) || !isMadeAs(made.get(pool.category), pool)) return [];
    served.add(pool.category).add(pool.id);
    return [pool];
  });
}
