// The optional backend. Correctness never depends on it: the contracts are the rules,
// and the browser checks whatever it reads against the chain.
//
//   GET  /health
//   GET  /archive/:pool   a pool's deposits and spent nullifiers
//   POST /                Electrum JSON-RPC, on the local chain (scripts and tests)
//   POST /faucet          test funds, on the local chain
//   WS   /                the same Electrum view with subscriptions: the page, and wallets such as Cashonize
//
// With POOL_NETWORK=local it runs a chain of its own and deploys the pools on it. On a
// real network it only keeps the archive, read from FULCRUM_URL.
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { TransactionBuilder } from '@solidcash/solidcash';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { DEPLOYMENT, NETWORK, PORT, ROOT, SERVICE_URL } from './lib/config';
import { Archive, type DeployedPool } from './archive';
import { LocalChain } from './chain';
import { attachElectrumWebSocket } from './electrum-ws';
import { SEED_TOKENS, exponentOf } from '../web/src/pools';
import { deployFactory, factoryArtifact } from '../web/src/factory';
import { PoolClient } from '../web/src/pool-client';
import { deployPool, type PoolPlan } from '../scripts/lib/deploy';
import { devnetAccount } from '../web/src/devnet-account';

const json = (res: ServerResponse, code: number, body: unknown) => {
  const data = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
};

// The pools of the local chain. A real network's are in deployments/<network>.json.
const LOCAL_PLANS: PoolPlan[] = [
  { id: 'bch', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: 1_000_000n },
  { id: 'bch1', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: 10_000_000n },
  { id: 'usdt', kind: 'token', name: 'Test USD', symbol: 'USDT', decimals: 2, denomination: 1_000_000n },
];

/** The test tokens the local faucet hands out, in addition to BCH. */
interface TestToken {
  name: string;
  symbol: string;
  decimals: number;
  asset: string;
  /** Units one faucet request sends. */
  faucet: string;
}
const TEST_TOKENS = [
  { name: 'Test USD', symbol: 'USDT', decimals: 2, supply: 1_000_000_000_000n, faucet: 10_000_000n },
  { name: 'Test Coin', symbol: 'USDC', decimals: 4, supply: 1_000_000_000_000n, faucet: 10_000_000n },
  { name: 'Test Stablecoin', symbol: 'DAI', decimals: 3, supply: 1_000_000_000_000n, faucet: 10_000_000n },
] as const;

/** A free coin whose outpoint transaction is not already a category: its txid becomes the new one. */
function genesisCoin(coins: any[], used: ReadonlySet<string>) {
  const coin = coins.find((entry) => !entry.token && entry.satoshis >= 1_000_000n && !used.has(entry.txid));
  if (coin === undefined) throw new Error('the local chain has no free coin for a new category');
  return coin;
}

/** Issue one test token: a large faucet coin, and for USDT the one-unit coin a pool opens with. */
async function issueTestToken(
  chain: LocalChain, spec: typeof TEST_TOKENS[number], used: Set<string>,
): Promise<TestToken> {
  const { faucet, provider } = chain;
  const issue = genesisCoin(await faucet.getUtxos(), used);
  used.add(issue.txid);
  const asset = issue.txid;
  const issuer = new TransactionBuilder({ provider });
  issuer.addInput(issue, faucet.unlockP2PKH());
  const faucetLock = chain.lockOf(faucet.getAddress());
  if (spec.symbol === 'USDT') {
    issuer.addOutput({ to: faucetLock, amount: 1_200n, token: { category: asset, amount: SEED_TOKENS } });
  }
  issuer.addOutput({ to: faucetLock, amount: 1_200n, token: { category: asset, amount: spec.supply } });
  issuer.addBchChangeOutputIfNeeded({ to: faucet.getAddress(), feeRate: 1.0 });
  await issuer.send();
  return { name: spec.name, symbol: spec.symbol, decimals: spec.decimals, asset, faucet: String(spec.faucet) };
}

async function deployLocally(chain: LocalChain) {
  const { faucet, provider } = chain;
  const used = new Set<string>();
  const tokens: TestToken[] = [];
  for (const spec of TEST_TOKENS) tokens.push(await issueTestToken(chain, spec, used));
  const usdt = tokens.find((token) => token.symbol === 'USDT')!;

  // The local chain's own factories: the page makes pools through them, as on a real network.
  const factories = {
    bch: (await deployFactory('bch', faucet)).categoryId as string,
    token: (await deployFactory('token', faucet)).categoryId as string,
  };
  const pools: Array<DeployedPool & { creator: string }> = [];
  for (const plan of LOCAL_PLANS) {
    const factory = factories[plan.kind];
    // A token pool's creation proves its slot empty, from the factory's pools so far.
    const created = pools.filter((pool) => pool.kind === 'token').map((pool) => ({
      category: pool.category, exponent: Number(exponentOf(BigInt(pool.denomination))), asset: pool.asset!,
    }));
    const deployed = await deployPool(provider, faucet, {
      ...plan, ...(plan.kind === 'token' ? { asset: usdt.asset } : {}),
    }, factory, created);
    pools.push({ ...deployed, denomination: String(deployed.denomination), creator: factory });
  }
  return { network: 'chipnet', local: true, factories, pools, tokens };
}

/** An older state file has no `tokens`: add the pool's USDT and issue the other test tokens. */
async function ensureTestTokens(
  chain: LocalChain,
  deployment: { pools: DeployedPool[]; tokens?: TestToken[] },
): Promise<void> {
  const tokens = deployment.tokens ?? [];
  // A state written before the test tokens took their present names keeps their categories and takes the names.
  for (const token of tokens) {
    const spec = TEST_TOKENS.find((entry) => entry.symbol === token.symbol);
    if (spec !== undefined) token.name = spec.name;
  }
  const poolToken = deployment.pools.find((pool) => pool.kind === 'token' && pool.asset !== undefined);
  if (poolToken !== undefined && !tokens.some((token) => token.symbol === 'USDT')) {
    tokens.push({
      name: poolToken.name, symbol: poolToken.symbol, decimals: poolToken.decimals,
      asset: poolToken.asset!, faucet: String(TEST_TOKENS[0].faucet),
    });
  }
  const used = new Set<string>([...deployment.pools.map((pool) => pool.category), ...tokens.map((token) => token.asset)]);
  for (const spec of TEST_TOKENS) {
    if (tokens.some((token) => token.symbol === spec.symbol)) continue;
    tokens.push(await issueTestToken(chain, spec, used));
  }
  deployment.tokens = tokens;
  writeFileSync(DEPLOYMENT, `${JSON.stringify(deployment, null, 2)}\n`);
}

/**
 * Why this build cannot drive a saved local deployment, if it cannot. A pool's coins sit at addresses that its
 * contracts and SolidCash derive, so pools deployed by another build (other artifacts, another SolidCash) hold
 * nothing where this one looks, and the first deposit fails with "Satoshi container UTXO not found". Every coin a
 * deployment makes must be where this build expects it: master, state record, satoshi and token containers, the
 * workers and the verifier.
 */
async function localMisfit(
  chain: LocalChain, deployment: { pools: DeployedPool[]; factories?: { bch: string; token: string } },
): Promise<string | undefined> {
  // Every pool is made through a factory now, and the page makes new ones through them.
  if (!deployment.factories) return 'it has no pool factories';
  for (const kind of ['bch', 'token'] as const) {
    const factory = new StatefulContract(deployment.factories[kind], factoryArtifact(kind), chain.provider, { constructorArgs: [] } as any) as any;
    if ((await chain.provider.getUtxos(factory.address)).length === 0) return `the ${kind} factory has no master coin at ${factory.address}`;
  }
  for (const pool of deployment.pools) {
    const client = new PoolClient({
      id: pool.id, kind: pool.kind, denomination: BigInt(pool.denomination), category: pool.category,
      ...(pool.asset ? { asset: pool.asset } : {}),
    }, chain.provider);
    const { contract } = client;
    const addresses: Array<[string, string]> = [
      ['master', contract.address], ['state record', contract.getDataNftAddress()],
      ['satoshi container', contract.getSatoshiContainerAddress()],
      ...(pool.asset ? [['token container', contract.getTokenContainerAddress(pool.asset)] as [string, string]] : []),
    ];
    for (const [label, address] of addresses) {
      if ((await chain.provider.getUtxos(address)).length === 0) return `pool ${pool.id} has no ${label} coin at ${address}`;
    }
    for (const [label, lock] of [['hashing', client.workerLock], ['verifier', client.verifier.lock]] as const) {
      if ((await chain.provider.getUtxosForLockingBytecode(lock)).length === 0) return `the chain has no ${label} coin`;
    }
  }
  return undefined;
}

// A forgotten setting must not put a mock chain and a faucet behind a public page.
if (!process.env.POOL_NETWORK) throw new Error('Set POOL_NETWORK: local runs a chain of its own, anything else reads a real one.');
if (NETWORK === 'local' && process.env.NODE_ENV === 'production') {
  throw new Error('The local chain and its test funds are for development, and NODE_ENV=production says this is not: `npm run start:prod` serves the app without them.');
}

const STATE = process.env.SERVICE_STATE ?? join(ROOT, 'service', 'state.json');
// A local deployment names coins on one chain, so it goes with that chain's saved state.
let redeploy = NETWORK === 'local' && !(existsSync(DEPLOYMENT) && existsSync(STATE));
let chain = NETWORK === 'local' ? await LocalChain.open(STATE) : undefined;
if (chain?.setAside) {
  // A deployment names coins on one chain, so it goes aside with the chain it named.
  if (existsSync(DEPLOYMENT)) renameSync(DEPLOYMENT, `${DEPLOYMENT}${chain.setAside.slice(STATE.length)}`);
  console.log(`the saved local chain is in a form this build does not read; starting a new one. The old file is kept as ${chain.setAside}.`);
  redeploy = true;
}
if (chain && !redeploy) {
  // A chain this build cannot use starts over. The old files stay beside the new ones, renamed, not deleted.
  const misfit = await localMisfit(chain, JSON.parse(readFileSync(DEPLOYMENT, 'utf8')));
  if (misfit !== undefined) {
    const aside = `${new Date().toISOString().replace(/[:.]/g, '-')}.old`;
    renameSync(STATE, `${STATE}.${aside}`);
    renameSync(DEPLOYMENT, `${DEPLOYMENT}.${aside}`);
    console.log(`the saved local chain does not fit this build (${misfit}); starting a new one. The old files are kept as *.${aside}.`);
    chain = await LocalChain.open(STATE);
    redeploy = true;
  }
}

if (chain && redeploy) {
  console.log('deploying the local pools');
  mkdirSync(dirname(DEPLOYMENT), { recursive: true });
  writeFileSync(DEPLOYMENT, `${JSON.stringify(await deployLocally(chain), null, 2)}\n`);
}
const deployment = JSON.parse(readFileSync(DEPLOYMENT, 'utf8')) as {
  network: string; pools: DeployedPool[]; tokens?: TestToken[]; factories?: { bch: string; token: string };
};
if (chain) await ensureTestTokens(chain, deployment);

const archive = new Archive(deployment, process.env.FULCRUM_URL ?? SERVICE_URL);

/** Every test token gets the metadata the app reads from `/bcmr/<category>.json`. */
function writeTokenMetadata(tokens: TestToken[]) {
  const dir = join(ROOT, 'web', 'public', 'bcmr');
  mkdirSync(dir, { recursive: true });
  for (const token of tokens) {
    const category = token.asset;
    const snapshot = {
      name: token.name,
      description: 'A test token issued by the local devnet.',
      token: { category, symbol: token.symbol, decimals: token.decimals },
    };
    // The local chain issues the same categories on every new chain, so a file that already says this
    // keeps its date instead of being rewritten on each start.
    const file = join(dir, `${category}.json`);
    try {
      const kept = Object.values(JSON.parse(readFileSync(file, 'utf8')).identities[category]);
      if (kept.length === 1 && JSON.stringify(kept[0]) === JSON.stringify(snapshot)) continue;
    } catch { /* absent or not this token's: write it */ }
    const body = { identities: { [category]: { [new Date().toISOString()]: snapshot } } };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  }
}

// A devnet browser account is deterministic, so seed it and publish its token metadata on every
// start. On a chain that already holds the coins this is a no-op.
if (chain) {
  const account = devnetAccount();
  const tokens = deployment.tokens ?? [];
  const requests = tokens.map((token) => ({ category: token.asset, amount: BigInt(token.faucet) }));
  const coins = await chain.provider.getUtxosForLockingBytecode(chain.lockOf(account.address));
  const SEED_BCH = 100_000_000n;
  const funded = coins.some((coin: any) => !coin.token && coin.satoshis >= SEED_BCH)
    && requests.every(({ category, amount }) => coins.some((coin: any) => coin.token?.category === category
      && coin.token.amount >= amount));
  if (!funded) {
    await chain.fund(account.address, requests, SEED_BCH);
    console.log(`seeded the devnet account ${account.address}`);
  }
  writeTokenMetadata(tokens);
}

// The largest thing a client sends is one standard transaction, in hex.
const MOST_BYTES = 1 << 20;
const body = (req: import('node:http').IncomingMessage) => new Promise<string>((resolve, reject) => {
  let text = '';
  req.on('data', (chunk) => {
    text += chunk;
    if (text.length > MOST_BYTES) { reject(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => resolve(text));
  req.on('error', reject);
});

// No request or server reply may take this process down, and the archive is optional.
process.on('unhandledRejection', (error) => console.error('unhandled:', error));

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, network: deployment.network, pools: deployment.pools.map((pool) => pool.id), local: Boolean(chain) });
      return;
    }
    const archived = /^\/archive\/([a-z0-9]+)$/.exec(url.pathname);
    if (req.method === 'GET' && archived) {
      json(res, 200, await archive.read(archived[1]));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/faucet' && chain) {
      const { address } = JSON.parse(await body(req)) as { address: string };
      const tokens = (deployment.tokens ?? []).map((token) => ({ category: token.asset, amount: BigInt(token.faucet) }));
      json(res, 200, { txid: await chain.fund(address, tokens) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/' && chain) {
      const { id, method, params } = JSON.parse(await body(req)) as { id: number; method: string; params: any[] };
      try {
        json(res, 200, { jsonrpc: '2.0', id, result: await chain.rpc(method, params ?? []) });
      } catch (error) {
        json(res, 200, { jsonrpc: '2.0', id, error: { code: 1, message: String((error as Error).message) } });
      }
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    // A local chain's errors are a developer's. A real network's stay here.
    json(res, 500, { error: chain ? String((error as Error).message ?? error) : 'internal error' });
  }
});

// It listens on every interface: the devnet's page reaches it from the host of its container through
// a mapped port, and on a real network it runs in a container behind nginx, with no port published
// (PRODUCTION.md). SERVICE_HOST names another address.
const HOST = process.env.SERVICE_HOST ?? '0.0.0.0';
server.listen(PORT, HOST, () => console.log(`service on ${SERVICE_URL} (listening on ${HOST}), ${deployment.network}, ${deployment.pools.length} pools`));
if (chain) {
  attachElectrumWebSocket(server, chain);
  console.log(`electrum websocket on ws://127.0.0.1:${PORT}`);
}
