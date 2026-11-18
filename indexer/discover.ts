// Discover pools from the factories' PoolCreated events. The only pool input is each factory's
// category: its coins' locks and its event address follow from it, an event names the pool's
// category, exponent and token asset, and the genesis checks below prove the rest before a pool
// is served.
//
// The events are read from the factory's own chain, by txid, from the transaction that holds its
// master now back to its genesis (lineage.ts): every `create` moves the master and mints its
// pool's event there. Anyone can pad the event address's history, and past Fulcrum's
// `max_history` a server answers it as if it had none and stops notifying it. So that history is
// read only where the server shows neither of the factory's coins, every new block reads each
// factory again, and a server that cut a history short is logged as such (HistoryLimit), never
// taken for a factory with no pools.
//
// A factory's own genesis is checked first, as soon as the server shows it: a second master kept
// there could mint any PoolCreated, so nothing a factory names is checked or served until then.
// Nothing waits for blocks to bury a genesis (scripts/lib/genesis.ts says what that leaves). An event
// counts only two outputs after the factory's own master, where `create` writes it (createdAt in
// factory.ts), and not wherever else an NFT of the factory's category sits. Each pool an event
// names must have been made through that factory, its creation holding that event beside the
// factory's master. The factory refuses a second pool of an amount, or of an asset and amount,
// on chain, so the pools served are one per amount.
import { Fulcrum, HistoryLimit, scripthashOfAddress, wholeHistory } from '../web/src/fulcrum';
import { headOf, lineage, readTransaction, type Decoded } from '../web/src/lineage';
import { FulcrumProvider } from '../web/src/provider';
import { PoolClient, type PoolDefinition } from '../web/src/pool-client';
import { resolveBcmr } from '../web/src/bcmr';
import { DENOMINATION_EXPONENTS, type PoolKind } from '../web/src/pools';
import {
  factoryCoinLocks, factoryMarks, poolCreatedAddress, poolsCreatedIn, type FactoryMarks, type PoolCreated,
} from '../web/src/factory';
import { factoryGenesisProblems, genesisProblems } from '../scripts/lib/genesis';
import type { Archive, DeployedPool } from '../service/archive';

export interface Factory { kind: PoolKind; category: string }
type Followed = Factory & {
  address: string;
  /** The factory's master's lock and its event address, which mark its events. */
  marks: FactoryMarks;
  /** Where the factory's master and state record sit. */
  coinLocks: Uint8Array[];
  sound: boolean;
  nextTry: number;
  /** The factory's transactions read so far, newest first. */
  walked: string[];
  /** Its genesis, once a walk reached it. */
  genesis?: string;
  /** The pools its events name, each from the transaction last read holding its event. */
  created: Map<string, PoolCreated>;
};
type Candidate = {
  kind: PoolKind;
  category: string;
  exponent: number;
  asset?: string;
  creator: string;
  /** The transaction its event was read from: its creation. */
  creation?: string;
  nextTry: number;
};

const RETRY_MS = 60_000;

/** The exponents each pool's constructor accepts (6..10 BCH, 0..12 token). */
const inRange = (kind: PoolKind, exponent: number): boolean => (
  Number.isInteger(exponent) && exponent >= DENOMINATION_EXPONENTS[kind].least && exponent <= DENOMINATION_EXPONENTS[kind].most
);

/** An error as an operator should read it: the page's words for a server's limit name no setting. */
const explain = (error: unknown, url: string): string => (error instanceof HistoryLimit
  ? `the Fulcrum at ${url} answers a history as empty because it is longer than that server's max_history. Point FULCRUM_URL at a server whose max_history is higher.`
  : String((error as Error)?.message ?? error));

export class Discovery {
  readonly pools = new Map<string, DeployedPool>();
  private readonly pending = new Map<string, Candidate>();
  private readonly seen = new Set<string>();
  private readonly cleanups: Array<() => void> = [];
  private readonly debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queue = new Map<string, Promise<void>>();
  private keepAlive?: ReturnType<typeof setInterval>;
  private readonly reader: Fulcrum;
  private readonly provider: FulcrumProvider;
  private readonly archive: Archive;
  readonly factories: Followed[];

  /** `fulcrum` is a WebSocket URL, or a client of one. */
  constructor(
    private readonly network: 'mainnet' | 'chipnet' | 'regtest',
    fulcrum: string | Fulcrum,
    factories: Factory[],
    private readonly bcmrServiceUrl: string | undefined,
    archive: Archive,
  ) {
    this.reader = typeof fulcrum === 'string' ? new Fulcrum(fulcrum) : fulcrum;
    this.provider = new FulcrumProvider(network, this.reader);
    this.archive = archive;
    this.factories = factories.map((factory) => ({
      ...factory,
      address: poolCreatedAddress(factory.kind, factory.category, network),
      marks: factoryMarks(factory.kind, factory.category, network),
      coinLocks: factoryCoinLocks(factory.kind, factory.category, network),
      sound: false,
      nextTry: 0,
      walked: [],
      created: new Map(),
    }));
  }

  /**
   * Keep a Fulcrum subscription on each factory's event address and on new blocks, and read each
   * factory once now. A server stops notifying an address past its limit, so every block reads
   * each factory again, which also wakes pending checks: nothing needs polling to mature.
   */
  async start(): Promise<void> {
    if (!/^wss?:\/\//i.test(this.reader.url)) {
      throw new Error('The indexer needs a WebSocket Fulcrum (ws:// or wss://) to subscribe.');
    }
    // Subscribe before the first read so an event that lands during the scan is not missed.
    for (const factory of this.factories) {
      this.cleanups.push(await this.reader.subscribeScripthash(scripthashOfAddress(factory.address), () => this.notify(factory)));
    }
    this.cleanups.push(await this.reader.subscribeHeaders(() => {
      for (const factory of this.factories) this.notify(factory);
    }));
    for (const factory of this.factories) await this.rescan(factory);
    // A keepalive for the socket.
    this.keepAlive = setInterval(() => {
      void this.reader.call('server.ping').catch(() => undefined);
    }, 60_000);
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    if (this.keepAlive) clearInterval(this.keepAlive);
  }

  private notify(factory: Followed): void {
    const prior = this.debounce.get(factory.address);
    if (prior) clearTimeout(prior);
    this.debounce.set(factory.address, setTimeout(() => {
      this.debounce.delete(factory.address);
      const previous = this.queue.get(factory.address) ?? Promise.resolve();
      this.queue.set(factory.address, previous.then(() => this.rescan(factory)));
    }, 250));
  }

  /** Read a factory, check what is new, and log what went wrong rather than stop. */
  private async rescan(factory: Followed): Promise<void> {
    try {
      await this.read(factory);
      if (await this.isSound(factory)) this.consider(factory);
      await this.checkPending();
    } catch (error) {
      console.error(`scan ${factory.kind} ${factory.category}:`, explain(error, this.reader.url));
    }
  }

  /**
   * The factory's events that are new since the last read: from its own chain, back from the
   * transaction that holds its master now to the newest one read before, or to its genesis.
   */
  private async read(factory: Followed): Promise<void> {
    const head = await headOf(this.reader, factory.category, factory.coinLocks);
    if (head === undefined) {
      await this.readEventHistory(factory);
      return;
    }
    const known = new Set(factory.walked);
    let joined: string | undefined;
    const isKnown = (txid: string) => {
      if (known.has(txid)) joined = txid;
      return joined !== undefined;
    };
    const fresh: Array<{ txid: string; events: PoolCreated[] }> = [];
    for await (const link of lineage(this.reader, factory.category, head, isKnown)) {
      fresh.push({ txid: link.txid, events: poolsCreatedIn(factory.marks, link.transaction, link.txid) });
      if (link.parent === undefined) factory.genesis = link.txid;
    }
    factory.walked = [...fresh.map(({ txid }) => txid), ...(joined === undefined ? [] : factory.walked.slice(factory.walked.indexOf(joined)))];
    for (const { events } of fresh.reverse()) this.add(factory, events);
  }

  /**
   * The events in the event address's history, where the server shows none of the factory's
   * coins. A transaction is passed over only once it was read: one whose read failed is read again
   * at the next block, since it may hold an event.
   */
  private async readEventHistory(factory: Followed): Promise<void> {
    for (const { tx_hash: txid } of await wholeHistory(this.reader, scripthashOfAddress(factory.address))) {
      const key = `${factory.category}:${txid}`;
      if (this.seen.has(key)) continue;
      let transaction: Decoded;
      try {
        ({ transaction } = await readTransaction(this.reader, txid));
      } catch {
        continue;
      }
      this.seen.add(key);
      this.add(factory, poolsCreatedIn(factory.marks, transaction, txid));
    }
  }

  /**
   * Keep each pool's event from the transaction that holds it now. Whoever relays or mines a
   * creation can re-sign it under another txid, and one in the mempool can be replaced before a
   * block takes it, so an event read from another transaction than before replaces the one kept,
   * and a pool waiting on the old one is checked again against the new.
   */
  private add(factory: Followed, events: PoolCreated[]): void {
    for (const event of events) {
      const kept = factory.created.get(event.category);
      if (kept?.txid === event.txid) continue;
      factory.created.set(event.category, event);
      if (!kept || this.pools.has(event.category) || !this.pending.has(event.category)) continue;
      this.pending.delete(event.category);
      if (inRange(factory.kind, event.exponent)) this.pending.set(event.category, this.candidate(factory, event));
    }
  }

  /** A pool a factory's event names, to be checked from its first try. */
  private candidate(factory: Followed, created: PoolCreated): Candidate {
    return {
      kind: factory.kind,
      category: created.category,
      exponent: created.exponent,
      ...(created.asset ? { asset: created.asset } : {}),
      creator: factory.category,
      ...(created.txid ? { creation: created.txid } : {}),
      nextTry: 0,
    };
  }

  /** Whether the factory's genesis checks out; once it does, it always will. */
  private async isSound(factory: Followed): Promise<boolean> {
    if (factory.sound) return true;
    if (Date.now() < factory.nextTry) return false;
    const problems = await factoryGenesisProblems(factory.kind, factory.category, this.reader, this.provider, { genesis: factory.genesis })
      .catch((error) => [explain(error, this.reader.url)]);
    if (problems.length > 0) {
      factory.nextTry = Date.now() + RETRY_MS;
      console.log(`${factory.kind} factory ${factory.category.slice(0, 12)} not ready: ${problems[0]}`);
      return false;
    }
    factory.sound = true;
    console.log(`${factory.kind} factory ${factory.category.slice(0, 12)} checked`);
    return true;
  }

  /** Every pool a sound factory names that is neither served nor waiting yet. */
  private consider(factory: Followed): void {
    for (const created of factory.created.values()) {
      if (!inRange(factory.kind, created.exponent)) continue;
      if (this.pools.has(created.category) || this.pending.has(created.category)) continue;
      this.pending.set(created.category, this.candidate(factory, created));
    }
  }

  private async checkPending(): Promise<void> {
    for (const factory of this.factories) {
      if (!factory.sound && Date.now() >= factory.nextTry && await this.isSound(factory)) this.consider(factory);
    }
    for (const [category, candidate] of [...this.pending]) {
      if (Date.now() < candidate.nextTry) continue;
      try {
        await this.verify(candidate);
      } catch (error) {
        candidate.nextTry = Date.now() + RETRY_MS;
        console.error(`verify ${category}:`, explain(error, this.reader.url));
      }
    }
  }

  private async verify(candidate: Candidate): Promise<void> {
    const denomination = 10n ** BigInt(candidate.exponent);
    const definition: PoolDefinition = {
      id: candidate.category, kind: candidate.kind, denomination, category: candidate.category,
      ...(candidate.asset ? { asset: candidate.asset } : {}),
    };
    const client = new PoolClient(definition, this.provider);
    const problems = await genesisProblems(client, this.reader, candidate.creator, { creation: candidate.creation });
    if (problems.length > 0) {
      candidate.nextTry = Date.now() + RETRY_MS;
      console.log(`pool ${candidate.category.slice(0, 12)} not ready: ${problems[0]}`);
      return;
    }
    const identity = candidate.asset
      ? await resolveBcmr(this.reader, candidate.asset, { serviceUrl: this.bcmrServiceUrl }).catch(() => undefined)
      : undefined;
    const pool: DeployedPool = {
      id: candidate.category,
      kind: candidate.kind,
      name: candidate.kind === 'bch' ? 'Bitcoin Cash' : identity?.name ?? 'Token pool',
      symbol: candidate.kind === 'bch' ? 'BCH' : identity?.symbol ?? candidate.asset!.slice(0, 8),
      decimals: candidate.kind === 'bch' ? 8 : identity?.decimals ?? 0,
      denomination: denomination.toString(),
      category: candidate.category,
      ...(candidate.asset ? { asset: candidate.asset } : {}),
    };
    this.pools.set(pool.id, pool);
    this.archive.add(pool);
    this.pending.delete(candidate.category);
    console.log(`pool ${pool.name} ${pool.symbol} ${pool.denomination} ${pool.category.slice(0, 12)}…`);
  }
}
