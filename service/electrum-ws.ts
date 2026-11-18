// The local chain's Electrum WebSocket surface. The page reads the devnet here, as it reads a real
// network's Fulcrum, and so does a wallet such as Cashonize, which only speaks Electrum over
// WebSocket; both wait on the subscriptions it serves. The HTTP endpoint in server.ts serves the
// same chain to scripts and tests.
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { binToHex, cashAddressToLockingBytecode, sha256 } from '@bitauth/libauth';
import type { LocalChain } from './chain';

interface AddressWatch {
  address: string;
  scripthash: string;
  status: string | null;
}

interface ClientState {
  addresses: Map<string, AddressWatch>;
  scripthashes: Map<string, AddressWatch | null>;
  header: number | null;
  transactions: Set<string>;
  reported: Set<string>;
  busy: boolean;
}

const scripthashOf = (address: string): string => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return binToHex(Uint8Array.from(sha256.hash(decoded.bytecode)).reverse());
};

/** A valid-shaped 80-byte header. The local chain has no proof of work, only a tip height. */
const headerAt = (height: number): string => {
  const header = new Uint8Array(80);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x20000000, true);
  view.setUint32(68, Math.floor(Date.now() / 1000), true);
  view.setUint32(72, 0x207fffff, true);
  view.setUint32(76, height >>> 0, true);
  return binToHex(header);
};

const historyOf = (chain: LocalChain, scripthash: string): Promise<{ tx_hash: string; height: number }[]> =>
  chain.rpc('blockchain.scripthash.get_history', [scripthash]) as Promise<{ tx_hash: string; height: number }[]>;

/** Electrum's subscription status: a hash over the history, or null for no history. */
const statusOf = async (chain: LocalChain, scripthash: string): Promise<string | null> => {
  const history = await historyOf(chain, scripthash);
  if (history.length === 0) return null;
  const text = history.map(({ tx_hash, height }) => `${tx_hash}:${height}:`).join('');
  return binToHex(sha256.hash(new TextEncoder().encode(text)));
};

const tipOf = async (chain: LocalChain) => {
  const height = await chain.provider.getBlockHeight();
  return { height, hex: headerAt(height) };
};

const balanceOf = async (chain: LocalChain, scripthash: string) => {
  const utxos = await chain.rpc('blockchain.scripthash.listunspent', [scripthash]) as { value: number }[];
  return { confirmed: utxos.reduce((sum, coin) => sum + coin.value, 0), unconfirmed: 0 };
};

const notify = (socket: WebSocket, method: string, params: unknown[]) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
};

async function handle(chain: LocalChain, socket: WebSocket, state: ClientState, method: string, params: any[]): Promise<unknown> {
  switch (method) {
    case 'server.version': return ['SolidPool devnet', '1.5'];
    case 'server.ping': return null;
    case 'server.banner': return 'SolidPool devnet';
    case 'server.donation_address': return '';
    case 'server.features':
      return {
        genesis_hash: '00'.repeat(32), hosts: {}, protocol_min: '1.4', protocol_max: '1.5',
        server_version: 'SolidPool devnet', hash_function: 'sha256',
      };
    case 'blockchain.headers.get_tip': return tipOf(chain);
    case 'blockchain.header.get':
    case 'blockchain.block.header': return headerAt(Number(params[0]));
    case 'blockchain.relayfee': return 0.00001;
    case 'blockchain.estimatefee': return 0.00001;
    case 'mempool.get_fee_histogram': return [];
    case 'blockchain.transaction.get_merkle': return { block_height: 0, merkle: [], pos: 0 };
    case 'blockchain.address.listunspent':
      return chain.rpc('blockchain.scripthash.listunspent', [scripthashOf(params[0])]);
    case 'blockchain.address.get_history':
      return chain.rpc('blockchain.scripthash.get_history', [scripthashOf(params[0])]);
    case 'blockchain.address.get_balance':
      return balanceOf(chain, scripthashOf(params[0]));
    case 'blockchain.scripthash.get_balance':
      return balanceOf(chain, params[0]);
    case 'blockchain.address.subscribe': {
      const address = String(params[0]);
      const watch = { address, scripthash: scripthashOf(address), status: await statusOf(chain, scripthashOf(address)) };
      state.addresses.set(address, watch);
      // A subscription's answer is the status; the notification gives the wallet the same
      // status in the shape its watch callback reads, [address, status].
      notify(socket, method, [address, watch.status]);
      return watch.status;
    }
    case 'blockchain.address.unsubscribe': state.addresses.delete(String(params[0])); return true;
    case 'blockchain.scripthash.subscribe': {
      const scripthash = String(params[0]);
      const status = await statusOf(chain, scripthash);
      state.scripthashes.set(scripthash, { address: '', scripthash, status });
      notify(socket, method, [scripthash, status]);
      return status;
    }
    case 'blockchain.scripthash.unsubscribe': state.scripthashes.delete(String(params[0])); return true;
    case 'blockchain.headers.subscribe': {
      const tip = await tipOf(chain);
      state.header = tip.height;
      notify(socket, method, [tip]);
      return tip;
    }
    case 'blockchain.headers.unsubscribe': state.header = null; return true;
    case 'blockchain.transaction.subscribe': {
      const txid = String(params[0]);
      state.transactions.add(txid);
      let confirmations: number | null = null;
      try { await chain.rpc('blockchain.transaction.get', [txid]); confirmations = 0; } catch { /* unknown yet */ }
      notify(socket, method, [txid, confirmations]);
      return null;
    }
    case 'blockchain.transaction.unsubscribe': state.transactions.delete(String(params[0])); return true;
    default: return chain.rpc(method, params);
  }
}

/** Serve the local chain at the service's WebSocket endpoint, ws://127.0.0.1:<port>. */
export function attachElectrumWebSocket(server: Server, chain: LocalChain): WebSocketServer {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    const state: ClientState = {
      addresses: new Map(), scripthashes: new Map(), header: null, transactions: new Set(), reported: new Set(), busy: false,
    };
    const timer = setInterval(() => {
      if (state.busy) return;
      state.busy = true;
      void (async () => {
        try {
          for (const watch of state.addresses.values()) {
            const status = await statusOf(chain, watch.scripthash);
            if (status !== watch.status) {
              watch.status = status;
              notify(socket, 'blockchain.address.subscribe', [watch.address, status]);
            }
          }
          for (const watch of state.scripthashes.values()) {
            if (watch === null) continue;
            const status = await statusOf(chain, watch.scripthash);
            if (status !== watch.status) {
              watch.status = status;
              notify(socket, 'blockchain.scripthash.subscribe', [watch.scripthash, status]);
            }
          }
          if (state.header !== null) {
            const height = await chain.provider.getBlockHeight();
            if (height !== state.header) {
              state.header = height;
              notify(socket, 'blockchain.headers.subscribe', [{ height, hex: headerAt(height) }]);
            }
          }
          for (const txid of state.transactions) {
            if (state.reported.has(txid)) continue;
            try {
              await chain.rpc('blockchain.transaction.get', [txid]);
              state.reported.add(txid);
              notify(socket, 'blockchain.transaction.subscribe', [txid, 0]);
            } catch { /* still unknown */ }
          }
        } finally {
          state.busy = false;
        }
      })();
    }, 1_500);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
    socket.on('message', (raw) => {
      void (async () => {
        let request: { id?: number; method?: string; params?: any[] };
        try { request = JSON.parse(String(raw)); } catch { return; }
        if (typeof request.method !== 'string') return;
        try {
          const result = await handle(chain, socket, state, request.method, request.params ?? []);
          if (request.id !== undefined) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        } catch (error) {
          if (request.id !== undefined) {
            socket.send(JSON.stringify({
              jsonrpc: '2.0', id: request.id, error: { code: 1, message: String((error as Error).message ?? error) },
            }));
          }
        }
      })();
    });
  });
  return wss;
}
