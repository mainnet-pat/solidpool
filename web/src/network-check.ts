// Which chain a Fulcrum server follows, and whether it can answer what this app asks. A network's
// name is only a name, so whatever acts on one asks the server first: a script before it spends,
// the indexer before it lists pools, a production build and server before they use the servers
// they are given, and the page before it keeps a custom server.
//
// The genesis checks read blockchain.scripthash.get_first_use, which Fulcrum added in 1.9.6
// (protocol 1.5.2). This app asks for 1.10 or later. An older server, or other software, cannot be
// told apart from an empty history there, so it is refused.
//
// The genesis alone does not settle it. Chipnet kept testnet4's genesis, and BTC, BSV and eCash
// kept mainnet's, so a server must also hold a block past the network's last split: one of BCHN's
// checkpoints (src/chainparams.cpp). The header after that block names it as its parent, so the
// check needs no hashing and runs the same in a page and in Node.
//
// A server that lies can answer all of this, so this catches a server of another chain, not a
// hostile one.

export type CheckedNetwork = 'mainnet' | 'chipnet' | 'regtest';

const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const TESTNET4_GENESIS = '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b';
const TESTNET3_GENESIS = '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
const SCALENET_GENESIS = '00000000e6453dc2dfe1ffa19023f86002eb11dbb8e87d0291a4599f0430be52';
const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

/** The chains a genesis may belong to, for messages. */
const GENESIS_NAMES: Record<string, string> = {
  [MAINNET_GENESIS]: 'mainnet, or a chain that split from it',
  [TESTNET4_GENESIS]: 'chipnet or testnet4',
  [TESTNET3_GENESIS]: 'testnet3',
  [SCALENET_GENESIS]: 'scalenet',
  [REGTEST_GENESIS]: 'regtest',
};

interface Marks {
  genesis: string;
  /** A block past the network's last split, from BCHN's checkpoints. */
  checkpoint?: { height: number; hash: string };
}

const MARKS: Record<CheckedNetwork, Marks> = {
  // The first block under the 2026 upgrade's rules, after BTC (478559), BSV (556767) and eCash
  // (661648) split away.
  mainnet: {
    genesis: MAINNET_GENESIS,
    checkpoint: { height: 951145, hash: '000000000000000000f64dbed68370486f945097ba90b17e30d7bf5c43df7a60' },
  },
  // A block after chipnet's 2026 upgrade, long after it split from testnet4 at block 115252.
  chipnet: {
    genesis: TESTNET4_GENESIS,
    checkpoint: { height: 284827, hash: '000000007af65a6e8853f858b3f2a8e7edabe41e6264410276705b324267d7d8' },
  },
  regtest: { genesis: REGTEST_GENESIS },
};

/** A JSON-RPC call to the server. */
export type ServerCall = (method: string, params: unknown[]) => Promise<unknown>;

/** How long one call to a server may take, its connection included when it is the first. */
export const CALL_TIMEOUT_MS = 8_000;

/** Whether this runtime can reach a server at `url`: a WebSocket URL needs the platform's WebSocket. */
export const reachableHere = (url: string): boolean => !/^wss?:\/\//i.test(url) || typeof WebSocket === 'function';

/**
 * JSON-RPC calls to one server: over its WebSocket, or over HTTP for an app path such as the
 * devnet's. It needs only the platform's WebSocket and fetch, so a page, a build and a server use it
 * alike. Each call has `timeoutMs` of its own, so a server that answers every call is checked
 * however many calls a check makes.
 */
export function serverCalls(url: string, timeoutMs = CALL_TIMEOUT_MS): { call: ServerCall; close: () => void } {
  const answer = (body: any) => {
    if (body?.error || body?.result === undefined) throw new Error(body?.error?.message ?? 'no answer');
    return body.result;
  };
  if (!/^wss?:\/\//i.test(url)) {
    let id = 0;
    return {
      call: async (method, params) => {
        id += 1;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return answer(await response.json());
      },
      close: () => undefined,
    };
  }
  if (typeof WebSocket !== 'function') throw new Error('this runtime has no WebSocket: run Node 22 or later');
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let id = 0;
  let socket: WebSocket | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    socket = new WebSocket(url);
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('no connection'));
    socket.onclose = () => {
      reject(new Error('closed'));
      for (const waiting of pending.values()) waiting.reject(new Error('closed'));
      pending.clear();
    };
    socket.onmessage = (event) => {
      let body: any;
      try { body = JSON.parse(String(event.data)); } catch { return; }
      const waiting = pending.get(body?.id);
      if (!waiting) return;
      pending.delete(body.id);
      try { waiting.resolve(answer(body)); } catch (error) { waiting.reject(error as Error); }
    };
  });
  opened.catch(() => undefined);
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      id += 1;
      const sent = id;
      const timer = setTimeout(() => {
        pending.delete(sent);
        reject(new Error(`no answer to ${method} in ${timeoutMs / 1000} s`));
      }, timeoutMs);
      const settle = <T>(done: (value: T) => void) => (value: T) => { clearTimeout(timer); done(value); };
      opened.then(() => {
        pending.set(sent, { resolve: settle(resolve), reject: settle(reject) });
        socket!.send(JSON.stringify({ jsonrpc: '2.0', id: sent, method, params }));
      }, settle(reject));
    }),
    close: () => { try { socket?.close(); } catch { /* already gone */ } },
  };
}

/** The oldest Fulcrum this app takes. Fulcrum answers blockchain.scripthash.get_first_use from 1.9.6 on. */
const LEAST_FULCRUM = { major: 1, minor: 10 };

/** Why a server's `server.version` answer names software this app cannot use, or undefined. */
export function serverSoftwareProblem(version: unknown): string | undefined {
  const software = Array.isArray(version) && typeof version[0] === 'string' ? version[0].trim() : '';
  const fulcrum = /^Fulcrum (\d+)\.(\d+)\b/.exec(software);
  const need = `the genesis checks need Fulcrum ${LEAST_FULCRUM.major}.${LEAST_FULCRUM.minor} or later (blockchain.scripthash.get_first_use)`;
  if (!fulcrum) return `it runs ${software ? `"${software.slice(0, 40)}"` : 'software that does not say what it is'}, and ${need}`;
  const [major, minor] = [Number(fulcrum[1]), Number(fulcrum[2])];
  if (major < LEAST_FULCRUM.major || (major === LEAST_FULCRUM.major && minor < LEAST_FULCRUM.minor)) return `it runs ${software}, and ${need}`;
  return undefined;
}

const HEADER_HEX = /^[0-9a-f]{160}$/i;

/** A header's parent, as a block hash is written: the bytes after the version, reversed. */
const parentOf = (header: string): string => (header.slice(8, 72).match(/../g) ?? []).reverse().join('').toLowerCase();

/** The genesis a server names in `server.features`, or undefined when it names none. */
export async function serverGenesis(call: ServerCall): Promise<string | undefined> {
  const features = await call('server.features', []) as { genesis_hash?: unknown } | null;
  const genesis = typeof features?.genesis_hash === 'string' ? features.genesis_hash.toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(genesis) ? genesis : undefined;
}

/** The public network a genesis is shared with, if it is mainnet's or chipnet's. */
export const publicChainOf = (genesis: string | undefined): string | undefined => (
  genesis === MAINNET_GENESIS || genesis === TESTNET4_GENESIS ? GENESIS_NAMES[genesis] : undefined);

/**
 * Why the server behind `call` will not do for `network`, or undefined when it will: it must run
 * Fulcrum 1.10 or later and follow that network. This opens the connection with its
 * `server.version`, which Fulcrum takes once, so nothing may send one before it. A server that does
 * not answer that throws, since it may only be down; one that answers and then cannot name its
 * chain is refused, since nothing should act on a chain it could not name.
 */
export async function serverNetworkProblem(network: CheckedNetwork, call: ServerCall): Promise<string | undefined> {
  const software = serverSoftwareProblem(await call('server.version', ['solidpool', '1.4']));
  if (software) return software;
  const marks = MARKS[network];
  let genesis: string | undefined;
  try {
    genesis = await serverGenesis(call);
  } catch {
    return 'it did not say which chain it follows (server.features)';
  }
  if (genesis === undefined) return 'it named no genesis block (server.features)';
  if (genesis !== marks.genesis) return `it follows ${GENESIS_NAMES[genesis] ?? `the chain of genesis ${genesis}`}, not ${network}`;
  if (!marks.checkpoint) return undefined;
  const { height, hash } = marks.checkpoint;
  let header: unknown;
  try {
    header = await call('blockchain.block.header', [height + 1]);
  } catch {
    return `it has no block ${height + 1}, so it is not a synced ${network} server`;
  }
  if (typeof header !== 'string' || !HEADER_HEX.test(header)) return `it answered block ${height + 1} with no header`;
  if (parentOf(header) !== hash) return `its block ${height} is not ${network}'s: it follows another chain with ${network}'s genesis`;
  return undefined;
}

/**
 * Mainnet and chipnet are read over TLS only, so nobody on the path can change what a server
 * says. The devnet's chain is a service on this machine, reached over plain WebSocket.
 */
export const tlsOnly = (network: string): boolean => network === 'mainnet' || network === 'chipnet';

/** Whether an IP address is this machine's or a private network's: loopback, private, shared or link-local. */
export function privateAddress(host: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes(':')) return false;
  // An IPv4 address mapped into IPv6, as written or as URL writes it (::ffff:a00:1 for 10.0.0.1).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (mapped) return privateAddress(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return privateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return host === '::' || host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host);
}

/**
 * Whether a URL names this machine or a host on its private network, where no stranger is on the
 * path: a private address, localhost, a name under .localhost, .local, .internal, .lan or .home,
 * or a single label such as a compose service.
 */
export function nearbyHost(url: string): boolean {
  let host: string;
  try { host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || privateAddress(host)) return true;
  return !host.includes('.') && !host.includes(':');
}

/**
 * Why `network` must not be read from `url`, if it must not. A page reads mainnet and chipnet over
 * TLS only. A script or the indexer, `nearbyPlain`, may also read them over a plain ws:// from this
 * machine or its private network, as from a Fulcrum beside it, and from nowhere else.
 */
export function serverUrlProblem(network: string, url: string, { nearbyPlain = false }: { nearbyPlain?: boolean } = {}): string | undefined {
  if (!tlsOnly(network)) return undefined;
  const value = url.trim();
  if (/^wss:\/\/[^/]/i.test(value)) return undefined;
  if (!nearbyPlain) return `${network} is read over TLS only, so name a wss:// server`;
  if (/^ws:\/\/[^/]/i.test(value) && nearbyHost(value)) return undefined;
  return `${network} is read over TLS, or over plain ws:// only from this machine or its private network, so name a wss:// server`;
}

/**
 * Ask the server at `url` whether it will do for `network` (serverNetworkProblem), each call within
 * `timeoutMs`. `unreachable` says it did not answer, which may only mean it is down; `problem` says
 * it answered and will not do, or that this runtime cannot reach it at all.
 */
export async function checkServerAt(
  url: string, network: CheckedNetwork, timeoutMs = CALL_TIMEOUT_MS,
): Promise<{ problem?: string; unreachable?: string }> {
  if (!reachableHere(url)) return { problem: 'this runtime has no WebSocket to reach it: run Node 22 or later' };
  let calls: ReturnType<typeof serverCalls>;
  try { calls = serverCalls(url, timeoutMs); } catch (error) { return { unreachable: String((error as Error).message ?? error) }; }
  try {
    const problem = await serverNetworkProblem(network, calls.call);
    return problem ? { problem } : {};
  } catch (error) {
    return { unreachable: String((error as Error)?.message ?? error) };
  } finally {
    calls.close();
  }
}
