// The token pool: deposit, withdraw, the rules on deposit coins, griefing of the token
// container. Neither category is a palindrome, so byte order does real work here.
//   tsx contracts/test/token-pool.ts (npm run test:contracts runs it with the other suites)
import { TransactionBuilder } from '@solidcash/solidcash';
import { sha256, binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { depositValue, le32, recipientField, stepWitness, type FeeTopUp } from '../../web/src/pool-client';
import { SEED_SATOSHIS, SEED_TOKENS, finishFeeOf, withdrawFeeOf } from '../../web/src/pools';
import { proveStatement } from '../../service/lib/verifier';
import { ASSET, DENOMINATION, FOREIGN, builtVerdict, lockOf, newSpend, poolOnMock, reporter, topUpFrom } from './lib/setup';

const { check, rejects, finish } = reporter();
const { provider, signers: [alice, bob, mallory], client, view, finishDeposit, addCoin } = await poolOnMock('token');

const assetCoin = (satoshis = 1_200n, extra: object = {}, amount = DENOMINATION) => addCoin(alice, satoshis, { category: ASSET, amount, ...extra });
const container = client.contract.tokens[ASSET];
const containerCoins = () => provider.getUtxos(container.address);
const containerTokens = async () => (await containerCoins()).reduce((sum: bigint, coin: any) => sum + (coin.token?.amount ?? 0n), 0n);
const fees = depositValue(client.pool);
const COMMITMENT = 0x0707070707070707070707070707070707070707070707070707070707070707n;
const packed = (values: bigint[]) => Uint8Array.from(Buffer.concat(values.map(le32)));
/** A hand-built deposit's own hashing, so only what a test changed can refuse it. A call is a thenable, so it stays wrapped. */
const hashed = async (call: any): Promise<{ call: any }> => {
  const current = await view();
  const { hashes } = stepWitness(current.tree.frontier(), COMMITMENT, Number(current.state.nextIndex), 1, current.tree.zeros);
  return client.withHashing(call, hashes);
};
/**
 * A sent transaction that a top-up paid into, read from its hex and its inputs' parents: what it
 * paid the miner and whether the change came back, as `builtVerdict` says of a built one. Its
 * size, fee and where the top-up's coin and change sit are printed.
 */
const sentTopUp = async (label: string, tx: any, topUp: FeeTopUp) => {
  const { inputs, outputs } = decodeTransaction(hexToBin(tx.hex)) as any;
  let spent = 0n;
  for (const input of inputs) {
    const parent = decodeTransaction(hexToBin(await provider.getRawTransaction(binToHex(input.outpointTransactionHash)))) as any;
    spent += parent.outputs[input.outpointIndex].valueSatoshis;
  }
  const fee = spent - outputs.reduce((sum: bigint, output: any) => sum + output.valueSatoshis, 0n);
  const coin = inputs.findIndex((input: any) => binToHex(input.outpointTransactionHash) === topUp.coin.txid && input.outpointIndex === topUp.coin.vout);
  const change = outputs.findIndex((output: any) => output.valueSatoshis === BigInt(topUp.coin.satoshis) - topUp.amount
    && binToHex(output.lockingBytecode) === binToHex(topUp.change));
  console.log(label.padEnd(16), `${tx.hex.length / 2} B, fee ${fee}, top-up input ${coin} of ${inputs.length}, change output ${change} of ${outputs.length}`);
  return { fee, changeBack: change >= 0, outputs };
};

// One note, which also leaves value in the pool for what follows.
const note = newSpend();
const deposited = await client.deposit(alice, note.commitment, await view(), await assetCoin());
console.log('deposit     ', deposited.hex.length / 2, 'B');
check(deposited.hex.length / 2 < 100_000, 'a deposit is a standard transaction');
// The finish the client would send were nodes to ask 5,000 sat more than the deposit prepaid.
const finishTopUp = await topUpFrom(alice, 5_000n);
const toppedFinish = await builtVerdict((await client.finishCall(await view(), finishTopUp)).call, finishTopUp);
const finished = await finishDeposit();
console.log('finish      ', finished.hex.length / 2, 'B');
check(finished.hex.length / 2 <= Number(finishFeeOf('token')), 'the prepaid fee covers finish at 1 sat/B');
check(toppedFinish.verdict === true && toppedFinish.fee === finishFeeOf('token') + 5_000n && toppedFinish.changeBack,
  'a finish topped up by a wallet\'s coin goes through, pays 5,000 sat more and gives the change back');
check(await containerTokens() === SEED_TOKENS + DENOMINATION, 'a deposit adds the denomination to the token coin');
check((await containerCoins()).length === 1, 'the pool holds one token coin');

// A coin larger than the denomination takes its change back.
{
  const larger = newSpend();
  await rejects('a larger coin with no token change', /[Ii]mplicit burning/, async () => (await hashed(client.contract.connect(alice).call
    .deposit(le32(COMMITMENT), packed((await view()).tree.frontier())).addInput(await assetCoin(1_200n, {}, DENOMINATION * 2n), alice.unlockP2PKH())
    .tokenContainerDeposit(ASSET, DENOMINATION).withValue(fees))).call.withMaxFee(110_000n).send());
  await client.deposit(alice, larger.commitment, await view(), await assetCoin(1_200n, {}, DENOMINATION * 2n));
  await finishDeposit();
  check(await containerTokens() === SEED_TOKENS + 2n * DENOMINATION, 'a larger coin deposits only the denomination, its change returns');
}

// A wallet is usually many small coins, and the SDK adds the extra ones after the hashing coins.
{
  const small = new Signer(new Uint8Array(32).fill(0x55), provider as any);
  for (let i = 0; i < 4; i += 1) await provider.seedUtxo(small.getAddress(), { txid: `${'d1'.repeat(31)}0${i}`, vout: 0, satoshis: 120_000n });
  const coin = { txid: `${'d2'.repeat(31)}00`, vout: 0, satoshis: 1_000n, token: { category: ASSET, amount: DENOMINATION } };
  await provider.seedUtxo(small.getAddress(), coin);
  await client.deposit(small, newSpend().commitment, await view(), coin);
  await finishDeposit();
  check(await containerTokens() === SEED_TOKENS + 3n * DENOMINATION, 'a wallet of small coins can deposit an exact token coin');
}

const attempt = async (coin: any, { value = fees, unlocker = alice.unlockP2PKH(), extra = (call: any) => call } = {}) => {
  let call = client.contract.connect(alice).call.deposit(le32(COMMITMENT), packed((await view()).tree.frontier()))
    .addInput(coin, unlocker).tokenContainerDeposit(ASSET, DENOMINATION);
  if (value > 0n) call = call.withValue(value);
  // The output the client adds at this slot, so only what a test changed can refuse it.
  call = call.addOutput({ to: alice.getLockingBytecode(), amount: 1_000n, ...(coin.token.nft ? { token: { category: ASSET, amount: 0n, nft: coin.token.nft } } : {}) });
  ({ call } = await hashed(call));
  return extra(call).withMaxFee(110_000n).send();
};

await rejects('a deposit without its fees', /value/, async () => attempt(await assetCoin(), { value: 0n }));
for (const [label, nft] of [
  ['a mutable NFT coin', { capability: 'mutable', commitment: '11' }],
  ['an immutable NFT coin', { capability: 'none', commitment: '11' }],
] as const) {
  await rejects(label, /token-nft/, async () => attempt(await assetCoin(1_200n, { nft })));
}
await rejects('a 1,500 sat coin', /token-bch/, async () => attempt(await assetCoin(1_500n)));
await rejects('a coin carrying 1 BCH', /token-bch/, async () => attempt(await assetCoin(100_000_000n)));
await rejects('a foreign token coin', /deposit-token/, async () => {
  const foreign = await addCoin(alice, 1_200n, { category: FOREIGN, amount: 5n });
  return attempt(await assetCoin(), {
    extra: (call) => call.addInput(foreign, alice.unlockP2PKH()).addOutput({
      to: alice.getLockingBytecode(), amount: 1_000n, token: { category: FOREIGN, amount: 5n },
    }),
  });
});

// The rules hold for a script-locked coin too: its BCH cannot pass as the container's.
await rejects('a script-locked coin of the asset', /deposit-lock/, async () => {
  const redeem = Uint8Array.of(0x51);
  const lock = Uint8Array.from([0xaa, 0x20, ...sha256.hash(sha256.hash(redeem)), 0x87]);
  const coin = { txid: 'cd'.repeat(32), vout: 0, satoshis: 100_000_000n, token: { category: ASSET, amount: DENOMINATION } };
  await provider.seedUtxo(binToHex(lock), coin);
  return attempt(coin, { unlocker: { generateLockingBytecode: () => lock, generateUnlockingBytecode: () => Uint8Array.of(0x01, 0x51) } as any });
});

// Anyone can pay a coin to the container's address. The pool does not count it and
// keeps working, for deposits and withdrawals alike.
{
  const grief = await addCoin(mallory, 3_000n, { category: ASSET, amount: 1n });
  const funding = (await mallory.getUtxos()).filter((coin: any) => !coin.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
  const builder = new TransactionBuilder({ provider });
  builder.addInput(grief, mallory.unlockP2PKH());
  builder.addInput(funding, mallory.unlockP2PKH());
  builder.addOutput({ to: lockOf(container.address), amount: 1_500n, token: { category: ASSET, amount: 1n } });
  builder.addOutput({ to: mallory.getAddress(), amount: funding.satoshis - 2_000n });
  await builder.send();
  check((await containerCoins()).length === 2, 'a griefing coin sits at the container\'s address');

  const after = newSpend();
  await client.deposit(alice, after.commitment, await view(), await assetCoin());
  // This note's finish and withdrawal are sent topped up, as they would be were nodes to ask
  // 5,000 sat more than the pool prepaid. The other top-ups in this file are only built.
  const topUpForFinish = await topUpFrom(alice, 5_000n);
  const sentFinish = await sentTopUp('topped finish', await client.finish(await view(), topUpForFinish), topUpForFinish);
  check(true, 'a deposit goes through beside a griefing coin');
  check(sentFinish.fee === finishFeeOf('token') + 5_000n && sentFinish.changeBack,
    'a finish sent topped up by a wallet\'s coin pays exactly 5,000 sat more and gives the change back');

  const current = await view();
  const recipient = lockOf(new Signer(new Uint8Array(32).fill(0x66), provider as any).getAddress());
  const proof = await client.prove(after, recipient, current, proveStatement);
  const topUpForWithdrawal = await topUpFrom(alice, 5_000n);
  const sentWithdrawal = await sentTopUp('topped withdraw',
    await client.submitWithdrawal(proof, le32(after.nullifierHash), recipient, current, topUpForWithdrawal), topUpForWithdrawal);
  check(sentWithdrawal.fee === withdrawFeeOf('token') - 2_400n + 5_000n && sentWithdrawal.changeBack,
    'a withdrawal sent topped up by a wallet\'s coin pays exactly 5,000 sat more and gives the change back');
  const paid = sentWithdrawal.outputs
    .filter((output: any) => binToHex(output.lockingBytecode) === binToHex(recipient) && output.token && binToHex(output.token.category) === ASSET)
    .reduce((sum: bigint, output: any) => sum + output.token.amount, 0n);
  check(paid === DENOMINATION, 'the topped-up withdrawal pays its fresh recipient exactly the denomination in the asset');
}

// The withdrawal: a real proof, paid in the asset, beside the griefing coin.
{
  const current = await view();
  const recipient = lockOf(bob.getAddress());
  const proof = await client.prove(note, recipient, current, proveStatement);
  const topUp = await topUpFrom(alice, 5_000n);
  const topped = await builtVerdict((await client.withdrawalCall(proof, le32(note.nullifierHash), recipient, current, topUp)).call, topUp);
  const tx = await client.submitWithdrawal(proof, le32(note.nullifierHash), recipient, current);
  console.log('withdraw    ', tx.hex.length / 2, 'B');
  check(tx.hex.length / 2 + 2_400 <= Number(withdrawFeeOf('token')), 'the prepaid fee covers the withdrawal and its two funded outputs');
  check(topped.verdict === true && topped.fee === withdrawFeeOf('token') - 2_400n + 5_000n && topped.changeBack,
    'a withdrawal topped up by a wallet\'s coin goes through, pays 5,000 sat more and gives the change back');
  const received = (await provider.getUtxosForLockingBytecode(recipient))
    .filter((coin: any) => coin.token?.category === ASSET).reduce((sum: bigint, coin: any) => sum + coin.token.amount, 0n);
  check(received === DENOMINATION, 'the recipient is paid exactly the denomination in the asset');
}

// The longest proof the client makes still leaves the fee room to spare, for a pool as grown as
// it gets. Anything longer goes under the relay floor for good: a retry is the same statement.
// The client takes a recipient's first salt when the proof is at most 141 words, so a recipient
// whose statement is exactly 141 gets the longest. A note's root and nullifier hash fix the rest
// of the statement, and for some notes no recipient reaches 141 (5 of 12 random ones tried), so
// such a note stays in the pool and another is taken.
{
  const { quotientWords } = await import('@solidpool/verifier');
  const lockFor = (i: number) => Uint8Array.from([0xaa, 0x20, ...sha256.hash(Uint8Array.of(i & 0xff, i >> 8)), 0x87]);
  const longestFor = (root: bigint, nullifierHash: bigint): Uint8Array | undefined => {
    for (let i = 0; i < 1 << 16; i += 1) {
      const lock = lockFor(i);
      if (quotientWords([root, nullifierHash, recipientField(lock, new Uint8Array(4))]) === 141) return lock;
    }
    return undefined;
  };
  let found: { note: ReturnType<typeof newSpend>; current: Awaited<ReturnType<typeof view>>; lock: Uint8Array } | undefined;
  for (let attempt = 0; attempt < 12 && found === undefined; attempt += 1) {
    const note = newSpend();
    await client.deposit(alice, note.commitment, await view(), await assetCoin());
    await finishDeposit();
    const current = await view();
    const lock = longestFor(current.tree.root(), note.nullifierHash);
    if (lock !== undefined) found = { note, current, lock };
  }
  if (found === undefined) throw new Error('none of 12 notes has a recipient with a 141-word statement');
  const tx = await client.withdraw(found.note, found.lock, found.current, proveStatement);
  check(tx.hex.length / 2 + 2_400 + 1_000 <= Number(withdrawFeeOf('token')), `the longest proof leaves at least 1,000 sat in the fee: ${tx.hex.length / 2} B`);
}

// Every note still in the pool is fully funded.
{
  const current = await view();
  const outstanding = BigInt(current.tree.size - 3);
  check(current.state.live === outstanding, `the pool's own count of its notes is right: ${current.state.live}`);
  const coins = await provider.getUtxos(client.contract.getSatoshiContainerAddress());
  const counted = (await containerCoins()).filter((coin: any) => coin.token?.amount > 1n);
  check(coins.length === 1, 'the pool is one satoshi coin');
  check(coins[0].satoshis === SEED_SATOSHIS + outstanding * withdrawFeeOf('token'), `the satoshi coin holds the fees of its notes: ${coins[0].satoshis}`);
  check(counted.length === 1 && counted[0].token.amount === SEED_TOKENS + outstanding * DENOMINATION, 'the token coin holds its notes');
}
finish();
