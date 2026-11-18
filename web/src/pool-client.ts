// One pool, driven through SolidCash: the same code in the browser, the tests and the
// deployment script. Every transaction here is built by the SDK; this module only
// says what each one holds. The chain is the authority: a view of a pool is refused
// unless it reproduces the digests the pool's state record holds.
import { Contract, TransactionBuilder } from '@solidcash/solidcash';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import notePool from '../../contracts/artifacts/solidcash/BchPool.json';
import tokenBchPool from '../../contracts/artifacts/solidcash/TokenPool.json';
import mimcHash from '../../contracts/artifacts/solidcash/MimcHash.json';
import {
  binToHex, cashAddressToLockingBytecode, decodeTransaction, hash256, hexToBin, sha256,
} from './libauth';
import { MimcTree, mimcSponge } from './mimc';
import { NullifierTree } from './nullifiers';
import {
  COIN_SATOSHIS, exponentOf, finishFeeOf, withdrawFeeOf, type PoolKind,
} from './pools';
import { Notice } from './notice';
import type { FulcrumUtxo } from './fulcrum';
import { statementFits, verifierProgram, verifierUnlockings, type VerifierProgram } from './verifier';

export const LEVELS = 20;
export const STEP_LEVELS = 10;
/** A deposit pays for its own hashing by size, and a standard transaction is at most 100,000 B. */
const DEPOSIT_FEE_CAP = 110_000n;
/** About 80 ms of hashing between chances for the page to breathe. */
const TREE_BATCH = 128;
export const RECENT_ROOTS = 8;
const VERIFIER_COINS = 3;

/**
 * A coin that pays what a pool's prepaid fee falls short of, should nodes ever relay only
 * more than it. A finish takes it as its last input and a withdrawal just before the
 * verifier's coins, which is where both pools accept one; its change goes back beside it.
 */
export interface FeeTopUp {
  coin: any;
  unlocker: any;
  /** The locking bytecode the change goes back to. */
  change: Uint8Array;
  /** What it adds to the fee. Change under the dust limit goes to the fee too. */
  amount: bigint;
}
/** Change below this is dust no node relays, so it stays in the fee. */
const CHANGE_DUST = 546n;
/** The most a P2PKH coin and its change add: the input at ECDSA's longest signature, the output, a margin. */
const TOP_UP_BYTES = 149n + 34n + 8n;

/** A call's transaction as the SDK would send it: its size and what it pays the miner. */
export async function measure(call: any): Promise<{ size: bigint; fee: bigint }> {
  const builder = await call.build();
  return { size: builder.getTransactionSize(), fee: builder.calculateTransactionFee().feeSats };
}

/**
 * What a top-up must add for a transaction to pay `floor` satoshis per 1,000 bytes, rounded up
 * as a node rounds it, or 0 when it pays that already. It counts the top-up's own bytes.
 */
export function shortfall({ size, fee }: { size: bigint; fee: bigint }, floor: bigint): bigint {
  const at = (bytes: bigint) => (bytes * floor + 999n) / 1000n;
  return fee >= at(size) ? 0n : at(size + TOP_UP_BYTES) - fee;
}

export interface PoolDefinition {
  id: string;
  kind: PoolKind;
  denomination: bigint;
  /** The pool's own master category, which its deployment's funding coin sets. */
  category: string;
  /** The CashToken a token pool holds. */
  asset?: string;
}

export interface DepositRecord { leafIndex: number; commitment: bigint }

/** Where a pool's history comes from. Fulcrum, an archive or a test: the view checks it either way. */
export interface PoolHistory {
  deposits(): Promise<DepositRecord[]>;
  /** Nullifier hashes in the contract's form: 32 bytes, little-endian. */
  withdrawals(): Promise<Uint8Array[]>;
}

export interface PoolView {
  state: { recentRoots: Uint8Array; treeState: Uint8Array; nullifierState: Uint8Array; nextIndex: bigint; stage: bigint; live: bigint };
  tree: MimcTree;
  nullifiers: NullifierTree;
  /** The commitment a deposit left half hashed, when `state.stage` is not 0. */
  pending?: bigint;
}

export const le32 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0, n = value; i < 32; i += 1, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
export const fromLe = (bytes: Uint8Array): bigint => bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const sha = (...parts: Uint8Array[]): Uint8Array => sha256.hash(concat(...parts));
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);
const packed = (values: bigint[]): Uint8Array => concat(...values.map(le32));
const lockOf = (address: string): Uint8Array => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
};
const byOutpoint = (a: { txid: string; vout: number }, b: { txid: string; vout: number }) => (
  a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1);
/** Anyone can pay a coin to the hashing or the verifier lock. These are the ones a transaction can spend. */
export const spendableCoins = (coins: any[]) => coins.filter((coin) => !coin.token && coin.satoshis >= COIN_SATOSHIS).sort(byOutpoint);
/**
 * The coins a provider lists at the hashing or the verifier lock, which every pool shares. A
 * server that lists none there while the lock holds coins is past its limit: anyone can pay either
 * lock that many coins, and that would stop every pool's deposits or withdrawals on the server
 * with no error. FulcrumProvider refuses that as the server's limit; other providers have no limit.
 */
const sharedCoins = async (provider: any, lock: Uint8Array): Promise<any[]> => {
  const coins = await provider.getUtxosForLockingBytecode(lock);
  if (coins.length === 0) await provider.refuseHiddenCoins?.(lock);
  return coins;
};
/** Whether a server's listing holds an NFT of `category` with `capability`. */
const holdsNft = (category: string, capability: string) => (coins: FulcrumUtxo[]): boolean => coins.some((coin) => (
  coin.token_data?.category === category.toLowerCase() && coin.token_data.nft?.capability === capability));
/** A provider gives a confirmed coin's height, and 0 or less, or nothing, for one in a mempool. */
const isConfirmed = (coin: any): boolean => coin.blockHeight > 0;

/** The recipient as the proof names it: the first 31 bytes of the hash of its locking bytecode and a salt. */
export const recipientField = (lock: Uint8Array, salt: Uint8Array): bigint => fromLe(sha(lock, salt).subarray(0, 31));

/** A proof made for one recipient, ready to send. */
export interface WithdrawalProof { unlockings: Uint8Array[]; salt: Uint8Array; root: bigint }

const saltOf = (counter: number): Uint8Array => Uint8Array.of(counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff, counter >>> 24);

/** The first salt whose statement has a proof that fits the verifier's inputs. */
export function fittingSalt(root: bigint, nullifierHash: bigint, recipient: Uint8Array, fits: (statement: bigint[]) => boolean): Uint8Array {
  for (let counter = 0; counter < 1 << 16; counter += 1) {
    const salt = saltOf(counter);
    if (fits([root, nullifierHash, recipientField(recipient, salt)])) return salt;
  }
  throw new Notice('This note cannot pay this recipient. Try another address.');
}

/** What a deposit adds to the satoshi container: the note, its withdrawal and its `finish`. */
export const depositValue = (pool: Pick<PoolDefinition, 'kind' | 'denomination'>): bigint => (
  (pool.kind === 'bch' ? pool.denomination : 0n) + withdrawFeeOf(pool.kind) + finishFeeOf(pool.kind));

export interface HashStep { left: bigint; right: bigint; out: bigint }

/** The hashes of one half of a path, and the frontier and node it leaves. */
export function stepWitness(frontier: bigint[], node: bigint, leafIndex: number, step: 1 | 2, zeros: bigint[]) {
  const base = (step - 1) * STEP_LEVELS;
  const next = frontier.slice();
  const hashes: HashStep[] = [];
  let current = node;
  let index = leafIndex >> base;
  for (let level = base; level < base + STEP_LEVELS; level += 1) {
    const isLeft = (index & 1) === 0;
    if (isLeft) next[level] = current;
    const [left, right] = isLeft ? [current, zeros[level]] : [frontier[level], current];
    const out = mimcSponge([left, right]);
    hashes.push({ left, right, out });
    current = out;
    index >>= 1;
  }
  return { hashes, frontier: next, node: current };
}

export const poolArtifact = (kind: PoolKind): any => (kind === 'bch' ? notePool : tokenBchPool);

/**
 * The creation arguments that bind a pool to its amount, and a token pool to its asset. The
 * contract takes the amount as its exponent, so only a power of ten can be a pool's
 * denomination. The hashing and verifier locks are pinned in the pool's code, the same for
 * every pool.
 */
export function poolArguments(pool: Pick<PoolDefinition, 'kind' | 'denomination' | 'asset'>): any[] {
  const exponent = exponentOf(pool.denomination);
  return pool.kind === 'bch' ? [exponent] : [exponent, hexToBin(pool.asset!)];
}

/** MimcHash, whose coins every pool shares. */
export const workerContract = (provider: any): any => new Contract(mimcHash as any, [], { provider, addressType: 'p2sh32' });

const rawUnlocker = (lock: Uint8Array, unlocking: Uint8Array): any => ({
  generateLockingBytecode: () => lock,
  generateUnlockingBytecode: () => Uint8Array.from(unlocking),
});

export class PoolClient {
  readonly verifier: VerifierProgram;
  readonly worker: any;
  readonly workerLock: Uint8Array;
  readonly contract: any;
  private readonly withdrawFee: bigint;
  /** The last tree a history proved. A note's hashes never change, so each is worked out once. */
  private proven = new MimcTree(LEVELS);
  /** Which transactions were the pool's, by txid. A transaction never changes, so each is read once. */
  private readonly ofThePool = new Map<string, Promise<boolean>>();

  constructor(readonly pool: PoolDefinition, readonly provider: any, artifact: any = poolArtifact(pool.kind)) {
    this.verifier = verifierProgram();
    this.worker = workerContract(provider);
    this.workerLock = lockOf(this.worker.address);
    this.withdrawFee = withdrawFeeOf(pool.kind);
    this.contract = new StatefulContract(pool.category, artifact, provider, {
      constructorArgs: poolArguments(pool),
    } as any);
    // The master, the state record and the pool's own coins never leave their locks, so a server
    // that lists none of one while the lock has a history is past its limit
    // (FulcrumProvider.mustShow): the satoshi coin is a plain one, and a token pool's coin holds
    // the asset.
    provider.mustShow?.(lockOf(this.contract.address), holdsNft(pool.category, 'minting'));
    provider.mustShow?.(lockOf(this.contract.getDataNftAddress()), holdsNft(pool.category, 'mutable'));
    provider.mustShow?.(lockOf(this.contract.getSatoshiContainerAddress()), (coins: FulcrumUtxo[]) => coins.some((coin) => !coin.token_data));
    if (pool.asset !== undefined) {
      const asset = pool.asset.toLowerCase();
      provider.mustShow?.(lockOf(this.contract.getTokenContainerAddress(pool.asset)), (coins: FulcrumUtxo[]) => coins.some((coin) => coin.token_data?.category === asset));
    }
  }

  /**
   * Every lock the pool owns: its master, state record, satoshi and token containers, event
   * addresses, workers and verifier. No key opens any of them, so a payout to one is lost.
   */
  ownLocks(): Uint8Array[] {
    const { contract } = this;
    const events: Array<{ signature: string }> = contract.inner.artifact.events ?? [];
    return [
      contract.address, contract.getDataNftAddress(), contract.getSatoshiContainerAddress(),
      ...(this.pool.asset ? [contract.getTokenContainerAddress(this.pool.asset)] : []),
      ...events.map(({ signature }) => contract.getEventNftAddress(signature)),
    ].map(lockOf).concat([this.workerLock, this.verifier.lock]);
  }

  /**
   * Whether a transaction spent the pool's master: its first output is the master again. Only
   * the master holds a minting NFT of the pool's category, so nothing else can make that output.
   */
  private madeByThePool(txid: string): Promise<boolean> {
    let known = this.ofThePool.get(txid);
    if (!known) {
      known = (async () => {
        const raw = hexToBin(await this.provider.getRawTransaction(txid));
        // A server's word for which transaction this is counts for nothing.
        if (binToHex(hash256(raw).slice().reverse()) !== txid) throw new Error('The server answered for another transaction.');
        const decoded = decodeTransaction(raw);
        if (typeof decoded === 'string') throw new Error(decoded);
        const [first] = decoded.outputs;
        return first !== undefined && equal(first.lockingBytecode, lockOf(this.contract.address))
          && first.token?.nft?.capability === 'minting' && binToHex(first.token.category) === this.pool.category;
      })();
      this.ofThePool.set(txid, known);
      // A failed read says nothing of the transaction, so the next call asks again.
      known.catch(() => this.ofThePool.delete(txid));
    }
    return known.catch(() => false);
  }

  /**
   * `count` coins at the hashing or the verifier lock, for a transaction that spends and
   * recreates them. Every pool shares those locks and anyone can pay a coin there, and a coin
   * whose transaction is unconfirmed is gone, with whatever was built on it, if its maker
   * double-spends that transaction at miners.
   *
   * So the coins the pool's own transactions made come first, confirmed or not: its last
   * transaction recreated the ones it spent, and a pool call rests on that transaction anyway
   * through the master. Then confirmed coins, in an order of this pool's own, so that two pools
   * rarely reach for the same coin. A stranger's unconfirmed coin, another pool's included, comes
   * only when the others are too few.
   */
  async coinsAt(lock: Uint8Array, count: number): Promise<any[]> {
    const coins = spendableCoins(await sharedCoins(this.provider, lock));
    const own: any[] = [];
    const confirmed: any[] = [];
    const strangers: any[] = [];
    for (const coin of coins) {
      if (await this.madeByThePool(coin.txid)) own.push(coin);
      else if (isConfirmed(coin)) confirmed.push(coin);
      else strangers.push(coin);
    }
    const category = hexToBin(this.pool.category);
    const rank = (coin: any) => binToHex(sha(category, hexToBin(coin.txid), le32(BigInt(coin.vout))));
    confirmed.sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
    return [...own, ...confirmed, ...strangers].slice(0, count);
  }

  /**
   * The pool as the chain has it. A history that left out a deposit, added one or
   * reordered them gives a different root, and a nullifier list that is not the spent
   * set gives a different nullifier root, so a dishonest source is refused here.
   */
  async view(history: PoolHistory): Promise<PoolView> {
    const state = await this.contract.getState();
    const count = Number(state.nextIndex);
    const [records, spent] = await Promise.all([history.deposits(), history.withdrawals()]);
    const deposits = records.slice().sort((a, b) => a.leafIndex - b.leafIndex);
    deposits.forEach((deposit, index) => {
      if (deposit.leafIndex !== index) throw new Error(`deposit history has a gap at leaf ${index}`);
    });
    const stage = Number(state.stage);
    if (deposits.length !== count + (stage === 0 ? 0 : 1)) {
      throw new Error(`deposit history has ${deposits.length} notes, the pool ${count}`);
    }
    const tree = await this.treeOf(deposits.slice(0, count).map((deposit) => deposit.commitment));
    if (!equal(sha(packed(tree.recentRoots(RECENT_ROOTS))), state.recentRoots)) {
      throw new Error('deposit history does not reproduce the pool\'s roots');
    }
    this.proven = tree;
    const nullifiers = new NullifierTree(spent);
    if (!equal(nullifiers.root(), state.nullifierState)) {
      throw new Error('withdrawal history does not reproduce the pool\'s nullifier root');
    }
    const view: PoolView = { state, tree, nullifiers, ...(stage === 0 ? {} : { pending: deposits[count].commitment }) };
    if (stage === 1) {
      const { frontier, node } = this.secondHalf(view);
      if (!equal(sha(sha(packed(frontier)), le32(node)), state.treeState)) {
        throw new Error('deposit history does not reproduce the note being hashed');
      }
    }
    return view;
  }

  /**
   * The tree of these leaves, from the last proven tree when they extend it. A long first
   * read hands the page back between batches, so it never looks dead with money in flight.
   */
  private async treeOf(leaves: bigint[]): Promise<MimcTree> {
    const held = this.proven.layers[0];
    const extendsIt = held.length <= leaves.length && held.every((leaf, i) => leaf === leaves[i]);
    const tree = extendsIt ? this.proven.copy() : new MimcTree(LEVELS);
    for (let at = tree.size; at < leaves.length; at += TREE_BATCH) {
      tree.append(leaves.slice(at, at + TREE_BATCH));
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    return tree;
  }

  /**
   * Add a note, with the first half of its hashing. `signer` pays; a token pool's coin of
   * the asset comes from `tokenCoin`. The rest is `finish`, which needs no key.
   */
  async deposit(signer: any, commitment: bigint, view: PoolView, tokenCoin?: any): Promise<any> {
    return (await this.depositCall(signer, commitment, view, tokenCoin)).call.send();
  }

  /** A deposit, ready to send. An SDK call is a thenable, so it travels in an object. */
  async depositCall(signer: any, commitment: bigint, view: PoolView, tokenCoin?: any): Promise<{ call: any }> {
    const frontier = view.tree.frontier();
    const { hashes } = stepWitness(frontier, commitment, Number(view.state.nextIndex), 1, view.tree.zeros);
    let call = this.contract.connect(signer).call.deposit(le32(commitment), packed(frontier)).withValue(depositValue(this.pool));
    if (this.pool.kind === 'token') {
      if (!tokenCoin) throw new Notice('A token deposit needs a coin of the asset.');
      call = call.addInput(tokenCoin, signer.unlockP2PKH()).tokenContainerDeposit(this.pool.asset!, this.pool.denomination);
    }
    if (tokenCoin) {
      // The coin's satoshis come back, with any token change. This output also keeps the
      // hashing coins' outputs level with their inputs, which each coin requires.
      const change = BigInt(tokenCoin.token.amount) - this.pool.denomination;
      call = call.addOutput({
        to: lockOf(signer.getAddress()),
        amount: BigInt(tokenCoin.satoshis),
        ...(change > 0n ? { token: { category: this.pool.asset!, amount: change } } : {}),
      });
    }
    ({ call } = await this.withHashing(call, hashes));
    return { call: call.withMaxFee(DEPOSIT_FEE_CAP) };
  }

  /** The MimcHash coins that prove a step's hashes. Each one's output has its index. */
  async withHashing(call: any, hashes: HashStep[]): Promise<{ call: any }> {
    const coins = await this.coinsAt(this.workerLock, STEP_LEVELS);
    if (coins.length < STEP_LEVELS) throw new Notice('Too few hashing coins are free right now. Every pool shares them: try again shortly.');
    let built = call;
    hashes.forEach(({ left, right, out }, i) => {
      built = built.addInput(coins[i], this.worker.unlock.hash(le32(left), le32(right), le32(out)));
    });
    for (const coin of coins) built = built.addOutput({ to: this.workerLock, amount: coin.satoshis });
    return { call: built };
  }

  /** Where `finish` starts: the frontier and node after a note's first 10 levels. */
  private secondHalf(view: PoolView) {
    const leafIndex = Number(view.state.nextIndex);
    const { frontier, node } = stepWitness(view.tree.frontier(), view.pending!, leafIndex, 1, view.tree.zeros);
    return { frontier, node, leafIndex };
  }

  /** Run `finish`. It needs no key: the deposit prepaid it, unless nodes now ask more. */
  async finish(view: PoolView, topUp?: FeeTopUp): Promise<any> {
    return (await this.finishCall(view, topUp)).call.send();
  }

  /** `finish`, ready to send. An SDK call is a thenable, so it travels in an object. */
  async finishCall(view: PoolView, topUp?: FeeTopUp): Promise<{ call: any }> {
    if (Number(view.state.stage) !== 1) throw new Notice('No deposit is waiting to be hashed.');
    const { frontier, node, leafIndex } = this.secondHalf(view);
    const { hashes } = stepWitness(frontier, node, leafIndex, 2, view.tree.zeros);
    const call = this.contract.call.finish(packed(frontier), le32(node), packed(view.tree.recentRoots(RECENT_ROOTS)));
    const { call: built } = await this.withHashing(call, hashes);
    const { call: paid, adds } = withTopUp(built, topUp);
    return { call: paid.withMaxFee(finishFeeOf(this.pool.kind) + adds) };
  }

  /**
   * Make the proof that pays a note to `recipient`, a locking bytecode, against the
   * pool's newest root. `prove` is the Groth16 prover, in a browser or in a test.
   */
  async prove(
    note: { nullifier: bigint; secret: bigint; commitment: bigint; nullifierHash: bigint },
    recipient: Uint8Array,
    view: PoolView,
    prove: (input: Record<string, unknown>) => Promise<unknown>,
    onProgress?: (message: string) => void,
  ): Promise<WithdrawalProof> {
    const leafIndex = view.tree.layers[0].indexOf(note.commitment);
    if (leafIndex < 0) throw new Notice('This note is not in the pool.');
    if (view.nullifiers.has(le32(note.nullifierHash))) throw new Notice('This note was already withdrawn.');
    const { pathElements, pathIndices } = view.tree.path(leafIndex);
    onProgress?.('Generating the proof in this browser…');
    const root = view.tree.root();
    const salt = fittingSalt(root, note.nullifierHash, recipient, await statementFits());
    const fixture = await prove({
      root: root.toString(),
      nullifierHash: note.nullifierHash.toString(),
      recipient: recipientField(recipient, salt).toString(),
      relayer: '0', fee: '0', refund: '0',
      nullifier: note.nullifier.toString(),
      secret: note.secret.toString(),
      pathElements: pathElements.map(String),
      pathIndices: pathIndices.map(String),
    });
    onProgress?.('Assembling the withdrawal…');
    return { unlockings: await verifierUnlockings(fixture, this.verifier), salt, root };
  }

  /** Prove and pay in one step. */
  async withdraw(
    note: { nullifier: bigint; secret: bigint; commitment: bigint; nullifierHash: bigint },
    recipient: Uint8Array,
    view: PoolView,
    prove: (input: Record<string, unknown>) => Promise<unknown>,
  ): Promise<any> {
    const proof = await this.prove(note, recipient, view, prove);
    return this.submitWithdrawal(proof, le32(note.nullifierHash), recipient, view);
  }

  /** Whether the pool still knows a proof's root. It keeps the last 8. */
  isFresh(proof: WithdrawalProof, view: PoolView): boolean {
    return view.tree.recentRoots(RECENT_ROOTS).includes(proof.root);
  }

  /** Send a proof. Also how one is resubmitted once the pool has moved on. */
  async submitWithdrawal(
    proof: WithdrawalProof, nullifierHash: Uint8Array, recipient: Uint8Array, view: PoolView, topUp?: FeeTopUp,
  ): Promise<any> {
    return (await this.withdrawalCall(proof, nullifierHash, recipient, view, topUp)).call.send();
  }

  /**
   * A proof's withdrawal, ready to send. An SDK call is a thenable, so it travels in an object.
   * A top-up shows its coin's owner in the transaction, so nothing adds one unasked.
   */
  async withdrawalCall(
    { unlockings, salt }: WithdrawalProof, nullifierHash: Uint8Array, recipient: Uint8Array, view: PoolView, topUp?: FeeTopUp,
  ): Promise<{ call: any }> {
    const coins = await this.coinsAt(this.verifier.lock, VERIFIER_COINS);
    if (coins.length < VERIFIER_COINS) throw new Notice('Too few verifier coins are free right now. Every pool shares them: try again shortly.');
    let call = this.contract.call.withdraw(
      packed(view.tree.recentRoots(RECENT_ROOTS)), view.nullifiers.path(nullifierHash), recipient, salt,
    );
    call = this.pool.kind === 'bch'
      ? call.transfer(recipient, this.pool.denomination)
      : call.tokenContainerTransfer(this.pool.asset!, recipient, this.pool.denomination);
    // The pool reads the verifier's statement from the last input, so a top-up goes before it.
    const { call: paid, adds } = withTopUp(call, topUp);
    call = paid;
    coins.forEach((coin: any, i: number) => { call = call.addInput(coin, rawUnlocker(this.verifier.lock, unlockings[i])); });
    for (const coin of coins) call = call.addOutput({ to: this.verifier.lock, amount: coin.satoshis });
    return { call: call.withMaxFee(this.withdrawFee + adds) };
  }
}

/** A call with a top-up's coin and change added where it stands, and what that adds to the fee. */
function withTopUp(call: any, topUp?: FeeTopUp): { call: any; adds: bigint } {
  if (!topUp) return { call, adds: 0n };
  const satoshis = BigInt(topUp.coin.satoshis);
  if (topUp.amount <= 0n || satoshis < topUp.amount) throw new Notice('That coin cannot pay the missing fee.');
  const change = satoshis - topUp.amount;
  const paid = call.addInput(topUp.coin, topUp.unlocker);
  if (change < CHANGE_DUST) return { call: paid, adds: satoshis };
  return { call: paid.addOutput({ to: topUp.change, amount: change }), adds: topUp.amount };
}

/** The hashing and verifier coins one pool transaction spends. */
export const SIDECARS_WANTED = { workers: STEP_LEVELS, verifiers: VERIFIER_COINS };

/** How many hashing and verifier coins the shared locks lack for `wanted`. */
export async function sidecarShortfall(provider: any, wanted = SIDECARS_WANTED): Promise<{ workers: number; verifiers: number }> {
  const short = async (lock: Uint8Array, count: number) => (
    Math.max(0, count - spendableCoins(await sharedCoins(provider, lock)).length));
  return {
    workers: await short(lockOf(workerContract(provider).address), wanted.workers),
    verifiers: await short(verifierProgram().lock, wanted.verifiers),
  };
}

/** At least the fee of a top-up with `inputs` P2PKH inputs and `outputs` outputs and change, at 1 sat/B. */
const topUpFee = (inputs: number, outputs: number): bigint => BigInt(10 + 160 * inputs + 34 * (outputs + 1));

/**
 * Pay hashing and verifier coins until each shared lock holds at least `wanted` that a
 * transaction can spend. Every pool shares them and anyone may add one: a pool transaction
 * recreates the coins it spends, and a coin left unmoved for 1,440 blocks is anyone's to sweep,
 * so a quiet spell can leave too few. Returns the transaction, or undefined when none was short.
 *
 * The funder's `utxo`, or as many of its `utxos`, largest first, as pay the coins and the fee: a
 * wallet's money is often spread over coins none of which pays alone.
 */
export async function topUpSidecars(
  provider: any, funder: { utxo?: any; utxos?: any[]; unlocker: any; change: string }, wanted = SIDECARS_WANTED,
): Promise<any> {
  const { workers, verifiers } = await sidecarShortfall(provider, wanted);
  if (workers + verifiers === 0) return undefined;
  const workerLock = lockOf(workerContract(provider).address);
  const verifierLock = verifierProgram().lock;
  const builder = new TransactionBuilder({ provider });
  const paying = BigInt(workers + verifiers) * COIN_SATOSHIS;
  const chosen: any[] = [];
  let held = 0n;
  const candidates = (funder.utxos ?? [funder.utxo]).filter(Boolean)
    .sort((a: any, b: any) => (BigInt(a.satoshis) === BigInt(b.satoshis) ? 0 : (BigInt(a.satoshis) > BigInt(b.satoshis) ? -1 : 1)));
  for (const coin of candidates) {
    if (held >= paying + topUpFee(chosen.length, workers + verifiers)) break;
    chosen.push(coin);
    held += BigInt(coin.satoshis);
  }
  if (held < paying + topUpFee(chosen.length, workers + verifiers)) {
    throw new Notice(`This wallet holds too little BCH to add the ${workers + verifiers} coins every pool shares: they hold ${paying.toLocaleString('en-US')} satoshis, with the fee on top.`);
  }
  for (const coin of chosen) builder.addInput(coin, funder.unlocker);
  for (let i = 0; i < verifiers; i += 1) builder.addOutput({ to: verifierLock, amount: COIN_SATOSHIS });
  for (let i = 0; i < workers; i += 1) builder.addOutput({ to: workerLock, amount: COIN_SATOSHIS });
  builder.addBchChangeOutputIfNeeded({ to: funder.change, feeRate: 1.0 });
  return builder.send();
}
