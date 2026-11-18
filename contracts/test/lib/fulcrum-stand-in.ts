// Fulcrum over a list of transactions, as it answers at its lowest `max_history`, 1,000 (Options.h:
// maxHistoryMin), read from its source (src/Storage.cpp):
// - getHistory counts a lock's whole confirmed history before any height range and answers nothing
//   past the limit. It counts the mempool's part after it, so past the limit by that part alone it
//   answers the confirmed part without it.
// - getFirstUse reads the first confirmed entry with no limit; with none, the first mempool
//   transaction that pays the lock, in txid order.
// - get_mempool counts the mempool's part alone.
// - listUnspent counts the mempool's coins first and then the confirmed ones, so past the limit it
//   answers the mempool's coins alone.
// Each transaction is confirmed at its height, 1 unless the chain names another, or in the mempool
// at height 0. The stand-in serves in process, with the method names of web/src/fulcrum.ts's
// client, or over HTTP JSON-RPC for code that makes its own client from a URL.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { binToHex, decodeTransaction, hash256, hexToBin, sha256 } from '@bitauth/libauth';

export const MAX_HISTORY = 1_000;

export interface StandInChain {
  transactions: string[];
  /** A transaction's height: 0 in the mempool. Unnamed ones are confirmed at height 1. */
  heights?: Map<string, number>;
  tip?: number;
  /** The coinbase of a block, by height, for blockchain.transaction.id_from_pos. */
  coinbases?: Map<number, string>;
}

export type StandInMethod = 'firstUse' | 'mempool' | 'listUnspent' | 'transactionHeight';

export const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());
export const scripthashOf = (lock: Uint8Array) => binToHex(sha256.hash(lock).slice().reverse());
const decode = (hex: string) => decodeTransaction(hexToBin(hex)) as any;

interface Indexed {
  key: string[];
  byTxid: Map<string, string>;
  decoded: Map<string, any>;
  /** Every transaction that pays a lock or spends from it, by scripthash, in the order given. */
  touching: Map<string, string[]>;
  /** The transactions that pay a lock, by scripthash. */
  paying: Map<string, Set<string>>;
  spent: Set<string>;
}

/**
 * A Fulcrum stand-in over `chain`, which may change under it. `without` leaves methods out, as a
 * reader before them had none. `lies` answers other bytes for a txid; `missing` has the server
 * answer that it has no such transaction.
 */
export function fulcrumStandIn(chain: StandInChain, { without = [] as StandInMethod[], lies = new Map<string, string>(), missing = new Set<string>() } = {}) {
  let indexed: Indexed | undefined;
  const index = (): Indexed => {
    if (indexed?.key === chain.transactions) return indexed;
    const byTxid = new Map(chain.transactions.map((hex) => [txidOf(hex), hex]));
    const decoded = new Map(chain.transactions.map((hex) => [txidOf(hex), decode(hex)]));
    const touching = new Map<string, string[]>();
    const paying = new Map<string, Set<string>>();
    const spent = new Set<string>();
    const touch = (lock: Uint8Array, txid: string) => {
      const list = touching.get(scripthashOf(lock)) ?? [];
      if (!list.includes(txid)) list.push(txid);
      touching.set(scripthashOf(lock), list);
    };
    for (const [txid, tx] of decoded) {
      for (const input of tx.inputs) {
        const parent = binToHex(input.outpointTransactionHash);
        spent.add(`${parent}:${input.outpointIndex}`);
        const output = decoded.get(parent)?.outputs[input.outpointIndex];
        if (output) touch(output.lockingBytecode, txid);
      }
      for (const output of tx.outputs) {
        touch(output.lockingBytecode, txid);
        const set = paying.get(scripthashOf(output.lockingBytecode)) ?? new Set<string>();
        set.add(txid);
        paying.set(scripthashOf(output.lockingBytecode), set);
      }
    }
    indexed = { key: chain.transactions, byTxid, decoded, touching, paying, spent };
    return indexed;
  };
  const heightOf = (txid: string) => chain.heights?.get(txid) ?? 1;
  const order = (txids: string[]) => {
    const at = new Map(index().key.map((hex, i) => [txidOf(hex), i]));
    return txids.slice().sort((a, b) => (heightOf(a) - heightOf(b)) || (at.get(a)! - at.get(b)!));
  };
  const parts = (scripthash: string) => {
    const list = index().touching.get(scripthash) ?? [];
    return { confirmed: order(list.filter((txid) => heightOf(txid) > 0)), pending: list.filter((txid) => heightOf(txid) <= 0) };
  };
  const entry = (tx_hash: string) => ({ tx_hash, height: heightOf(tx_hash) });

  const reader: any = {
    url: 'ws://fulcrum.stand-in',
    /** Transactions read by txid, and their bytes. */
    reads: 0,
    bytes: 0,
    calls: [] as string[],
    async history(scripthash: string, fromHeight = 0) {
      reader.calls.push('history');
      const { confirmed, pending } = parts(scripthash);
      if (confirmed.length > MAX_HISTORY) return [];
      const shown = confirmed.filter((txid) => heightOf(txid) >= fromHeight).map(entry);
      return confirmed.length + pending.length > MAX_HISTORY ? shown : [...shown, ...pending.map(entry)];
    },
    async firstUse(scripthash: string) {
      reader.calls.push('firstUse');
      const { confirmed } = parts(scripthash);
      if (confirmed.length > 0) return entry(confirmed[0]);
      const [first] = [...(index().paying.get(scripthash) ?? [])].filter((txid) => heightOf(txid) <= 0).sort();
      return first === undefined ? null : { tx_hash: first, height: 0 };
    },
    async mempool(scripthash: string) {
      reader.calls.push('mempool');
      const { pending } = parts(scripthash);
      return pending.length > MAX_HISTORY ? [] : pending.map(entry);
    },
    async listUnspent(scripthash: string) {
      reader.calls.push('listUnspent');
      const { decoded, spent } = index();
      const coins: any[] = [];
      for (const [txid, tx] of decoded) {
        tx.outputs.forEach((output: any, vout: number) => {
          if (spent.has(`${txid}:${vout}`) || scripthashOf(output.lockingBytecode) !== scripthash) return;
          const { token } = output;
          coins.push({
            tx_hash: txid, tx_pos: vout, height: Math.max(heightOf(txid), 0), value: Number(output.valueSatoshis),
            ...(token ? { token_data: {
              category: binToHex(token.category), amount: String(token.amount),
              ...(token.nft ? { nft: { capability: token.nft.capability, commitment: binToHex(token.nft.commitment) } } : {}),
            } } : {}),
          });
        });
      }
      const pending = coins.filter((coin) => coin.height === 0);
      if (pending.length > MAX_HISTORY) return [];
      return coins.length > MAX_HISTORY ? pending : coins;
    },
    /**
     * Storage::getBalance: the confirmed coins' sum, then the mempool's change to it. Past the
     * limit it has tallied the confirmed coins it counted so far, and nothing of the mempool.
     */
    async balance(scripthash: string) {
      reader.calls.push('balance');
      const { decoded } = index();
      const confirmedSpends = new Set<string>();
      const pendingSpends = new Set<string>();
      for (const [txid, tx] of decoded) {
        for (const input of tx.inputs) (heightOf(txid) > 0 ? confirmedSpends : pendingSpends).add(`${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`);
      }
      const at = (want: (txid: string) => boolean) => [...decoded].flatMap(([txid, tx]) => (want(txid) ? tx.outputs.map((output: any, vout: number) => ({ txid, vout, output })) : []))
        .filter(({ output }) => scripthashOf(output.lockingBytecode) === scripthash);
      const confirmed = at((txid) => heightOf(txid) > 0).filter(({ txid, vout }) => !confirmedSpends.has(`${txid}:${vout}`));
      const sum = (coins: Array<{ output: any }>) => coins.reduce((total, { output }) => total + Number(output.valueSatoshis), 0);
      if (confirmed.length > MAX_HISTORY) return { confirmed: sum(confirmed.slice(0, MAX_HISTORY)), unconfirmed: 0 };
      const added = at((txid) => heightOf(txid) <= 0).filter(({ txid, vout }) => !pendingSpends.has(`${txid}:${vout}`));
      const taken = confirmed.filter(({ txid, vout }) => pendingSpends.has(`${txid}:${vout}`));
      return { confirmed: sum(confirmed), unconfirmed: sum(added) - sum(taken) };
    },
    async transaction(txid: string) {
      reader.calls.push('transaction');
      const hex = lies.get(txid) ?? (missing.has(txid) ? undefined : index().byTxid.get(txid));
      if (hex === undefined) throw new Error('No transaction matching the requested hash was found');
      reader.reads += 1;
      reader.bytes += hex.length / 2;
      return hex;
    },
    async transactionHeight(txid: string) {
      if (missing.has(txid) || !index().byTxid.has(txid)) throw new Error('No transaction matching the requested hash was found');
      return Math.max(heightOf(txid), 0);
    },
    async call(method: string, params: any[] = []) {
      if (method === 'blockchain.headers.get_tip') return { height: chain.tip ?? 100 };
      if (method === 'blockchain.transaction.id_from_pos') return chain.coinbases?.get(params[0]) ?? '00'.repeat(32);
      return null;
    },
    async subscribeScripthash() { return () => undefined; },
    async subscribeHeaders() { return () => undefined; },
    close() { /* nothing open */ },
  };
  for (const method of without) delete reader[method];
  return reader;
}

/** The JSON-RPC methods a Fulcrum client asks, answered by a stand-in. */
const METHODS: Record<string, (reader: any, params: any[]) => Promise<unknown>> = {
  'server.version': async () => ['Fulcrum 2.1.3', '1.5'],
  'server.ping': async () => null,
  'blockchain.headers.get_tip': (reader) => reader.call('blockchain.headers.get_tip'),
  'blockchain.transaction.id_from_pos': (reader, params) => reader.call('blockchain.transaction.id_from_pos', params),
  'blockchain.scripthash.get_history': (reader, [scripthash, from]) => reader.history(scripthash, from),
  'blockchain.scripthash.get_first_use': (reader, [scripthash]) => reader.firstUse(scripthash),
  'blockchain.scripthash.get_mempool': (reader, [scripthash]) => reader.mempool(scripthash),
  'blockchain.scripthash.listunspent': (reader, [scripthash]) => reader.listUnspent(scripthash),
  'blockchain.scripthash.get_balance': (reader, [scripthash]) => reader.balance(scripthash),
  'blockchain.transaction.get': (reader, [txid]) => reader.transaction(txid),
  'blockchain.transaction.get_height': (reader, [txid]) => reader.transactionHeight(txid),
};

/** Serve a stand-in over HTTP JSON-RPC, as an app path or a Fulcrum behind a proxy would. */
export async function serveStandIn(reader: any): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', async () => {
      let id: unknown = null;
      let answer: unknown;
      try {
        const message = JSON.parse(body);
        id = message.id;
        requests.push(message.method);
        const method = METHODS[message.method];
        // A method the stand-in was made without fails here, as an older server's would.
        answer = method
          ? { result: await method(reader, message.params ?? []) }
          : { error: { code: -32601, message: `unknown method ${message.method}` } };
      } catch (error) {
        answer = { error: { code: 1, message: String((error as Error).message ?? error) } };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, ...(answer as object) }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

/** A stranger's transaction paying 1,000 sat to each of `locks`, from a coin of nowhere. */
let junkCount = 0;
export const junk = (...locks: Uint8Array[]): string => {
  junkCount += 1;
  return binToHex(encodeJunk(junkCount, locks));
};
function encodeJunk(serial: number, locks: Uint8Array[]): Uint8Array {
  // A minimal version-2 transaction, built by hand so the helper needs no builder.
  const le = (value: number, bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => (value / 2 ** (8 * i)) & 0xff);
  const outpoint = sha256.hash(Uint8Array.from([0x6a, 0x75, 0x6e, 0x6b, ...le(serial, 4)]));
  const parts: number[] = [...le(2, 4), 1, ...outpoint, ...le(0, 4), 0, ...le(0xffffffff, 4), locks.length];
  for (const lock of locks) parts.push(...le(1_000, 8), lock.length, ...lock);
  parts.push(...le(0, 4));
  return Uint8Array.from(parts);
}
/** `count` of them at `lock`: past the limit when `count` passes it. */
export const padding = (lock: Uint8Array, count = MAX_HISTORY + 1) => Array.from({ length: count }, () => junk(lock));
