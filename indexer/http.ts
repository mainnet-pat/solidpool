// The indexer's HTTP side. It is public: every browser reads a pool's archive from it, and the
// app's server its pool list. It serves public chain data, so any page may read it, but it answers
// reads only and bounds the work a request can cause: an archive is read from Fulcrum once however
// many ask at a time, and then kept for a few seconds, and one client may ask only so often.
// It writes no access log: a request's moment could be matched to a deposit or withdrawal.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DeployedPool } from '../service/archive';

export interface IndexerApi {
  network: string;
  pools(): DeployedPool[];
  /** Whether the archive holds a pool, before any work is done for it. */
  has(poolId: string): boolean;
  archive(poolId: string): Promise<unknown>;
}

export interface HttpOptions {
  /** How long a pool's archive is served before it is read again. */
  archiveCacheMs: number;
  /** Archive requests one client may make a minute; 0 leaves limits to a proxy in front. */
  archivePerMinute: number;
  /** Pool-list requests one client may make a minute, 120 unless named; 0 leaves limits to a proxy. */
  poolsPerMinute?: number;
  /** How long a client has for its headers, and for its whole request: 10 and 15 seconds unless named. */
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** How often those limits are enforced: every second unless named. */
  checkTimeoutsEveryMs?: number;
}

const LONGEST_URL = 512;
const POOL_PATH = /^\/archive\/([0-9a-zA-Z]{1,64})$/;
/** Clients counted in one minute before the count starts over, so the map stays small. */
const MOST_CLIENTS = 50_000;

/** Loopback, private and link-local peers: a proxy on this host or network, or Docker's port mapping. */
function nearby(address: string): boolean {
  const host = address.replace(/^::ffff:/, '');
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host);
}

/**
 * Who asks. A proxy nearby names the client it serves last in X-Forwarded-For; anyone else is its
 * own address, whatever the header claims. An IPv6 client is its /64, the block one subscriber
 * holds, so a client cannot count as a new one by moving to another of its addresses.
 */
export function clientOf(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  return networkOf(nearby(peer) ? forwarded.at(-1) ?? peer : peer);
}

/** An IPv4 address as itself, and an IPv6 address as its /64. */
export function networkOf(address: string): string {
  const host = address.replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase();
  if (!host.includes(':')) return host;
  const [head, tail = ''] = host.split('::');
  const left = head ? head.split(':') : [];
  const right = host.includes('::') && tail ? tail.split(':') : [];
  const groups = host.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || '0', 16).toString(16)).join(':')}::/64`;
}

/** A count of each client's requests in the current minute. */
class MinuteLimit {
  private minute = 0;
  private readonly counts = new Map<string, number>();

  constructor(private readonly perMinute: number) {}

  allow(client: string, now = Date.now()): boolean {
    if (this.perMinute <= 0) return true;
    const minute = Math.floor(now / 60_000);
    if (minute !== this.minute || this.counts.size >= MOST_CLIENTS) {
      this.minute = minute;
      this.counts.clear();
    }
    const count = (this.counts.get(client) ?? 0) + 1;
    this.counts.set(client, count);
    return count <= this.perMinute;
  }

  /** Seconds until the next minute starts. */
  retryAfter(now = Date.now()): number {
    return Math.max(1, Math.ceil((60_000 - (now % 60_000)) / 1000));
  }
}

/** Each pool's archive as served: one read at a time, kept for `ttl` milliseconds. */
class ArchiveCache {
  private readonly kept = new Map<string, { body: string; at: number }>();
  private readonly reading = new Map<string, Promise<string>>();

  constructor(private readonly read: (poolId: string) => Promise<unknown>, private readonly ttl: number) {}

  async get(poolId: string): Promise<string> {
    const kept = this.kept.get(poolId);
    if (kept && Date.now() - kept.at < this.ttl) return kept.body;
    let pending = this.reading.get(poolId);
    if (!pending) {
      pending = this.read(poolId).then((archive) => {
        const body = JSON.stringify(archive);
        this.kept.set(poolId, { body, at: Date.now() });
        return body;
      }).finally(() => { this.reading.delete(poolId); });
      this.reading.set(poolId, pending);
    }
    return pending;
  }
}

/** The indexer's server, not yet listening. */
export function indexerServer(api: IndexerApi, options: HttpOptions): Server {
  const limit = new MinuteLimit(options.archivePerMinute);
  const poolsLimit = new MinuteLimit(options.poolsPerMinute ?? 120);
  const archives = new ArchiveCache((poolId) => api.archive(poolId), options.archiveCacheMs);
  const maxAge = Math.floor(options.archiveCacheMs / 1000);

  const send = (res: ServerResponse, code: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, value: unknown, headers?: Record<string, string>) => (
    send(res, code, JSON.stringify(value), headers));

  // Node enforces the header and request timeouts only as often as it checks its connections, every
  // 30 seconds unless told, so a slow client could hold a connection three times as long as allowed.
  const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: options.checkTimeoutsEveryMs ?? 1_000 }, async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, OPTIONS' }); return; }
    if ((req.url ?? '').length > LONGEST_URL) { json(res, 414, { error: 'URL too long' }); return; }
    const { pathname } = new URL(req.url ?? '/', 'http://indexer');
    try {
      if (pathname === '/health') {
        json(res, 200, { ok: true, network: api.network, pools: api.pools().map((pool) => pool.id) }, { 'cache-control': 'no-store' });
        return;
      }
      if (pathname === '/pools') {
        // The app's server reads it, and keeps it a few seconds; nobody needs it more often.
        if (!poolsLimit.allow(clientOf(req))) {
          json(res, 429, { error: 'too many requests' }, { 'retry-after': String(poolsLimit.retryAfter()) });
          return;
        }
        json(res, 200, { pools: api.pools() }, { 'cache-control': `public, max-age=${maxAge}` });
        return;
      }
      const archived = POOL_PATH.exec(pathname);
      if (archived) {
        if (!limit.allow(clientOf(req))) {
          json(res, 429, { error: 'too many requests' }, { 'retry-after': String(limit.retryAfter()) });
          return;
        }
        const [, poolId] = archived;
        if (!api.has(poolId)) { json(res, 404, { error: 'unknown pool' }); return; }
        let body: string;
        try {
          body = await archives.get(poolId);
        } catch (error) {
          console.error(`archive ${poolId.slice(0, 12)}:`, String((error as Error).message ?? error));
          json(res, 503, { error: 'archive unavailable' }, { 'retry-after': '5' });
          return;
        }
        send(res, 200, body, { 'cache-control': `public, max-age=${maxAge}` });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error(String((error as Error).message ?? error));
      json(res, 500, { error: 'internal error' });
    }
  });
  // A slow or idle client cannot hold a connection for long, nor can many hold all of them.
  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.requestTimeout = options.requestTimeoutMs ?? 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1_000;
  return server;
}
