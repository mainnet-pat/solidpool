// Create pools through a network's factories and add them to deployments/<network>.json.
//
//   POOL_NETWORK=chipnet FULCRUM_URL=wss://... tsx scripts/deploy.ts deployments/chipnet.plan.json
//
// The deployment file must name the factories already (scripts/deploy-factories.ts). A plan is
// { "pools": [{ id, kind, name, symbol, decimals, denomination, asset? }] }, checked whole before
// anything spends. Each pool is made the way the app makes one: a prep pays the factory's
// one-shot coin, the factory's `create` spends it, and the factory refuses a second pool of an
// amount, or of an asset and amount, on chain. A token pool also opens with a coin of exactly one
// unit of its asset holding at least 1,200 sat, which this makes from a larger coin of the asset
// when the key has none. Mainnet refuses to run without CONFIRM_MAINNET=1.
//
// A run that stops can be run again with the same plan. A pool the file has already is skipped,
// and one the factory has made already, by an earlier run that stopped before writing it or by
// anyone through the page, is recorded rather than made: the factory makes one pool of an amount.
// verify-deployment.ts checks it like any other.
import { existsSync, readFileSync } from 'node:fs';
import { factoryPools } from '../web/src/factory';
import { exponentOf } from '../web/src/pools';
import { deployPool, plansProblems, type PoolPlan } from './lib/deploy';
import {
  connectDeployer, deploymentFileOf, readDeployment, webCopyConflict, writeDeployment,
} from './lib/network';
import { solidcashBuild } from './lib/solidcash-build';

const [planFile] = process.argv.slice(2);
if (!planFile) throw new Error('Usage: POOL_NETWORK=... FULCRUM_URL=... tsx scripts/deploy.ts <plan.json>');
const plan = JSON.parse(readFileSync(planFile, 'utf8')) as { pools?: Array<Omit<PoolPlan, 'denomination'> & { denomination: string }> };
if (!Array.isArray(plan.pools) || plan.pools.length === 0) throw new Error(`${planFile} names no pools: a plan is { "pools": [...] }.`);
const entries = plan.pools.map((entry) => ({ ...entry, denomination: BigInt(entry.denomination) }));
const problems = plansProblems(entries);
if (problems.length) throw new Error(`The plan cannot be deployed:\n  ${problems.join('\n  ')}`);

// The file is checked before anything connects, or a key is asked for.
const named = process.env.POOL_NETWORK?.trim() ?? '';
const out = deploymentFileOf(named);
if (!existsSync(out)) throw new Error(`${out} does not exist: deploy the factories first (scripts/deploy-factories.ts).`);
const deployment = readDeployment(out);
if (deployment.network !== named) throw new Error(`${out} is a ${deployment.network} deployment, not ${named || 'the POOL_NETWORK this run names'}.`);
const conflict = webCopyConflict(named, out, deployment);
if (conflict) throw new Error(conflict);
for (const kind of new Set(entries.map((entry) => entry.kind))) {
  if (!deployment.factories?.[kind]) throw new Error(`${out} names no ${kind} factory: deploy the factories first (scripts/deploy-factories.ts).`);
}
// Pools are made through the factories with this build's artifacts, which must be those the
// factories were made with: other ones give other locks, and a creation that fails after its prep
// went out leaves that prep's coin behind.
const installed = solidcashBuild().version;
if (deployment.solidcash?.version !== installed) {
  throw new Error(`${out} was made with SolidCash ${deployment.solidcash?.version ?? '(not named)'}, and this is ${installed}: install that version first.`);
}

const { network, reader, provider, signer } = await connectDeployer();

// What a pool is, for a factory: its kind, amount and asset. A note names its pool by id.
const amountOf = (pool: { kind: string; denomination: bigint | string; asset?: string }) => (
  `${pool.kind} ${pool.denomination} ${pool.asset ?? ''}`.trim());
const todo: typeof entries = [];
const clashes: string[] = [];
for (const entry of entries) {
  const same = deployment.pools.find((pool) => pool.id === entry.id);
  if (same) {
    if (amountOf(same) !== amountOf(entry)) clashes.push(`${entry.id}: ${out} has a pool of that id for ${amountOf(same)}, not ${amountOf(entry)}`);
    else console.log(entry.id, same.category, `(in ${out} already)`);
    continue;
  }
  const taken = deployment.pools.find((pool) => amountOf(pool) === amountOf(entry));
  if (taken) {
    clashes.push(`${entry.id}: ${out} has ${amountOf(entry)} already, as ${taken.id}, and a factory makes one pool of it`);
    continue;
  }
  todo.push(entry);
}
if (clashes.length) throw new Error(`The plan does not fit ${out}; nothing was spent:\n  ${clashes.join('\n  ')}`);

for (const entry of todo) {
  const factory = deployment.factories[entry.kind]!;
  const exponent = Number(exponentOf(entry.denomination));
  // The factory's own record of the pool of this amount, from its PoolCreated events.
  const madeAlready = async () => (await factoryPools(reader, entry.kind, factory, network)).find((pool) => (
    pool.exponent === exponent && (entry.kind === 'bch' || pool.asset === entry.asset)));
  const record = (category: string, how: string) => {
    deployment.pools.push({
      id: entry.id, kind: entry.kind, name: entry.name, symbol: entry.symbol, decimals: entry.decimals,
      denomination: entry.denomination.toString(), category, ...(entry.asset ? { asset: entry.asset } : {}), creator: factory,
    });
    // Written after each pool, so a run that stops says what it left on chain.
    writeDeployment(out, deployment);
    console.log(entry.id, category, how);
  };
  const found = await madeAlready();
  if (found) {
    record(found.category, '(the factory made it already, for an earlier run or through the page: recorded, not made)');
    continue;
  }
  const created = entry.kind === 'token' ? await factoryPools(reader, 'token', factory, network) : [];
  try {
    record((await deployPool(provider, signer, entry, factory, created)).category, '');
  } catch (error) {
    // The creation may have landed before a later step failed, such as topping up the shared coins.
    const landed = await madeAlready().catch(() => undefined);
    if (landed) record(landed.category, '(made, and recorded, though a later step failed)');
    throw error;
  }
}
console.log('wrote', out);
// The server's socket would keep this process alive.
process.exit(0);
