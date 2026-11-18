// The indexer's HTTP side (indexer/http.ts), over a real socket, with an archive that counts its
// reads: reads only, any origin, one read of an archive however many ask, a few seconds' keep, a
// limit for one client, and the page's first paint reading a deployment's pool from it.
//   tsx test/indexer-http.ts
import { connect, type AddressInfo } from 'node:net';
import { indexerServer, networkOf, type IndexerApi } from '../indexer/http';
import { Archive } from '../service/archive';
import { loadIndexedRows } from '../web/src/indexer';
import { reporter } from './lib/setup';

const { check, finish } = reporter();

const POOL = 'aa'.repeat(32);
let reads = 0;
let failing = false;
let holding = true;
let release: (() => void) | undefined;
const api: IndexerApi = {
  network: 'chipnet',
  pools: () => [{ id: POOL, kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: '1000000', category: POOL }],
  has: (poolId) => poolId === POOL,
  archive: async () => {
    reads += 1;
    // Held until released, so several requests arrive while one read is under way.
    if (holding) await new Promise<void>((resolve) => { release = resolve; });
    if (failing) throw new Error('Fulcrum went away');
    return { deposits: [{ leafIndex: 0, commitment: '1' }], withdrawals: [] };
  },
};

const start = async (options: Parameters<typeof indexerServer>[1]) => {
  const server = indexerServer(api, options);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
};
const settle = () => new Promise((resolve) => { setTimeout(resolve, 50); });

const { server, base } = await start({ archiveCacheMs: 400, archivePerMinute: 0 });

// ---- reads only, for any page ----
const health = await fetch(`${base}/health`);
check(health.ok && (await health.json()).network === 'chipnet', '/health answers');
const pools = await fetch(`${base}/pools`, { headers: { origin: 'https://pools.example.org' } });
check(pools.headers.get('access-control-allow-origin') === '*', 'any page may read it from a browser');
check((await pools.json()).pools[0].category === POOL, '/pools lists the pool');
const posted = await fetch(`${base}/pools`, { method: 'POST', body: '{}' });
check(posted.status === 405 && posted.headers.get('allow') === 'GET, HEAD, OPTIONS', 'a POST is refused');
const long = await fetch(`${base}/archive/${POOL}?${'x'.repeat(600)}`);
check(long.status === 414, 'a long URL is refused');
const head = await fetch(`${base}/pools`, { method: 'HEAD' });
check(head.ok && (await head.text()) === '', 'HEAD answers with no body');
check((await fetch(`${base}/archive/${'b'.repeat(65)}`)).status === 404, 'an id longer than a category is no pool');

// ---- one read of an archive at a time, then kept ----
const asked = [1, 2, 3, 4].map(() => fetch(`${base}/archive/${POOL}`));
await settle();
release!();
const answers = await Promise.all(asked);
check(answers.every((answer) => answer.ok), 'four requests at once are answered');
check(reads === 1, `and read the archive once (${reads} reads)`);
check(answers[0].headers.get('access-control-allow-origin') === '*', 'any page may read an archive too');
check(answers[0].headers.get('cache-control') === 'public, max-age=0', `a proxy may keep it no longer (${answers[0].headers.get('cache-control')})`);
check((await answers[0].json()).deposits.length === 1, 'with the archive in it');
const kept = await fetch(`${base}/archive/${POOL}`);
check(kept.ok && reads === 1, 'a request soon after is answered from what was kept');
check((await fetch(`${base}/archive/${'cc'.repeat(32)}`)).status === 404 && reads === 1, 'an unknown pool reads nothing');
await new Promise((resolve) => { setTimeout(resolve, 450); });
failing = true;
const failed = fetch(`${base}/archive/${POOL}`);
await settle();
release!();
const answer = await failed;
check(answer.status === 503 && reads === 2, `a read that fails is a 503, and is tried again after the keep (${answer.status}, ${reads} reads)`);
failing = false;

server.close();

// ---- one client's limit: 3 a minute here, and a proxy nearby names its client ----
holding = false;
// The count starts over each minute, so this stays clear of the turn of one.
while (Date.now() % 60_000 > 55_000) await new Promise((resolve) => { setTimeout(resolve, 200); });
const limits = await start({ archiveCacheMs: 60_000, archivePerMinute: 3 });
const firstThree = [];
for (let i = 0; i < 3; i += 1) firstThree.push((await fetch(`${limits.base}/archive/${POOL}`)).status);
check(firstThree.every((status) => status === 200), `a client's first 3 a minute are answered (${firstThree.join(', ')})`);
const limited = await fetch(`${limits.base}/archive/${POOL}`);
check(limited.status === 429 && Number(limited.headers.get('retry-after')) >= 1, `the 4th waits (${limited.status}, retry-after ${limited.headers.get('retry-after')})`);
const proxied = await fetch(`${limits.base}/archive/${POOL}`, { headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.7' } });
check(proxied.ok, 'another client, named last by a proxy on this host, is not held back');
check((await fetch(`${limits.base}/pools`)).ok, 'nor is the pool list, which the app\'s server reads for every page');
// An IPv6 client is its /64: other addresses of one subscriber's block share its count.
const viaProxy = (client: string) => fetch(`${limits.base}/archive/${POOL}`, { headers: { 'x-forwarded-for': client } });
const block = [];
for (const client of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::9', '2001:db8:1:2:0:0:0:abcd']) block.push((await viaProxy(client)).status);
check(block.join(',') === '200,200,200,429', `four addresses of one IPv6 /64 share one client's limit (${block.join(', ')})`);
check((await viaProxy('2001:db8:1:3::1')).ok, 'while the next /64 is another client');
check(networkOf('2001:DB8:1:2::abcd') === '2001:db8:1:2::/64' && networkOf('::ffff:203.0.113.7') === '203.0.113.7' && networkOf('::1') === '0:0:0:0::/64',
  `addresses are counted by their network (${networkOf('2001:DB8:1:2::abcd')})`);
limits.server.close();

// ---- the pool list has a limit of its own ----
const listed = await start({ archiveCacheMs: 0, archivePerMinute: 0, poolsPerMinute: 2 });
const lists = [];
for (let i = 0; i < 3; i += 1) lists.push((await fetch(`${listed.base}/pools`)).status);
check(lists.join(',') === '200,200,429', `a client's pool lists are limited too, the app's server reading it a few times a minute (${lists.join(', ')})`);
listed.server.close();

// ---- a client that never finishes its headers is cut off when its time is up ----
// Node enforces these limits only as often as it checks its connections, every 30 s unless told,
// so a 10 s limit once held a connection for up to 40 s.
const timed = await start({ archiveCacheMs: 0, archivePerMinute: 0, headersTimeoutMs: 400, requestTimeoutMs: 600, checkTimeoutsEveryMs: 100 });
const lingering = connect((timed.server.address() as AddressInfo).port, '127.0.0.1');
let told = '';
lingering.on('data', (chunk) => { told += String(chunk); });
lingering.on('error', () => undefined);
lingering.write('GET /health HTTP/1.1\r\nHost: indexer\r\n');
const opened = Date.now();
const cutOff = await new Promise<number>((resolve) => {
  lingering.on('close', () => resolve(Date.now() - opened));
  setTimeout(() => resolve(-1), 3_000);
});
check(cutOff > 0 && cutOff < 1_500 && told.startsWith('HTTP/1.1 408'),
  `a client with unfinished headers is told 408 and cut off soon after its 400 ms (${cutOff < 0 ? 'still open after 3 s' : `${cutOff} ms`})`);
lingering.destroy();
timed.server.close();

// ---- a deployment's pool, by its category ----
// The indexer knows a pool by its category alone, while a deployment names its pools by ids of its
// own. The page's first paint asks for each pool's archive by category, so a deployment's pool gets
// one; so does the devnet's service, which the page reaches at /api/indexer.
{
  const page = await start({ archiveCacheMs: 400, archivePerMinute: 0 });
  const planned = { id: 'bch01', kind: 'bch' as const, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: '1000000', category: POOL };
  const painted = await loadIndexedRows({ indexerUrl: page.base, pools: [planned] }).catch((error) => ({ error }));
  const row: any = 'pools' in painted ? painted.pools[0] : undefined;
  check(row?.id === 'bch01' && !row.unread && row.notes === 1 && row.spent === 0,
    `a deployment's pool named by its own id gets its archive from the indexer (${'error' in painted ? painted.error.message : JSON.stringify(row?.notes)})`);
  page.server.close();
  const service = new Archive({ network: 'chipnet', pools: [planned] }, 'http://127.0.0.1:1');
  check(service.has(POOL) && service.has('bch01'), 'and the devnet\'s service answers for it by its category, as by its id');
}

finish();
