// Attacks on the proof-carrying pool, each stopped by the rule named beside it. The
// mock enforces BCH's limits, and a proof here is a real one under the production key.
//   tsx contracts/test/pool-attacks.ts (npm run test:contracts runs it with the other suites)
import { Contract, TransactionBuilder } from '@solidcash/solidcash';
import { createVirtualMachineBch2026 } from '@bitauth/libauth';
import { RECENT_ROOTS, depositValue, le32, recipientField, stepWitness, type WithdrawalProof } from '../../web/src/pool-client';
import { verifierSweepUnlocking, verifierUnlockings } from '../../web/src/verifier';
import { MimcTree, FIELD, mimcSponge } from '../../web/src/mimc';
import { SEED_SATOSHIS, finishFeeOf, withdrawFeeOf } from '../../web/src/pools';
import mimcHash from '../artifacts/solidcash/MimcHash.json';
import { proveStatement } from '../../service/lib/verifier';
import { DENOMINATION, lockOf, newSpend, poolOnMock, reporter, type Spend } from './lib/setup';

const { check, rejects, finish } = reporter();
const { provider, signers: [alice, bob, eve], client, history, view, finishDeposit } = await poolOnMock('bch');
const definition = client.pool;
const biggest = (signer: any) => signer.getUtxos().then((coins: any[]) => coins.filter((coin) => !coin.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0]);
const addNote = async () => {
  const note = newSpend();
  await client.deposit(alice, note.commitment, await view());
  await finishDeposit();
  return note;
};
const containerCoins = () => provider.getUtxos(client.contract.getSatoshiContainerAddress());
const coinsAt = (lock: Uint8Array) => provider.getUtxosForLockingBytecode(lock).then((coins: any[]) => coins.filter((coin) => !coin.token));
const bobLock = lockOf(bob.getAddress());
const eveLock = lockOf(eve.getAddress());
const proofFor = async (note: Spend, recipient: Uint8Array, tree: MimcTree, leaf: number): Promise<WithdrawalProof> => {
  const { pathElements, pathIndices } = tree.path(leaf);
  const salt = new Uint8Array(4);
  const unlockings = await verifierUnlockings(await proveStatement({
    root: tree.root().toString(), nullifierHash: note.nullifierHash.toString(), recipient: recipientField(recipient, salt).toString(),
    relayer: '0', fee: '0', refund: '0', nullifier: note.nullifier.toString(), secret: note.secret.toString(),
    pathElements: pathElements.map(String), pathIndices: pathIndices.map(String),
  }), client.verifier);
  return { unlockings, salt, root: tree.root() };
};
/** A built call sent by hand, with the change its own send would have given: the covenant, not the fee cap, judges it. */
const sendBuilt = (built: any, signer: any) => {
  built.addBchChangeOutputIfNeeded({ to: signer.getAddress(), feeRate: 1.0 });
  return built.send();
};
const raw = (lock: Uint8Array, unlocking: Uint8Array) => ({
  generateLockingBytecode: () => lock, generateUnlockingBytecode: () => Uint8Array.from(unlocking),
});

// ---- deposits ----
const note = newSpend();
const firstCommitment = note.commitment;
const packed = (values: bigint[]) => Uint8Array.from(Buffer.concat(values.map(le32)));
await rejects('a deposit below the required value', /value/, async () => (await client.depositCall(alice, firstCommitment, await view())).call
  .withValue(depositValue(definition) - 1n).send());
await rejects('a commitment at the field size, which could never be hashed', /mimc|Require|VERIFY|failed/i, async () => client.deposit(alice, FIELD, await view()));
await rejects('a commitment of all ones', /mimc|Require|VERIFY|failed/i, async () => client.deposit(alice, (1n << 256n) - 1n, await view()));
await rejects('a finish with nothing to hash', /idle|waiting/, async () => client.finish(await view()));

// ---- hashing inside a deposit ----
{
  const start = await view();
  const frontier = start.tree.frontier();
  const { hashes } = stepWitness(frontier, firstCommitment, 0, 1, start.tree.zeros);
  const unlockFor = (h: any) => client.worker.unlock.hash(le32(h.left), le32(h.right), le32(h.out));
  const coins = (await coinsAt(client.workerLock)).slice(0, 10);
  const depositWith = (mutate: (i: number, h: any) => any, claimed = frontier) => {
    let call = client.contract.connect(alice).call.deposit(le32(firstCommitment), packed(claimed)).withValue(depositValue(definition));
    hashes.forEach((hash, i) => { call = call.addInput(coins[i], unlockFor(mutate(i, hash))); });
    for (const coin of coins) call = call.addOutput({ to: client.workerLock, amount: coin.satoshis });
    return call.withMaxFee(110_000n).send();
  };
  await rejects('a forged hash in a deposit', /mimc|Require|VERIFY|failed/i, () => depositWith((i, h) => (i === 3 ? { ...h, out: 12345n } : h)));
  await rejects('a deposit that hashes another note', /left|Require|VERIFY|failed/i, () => depositWith((i, h) => (i === 0 ? { left: 777n, right: h.right, out: mimcSponge([777n, h.right]) } : h)));
  await rejects('a deposit from a frontier of its own', /frontier/, () => depositWith((_, h) => h, frontier.map((node, i) => (i === 0 ? 1n : node))));
  await rejects('a hashing coin taken out of a deposit', /worker|Require|VERIFY|failed/i, async () => {
    const built = await (await client.depositCall(alice, firstCommitment, start)).call.build();
    built.outputs[4] = { to: eve.getAddress(), amount: 1_000n };
    return sendBuilt(built, alice);
  });
  await rejects('a hashing coin recreated smaller', /worker|Require|VERIFY|failed/i, async () => {
    const built = await (await client.depositCall(alice, firstCommitment, start)).call.build();
    built.outputs[5] = { ...built.outputs[5], amount: 900n };
    return sendBuilt(built, alice);
  });
  await rejects('an eleventh hashing coin not recreated', /coin|Require|VERIFY|failed/i, async () => {
    const paid = new TransactionBuilder({ provider });
    paid.addInput(await biggest(eve), eve.unlockP2PKH());
    paid.addOutput({ to: client.workerLock, amount: 1_000n });
    paid.addBchChangeOutputIfNeeded({ to: eve.getAddress(), feeRate: 1.0 });
    await paid.send();
    const built = await (await client.depositCall(alice, firstCommitment, start)).call.build();
    const spare = (await coinsAt(client.workerLock)).find((coin: any) => !built.inputs.some((input: any) => input.txid === coin.txid && input.vout === coin.vout));
    built.inputs.push({ ...spare, unlocker: unlockFor(hashes[0]) });
    return sendBuilt(built, alice);
  });
}

await client.deposit(alice, firstCommitment, await view());
await rejects('a second deposit while one is hashing', /busy/, async () => client.deposit(alice, 5n, await view()));

// ---- hashing in finish ----
{
  const pending = await view();
  const half = stepWitness(pending.tree.frontier(), pending.pending!, 0, 1, pending.tree.zeros);
  const frontier = half.frontier;
  const { hashes } = stepWitness(frontier, half.node, 0, 2, pending.tree.zeros);
  const coins = (await coinsAt(client.workerLock)).slice(0, 10);
  const recentRoots = packed(pending.tree.recentRoots(RECENT_ROOTS));
  const stepCall = (mutate: (i: number, h: any) => any, unlock = (h: any) => client.worker.unlock.hash(le32(h.left), le32(h.right), le32(h.out)), node = half.node, inputCoins = coins) => {
    let call = client.contract.call.finish(packed(frontier), le32(node), recentRoots);
    hashes.forEach((hash, i) => { call = call.addInput(inputCoins[i], unlock(mutate(i, hash))); });
    for (const coin of inputCoins) call = call.addOutput({ to: client.workerLock, amount: coin.satoshis });
    return call.withMaxFee(finishFeeOf('bch')).send();
  };
  await rejects('a forged hash, the worker refuses it', /mimc|Require|VERIFY|failed/i, () => stepCall((i, h) => (i === 3 ? { ...h, out: 12345n } : h)));
  await rejects('a hash of the wrong node, the pool refuses it', /left|Require|VERIFY|failed/i, () => stepCall((i, h) => {
    if (i !== 0) return h;
    const left = 777n;
    return { left, right: h.right, out: mimcSponge([left, h.right]) };
  }));
  await rejects('a hash with a sibling that is not the empty subtree', /zero|Require|VERIFY|failed/i, () => stepCall((i, h) => {
    if (i !== 1) return h;
    const right = 778n;
    return { left: h.left, right, out: mimcSponge([h.left, right]) };
  }));
  await rejects('a node that is not the pending commitment', /frontier/i, () => stepCall((_, h) => h, undefined, 999n));

  // A worker the attacker wrote: it accepts any hash, so only the pool's lock check stops it.
  const fake = new Contract({ ...(mimcHash as any), bytecode: 'OP_DROP OP_DROP OP_DROP OP_1' } as any, [], { provider, addressType: 'p2sh32' });
  const fakeCoins = [];
  {
    const builder = new TransactionBuilder({ provider });
    builder.addInput(await biggest(eve), eve.unlockP2PKH());
    for (let i = 0; i < 10; i += 1) builder.addOutput({ to: fake.address, amount: 1_000n });
    builder.addBchChangeOutputIfNeeded({ to: eve.getAddress(), feeRate: 1.0 });
    await builder.send();
    fakeCoins.push(...await fake.getUtxos());
  }
  await rejects('a fake hashing contract', /worker|Require|VERIFY|failed/i, () => {
    let call = client.contract.call.finish(packed(frontier), le32(half.node), recentRoots);
    fakeCoins.slice(0, 10).forEach((coin: any) => { call = call.addInput(coin, raw(lockOf(fake.address), Uint8Array.of(0x20, ...new Uint8Array(32)))); });
    return call.withMaxFee(finishFeeOf('bch')).send();
  });
}

// Every pool shares the hashing coins, so anyone may spend one outside a pool, but only with a
// true hash and only to recreate it as it was, at its own index. Its sweep needs it to stand
// alone, so beside any other input it takes the hash path, and a pool never reads a hash nobody
// proved. The coin's unlocking holds no signature, so it is sent as its bytes, beside Eve's coin.
const outsideThePool = async (left: bigint, right: bigint, out: bigint, sequence?: number) => {
  const coin = (await coinsAt(client.workerLock))[0];
  const dummy = { version: 2, locktime: 0, inputs: [{ outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: new Uint8Array() }], outputs: [] };
  const unlocking = client.worker.unlock.hash(le32(left), le32(right), le32(out))
    .generateUnlockingBytecode({ transaction: dummy, sourceOutputs: [{ lockingBytecode: client.workerLock, valueSatoshis: coin.satoshis }], inputIndex: 0 });
  const builder: any = new TransactionBuilder({ provider });
  builder.addInput(await biggest(eve), eve.unlockP2PKH());
  builder.addInput(coin, raw(client.workerLock, unlocking), sequence === undefined ? undefined : { sequence });
  builder.addOutput({ to: eve.getAddress(), amount: 500_000n });
  builder.addOutput({ to: client.workerLock, amount: coin.satoshis });
  builder.addBchChangeOutputIfNeeded({ to: eve.getAddress(), feeRate: 1.0 });
  return builder.send();
};
const theWorkerRefuses = /input index 1[\s\S]*OP_VERIFY|mimc/;
await rejects('a worker coin spent outside the pool with a false hash', theWorkerRefuses, () => outsideThePool(1n, 2n, 3n));
{
  const before = (await coinsAt(client.workerLock)).length;
  await outsideThePool(1n, 2n, mimcSponge([1n, 2n]));
  check((await coinsAt(client.workerLock)).length === before, 'a worker coin spent outside the pool with a true hash comes back, as it was');
}

await finishDeposit();
const afterFirst = await view();
check(afterFirst.tree.size === 1 && Number(afterFirst.state.stage) === 0, 'an honest deposit finishes after every refused attempt');

// ---- withdrawals ----
const honest = await proofFor(note, bobLock, afterFirst.tree, 0);

await rejects('a stolen proof, resubmitted to pay someone else', /recipient/, async () => {
  const current = await view();
  return client.submitWithdrawal(honest, le32(note.nullifierHash), eveLock, current);
});
await rejects('a stolen proof with another salt', /recipient/, async () => client.submitWithdrawal({ ...honest, salt: Uint8Array.of(1, 2, 3, 4) }, le32(note.nullifierHash), bobLock, await view()));

// A valid proof of a note in a tree the attacker made up: this is the attack that needs
// an on-chain root, since a verifier alone accepts it.
{
  const fakeNote = newSpend();
  const fakeTree = new MimcTree(20, [fakeNote.commitment]);
  const forged = await proofFor(fakeNote, eveLock, fakeTree, 0);
  // R's sweep branch needs its coin alone in the transaction, so the redeem alone at a verifier
  // input of a withdrawal runs the verifier, which finds no proof there.
  for (const at of [0, 1, 2]) {
    await rejects(`a withdrawal with the sweep's unlocking as verifier input ${at}`, /Program failed|VERIFY|evaluat|split|range|stack/i, async () => {
      const unlockings = honest.unlockings.slice();
      unlockings[at] = verifierSweepUnlocking();
      return client.submitWithdrawal({ ...honest, unlockings }, le32(note.nullifierHash), bobLock, await view());
    });
  }
  await rejects('a real proof over a tree the pool never had', /root/, async () => {
    const current = await view();
    return client.submitWithdrawal(forged, le32(fakeNote.nullifierHash), eveLock, current);
  });
}

await rejects('a withdrawal with no proof', /verifier|Require|VERIFY|failed/i, async () => {
  const current = await view();
  return client.contract.call.withdraw(
    Uint8Array.from(Buffer.concat(current.tree.recentRoots(RECENT_ROOTS).map(le32))),
    current.nullifiers.path(le32(note.nullifierHash)), eveLock, new Uint8Array(4),
  ).transfer(eveLock, DENOMINATION).withMaxFee(withdrawFeeOf('bch')).send();
});

const tampered = honest.unlockings.map((unlocking) => Uint8Array.from(unlocking));
tampered[2][357 + 33] ^= 1; // one bit of the nullifier hash in the statement
await rejects('a statement changed after proving, the verifier refuses it', /Require|VERIFY|failed|rejected/i, async () => {
  const current = await view();
  const nullifier = tampered[2].slice(357 + 32, 357 + 64);
  return client.submitWithdrawal({ ...honest, unlockings: tampered }, nullifier, bobLock, current);
});

// Every pool shares the verifier coins, so anyone may spend them outside a pool, with a valid
// proof of some statement, and only to recreate them as they were. Nothing pays out: the pool
// is the one that judges a statement and pays.
{
  const coins = (await coinsAt(client.verifier.lock)).slice(0, 3);
  const builder = new TransactionBuilder({ provider });
  builder.addInput(await biggest(eve), eve.unlockP2PKH());
  coins.forEach((coin: any, i: number) => builder.addInput(coin, raw(client.verifier.lock, honest.unlockings[i])));
  builder.addOutput({ to: eve.getAddress(), amount: 100_000n });
  for (const coin of coins) builder.addOutput({ to: client.verifier.lock, amount: coin.satoshis });
  await builder.send();
  check((await coinsAt(client.verifier.lock)).length === coins.length, 'verifier coins spent outside the pool with a valid proof come back, as they were');
}

await rejects('verifier coins not recreated', /VERIFY|failed|Script|Require/i, async () => {
  const current = await view();
  const coins = (await coinsAt(client.verifier.lock)).slice(0, 3);
  let call = client.contract.call.withdraw(
    Uint8Array.from(Buffer.concat(current.tree.recentRoots(RECENT_ROOTS).map(le32))),
    current.nullifiers.path(le32(note.nullifierHash)), bobLock, honest.salt,
  ).transfer(bobLock, DENOMINATION);
  coins.forEach((coin: any, i: number) => { call = call.addInput(coin, raw(client.verifier.lock, honest.unlockings[i])); });
  for (const coin of coins) call = call.addOutput({ to: eve.getAddress(), amount: coin.satoshis });
  return call.withMaxFee(withdrawFeeOf('bch')).send();
});

const paying = await client.submitWithdrawal(honest, le32(note.nullifierHash), bobLock, await view());
check(Boolean(paying.txid), 'the honest proof pays after every refused attempt');

// ---- a proof outlives deposits, up to the eight recent roots ----
const second = await addNote();
const atSecond = await view();

// The pool holds a note now, so only the spent check can stop this, on any siblings:
// the slot is filled, so no path to an empty slot reproduces the nullifier root.
await rejects('the same note again', /spent/, async () => client.submitWithdrawal(honest, le32(note.nullifierHash), bobLock, await view()));
const oldProof = await proofFor(second, bobLock, atSecond.tree, 1);
for (let i = 0; i < RECENT_ROOTS - 1; i += 1) await addNote();
await client.submitWithdrawal(oldProof, le32(second.nullifierHash), bobLock, await view());
check(true, `a proof stays valid across ${RECENT_ROOTS - 1} later deposits`);

const third = await addNote();
const atThird = await view();
const staleProof = await proofFor(third, bobLock, atThird.tree, atThird.tree.size - 1);
for (let i = 0; i < RECENT_ROOTS; i += 1) await addNote();
check(!client.isFresh(staleProof, await view()), 'the client knows such a proof needs making again');
await rejects('a proof against a root that left the recent eight', /root/, async () => client.submitWithdrawal(staleProof, le32(third.nullifierHash), bobLock, await view()));

// ---- a dishonest history is refused by the client ----
await rejects('a history with a note left out', /history/, async () => client.view({ ...history, deposits: async () => (await history.deposits()).slice(1).map((d, i) => ({ ...d, leafIndex: i })) }));
await rejects('a history with a note replaced', /history|roots/, async () => client.view({ ...history, deposits: async () => (await history.deposits()).map((d, i) => (i === 0 ? { ...d, commitment: 5n } : d)) }));
await rejects('a nullifier list with a spend left out', /history/, async () => client.view({ ...history, withdrawals: async () => (await history.withdrawals()).slice(1) }));

// ---- money ----
// Every note still in the pool is exactly funded, and the pool is still one coin.
{
  const current = await view();
  const outstanding = BigInt(current.tree.size - (await history.withdrawals()).length);
  const coins = await containerCoins();
  check(coins.length === 1, 'the pool is one satoshi coin');
  const expected = SEED_SATOSHIS + outstanding * (DENOMINATION + withdrawFeeOf('bch'));
  check(coins[0].satoshis === expected, `the coin holds exactly its notes: ${coins[0].satoshis} of ${expected}`);
}

// ---- the sweep ----
// A hashing or verifier coin that has stood unmoved for 1,440 blocks is anyone's, but only as its
// transaction's only input, so no sweep can stand in a pool's transaction. These are the scripts'
// verdicts, from the VM: a coin's age is the node's to enforce, which test/real-node.ts runs. A
// lone input brings no other coin to pay the fee, so a coin is worth sweeping only when it holds
// more than its unlocking costs: about 8 kB for a hashing coin, 81 B for a verifier coin.
{
  const vm = createVirtualMachineBch2026(true);
  const dummy = { version: 2, locktime: 0, inputs: [{ outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: new Uint8Array() }], outputs: [] };
  const workerSweep = client.worker.unlock.hash(le32(0n), le32(0n), le32(0n))
    .generateUnlockingBytecode({ transaction: dummy, sourceOutputs: [{ lockingBytecode: client.workerLock, valueSatoshis: 1_000n }], inputIndex: 0 });
  const kinds = { worker: { lock: client.workerLock, unlocking: workerSweep }, verifier: { lock: client.verifier.lock, unlocking: verifierSweepUnlocking() } };
  /** The VM's verdict on sweeping `count` coins of one kind together, each holding `satoshis`. */
  const sweep = (kind: keyof typeof kinds, { count = 1, sequence = 1440, version = 2, satoshis = 20_000n } = {}) => {
    const { lock, unlocking } = kinds[kind];
    const total = satoshis * BigInt(count);
    return vm.verify({
      sourceOutputs: Array.from({ length: count }, () => ({ lockingBytecode: lock, valueSatoshis: satoshis })),
      transaction: {
        version, locktime: 0,
        inputs: Array.from({ length: count }, (_, n) => ({ outpointTransactionHash: new Uint8Array(32).fill(n + 1), outpointIndex: 0, sequenceNumber: sequence, unlockingBytecode: unlocking })),
        outputs: [{ lockingBytecode: eveLock, valueSatoshis: total - 10_000n * BigInt(count) }],
      },
    } as any);
  };
  for (const kind of ['worker', 'verifier'] as const) {
    check(sweep(kind) === true, `a lone ${kind} coin with a relative lock of 1,440 blocks is swept by anyone`);
    check(sweep(kind, { sequence: 1439 }) !== true, `a lone ${kind} coin with a relative lock of 1,439 blocks is not`);
    check(sweep(kind, { version: 1 }) !== true, `nor one in a version 1 transaction`);
    check(sweep(kind, { sequence: 0xfffffffe }) !== true, `nor one whose relative lock is off`);
    check(sweep(kind, { count: 2 }) !== true, `two ${kind} coins cannot be swept together: beside another input, each takes its working path`);
  }
}

finish();
