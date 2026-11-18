// The pool factories, BchPoolDeployer and TokenPoolDeployer: every pool is made through one,
// and each refuses a second pool of an amount (and, for tokens, of an asset) on chain. A pool's
// category is the txid of a prep transaction that pays a one-shot coin to the factory's
// `Deploy<C>`, so the prep comes first and the factory's `create` spends its coin.
//
// The BCH factory remembers its amounts as a mask, one bit per exponent. The token factory
// keeps the root of a 128-level sparse tree whose slot is sha256(asset || exponent) and whose
// leaf is the pool's category; a creation proves its slot empty, so the creator needs the tree,
// which its `PoolCreated` events rebuild and the root checks.
import {
  ContractFactory, buildDeployerPreps, genesisOutpointKey, getDataNftAddress, getEventNftAddress,
  releaseGenesisOutpoint, tryParseEventCommitment,
} from '@solidcash/solidcash/stateful';
import { Contract } from '@solidcash/solidcash';
import bchPoolDeployer from '../../contracts/artifacts/solidcash/BchPoolDeployer.json';
import tokenPoolDeployer from '../../contracts/artifacts/solidcash/TokenPoolDeployer.json';
import bchPool from '../../contracts/artifacts/solidcash/BchPool.json';
import tokenPool from '../../contracts/artifacts/solidcash/TokenPool.json';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin, sha256 } from './libauth';
import { wholeHistory, type FulcrumFirstUse, type FulcrumUtxo } from './fulcrum';
import { headOf, lineage, readTransaction, type Decoded } from './lineage';
import { SparseTree } from './sparse-tree';
import { Notice } from './notice';
import type { PoolKind } from './pools';

export const REGISTRY_LEVELS = 128;

const FACTORIES = {
  bch: { artifact: bchPoolDeployer as any, child: bchPool as any, childName: 'BchPool' },
  token: { artifact: tokenPoolDeployer as any, child: tokenPool as any, childName: 'TokenPool' },
} as const;

export const factoryArtifact = (kind: PoolKind): any => FACTORIES[kind].artifact;
export const factoryChildName = (kind: PoolKind): string => FACTORIES[kind].childName;
/** The lock of the one-shot coin a prep pays, which the factory's `create` spends. */
export const deployerCoinLock = (kind: PoolKind): string => FACTORIES[kind].artifact.childDeployers[FACTORIES[kind].childName].lockingBytecode;
/** What that coin holds, in satoshis: lost to its payer if no creation spends it. */
export const deployerCoinValue = (kind: PoolKind): bigint => BigInt(FACTORIES[kind].artifact.childDeployers[FACTORIES[kind].childName].coinValue);

const lockOf = (address: string): Uint8Array => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
};

/** The factory's contract, for addresses that do not depend on its category. */
const factoryContract = (kind: PoolKind, network: string): any => new Contract(
  factoryArtifact(kind), [], { provider: { network } as any, addressType: 'p2sh32' },
);
/** The factory of category `factoryCategory`, whose master's lock holds that category, as SolidCash builds it. */
const factoryAt = (kind: PoolKind, factoryCategory: string, network: string): any => (
  factoryContract(kind, network).withCategory(hexToBin(factoryCategory)));

/** The address a factory's `PoolCreated` events are paid to: an NFT of its own category there. */
export const poolCreatedAddress = (kind: PoolKind, factoryCategory: string, network: string): string => (
  getEventNftAddress(factoryContract(kind, network), factoryCategory, 'PoolCreated'));
export const poolCreatedLock = (kind: PoolKind, factoryCategory: string, network: string): Uint8Array => (
  lockOf(poolCreatedAddress(kind, factoryCategory, network)));

export interface PoolCreated {
  category: string;
  exponent: number;
  asset?: string;
  /** The transaction the event was read from: its creation, where the factory minted it. */
  txid?: string;
}

/** A `PoolCreated` commitment, or undefined for anything else. */
export function parsePoolCreated(kind: PoolKind, commitment: Uint8Array | string): PoolCreated | undefined {
  const event = factoryArtifact(kind).events.find((entry: { name: string }) => entry.name === 'PoolCreated');
  const hex = typeof commitment === 'string' ? commitment : binToHex(commitment);
  let values: Record<string, unknown> | null = null;
  try {
    values = tryParseEventCommitment(hex, event) as Record<string, unknown> | null;
  } catch {
    return undefined;
  }
  if (!values || !(values.category instanceof Uint8Array) || values.category.length !== 32) return undefined;
  const exponent = Number(values.exponent);
  if (!Number.isInteger(exponent)) return undefined;
  const created: PoolCreated = { category: binToHex(values.category), exponent };
  if (kind === 'token') {
    if (!(values.asset instanceof Uint8Array) || values.asset.length !== 32) return undefined;
    created.asset = binToHex(values.asset);
  }
  return created;
}

/**
 * The token factory's slot for an asset and amount: sha256(asset || exponent), as `create` packs
 * them, the uint8 exponent in two bytes, little-endian (a VM number of up to 255 needs its sign byte).
 */
export const registryKey = (asset: string, exponent: number): Uint8Array => (
  sha256.hash(Uint8Array.from([...hexToBin(asset), exponent & 0xff, exponent >> 8])));

/** The token factory's empty tree: its walk halves the key from the leaf up. */
export const emptyRegistry = (): SparseTree => new SparseTree(REGISTRY_LEVELS, [], 'leaf');

/** The token factory's tree, from the pools its `PoolCreated` history names. */
export function registryTree(created: PoolCreated[]): SparseTree {
  let tree = emptyRegistry();
  for (const pool of created) tree = tree.with({ key: registryKey(pool.asset!, pool.exponent), leaf: hexToBin(pool.category) });
  return tree;
}

/** A slot's siblings as `create` takes them: one run of 32-byte words, leaf first. */
export const registryPath = (tree: SparseTree, key: Uint8Array): Uint8Array => Uint8Array.from(tree.path(key).flatMap((word) => [...word]));

/** The exponents the BCH factory's `made` holds. */
export const madeExponents = (made: bigint): number[] => {
  const out: number[] = [];
  for (let exponent = 0, rest = made; rest > 0n; exponent += 1, rest >>= 1n) if (rest & 1n) out.push(exponent);
  return out;
};

/** Deploy a factory: an ordinary genesis, whose funding coin's txid becomes its category. */
export async function deployFactory(kind: PoolKind, signer: any, options: Record<string, unknown> = {}): Promise<any> {
  return new ContractFactory(factoryArtifact(kind), signer).deploy(options as any);
}

/** The factory at `category`, connected to `runner` (a signer, or a provider) and ready to create. */
export async function connectFactory(kind: PoolKind, category: string, runner: any): Promise<any> {
  // Its master and state record never leave their locks, so a server that lists neither while the
  // lock has a history is past its limit (FulcrumProvider.mustShow).
  const provider = runner?.provider ?? runner;
  if (typeof provider?.mustShow === 'function') {
    const own = category.toLowerCase();
    const holds = (capability: string) => (coins: FulcrumUtxo[]) => coins.some((coin) => (
      coin.token_data?.category === own && coin.token_data.nft?.capability === capability));
    const [master, record] = factoryCoinLocks(kind, own, provider.network);
    provider.mustShow(master, holds('minting'));
    provider.mustShow(record, holds('mutable'));
  }
  const factory: any = await new ContractFactory(factoryArtifact(kind), runner).attach(category);
  factory.registerChild(FACTORIES[kind].child);
  return factory;
}

export interface ChainReader {
  history(scripthash: string, fromHeight?: number): Promise<Array<{ tx_hash: string; height?: number }>>;
  transaction(txid: string): Promise<unknown>;
  /** Fulcrum 1.9.6 and later: a lock's first transaction, which no history limit hides. */
  firstUse?(scripthash: string): Promise<FulcrumFirstUse | null>;
  /** The coins at a lock, from which a contract's own transactions lead back by txid. */
  listUnspent?(scripthash: string): Promise<FulcrumUtxo[]>;
  /** A transaction's height, 0 in the mempool. */
  transactionHeight?(txid: string): Promise<number>;
  /** A lock's transactions in the mempool, which Fulcrum counts apart from the rest of its history. */
  mempool?(scripthash: string): Promise<Array<{ tx_hash: string; height?: number }>>;
}

/** The locks a factory's own coins sit at: its master's and its state record's. */
export const factoryCoinLocks = (kind: PoolKind, factoryCategory: string, network: string): Uint8Array[] => {
  const contract = factoryAt(kind, factoryCategory, network);
  return [lockOf(contract.address), lockOf(getDataNftAddress(contract, factoryCategory))];
};

/** What marks a factory's own `PoolCreated`: the lock of the factory's master and its event address, in hex. */
export interface FactoryMarks { kind: PoolKind; category: string; master: string; event: string }

export const factoryMarks = (kind: PoolKind, factoryCategory: string, network: string): FactoryMarks => ({
  kind,
  category: factoryCategory,
  master: binToHex(lockOf(factoryAt(kind, factoryCategory, network).address)),
  event: binToHex(poolCreatedLock(kind, factoryCategory, network)),
});

type Output = Decoded['outputs'][number];

/**
 * The `PoolCreated` at output `at + 2`, if output `at` is the factory's master. That is where the
 * factory's `create` writes its event: its master, its state record, the event, then the pool's
 * master. Only the factory's own code moves its master, and `create` refuses any other output of
 * the factory's category, so since the factory's genesis every NFT of its category has been a
 * creation's own event, in that place. An event is still read only there, not wherever an NFT of
 * the category sits at the event address: SolidCash 0.51.1's own count of a contract's outputs
 * passes over an NFT at a bare OP_1 lock, and it is the factory's refusal alone that keeps a
 * creation from minting one there that names any pool, for anyone to move to the event address.
 */
export function createdAt(marks: FactoryMarks, outputs: readonly Output[], at: number): PoolCreated | undefined {
  const master = outputs[at];
  const event = outputs[at + 2];
  const ofFactory = (output: Output | undefined, capability: string) => output?.token?.nft?.capability === capability
    && binToHex(output.token.category) === marks.category;
  if (!ofFactory(master, 'minting') || binToHex(master.lockingBytecode) !== marks.master) return undefined;
  if (!ofFactory(event, 'none') || binToHex(event.lockingBytecode) !== marks.event) return undefined;
  return parsePoolCreated(marks.kind, event.token!.nft!.commitment);
}

/** The `PoolCreated` events a transaction holds where the factory's `create` writes them (createdAt). */
export function poolsCreatedIn(marks: FactoryMarks, transaction: Decoded, txid: string): PoolCreated[] {
  const found: PoolCreated[] = [];
  transaction.outputs.forEach((_, at) => {
    const created = createdAt(marks, transaction.outputs, at);
    if (created) found.push({ ...created, txid });
  });
  return found;
}

/** The first event naming each pool, should a reader be shown one twice. */
export const firstOfEach = (events: PoolCreated[]): PoolCreated[] => {
  const pools = new Map<string, PoolCreated>();
  for (const event of events) if (!pools.has(event.category)) pools.set(event.category, event);
  return [...pools.values()];
};

/** A factory's own chain: every pool it made, oldest first, each from its creation, and its genesis. */
export interface FactoryLineage {
  creations: Array<PoolCreated & { txid: string }>;
  genesis: string;
}

/**
 * A factory's own transactions, read by txid from the one that holds its master now back to its
 * genesis (lineage.ts), and what they hold. Every `create` moves the master and writes its pool's
 * `PoolCreated` two outputs after it, so every pool the factory made is on the way, and nobody
 * can pad the walk past a server's limit as they can pad the event address's history. Undefined
 * when the server shows neither the master nor the state record.
 */
export async function factoryLineage(reader: ChainReader, kind: PoolKind, factoryCategory: string, network: string): Promise<FactoryLineage | undefined> {
  const head = await headOf(reader, factoryCategory, factoryCoinLocks(kind, factoryCategory, network));
  if (head === undefined) return undefined;
  const marks = factoryMarks(kind, factoryCategory, network);
  const newestFirst: PoolCreated[][] = [];
  let genesis = head;
  for await (const link of lineage(reader, factoryCategory, head)) {
    newestFirst.push(poolsCreatedIn(marks, link.transaction, link.txid));
    genesis = link.txid;
  }
  return { creations: firstOfEach(newestFirst.reverse().flat()) as FactoryLineage['creations'], genesis };
}

/**
 * The pools a factory made, oldest first, from a Fulcrum-like reader, each from the creation
 * that made it. They come from the factory's own chain where the server shows its coins
 * (factoryLineage), and else from the history of its event address, which a server cut short at
 * its limit refuses with HistoryLimit rather than answer with fewer pools. Either way an event
 * counts only where the factory's `create` writes it (createdAt). A list a server trims or pads
 * anyway gives the token factory another root, which `createThroughFactory` refuses.
 */
export async function factoryPools(reader: ChainReader, kind: PoolKind, factoryCategory: string, network: string): Promise<PoolCreated[]> {
  const walked = await factoryLineage(reader, kind, factoryCategory, network);
  if (walked) return walked.creations;
  const marks = factoryMarks(kind, factoryCategory, network);
  const scripthash = binToHex(sha256.hash(hexToBin(marks.event)).slice().reverse());
  const events: PoolCreated[] = [];
  for (const { tx_hash: txid } of await wholeHistory(reader, scripthash)) {
    // Its bytes must be the txid's, as a walk's are: a server could otherwise answer another
    // transaction of the factory's for a txid it lists.
    events.push(...poolsCreatedIn(marks, (await readTransaction(reader, txid)).transaction, txid));
  }
  return firstOfEach(events);
}

/**
 * Release the coins a prep reserved: its funding inputs, author coin and change coin. SolidCash
 * reserves them process-wide once the prep is built, and releases them itself only for preps it
 * built; preps handed to a creation stay reserved when it fails. This mirrors SolidCash's own
 * `releaseDeployerPrepReservations`, which `@solidcash/solidcash/stateful` does not export.
 */
function releasePrepReservations(preps: readonly any[]): void {
  for (const prep of preps) {
    const transaction = decodeTransaction(hexToBin(prep.transactionHex));
    if (typeof transaction !== 'string') {
      for (const input of transaction.inputs) {
        releaseGenesisOutpoint(genesisOutpointKey(binToHex(input.outpointTransactionHash), input.outpointIndex));
      }
    }
    releaseGenesisOutpoint(genesisOutpointKey(prep.authorCoin.txid, prep.authorCoin.vout));
    if (prep.changeCoin !== undefined) {
      releaseGenesisOutpoint(genesisOutpointKey(prep.changeCoin.txid, prep.changeCoin.vout));
    }
  }
}

/**
 * Preps that went out with a creation that then failed, by factory and wallet. A retry spends one
 * rather than build another, so its deployer coin, which only a creation can spend, is not stranded.
 * Its coins stay reserved until that retry succeeds or the page reloads.
 */
const sentPreps = new Map<string, any[]>();
const sentKey = (kind: PoolKind, factoryCategory: string | undefined, ownLock: Uint8Array): string => (
  `${kind}:${factoryCategory?.toLowerCase() ?? ''}:${binToHex(ownLock)}`);

/** Whether a creation through this factory from this wallet would spend a prep that already went out. */
export const hasSentPrep = (kind: PoolKind, factoryCategory: string, address: string): boolean => (
  sentPreps.has(sentKey(kind, factoryCategory, lockOf(address))));

/**
 * Ready preps that went out with a creation that failed for a retry. One the server knows is not
 * sent again; one it does not is sent again, as it was signed. If its deployer coin is spent already,
 * by the earlier creation after all or by anyone, the retry cannot spend it: the preps are forgotten,
 * their coins freed, and the person told.
 */
async function resumePreps(provider: any, kind: PoolKind, preps: any[], forget: () => void): Promise<void> {
  for (const prep of preps) {
    const known = await provider.getRawTransaction(prep.category).then(() => true, () => false);
    if (known) {
      const coins = await provider.getUtxosForLockingBytecode(hexToBin(deployerCoinLock(kind)));
      if (!coins.some((coin: any) => coin.txid === prep.deployerCoin.txid && coin.vout === prep.deployerCoin.vout)) {
        forget();
        releasePrepReservations(preps);
        throw new Notice('An earlier attempt to create this pool may have gone through. Refresh the pools, and try again if it is not there.');
      }
    }
    prep.broadcast = known;
  }
}

export interface CreateThroughFactory {
  kind: PoolKind;
  exponent: number;
  asset?: string;
  /** The factory's pools so far, from its `PoolCreated` history: a token creation proves its slot empty. */
  created?: PoolCreated[];
  /** The factory's category, which a prep that went out for a failed creation is kept under. */
  factoryCategory?: string;
  /** The plain coin a new prep spends. None is needed while a prep that went out is waiting to be spent. */
  prepCoin?: any;
  /** For a token pool: a coin of exactly one unit of the asset and no NFT, which opens its token container. */
  tokenSeed?: any;
}

/**
 * Create one pool through `factory`. Everything the factory would refuse is checked first, so a
 * refused creation spends and reserves nothing. Then the prep is built and signed, since the
 * pool's category is its txid, and the SDK sends it before the creation. Returns the category. A
 * prep that went out with an earlier creation through this factory from this wallet, which then
 * failed, is spent in place of a new one.
 */
export async function createThroughFactory(
  factory: any, provider: any, signer: any, request: CreateThroughFactory,
  onStep?: (step: 'prep' | 'create') => void,
): Promise<string> {
  const { kind, exponent } = request;
  const ownLock = lockOf(signer.getAddress());
  let args: any[];
  if (kind === 'bch') {
    if (madeExponents((await factory.getState()).made).includes(exponent)) throw new Notice('That amount already has a pool.');
    args = [BigInt(exponent)];
  } else {
    if (!request.asset || !request.tokenSeed) throw new Error('A token pool needs its asset and a one-unit coin of it.');
    const tree = registryTree(request.created ?? []);
    // A list of the factory's pools that leaves one out, or adds one, gives another root.
    if (binToHex((await factory.getState()).registered) !== binToHex(tree.root())) {
      throw new Notice('The server\'s list of this factory\'s pools does not match the factory. Try another server.');
    }
    const key = registryKey(request.asset, exponent);
    if (tree.at(key)) throw new Notice('That asset and amount already have a pool.');
    args = [BigInt(exponent), hexToBin(request.asset), registryPath(tree, key)];
  }
  const kept = sentKey(kind, request.factoryCategory, ownLock);
  let preps = sentPreps.get(kept);
  const resumed = preps !== undefined;
  if (preps !== undefined) {
    await resumePreps(provider, kind, preps, () => sentPreps.delete(kept));
  } else {
    if (!request.prepCoin) throw new Error('A creation needs the plain coin its prep spends.');
    // Building the prep signs it, and the creation is signed in its `deploy`. An external wallet
    // reads its prompt when an unlocker is made, so each is made once its step is named.
    onStep?.('prep');
    // SolidCash reserves the prep's coins only once the prep is built and signed, so a wallet that
    // refuses the prep leaves nothing reserved.
    ({ preps } = await buildDeployerPreps({
      provider,
      children: [{ contractName: factoryChildName(kind), deployer: factoryArtifact(kind).childDeployers[factoryChildName(kind)] }],
      fundingUtxos: [request.prepCoin],
      authorSigner: signer.unlockP2PKH(),
      authorLockingBytecode: ownLock,
      changeLockingBytecode: ownLock,
    } as any));
  }
  const used = preps!;
  onStep?.('create');
  // What left the page is what the providers the creation sends through tried to send, whatever a
  // server answered: the page's FulcrumProvider counts each attempt before the server has said
  // anything. SolidCash marks a prep broadcast only once its send succeeded, so a prep a server took
  // and then failed to show would read as unsent.
  const counting = [...new Set([provider, signer?.provider])].filter((runner: any) => typeof runner?.broadcasts === 'number');
  const sentBefore = counting.map((runner: any) => runner.broadcasts as number);
  const funder = signer.unlockP2PKH();
  try {
    const result = await factory.create(...args).deploy({
      deployerPreps: used,
      funder,
      changeAddress: signer.getAddress(),
      ...(kind === 'token' ? { childTokenContainers: [{ utxo: request.tokenSeed, unlocker: funder }] } : {}),
    });
    sentPreps.delete(kept);
    return result.childCategoryId as string;
  } catch (error) {
    // A creation that failed before anything left the page leaves the wallet's coins as they were,
    // so a retry can use them, as SolidCash does for preps it built. Once a prep may have gone out,
    // whatever a server said, its coins belong to this creation and stay reserved, and the prep is
    // kept for the retry: a new prep would sign a second spend of a coin that may already be spent,
    // and strand the first prep's deployer coin. A provider that does not count is taken at
    // SolidCash's word for its preps. A prep kept from before stays kept.
    if (!resumed) {
      const nothingLeft = counting.length > 0
        ? counting.every((runner: any, index) => runner.broadcasts === sentBefore[index])
        : used.every((prep: any) => !prep.broadcast);
      if (nothingLeft) releasePrepReservations(used);
      else sentPreps.set(kept, used);
    }
    throw error;
  }
}
