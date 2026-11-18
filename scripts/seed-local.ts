// Seed the deterministic devnet browser account with BCH and each token pool's asset, and
// print its address and key. Run while `npm start` is up; the service also seeds it on start.
//   npm run seed:local
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { devnetAccount } from '../web/src/devnet-account';

const service = process.env.SERVICE_URL ?? `http://127.0.0.1:${process.env.SERVICE_PORT ?? 8788}`;
const account = devnetAccount();
const deployment = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'deployments', 'local.json'), 'utf8')) as {
  pools: Array<{ id: string; kind: string; asset?: string; name: string; symbol: string; decimals: number; denomination: string }>;
  tokens?: Array<{ name: string; symbol: string; decimals: number; asset: string; faucet: string }>;
};
const response = await fetch(`${service}/faucet`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ address: account.address }),
});
const result = await response.json();
if (!response.ok) throw new Error(`faucet: ${JSON.stringify(result)}`);
console.log(JSON.stringify({
  account: account.address,
  mnemonic: account.mnemonic,
  path: account.path,
  privateKey: account.keyHex,
  faucet: result,
  pools: deployment.pools.map((pool) => ({
    id: pool.id, kind: pool.kind, name: pool.name, symbol: pool.symbol, decimals: pool.decimals,
    denomination: pool.denomination, ...(pool.asset ? { asset: pool.asset } : {}),
  })),
  tokens: (deployment.tokens ?? []).map((token) => ({
    name: token.name, symbol: token.symbol, decimals: token.decimals, asset: token.asset, faucet: token.faucet,
  })),
}, null, 2));
