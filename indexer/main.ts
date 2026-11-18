// A small fast indexer for mainnet and chipnet. It knows only the categories of the BCH and token
// pool factories; every pool comes from their PoolCreated events and is checked against its
// genesis, and each factory against its own, before it is served.
//
// It lists what its Fulcrum server shows, so it starts only with a server of the operator's
// choosing, which must follow POOL_NETWORK. Its HTTP side is in http.ts.
import { Archive } from '../service/archive';
import { Fulcrum } from '../web/src/fulcrum';
import { serverNetworkProblem, serverUrlProblem } from '../web/src/network-check';
import { Discovery } from './discover';
import { indexerServer } from './http';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const setting = (name: string) => process.env[name]?.trim() ?? '';

const network = setting('POOL_NETWORK');
// regtest is for rehearsals against a local node.
if (network !== 'mainnet' && network !== 'chipnet' && network !== 'regtest') fail('Set POOL_NETWORK to mainnet or chipnet.');
const fulcrumUrl = setting('FULCRUM_URL');
if (!/^wss?:\/\/./i.test(fulcrumUrl)) {
  fail('Set FULCRUM_URL to a Fulcrum server of your own, as wss://, or ws:// on this machine or its private network: the indexer lists what it shows, and follows the factories over its WebSocket.');
}
// Over a plain socket anyone on the path could answer for the server.
const plain = serverUrlProblem(network, fulcrumUrl, { nearbyPlain: true });
if (plain) fail(`FULCRUM_URL ${fulcrumUrl}: ${plain}.`);
const factories = [
  { kind: 'bch' as const, category: setting('BCH_FACTORY').toLowerCase() },
  { kind: 'token' as const, category: setting('TOKEN_FACTORY').toLowerCase() },
].filter((factory) => factory.category !== '');
if (factories.length === 0) fail('Set BCH_FACTORY and/or TOKEN_FACTORY to the factories\' categories.');
for (const factory of factories) {
  if (!/^[0-9a-f]{64}$/.test(factory.category)) fail(`${factory.kind} factory: a category is 64 hex digits, not ${factory.category}.`);
}
const number = (name: string, fallback: number) => {
  const value = Number(setting(name) || fallback);
  if (!Number.isInteger(value) || value < 0) fail(`${name} is a whole number, not ${setting(name)}.`);
  return value;
};
const port = number('INDEXER_PORT', 8080);
// Every interface: it runs in a container that nginx reaches over their network, with no port
// published. INDEXER_HOST names another address.
const host = setting('INDEXER_HOST') || '0.0.0.0';
const archiveCacheMs = number('ARCHIVE_CACHE_SECONDS', 5) * 1000;
const archivePerMinute = number('ARCHIVE_RATE_LIMIT', 1200);
const poolsPerMinute = number('POOLS_RATE_LIMIT', 120);

const probe = new Fulcrum(fulcrumUrl);
const problem = await serverNetworkProblem(network as 'mainnet' | 'chipnet' | 'regtest', (method, params) => probe.call(method, params))
  .catch((error) => String((error as Error).message ?? error));
probe.close();
if (problem) fail(`FULCRUM_URL ${fulcrumUrl}: ${problem}.`);
// Every later connection, the archive's and discovery's first and each after a reconnect, is asked
// again before anything goes over it: a server that now follows another chain, or a name that now
// leads to another server, stops the indexer, and its container starts it into the check above.
Fulcrum.connectionCheck = async (url, call) => {
  const changed = await serverNetworkProblem(network as 'mainnet' | 'chipnet' | 'regtest', call);
  if (changed) fail(`FULCRUM_URL ${url}, on a new connection: ${changed}.`);
  return changed;
};

const archive = new Archive({ network, pools: [] }, fulcrumUrl);
const discovery = new Discovery(
  network as 'mainnet' | 'chipnet' | 'regtest', fulcrumUrl, factories,
  setting('BCMR_SERVICE_URL') || 'https://bcmr.paytaca.com',
  archive,
);

const server = indexerServer({
  network,
  pools: () => [...discovery.pools.values()],
  has: (poolId) => archive.has(poolId),
  archive: (poolId) => archive.read(poolId),
}, { archiveCacheMs, archivePerMinute, poolsPerMinute });

server.listen(port, host, () => {
  console.log(`indexer ${network} on ${host}:${port}, Fulcrum ${fulcrumUrl}`);
  for (const factory of discovery.factories) console.log(`${factory.kind} factory ${factory.category}, events at ${factory.address}`);
});

discovery.start().catch((error) => {
  console.error('subscribe:', String((error as Error).message ?? error));
  process.exit(1);
});
process.on('SIGTERM', () => {
  discovery.stop();
  server.close(() => process.exit(0));
});
