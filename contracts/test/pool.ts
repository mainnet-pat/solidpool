// The native pool, end to end, with the fee each step pays.
//   tsx contracts/test/pool.ts (npm run test:contracts runs it with the other suites)
import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { depositValue, le32 } from '../../web/src/pool-client';
import { Signer } from '@solidcash/solidcash';
import { SEED_SATOSHIS, finishFeeOf, withdrawFeeOf } from '../../web/src/pools';
import { proveStatement } from '../../service/lib/verifier';
import { DENOMINATION, builtVerdict, lockOf, newSpend, poolOnMock, reporter, topUpFrom } from './lib/setup';

const { check, finish } = reporter();
const { provider, signers: [alice, bob], client, history, view, addCoin } = await poolOnMock('bch');
const fee = async (tx: any) => {
  const decoded = decodeTransaction(hexToBin(tx.hex)) as any;
  let spent = 0n;
  for (const input of decoded.inputs) {
    const parent = decodeTransaction(hexToBin(await provider.getRawTransaction(Buffer.from(input.outpointTransactionHash).toString('hex')))) as any;
    spent += parent.outputs[input.outpointIndex].valueSatoshis;
  }
  return spent - decoded.outputs.reduce((sum: bigint, output: any) => sum + output.valueSatoshis, 0n);
};
const size = (tx: any) => tx.hex.length / 2;
const report = async (label: string, tx: any) => console.log(label.padEnd(12), `${size(tx)} B, fee ${await fee(tx)}`);

const note = newSpend();
const deposit = await client.deposit(alice, note.commitment, await view());
await report('deposit', deposit);
// The finish the client would send were nodes to ask 5,000 sat more than the deposit prepaid.
const finishTopUp = await topUpFrom(alice, 5_000n);
const toppedFinish = await builtVerdict((await client.finishCall(await view(), finishTopUp)).call, finishTopUp);
// And were they to ask 5,600 sat of a 6,000 sat coin: its 400 sat of change would be dust, so all of it goes to the fee.
const dustTopUp = { coin: await addCoin(alice, 6_000n), unlocker: alice.unlockP2PKH(), change: lockOf(alice.getAddress()), amount: 5_600n };
const dustFinish = await builtVerdict((await client.finishCall(await view(), dustTopUp)).call, dustTopUp);
const finished = await client.finish(await view());
await report('finish', finished);
check(size(finished) <= Number(finishFeeOf('bch')), 'the prepaid fee covers finish at 1 sat/B');
check(size(deposit) < 100_000 && size(finished) < 100_000, 'a deposit and its finish are standard transactions');

const after = await view();
check(after.tree.size === 1 && Number(after.state.stage) === 0, 'the note is in the tree');

const recipient = lockOf(bob.getAddress());
const balance = async (): Promise<bigint> => (await bob.getUtxos()).reduce((sum: bigint, coin: any) => sum + BigInt(coin.satoshis), 0n);
const before = await balance();
const proof = await client.prove(note, recipient, after, proveStatement);
const withdrawalTopUp = await topUpFrom(alice, 5_000n);
const toppedWithdrawal = await builtVerdict(
  (await client.withdrawalCall(proof, le32(note.nullifierHash), recipient, after, withdrawalTopUp)).call, withdrawalTopUp,
);
const withdrawal = await client.submitWithdrawal(proof, le32(note.nullifierHash), recipient, after);
await report('withdraw', withdrawal);
check(await balance() - before === DENOMINATION, 'the recipient is paid exactly the denomination');
check(size(withdrawal) + 1_200 <= Number(withdrawFeeOf('bch')), 'the prepaid fee covers the withdrawal and its event coin');
check(toppedFinish.verdict === true && toppedFinish.fee === await fee(finished) + 5_000n && toppedFinish.changeBack,
  'a finish topped up by a wallet\'s coin goes through, pays 5,000 sat more and gives the change back');
check(toppedWithdrawal.verdict === true && toppedWithdrawal.fee === await fee(withdrawal) + 5_000n && toppedWithdrawal.changeBack,
  'and so does a withdrawal');
console.log('dust finish'.padEnd(12), `fee ${dustFinish.fee}, built and not sent`);
check(dustFinish.verdict === true && dustFinish.fee === await fee(finished) + 6_000n && !dustFinish.changeBack,
  'a finish topped up by a coin whose change would be dust goes through, pays all 6,000 sat more and has no change output');

const containers = await provider.getUtxos(client.contract.getSatoshiContainerAddress());
check(containers.length === 1 && containers[0].satoshis === SEED_SATOSHIS, 'the pool is back to its seed, in one coin');
check((await history.withdrawals()).length === 1, 'the spend is on record');
console.log('a deposit adds', depositValue(client.pool), 'sat to the pool');
// A wallet is usually many small coins, and the SDK adds the extra ones after the hashing coins.
{
  const small = new Signer(new Uint8Array(32).fill(0x55), provider as any);
  for (let i = 0; i < 6; i += 1) await provider.seedUtxo(small.getAddress(), { txid: `${'d1'.repeat(31)}0${i}`, vout: 0, satoshis: 240_000n });
  await client.deposit(small, newSpend().commitment, await view());
  await client.finish(await view());
  check(Number((await view()).state.stage) === 0, 'a wallet of small coins can deposit');
}

finish();
