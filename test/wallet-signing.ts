// A deposit signed by a wallet this page holds no key for: the path every mainnet user
// takes. The wallet here answers `bch_signTransaction` as a wc2 wallet does: it signs the
// empty inputs at its own lock and returns the transaction.
//   tsx test/wallet-signing.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Signer } from '@solidcash/solidcash';
import {
  binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeTransaction, hexToBin, secp256k1, hash160, encodeCashAddress,
} from '@bitauth/libauth';
import { newSpend, poolOnMock, reporter, SIGNER_COIN } from './lib/setup';
import { accountAddress } from '../web/src/wallet';
import { signP2pkh } from './lib/sign';
import { LocalChain } from '../service/chain';
import { deployFactory } from '../web/src/factory';
import { PoolClient } from '../web/src/pool-client';
import * as engine from '../web/src/engine';

const { check, rejects, finish } = reporter();
const { provider, signers: [alice], client, view, addCoin } = await poolOnMock('bch');

const key = new Uint8Array(32).fill(0x37);
const publicKey = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;
const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
const lock = (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
// One coin covers a deposit of the pool's denomination and its fee, as each mock signer coin does.
await provider.seedUtxo(address, { txid: 'ab'.repeat(32), vout: 0, satoshis: SIGNER_COIN });

const seen: { bytes: number; inputs: number }[] = [];
type Mode = 'honest' | 'refuse' | 'tamper';
let mode: Mode = 'honest';
const wallet = {
  async signTransaction({ transaction, sourceOutputs }: any) {
    if (mode === 'refuse') return undefined;
    seen.push({ bytes: encodeTransaction(transaction).length, inputs: transaction.inputs.length });
    const inputs = transaction.inputs.map((input: any, index: number) => (
      input.unlockingBytecode.length === 0 && binToHex(sourceOutputs[index].lockingBytecode) === binToHex(lock)
        ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, key) }
        : input));
    const outputs = mode === 'tamper'
      ? transaction.outputs.map((output: any, index: number) => (index === transaction.outputs.length - 1 ? { ...output, valueSatoshis: output.valueSatoshis - 1n } : output))
      : transaction.outputs;
    return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs, outputs })) };
  },
};
const signer = Signer.external({ wallet, address, userPrompt: 'Deposit into a private pool' } as any, provider);

// The forms real wallets send, from Cashonize and Paytaca.
check(accountAddress(['bch:bitcoincash:qqtest'], 'bch:bitcoincash') === 'bitcoincash:qqtest', 'a session account keeps its address prefix');
check(accountAddress(['bch:bchtest:qqtest', 'bch:bitcoincash:qqmain'], 'bch:bitcoincash') === 'bitcoincash:qqmain', 'and the account is the one on this chain');
check(accountAddress(['bch:bchtest:qqtest'], 'bch:bitcoincash') === undefined, 'an account on another chain is not taken for one');

mode = 'refuse';
await rejects('a wallet that declines', /did not sign/, async () => client.deposit(signer, newSpend().commitment, await view()));
mode = 'tamper';
await rejects('a wallet that changes an output', /changed output/, async () => client.deposit(signer, newSpend().commitment, await view()));

mode = 'honest';
const note = newSpend();
const tx = await client.deposit(signer, note.commitment, await view());
check(Boolean(tx.txid), 'the wallet signed the deposit');
check(seen.at(-1)!.bytes < 39_000, `the wallet is asked to sign ${seen.at(-1)!.bytes} B, within WalletConnect's limit`);
await client.finish(await view());
check((await view()).tree.size === 1, 'the deposit finishes with no further signature');
check(alice !== undefined, 'the pool was deployed by someone else');
void addCoin;

// ---- the steps a pool's creation shows, from the same wallet ----
// The engine as the page runs it, reading a local chain through Fulcrum's HTTP form. A creation
// sends several transactions and the wallet approves each in its own app, so the page must say which
// step is under way and when the wallet is waiting: this records what it said at each request.
const scratch = mkdtempSync(join(tmpdir(), 'pools-signing-'));
const chain = await LocalChain.open(join(scratch, 'state.json'));
// The least fee the server's node relays, in satoshis per 1,000 bytes, and what it rises to once
// the next transaction is relayed. Below it, a broadcast is refused as a node refuses it.
const relay = { floor: 1_000n, afterNext: 0n };
const feeOf = async (hex: string): Promise<bigint> => {
  const transaction = decodeTransaction(hexToBin(hex)) as any;
  let spent = 0n;
  for (const input of transaction.inputs) {
    const parent = decodeTransaction(hexToBin(String(await chain.rpc('blockchain.transaction.get', [binToHex(input.outpointTransactionHash)])))) as any;
    spent += parent.outputs[input.outpointIndex].valueSatoshis;
  }
  return spent - transaction.outputs.reduce((sum: bigint, output: any) => sum + output.valueSatoshis, 0n);
};
(globalThis as any).fetch = async (_url: string, init: any) => {
  const { id, method, params } = JSON.parse(init.body);
  const answer = (body: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
  if (method === 'blockchain.relayfee') return answer({ result: Number(relay.floor) / 1e8 });
  if (method === 'blockchain.transaction.broadcast' && relay.floor > 1_000n) {
    const [fee, least] = [await feeOf(params[0]), (BigInt(params[0].length / 2) * relay.floor + 999n) / 1_000n];
    if (fee < least) return answer({ error: { code: 1, message: `min relay fee not met, ${fee} < ${least}` } });
  }
  try {
    const result = await chain.rpc(method, params ?? []);
    if (method === 'blockchain.transaction.broadcast' && relay.afterNext > 0n) [relay.floor, relay.afterNext] = [relay.afterNext, 0n];
    return answer({ result });
  } catch (error) {
    return answer({ error: { code: 1, message: String((error as Error).message) } });
  }
};
const factory = (await deployFactory('bch', chain.faucet)).categoryId as string;
await chain.fund(address, []);
const config: any = {
  network: 'chipnet', addressPrefix: 'bchtest', fulcrumUrl: 'http://chain.invalid', pools: [],
  factories: { bch: factory }, prover: { circuitUrl: '', provingKeyUrl: '' },
};
let shown: engine.StepProgress | undefined;
const asked: Array<{ prompt: string; shown: engine.StepProgress | undefined }> = [];
let refuse = '';
const external = {
  address,
  signRequest: async ({ transaction, sourceOutputs, userPrompt }: any) => {
    asked.push({ prompt: userPrompt, shown });
    if (userPrompt === refuse) throw new Error('User rejected the request');
    const inputs = transaction.inputs.map((input: any, index: number) => (
      binToHex(sourceOutputs[index].lockingBytecode) === binToHex(lock)
        ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, key) } : input));
    return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
  },
};
const events: engine.StepProgress[] = [];
const record = (progress: engine.StepProgress) => { events.push(progress); shown = progress; };
const request = { kind: 'bch' as const, denomination: 1_000_000n, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8 };
const PREP = 'Create the coin that names the new pool';
const CREATE = 'Create the new pool through its factory';
const SHARED = 'Add the hashing and verifier coins every pool shares';

// Refused at the creation: the prep was only signed, so nothing went out and both are asked again.
refuse = CREATE;
await rejects('a creation the wallet refuses', /did not approve/, () => engine.createPool(config, request, external, undefined, record));
const stopped = events.at(-1)!;
check(asked.map((entry) => entry.prompt).join('|') === [PREP, CREATE].join('|'), 'the wallet was asked for the prep, then the creation');
check(stopped.over && stopped.steps.find((step) => step.id === 'create')?.state === 'failed'
  && stopped.steps.find((step) => step.id === 'prep')?.state === 'done', 'the steps say the creation failed, after the prep');
check(/Nothing was sent\. The coin that names the pool was signed but not sent/.test(stopped.failure?.sent ?? '')
  && /asks your wallet to approve both again/.test(stopped.failure?.next ?? ''), `and say what went out and what a retry does: ${stopped.failure?.sent} ${stopped.failure?.next}`);

refuse = '';
asked.length = 0;
events.length = 0;
const created = await engine.createPool(config, request, external, undefined, record);
const [planned] = events;
check(planned.steps.map((step) => step.id).join(',') === 'prep,create,shared' && planned.total === 3 && planned.approvals === 3
  && planned.steps.every((step) => step.state === 'todo' && step.waitsOnWallet), 'the steps are known before the first: prep, creation and the shared coins, each waiting on the wallet');
check(asked.map((entry) => entry.prompt).join('|') === [PREP, CREATE, SHARED].join('|'), 'the wallet is asked for each, in order');
check(asked.every(({ prompt, shown: at }, index) => at?.current?.title === prompt && at.waiting === 'wallet'
  && at.current.approval === index + 1 && at.approvals === 3 && at.walletApproves),
  'and each time the page says that step waits on the wallet\'s approval, n of 3');
const order = events.filter((event) => event.current).map((event) => event.current!.id).filter((id, index, all) => all[index - 1] !== id);
check(order.join(',') === 'prep,create,shared', `the steps run in order: ${order.join(',')}`);
const last = events.at(-1)!;
check(last.over && !last.failure && last.steps.every((step) => step.state === 'done'), 'and all end done');
const madePool = new PoolClient({ id: 'made', kind: 'bch', denomination: 1_000_000n, category: created.category }, chain.provider);
check((await madePool.contract.getState()).nextIndex === 0n, 'and the pool is made');

// ---- a deposit's steps, from the same wallet ----
const pool = { id: created.category, kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: '1000000', category: created.category };
const withPool = { ...config, pools: [pool] };
await chain.fund(address, []);
const depositNote = engine.newNote(pool as any, 'chipnet');
asked.length = 0;
events.length = 0;
// Nodes ask 2 sat/B from the moment the deposit has left: more than the pool prepaid for adding its note.
relay.afterNext = 2_000n;
const deposited = await engine.deposit(withPool, depositNote, external, undefined, record);
check(deposited.accepted && !deposited.hashed && (deposited.waitsOnFee ?? 0n) > 0n,
  `a deposit lands, and adding its note waits on ${deposited.waitsOnFee} sat more fee once nodes ask 2 sat/B`);
check(events[0]?.steps.map((step) => step.id).join(',') === 'deposit,land' && asked.length === 1
  && asked[0].shown?.current?.id === 'deposit' && asked[0].shown.waiting === 'wallet' && asked[0].shown.current.approval === 1
  && asked[0].shown.approvals === 1, 'its steps are the deposit, which waits on the wallet, then its note appearing');
check(events.at(-1)!.over && events.at(-1)!.steps.every((step) => step.state === 'done'), 'and both end done');

// ---- a fee paid from coins none of which pays it alone ----
// The wallet that pays the rest holds enough, but over six coins of a third of it each. It gathers
// them into one, at the floor nodes ask, then pays the fee from that coin: two approvals.
const missing = deposited.waitsOnFee!;
const payerKey = new Uint8Array(32).fill(0x38);
const payerPkh = hash160(secp256k1.derivePublicKeyCompressed(payerKey) as Uint8Array);
const payerAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: payerPkh }).address;
const payerLock = binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...payerPkh, 0x88, 0xac]));
const piece = missing / 3n;
check(piece > 546n, `each of its coins, ${piece} sat, is above dust and below the ${missing} sat missing`);
for (let i = 0; i < 6; i += 1) await chain.fund(payerAddress, [], piece);
const payerAsked: Array<{ prompt: string; shown: engine.StepProgress | undefined }> = [];
let payerShown: engine.StepProgress | undefined;
const payer = {
  address: payerAddress,
  signRequest: async ({ transaction, sourceOutputs, userPrompt }: any) => {
    payerAsked.push({ prompt: userPrompt, shown: payerShown });
    const inputs = transaction.inputs.map((input: any, index: number) => (
      binToHex(sourceOutputs[index].lockingBytecode) === payerLock
        ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, payerKey) } : input));
    return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
  },
};
const payerBalance = async () => (await chain.provider.getUtxos(payerAddress)).reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
const beforeFee = await payerBalance();
const feeEvents: engine.StepProgress[] = [];
const hashedNote = await engine.finishNote(withPool, depositNote, payer, undefined, {
  mostTopUp: missing + missing / 10n,
  onSteps: (progress) => { feeEvents.push(progress); payerShown = progress; },
});
const paid = beforeFee - await payerBalance();
check(hashedNote.hashed, 'the note is added to the pool');
check(payerAsked.map((entry) => entry.prompt).join('|') === 'Gather your coins into one that pays the network fee|Pay the network fee of adding a note to a private pool',
  `the wallet is asked to gather its coins into one, then to pay the fee from it: ${payerAsked.map((entry) => entry.prompt).join(' / ')}`);
check(feeEvents[0]?.steps.map((step) => step.id).join(',') === 'gather,fee' && payerAsked.every(({ prompt, shown: at }, index) => (
  at?.current?.title === prompt && at.waiting === 'wallet' && at.current.approval === index + 1 && at.approvals === 2)),
  'both steps are known before the first, and each request finds its step waiting on the wallet, 1 of 2 then 2 of 2');
check(paid >= missing && paid < missing + 3_000n, `it pays the ${missing} sat missing and the gathering's fee: ${paid} sat`);
rmSync(scratch, { recursive: true, force: true });
finish();
