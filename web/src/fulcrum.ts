// Minimal Electrum/Fulcrum client used by the browser trustless engine.
// Only the methods the app needs are implemented; all data comes from the
// user's chosen Fulcrum endpoint.
import { binToHex, cashAddressToLockingBytecode, hash256, sha256 } from './libauth.ts';
import { cacheGet, cachePut } from './cache.ts';
import { Notice } from './notice.ts';

export interface FulcrumUtxo {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  token_data?: {
    category: string;
    amount: string;
    nft?: { capability: string; commitment: string };
  };
}

export interface FulcrumHistoryItem {
  tx_hash: string;
  height: number;
}

/** The first transaction that paid a lock: its txid, and its height, 0 in the mempool. */
export interface FulcrumFirstUse {
  tx_hash: string;
  height: number;
}

/**
 * A server that cannot show all of a lock's history. Fulcrum counts every confirmed transaction
 * of a lock against its `max_history`, 125,000 unless its operator set more, before it looks at
 * any height range, and past it answers with an empty list, as if the lock had none. Anyone can
 * pay a lock that many transactions, about 1 BCH at 800 sat each, so this is refused rather than
 * read as an empty history: another server, or one whose operator raised the limit, can answer.
 */
export class HistoryLimit extends Notice {
  constructor(readonly scripthash: string) {
    super('This server cannot show all of the history this needs: an address has more transactions than it serves (Fulcrum\'s max_history). Switch to another server in Settings.');
  }
}

/** A server's answer for a txid whose bytes are another transaction's: the server lies. */
export class OtherBytes extends Error {}

/** What reads a lock's history: Fulcrum, or a stand-in for one. */
export interface HistoryReader {
  history(scripthash: string, fromHeight?: number): Promise<Array<{ tx_hash: string; height?: number }>>;
  /** Fulcrum 1.9.6 and later: a lock's first transaction, read without counting the rest. */
  firstUse?(scripthash: string): Promise<FulcrumFirstUse | null>;
  /** A lock's transactions in the mempool alone, which Fulcrum counts apart from the rest. */
  mempool?(scripthash: string): Promise<Array<{ tx_hash: string; height?: number }>>;
}

/**
 * A lock's whole history, refused with HistoryLimit when the server left some of it out. Fulcrum
 * counts a lock's confirmed history against its limit first, and past it answers with an empty
 * list, with no error. Its first use is read alone, with no limit, and is read first, so it is in
 * any history read after it, unless that history was cut. A server that cannot answer it says
 * nothing about the history, so its error stands.
 *
 * Fulcrum counts the mempool's part after the confirmed one, so past its limit by that part alone it
 * answers the confirmed part without it. `get_mempool` counts that part alone, so it is read too,
 * before the history so that a transaction confirmed in between is in one or the other, and what
 * the history lacks of it is added at its end, as Fulcrum lists the mempool.
 *
 * A reader that cannot name a lock's first transaction cannot tell an empty history from one its
 * server cut to nothing, so an empty answer from it is refused too. One it shows is the server's
 * whole confirmed part: Fulcrum cuts that part whole or not at all.
 */
export async function wholeHistory(reader: HistoryReader, scripthash: string): Promise<Array<{ tx_hash: string; height?: number }>> {
  const first = reader.firstUse ? await reader.firstUse(scripthash) : undefined;
  const pending = reader.mempool ? await reader.mempool(scripthash) : [];
  const entries = await reader.history(scripthash);
  const cut = first === undefined
    ? entries.length === 0
    : first !== null && !entries.some((entry) => entry.tx_hash === first.tx_hash);
  if (cut) throw new HistoryLimit(scripthash);
  const listed = new Set(entries.map((entry) => entry.tx_hash));
  const missing = pending.filter((entry) => !listed.has(entry.tx_hash));
  return missing.length === 0 ? entries : [...entries, ...missing];
}

export const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const scripthashOfLock = (lock: Uint8Array): string => bytesToHex(sha256.hash(lock).reverse());

export const scripthashOfAddress = (address: string): string => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return scripthashOfLock(decoded.bytecode);
};

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A call over one connection, before it is handed to anything else. */
export type ConnectionCall = (method: string, params: unknown[]) => Promise<unknown>;

export class Fulcrum {
  /**
   * Asked of every WebSocket connection any Fulcrum client in this process opens, the first and
   * each one after a reconnect, before a call or subscription goes over it: why the server behind
   * it will not do, or undefined. The indexer sets it, so a server that follows another chain
   * after a reconnect is refused there, as it was at the start.
   */
  static connectionCheck?: (url: string, call: ConnectionCall) => Promise<string | undefined>;

  readonly url: string;
  private nextId = 1;
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private readonly pending = new Map<number, PendingCall>();
  private readonly subscriptions = new Map<string, (status: string | null) => void>();
  private readonly headerListeners = new Set<(height: number) => void>();

  constructor(url: string, private readonly cacheKey = '') {
    this.url = url.replace(/\/+$/, '');
  }

  private isWebSocket(): boolean {
    return /^wss?:\/\//i.test(this.url);
  }

  private async connect(): Promise<WebSocket> {
    if (!this.url) throw new Error('Set a Fulcrum endpoint first.');
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.close();
        this.connecting = null;
        reject(new Error(`Fulcrum WebSocket timeout: ${this.url}`));
      }, 15_000);
      const opened = () => {
        this.socket = socket;
        this.connecting = null;
        for (const scripthash of this.subscriptions.keys()) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.scripthash.subscribe', params: [scripthash],
          }));
        }
        if (this.headerListeners.size > 0) {
          socket.send(JSON.stringify({
            jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.headers.subscribe', params: [],
          }));
        }
        resolve(socket);
      };
      socket.onopen = () => {
        clearTimeout(timer);
        const check = Fulcrum.connectionCheck;
        if (!check) { opened(); return; }
        check(this.url, (method, params) => this.send(socket, method, params)).then((problem) => {
          if (problem === undefined) { opened(); return; }
          this.connecting = null;
          socket.close();
          reject(new Error(`${this.url}: ${problem}`));
        }, (error) => {
          this.connecting = null;
          socket.close();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      socket.onerror = () => {
        clearTimeout(timer);
        this.connecting = null;
        reject(new Error(`Fulcrum WebSocket failed: ${this.url}`));
      };
      socket.onclose = () => {
        this.socket = null;
        this.connecting = null;
        for (const [, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Fulcrum WebSocket closed'));
        }
        this.pending.clear();
      };
      socket.onmessage = async (event) => {
        const text = typeof event.data === 'string' ? event.data : await (event.data as Blob).text();
        let body: any;
        try { body = JSON.parse(text); } catch { return; }
        if (typeof body !== 'object' || body === null) return;
        if (body.method === 'blockchain.scripthash.subscribe' && Array.isArray(body.params)) {
          this.subscriptions.get(body.params[0])?.(body.params[1] ?? null);
          return;
        }
        if (body.method === 'blockchain.headers.subscribe') {
          const height = Number(body.params?.[0]?.height);
          if (Number.isFinite(height)) for (const listener of this.headerListeners) listener(height);
          return;
        }
        const pending = this.pending.get(body.id);
        if (!pending) return;
        this.pending.delete(body.id);
        clearTimeout(pending.timer);
        if (body.error) pending.reject(new Error(body.error.message ?? String(body.error)));
        else pending.resolve(body.result);
      };
    });
    return this.connecting;
  }

  private async callWebSocket<T>(method: string, params: unknown[]): Promise<T> {
    return this.send<T>(await this.connect(), method, params);
  }

  /** One call over `socket`, answered through this client's message handler. */
  private send<T>(socket: WebSocket, method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Fulcrum ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.url) throw new Error('Set a Fulcrum endpoint first.');
    if (this.isWebSocket()) return this.callWebSocket<T>(method, params);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Fulcrum HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? String(body.error));
    return body.result as T;
  }

  close(): void {
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
  }

  async subscribeScripthash(scripthash: string, listener: (status: string | null) => void): Promise<() => void> {
    this.subscriptions.set(scripthash, listener);
    if (this.isWebSocket()) {
      const socket = await this.connect();
      socket.send(JSON.stringify({
        jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.scripthash.subscribe', params: [scripthash],
      }));
    }
    return () => {
      this.subscriptions.delete(scripthash);
      if (this.isWebSocket() && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({
          jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.scripthash.unsubscribe', params: [scripthash],
        }));
      }
    };
  }

  /** New block tips, for work that waits on confirmations without polling. */
  async subscribeHeaders(listener: (height: number) => void): Promise<() => void> {
    this.headerListeners.add(listener);
    if (this.isWebSocket()) {
      const socket = await this.connect();
      socket.send(JSON.stringify({
        jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.headers.subscribe', params: [],
      }));
    }
    return () => {
      this.headerListeners.delete(listener);
      if (this.isWebSocket() && this.headerListeners.size === 0 && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({
          jsonrpc: '2.0', id: this.nextId++, method: 'blockchain.headers.unsubscribe', params: [],
        }));
      }
    };
  }

  /**
   * A lock's history, from `fromHeight` on if given. That saves sending what lies before it, but
   * Fulcrum still counts all of it against its limit: see HistoryLimit and wholeHistory.
   */
  history(scripthash: string, fromHeight?: number): Promise<FulcrumHistoryItem[]> {
    return this.call('blockchain.scripthash.get_history', fromHeight ? [scripthash, fromHeight] : [scripthash]);
  }

  /** A lock's first transaction, or null for a lock nothing has paid. No limit stops it. */
  firstUse(scripthash: string): Promise<FulcrumFirstUse | null> {
    return this.call('blockchain.scripthash.get_first_use', [scripthash]);
  }

  /** A lock's transactions in the mempool, which Fulcrum counts against its limit apart from the rest. */
  mempool(scripthash: string): Promise<FulcrumHistoryItem[]> {
    return this.call('blockchain.scripthash.get_mempool', [scripthash]);
  }

  /** The height of a transaction's block, 0 while it is in the mempool. */
  transactionHeight(txid: string): Promise<number> {
    return this.call('blockchain.transaction.get_height', [txid]);
  }

  listUnspent(scripthash: string): Promise<FulcrumUtxo[]> {
    return this.call('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']);
  }

  /**
   * A lock's balance in satoshis: its confirmed coins, and the mempool's change to them. Past its
   * `max_history` Fulcrum has tallied the confirmed coins it counted so far, and none of the
   * mempool, so a lock it lists no coins of still shows a balance.
   */
  balance(scripthash: string): Promise<{ confirmed: number; unconfirmed: number }> {
    return this.call('blockchain.scripthash.get_balance', [scripthash, 'include_tokens']);
  }

  /**
   * A transaction by txid, refused unless its bytes are that txid's. A transaction is immutable,
   * so the trustless history re-reads it from IndexedDB, which keeps only bytes that passed.
   */
  async transaction(txid: string): Promise<string> {
    const key = this.cacheKey ? `tx:${this.cacheKey}:${txid}` : '';
    if (key) {
      const cached = await cacheGet<string>(key);
      if (typeof cached === 'string') return cached;
    }
    const hex = await this.call<string>('blockchain.transaction.get', [txid]);
    if (typeof hex !== 'string' || binToHex(hash256(hexToBytes(hex)).slice().reverse()) !== txid) {
      throw new OtherBytes(`a server answered with other bytes for ${txid}`);
    }
    if (key) void cachePut(key, hex);
    return hex;
  }

  broadcast(rawHex: string): Promise<string> {
    return this.call('blockchain.transaction.broadcast', [rawHex]);
  }

  /** The least fee the server's node relays, in satoshis per 1,000 bytes. Fulcrum says it in BCH. */
  async relayFee(): Promise<bigint> {
    const perKilobyte = Number(await this.call<number>('blockchain.relayfee'));
    if (!Number.isFinite(perKilobyte) || perKilobyte < 0) throw new Error('The server named no relay fee.');
    return BigInt(Math.round(perKilobyte * 1e8));
  }
}
