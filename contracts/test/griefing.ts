// Attacks that steal nothing and could still stop a pool for everyone: a coin the client
// no longer reads, a record it no longer believes, a deployment that hides a second
// master. Each is the SDK's own transaction with one thing changed, judged by the VM, and
// the pool must keep working through the real client afterwards.
//   tsx contracts/test/griefing.ts (npm run test:contracts runs it with the other suites)
import { Signer, TransactionBuilder } from '@solidcash/solidcash';
import {
  createCovenantContractUnlocker, createDataNftUnlocker, createReadOnlyDataNftUnlocker, createSatoshiContainerUnlocker,
  createTokenContainerUnlocker, getDataNftAddress, getEventNftAddress,
} from '@solidcash/solidcash/stateful';
import {
  EVENT_NFT_RELATIVE_LOCK_SEQUENCE, directContainerOptions, directConventionMasterLock,
} from '@solidcash/solidcash/dist/stateful/covenant-helpers.js';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import {
  buildEventNftCovenantScript, buildSatoshiContainerCovenantScript, computeEventNameHash, fillerLockingBytecode, FILLER_SATOSHIS,
  scriptToBytecode,
} from '@solidcash/utils';
import { binToHex, decodeTransaction, encodeDataPush, encodeTransaction, hash256, hexToBin } from '@bitauth/libauth';
import { ChainHistory } from '../../web/src/history';
import { depositValue, le32 } from '../../web/src/pool-client';
import { finishFeeOf, withdrawFeeOf } from '../../web/src/pools';
import { deployPool } from '../../scripts/lib/deploy';
import { deployFactory } from '../../web/src/factory';
import { proveStatement } from '../../service/lib/verifier';
import { genesisProblems, poolReport } from '../../scripts/lib/genesis';
import { ASSET, DENOMINATION, lockOf, newSpend, poolOnMock, reporter } from './lib/setup';

const { check, rejects, finish } = reporter();
const REFUSED = /Program failed|VERIFY|evaluat|verify-flag|Script/i;

const pool = await poolOnMock('bch');
const { provider, signers: [alice, bob, eve], client, reader, transactions } = pool;
const chain = new ChainHistory(reader as any, client);
const view = () => client.view(chain);
const category = client.pool.category;
const bobLock = lockOf(bob.getAddress());
const satoshiCoin = () => provider.getUtxos(client.contract.getSatoshiContainerAddress());
const eventLock = (signature: string) => lockOf(getEventNftAddress(client.contract.inner, category, signature));
const DEPOSIT = 'Deposit(uint32,bytes32)';
const WITHDRAW = 'Withdraw(bytes32)';

/**
 * A coin of the signer's beside the pool, with its change, where the pool's own coins keep
 * their places: after the hashing coins, or before a withdrawal's last three inputs.
 */
const beside = async (builder: any, signer: any, { genesis = false, at = builder.outputs.length, input = builder.inputs.length } = {}) => {
  const coins = (await signer.getUtxos()).filter((coin: any) => !coin.token && coin.satoshis > 100_000n);
  const coin = coins.find((candidate: any) => !genesis || candidate.vout === 0);
  builder.inputs.splice(input, 0, { ...coin, unlocker: signer.unlockP2PKH() });
  builder.outputs.splice(at, 0, { to: signer.getAddress(), amount: coin.satoshis - 5_000n });
  return coin;
};
/**
 * An attack is the attacker's own transaction, so the fee cap of the honest call it was built
 * from does not hold it back: what refuses it here has to be a covenant.
 */
const attack = async (built: Promise<any>) => {
  const builder = await built;
  builder.enforceFeeCaps = false;
  return builder;
};
const stepBuilder = async () => attack((await client.finishCall(await view())).call.build());
const depositBuilder = async () => attack((await client.depositCall(alice, newSpend().commitment, await view())).call.build());
const newToken = (coin: any) => ({ category: coin.txid, amount: 1n });
const forgedNft = (commitment: Uint8Array) => ({ category, amount: 0n, nft: { capability: 'none', commitment: binToHex(commitment) } });
const eventRecord = (leaf: number, value: bigint) => Uint8Array.from([0x50 + leaf, 0x20, ...le32(value)]);
const anchor = () => Uint8Array.from([0x53, 0x43, 0x49, 0x44, 0x01, ...lockOf(client.contract.address)]);
const raw = (lock: Uint8Array, unlocking: Uint8Array) => ({
  generateLockingBytecode: () => lock, generateUnlockingBytecode: () => Uint8Array.from(unlocking),
});

// ---- every event sits where a reader looks for it ----
await rejects('a deposit with the master at another input', /input index 1/, async () => {
  const builder = await depositBuilder();
  const coin = (await eve.getUtxos()).find((candidate: any) => !candidate.token && candidate.satoshis > 100_000n);
  builder.inputs.unshift({ ...coin, unlocker: eve.unlockP2PKH() });
  builder.inputs[2].unlocker = createDataNftUnlocker(client.contract.inner, 1, category);
  builder.inputs[3].unlocker = createSatoshiContainerUnlocker(client.contract.inner, 1, category);
  builder.outputs.unshift({ to: eve.getAddress(), amount: coin.satoshis - 3_000n });
  return builder.send();
});

// ---- a token on a coin the client must keep reading ----
const noteA = newSpend();
await client.deposit(alice, noteA.commitment, await view());

await rejects('a history that names another note as the one being hashed', /being hashed/, async () => client.view({
  deposits: async () => (await chain.deposits()).map((record) => ({ ...record, commitment: 12345n })),
  withdrawals: () => chain.withdrawals(),
}));

await rejects('a new token on the satoshi coin, in a hashing step', REFUSED, async () => {
  const builder = await stepBuilder();
  const coin = await beside(builder, eve, { genesis: true });
  builder.outputs[2] = { ...builder.outputs[2], token: newToken(coin) };
  return builder.send();
});
await rejects('a new token on the hashing coins, in a hashing step', REFUSED, async () => {
  const builder = await stepBuilder();
  const coin = await beside(builder, eve, { genesis: true });
  for (let i = 3; i < 13; i += 1) builder.outputs[i] = { ...builder.outputs[i], token: newToken(coin) };
  return builder.send();
});
await rejects('an NFT of the pool\'s own category on the satoshi coin', REFUSED, async () => {
  const builder = await stepBuilder();
  await beside(builder, eve);
  builder.outputs[2] = { ...builder.outputs[2], token: forgedNft(new Uint8Array()) };
  return builder.send();
});
await rejects('a master grown to 128 bytes, in a hashing step', REFUSED, async () => {
  const builder = await stepBuilder();
  builder.outputs[0] = { ...builder.outputs[0], token: { ...builder.outputs[0].token, nft: { capability: 'minting', commitment: 'ff'.repeat(128) } } };
  return builder.send();
});

// ---- records at an event's address that are not events ----
// The VM takes these two, so the client has to tell them apart.
{
  const builder = await stepBuilder();
  await beside(builder, eve);
  builder.outputs.push({ to: eventLock(DEPOSIT), amount: 1_000n, token: forgedNft(new Uint8Array()) });
  await builder.send();
  check((await view()).tree.size === 1, 'an empty record at the Deposit address is skipped');
}
await client.deposit(alice, newSpend().commitment, await view());
{
  const builder = await stepBuilder();
  await beside(builder, eve);
  builder.outputs.push({ to: eventLock(WITHDRAW), amount: 1_000n, token: forgedNft(anchor()) });
  builder.outputs.push({ to: eventLock(DEPOSIT), amount: 1_000n, token: forgedNft(anchor()) });
  await builder.send();
  check((await view()).tree.size === 2, 'an anchor at the Deposit and Withdraw addresses is skipped');
}

const noteB = newSpend();
await client.deposit(alice, noteB.commitment, await view());
await rejects('a forged event in the form of a real one, in a hashing step', REFUSED, async () => {
  const builder = await stepBuilder();
  await beside(builder, eve);
  builder.outputs.push({ to: eventLock(DEPOSIT), amount: 1_000n, token: forgedNft(eventRecord(3, 12345n)) });
  return builder.send();
});

// The forged step left noteB pending; finish it with an honest step before the records.
await client.finish(await view());

// A record can arrive at an event's address from a transaction that is not the pool's.
// The mock mines the carrier coin (a standard send could not name the event's lock), and
// the spend that moves it is ordinary.
{
  const carrier = eve.getAddress();
  const mined = { txid: `${'e0'.repeat(32)}`, vout: 0, satoshis: 2_000n, token: forgedNft(eventRecord(3, 12345n)) };
  await provider.seedUtxo(carrier, mined);
  const carried = (await provider.getUtxos(carrier)).find((coin: any) => coin.token?.nft?.commitment.length);
  const funds = (await eve.getUtxos()).find((coin: any) => !coin.token && coin.satoshis > 100_000n);
  await new TransactionBuilder({ provider })
    .addInput(carried, eve.unlockP2PKH())
    .addInput(funds, eve.unlockP2PKH())
    .addOutput({ to: eventLock(DEPOSIT), amount: carried.satoshis, token: carried.token })
    .addOutput({ to: eve.getAddress(), amount: funds.satoshis - 3_000n })
    .send();
  check((await view()).tree.size === 3, 'a record moved to the Deposit address by hand is skipped');
}

// After 144 blocks anyone can spend an event, and it can go back where it was.
await provider.mine(150);
{
  const [event] = (await provider.getUtxosForLockingBytecode(eventLock(DEPOSIT))).filter((coin: any) => coin.token?.nft?.commitment.length > 0);
  const redeem = scriptToBytecode(buildEventNftCovenantScript(hexToBin(category), computeEventNameHash(DEPOSIT)));
  const funds = (await eve.getUtxos()).find((coin: any) => !coin.token && coin.satoshis > 100_000n);
  await new TransactionBuilder({ provider })
    .addInput(event, raw(eventLock(DEPOSIT), encodeDataPush(redeem)), { sequence: EVENT_NFT_RELATIVE_LOCK_SEQUENCE })
    .addInput(funds, eve.unlockP2PKH())
    .addOutput({ to: eventLock(DEPOSIT), amount: event.satoshis, token: event.token })
    .addOutput({ to: eve.getAddress(), amount: funds.satoshis - 3_000n })
    .send();
  check((await view()).tree.size === 3, 'an event spent back to its own address is skipped');
}

// ---- deposits and withdrawals ----
await rejects('a new token on the satoshi coin, in a deposit', REFUSED, async () => {
  const builder = await depositBuilder();
  const coin = await beside(builder, eve, { genesis: true });
  builder.outputs[2] = { ...builder.outputs[2], token: newToken(coin) };
  return builder.send();
});
await rejects('a master grown to 128 bytes, in a deposit', REFUSED, async () => {
  const builder = await depositBuilder();
  builder.outputs[0] = { ...builder.outputs[0], token: { ...builder.outputs[0].token, nft: { capability: 'minting', commitment: 'ff'.repeat(128) } } };
  return builder.send();
});

await rejects('a forged Withdraw record beside a deposit', REFUSED, async () => {
  const builder = await depositBuilder();
  await beside(builder, eve);
  builder.outputs.push({ to: eventLock(WITHDRAW), amount: 1_000n, token: forgedNft(Uint8Array.from([0x20, ...le32(99n)])) });
  return builder.send();
});
await rejects('a deposit whose event names another commitment', REFUSED, async () => {
  const builder = await depositBuilder();
  const event = builder.outputs[3];
  builder.outputs[3] = { ...event, token: { ...event.token, nft: { ...event.token.nft, commitment: binToHex(eventRecord(2, 777n)) } } };
  return builder.send();
});

const current = await view();
const proof = await client.prove(noteA, bobLock, current, proveStatement);
const withdrawal = async () => attack((await client.withdrawalCall(proof, le32(noteA.nullifierHash), bobLock, current)).call.build());
await rejects('a new token on the verifier\'s coins, in a withdrawal', REFUSED, async () => {
  const builder = await withdrawal();
  const coin = await beside(builder, eve, { genesis: true, at: 5, input: 3 });
  for (let i = builder.outputs.length - 3; i < builder.outputs.length; i += 1) builder.outputs[i] = { ...builder.outputs[i], token: newToken(coin) };
  return builder.send();
});
await rejects('a new token on the satoshi coin, in a withdrawal', REFUSED, async () => {
  const builder = await withdrawal();
  const coin = await beside(builder, eve, { genesis: true, at: 5, input: 3 });
  builder.outputs[2] = { ...builder.outputs[2], token: newToken(coin) };
  return builder.send();
});
await rejects('a master grown to 128 bytes, in a withdrawal', REFUSED, async () => {
  const builder = await withdrawal();
  builder.outputs[0] = { ...builder.outputs[0], token: { ...builder.outputs[0].token, nft: { capability: 'minting', commitment: 'ff'.repeat(128) } } };
  return builder.send();
});
await rejects('a hashing coin spent beside a withdrawal', REFUSED, async () => {
  const builder = await withdrawal();
  const [coin] = await provider.getUtxosForLockingBytecode(client.workerLock);
  // Paid for, so that the coin's own script is what refuses it.
  await beside(builder, eve, { at: 5, input: 3 });
  builder.outputs[5] = { ...builder.outputs[5], amount: builder.outputs[5].amount - 20_000n };
  builder.inputs.splice(3, 0, { ...coin, unlocker: client.worker.unlock.hash(le32(1n), le32(2n), le32(3n)) });
  return builder.send();
});
await rejects('a forged event on the recipient\'s output', REFUSED, async () => {
  const builder = await withdrawal();
  await beside(builder, eve, { at: 5, input: 3 });
  builder.outputs[3] = { ...builder.outputs[3], token: forgedNft(eventRecord(3, 99n)) };
  return builder.send();
});

// ---- coins anyone can pay in ----
await provider.seedUtxo(client.worker.address, { txid: '00'.repeat(32), vout: 0, satoshis: 100n });
await provider.seedUtxo(binToHex(client.verifier.lock), { txid: '00'.repeat(32), vout: 1, satoshis: 100n });

// ---- coins anyone can move, which PRODUCTION accepts ----
// The satoshi coin's merge path and the state record's read-only path need no master, so anyone
// can spend either back to itself. A wallet's signature names both, so a move while a wallet
// signs spoils that deposit: these sizes are the price of that griefing.
{
  const inner = (client.contract as any).inner ?? client.contract;
  const moved = async (coin: any, unlocker: any, output: any): Promise<number> => {
    const funding = (await eve.getUtxos()).filter((c: any) => !c.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
    const builder = new TransactionBuilder({ provider });
    builder.addInput(coin, unlocker);
    builder.addInput(funding, eve.unlockP2PKH());
    builder.addOutput(output);
    builder.addOutput({ to: eve.getAddress(), amount: funding.satoshis - 1_000n });
    const sent: any = await builder.send();
    return (sent.hex ?? await provider.getRawTransaction(sent.txid ?? sent)).length / 2;
  };
  const satoshiAddress = client.contract.getSatoshiContainerAddress();
  const plain = (await satoshiCoin()).find((coin: any) => !coin.token);
  const covenant = buildSatoshiContainerCovenantScript(hexToBin(category), directConventionMasterLock(inner),
    directContainerOptions(inner, 'satoshiContainer'));
  const merge = createCovenantContractUnlocker(inner, `SatoshiContainer_${category.slice(0, 8)}`, covenant,
    [{ name: 'flag', type: 'bigint' }, { name: 'masterInputIndex', type: 'bigint' }], [0n, 0n], 'p2sh32');
  const satoshiMove = await moved(plain, merge, { to: lockOf(satoshiAddress), amount: plain.satoshis });
  check(satoshiMove >= 500 && satoshiMove <= 520, `anyone can move the satoshi coin back to itself, for ${satoshiMove} B`);
  const recordAddress = client.contract.getDataNftAddress();
  const record = (await provider.getUtxos(recordAddress)).find((coin: any) => coin.token?.nft?.capability === 'mutable');
  const recordMove = await moved(record, createReadOnlyDataNftUnlocker(inner, category),
    { to: lockOf(recordAddress), amount: record.satoshis, token: record.token });
  check(recordMove >= 640 && recordMove <= 660, `and the state record, for ${recordMove} B`);
}

// ---- the pool still works, on the chain's own records ----
const bobBefore = (await bob.getUtxos()).reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
await client.withdraw(noteA, bobLock, await view(), proveStatement);
const bobAfter = (await bob.getUtxos()).reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
check(BigInt(bobAfter) - BigInt(bobBefore) === DENOMINATION, 'a withdrawal pays through all of that');

const noteC = newSpend();
await client.deposit(alice, noteC.commitment, await view());
await client.finish(await view());
const end = await view();
check(end.tree.size === 4 && end.nullifiers.root().length === 32, 'a note lands through all of that');
check((await satoshiCoin()).filter((coin: any) => !coin.token).length === 1, 'the satoshi coin is one plain coin');
const genesisFindings = (await poolReport(client, reader, pool.factory)).problems;
check(genesisFindings.length === 0, `an honest deployment has nothing wrong with it${genesisFindings.length ? `: ${genesisFindings.join(', ')}` : ''}`);

// ---- a dishonest genesis ----
/** What the checks find in a pool's own genesis with something changed, on a chain where it is the genesis. */
const genesisOf = ({ client: of, reader: chainReader, transactions: sent, factory: creator }: Awaited<ReturnType<typeof poolOnMock>>) => {
  const isGenesis = (hex: string) => (decodeTransaction(hexToBin(hex)) as any).inputs
    .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === of.pool.category);
  const honest = sent.find(isGenesis)!;
  let height = 1;
  const tampered = async (mutate: (tx: any) => void) => {
    const tx = decodeTransaction(hexToBin(honest)) as any;
    mutate(tx);
    const hex = binToHex(encodeTransaction(tx));
    const idOf = (bytes: string) => binToHex(hash256(hexToBin(bytes)).slice().reverse());
    return genesisProblems(of, {
      history: async (scripthash: string) => (await chainReader.history(scripthash)).map((entry: { tx_hash: string; height: number }) => (
        entry.tx_hash === idOf(honest) ? { tx_hash: idOf(hex), height } : entry)),
      transaction: async (txid: string) => (txid === idOf(hex) ? hex : chainReader.transaction(txid)),
    }, creator);
  };
  const found = async (label: string, finding: RegExp, mutate: (tx: any) => void, heightOf = 1) => {
    height = heightOf;
    const problems = await tampered(mutate);
    check(problems.length === 1 && finding.test(problems[0]), `${label}${problems.length === 1 ? '' : `: ${problems.join(', ')}`}`);
  };
  /** A change the check must take, as the chain takes it, at `heightOf` (0 in the mempool). */
  const takes = async (label: string, mutate: (tx: any) => void, heightOf = 1) => {
    height = heightOf;
    const problems = await tampered(mutate);
    check(problems.length === 0, `${label}${problems.length === 0 ? '' : `: ${problems.join(', ')}`}`);
  };
  return { honest, found, takes };
};
/** The pool's own master: a factory's creation also recreates the factory's. */
const poolMaster = (output: any) => output.token?.nft?.capability === 'minting' && binToHex(output.token.category) === category;
{
  const { honest, found, takes } = genesisOf(pool);
  const nft = (capability: string, commitment = new Uint8Array()) => ({
    lockingBytecode: bobLock, valueSatoshis: 1_000n,
    token: { amount: 0n, category: hexToBin(category), nft: { capability, commitment } },
  });
  await found('a second master in the genesis is found', /2 minting/, (tx) => tx.outputs.push(nft('minting')));
  await found('a second state record in the genesis is found', /2 state records/, (tx) => tx.outputs.push(nft('mutable')));
  await found('a forged event in the genesis is found', /another NFT/, (tx) => tx.outputs.push(nft('none', eventRecord(0, 7n))));
  await found('a fungible supply in the genesis is found', /fungible/, (tx) => {
    tx.outputs.find(poolMaster).token.amount = 1_000n;
  });
  await found('a state record for a made-up tree is found', /empty pool/, (tx) => {
    const state = tx.outputs.find((output: any) => output.token?.nft?.capability === 'mutable' && output.token.nft.commitment[0] === 0x20);
    state.token.nft.commitment = state.token.nft.commitment.slice().fill(7, 1, 33);
  });
  const lying = await genesisProblems(client, {
    history: reader.history,
    transaction: async (txid: string) => {
      const found = await reader.transaction(txid);
      return found === honest ? binToHex(encodeTransaction({ ...(decodeTransaction(hexToBin(honest)) as any), locktime: 1 })) : found;
    },
  }, pool.factory);
  check(/other bytes/.test(lying.join()), 'a server answering with other bytes is caught');
  // The factory's own event names the pool, two outputs after the factory's master, where its
  // `create` writes it.
  const atEventOf = (output: any) => output.token && binToHex(output.token.category) === pool.factory;
  await found('a creation without its PoolCreated is found', /no PoolCreated/, (tx) => { tx.outputs = tx.outputs.filter((output: any) => !atEventOf(output)); });
  await found('a master that holds a commitment is found', /commitment/, (tx) => {
    tx.outputs.find(poolMaster).token.nft.commitment = new Uint8Array(40);
  });
  const satoshiLock = lockOf(client.contract.getSatoshiContainerAddress());
  const atSatoshiLock = (output: any) => binToHex(output.lockingBytecode) === binToHex(satoshiLock);
  await found('a token on the satoshi coin is found', /satoshi coin/, (tx) => {
    tx.outputs.find(atSatoshiLock).token = { amount: 1n, category: hexToBin('ee'.repeat(32)) };
  });
  await found('a genesis with no satoshi coin is found', /0 satoshi coins/, (tx) => { tx.outputs = tx.outputs.filter((output: any) => !atSatoshiLock(output)); });
  await found('a second satoshi coin is found', /2 satoshi coins/, (tx) => { tx.outputs.push({ lockingBytecode: satoshiLock, valueSatoshis: 5_000n }); });
  await found('a satoshi coin too small to hold is found', /satoshi coin holds 576 sat/, (tx) => { tx.outputs.find(atSatoshiLock).valueSatoshis = 576n; });
  // A record's commitment grows with the pool, and the coin holding it keeps its satoshis.
  const stateLock = binToHex(lockOf(getDataNftAddress(client.contract.inner, category)));
  await found('a state record opened too small is found', /state record holds 984 sat/, (tx) => {
    tx.outputs.find((output: any) => binToHex(output.lockingBytecode) === stateLock).valueSatoshis = 984n;
  });
  await found('a master opened too small is found', /master holds 684 sat/, (tx) => {
    tx.outputs.find(poolMaster).valueSatoshis = 684n;
  });
  // A genesis counts as soon as it is seen: nothing waits for blocks to bury it.
  await takes('a genesis still in the mempool is taken', () => undefined, 0);
  await takes('a genesis a few blocks deep is taken', () => undefined, await provider.getBlockHeight() - 2);
}

// ---- the token pool ----
const token = await poolOnMock('token');
{
  const { client: tokenClient, signers: [owner, , thief], addCoin, view: tokenView } = token;
  const asset = (await addCoin(owner, 1_000n, { category: ASSET, amount: DENOMINATION }));
  await tokenClient.deposit(owner, newSpend().commitment, await tokenView(), asset);
  const tokenStep = async () => attack((await tokenClient.finishCall(await tokenView())).call.build());

  await rejects('a new token on the satoshi coin of a token pool', REFUSED, async () => {
    const builder = await tokenStep();
    const coin = await beside(builder, thief, { genesis: true });
    builder.outputs[2] = { ...builder.outputs[2], token: newToken(coin) };
    return builder.send();
  });

  const tokenAddress = tokenClient.contract.tokens[ASSET].address;
  const [held] = (await token.provider.getUtxos(tokenAddress)).filter((coin: any) => coin.token?.category === ASSET);
  await rejects('the token coin in a hashing step, paying a thief', REFUSED, async () => {
    // A container keeps its input's index, so the coin goes after the hashing coins.
    const builder = await tokenStep();
    const [funds] = (await thief.getUtxos()).filter((coin: any) => !coin.token && coin.satoshis > 100_000n);
    builder.inputs.push(
      { ...held, unlocker: createTokenContainerUnlocker(tokenClient.contract.inner, 0, tokenClient.pool.category, ASSET) },
      { ...funds, unlocker: thief.unlockP2PKH() },
    );
    builder.outputs.push(
      { to: tokenAddress, amount: held.satoshis, token: { category: ASSET, amount: held.token.amount - 1n } },
      { to: thief.getTokenAddress?.() ?? thief.getAddress(), amount: 1_000n, token: { category: ASSET, amount: 1n } },
      { to: thief.getAddress(), amount: funds.satoshis - 20_000n },
    );
    return builder.send();
  });

  // ---- an NFT of the asset on the token coin ----
  // A category can hold fungible units and NFTs, and an NFT on the coin can stop it: a minting one
  // brings the mint bound, which lets it pay no tokens at all. So the coin stays as it is.
  const { provider: tokenProvider } = token;
  await tokenClient.finish(await tokenView());
  const noteD = newSpend();
  await tokenClient.deposit(owner, noteD.commitment, await tokenView(), await addCoin(owner, 1_000n, { category: ASSET, amount: DENOMINATION }));
  await tokenClient.finish(await tokenView());
  const thiefLock = lockOf(thief.getAddress());
  const pinned = await tokenView();
  const proved = await tokenClient.prove(noteD, thiefLock, pinned, proveStatement);
  for (const [capability, commitment] of [['none', 'ab'.repeat(40)], ['mutable', ''], ['minting', '']]) {
    await rejects(`a ${capability} NFT hung on the token coin by a withdrawal`, REFUSED, async () => {
      const nftCoin = await addCoin(thief, 1_000n, { category: ASSET, amount: 0n, nft: { capability, commitment } });
      const built = await attack((await tokenClient.withdrawalCall(proved, le32(noteD.nullifierHash), thiefLock, pinned)).call.build());
      built.inputs.splice(4, 0, { ...nftCoin, unlocker: thief.unlockP2PKH() });
      const kept = built.outputs.findIndex((output: any) => output.token?.category === ASSET && output.to !== undefined && output.token.amount >= DENOMINATION);
      built.outputs[kept] = { ...built.outputs[kept], token: { ...built.outputs[kept].token, nft: (nftCoin.token as any).nft } };
      return built.send();
    });
  }
  const heldCoins = () => tokenProvider.getUtxos(tokenAddress).then((coins: any[]) => coins.filter((coin) => coin.token?.category === ASSET));
  check((await heldCoins()).every((coin: any) => coin.token.nft === undefined), 'and the token coin holds none');
  const noteE = newSpend();
  await tokenClient.deposit(owner, noteE.commitment, await tokenView(), await addCoin(owner, 1_000n, { category: ASSET, amount: DENOMINATION }));
  await tokenClient.finish(await tokenView());
  const paid = await tokenClient.withdraw(noteE, lockOf(owner.getAddress()), await tokenView(), proveStatement);
  check(paid.hex.length / 2 + 2_400 <= Number(withdrawFeeOf('token')), `the pool works past it, and the fee covers the withdrawal and its two funded outputs: ${paid.hex.length / 2} B`);
  check((await heldCoins()).length === 1, 'and the token coin stays one coin');

  // ---- the token coin's genesis ----
  // Its category is the asset's, so nothing that reads the pool's own category sees it.
  const tokenFindings = (await poolReport(tokenClient, token.reader, token.factory)).problems;
  check(tokenFindings.length === 0, `an honest token deployment has nothing wrong with it${tokenFindings.length ? `: ${tokenFindings.join(', ')}` : ''}`);
  const { found, takes } = genesisOf(token);
  const tokenLock = binToHex(lockOf(tokenAddress));
  const atTokenLock = (output: any) => binToHex(output.lockingBytecode) === tokenLock;
  await found('a genesis with no token coin is found', /0 token coins/, (tx) => { tx.outputs = tx.outputs.filter((output: any) => !atTokenLock(output)); });
  await found('a token coin moved to another lock is found', /0 token coins/, (tx) => { tx.outputs.find(atTokenLock).lockingBytecode = thiefLock; });
  await found('a second token coin is found', /2 token coins/, (tx) => { tx.outputs.push({ ...tx.outputs.find(atTokenLock) }); });
  // The chain takes a creation that opens the coin with more than one unit, and the pool asks only
  // that its coin hold at least one, so the check takes it too: refusing it would leave that asset
  // and amount without a pool for good (deployer-genesis.test.ts). The extra stays in the coin.
  await takes('a token coin of more than one unit is taken, as the chain takes it', (tx) => { tx.outputs.find(atTokenLock).token.amount = 777n; });
  await found('a token coin of another category is found', /does not hold the asset/, (tx) => { tx.outputs.find(atTokenLock).token.category = hexToBin('ee'.repeat(32)); });
  await found('a minting NFT on the token coin is found', /an NFT/, (tx) => { tx.outputs.find(atTokenLock).token.nft = { capability: 'minting', commitment: new Uint8Array() }; });
  await found('a token coin too small to grow is found', /681 sat/, (tx) => { tx.outputs.find(atTokenLock).valueSatoshis = 681n; });
}

// ---- the token coin's satoshis ----
// A coin is recreated with the satoshis it holds, and the dust floor rises with its amount: 681
// sat at 2 units, 693 at 100,000. So a coin too small for its next amount can stop every call.
{
  const fresh = await poolOnMock('token');
  const { client: pooled, signers: [owner, recipient, griefer], addCoin, provider: chain2, reader: chainReader } = fresh;
  const seen = new ChainHistory(chainReader as any, pooled);
  const look = () => pooled.view(seen);
  const address = pooled.contract.tokens[ASSET].address;
  const coinsAt = async () => (await chain2.getUtxos(address)).filter((coin: any) => coin.token?.category === ASSET);
  const payIn = async (amount: bigint, satoshis: bigint) => {
    const coin = await addCoin(griefer, 3_000n, { category: ASSET, amount });
    const [funds] = (await griefer.getUtxos()).filter((candidate: any) => !candidate.token && candidate.satoshis > 100_000n);
    await new TransactionBuilder({ provider: chain2 })
      .addInput(coin, griefer.unlockP2PKH())
      .addInput(funds, griefer.unlockP2PKH())
      .addOutput({ to: lockOf(address), amount: satoshis, token: { category: ASSET, amount } })
      .addOutput({ to: griefer.getAddress(), amount: funds.satoshis - 2_000n })
      .send();
  };
  const noteOf = async () => {
    const spend = newSpend();
    await pooled.deposit(owner, spend.commitment, await look(), await addCoin(owner, 1_000n, { category: ASSET, amount: DENOMINATION }));
    return spend;
  };

  await payIn(2n, 681n);
  const first = await noteOf();
  await pooled.finish(await look());
  check((await coinsAt()).some((coin: any) => coin.token.amount === 1n + DENOMINATION), 'a larger coin at its dust floor does not stop a new pool');

  const tookFrom = async (build: () => Promise<any>) => {
    const builder = await build();
    const [held] = (await coinsAt()).sort((a: any, b: any) => Number(b.token.amount - a.token.amount));
    const [funds] = (await griefer.getUtxos()).filter((candidate: any) => !candidate.token && candidate.satoshis > 100_000n);
    builder.inputs.push(
      { ...held, unlocker: createTokenContainerUnlocker(pooled.contract.inner, 0, pooled.pool.category, ASSET) },
      { ...funds, unlocker: griefer.unlockP2PKH() },
    );
    builder.outputs.push(
      { to: address, amount: held.satoshis - 300n, token: held.token },
      { to: griefer.getAddress(), amount: funds.satoshis - 20_000n + 300n },
    );
    return builder.send();
  };
  await noteOf();
  await rejects('the token coin\'s satoshis taken by a hashing step, which needs no note', REFUSED, () => tookFrom(async () => attack((await pooled.finishCall(await look())).call.build())));
  await pooled.finish(await look());
  check((await coinsAt()).every((coin: any) => coin.satoshis >= 681n), 'nothing shrinks a coin at the token lock');

  // Relay refuses a coin under its floor, and a miner need not.
  await chain2.seedUtxo(address, { txid: 'ee'.repeat(32), vout: 0, satoshis: 300n, token: { category: ASSET, amount: 50n * DENOMINATION } });
  const paid = await pooled.withdraw(first, lockOf(recipient.getAddress()), await look(), proveStatement);
  check(Boolean(paid.txid), 'a larger coin under the floor does not stop a withdrawal');
  await noteOf();
  await pooled.finish(await look());
  check((await coinsAt()).some((coin: any) => coin.satoshis === 300n), 'and it does not stop a deposit: it is passed over, and stays');
}

// ---- a pool's money stays in one coin ----
// Anyone can pay a coin to a pool's lock, and a transaction can pick it. If money could spread over
// such coins, a note could find none that pays it: the client spends one, and a withdrawal has
// nowhere to take a second from. So a coin takes a note only if it then holds all the pool owes.
{
  const bch = await poolOnMock('bch');
  const { client: pooled, signers: [owner, payee, griefer], provider: chain3, reader: chainReader } = bch;
  const seen = new ChainHistory(chainReader as any, pooled);
  const look = () => pooled.view(seen);
  const address = pooled.contract.getSatoshiContainerAddress();
  const lock = lockOf(address);
  const unlock = () => createSatoshiContainerUnlocker(pooled.contract.inner, 0, pooled.pool.category);
  const noteOf = async () => { const spend = newSpend(); await pooled.deposit(owner, spend.commitment, await look()); await pooled.finish(await look()); return spend; };
  const biggest = async () => (await griefer.getUtxos()).filter((coin: any) => !coin.token && coin.satoshis > 100_000n)[0];
  const stranger = async (satoshis: bigint, tokenOf?: (coin: any) => any) => {
    const funds = await biggest();
    await new TransactionBuilder({ provider: chain3 })
      .addInput(funds, griefer.unlockP2PKH())
      .addOutput({ to: lock, amount: satoshis, ...(tokenOf ? { token: tokenOf(funds) } : {}) })
      .addOutput({ to: griefer.getAddress(), amount: funds.satoshis - satoshis - 2_000n })
      .send();
    const coins = await chain3.getUtxos(address);
    return coins.find((coin: any) => coin.satoshis === satoshis);
  };
  const first = await noteOf();
  const coinAtSlot = (builder: any, coin: any, real: any) => {
    builder.inputs[2] = { ...coin, unlocker: unlock() };
    builder.inputs.push({ ...real, unlocker: unlock() });
  };
  const sweep = async (coin: any) => {
    await pooled.deposit(owner, newSpend().commitment, await look());
    const builder: any = await attack((await pooled.finishCall(await look())).call.build());
    const real = (await chain3.getUtxos(address)).filter((candidate: any) => !candidate.token && candidate.txid !== coin.txid).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
    const funds = await biggest();
    coinAtSlot(builder, coin, real);
    builder.inputs.push({ ...funds, unlocker: griefer.unlockP2PKH() });
    builder.outputs[2] = { to: lock, amount: coin.satoshis + real.satoshis - finishFeeOf('bch'), ...(coin.token ? { token: coin.token } : {}) };
    builder.outputs.push({ to: fillerLockingBytecode(), amount: FILLER_SATOSHIS }, { to: griefer.getAddress(), amount: funds.satoshis - 3_000n });
    return builder;
  };
  const tokenCoin = await stranger(1_000n, (funds) => ({ category: funds.txid, amount: 1n }));
  await rejects('the pool\'s satoshis swept onto a coin with a token, which no client reads', REFUSED, async () => (await sweep(tokenCoin)).send());
  await pooled.finish(await look());

  const depositInto = async (coin: any) => {
    const builder: any = await attack((await pooled.depositCall(owner, newSpend().commitment, await look())).call.build());
    builder.inputs[2] = { ...coin, unlocker: unlock() };
    builder.outputs[2] = { ...builder.outputs[2], amount: coin.satoshis + depositValue(pooled.pool) };
    return builder.send();
  };
  const reserve = (await chain3.getUtxos(address)).filter((coin: any) => !coin.token).reduce((most: bigint, coin: any) => (coin.satoshis > most ? coin.satoshis : most), 0n);
  await rejects('a deposit into a coin one satoshi short of what the pool owes', REFUSED, async () => depositInto(await stranger(reserve - 1n)));
  check(await depositInto(await stranger(reserve)), 'the same deposit lands on a coin that holds it all');
  await pooled.finish(await look());
  const second = await noteOf();
  check((await pooled.withdraw(first, lockOf(payee.getAddress()), await look(), proveStatement)).txid, 'a coin that holds all the pool owes can take over, and pays');
  check((await pooled.withdraw(second, lockOf(payee.getAddress()), await look(), proveStatement)).txid, 'and every note after it');
}
{
  const fresh = await poolOnMock('token');
  const { client: pooled, signers: [owner, payee, griefer], provider: chain4, addCoin, reader: chainReader } = fresh;
  const seen = new ChainHistory(chainReader as any, pooled);
  const look = () => pooled.view(seen);
  const address = pooled.contract.tokens[ASSET].address;
  const lock = lockOf(address);
  const unlock = () => createTokenContainerUnlocker(pooled.contract.inner, 0, pooled.pool.category, ASSET);
  const asset = () => addCoin(owner, 1_000n, { category: ASSET, amount: DENOMINATION });
  const noteOf = async () => { const spend = newSpend(); await pooled.deposit(owner, spend.commitment, await look(), await asset()); await pooled.finish(await look()); return spend; };
  const first = await noteOf();

  let next = 0;
  const seedAt = async (satoshis: bigint, token: object) => {
    next += 1;
    const coin = { txid: `${'be'.repeat(31)}${next.toString(16).padStart(2, '0')}`, vout: 0, satoshis, token: { category: ASSET, ...token } };
    await chain4.seedUtxo(address, coin);
    return coin;
  };
  const depositInto = async (coin: any) => {
    const builder: any = await attack((await pooled.depositCall(owner, newSpend().commitment, await look(), await asset())).call.build());
    builder.inputs[3] = { ...coin, unlocker: unlock() };
    builder.outputs[3] = { to: lock, amount: coin.satoshis, token: { ...coin.token, amount: coin.token.amount + DENOMINATION } };
    return builder.send();
  };
  // Each of these is the coin below with one thing changed, and that coin takes the deposit.
  const large = 50n * DENOMINATION;
  await rejects('a deposit into a coin too small to recreate', REFUSED, async () => depositInto(await seedAt(704n, { amount: large })));
  await rejects('a deposit into a coin one unit short of what the pool owes', REFUSED, async () => depositInto(await seedAt(1_200n, { amount: DENOMINATION })));
  await rejects('a deposit into a coin with a minting NFT', REFUSED, async () => depositInto(await seedAt(1_200n, { amount: large, nft: { capability: 'minting', commitment: '' } })));
  await rejects('a deposit into a coin with a mutable NFT', REFUSED, async () => depositInto(await seedAt(1_200n, { amount: large, nft: { capability: 'mutable', commitment: '' } })));
  await rejects('a deposit into a coin with an immutable NFT', REFUSED, async () => depositInto(await seedAt(1_200n, { amount: large, nft: { capability: 'none', commitment: 'ab' } })));
  check(await depositInto(await seedAt(1_200n, { amount: DENOMINATION + 1n })), 'the same deposit lands on a clean coin that holds what the pool owes');
  await pooled.finish(await look());

  // A larger coin the client must not touch stops nothing: all of those above are still there.
  const second = await noteOf();
  check((await pooled.withdraw(first, lockOf(payee.getAddress()), await look(), proveStatement)).txid, 'none of those coins stops the client');

  // The SDK's rule and the contract's meet exactly: at 704 sat a coin is refused and passed over,
  // and at 705, the dust floor of the largest amount, the client takes it and the contract agrees.
  const atFloor = await seedAt(705n, { amount: 60n * DENOMINATION });
  await noteOf();
  check((await chain4.getUtxos(address)).some((coin: any) => coin.satoshis === 705n && coin.token?.amount === (atFloor.token as any).amount + DENOMINATION), 'a coin at the floor takes a note');

  // An immutable NFT with an empty commitment beside a fungible amount: no script can see it, so
  // it can reach the pool's own coin in a deposit, and the client has to carry it.
  const nft = { capability: 'none', commitment: '' };
  const hidden = await addCoin(griefer, 1_000n, { category: ASSET, amount: DENOMINATION, nft });
  const looksPlain = { ...hidden, token: { category: ASSET, amount: DENOMINATION } };
  const builder: any = await attack((await pooled.depositCall(griefer, newSpend().commitment, await look(), looksPlain)).call.build());
  builder.inputs[builder.inputs.findIndex((input: any) => input.txid === hidden.txid)].token = hidden.token;
  builder.outputs[3] = { ...builder.outputs[3], token: { ...builder.outputs[3].token, nft } };
  await builder.send();
  await pooled.finish(await look());
  const carrier = (await chain4.getUtxos(address)).find((coin: any) => coin.token?.nft?.commitment === '' && coin.token.nft.capability === 'none');
  check(carrier, 'an NFT no script can see can reach the pool\'s coin');
  const third = await noteOf();
  check((await pooled.withdraw(second, lockOf(payee.getAddress()), await look(), proveStatement)).txid, 'and the client still pays from that coin');
  check((await pooled.withdraw(third, lockOf(payee.getAddress()), await look(), proveStatement)).txid, 'and takes deposits into it');
}

// ---- a plan of two pools, from few coins ----
// The factory refuses a second pool of an amount, so the two pay different amounts.
{
  const provider2: any = new MockNetworkProvider({ profile: 'production' });
  const deployer = new Signer(new Uint8Array(32).fill(7), provider2);
  for (const byte of ['a1', 'a2', 'a3']) await provider2.seedUtxo(deployer.getAddress(), { txid: byte.repeat(32), vout: 0, satoshis: 200_000n });
  const factory = (await deployFactory('bch', deployer)).categoryId as string;
  const plan = (id: string, denomination: bigint) => ({ id, kind: 'bch' as const, name: 'test', symbol: 'BCH', decimals: 8, denomination });
  const one = await deployPool(provider2, deployer, plan('one', DENOMINATION), factory);
  const two = await deployPool(provider2, deployer, plan('two', DENOMINATION * 10n), factory);
  check(one.category !== two.category, 'a key of three coins makes a factory and two pools through it');
}

finish();
