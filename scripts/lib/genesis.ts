// What a pool's and a factory's genesis may hold. After it the contracts keep the count of the
// master and state record, so they are only as good as the transaction that made them: a second
// master minted there could later move to the lock and act for the contract, with a state of its
// own. The genesis spends the deployer's own coin, so no contract sees it, and reading it is the
// only check.
//
// Every pool is made through a factory (BchPoolDeployer, TokenPoolDeployer). Its category is the
// txid of a prep transaction whose output 0 is a one-shot deployer coin, at the lock the factory's
// artifact names, and the creation is the transaction that spends that coin. The creation runs
// the factory's `create`, which mints a `PoolCreated` event of the factory's own category, so a
// pool names the factory that made it, and the factory refuses a second pool of an amount (and,
// for tokens, of an asset). That coin's covenant also lets a pool be born with no factory in the
// transaction, so the check asks for the factory's master beside the event, where `create` puts
// it. The creation holds no BCMR identity, so the pool's state record is its category's only
// mutable NFT. It also opens the pool's coins: one plain satoshi coin and, in a token pool, one
// coin of the asset. A call cannot open either, and each keeps its satoshis for good while the
// dust floor rises with what it holds, so one opened too small could stop the pool.
//
// A factory is made by an ordinary genesis: its master, its state record, at output 0 SolidCash's
// BCMR identity, a mutable NFT that is safe because its covenant can only send it back to itself,
// frozen or burned, and SolidCash's SCID v1 anchor, an immutable NFT whose commitment names the
// deployer. An immutable NFT never changes, and that commitment is no `PoolCreated`, nor is it
// minted in a pool's creation, which is where a pool's event must be. A second minting NFT kept
// there could mint any `PoolCreated`, so the genesis is checked once, as a pool's is.
//
// A genesis counts as soon as a server shows it, in the mempool or in a block: the user decided on
// 2026-11-18 that nothing waits for blocks to bury it. Until they do, whoever spent its coin can
// still spend that coin another way, under the same category. A pool's deployer coin pins its
// replacement as it pins the creation, but a factory's genesis spends its deployer's own coin, so
// only that deployer could put a second master in one.
//
// Finding a genesis reads no history that anyone can pad, where it can help it (genesisOf). The
// lock a genesis spends from is a pool kind's one deployer-coin lock, which every creation of
// that kind shares, or a deployer's own address, and past Fulcrum's `max_history` a server
// answers that lock's history as if it had none. That is HistoryLimit, thrown, and never a
// problem of the pool: another server can answer.
import { authheadLockingBytecode } from '@solidcash/solidcash/bcmr';
import { buildInitialStateCommitments } from '@solidcash/utils';
import { StatefulContract, getDataNftAddress } from '@solidcash/solidcash/stateful';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import {
  HistoryLimit, bytesToHex, scripthashOfLock, type FulcrumFirstUse, type FulcrumUtxo,
} from '../../web/src/fulcrum';
import { sha256 } from '../../web/src/libauth';
import { OtherBytes, readTransaction, type Decoded } from '../../web/src/lineage';
import { MimcTree } from '../../web/src/mimc';
import { NullifierTree } from '../../web/src/nullifiers';
import { LEVELS, RECENT_ROOTS, le32, spendableCoins, type PoolClient } from '../../web/src/pool-client';
import { SEED_SATOSHIS, SEED_TOKENS, exponentOf, type PoolKind } from '../../web/src/pools';
import {
  createdAt, deployerCoinLock, emptyRegistry, factoryArtifact, factoryCoinLocks, factoryLineage, factoryMarks,
} from '../../web/src/factory';

export interface ChainReader {
  history(scripthash: string, fromHeight?: number): Promise<Array<{ tx_hash: string; height?: number }>>;
  transaction(txid: string): Promise<unknown>;
  /** Fulcrum 1.9.6 and later: a lock's first transaction, which no history limit hides. */
  firstUse?(scripthash: string): Promise<FulcrumFirstUse | null>;
  /** The coins at a lock, from which a contract's own transactions lead back by txid. */
  listUnspent?(scripthash: string): Promise<FulcrumUtxo[]>;
  /** A transaction's height, 0 in the mempool. */
  transactionHeight?(txid: string): Promise<number>;
}

const lockOf = (address: string) => (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
const lockHex = (address: string) => bytesToHex(lockOf(address));
const packed = (values: bigint[]) => Uint8Array.from(Buffer.concat(values.map(le32)));

/** The state record of a pool nobody has used. */
function emptyState(client: PoolClient): string {
  const tree = new MimcTree(LEVELS);
  const [commitment] = buildInitialStateCommitments(client.contract.inner.artifact.stateLayout, {
    recentRoots: sha256.hash(packed(tree.recentRoots(RECENT_ROOTS))),
    treeState: sha256.hash(packed(tree.frontier())),
    nullifierState: new NullifierTree([]).root(),
    nextIndex: 0n,
    stage: 0n,
    live: 0n,
  });
  return commitment.replace(/^0x/, '').toLowerCase();
}

type Output = Decoded['outputs'][number];

/** A transaction from the server, refused unless its bytes are the txid's. */
const reading = (reader: ChainReader) => async (txid: string): Promise<Decoded> => (await readTransaction(reader, txid)).transaction;

/**
 * Where to look for a genesis before the history of the lock it spends from. Each only says where
 * to look: a transaction counts only if its bytes are its txid's and it spends output 0 of the
 * category's own transaction, which one transaction alone can do. A lead the server has no
 * transaction for leads nowhere, and the next is asked.
 */
interface Leads {
  /** A transaction a caller read already: a pool's `PoolCreated` is minted in its creation. */
  named?: string;
  /**
   * Locks the genesis pays, and whose address follows from the category, so nobody could pay
   * them before it existed. The first transaction of each is read with no history limit, and is
   * the genesis unless someone paid the lock between the category's transaction and its genesis.
   */
  firstAt?: Uint8Array[];
  /** Transactions a walk by txid found (lineage.ts), which no padded history stands in the way of. */
  walked?: () => Promise<string[]>;
}

/** The OP_RETURN that starts an output nothing can spend. */
const OP_RETURN = 0x6a;

/**
 * The transaction that spends output 0 of `category`'s own transaction, which mints the
 * category. Problems instead when there is none, or the server lies.
 *
 * It looks at `leads` first, and only then at the history of output 0's lock, which anyone can
 * pad, from the category's own transaction's height. That transaction pays the lock, so a
 * history without it is one the server cut short at its limit: HistoryLimit, thrown.
 */
async function genesisOf(reader: ChainReader, category: string, leads: Leads = {}): Promise<
  { genesis: Decoded; named: Output } | { problems: string[] }> {
  const read = reading(reader);
  let named: Output;
  try {
    [named] = (await read(category)).outputs;
  } catch (error) {
    return { problems: [String((error as Error).message)] };
  }
  if (!named) return { problems: ['the transaction that names the category has no output 0'] };
  const none = { problems: ['no transaction spends the coin that names the category'] };
  if (named.lockingBytecode[0] === OP_RETURN) return none;

  const tried = new Set<string>([category]);
  const heightOf = async (txid: string): Promise<number | undefined> => (
    reader.transactionHeight ? reader.transactionHeight(txid).catch(() => undefined) : undefined);
  /** The genesis if `txid` is it, problems if the server lies about it, or undefined. */
  const tryOne = async (txid: string, height?: number) => {
    if (tried.has(txid)) return undefined;
    let candidate: Decoded;
    try {
      candidate = await read(txid);
    } catch (error) {
      // Other bytes under a txid are a lie. A transaction the server does not have is no lead:
      // whoever relays or mines a creation can re-sign it under another txid, and a creation in
      // the mempool can be replaced or dropped, after a caller read where its event was.
      if (error instanceof OtherBytes) return { problems: [String(error.message)] };
      return undefined;
    }
    if (!candidate.inputs.some((input) => input.outpointIndex === 0 && bytesToHex(input.outpointTransactionHash) === category)) {
      tried.add(txid);
      return undefined;
    }
    const at = height ?? await heightOf(txid);
    // A lead without a height is left to the history below, which has one.
    if (at === undefined) return undefined;
    tried.add(txid);
    return { genesis: candidate, named };
  };

  if (leads.named) {
    const found = await tryOne(leads.named);
    if (found) return found;
  }
  for (const lock of reader.firstUse ? leads.firstAt ?? [] : []) {
    const first = await reader.firstUse!(scripthashOfLock(lock)).catch(() => null);
    const found = first ? await tryOne(first.tx_hash, first.height) : undefined;
    if (found) return found;
  }
  for (const txid of leads.walked ? await leads.walked().catch(() => [] as string[]) : []) {
    const found = await tryOne(txid);
    if (found) return found;
  }

  // The genesis cannot come before the category's own transaction, so the history is asked from
  // that transaction's height where the server can say it: what lies before is not sent, though
  // Fulcrum still counts it against its limit.
  const scripthash = scripthashOfLock(named.lockingBytecode);
  const from = (await heightOf(category)) ?? 0;
  const history = from > 0
    ? await reader.history(scripthash, from).catch(() => reader.history(scripthash))
    : await reader.history(scripthash);
  if (!history.some((entry) => entry.tx_hash === category)) throw new HistoryLimit(scripthash);
  for (const { tx_hash: txid, height = 0 } of history) {
    if (from > 0 && height > 0 && height < from) continue;
    const found = await tryOne(txid, height);
    if (found) return found;
  }
  return none;
}

const tooSmall = (problems: string[], name: string, output?: { valueSatoshis: bigint }) => {
  if (output && output.valueSatoshis < SEED_SATOSHIS) problems.push(`the ${name} holds ${output.valueSatoshis} sat, under ${SEED_SATOSHIS}`);
};

/**
 * What is wrong with a pool's creation through the factory of category `creator`. Nothing, for
 * an honest one: the factory's `create` made it, so its `PoolCreated` names it.
 *
 * `creation` is where a caller saw the pool's `PoolCreated`, which is in its creation. Without it
 * the creation is looked for at the first transaction of the pool's own coins' locks, then in
 * the factory's own chain, read by txid, and only then in the deployer-coin lock's history, which
 * every pool of the kind shares and anyone can pad. A server that cut that history short throws
 * HistoryLimit.
 */
export async function genesisProblems(
  client: PoolClient, reader: ChainReader, creator: string, { creation }: { creation?: string } = {},
): Promise<string[]> {
  const { category, kind } = client.pool;
  const network = client.provider.network;
  const found = await genesisOf(reader, category, {
    named: creation,
    firstAt: [
      lockOf(getDataNftAddress(client.contract.inner, category)),
      lockOf(client.contract.getSatoshiContainerAddress()),
      ...(kind === 'token' ? [lockOf(client.contract.tokens[client.pool.asset!].address)] : []),
    ],
    walked: async () => ((await factoryLineage(reader, kind, creator, network))?.creations ?? [])
      .filter((created) => created.category === category).map((created) => created.txid),
  });
  if ('problems' in found) return found.problems;
  const { genesis, named } = found;
  // A coin at that lock is spent only by a genesis its covenant (`Deploy<C>`) pins, which the
  // checks below read. The covenant does not ask for a factory: whether one ran is the last check's.
  if (bytesToHex(named.lockingBytecode) !== deployerCoinLock(kind)) return ['the pool was not made through a factory'];

  const problems: string[] = [];
  const minted = genesis.outputs.filter((output) => output.token && bytesToHex(output.token.category) === category);
  const master = minted.filter((output) => output.token!.nft?.capability === 'minting');
  // A creation opens no identity, so every mutable NFT of the category is a state record.
  const state = minted.filter((output) => output.token!.nft?.capability === 'mutable');
  if (master.length !== 1) problems.push(`${master.length} minting NFTs, not 1`);
  if (state.length !== 1) problems.push(`${state.length} state records, not 1`);
  if (minted.length !== master.length + state.length) problems.push('another NFT or token of the category');
  if (minted.some((output) => output.token!.amount !== 0n)) problems.push('a fungible amount of the category');
  if (master[0] && bytesToHex(master[0].lockingBytecode) !== lockHex(client.contract.address)) {
    problems.push('the minting NFT is not at the pool\'s lock');
  }
  if (master[0]?.token!.nft!.commitment.length) problems.push('the master holds a commitment');
  tooSmall(problems, 'master', master[0]);
  tooSmall(problems, 'state record', state[0]);
  const outputsAt = (lock: string) => genesis.outputs.filter((output) => bytesToHex(output.lockingBytecode) === lock);
  const satoshiCoins = outputsAt(lockHex(client.contract.getSatoshiContainerAddress()));
  if (satoshiCoins.length !== 1) problems.push(`${satoshiCoins.length} satoshi coins, not 1`);
  if (satoshiCoins.some((output) => output.token)) problems.push('a token on the satoshi coin');
  tooSmall(problems, 'satoshi coin', satoshiCoins[0]);
  if (kind === 'token') {
    const asset = client.pool.asset!;
    const tokenCoins = outputsAt(lockHex(client.contract.tokens[asset].address));
    if (tokenCoins.length !== 1) problems.push(`${tokenCoins.length} token coins, not 1`);
    const [tokenCoin] = tokenCoins;
    if (tokenCoin) {
      if (!tokenCoin.token || bytesToHex(tokenCoin.token.category) !== asset) problems.push('the token coin does not hold the asset');
      // The chain takes a creation that opens the coin with more than one unit, and the pool asks
      // only that its coin hold at least the seed and what it owes, so more is a gift that stays in
      // the coin for good. Refusing it here would leave that asset and amount without a pool:
      // the factory makes only one.
      else if (tokenCoin.token.amount < SEED_TOKENS) problems.push(`the token coin holds ${tokenCoin.token.amount} units, under ${SEED_TOKENS}`);
      // `Deploy<C>` reads the coin's category as the asset's 32 bytes, which a mutable or minting
      // NFT would lengthen, and its commitment as empty, so the chain refuses either of those. An
      // immutable NFT with no commitment it cannot see: anyone holding one of the asset's NFTs can
      // add one beside the unit. No script sees it either, and the pool works with it on its coin,
      // so it is taken, as the chain takes it, and the factory's amount is not left without a pool.
      const nft = tokenCoin.token?.nft;
      if (nft && (nft.capability !== 'none' || nft.commitment.length > 0)) problems.push('an NFT with a capability or a commitment on the token coin');
      tooSmall(problems, 'token coin', tokenCoin);
    }
  }
  if (state[0]) {
    if (bytesToHex(state[0].lockingBytecode) !== lockHex(getDataNftAddress(client.contract.inner, category))) {
      problems.push('the state record is not at its lock');
    }
    if (bytesToHex(state[0].token!.nft!.commitment) !== emptyState(client)) {
      problems.push('the state record is not that of an empty pool');
    }
  }
  // The factory's `create` writes its master, its state record, the `PoolCreated` naming the pool
  // and the pool's master, in that order, and refuses any other output of its category. An NFT of
  // the factory's category at its event address proves nothing more: the deployer coin's covenant
  // lets a pool be born with no factory in the transaction. An event counts only two outputs
  // after the factory's own master, with this pool's master after it (createdAt). That master
  // moves only through the factory's code, and the factory's own genesis is
  // factoryGenesisProblems's to read.
  const marks = factoryMarks(kind, creator, client.provider.network);
  const poolMaster = lockHex(client.contract.address);
  const exponent = exponentOf(client.pool.denomination);
  const madeHere = (_: Output, at: number) => {
    const created = createdAt(marks, genesis.outputs, at);
    const next = genesis.outputs[at + 3];
    return created !== undefined && created.category === category && BigInt(created.exponent) === exponent
      && (kind === 'bch' || created.asset === client.pool.asset)
      && next?.token?.nft?.capability === 'minting' && bytesToHex(next.token.category) === category
      && bytesToHex(next.lockingBytecode) === poolMaster;
  };
  if (!genesis.outputs.some(madeHere)) problems.push(`no PoolCreated event of ${creator} in the genesis names this pool`);
  return problems;
}

/** "SCID" and version 1: the start of SolidCash's identity anchor. */
const SCID_V1 = '5343494401';

/** The state a factory starts with: no amount made, or the empty tree. */
function factoryStart(kind: PoolKind): string {
  const [commitment] = buildInitialStateCommitments(factoryArtifact(kind).stateLayout, kind === 'bch'
    ? { made: 0n }
    : { registered: emptyRegistry().root() });
  return commitment.replace(/^0x/, '').toLowerCase();
}

/**
 * What is wrong with the genesis of the factory of category `category`. Nothing, for an honest
 * one: one master at the factory's lock, one state record that has made nothing, the identity at
 * output 0, one SCID anchor, which `ContractFactory.deploy` writes for a deployment a signer makes,
 * as deploy-factories.ts makes it, and nothing else of the category.
 *
 * `genesis` is the genesis if a caller found it already, as a walk of the factory's chain does.
 * Without it the genesis is looked for at the first transaction of the factory's identity and
 * state record locks, then at the end of the factory's own chain, read by txid, and only then
 * in the history of the deployer's address. A server that cut that history short throws
 * HistoryLimit.
 */
export async function factoryGenesisProblems(
  kind: PoolKind, category: string, reader: ChainReader, provider: any, { genesis: known }: { genesis?: string } = {},
): Promise<string[]> {
  const found = await genesisOf(reader, category, {
    named: known,
    firstAt: [authheadLockingBytecode(category), factoryCoinLocks(kind, category, provider.network)[1]],
    walked: async () => {
      const walked = await factoryLineage(reader, kind, category, provider.network);
      return walked ? [walked.genesis] : [];
    },
  });
  if ('problems' in found) return found.problems;
  const { genesis } = found;
  const factory = new StatefulContract(category, factoryArtifact(kind), provider, { constructorArgs: [] } as any) as any;
  const problems: string[] = [];
  const minted = genesis.outputs.filter((output) => output.token && bytesToHex(output.token.category) === category);
  const master = minted.filter((output) => output.token!.nft?.capability === 'minting');
  const identityHex = bytesToHex(authheadLockingBytecode(category));
  const isIdentity = (output: Output) => bytesToHex(output.lockingBytecode) === identityHex;
  const mutable = minted.filter((output) => output.token!.nft?.capability === 'mutable');
  const identity = mutable.filter(isIdentity);
  const state = mutable.filter((output) => !isIdentity(output));
  const anchors = minted.filter((output) => output.token!.nft?.capability === 'none'
    && bytesToHex(output.token!.nft!.commitment).startsWith(SCID_V1));
  if (master.length !== 1) problems.push(`${master.length} minting NFTs, not 1`);
  if (state.length !== 1) problems.push(`${state.length} state records, not 1`);
  if (identity.length !== 1 || !isIdentity(genesis.outputs[0])) problems.push('the identity is not output 0 alone');
  if (anchors.length !== 1) problems.push(`${anchors.length} SCID anchors, not 1`);
  if (minted.length !== master.length + mutable.length + anchors.length) problems.push('another NFT or token of the category');
  if (minted.some((output) => output.token!.amount !== 0n)) problems.push('a fungible amount of the category');
  if (master[0] && bytesToHex(master[0].lockingBytecode) !== lockHex(factory.address)) problems.push('the minting NFT is not at the factory\'s lock');
  if (master[0]?.token!.nft!.commitment.length) problems.push('the master holds a commitment');
  if (state[0]) {
    if (bytesToHex(state[0].lockingBytecode) !== lockHex(getDataNftAddress(factory.inner, category))) problems.push('the state record is not at its lock');
    if (bytesToHex(state[0].token!.nft!.commitment) !== factoryStart(kind)) problems.push('the state record is not that of a new factory');
  }
  return problems;
}

const VERIFIER_COINS = 3;
const WORKER_COINS = 10;

/**
 * What a pool holds today, and what is wrong with it. Nothing, for an honest one. The hashing
 * and verifier coins are every pool's, so their counts are the shared ones. `creation` is as
 * genesisProblems takes it.
 */
export async function poolReport(client: PoolClient, reader: ChainReader, creator: string, leads: { creation?: string } = {}) {
  const { provider } = client;
  const state = await client.contract.getState();
  // Anyone can pay a coin to these locks, so only the ones the client would spend count, and
  // each count is a minimum. An exact one would let anyone fail this check with a single coin.
  const verifierCoins = spendableCoins(await provider.getUtxosForLockingBytecode(client.verifier.lock)).length;
  const workerCoins = spendableCoins(await provider.getUtxosForLockingBytecode(client.workerLock)).length;
  const satoshiCoins = (await provider.getUtxos(client.contract.getSatoshiContainerAddress())).filter((coin: any) => !coin.token).length;
  const asset = client.pool.asset;
  const tokenCoins = asset === undefined ? 0 : (await provider.getUtxos(client.contract.tokens[asset].address))
    .filter((coin: any) => coin.token?.category === asset && coin.satoshis >= SEED_SATOSHIS).length;

  const problems = await genesisProblems(client, reader, creator, leads);
  if (verifierCoins < VERIFIER_COINS) problems.push(`${verifierCoins} verifier coins, under ${VERIFIER_COINS}`);
  if (workerCoins < WORKER_COINS) problems.push(`${workerCoins} hashing coins, under ${WORKER_COINS}`);
  if (satoshiCoins < 1) problems.push('no satoshi coin');
  if (asset !== undefined && tokenCoins < 1) problems.push('no token coin');
  return { problems, verifierCoins, workerCoins, satoshiCoins, tokenCoins, notes: Number(state.nextIndex), stage: Number(state.stage) };
}
