// The engine a browser runs, on a local chain, behind servers that lie. The chain is real
// and the page's own code drives it: only `fetch` stands between them. What a person
// must never see is money moved and a page that says otherwise, or the reverse.
//   tsx test/app-flows.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  binToHex, cashAddressToLockingBytecode, decodeAuthenticationInstructions, decodeTransaction, encodeCashAddress, encodeDataPush,
  encodeTransaction, flattenBinArray, hash160, hash256, hexToBin, lockingBytecodeToCashAddress, secp256k1,
} from '@bitauth/libauth';
import { reporter } from './lib/setup';
import { signP2pkh } from './lib/sign';
import { LocalChain } from '../service/chain';
import { deployPool } from '../scripts/lib/deploy';
import { deployFactory } from '../web/src/factory';
import { proveStatement } from '../service/lib/verifier';
import * as engine from '../web/src/engine';
import { Fulcrum, scripthashOfLock as scripthashOf } from '../web/src/fulcrum';
import { FulcrumProvider } from '../web/src/provider';
import { PoolClient, poolArguments, poolArtifact } from '../web/src/pool-client';
import { ChainHistory } from '../web/src/history';
import { parseNote } from '../web/src/note';
import { SEED_SATOSHIS } from '../web/src/pools';
import { indexerPools, poolsToServe } from '../web/src/listed-pools';
import { trustedFactories } from '../web/lib/deployment';
import { UNLISTED_POOL_RISK, withdrawNote } from '../scripts/lib/withdraw-note';
import { StatefulContract, getDataNftAddress, getEventNftAddress } from '@solidcash/solidcash/stateful';
import { connectWalletConnect } from '../web/src/wallet';

const { check, rejects, finish } = reporter();
const scratch = mkdtempSync(join(tmpdir(), 'pools-flows-'));
const chain = await LocalChain.open(join(scratch, 'state.json'));
const { faucet, provider } = chain;
// The pool is made through its factory, as the page and the scripts make every pool.
const factory = (await deployFactory('bch', faucet)).categoryId as string;
const deployed = await deployPool(provider, faucet, {
  id: 'bch', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: 1_000_000n,
}, factory);
const pool = { ...deployed, denomination: '1000000' };

const key = new Uint8Array(32).fill(0x41);
const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(key) as Uint8Array) }).address;
const tokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: hash160(secp256k1.derivePublicKeyCompressed(key) as Uint8Array) }).address;
const lock = (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
for (let i = 0; i < 12; i += 1) await chain.fund(address, []);
const balance = async () => (await provider.getUtxosForLockingBytecode(lock)).reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);

// What the two servers do. Each scenario sets what it needs.
const servers = {
  /** The broadcaster takes a transaction and tells the node nothing. */
  drops: false,
  /** It also lists what it dropped in every history, and serves it, as if it had landed. */
  lists: false,
  /** It relays a transaction, then says it was refused, this many times. */
  denies: 0,
  /** The second server answers from this old copy of the chain. */
  frozen: null as Map<string, unknown> | null,
  /** The first server does, and so hides whatever has landed since. */
  hiding: null as Map<string, unknown> | null,
  /** What an indexer's /pools names. */
  indexed: [] as unknown[],
  /** Runs before a request is answered, so something can land at just that moment. */
  before: null as null | ((method: string, params: any[]) => Promise<void>),
  /** Keeps the next transaction back and says it lost a race. A server can release it whenever it likes. */
  holds: false,
  /** Refuses broadcasts over this size without relaying them, in these words, once each. */
  refuses: { over: 0, words: [] as string[] },
  /** The second server stops answering reads. */
  secondDown: false,
  /**
   * Both list a stranger's unconfirmed coin at this lock and serve its transaction. The chain never
   * took it, as if its maker had double-spent it at miners.
   */
  stranger: null as null | { scripthash: string; txid: string; hex: string },
  /**
   * The second server relays a withdrawal with one zero byte more in a verifier filler, which does
   * the same and has another txid. It answers with the txid it was given, or with a conflict, as if
   * the changed copy had got there first.
   */
  malleates: null as null | 'relays' | 'first',
  /** The least fee their node relays, in satoshis per 1,000 bytes; anything paying less is refused in BCHN's words. */
  floor: 1_000n,
  /** The floor rises to this once the next transaction is relayed. */
  floorAfterNext: 0n,
};
/** What a transaction pays the miner, by the coins it spends on the local chain. */
const feeOf = async (hex: string): Promise<bigint> => {
  const transaction = decodeTransaction(hexToBin(hex)) as any;
  let spent = 0n;
  for (const input of transaction.inputs) {
    const parent = decodeTransaction(hexToBin(String(await chain.rpc('blockchain.transaction.get', [binToHex(input.outpointTransactionHash)])))) as any;
    spent += parent.outputs[input.outpointIndex].valueSatoshis;
  }
  return spent - transaction.outputs.reduce((sum: bigint, output: any) => sum + output.valueSatoshis, 0n);
};
/** The txid of the copy the second server relayed in place of a withdrawal. */
let malleatedTxid = '';
/** A withdrawal with one zero byte more in its first verifier input's filler. */
const malleate = (txHex: string): string => {
  const transaction = decodeTransaction(hexToBin(txHex)) as any;
  const input = transaction.inputs[transaction.inputs.length - 3];
  const pushes = decodeAuthenticationInstructions(input.unlockingBytecode).map((instruction: any) => instruction.data ?? new Uint8Array());
  pushes[3] = new Uint8Array(pushes[3].length + 1);
  input.unlockingBytecode = flattenBinArray(pushes.map((push: Uint8Array) => encodeDataPush(push)));
  return binToHex(encodeTransaction(transaction));
};
/** A stranger's transaction paying 1,000 sat to `lock` as output 0, its txid ground to sort before `before`. */
const strangerCoin = (lock: Uint8Array, before: string) => {
  for (let locktime = 0; ; locktime += 1) {
    const raw = encodeTransaction({
      version: 2, locktime,
      inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(0x77), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) }],
      outputs: [{ lockingBytecode: lock, valueSatoshis: 1_000n }],
    });
    const txid = binToHex(hash256(raw).slice().reverse());
    if (txid < before) return { scripthash: scripthashOf(lock), txid, hex: binToHex(raw) };
  }
};
/** Which server was asked what. */
const traffic: Array<{ second: boolean; method: string; params: any[] }> = [];
const heldBack: string[] = [];
const dropped = new Map<string, string>();
const seen = new Map<string, unknown>();
const answer = (id: unknown, body: object) => new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
const archiveReads: string[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  if (String(url).endsWith('/pools')) return new Response(JSON.stringify({ pools: servers.indexed }));
  if (String(url).includes('/archive/')) {
    archiveReads.push(new URL(String(url)).hostname);
    return new Response('', { status: 503 });
  }
  const { id, method, params } = JSON.parse(init.body);
  const second = String(url).includes('broadcaster');
  const key2 = JSON.stringify([method, params]);
  traffic.push({ second, method, params });
  await servers.before?.(method, params);
  if (method === 'blockchain.relayfee') return answer(id, { result: Number(servers.floor) / 1e8 });
  if (method === 'blockchain.transaction.broadcast' && servers.floor > 1_000n) {
    const [fee, least] = [await feeOf(params[0]), (BigInt(params[0].length / 2) * servers.floor + 999n) / 1000n];
    if (fee < least) return answer(id, { error: { code: 1, message: `the transaction was rejected by network rules.\n\nmin relay fee not met, ${fee} < ${least}\n` } });
  }
  if (second && servers.secondDown && method !== 'blockchain.transaction.broadcast') return answer(id, { error: { code: 1, message: 'unavailable' } });
  if (method === 'blockchain.transaction.broadcast' && servers.holds) {
    servers.holds = false;
    heldBack.push(params[0]);
    return answer(id, { error: { code: 1, message: 'bad-txns-inputs-conflict' } });
  }
  if (method === 'blockchain.transaction.broadcast' && params[0].length / 2 > servers.refuses.over && servers.refuses.words.length > 0) {
    return answer(id, { error: { code: 1, message: servers.refuses.words.shift() } });
  }
  if (method === 'blockchain.transaction.get' && params[0] === servers.stranger?.txid) return answer(id, { result: servers.stranger.hex });
  if (method === 'blockchain.transaction.broadcast' && second && servers.malleates) {
    const mode = servers.malleates;
    servers.malleates = null;
    malleatedTxid = String(await chain.rpc(method, [malleate(params[0])]));
    if (mode === 'first') return answer(id, { error: { code: 1, message: 'the transaction was rejected by network rules.\n\ntxn-mempool-conflict\n' } });
    return answer(id, { result: binToHex(hash256(hexToBin(params[0])).slice().reverse()) });
  }
  if (second && servers.frozen?.has(key2)) return answer(id, { result: servers.frozen.get(key2) });
  if (!second && servers.hiding?.has(key2)) return answer(id, { result: servers.hiding.get(key2) });
  try {
    if (method === 'blockchain.transaction.broadcast' && servers.drops) {
      const txid = binToHex(hash256(hexToBin(params[0])).slice().reverse());
      dropped.set(txid, params[0]);
      return answer(id, { result: txid });
    }
    if (method === 'blockchain.transaction.get_height' && dropped.has(params[0])) return answer(id, { result: second && servers.lists ? 0 : null });
    if (method === 'blockchain.transaction.get' && second && servers.lists && dropped.has(params[0])) return answer(id, { result: dropped.get(params[0]) });
    const result = await chain.rpc(method, params ?? []);
    if (method === 'blockchain.scripthash.listunspent' && params[0] === servers.stranger?.scripthash) {
      return answer(id, { result: [...(result as unknown[]), { tx_hash: servers.stranger.txid, tx_pos: 0, height: 0, value: 1_000 }] });
    }
    if (method === 'blockchain.scripthash.get_history' && second && servers.lists) {
      return answer(id, { result: [...(result as unknown[]), ...[...dropped.keys()].map((tx_hash) => ({ tx_hash, height: 0 }))] });
    }
    if (!second) seen.set(key2, result);
    if (method === 'blockchain.transaction.broadcast' && servers.floorAfterNext > 0n) {
      [servers.floor, servers.floorAfterNext] = [servers.floorAfterNext, 0n];
    }
    if (method === 'blockchain.transaction.broadcast' && servers.denies > 0) {
      servers.denies -= 1;
      return answer(id, { error: { code: 1, message: 'the transaction was rejected by network rules.\n\ntxn-mempool-conflict\n' } });
    }
    return answer(id, { result });
  } catch (error) {
    return answer(id, { error: { code: 1, message: String((error as Error).message) } });
  }
};

const config: any = {
  network: 'chipnet', addressPrefix: 'bchtest', fulcrumUrl: 'http://reader.invalid', broadcastUrl: 'http://broadcaster.invalid',
  pools: [pool], factories: { bch: factory }, prover: { circuitUrl: '', provingKeyUrl: '' },
};
let prompts = 0;
/** The wallet refuses from this prompt on. */
let refusesFrom = Infinity;
const wallet = {
  address,
  signRequest: async ({ transaction, sourceOutputs }: any) => {
    prompts += 1;
    if (prompts >= refusesFrom) throw new Error('User rejected the request');
    const inputs = transaction.inputs.map((input: any, index: number) => (
      binToHex(sourceOutputs[index].lockingBytecode) === binToHex(lock)
        ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, key) } : input));
    return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
  },
};
const reader = new Fulcrum('http://reader.invalid');
const client = new PoolClient({ id: pool.id, kind: 'bch', denomination: 1_000_000n, category: pool.category }, new FulcrumProvider('chipnet', reader));
const history = new ChainHistory(reader, client);
const cashAddressLock = (recipient: string) => (cashAddressToLockingBytecode(recipient) as { bytecode: Uint8Array }).bytecode;
const depositsOf = async (note: string) => (await history.deposits()).filter((record) => record.commitment === parseNote(note).commitment).length;
const COST = 1_000_000n + 216_000n;
/** The pool as it stands now, for a server to keep showing. Everything else it answers truly. */
const poolSnapshot = async () => {
  await client.view(history);
  await client.provider.getUtxos(client.contract.getSatoshiContainerAddress());
  const locks = [
    client.contract.address, client.contract.getSatoshiContainerAddress(), getDataNftAddress(client.contract.inner, pool.category),
    getEventNftAddress(client.contract.inner, pool.category, 'Deposit(uint32,bytes32)'),
    getEventNftAddress(client.contract.inner, pool.category, 'Withdraw(bytes32)'),
  ].map((locked) => scripthashOf(cashAddressLock(locked)));
  return new Map([...seen].filter(([request]) => locks.some((lockHash) => request.includes(lockHash))));
};
const oneServer = { ...config, broadcastUrl: undefined };
const failure = (attempt: Promise<unknown>): Promise<any> => attempt.then(() => ({ message: 'it succeeded' }), (error) => error);

// ---- the honest path ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  const result = await engine.deposit(config, note, wallet as any);
  check(result.accepted && result.hashed && prompts === 1, 'a deposit asks the wallet once and finishes hashing');
  check(await depositsOf(note) === 1, 'and lands one note');
  check(before - await balance() >= COST, 'and costs what it says');
}

// ---- a server that says it took the deposit and told nobody ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  servers.drops = true;
  const error = await failure(engine.deposit(config, note, wallet as any));
  servers.drops = false;
  check(/may have gone through/.test(error.message) && !error.unsent, 'a deposit nobody relayed is not called a success, or a failure');
  check(await balance() === before && await depositsOf(note) === 0, 'and no money moved');
}

// ---- a server that relays a deposit and says it was refused ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  prompts = 0;
  servers.denies = 3;
  const result = await engine.deposit(config, note, wallet as any);
  check(result.accepted, 'a deposit one server denies is found in the pool');
  check(await depositsOf(note) === 1, `one note paid once, not twice, after ${prompts} wallet prompt${prompts === 1 ? '' : 's'}`);
  check(prompts <= 3, 'and the wallet is not worn down with prompts');
  check(before - await balance() < COST + 20_000n, 'and the wallet paid for one deposit');
  servers.denies = 0;
}

// ---- a wallet that refuses ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  prompts = 0;
  refusesFrom = 1;
  const error = await failure(engine.deposit(config, note, wallet as any));
  refusesFrom = Infinity;
  check(/did not sign, so nothing was sent/.test(error.message) && error.unsent, 'a refusal says nothing was sent, so the note can be used again');
  check(await balance() === before, 'and nothing was');
  check((await engine.deposit(config, note, wallet as any)).accepted, 'and it can');
}

// ---- a wallet that cannot pay ----
{
  const broke = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(3) }).address;
  const error = await failure(engine.deposit(config, engine.newNote(pool as any, 'chipnet'), { ...wallet, address: broke } as any));
  check(/^This wallet holds 0 BCH\. Depositing into this pool needs [0-9.]+ BCH, including its fees\.$/.test(error.message) && error.unsent,
    'an empty wallet is told what it holds and what the deposit needs, and that nothing was sent');
}

// ---- a server that hides what landed ----
// With one server, nothing can contradict it, so the wallet is not asked twice.
{
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  prompts = 0;
  servers.hiding = await poolSnapshot();
  servers.denies = 3;
  const error = await failure(engine.deposit(oneServer, note, wallet as any));
  servers.hiding = null;
  servers.denies = 0;
  check(/may have gone through/.test(error.message) && !error.unsent, 'one server hiding a deposit gets no "nothing was sent"');
  check(prompts === 1 && await depositsOf(note) === 1, 'and no second signature');
  check(before - await balance() < COST + 20_000n, 'so the wallet paid once');
}
// Nor with two: a signed deposit can land at any time, whatever either server says of it.
// This one holds it back, so the other truthfully does not show it, and asks for another.
{
  await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  prompts = 0;
  servers.holds = true;
  const error = await failure(engine.deposit(config, note, wallet as any));
  check(prompts === 1 && /may have gone through/.test(error.message) && !error.unsent, 'a server holding a signed deposit back gets no second signature');
  await chain.rpc('blockchain.transaction.broadcast', [heldBack.at(-1)]);
  check(await depositsOf(note) === 1 && before - await balance() < COST + 20_000n, 'so when it lets go, one note is paid once');
  await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
}

// ---- a wallet over WalletConnect, as real ones speak it ----
{
  // The sign client's surface, and a wallet behind it that answers as Cashonize and Paytaca do:
  // accounts in CAIP-10 form, parameters in libauth's extended JSON, nothing broadcast.
  const revive = (text: string) => JSON.parse(text, (_key, value) => {
    if (typeof value !== 'string') return value;
    const bytes = /^<Uint8Array: 0x([0-9a-f]*)>$/.exec(value);
    if (bytes) return hexToBin(bytes[1]);
    const number = /^<bigint: (\d+)n>$/.exec(value);
    return number ? BigInt(number[1]) : value;
  });
  const asked: any[] = [];
  let init: any;
  let accounts = [`bch:${address}`];
  class SignClient {
    handlers = new Map<string, (event: any) => void>();
    hungUp: string[] = [];
    static last: SignClient;
    static async init(options: unknown) { init = options; SignClient.last = new SignClient(); return SignClient.last; }
    on(name: string, handler: (event: any) => void) { this.handlers.set(name, handler); }
    async disconnect({ topic }: { topic: string }) { this.hungUp.push(topic); }
    async connect() {
      return { uri: 'wc:pairing', approval: async () => ({ topic: 'session', peer: { metadata: { name: 'Cashonize' } }, namespaces: { bch: { accounts } } }) };
    }
    async request({ topic, chainId, request }: any) {
      asked.push({ topic, chainId, method: request.method, params: request.params });
      const { transaction, sourceOutputs } = revive(JSON.stringify(request.params));
      const inputs = transaction.inputs.map((input: any, index: number) => (
        binToHex(sourceOutputs[index].lockingBytecode) === binToHex(lock)
          ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, key) } : input));
      return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
    }
  }
  const events: string[] = [];
  const session = await connectWalletConnect({
    projectId: 'x', chain: 'bch:bchtest', signClient: SignClient, onUri: (uri: string) => events.push(uri),
    onEnded: () => events.push('ended'), onAddress: (next: string) => events.push(next),
  });
  check(session.address === address && session.walletName === 'Cashonize', 'a session reads the address real wallets send');
  check(init.telemetryEnabled === false, 'and tells WalletConnect nothing about this page');

  const note = engine.newNote(pool as any, 'chipnet');
  const before = await balance();
  const deposited = await engine.deposit(config, note, session as any);
  check(deposited.accepted && await depositsOf(note) === 1, 'a deposit goes from pairing to the pool through the page\'s own code');
  check(before - await balance() >= COST, 'and the wallet paid for it');
  const [first] = asked;
  check(asked.length === 1 && first.method === 'bch_signTransaction' && first.chainId === 'bch:bchtest' && first.topic === 'session', 'the wallet is asked once, on this chain');
  check(first.params.broadcast === false, 'and told not to broadcast, since the page does');

  const handlers = SignClient.last.handlers;
  const other = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(9) }).address;
  handlers.get('session_event')!({ topic: 'session', params: { event: { name: 'addressesChanged', data: [`bch:${other}`] } } });
  check(events.at(-1) === other, 'a wallet that moves addresses is followed');
  handlers.get('session_event')!({ topic: 'session', params: { event: { name: 'addressesChanged', data: ['bitcoincash:qqmain'] } } });
  handlers.get('session_event')!({ topic: 'another', params: { event: { name: 'addressesChanged', data: [`bch:${address}`] } } });
  check(events.at(-1) === other, 'but not to another network, or from another session');
  handlers.get('session_delete')!({ topic: 'another' });
  check(events.at(-1) === other, 'another session ending changes nothing');
  handlers.get('session_delete')!({ topic: 'session' });
  check(events.at(-1) === 'ended', 'and this one ending is noticed');
  handlers.get('session_expire')!({ topic: 'session' });
  check(events.filter((event) => event === 'ended').length === 2, 'as is its expiry');

  accounts = ['bch:bitcoincash:qqmain'];
  await rejects('a wallet with no account on this network', /no account on this network/, () => connectWalletConnect({ projectId: 'x', chain: 'bch:bchtest', signClient: SignClient }));
  check(SignClient.last.hungUp.includes('session'), 'and the session it opened is closed');
  prompts = 0;
}

// ---- withdrawals: what the page says is what happened ----
{
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const fresh = (byte: number) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(byte) }).address;

  const plain = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, plain, wallet as any);
  const paid = await engine.withdraw(config, plain, fresh(0x51), undefined, proveStatement);
  check(paid.outcome === 'paid' && await paidTo(fresh(0x51)) === 1_000_000n, 'a withdrawal that paid says so');

  // A stranger pays a coin to the verifier's lock with a txid that sorts first, then double-spends
  // its transaction at miners: a server still lists the coin, but it never confirms, and whatever
  // spends it is dropped. The page takes the pool's own coins first.
  {
    const note = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, note, wallet as any);
    const [first] = (await provider.getUtxosForLockingBytecode(client.verifier.lock)).map((coin: any) => coin.txid).sort();
    servers.stranger = strangerCoin(client.verifier.lock, first);
    const recipient = fresh(0x5c);
    const outcome = await engine.withdraw(config, note, recipient, undefined, proveStatement).catch(() => ({ outcome: 'threw' }));
    servers.stranger = null;
    check(outcome.outcome === 'paid' && await paidTo(recipient) === 1_000_000n, 'a withdrawal passes over a stranger\'s unconfirmed coin that sorts first');
  }
  {
    const [first] = (await provider.getUtxosForLockingBytecode(client.workerLock)).map((coin: any) => coin.txid).sort();
    servers.stranger = strangerCoin(client.workerLock, first);
    const note = engine.newNote(pool as any, 'chipnet');
    const result = await engine.deposit(config, note, wallet as any).catch(() => ({ hashed: false }));
    servers.stranger = null;
    check(result.hashed && await depositsOf(note) === 1, 'and so do a deposit and its hashing, at the hashing coins\' lock');
  }

  // Anyone who relays a withdrawal can change it without changing what it does: a zero byte more in
  // a verifier filler, or a re-randomised proof, gives another txid. The page knows a withdrawal by
  // its nullifier hash, and names the transaction that landed.
  for (const [mode, byte, label] of [
    ['relays', 0x5d, 'a withdrawal that lands under another txid is paid'],
    ['first', 0x5e, 'and so is one whose changed copy got there first'],
  ] as const) {
    const note = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, note, wallet as any);
    malleatedTxid = '';
    servers.malleates = mode;
    const outcome = await engine.withdraw(config, note, fresh(byte), undefined, proveStatement).catch(() => ({ outcome: 'threw', txid: '' }));
    servers.malleates = null;
    check(outcome.outcome === 'paid' && malleatedTxid !== '' && outcome.txid === malleatedTxid && await paidTo(fresh(byte)) === 1_000_000n, label);
  }

  // A server keeps a withdrawal to itself and lists it as landed. The pool's state does not hold
  // it, so the page does not call it paid. One that also forged the state would get further,
  // which is why the page keeps the note whatever it is told.
  {
    const listed = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, listed, wallet as any);
    const recipient = fresh(0x5a);
    dropped.clear();
    servers.drops = true;
    servers.lists = true;
    const said = await engine.withdraw(config, listed, recipient, undefined, proveStatement);
    servers.drops = false;
    servers.lists = false;
    dropped.clear();
    check(said.outcome === 'sent' && await paidTo(recipient) === 0n, 'a history that lists a withdrawal the pool does not hold is not called paid');
  }

  // An archive hears a read just before each deposit or withdrawal, so one person's two sides
  // must not meet in one. Each server has its own, and neither needs the other's.
  {
    const archived = { ...config, archiveUrl: 'http://wallet-archive.invalid', broadcastArchiveUrl: 'http://second-archive.invalid' };
    const note = engine.newNote(pool as any, 'chipnet');
    archiveReads.length = 0;
    await engine.deposit(archived, note, wallet as any);
    check(archiveReads.length > 0 && archiveReads.every((host) => host === 'wallet-archive.invalid'), 'a deposit reads its own server\'s archive alone');
    archiveReads.length = 0;
    await engine.withdraw(archived, note, fresh(0x5b), undefined, proveStatement);
    check(archiveReads.length > 0 && archiveReads.every((host) => host === 'second-archive.invalid'), 'a withdrawal reads its own server\'s archive alone');
  }

  // The same note, paid elsewhere while this page was proving.
  const contested = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, contested, wallet as any);
  const elsewhere = fresh(0x52);
  const here = fresh(0x53);
  let raced = false;
  const outcome = await engine.withdraw(config, contested, here, undefined, async (input) => {
    const proof = await proveStatement(input);
    if (!raced) { raced = true; await engine.withdraw(config, contested, elsewhere, undefined, proveStatement); }
    return proof;
  });
  check(outcome.outcome === 'spent' && await paidTo(here) === 0n && await paidTo(elsewhere) === 1_000_000n, 'a note paid elsewhere is not called paid to this address');

  // The pool moves on past the proof's root, and again while it is made over.
  const slow = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, slow, wallet as any);
  let proofs = 0;
  const reproved = await engine.withdraw(config, slow, fresh(0x54), undefined, async (input) => {
    proofs += 1;
    const proof = await proveStatement(input);
    for (let i = 0; i < (proofs === 1 ? 8 : proofs === 2 ? 1 : 0); i += 1) await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
    return proof;
  });
  check(reproved.outcome === 'paid' && proofs === 2, 'a proof that fell behind is made again, and goes out against the pool as it is then');

  // A broadcast refused for having lost a race, in the words servers really use. A note pays
  // once, so this retries whatever the words were.
  for (const word of ['txn-mempool-conflict', 'Missing inputs', 'bad-txns-inputs-missingorspent', 'something nobody has seen']) {
    const lost = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, lost, wallet as any);
    const recipient = fresh(0x60 + word.length);
    servers.refuses = { over: 20_000, words: [word] };
    const outcome2 = await engine.withdraw(config, lost, recipient, undefined, proveStatement);
    servers.refuses = { over: 0, words: [] };
    check(outcome2.outcome === 'paid' && await paidTo(recipient) === 1_000_000n, `a withdrawal refused with "${word}" goes out again and pays`);
  }

  // A hashing step refused the same way is tried again.
  {
    await client.deposit(faucet, parseNote(engine.newNote(pool as any, 'chipnet')).commitment, await client.view(history));
    servers.refuses = { over: 50_000, words: ['txn-mempool-conflict', 'something nobody has seen'] };
    const result = await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
    servers.refuses = { over: 0, words: [] };
    check(result.accepted && result.hashed, 'a finish refused for any reason is tried again');
  }

  // Sent, refused in words, and then the server goes quiet. The money moved.
  {
    const quiet = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, quiet, wallet as any);
    const recipient = fresh(0x56);
    servers.denies = 1;
    servers.before = async (method) => { if (method === 'blockchain.transaction.broadcast') { servers.before = null; servers.secondDown = true; } };
    const error = await failure(engine.withdraw(config, quiet, recipient, undefined, proveStatement));
    servers.secondDown = false;
    servers.denies = 0;
    check(await paidTo(recipient) === 1_000_000n && /Keep your note until the recipient/.test(error.message), 'a withdrawal that left is never called unsent, and its advice is its own');
  }

  // Another note's hashing cannot go through, which is what a raised relay floor would do. The
  // pool pays any note in its tree at any stage, so this stops deposits and not withdrawals.
  {
    const mine = engine.newNote(pool as any, 'chipnet');
    await engine.deposit(config, mine, wallet as any);
    await client.deposit(faucet, parseNote(engine.newNote(pool as any, 'chipnet')).commitment, await client.view(history));
    servers.refuses = { over: 50_000, words: Array.from({ length: 200 }, () => 'min relay fee not met') };
    const recipient = fresh(0x58);
    const paidAnyway = await engine.withdraw(config, mine, recipient, undefined, proveStatement);
    check(paidAnyway.outcome === 'paid' && await paidTo(recipient) === 1_000_000n, 'a note in the tree pays while another note\'s hashing is stuck');
    const error = await failure(engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any));
    servers.refuses = { over: 0, words: [] };
    check(/could not be finished/.test(error.message) && error.unsent, 'and a deposit it stops is told nothing was sent');
    await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
  }

  // A note still being hashed finishes first, through the withdrawal's own server.
  {
    const own = engine.newNote(pool as any, 'chipnet');
    await client.deposit(faucet, parseNote(own).commitment, await client.view(history));
    traffic.length = 0;
    const paidHashed = await engine.withdraw(config, own, fresh(0x59), undefined, proveStatement);
    check(paidHashed.outcome === 'paid', 'a note still being hashed finishes and pays');
    check(traffic.every((request) => request.second || request.method !== 'blockchain.transaction.broadcast'), 'with no broadcast through the wallet\'s server');
  }

  // Someone else's last hashing step lands between reading the pool and building on it.
  const raceNote = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, raceNote, wallet as any);
  const verifierAt = binToHex(hexToBin(scripthashOf(client.verifier.lock)));
  let moved = false;
  const racing = await engine.withdraw(config, raceNote, fresh(0x55), undefined, async (input) => {
    const proof = await proveStatement(input);
    await client.deposit(faucet, parseNote(engine.newNote(pool as any, 'chipnet')).commitment, await client.view(history));
    servers.before = async (method, params) => {
      if (moved || method !== 'blockchain.scripthash.listunspent' || params[0] !== verifierAt) return;
      moved = true;
      await client.finish(await client.view(history));
    };
    return proof;
  });
  servers.before = null;
  check(moved && racing.outcome === 'paid', 'a withdrawal that lost a race rebuilds on what won');
}

// ---- coins anyone can pay to a pool's locks ----
// A provider stub lists the coins and serves the transactions that made them. Every pool shares
// these coins, so a coin one of the pool's own transactions made comes first: the pool's next
// transaction depends on that one anyway, and no other pool reaches for it. Then a confirmed coin,
// in an order of the pool's own, and a stranger's unconfirmed coin only when the others are too few.
{
  const outputs = Array.from({ length: 10 }, () => ({ lockingBytecode: client.verifier.lock, valueSatoshis: 1_000n }));
  const ofThePool = encodeTransaction({
    version: 2, locktime: 0, outputs: [{
      lockingBytecode: cashAddressLock(client.contract.address), valueSatoshis: 1_200n,
      token: { category: hexToBin(pool.category), amount: 0n, nft: { capability: 'minting', commitment: new Uint8Array() } },
    }, ...outputs],
    inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(0x66), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) }],
  });
  const poolTxid = binToHex(hash256(ofThePool).slice().reverse());
  const stranger = strangerCoin(client.verifier.lock, poolTxid);
  const confirmed = 'ff'.repeat(32);
  const served = new Map([[poolTxid, binToHex(ofThePool)], [stranger.txid, stranger.hex]]);
  const nameOf = (coin: any) => `${coin.txid === poolTxid ? 'pool' : coin.txid === stranger.txid ? 'stranger' : 'confirmed'}:${coin.vout}`;
  const pick = async (coins: Array<[string, number, number]>, count: number, transactions = served) => {
    const stub = {
      getUtxosForLockingBytecode: async () => coins.map(([txid, vout, blockHeight]) => ({ txid, vout, satoshis: 1_000n, blockHeight })),
      getRawTransaction: async (txid: string) => {
        const raw = transactions.get(txid);
        if (!raw) throw new Error('unknown transaction');
        return raw;
      },
    };
    const picker = new PoolClient({ id: pool.id, kind: 'bch', denomination: 1_000_000n, category: pool.category }, stub);
    return (await picker.coinsAt(count === 10 ? picker.workerLock : picker.verifier.lock, count)).map(nameOf).join(' ');
  };
  const pooled = (count: number) => Array.from({ length: count }, (_, i) => [poolTxid, i + 1, 0] as [string, number, number]);
  const named = (count: number) => pooled(count).map(([, vout]) => `pool:${vout}`).join(' ');
  check(await pick([[stranger.txid, 0, 0], ...pooled(3)], 3) === named(3), 'a stranger\'s unconfirmed coin that sorts first is passed over for the pool\'s');
  check(await pick([[stranger.txid, 0, 0], [poolTxid, 1, 0], [confirmed, 0, 800_000]], 3) === 'pool:1 confirmed:0 stranger:0', 'the pool\'s own coin comes first, then a confirmed one, and a stranger\'s only when the others are too few');
  check(await pick([[stranger.txid, 0, -1], ...pooled(10)], 10) === named(10), 'the hashing coins are chosen the same way');
  // A server cannot make a stranger's coin the pool's by serving the pool's transaction for it.
  const swapped = new Map([...served, [stranger.txid, binToHex(ofThePool)]]);
  check(await pick([[stranger.txid, 0, 0], ...pooled(3)], 3, swapped) === named(3), 'and a transaction served under another txid counts for nothing');
}

// ---- recipients ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  const mainnet = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: new Uint8Array(20).fill(1) }).address;
  await rejects('an address for another network', /another network/, () => engine.withdraw(config, note, mainnet));
  await rejects('something that is no address', /not a valid address/, () => engine.withdraw(config, note, 'bchtest:nonsense'));

  const tokenPool = { ...pool, id: 'usdt', kind: 'token', category: 'ab'.repeat(32), asset: 'cd'.repeat(32), denomination: '100' };
  const tokenConfig = { ...config, pools: [tokenPool] };
  await rejects('a token note to an address with no token support', /token-aware/, () => engine.withdraw(tokenConfig, engine.newNote(tokenPool as any, 'chipnet'), address));

  // A payout to a lock the pool owns is lost for good: no key opens any of them.
  const addressOf = (lock: Uint8Array, tokenSupport = false) => (
    lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest', tokenSupport }) as { address: string }).address;
  const owned: Array<[string, Uint8Array]> = [
    ['master', cashAddressLock(client.contract.address)],
    ['state record', cashAddressLock(getDataNftAddress(client.contract.inner, pool.category))],
    ['satoshi coin', cashAddressLock(client.contract.getSatoshiContainerAddress())],
    ['Deposit events', cashAddressLock(getEventNftAddress(client.contract.inner, pool.category, 'Deposit(uint32,bytes32)'))],
    ['Withdraw events', cashAddressLock(getEventNftAddress(client.contract.inner, pool.category, 'Withdraw(bytes32)'))],
    ['hashing coins', client.workerLock],
    ['verifier', client.verifier.lock],
  ];
  for (const [name, own] of owned) {
    await rejects(`a payout to the pool's ${name}`, /belongs to the pool/, () => engine.withdraw(config, note, addressOf(own)));
  }
  const tokenClient = new PoolClient({ id: tokenPool.id, kind: 'token', denomination: 100n, category: tokenPool.category, asset: tokenPool.asset }, client.provider);
  const tokenCoin = cashAddressLock(tokenClient.contract.getTokenContainerAddress(tokenPool.asset));
  await rejects('a token payout to the token pool\'s own token coin', /belongs to the pool/, () => engine.withdraw(tokenConfig, engine.newNote(tokenPool as any, 'chipnet'), addressOf(tokenCoin, true)));
  check(engine.sameLock(address, tokenAddress), 'one key\'s plain and token addresses are the same lock');
  check(engine.sameLock(address, address.toUpperCase()), 'and so is its uppercase form');
  check(!engine.sameLock(address, mainnet), 'and another key\'s is not');
}

// ---- two servers that show different pools ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, note, wallet as any);
  servers.frozen = await poolSnapshot();
  await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
  await rejects('no proof is made over a pool the second server does not know', /disagree/, () => engine.withdraw(config, note, tokenAddress));
  servers.frozen = null;
}

// ---- who hears what ----
{
  const note = engine.newNote(pool as any, 'chipnet');
  traffic.length = 0;
  await engine.deposit(config, note, wallet as any);
  check(traffic.length > 0 && traffic.every((request) => !request.second), 'the second server hears nothing of a deposit or its hashing');

  traffic.length = 0;
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x57) }).address;
  await engine.withdraw(config, note, recipient, undefined, proveStatement);
  const wallets = traffic.filter((request) => !request.second);
  const verifierLock = scripthashOf(client.verifier.lock);
  check(traffic.some((request) => request.second && request.method === 'blockchain.transaction.broadcast'), 'a withdrawal goes out through the second server');
  check(wallets.every((request) => request.method !== 'blockchain.transaction.broadcast' && !request.params.includes(verifierLock)), 'and the wallet\'s server sees no sign of one');
}

// ---- nodes that ask more than a pool prepaid ----
// The pools' fees are constants sized for 1 sat/B. Should nodes ever ask more, a deposit waits
// for SolidCash, and a note already in stays withdrawable with wallets the person chose paying
// the rest: the note's own hashing from the wallet that deposited it, which is tied to the
// deposit already, and the withdrawal from any other. Without one, nothing is sent.
{
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x61) }).address;
  const recipientBalance = async () => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const hashedNote = engine.newNote(pool as any, 'chipnet');
  check((await engine.deposit(config, hashedNote, wallet as any)).hashed, 'a note goes in while nodes take 1 sat/B');
  const waiting = engine.newNote(pool as any, 'chipnet');
  servers.floorAfterNext = 2_000n;
  prompts = 0;
  const deposited = await engine.deposit(config, waiting, wallet as any);
  check(servers.floor === 2_000n && deposited.accepted && !deposited.hashed && (deposited.waitsOnFee ?? 0n) > 0n && prompts === 1,
    'a deposit lands, and its hashing waits once nodes ask 2 sat/B, and says it waits on a fee');
  await rejects('a deposit while nodes ask more than SolidCash pays', /higher network fee/, () => engine.deposit(config, engine.newNote(pool as any, 'chipnet'), wallet as any));
  check(prompts === 1, 'which asks the wallet nothing');

  const unhashed = await failure(engine.withdraw(config, waiting, recipient, undefined, proveStatement));
  check(unhashed.step === 'hashing' && unhashed.missing > 0n && unhashed.unsent,
    `a withdrawal whose own note's hashing is ${unhashed.missing} sat short stops, and says how much`);
  const kept = await failure(engine.withdraw(config, waiting, recipient, undefined, proveStatement, { feeWallet: wallet as any }));
  check(kept.step === 'hashing' && prompts === 1,
    'a withdrawal\'s fee wallet never pays the note\'s own hashing, which would tie the deposit to the withdrawal');
  const unpaid = await failure(engine.withdraw(config, hashedNote, recipient, undefined, proveStatement));
  check(unpaid.step === 'withdrawal' && unpaid.missing > 0n && unpaid.unsent, `and one ${unpaid.missing} sat short itself stops too`);
  check(prompts === 1 && await recipientBalance() === 0n, 'none of them asks the wallet anything or pays anyone');
  servers.floor = 6_000n;
  const unbelieved = await failure(engine.withdraw(config, hashedNote, recipient, undefined, proveStatement, { feeWallet: wallet as any }));
  check(/more than this page believes/.test(unbelieved.message) && unbelieved.unsent && prompts === 1,
    'a server naming 6 sat/B is not believed, even with a wallet chosen, and the wallet is not asked');
  servers.floor = 2_000n;

  refusesFrom = prompts + 1;
  const refused = await failure(engine.finishNote(config, waiting, wallet as any));
  refusesFrom = Infinity;
  check(/did not sign/.test(refused.message) && refused.unsent && prompts === 2, 'a wallet that refuses to pay the hashing is asked once');
  const capped = await failure(engine.finishNote(config, waiting, wallet as any, undefined, { mostTopUp: unhashed.missing / 2n }));
  check(capped.step === 'hashing' && prompts === 2, 'and never for more than the page showed');
  const beforeHashing = await balance();
  const finished = await engine.finishNote(config, waiting, wallet as any, undefined, { mostTopUp: unhashed.missing + unhashed.missing / 10n });
  const paidHashing = beforeHashing - await balance();
  check(finished.hashed && prompts === 3 && paidHashing >= unhashed.missing && paidHashing < unhashed.missing + 1_000n,
    `the wallet that deposited signs once, and pays ${paidHashing} sat to add the note`);

  const beforeWithdrawal = await balance();
  const result = await engine.withdraw(config, waiting, recipient, undefined, proveStatement,
    { feeWallet: wallet as any, mostTopUp: unpaid.missing + unpaid.missing / 10n });
  const paidWithdrawal = beforeWithdrawal - await balance();
  check(result.outcome === 'paid' && await recipientBalance() === 1_000_000n, 'then, with a wallet chosen to pay the rest, the note is paid');
  check(prompts === 4 && paidWithdrawal > 0n && paidWithdrawal < unpaid.missing + 2_000n,
    `that wallet signs once and pays ${paidWithdrawal} sat`);
  servers.floor = 1_000n;
}

// ---- a pool no factory made, listed by an indexer ----
// Anyone can make a pool of the same code outside a factory, through a plain genesis that can keep a
// second master back to pay out proofs of a tree of its own later. An indexer's word for a pool proves
// nothing, so the app's server lists one only once it finds it among the factory's creations, and the
// page reads those itself before it lists a pool, deposits or withdraws.
{
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const coin = await chain.fund(faucet.getAddress(), [], 300_000n);
  const fundingUtxo = (await faucet.getUtxos()).find((candidate: any) => candidate.txid === coin && candidate.vout === 0);
  const definition = { id: coin, kind: 'bch' as const, denomination: 1_000_000n, category: coin };
  await StatefulContract.deploy(poolArtifact('bch'), poolArguments(definition), {
    provider, fundingUtxo, funder: faucet.unlockP2PKH(), changeAddress: faucet.getAddress(), initialBalance: SEED_SATOSHIS,
  } as any);
  const outside = { id: coin, kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: '1000000', category: coin };
  // The indexer names both, the factory's pool by its category as an indexer does.
  servers.indexed = [{ ...pool, id: pool.category }, outside];
  const deployment = { network: 'chipnet', fulcrumUrl: 'http://reader.invalid', factories: { bch: factory }, pools: [] };
  const listed = await poolsToServe(deployment, await indexerPools('http://indexer.invalid'), { reader });
  check(listed.length === 1 && listed[0].category === pool.category, 'the app lists the pool its indexer names that the factory made, and not one made outside it');
  check((await poolsToServe({ ...deployment, factories: null }, await indexerPools('http://indexer.invalid'), { reader })).length === 0,
    'and with no factory to check against, it lists none of the indexer\'s');
  servers.indexed = [];
  // The deployment's own pools are checked the same way, and what a read showed is kept: while the
  // chain cannot be read, the app serves the pools it saw made before, and never another.
  const bundled = await poolsToServe({ ...deployment, pools: [outside as any, pool] }, [], { reader });
  check(bundled.length === 1 && bundled[0].category === pool.category, 'a pool the deployment itself names that the factory did not make is not served');
  // Every read the app's server makes fails, and a refresh waits for its read, so what is served
  // after it is what a failed read left.
  let asked = 0;
  const unreachable = async (): Promise<never> => { asked += 1; throw new Error('unreachable'); };
  const unreadable = { history: unreachable, transaction: unreachable, firstUse: unreachable, listUnspent: unreachable, transactionHeight: unreachable };
  const kept = await poolsToServe({ ...deployment, pools: [outside as any, pool] }, [], { reader: unreadable, refresh: true });
  check(asked > 0 && kept.length === 1 && kept[0].category === pool.category, 'while the chain cannot be read, only the pools seen made before are served');
  check((await poolsToServe({ ...deployment, fulcrumUrl: 'http://unread.invalid', pools: [pool] }, [], { reader: unreadable })).length === 0,
    'and with none seen before, none at all');

  const both = { ...config, pools: [pool, outside] };
  const rows = (await engine.loadState(both)).pools;
  check(rows.some((row: any) => row.id === pool.id && !row.unread) && !rows.some((row: any) => row.category === outside.category),
    'Trustless lists the factory\'s pool and not the other, whatever its list says');
  const found = (await engine.loadState({ ...config, pools: [] })).pools;
  check(found.length === 1 && found[0].category === pool.category && found[0].network === 'chipnet' && !found[0].unread,
    'and finds the factory\'s pools through its events with no list at all');

  const before = await balance();
  prompts = 0;
  const refused = await failure(engine.deposit(both, engine.newNote(outside as any, 'chipnet'), wallet as any));
  check(/not one this network's factories made/.test(refused.message) && refused.unsent && prompts === 0 && await balance() === before,
    'a deposit into the pool made outside the factory is refused before the wallet is asked, and nothing moves');
  check((await engine.deposit(both, engine.newNote(pool as any, 'chipnet'), wallet as any)).accepted, 'while one into the factory\'s pool, through the same list, goes in');
  // The control: the other pool works, and a deposit built by hand goes in. Only the page's check stopped it.
  const outsider = new PoolClient(definition, new FulcrumProvider('chipnet', reader));
  const outsideNote = engine.newNote(outside as any, 'chipnet');
  const handBuilt = await outsider.deposit(faucet, parseNote(outsideNote).commitment, await outsider.view(new ChainHistory(reader, outsider)))
    .then(() => true, () => false);
  check(handBuilt, 'the pool made outside the factory takes a deposit built by hand');

  // Its note is no more trusted than its listing: the page will not withdraw it, and neither will
  // the script unless told to, when it says what that risks first.
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x86) }).address;
  await rejects('a withdrawal from the pool made outside the factory, on the page', /not one this network's factories made/,
    () => engine.withdraw(both, outsideNote, recipient, undefined, proveStatement));
  const script = { note: outsideNote, recipient, fulcrumUrl: 'http://reader.invalid', deployment: { pools: [], factories: { bch: factory } } };
  await rejects('and in the script without --unlisted-pool', /not one this network's factories made/, () => withdrawNote(script));
  const said: string[] = [];
  const recovered = await withdrawNote({ ...script, unlistedPool: true, log: (line) => said.push(line) });
  check(recovered.outcome === 'paid' && await paidTo(recipient) === 1_000_000n && said[0] === UNLISTED_POOL_RISK,
    'with it, the script says what that risks, then withdraws the note');
}

// ---- the factories a page trusts ----
// BCH_FACTORY and TOKEN_FACTORY name them for the network the app runs for, as they do for the
// indexer. Where a deployment names another, nothing tells which is right, so the network is not served.
{
  const saved = { network: process.env.POOL_NETWORK, bch: process.env.BCH_FACTORY };
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  process.env.POOL_NETWORK = 'chipnet';
  const file = { network: 'chipnet' as const, factories: { bch: factory }, pools: [] };
  process.env.BCH_FACTORY = 'ee'.repeat(32);
  await rejects('a deployment whose factory the environment contradicts', /another BCH pool factory/, async () => trustedFactories('chipnet', file));
  process.env.BCH_FACTORY = factory.toUpperCase();
  check(trustedFactories('chipnet', file)?.bch === factory, 'one both name alike is taken');
  check(trustedFactories('chipnet', { ...file, factories: null })?.bch === factory && trustedFactories('chipnet', { ...file, factories: null })?.token === undefined,
    'and one only the environment names is taken for its kind alone');
  check(trustedFactories('mainnet', { network: 'mainnet', pools: [] }) === null, 'while another network than POOL_NETWORK takes none from it');
  restore('POOL_NETWORK', saved.network);
  restore('BCH_FACTORY', saved.bch);
}

// ---- a note alone ----
// A note names its network, its pool's kind and category, and its amount, so a page that lists no
// pools and has no indexer withdraws it through a chain server alone, once the network's factory is
// seen to have made that pool, as the note says. Notes an older page wrote named a deployment's id,
// or a pool's category: the id withdraws through the page's list, and the category through the
// factory's events, with no list at all.
{
  const recipientOf = (byte: number) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(byte) }).address;
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  // A server no page has read through, so nothing it read before is kept. The page knows its
  // network's factories, as every page does from its deployment, and no pool.
  const bare = {
    network: 'chipnet', addressPrefix: 'bchtest', fulcrumUrl: 'http://fresh.invalid', pools: [], factories: { bch: factory }, prover: config.prover,
  };

  const note = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, note, wallet as any);
  const mainnet = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: new Uint8Array(20).fill(0x80) }).address;
  await rejects('a note on a page of another network', /This note is for Chipnet/, () => engine.withdraw(
    { ...bare, network: 'mainnet', networkId: 'mainnet', addressPrefix: 'bitcoincash' }, note, mainnet, undefined, proveStatement));
  const alone = await engine.withdraw(bare, note, recipientOf(0x81), undefined, proveStatement);
  check(alone.outcome === 'paid' && await paidTo(recipientOf(0x81)) === 1_000_000n, 'a note withdraws on a page that lists no pools and has no indexer');
  // A note's text cannot claim another pool's terms: its amount must be the one its pool's factory made it for.
  const altered = note.replace('-1000000-0x', '-10000000-0x');
  await rejects('a note naming another amount than its pool\'s factory made it for', /another amount or asset than its pool's factory made it for/,
    () => engine.withdraw(bare, altered, recipientOf(0x84), undefined, proveStatement));
  await rejects('and the same note on a page that lists its pool', /another amount/, () => engine.withdraw(config, altered, recipientOf(0x84), undefined, proveStatement));

  const secretOf = (text: string) => text.slice(-124);
  const byCategory = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, byCategory, wallet as any);
  const olderByCategory = `bchnote-${pool.category}-1000000-0x${secretOf(byCategory)}`;
  await rejects('an older note naming a category, on a page that knows no factory', /does not know/,
    () => engine.withdraw({ ...bare, factories: undefined }, olderByCategory, recipientOf(0x82), undefined, proveStatement));
  const byEvents = await engine.withdraw(bare, olderByCategory, recipientOf(0x82), undefined, proveStatement);
  check(byEvents.outcome === 'paid' && await paidTo(recipientOf(0x82)) === 1_000_000n, 'an older note naming its pool\'s category withdraws through the factory\'s events, with no list');

  const byId = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, byId, wallet as any);
  const olderById = `tornado-bch-${pool.id}-1000000-0x${secretOf(byId)}`;
  await rejects('an older note naming an id no list holds', /does not know/, () => engine.withdraw(bare, olderById, recipientOf(0x83), undefined, proveStatement));
  const byList = await engine.withdraw(config, olderById, recipientOf(0x83), undefined, proveStatement);
  check(byList.outcome === 'paid' && await paidTo(recipientOf(0x83)) === 1_000_000n, 'and one naming a deployment\'s id withdraws through the page\'s list');
}

// ---- what a withdrawal shows the wallet's server ----
// With two servers, a withdrawal checks its pool's roots with the wallet's server too, which knows the
// wallet. One read of the note's pool alone, just before a withdrawal from it leaves the other server,
// would tell that server which pool the withdrawal left, so it is asked as a page load asks it: about
// every pool at once. A second pool from the factory shows it.
{
  const other = await deployPool(provider, faucet, {
    id: 'bch2', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: 10_000_000n,
  }, factory);
  const recordOf = (category: string, denomination: bigint) => scripthashOf(cashAddressLock(getDataNftAddress(
    new PoolClient({ id: category, kind: 'bch', denomination, category }, client.provider).contract.inner, category)));
  const records = new Map([[recordOf(pool.category, 1_000_000n), 'the note\'s pool'], [recordOf(other.category, 10_000_000n), 'the other pool']]);
  const walletReads = () => new Set(traffic.filter((request) => !request.second && records.has(request.params?.[0])).map((request) => records.get(request.params[0])));
  traffic.length = 0;
  await engine.loadState(config);
  check(walletReads().size === 2, 'a page load reads the state of every pool through the wallet\'s server');
  const note = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, note, wallet as any);
  traffic.length = 0;
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x87) }).address;
  const paid = await engine.withdraw(config, note, recipient, undefined, proveStatement);
  const read = walletReads();
  check(paid.outcome === 'paid' && read.has('the other pool') && read.has('the note\'s pool'),
    'and a withdrawal reads them all there too, not the note\'s pool alone');
  check(traffic.every((request) => request.second || request.method !== 'blockchain.transaction.broadcast'), 'and sends nothing there');
}

// ---- a withdrawal after a page load ----
// A Trustless page load reads every pool through the wallet's server. While the roots it saw are still
// the pool's newest, a withdrawal asks that server nothing, and proves over the newest root as a fresh
// read would. Once one more root has landed it reads every pool there again: a proof over an older
// root would tell everyone on chain that it came from a page loaded before the latest deposit. A second
// server that shows another pool than the load saw gets no proof either way.
{
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const recipientOf = (byte: number) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(byte) }).address;
  // The wallet pays for this block's four deposits here, so the blocks after it keep what they had.
  for (let i = 0; i < 2; i += 1) await chain.fund(address, []);

  const note = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, note, wallet as any);
  await engine.loadState(config);
  traffic.length = 0;
  const paid = await engine.withdraw(config, note, recipientOf(0x8c), undefined, proveStatement);
  check(paid.outcome === 'paid' && await paidTo(recipientOf(0x8c)) === 1_000_000n && traffic.length > 0 && traffic.every((request) => request.second),
    'a withdrawal right after a page load asks the wallet\'s server nothing');

  const later = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, later, wallet as any);
  await engine.loadState(config);
  // One more note, hashed, so the newest root is no longer the one that load saw.
  await client.deposit(faucet, parseNote(engine.newNote(pool as any, 'chipnet')).commitment, await client.view(history));
  await client.finish(await client.view(history));
  traffic.length = 0;
  const fellBack = await engine.withdraw(config, later, recipientOf(0x8d), undefined, proveStatement);
  check(fellBack.outcome === 'paid' && await paidTo(recipientOf(0x8d)) === 1_000_000n && traffic.some((request) => !request.second),
    'after one more root, it reads the pools through the wallet\'s server again');

  const disputed = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, disputed, wallet as any);
  servers.frozen = await poolSnapshot();
  await engine.deposit(oneServer, engine.newNote(pool as any, 'chipnet'), wallet as any);
  await engine.loadState(config);
  let proofs = 0;
  await rejects('a withdrawal whose second server shows another pool than the page load saw', /disagree/,
    () => engine.withdraw(config, disputed, recipientOf(0x8e), undefined, async (input) => { proofs += 1; return proveStatement(input); }));
  servers.frozen = null;
  check(proofs === 0, 'and no proof is made for it');
}

// ---- a deposit pays what its note says ----
// A note that names its pool's category with another amount would otherwise go into the pool at the
// pool's own amount, and name an amount it does not hold, which no page would then withdraw.
{
  const note = engine.newNote(pool as any, 'chipnet').replace('-1000000-0x', '-10000000-0x');
  const before = await balance();
  prompts = 0;
  const refused = await failure(engine.deposit(config, note, wallet as any));
  check(/another amount or asset/.test(refused.message) && refused.unsent && prompts === 0 && await balance() === before,
    'a note naming another amount than its pool is refused before the wallet is asked');
}

// ---- a note's own terms over a stale list ----
// The note is the withdrawal key. A page whose list names the note's pool with another amount, as a
// browser that kept a creation later replaced could, still withdraws it by the note's own terms,
// once the factory is seen to have made the pool on them.
{
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const note = engine.newNote(pool as any, 'chipnet');
  await engine.deposit(config, note, wallet as any);
  const stale = { ...config, pools: [{ ...pool, id: 'stale', denomination: '10000000' }] };
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x88) }).address;
  const paid = await engine.withdraw(stale, note, recipient, undefined, proveStatement);
  check(paid.outcome === 'paid' && await paidTo(recipient) === 1_000_000n,
    'a note withdraws by its own terms, which its factory made, past a list that names its pool otherwise');
}

// ---- an indexer's list, as the app lists pools ----
// Categories and assets are read in lowercase, as the chain names them. An older note is looked up by
// its pool's id first, so an id that could be read as another pool's category, or that is no name at
// all, is not taken from an indexer, nor served from a deployment.
{
  const deployment = { network: 'chipnet', fulcrumUrl: 'http://reader.invalid', factories: { bch: factory }, pools: [] };
  const token = { ...pool, id: 'ab'.repeat(32), kind: 'token', category: 'AB'.repeat(32), asset: 'CD'.repeat(32), denomination: '100' };
  servers.indexed = [{ ...pool, id: pool.category.toUpperCase(), category: pool.category.toUpperCase() }, token];
  const listed = await indexerPools('http://indexer.invalid');
  check(listed.length === 2 && listed[0].category === pool.category && listed[0].id === pool.category && listed[1].asset === 'cd'.repeat(32),
    'an indexer\'s pools are read in lowercase');
  const served = await poolsToServe(deployment, listed, { reader });
  check(served.length === 1 && served[0].category === pool.category && served[0].id === pool.category, 'and served so');
  servers.indexed = [{ ...pool, id: 'ab'.repeat(32) }, { ...pool, id: 'bch"]' }, { ...pool, id: '' }];
  check((await indexerPools('http://indexer.invalid')).length === 0, 'an id that reads as another pool\'s category, or as no name, is not taken');
  check((await poolsToServe({ ...deployment, pools: [{ ...pool, id: 'ab'.repeat(32) } as any] }, [], { reader })).length === 0,
    'nor served from a deployment');
  servers.indexed = [];
}

// ---- an older note of a pool no factory made, through the script ----
// The notes of pools made before the factories are all in the older forms, which name no kind or
// asset, so neither a list nor the factories' events find their pools. --unlisted-pool recovers them
// once the kind, a token pool's asset, and for a note that names an id the category, are named.
{
  const paidTo = async (recipient: string) => (await provider.getUtxosForLockingBytecode(cashAddressLock(recipient)))
    .reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
  const recipientOf = (byte: number) => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(byte) }).address;
  const coin = await chain.fund(faucet.getAddress(), [], 300_000n);
  const fundingUtxo = (await faucet.getUtxos()).find((candidate: any) => candidate.txid === coin && candidate.vout === 0);
  const definition = { id: coin, kind: 'bch' as const, denomination: 1_000_000n, category: coin };
  await StatefulContract.deploy(poolArtifact('bch'), poolArguments(definition), {
    provider, fundingUtxo, funder: faucet.unlockP2PKH(), changeAddress: faucet.getAddress(), initialBalance: SEED_SATOSHIS,
  } as any);
  const outsider = new PoolClient(definition, new FulcrumProvider('chipnet', reader));
  const outsideHistory = new ChainHistory(reader, outsider);
  /** An older note, naming its pool as `named`, of a deposit made by hand and hashed. */
  const olderNote = async (named: string) => {
    const current = engine.newNote({ ...definition, denomination: '1000000' } as any, 'chipnet');
    await outsider.deposit(faucet, parseNote(current).commitment, await outsider.view(outsideHistory));
    await outsider.finish(await outsider.view(outsideHistory));
    return `bchnote-${named}-1000000-0x${current.slice(-124)}`;
  };
  const script = { network: 'chipnet', fulcrumUrl: 'http://reader.invalid', deployment: { pools: [], factories: { bch: factory } }, unlistedPool: true };

  const byCategory = await olderNote(coin);
  await rejects('an older note of a pool nothing here knows, with no kind', /KIND=bch/,
    () => withdrawNote({ ...script, note: byCategory, recipient: recipientOf(0x89) }));
  const recovered = await withdrawNote({ ...script, note: byCategory, recipient: recipientOf(0x89), kind: 'bch' });
  check(recovered.outcome === 'paid' && await paidTo(recipientOf(0x89)) === 1_000_000n,
    'with its kind, --unlisted-pool withdraws an older note of a pool no factory made');
  const byId = await olderNote('oldpool');
  const byIdRecovered = await withdrawNote({ ...script, note: byId, recipient: recipientOf(0x8a), kind: 'bch', category: coin });
  check(byIdRecovered.outcome === 'paid' && await paidTo(recipientOf(0x8a)) === 1_000_000n, 'and one naming its pool by an id, with its category');
  await rejects('a current note with terms named beside it', /names its pool's kind, category and asset itself/,
    () => withdrawNote({ ...script, note: engine.newNote({ ...definition, denomination: '1000000' } as any, 'chipnet'), recipient: recipientOf(0x8b), kind: 'bch' }));
}

// ---- a transaction a server cannot show ----
{
  const liar = new FulcrumProvider('chipnet', { broadcast: async () => 'ab'.repeat(32), call: async () => 1 } as any);
  await rejects('a server that answers for another transaction', /another transaction/, () => liar.sendRawTransaction('00'));
  const hanging = new FulcrumProvider('chipnet', { broadcast: async (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse()), call: () => new Promise(() => {}) } as any);
  const started = Date.now();
  await rejects('a server that never shows what it took', /cannot show it/, () => hanging.sendRawTransaction('00'));
  check(Date.now() - started < 20_000, 'is given up on in seconds');
}

rmSync(scratch, { recursive: true, force: true });
finish();
process.exit(0);
