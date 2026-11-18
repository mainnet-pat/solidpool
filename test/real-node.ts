// The pools on a real node: unmodified BCHN with public relay policy, read through a real
// Fulcrum, with a real proof. What this accepts is what mainnet's rules accept. The pools are
// made through their factories, and the hashing and verifier coins every pool shares are swept
// here once the node says they are 1,440 blocks old. Last, the deployment scripts and the deploy
// command run as a deployer runs them.
//   scripts/regtest.sh up && tsx test/real-node.ts; scripts/regtest.sh down
// The proofs are under the production key, which @solidpool/verifier ships (verifier:check holds it to
// service/verifier/tornado-bn254-3in.json).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Signer, TransactionBuilder } from '@solidcash/solidcash';
import {
  binToHex, decodeTransaction, encodeCashAddress, encodePrivateKeyWif, encodeTransaction, hexToBin,
} from '@bitauth/libauth';
import { Fulcrum, scripthashOfLock } from '../web/src/fulcrum';
import { ChainHistory } from '../web/src/history';
import { createTokenContainerUnlocker, selectGenesisFundingUtxo } from '@solidcash/solidcash/stateful';
import { seedLogicalNonce } from '@solidcash/solidcash/dist/network/logical-nonce.js';
import { factoryGenesisProblems, poolReport } from '../scripts/lib/genesis';
import { PoolClient, depositValue, le32 } from '../web/src/pool-client';
import { deployFactory, factoryArtifact, factoryPools, parsePoolCreated, poolCreatedLock } from '../web/src/factory';
import { Discovery } from '../indexer/discover';
import { verifierSweepUnlocking } from '../web/src/verifier';
import { FulcrumProvider } from '../web/src/provider';
import { SEED_TOKENS, finishFeeOf, withdrawFeeOf } from '../web/src/pools';
import { createNote } from '../web/src/note';
import { deployPool } from '../scripts/lib/deploy';
import { proveStatement } from '../service/lib/verifier';
import { solidcashBuild } from '../scripts/lib/solidcash-build';
import { lockOf, reporter } from './lib/setup';

const { check, rejects, finish } = reporter();
const FULCRUM = process.env.FULCRUM_URL ?? 'ws://127.0.0.1:60003';
const RPC = process.env.BCHN_RPC ?? 'http://127.0.0.1:28443';

const post = (method: string, params: unknown[]) => fetch(RPC, {
  method: 'POST',
  headers: { 'content-type': 'text/plain', authorization: `Basic ${Buffer.from('user:password').toString('base64')}` },
  body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
});
const rpc = async (method: string, params: unknown[] = []) => {
  // The node closes a connection left idle, as one is while a child process blocks this one.
  const response = await post(method, params).catch(() => post(method, params));
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
};

const reader = new Fulcrum(FULCRUM);
const provider = new FulcrumProvider('regtest', reader);
const alice = new Signer(new Uint8Array(32).fill(0x11), provider as any);
const bob = new Signer(new Uint8Array(32).fill(0x22), provider as any);
const info = await rpc('getnetworkinfo');
console.log('node', info.subversion, 'relay fee', info.relayfee);

const tip = async () => (await reader.call<{ height: number }>('blockchain.headers.get_tip')).height;
const miner = await rpc('getnewaddress');
const mine = async (count = 1, to = miner) => {
  const before = await rpc('getblockcount');
  await rpc('generatetoaddress', [count, to]);
  for (let i = 0; i < 200 && await tip() < before + count; i += 1) await new Promise((r) => { setTimeout(r, 100); });
};
// Alice's coins are coinbases buried past maturity, and later rewards go elsewhere.
await mine(10, alice.getAddress());
await mine(105);
console.log('height', await tip(), 'spendable coins', (await alice.getUtxos()).length);

const mature = async () => (await alice.getUtxos()).filter((coin: any) => !coin.token && coin.vout === 0);

// ---- deploy: one native pool, and one token pool with a fresh category ----
const issue = (await mature())[0];
const asset = issue.txid;
const aliceLock = lockOf(alice.getAddress());
{
  const builder = new TransactionBuilder({ provider: provider as any });
  builder.addInput(issue, alice.unlockP2PKH());
  builder.addOutput({ to: aliceLock, amount: 1_200n, token: { category: asset, amount: SEED_TOKENS } });
  builder.addOutput({ to: aliceLock, amount: 1_200n, token: { category: asset, amount: SEED_TOKENS } });
  builder.addOutput({ to: aliceLock, amount: 1_200n, token: { category: asset, amount: SEED_TOKENS } });
  builder.addOutput({ to: aliceLock, amount: 1_200n, token: { category: asset, amount: 2n } });
  builder.addOutput({ to: aliceLock, amount: 1_200n, token: { category: asset, amount: 5_000_000n } });
  builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
  await builder.send();
}
await mine();
const factories = { bch: (await deployFactory('bch', alice)).categoryId as string, token: (await deployFactory('token', alice)).categoryId as string };
await mine();
const denomination = 1_000_000n;
const nativePool = await deployPool(provider, alice, {
  id: 'bch', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination,
}, factories.bch);
await mine();
const tokenPool = await deployPool(provider, alice, {
  id: 'usdt', kind: 'token', name: 'test', symbol: 'USDT', decimals: 6, denomination, asset,
}, factories.token, await factoryPools(reader, 'token', factories.token, 'regtest'));
await mine();
console.log('deployed', nativePool.category.slice(0, 12), tokenPool.category.slice(0, 12), 'through', factories.bch.slice(0, 12), factories.token.slice(0, 12));

const open = (pool: any) => {
  const client = new PoolClient({ id: pool.id, kind: pool.kind, denomination: BigInt(pool.denomination), category: pool.category, ...(pool.asset ? { asset: pool.asset } : {}) }, provider as any);
  return { client, history: new ChainHistory(reader, client) };
};
const inMempool = async (txid: string) => (await rpc('getrawmempool')).includes(txid);

// A genesis counts as soon as it is seen: these are a block or two deep.
for (const kind of ['bch', 'token'] as const) {
  const problems = await factoryGenesisProblems(kind, factories[kind], reader, provider);
  check(problems.length === 0, `the ${kind} factory's genesis holds what it should and nothing else${problems.length ? `: ${problems.join(', ')}` : ''}`);
}
for (const pool of [nativePool, tokenPool]) {
  const { problems } = await poolReport(open(pool).client, reader, factories[pool.kind]);
  check(problems.length === 0, `${pool.id} creation holds what it should and nothing else${problems.length ? `: ${problems.join(', ')}` : ''}`);
}
await rejects('a second 0.01 BCH pool through the same factory', /already has a pool/, () => deployPool(provider, alice, {
  id: 'bchtwo', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination,
}, factories.bch));

for (const pool of [nativePool, tokenPool]) {
  const { client, history } = open(pool);
  const note = createNote();
  const view = () => client.view(history);

  // ---- deposit: both transactions in one block, chained in the mempool ----
  const tokenCoin = pool.kind === 'token'
    ? (await alice.getUtxos()).find((coin: any) => coin.token?.category === asset && coin.token.amount >= denomination) : undefined;
  const deposit = await client.deposit(alice, note.commitment, await view(), tokenCoin);
  check(await inMempool(deposit.txid), `${pool.id} deposit ${deposit.hex.length / 2} B: relayed by the node`);
  const finished = await client.finish(await view());
  check(await inMempool(finished.txid), `${pool.id} finish ${finished.hex.length / 2} B: relayed, chained on the deposit`);
  check(finished.hex.length / 2 <= Number(finishFeeOf(pool.kind)), `${pool.id} the prepaid fee covers it`);
  await mine();
  check((await rpc('getrawmempool')).length === 0, `${pool.id} deposit confirmed: the node mined both`);
  const current = await view();
  check(current.tree.size === 1, `${pool.id} the tree read through Fulcrum reproduces the on-chain roots`);

  // ---- withdraw with a real proof ----
  const recipient = lockOf(bob.getAddress());
  const received = async (): Promise<bigint> => (await provider.getUtxosForLockingBytecode(recipient)).reduce(
    (sum: bigint, coin: any) => sum + BigInt(pool.kind === 'token' ? (coin.token?.category === asset ? coin.token.amount : 0n) : (coin.token ? 0n : coin.satoshis)), 0n,
  );
  const before = await received();
  const proof = await client.prove(note, recipient, current, proveStatement);
  const nullifier = (await import('../web/src/pool-client')).le32(note.nullifierHash);
  const withdrawal = await client.submitWithdrawal(proof, nullifier, recipient, current);
  check(await inMempool(withdrawal.txid), `${pool.id} withdrawal ${withdrawal.hex.length / 2} B: relayed by the node`);
  await mine();
  check(await received() - before === denomination, `${pool.id} the recipient holds exactly the denomination`);

  // ---- a replay, against a funded pool, so only the nullifier check can stop it ----
  const other = createNote();
  const otherCoin = pool.kind === 'token'
    ? (await alice.getUtxos()).find((coin: any) => coin.token?.category === asset && coin.token.amount >= denomination) : undefined;
  await client.deposit(alice, other.commitment, await view(), otherCoin);
  await client.finish(await view());
  await mine();
  await rejects(`${pool.id} the same proof again`, /spent/, async () => client.submitWithdrawal(proof, nullifier, recipient, await view()));
  console.log(`${pool.id} a deposit prepays`, depositValue(client.pool), 'sat; a withdrawal costs', withdrawFeeOf(pool.kind), 'sat');
}

// ---- the token coin, under the node's own dust rule ----
// The factory takes one pool per asset and amount, so this one pays another amount.
let griefed: any;
{
  griefed = await deployPool(provider, alice, {
    id: 'grief', kind: 'token', name: 'test', symbol: 'USDT', decimals: 6, denomination: denomination / 10n, asset,
  }, factories.token, await factoryPools(reader, 'token', factories.token, 'regtest'));
  await mine();
  const { client, history } = open(griefed);
  const view = () => client.view(history);
  const address = client.contract.tokens[asset].address;
  const largestPlain = async () => (await alice.getUtxos()).filter((coin: any) => !coin.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
  const payIn = async (satoshis: bigint) => {
    const coin = (await alice.getUtxos()).find((candidate: any) => candidate.token?.category === asset && candidate.token.amount === 2n);
    const funds = await largestPlain();
    const builder: any = new TransactionBuilder({ provider: provider as any });
    builder.addInput(coin, alice.unlockP2PKH());
    builder.addInput(funds, alice.unlockP2PKH());
    builder.outputs.push({ to: lockOf(address), amount: satoshis, token: coin.token });
    builder.outputs.push({ to: alice.getAddress(), amount: funds.satoshis + coin.satoshis - satoshis - 1_000n });
    return builder.build();
  };
  const accepts = async (hex: string) => (await rpc('testmempoolaccept', [[hex]]))[0];
  check(/dust/.test((await accepts(await payIn(680n)))['reject-reason'] ?? ''), 'a node refuses 2 units at 680 sat: its floor is what the SDK says');
  const griefing = await payIn(681n);
  check((await accepts(griefing)).allowed, 'and takes them at 681 sat, the floor');
  await rpc('sendrawtransaction', [griefing]);
  await mine();

  const held = async () => (await provider.getUtxos(address)).filter((coin: any) => coin.token?.category === asset);
  const note = createNote();
  const coin = (await alice.getUtxos()).find((candidate: any) => candidate.token?.category === asset && candidate.token.amount >= denomination);
  const deposited = await client.deposit(alice, note.commitment, await view(), coin);
  check(await inMempool(deposited.txid), 'a deposit is relayed beside a larger coin at its dust floor');
  await mine();

  const [real] = (await held()).sort((a: any, b: any) => Number(b.token.amount - a.token.amount));
  const funds = await largestPlain();
  const drain: any = await (await client.finishCall(await view())).call.build();
  // The attacker's own transaction, which the honest step's fee cap does not hold back.
  drain.enforceFeeCaps = false;
  drain.inputs.push(
    { ...real, unlocker: createTokenContainerUnlocker(client.contract.inner, 0, client.pool.category, asset) },
    { ...funds, unlocker: alice.unlockP2PKH() },
  );
  drain.outputs.push(
    { to: address, amount: real.satoshis - 300n, token: real.token },
    { to: alice.getAddress(), amount: funds.satoshis - 20_000n + 300n },
  );
  await rejects('the token coin\'s satoshis taken by a hashing step', /Program failed|VERIFY|mandatory|evaluat/i, () => drain.send());
  await client.finish(await view());
  await mine();
  check((await held()).find((candidate: any) => candidate.token.amount === real.token.amount)?.satoshis === real.satoshis, 'the token coin keeps its satoshis');
}

// ---- a miner's reward at a pool's lock ----
// For 100 blocks it looks like any coin and sinks whatever spends it, so the client skips it.
{
  const { client, history } = open(tokenPool);
  const regtest = (lock: Uint8Array) => encodeCashAddress({ prefix: 'bchreg', type: 'p2sh', payload: lock.subarray(2, 34) }).address;
  await mine(1, regtest(client.workerLock));
  await mine(1, regtest(client.verifier.lock));
  await mine(1, regtest(lockOf(client.contract.getSatoshiContainerAddress())));
  const view = () => client.view(history);
  const raw = async (lock: Uint8Array) => reader.listUnspent(scripthashOfLock(lock));
  const seen = (await raw(client.workerLock)).length + (await raw(client.verifier.lock)).length;
  check(seen > 13, 'a server lists a miner\'s reward among the coins at a pool\'s lock');
  const note = createNote();
  const coin = (await alice.getUtxos()).find((candidate: any) => candidate.token?.category === asset && candidate.token.amount >= denomination);
  const landed = await client.deposit(alice, note.commitment, await view(), coin);
  check(await inMempool(landed.txid), 'a deposit is relayed beside rewards at the hashing and satoshi locks');
  await client.finish(await view());
  await mine();
  const lock = lockOf(bob.getAddress());
  const current = await view();
  const proof = await client.prove(note, lock, current, proveStatement);
  const paid = await client.submitWithdrawal(proof, (await import('../web/src/pool-client')).le32(note.nullifierHash), lock, current);
  check(await inMempool(paid.txid), 'a withdrawal is relayed beside a reward at the verifier\'s lock');
  await mine();
}

// ---- the sweep, under the node's own relative locks ----
// A hashing or verifier coin unmoved for 1,440 blocks is anyone's, as its transaction's only
// input. The node holds the age: a sweep a block early is not final. A withdrawal cannot hold
// one: beside other inputs the verifier's redeem runs the verifier.
{
  const { client } = open(nativePool);
  const accepts = async (hex: string) => (await rpc('testmempoolaccept', [[hex]]))[0];
  const lone = (coin: any, lock: Uint8Array, unlocking: Uint8Array, fee: bigint) => {
    const builder: any = new TransactionBuilder({ provider: provider as any });
    builder.addInput(coin, { generateLockingBytecode: () => lock, generateUnlockingBytecode: () => unlocking }, { sequence: 1440 });
    builder.addOutput({ to: bob.getAddress(), amount: BigInt(coin.satoshis) - fee });
    return builder.build();
  };
  // A hashing coin worth sweeping: its unlocking is the whole 7.9 kB of MiMC.
  {
    const builder = new TransactionBuilder({ provider: provider as any });
    builder.addInput((await alice.getUtxos()).filter((coin: any) => !coin.token).sort((x: any, y: any) => Number(y.satoshis - x.satoshis))[0], alice.unlockP2PKH());
    builder.addOutput({ to: client.workerLock, amount: 20_000n });
    builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
    await builder.send();
  }
  await mine();
  const dummy = { version: 2, locktime: 0, inputs: [{ outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: new Uint8Array() }], outputs: [] };
  const workerSweep = client.worker.unlock.hash(le32(0n), le32(0n), le32(0n))
    .generateUnlockingBytecode({ transaction: dummy, sourceOutputs: [{ lockingBytecode: client.workerLock, valueSatoshis: 20_000n }], inputIndex: 0 });
  const rich = (await provider.getUtxosForLockingBytecode(client.workerLock)).find((coin: any) => coin.satoshis === 20_000n);
  const verifierCoin = (await provider.getUtxosForLockingBytecode(client.verifier.lock)).find((coin: any) => !coin.token && coin.satoshis === 1_000n);
  const early = await accepts(await lone(verifierCoin, client.verifier.lock, verifierSweepUnlocking(), 300n));
  check(!early.allowed && /BIP68|final/i.test(early['reject-reason'] ?? ''), `the node refuses a sweep before the coin is 1,440 blocks old: ${early['reject-reason']}`);
  await mine(1440);
  const verifierSwept = await lone(verifierCoin, client.verifier.lock, verifierSweepUnlocking(), 300n);
  check((await accepts(verifierSwept)).allowed, `the node takes a lone verifier coin 1,440 blocks old, swept by anyone: ${verifierSwept.length / 2} B`);
  await rpc('sendrawtransaction', [verifierSwept]);
  const workerSwept = await lone(rich, client.workerLock, workerSweep, 9_000n);
  check((await accepts(workerSwept)).allowed, `and a lone hashing coin worth sweeping: ${workerSwept.length / 2} B`);
  await rpc('sendrawtransaction', [workerSwept]);
  await mine();

  // The pool still works: a withdrawal with the sweep's unlocking at a verifier input is refused,
  // and the honest one is paid.
  const { history } = open(nativePool);
  const view = () => client.view(history);
  const note = createNote();
  await client.deposit(alice, note.commitment, await view());
  await client.finish(await view());
  await mine();
  const lock = lockOf(bob.getAddress());
  const current = await view();
  const proof = await client.prove(note, lock, current, proveStatement);
  for (const at of [0, 2]) {
    // Built honestly, then the sweep's unlocking put at one verifier input and handed to the node
    // itself, since the SDK's own run refuses it first. Nothing in a withdrawal is signed.
    const builder: any = await (await client.withdrawalCall(proof, le32(note.nullifierHash), lock, current)).call.build();
    const built: any = decodeTransaction(hexToBin(await builder.build()));
    built.inputs[built.inputs.length - 3 + at].unlockingBytecode = verifierSweepUnlocking();
    const verdict = await accepts(binToHex(encodeTransaction(built)));
    check(!verdict.allowed && /script|verify|evaluat|mandatory/i.test(verdict['reject-reason'] ?? ''),
      `the node refuses a withdrawal with the sweep's unlocking as verifier input ${at}: ${verdict['reject-reason']}`);
  }
  const paid = await client.submitWithdrawal(proof, le32(note.nullifierHash), lock, current);
  check(await inMempool(paid.txid), 'and the honest withdrawal is relayed after the sweeps');
  await mine();
}

// ---- the indexer, given only the factories' categories ----
// It checks each factory's genesis before it reads the factory's events, counts only NFTs of the
// factory's own category at its event address, and checks each pool's creation before it lists
// the pool. A stranger can pay anything to an event address: here, an NFT of their own category
// whose commitment reads as a PoolCreated naming a pool nobody made.
{
  const eventLock = poolCreatedLock('token', factories.token, 'regtest');
  let honest: Uint8Array | undefined;
  for (const item of await reader.history(scripthashOfLock(eventLock))) {
    const raw: any = await reader.transaction(item.tx_hash);
    const tx: any = decodeTransaction(hexToBin(typeof raw === 'string' ? raw : raw.hex));
    const event = tx.outputs.find((output: any) => output.token && binToHex(output.token.category) === factories.token
      && output.token.nft?.capability === 'none');
    if (event) honest = Uint8Array.from(event.token.nft.commitment);
  }
  const forged = Uint8Array.from(honest!);
  const named = hexToBin(tokenPool.category);
  const at = forged.findIndex((_, i) => named.every((byte, j) => forged[i + j] === byte));
  forged[at] ^= 1;
  const forgedEvent = parsePoolCreated('token', forged);
  check(forgedEvent !== undefined && forgedEvent.category !== tokenPool.category, 'a stranger\'s commitment reads as a PoolCreated naming another pool');
  const naming = (await mature())[0];
  const builder = new TransactionBuilder({ provider: provider as any });
  builder.addInput(naming, alice.unlockP2PKH());
  builder.addOutput({ to: eventLock, amount: 1_000n, token: { category: naming.txid, amount: 0n, nft: { capability: 'none', commitment: binToHex(forged) } } });
  builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
  await builder.send();
  await mine();

  const discovery = new Discovery('regtest', FULCRUM, [
    { kind: 'bch', category: factories.bch },
    { kind: 'token', category: factories.token },
    { kind: 'bch', category: asset }, // a category that is no factory
  ], undefined, { add: () => undefined } as any);
  await discovery.start();
  // The factories made three: the BCH pool, and two token pools of the asset at two amounts.
  const made: any[] = [nativePool, tokenPool, griefed];
  const served = [...discovery.pools.values()];
  check(served.length === made.length && made.every((pool) => served.some((listed) => listed.category === pool.category
    && listed.denomination === String(pool.denomination) && listed.asset === pool.asset)),
  `the indexer lists the factories' three pools and nothing else: ${served.map((pool) => `${pool.symbol} ${pool.denomination}`).join(', ')}`);
  check((discovery as any).pending.size === 0, 'and takes no candidate from the stranger\'s NFT at the token factory\'s event address');
  check(discovery.factories.find((factory) => factory.category === asset)?.sound === false, 'and reads nothing through a category that is no factory');
  discovery.stop();
}

// ---- the deployment, run as a deployer runs it ----
{
  const folder = mkdtempSync(join(tmpdir(), 'deployment-'));
  const planFile = join(folder, 'plan.json');
  const file = join(folder, 'regtest.json');
  const run = (script: string, env: object, ...args: string[]) => spawnSync('npx', ['tsx', script, ...args], { encoding: 'utf8', env: { ...process.env, FULCRUM_URL: FULCRUM, ...env } });
  // The scripts hold a server to its network's genesis, so the rehearsal names regtest itself. They
  // take the key from a file only its owner reads, as a run with no terminal does.
  const keyFile = join(folder, 'deployer.key');
  writeFileSync(keyFile, '11'.repeat(32), { mode: 0o600 });
  const deployer = { POOL_NETWORK: 'regtest', DEPLOYER_KEY_FILE: keyFile, DEPLOYMENT_FILE: file };
  const pool = (id: string, extra: object) => ({ id, name: 'test', symbol: 'TST', decimals: 6, denomination: String(denomination), ...extra });
  writeFileSync(planFile, JSON.stringify({ pools: [pool('bch', { kind: 'bch' }), pool('usd', { kind: 'token', asset })] }));
  const early = run('scripts/deploy.ts', deployer, planFile);
  check(early.status !== 0 && /deploy the factories first/.test(early.stderr), 'deploy.ts refuses to make pools before there are factories');
  // A run that stopped right after the BCH factory's genesis went out: the file names the coin it
  // chose, under pending, and the factory stands on chain unrecorded. The next run adopts it.
  await seedLogicalNonce(provider as any, alice, new WeakSet());
  const bchCoin = await selectGenesisFundingUtxo(alice, factoryArtifact('bch'));
  writeFileSync(file, JSON.stringify({
    network: 'regtest', solidcash: { version: solidcashBuild().version }, factories: {}, events: {}, pending: { bch: bchCoin.txid }, pools: [],
  }));
  await deployFactory('bch', alice, { fundingUtxo: bchCoin, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress() });
  const factoriesRun = run('scripts/deploy-factories.ts', deployer);
  check(factoriesRun.status === 0, `deploy-factories.ts deploys both factories${factoriesRun.status === 0
    ? ` (${/spent \d+ sat/.exec(factoriesRun.stdout)?.[0]}, a float topped up where earlier pools left it short)` : `: ${factoriesRun.stdout}${factoriesRun.stderr}`}`);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  check(written.factories?.bch === bchCoin.txid && !written.pending?.bch && /adopted/.test(factoriesRun.stdout),
    `and adopts the BCH factory an earlier run sent without recording, rather than make another (${written.factories?.bch?.slice(0, 12)}, pending ${JSON.stringify(written.pending)})`);
  const again = run('scripts/deploy-factories.ts', deployer);
  check(again.status !== 0 && /not repeated/.test(again.stderr), 'and refuses to deploy them twice');
  await mine();
  writeFileSync(join(folder, 'bad.json'), JSON.stringify({ pools: [pool('bad-id', { kind: 'bch' })] }));
  const refused = run('scripts/deploy.ts', deployer, join(folder, 'bad.json'));
  check(refused.status !== 0 && /cannot be deployed/.test(refused.stderr), 'deploy.ts refuses a bad plan before it spends');
  const deployed = run('scripts/deploy.ts', deployer, planFile);
  check(deployed.status === 0, `deploy.ts makes a plan of two pools through them${deployed.status === 0 ? '' : `: ${deployed.stdout}${deployed.stderr}`}`);
  // A run that stopped can be run again with the same plan: what the file has is skipped.
  const repeated = run('scripts/deploy.ts', deployer, planFile);
  check(repeated.status === 0 && /^bch \S+ \(in .* already\)$/m.test(repeated.stdout) && /^usd \S+ \(in .* already\)$/m.test(repeated.stdout),
    `and, run again, makes neither again${repeated.status === 0 ? '' : `: ${repeated.stdout}${repeated.stderr}`}`);
  // Nothing waits for blocks: the factories are a block deep, and the pools still in the mempool.
  const unmined: string[] = await rpc('getrawmempool');
  const listed: Array<{ category: string }> = JSON.parse(readFileSync(file, 'utf8')).pools;
  check(listed.length === 2 && listed.every((made) => unmined.includes(made.category)), 'the pools\' preps and creations are still in the mempool');
  const verified = run('scripts/verify-deployment.ts', {}, file);
  rmSync(folder, { recursive: true, force: true });
  check(verified.status === 0 && /^bch factory ok$/m.test(verified.stdout) && /^token factory ok$/m.test(verified.stdout)
    && /^bch ok$/m.test(verified.stdout) && /^usd ok$/m.test(verified.stdout),
  `verify-deployment passes both factories and both pools as soon as they are seen${verified.status === 0 ? '' : `: ${verified.stdout}${verified.stderr}`}`);
}

// ---- the deploy command, run as an operator runs it ----
// npm run deploy -- regtest --server … --key-file …, with the key a WIF in a file only its owner
// reads. A run before it stopped right after the BCH factory's genesis went out. The command
// finishes that run in one process: it adopts that factory, makes the token one, tops up the float
// if it is short, and passes verify-deployment at once, with both geneses still in the mempool. It
// makes no pool. Run again, it finds everything done and spends nothing.
{
  const folder = mkdtempSync(join(tmpdir(), 'deploy-command-'));
  const file = join(folder, 'regtest.json');
  const secret = new Uint8Array(32).fill(0x44);
  const operator = new Signer(secret, provider as any);
  const keyFile = join(folder, 'deployer.wif');
  writeFileSync(keyFile, `${encodePrivateKeyWif(secret, 'testnet')}\n`, { mode: 0o600 });
  {
    const builder = new TransactionBuilder({ provider: provider as any });
    builder.addInput((await alice.getUtxos()).filter((coin: any) => !coin.token).sort((x: any, y: any) => Number(y.satoshis - x.satoshis))[0], alice.unlockP2PKH());
    builder.addOutput({ to: operator.getAddress(), amount: 300_000n });
    builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
    await builder.send();
  }
  await mine();
  await seedLogicalNonce(provider as any, operator, new WeakSet());
  const bchCoin = await selectGenesisFundingUtxo(operator, factoryArtifact('bch'));
  writeFileSync(file, JSON.stringify({
    network: 'regtest', solidcash: { version: solidcashBuild().version }, factories: {}, events: {}, pending: { bch: bchCoin.txid }, pools: [],
  }));
  await deployFactory('bch', operator, { fundingUtxo: bchCoin, funder: operator.unlockP2PKH(), changeAddress: operator.getAddress() });
  const plainOf = async () => (await operator.getUtxos()).filter((coin: any) => !coin.token)
    .reduce((sum: bigint, coin: any) => sum + BigInt(coin.satoshis), 0n);
  const deploy = () => spawnSync('npx', ['tsx', 'scripts/deploy-network.ts', 'regtest', '--server', FULCRUM, '--key-file', keyFile], {
    encoding: 'utf8', env: { ...process.env, DEPLOYMENT_FILE: file },
  });
  const output = (run: ReturnType<typeof deploy>) => `${run.stdout}${run.stderr}`;
  const first = deploy();
  const made = JSON.parse(readFileSync(file, 'utf8'));
  check(first.status === 0 && /adopted/.test(first.stdout) && /^bch factory ok$/m.test(first.stdout) && /^token factory ok$/m.test(first.stdout)
    && /^all checks passed$/m.test(first.stdout),
  `the deploy command finishes a run that stopped and passes the check at once${first.status === 0
    ? ` (${/^ {2}spent .*$/m.exec(first.stdout)?.[0].trim()})` : `: ${output(first)}`}`);
  check(made.factories?.bch === bchCoin.txid && /^[0-9a-f]{64}$/.test(made.factories?.token ?? '') && !made.pending?.bch
    && first.stdout.includes(made.factories.bch) && first.stdout.includes(made.factories.token),
  'and writes and prints both factories, the BCH one adopted from the run that stopped');
  const events = [
    ...await factoryPools(reader, 'bch', made.factories.bch, 'regtest'),
    ...await factoryPools(reader, 'token', made.factories.token, 'regtest'),
  ];
  check(Array.isArray(made.pools) && made.pools.length === 0 && events.length === 0,
    `it makes no pool: the file lists none, and neither factory has a PoolCreated event (${made.pools?.length}, ${events.length})`);
  const before = await plainOf();
  const again = deploy();
  check(again.status === 0 && /factories: nothing/.test(again.stdout) && /shared coins: nothing/.test(again.stdout)
    && /^all checks passed$/m.test(again.stdout) && /^ {2}spent +0 sat in this run$/m.test(again.stdout),
  `run again, it finds everything done${again.status === 0 ? '' : `: ${output(again)}`}`);
  check(await plainOf() === before, `and spends nothing (${before} sat before and after)`);
  rmSync(folder, { recursive: true, force: true });
}

finish();
