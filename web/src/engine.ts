// The browser engine, imported by the app through @solidpool/engine. It reads the chain through the
// user's Fulcrum server and drives each pool through SolidCash, so the contracts are
// the only rules. The notes, proofs and keys stay in this browser.
import { Signer } from '@solidcash/solidcash';
import { cacheGet, cachePut } from './cache';
import { resolveBcmrBatch } from './bcmr';

/** Be told when the chain verifies a token identity shown unverified (bcmr.ts, onBcmrVerified). */
export { onBcmrVerified as onTokenVerified } from './bcmr';
import {
  CREATION_ORDER, addSharedCoins, createPoolWithSigner, plannedCreationSteps,
  type PlannedCreationStep, type PoolCreationStep, type PoolPlan,
} from './deploy-pool';
import { deployerCoinValue, factoryPools, hasSentPrep } from './factory';
import { Fulcrum, HistoryLimit, bytesToHex, scripthashOfAddress } from './fulcrum';
import { ArchiveHistory, ChainHistory } from './history';
import { cashAddressToLockingBytecode } from './libauth';
import { POOL_KINDS, factoriesMade, isMadeAs, isPoolId, type MadePool } from './listing';
import { createNote, noteString, parseNote } from './note';
import { namesCategory, poolOfNote, type NoteText } from './note-text';
import { Notice } from './notice';
import {
  PoolClient, STEP_LEVELS, depositValue, le32, measure, shortfall, spendableCoins, topUpSidecars, workerContract,
  type FeeTopUp, type PoolDefinition, type PoolView,
} from './pool-client';
import { depositFeeOf, exponentOf, isPoolDenomination, type PoolKind } from './pools';
import { prove, type ProverAssets } from './prover';
import { FulcrumProvider } from './provider';
import {
  DEPOSIT_COIN_LIMIT, depositCoinTransfer, gatherTransfer, isDepositCoin, isFree, sendSelfTransfer, signatureBytesOf, waitForOwnCoin,
} from './self-transfer';
import { StepTracker, type DescribeFailure, type FlowStep, type StepProgress } from './step-progress';

export type { StepProgress, StepView } from './step-progress';

export interface RawPool {
  id: string;
  kind: PoolKind;
  name: string;
  symbol: string;
  decimals: number;
  denomination: string;
  category: string;
  asset?: string;
}

export interface EngineConfig {
  network: string;
  /** `mainnet`, `chipnet` or `devnet`: which deployment the page follows. */
  networkId?: string;
  /** What every address on this network starts with. */
  addressPrefix: string;
  fulcrumUrl: string;
  broadcastUrl?: string;
  /**
   * An archive to read history from. Optional: what it returns is checked either way. It hears
   * a read just before each deposit, so it belongs to the same operator as `fulcrumUrl`.
   */
  archiveUrl?: string;
  /** The same for withdrawals, with `broadcastUrl`. No archive serves both of a person's sides. */
  broadcastArchiveUrl?: string;
  /** An indexer's archive root, read for the first paint. Absent: the page paints from the chain. */
  indexerUrl?: string;
  pools: RawPool[];
  /** The categories of the network's pool factories. Without one, no pool of that kind can be made here. */
  factories?: { bch?: string; token?: string };
  prover: ProverAssets;
  /** A BCMR index or marketplace-style service, asked before the chain's authchain is walked. */
  bcmrServiceUrl?: string;
}

/** What the engine needs from a connected wallet. */
export interface EngineWallet {
  address: string;
  /** A key this page holds. */
  privateKey?: Uint8Array;
  /** Forwards SolidCash's request to the wallet as `bch_signTransaction`. */
  signRequest?: (request: unknown) => Promise<{ signedTransaction: string } | undefined>;
}

/** A pool through one server. */
interface PoolLink { client: PoolClient; history: ChainHistory; archive?: ArchiveHistory }

/**
 * `client` and the rest are the pool through the server that knows the wallet: page loads,
 * deposits and hashing. `payout` is the pool through the server a withdrawal uses from its
 * first read to its broadcast. With one server they are the same link.
 */
interface Pool extends PoolLink {
  raw: RawPool;
  payout: PoolLink;
  /**
   * What the wallet's server last showed of this pool, read with every other pool (a Trustless page
   * load, or a withdrawal's check): its recent roots, how many notes they cover, and when.
   */
  seen?: { recentRoots: string; nextIndex: number; at: number };
}

const definitionOf = (pool: RawPool): PoolDefinition => ({
  id: pool.id, kind: pool.kind, denomination: BigInt(pool.denomination), category: pool.category,
  ...(pool.asset ? { asset: pool.asset } : {}),
});

/**
 * A pool of these contracts pays a power of ten its constructor takes, since the exponent is its
 * argument. An entry that does not is no such pool, and its client cannot be built, so it is left
 * out rather than stopping every other pool from loading. So is one whose id could be read as another
 * pool's category, which would take that pool's older notes (isPoolId).
 */
const isPoolOfThisCode = (pool: RawPool): boolean => {
  try {
    exponentOf(BigInt(pool.denomination));
    return (pool.kind === 'bch' || pool.kind === 'token') && isPoolDenomination(pool.kind, BigInt(pool.denomination))
      && /^[0-9a-f]{64}$/i.test(pool.category) && isPoolId(pool.id, pool.category);
  } catch {
    return false;
  }
};

/** The servers a page reads, and every pool linked through them: its list, and any a note or a factory named. */
interface Connection {
  key: string;
  provider: FulcrumProvider;
  reader: Fulcrum;
  /** The server a withdrawal reads and sends through: the second, or with one server the same. */
  payoutReader: Fulcrum;
  link: (raw: RawPool) => Pool;
  linked: Map<string, Pool>;
}

// One set of clients per endpoint keeps each history's cache across refreshes, and a new pool in
// the list links beside the others rather than replacing the servers a wallet watch is subscribed on.
let connected: Connection | null = null;

function connect(config: EngineConfig): Connection {
  if (!config.fulcrumUrl) throw new Notice('Set a Fulcrum server in Settings.');
  const key = JSON.stringify([config.network, config.fulcrumUrl, config.broadcastUrl, config.archiveUrl, config.broadcastArchiveUrl]);
  if (connected?.key !== key) {
    const previous = connected?.reader as any;
    if (typeof previous?.close === 'function') void previous.close();
    const cachePrefix = `${config.networkId ?? config.network}:${config.fulcrumUrl}`;
    const reader = new Fulcrum(config.fulcrumUrl, cachePrefix);
    const provider = new FulcrumProvider(config.network, reader);
    // The wallet's server hears nothing of a withdrawal, and the other nothing of a deposit.
    const second = config.broadcastUrl && config.broadcastUrl !== config.fulcrumUrl
      ? new Fulcrum(config.broadcastUrl, cachePrefix) : undefined;
    const secondProvider = second && new FulcrumProvider(config.network, second);
    const link = (raw: RawPool): Pool => {
      // An archive keeps a pool under its category, whatever id a deployment gave it.
      const archiveAt = (url?: string) => (url ? { archive: new ArchiveHistory(url, raw.category.toLowerCase()) } : {});
      const client = new PoolClient(definitionOf(raw), provider);
      const own: PoolLink = { client, history: new ChainHistory(reader, client), ...archiveAt(config.archiveUrl) };
      const paying = secondProvider && new PoolClient(definitionOf(raw), secondProvider);
      const pool: Pool = { raw, ...own, payout: own };
      if (paying) pool.payout = { client: paying, history: new ChainHistory(second!, paying), ...archiveAt(config.broadcastArchiveUrl) };
      else pool.payout = pool;
      return pool;
    };
    connected = { key, provider, reader, payoutReader: second ?? reader, link, linked: new Map() };
  }
  return connected;
}

/** A pool as `raw` lists it, linked once for its id, category, kind, amount and asset. */
function linkPool(connection: Connection, raw: RawPool): Pool {
  const key = [raw.id, raw.category.toLowerCase(), raw.kind, raw.denomination, raw.asset?.toLowerCase() ?? ''].join(':');
  let pool = connection.linked.get(key);
  if (!pool) {
    pool = connection.link(raw);
    connection.linked.set(key, pool);
  }
  // The names a list gives may change; what the pool is does not.
  pool.raw = raw;
  return pool;
}

/** The pools `config` lists, one for each category, the first listing of it winning. */
function listedPools(config: EngineConfig): Pool[] {
  const connection = connect(config);
  const seen = new Set<string>();
  return config.pools.filter(isPoolOfThisCode).filter((raw) => {
    const category = raw.category.toLowerCase();
    if (seen.has(raw.id) || seen.has(category)) return false;
    seen.add(raw.id).add(category);
    return true;
  }).map((raw) => linkPool(connection, raw));
}

/** A pool the page lists, or one it linked since, by id. */
function poolOf(config: EngineConfig, id: string): Pool {
  const pool = listedPools(config).find((candidate) => candidate.raw.id === id)
    ?? [...connect(config).linked.values()].find((candidate) => candidate.raw.id === id);
  if (!pool) throw new Notice('This note is for a pool this app does not know.');
  return pool;
}

/** The network a page is on, as a note names it. */
const networkOf = (config: EngineConfig): string => config.networkId ?? config.network;
/** A network's name as Settings shows it. */
const networkName = (network: string): string => `${network.charAt(0).toUpperCase()}${network.slice(1)}`;

/**
 * How the page lists a pool that a factory's event or a note names and its own list does not. A
 * token pool's names come from a listed pool of the same asset when there is one; the page reads
 * an issuer's names for what it shows, and a withdrawal asks nobody, since the moment a person
 * withdraws is what a lookup would tell.
 */
function rawOf(config: EngineConfig, kind: PoolKind, category: string, denomination: bigint, asset?: string): RawPool {
  const common = { id: category, kind, category, denomination: denomination.toString() };
  if (kind === 'bch') return { ...common, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8 };
  const named = config.pools.find((pool) => pool.kind === 'token' && pool.asset?.toLowerCase() === asset);
  return {
    ...common, asset, name: named?.name ?? 'Token pool', symbol: named?.symbol ?? asset!.slice(0, 8), decimals: named?.decimals ?? 0,
  };
}

const rawOfMade = (config: EngineConfig, made: MadePool): RawPool => (
  rawOf(config, made.kind, made.category, 10n ** BigInt(made.exponent), made.asset));

/** Whether a pool has the terms a note names: its amount, and in a note that names them, its kind and asset. */
const hasNoteTerms = (raw: RawPool, note: NoteText): boolean => note.amount === BigInt(raw.denomination)
  && (note.kind === undefined || (note.kind === raw.kind && (note.asset ?? '') === (raw.asset?.toLowerCase() ?? '')));

/**
 * The pool a note is for. A note names its pool's kind, category, amount and asset, so any page
 * reaches it through a chain server alone, whatever it lists. A note from before notes named those
 * names a deployment's id, which the page's list holds, or a category, which the network's
 * factories' events hold, read through `reader`: a withdrawal's own server. Whether the factory made
 * the pool as the note says is each step's own check: see `requireFactoryMade`.
 *
 * A current note's own terms are what that check reads, so a list entry that names the note's pool
 * with other terms gives way to the note: it is stale or wrong, as one a browser kept from a creation
 * that was replaced. An older note names no kind or asset, so its pool is the list's.
 */
async function poolForNote(config: EngineConfig, note: NoteText, reader?: Fulcrum): Promise<Pool> {
  if (note.network !== undefined && note.network !== networkOf(config)) {
    const name = networkName(note.network);
    throw new Notice(`This note is for ${name}. Choose ${name} in Settings to use it.`);
  }
  const connection = connect(config);
  const listed = listedPools(config);
  const found = poolOfNote(note, listed.map((pool) => pool.raw));
  if (found && (note.kind === undefined || hasNoteTerms(found, note))) return listed.find((pool) => pool.raw === found)!;
  let raw: RawPool | undefined;
  if (note.kind !== undefined) raw = rawOf(config, note.kind, note.category!, note.amount, note.asset);
  else if (namesCategory(note)) {
    const { made, unread, limits } = await factoriesMade(reader ?? connection.reader, config.factories, config.network);
    const event = made.get(note.poolId);
    if (event) raw = rawOfMade(config, event);
    // Such a note names no kind, so either factory could have made its pool.
    else if (unread.length > 0) throw Object.values(limits)[0] ?? new Notice('This note\'s pool could not be looked up. Check your connection and try again.');
  }
  if (!raw || !isPoolOfThisCode(raw)) throw new Notice('This note is for a pool this app does not know.');
  return linkPool(connection, raw);
}

/** What a network's factories made of a pool: as listed, otherwise, nothing, or unknown. */
type FactoryVerdict = 'made' | 'differs' | 'unmade' | 'unread' | 'unnamed';

/**
 * Whether its network's factories made this pool with its kind, amount and asset, read now through
 * `reader`, whatever listed the pool or named it: see listing.ts.
 */
async function factoryVerdict(config: EngineConfig, reader: Fulcrum, raw: RawPool): Promise<FactoryVerdict> {
  if (!config.factories?.bch && !config.factories?.token) return 'unnamed';
  const { made, unread, limits } = await factoriesMade(reader, config.factories, config.network);
  const record = made.get(raw.category.toLowerCase());
  if (record) return isMadeAs(record, raw) ? 'made' : 'differs';
  // Only the factory of the pool's own kind could have made it, so only that read decides. A
  // server past its limit there can never answer, so the page asks for another one; the other
  // factory's read, cut or not, says nothing of this pool.
  if (unread.includes(raw.kind)) {
    const limit = limits[raw.kind];
    if (limit) throw limit;
    return 'unread';
  }
  return config.factories[raw.kind] ? 'unmade' : 'unnamed';
}

const FACTORY_REFUSALS: Record<'deposit' | 'withdrawal', Record<Exclude<FactoryVerdict, 'made'>, string>> = {
  deposit: {
    unnamed: 'This network names no factory for these pools, so this page cannot check the pool and deposits nothing.',
    unread: 'This page could not read which pools this network\'s factories made. Check your connection and try again.',
    unmade: 'This pool is not one this network\'s factories made, so this page does not deposit into it.',
    differs: 'This pool is listed for another amount or asset than its factory made it for, so this page does not deposit into it.',
  },
  withdrawal: {
    unnamed: 'This network names no factory for these pools, so this page cannot check this note\'s pool.',
    unread: 'This page could not read which pools this network\'s factories made. Check your connection and try again.',
    unmade: 'This note\'s pool is not one this network\'s factories made. Whoever made it could empty it, so this page does not withdraw from it.',
    differs: 'This note names another amount or asset than its pool\'s factory made it for. Check that you copied the whole note, unchanged.',
  },
};

/**
 * Refuse a step on a pool its network's factories did not make as `raw` says, saying why. A deposit
 * reads through the wallet's server, and a withdrawal through its own, which is the second server
 * when there are two.
 */
async function requireFactoryMade(config: EngineConfig, reader: Fulcrum, raw: RawPool, step: 'deposit' | 'withdrawal'): Promise<void> {
  const verdict = await factoryVerdict(config, reader, raw);
  if (verdict !== 'made') throw new Notice(FACTORY_REFUSALS[step][verdict]);
}

const signerFor = (
  wallet: EngineWallet, provider: FulcrumProvider, beforePrompt: () => void, afterPrompt: () => void,
  userPrompt: string | (() => string) = 'Deposit into a private pool',
): any => {
  const prompt = typeof userPrompt === 'function' ? userPrompt : () => userPrompt;
  return (wallet.privateKey
    ? new Signer(wallet.privateKey, provider as any)
    : Signer.external({
      wallet: {
        signTransaction: async (request: unknown) => {
          beforePrompt();
          // A wallet that refuses, or a session that ended, signed nothing.
          try {
            const signed = await wallet.signRequest!(request);
            afterPrompt();
            return signed;
          } catch { return undefined; }
        },
      },
      address: wallet.address,
      // Each transaction is described as the step it belongs to, which changes as the flow goes on.
      get userPrompt() { return prompt(); },
    } as any, provider as any));
};

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** An amount in a pool's own units, as a wallet prompt names it: 1000000 at 8 decimals is 0.01. */
const unitsText = (value: bigint, decimals: number): string => {
  const digits = value.toString().padStart(decimals + 1, '0');
  if (decimals === 0) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, -decimals)}.${fraction}` : digits.slice(0, -decimals);
};
/** What the page says while the wallet is asked to sign one transaction of a step. */
const approving = (prompt: string): string => `Approve the transaction in your wallet to ${prompt.toLowerCase()}…`;

/** SolidCash builds every transaction to pay 1,000 sat per 1,000 bytes, which the pools' prepaid fees cover with room to spare. */
const SDK_FLOOR = 1_000n;
/** Five times what nodes ask today: the most this page takes a server's word for. */
const MOST_BELIEVED_FLOOR = 5_000n;

/**
 * The least fee the node behind the server a transaction goes to relays, in satoshis per 1,000
 * bytes. A server that cannot say is taken at SolidCash's floor, and its node's refusal speaks.
 */
async function relayFloor(provider: FulcrumProvider): Promise<bigint> {
  try { return await (provider.reader as Fulcrum).relayFee(); } catch { return SDK_FLOOR; }
}

/**
 * The two steps a deposit prepays. Whoever pays more for `hashing`, the last step of adding a
 * note, is tied to that deposit, and whoever pays more for a `withdrawal` to that withdrawal, so
 * one wallet must never pay both for one note.
 */
export type FeeStep = 'hashing' | 'withdrawal';

/**
 * A pool's step whose prepaid fee nodes no longer relay, stopped before anything left. A wallet
 * can pay `missing` with a coin of its own, and that coin shows in the transaction.
 */
export class FeeShortfall extends Notice {
  constructor(readonly missing: bigint, readonly step: FeeStep) {
    const satoshis = missing.toLocaleString('en-US');
    super(step === 'hashing'
      ? `This note is still being added to the pool, and nodes now ask ${satoshis} satoshis more network fee for that than its deposit prepaid, so nothing was sent.`
      : `Nodes now ask ${satoshis} satoshis more network fee for this withdrawal than its pool prepaid, so nothing was sent.`, true);
  }
}

/** A wallet's refusal, in SolidCash's words. A person who said no is not asked again. */
const refusedToSign = (error: unknown): boolean => /did not sign/.test(String((error as Error)?.message));

/** A fee top-up's steps: its coins gathered into one, when no coin pays it alone, then the fee. */
const FEE_ORDER = ['gather', 'fee'];
const GATHER_FEE_STEP: FlowStep = { id: 'gather', title: 'Gather your coins into one that pays the network fee', signs: true };
/** A top-up whose coin was gathered first: the gathering went out, and only moved the payer's coins. */
type PaidTopUp = FeeTopUp & { gathered?: string };

/**
 * The top-up a pool's step needs at the relay floor of the server it goes to, paid by `payer`,
 * or none while the prepaid fee covers that floor. It always covers SolidCash's. `most` is what
 * the person was shown: a step that now needs more stops and says so before anything is signed.
 *
 * One coin pays it, inside the step's own transaction. When no coin of the wallet's holds that
 * much alone and its coins together do, a transaction to itself gathers them into one first
 * (self-transfer.ts), which the wallet approves too, through a provider of its own so that it never
 * counts as the step leaving. `steps` hears both.
 */
async function topUpFor(
  provider: FulcrumProvider, step: FeeStep, unpaid: () => Promise<{ call: any }>,
  { payer, most, onProgress, steps }: {
    payer?: EngineWallet; most?: bigint; onProgress?: (message: string) => void; steps?: StepTracker;
  } = {},
): Promise<PaidTopUp | undefined> {
  const floor = await relayFloor(provider);
  if (floor <= SDK_FLOOR) return undefined;
  // The floor is the server's word, which nothing here can check, and a hostile server would
  // name one that has the page offer a wallet's coin for a fee of its choosing.
  if (floor > MOST_BELIEVED_FLOOR) {
    const perByte = (Number(floor) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
    throw new Notice(`This server says nodes now ask ${perByte} sat per byte, more than this page believes of any server, so nothing was sent. Choose another server in Settings.`, true);
  }
  const missing = shortfall(await measure((await unpaid()).call), floor);
  if (missing === 0n) return undefined;
  if (!payer || (most !== undefined && missing > most)) throw new FeeShortfall(missing, step);
  const feeStep: FlowStep = {
    id: 'fee', title: step === 'hashing' ? 'Pay the network fee of adding a note to a private pool' : 'Pay the network fee of a private withdrawal', signs: true,
  };
  // Once signed, the fee goes out inside the step's own transaction.
  const signer = signerFor(
    payer, provider,
    () => {
      steps?.asking();
      onProgress?.(approving(feeStep.title));
    },
    () => {
      steps?.answered();
      onProgress?.(step === 'hashing' ? 'Adding the note to the pool…' : 'Sending the withdrawal…');
    },
    feeStep.title,
  );
  const change = cashAddressToLockingBytecode(payer.address);
  if (typeof change === 'string') throw new Notice('This wallet\'s address is not one this page can pay change to.', true);
  const plain = (await signer.getUtxos()).filter((coin: any) => !coin.token && isFree(coin));
  let coin = plain.filter((candidate: any) => BigInt(candidate.satoshis) >= missing)
    .sort((a: any, b: any) => (BigInt(a.satoshis) < BigInt(b.satoshis) ? -1 : 1))[0];
  // A step tried again keeps the steps it planned the first time.
  if (steps && steps.progress().total === 0) steps.plan([...(coin ? [] : [GATHER_FEE_STEP]), feeStep]);
  let gathered: string | undefined;
  if (!coin) {
    const gathering = new FulcrumProvider(provider.network, provider.reader);
    // Nodes ask more than 1 sat/B now, or nothing would be missing: the gathering pays what they ask.
    const transfer = gatherTransfer(await gathering.getUtxos(payer.address), missing, change.bytecode, signatureBytesOf(payer), floor);
    if ('short' in transfer) throw new Notice(`This wallet has no coin of ${missing.toLocaleString('en-US')} satoshis or more to pay the network fee.`, true);
    steps?.start(GATHER_FEE_STEP);
    onProgress?.('Gathering your coins into one that pays the network fee…');
    gathered = await sendSelfTransfer(gathering, transfer, change.bytecode, payer, GATHER_FEE_STEP.title, {
      asking: () => {
        steps?.asking();
        onProgress?.(approving(GATHER_FEE_STEP.title));
      },
      answered: () => steps?.answered(),
    });
    coin = await waitForOwnCoin(gathering, payer.address, gathered, 0);
    steps?.done(GATHER_FEE_STEP.id);
  }
  steps?.start(feeStep);
  return { coin, unlocker: signer.unlockP2PKH(), change: change.bytecode, amount: missing, ...(gathered ? { gathered } : {}) };
}

/** A payer's refusal of a fee, saying whether its coins had been gathered for it. */
const refusedFee = (gathered: boolean): string => (gathered
  ? 'The wallet did not sign the fee, so it was not paid. Only the coin that pays it went out, gathered within your wallet, and it stays there.'
  : 'The wallet did not sign, so nothing was sent.');

/** Whether something shows up. A server saying it took a transaction proves little. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await check().catch(() => false)) return true;
    await sleep(1_000);
  }
  return false;
}

const MOST_ATTEMPTS = 6;

const DEPOSIT_MAY_HAVE_LANDED = 'This may have gone through. Keep your note: it pays if it did.';
const WITHDRAWAL_MAY_HAVE_LANDED = 'This may have gone through. Keep your note until the recipient shows the payment. If nothing arrives, try again: a note pays once, so that is safe.';

/**
 * The pool as the chain has it. An archive saves reading every transaction, and is only
 * believed when it reproduces the pool's roots; otherwise the chain itself is read.
 */
async function viewOf({ client, history, archive }: PoolLink) {
  if (archive) {
    try { return await client.view(archive); } catch { /* the chain below is the authority */ }
  }
  return client.view(history);
}

/**
 * Finish whatever note is being hashed. It needs no key, and the deposit prepaid it. Should
 * nodes ask more, `payer` pays the rest, up to `most`, and without one nothing is sent.
 */
async function finishHashing(
  link: PoolLink, onProgress?: (message: string) => void, payer?: EngineWallet, most?: bigint, steps?: StepTracker,
): Promise<void> {
  const { client } = link;
  let gathered = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { stage } = await client.contract.getState();
    if (Number(stage) === 0) return;
    onProgress?.('Adding the note to the pool…');
    try {
      const view = await viewOf(link);
      const topUp = await topUpFor(client.provider, 'hashing', () => client.finishCall(view), { payer, most, onProgress, steps });
      if (topUp?.gathered) gathered = true;
      await client.finish(view, topUp);
      if (topUp) steps?.done('fee');
    } catch (error) {
      if (refusedToSign(error)) throw new Notice(refusedFee(gathered), !gathered);
      // Someone else's step can land first, in whatever words a server has for that, and a
      // hashing step costs nobody anything to try again. What lasts ends this loop.
      if ((error as Notice).notice && !/waiting to be hashed/.test((error as Notice).message)) throw error;
      await sleep(1_000);
    }
  }
  throw new Notice('The note being added to the pool could not be finished. Try again shortly.');
}

/**
 * The pool to prove over, once the wallet's server agrees with the second on its roots. A proof
 * shows whoever receives it which tree it was made over, so a second server that showed this page a
 * tree of its own choosing would learn from the proof whether the note is in that tree. With one
 * server, this page has only its word for the pool: it cannot lose money that way, but it can lose
 * privacy.
 *
 * The wallet's server knows the wallet, so a withdrawal asks it nothing when it can avoid it. A
 * Trustless page load read every pool there. While the roots that load saw are still the pool's
 * newest, by the second server's state, the two servers agree already, and the proof is made over
 * the newest root, as it would be after a fresh read (stillNewest). A proof over any older root would
 * be worse: its root is public on chain, and would tell everyone the withdrawal came from a page
 * loaded before the latest deposits. So once the pool has moved on, or in the Fast indexer view,
 * where no page load reads the pools through the wallet's server, that server is asked about every
 * pool at once and never about this one alone (walletServerRoots). That shows it this page read its
 * pools again, and so that a withdrawal may be under way, but not from which pool.
 */
async function agreedView(config: EngineConfig, pool: Pool): Promise<PoolView> {
  for (let attempt = 0; ; attempt += 1) {
    const view = await viewOf(pool.payout);
    if (pool.payout === pool || stillNewest(config, pool, view)) return view;
    const roots = await walletServerRoots(config, pool);
    if (roots === bytesToHex(view.state.recentRoots)) return view;
    if (attempt >= 4) {
      throw new Notice(roots === undefined
        ? 'Your chain server did not show this pool, so no proof was made. Check your connection and try again.'
        : 'Your two servers disagree about this pool, so no proof was made. Check them in Settings.');
    }
    await sleep(1_000);
  }
}

/**
 * A pool's recent roots as the wallet's server shows them, read as a Trustless page load reads the
 * pools there: the network's factories, then the state of every pool the page lists and every pool
 * the factories made, all at once (checkedPools). So nothing in these reads says which pool they are
 * for. Their spent notes, which a page load reads too, are not read: a page load reads them from the
 * wallet's archive where there is one, and that archive hears nothing of a withdrawal. A pool no
 * factory made, which only `unlistedPool` withdraws from, is read beside the others, and so does
 * stand out. Undefined when the server did not show the pool.
 */
async function walletServerRoots(config: EngineConfig, pool: Pool): Promise<string | undefined> {
  const category = pool.raw.category.toLowerCase();
  // A pool whose factory this server could not read is read anyway, rather than leave this one alone.
  const pools = (await checkedPools(config)).checked.map((entry) => entry.pool);
  if (!pools.some((listed) => listed.raw.category.toLowerCase() === category)) pools.push(pool);
  const states = await Promise.all(pools.map(async (listed) => {
    const state = await listed.client.contract.getState().catch(() => undefined);
    if (state) remember(listed, state);
    return state;
  }));
  const state = states[pools.findIndex((listed) => listed.raw.category.toLowerCase() === category)];
  return state === undefined ? undefined : bytesToHex(state.recentRoots);
}

/** Keep what the wallet's server showed of a pool, read with every other pool. */
const remember = (pool: Pool, state: { recentRoots: Uint8Array; nextIndex: bigint }): void => {
  pool.seen = { recentRoots: bytesToHex(state.recentRoots), nextIndex: Number(state.nextIndex), at: Date.now() };
};

/**
 * Whether the recent roots the wallet's server last showed of this pool, read with every other pool,
 * are still the pool's own by the second server's state: the same roots over the same notes. Then the
 * newest root is the one a fresh read would show, and nothing need be asked.
 */
function stillNewest(config: EngineConfig, pool: Pool, view: PoolView): boolean {
  const category = pool.raw.category.toLowerCase();
  const seen = [...connect(config).linked.values()]
    .filter((linked) => linked.seen && linked.raw.category.toLowerCase() === category)
    .map((linked) => linked.seen!)
    .sort((a, b) => b.at - a.at)[0];
  return seen !== undefined && seen.nextIndex === Number(view.state.nextIndex)
    && seen.recentRoots === bytesToHex(view.state.recentRoots);
}

/** How long a page waits for a count. Anyone can pad an event's history with coins. */
const COUNT_WAIT_MS = 5_000;

/** The spent notes, for counting, or nothing yet: a long history must not hold up the page. */
async function spentCount({ archive, history }: PoolLink): Promise<number | null> {
  const list = archive ? archive.withdrawals().catch(() => history.withdrawals()) : history.withdrawals();
  return Promise.race([list.then((spent) => spent.length, () => null), sleep(COUNT_WAIT_MS).then(() => null)]);
}

/** What a trustless catch-up reports while it reads and verifies each pool. */
export interface SyncProgress {
  done: number;
  total: number;
  pool?: string;
  phase: 'verify';
}

const stateCacheKey = (config: EngineConfig): string => (
  `state:${networkOf(config)}:${config.fulcrumUrl}:${config.factories?.bch ?? ''}:${config.factories?.token ?? ''}:`
  + config.pools.map((pool) => pool.category).join(',')
);

/** The last verified pool rows, for a paint before the chain is read again. */
export async function cachedState(config: EngineConfig): Promise<{ pools: any[] } | undefined> {
  const raw = await cacheGet<string>(stateCacheKey(config));
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.pools) ? parsed : undefined;
  } catch { return undefined; }
}

/** A pool's row before its state is read. */
function rowOf({ raw }: Pool, network: string) {
  return {
    id: raw.id, kind: raw.kind, name: raw.name, symbol: raw.symbol, decimals: raw.decimals,
    denomination: raw.denomination, category: raw.category,
    ...(raw.asset === undefined ? {} : { asset: raw.asset }),
    // The network the row was checked on, so a page that moves to another does not carry it along.
    network,
    depositValue: String(depositValue(definitionOf(raw))),
    depositFee: String(depositFeeOf(raw.kind)),
    hashing: false,
    unread: false,
    source: 'trustless',
  };
}

/**
 * One pool's row, read through the server; a pool that cannot be read stays unread. A server past
 * its limit is kept in `limits`, for a page that could read nothing to say so.
 */
async function readPoolRow(pool: Pool, network: string, limits: HistoryLimit[] = []) {
  const row = rowOf(pool, network);
  try {
    const [state, spent] = await Promise.all([pool.client.contract.getState(), spentCount(pool)]);
    remember(pool, state);
    return {
      ...row,
      notes: spent === null ? null : Number(state.nextIndex) - spent,
      spent,
      hashing: Number(state.stage) !== 0,
    };
  } catch (error) {
    if (error instanceof HistoryLimit) limits.push(error);
    return { ...row, notes: null, spent: null, unread: true };
  }
}

/**
 * The pools a page lists, by its own reads of its network's factories: each of its own pools that
 * `factoryPools` finds among the creations of the factory of its kind, then every other pool that
 * factory made, so the page finds every pool without an indexer. Any other pool is left out,
 * whoever listed it (see listing.ts). A kind whose factory could not be read keeps its pools unread, and an
 * unread pool takes no deposit. With `ids`, only those of the page's own pools, and nothing more.
 */
async function checkedPools(config: EngineConfig, ids?: ReadonlySet<string>) {
  const connection = connect(config);
  const listed = listedPools(config).filter((pool) => !ids || ids.has(pool.raw.id));
  const kinds = ids ? POOL_KINDS.filter((kind) => listed.some((pool) => pool.raw.kind === kind)) : POOL_KINDS;
  const { made, unread, limits } = await factoriesMade(connection.reader, config.factories, config.network, kinds);
  const checked: Array<{ pool: Pool; read: boolean }> = [];
  const shown = new Set<string>();
  for (const pool of listed) {
    const category = pool.raw.category.toLowerCase();
    if (unread.includes(pool.raw.kind)) checked.push({ pool, read: false });
    else if (isMadeAs(made.get(category), pool.raw)) checked.push({ pool, read: true });
    else continue;
    shown.add(category);
  }
  if (!ids) {
    for (const event of made.values()) {
      if (!shown.has(event.category)) checked.push({ pool: linkPool(connection, rawOfMade(config, event)), read: true });
    }
  }
  return { checked, unread, limits: Object.values(limits) };
}

/** Rows for pools checked against the factories: read through the server, or unread. */
async function rowsOf(
  config: EngineConfig, checked: Array<{ pool: Pool; read: boolean }>, onProgress?: (progress: SyncProgress) => void,
  limits: HistoryLimit[] = [],
) {
  const network = networkOf(config);
  const total = checked.filter(({ read }) => read).length;
  let done = 0;
  return Promise.all(checked.map(async ({ pool, read }) => {
    if (!read) return { ...rowOf(pool, network), notes: null, spent: null, unread: true };
    const row = await readPoolRow(pool, network, limits);
    done += 1;
    onProgress?.({ done, total, pool: pool.raw.id, phase: 'verify' });
    return row;
  }));
}

export async function loadState(config: EngineConfig, onProgress?: (progress: SyncProgress) => void) {
  const { checked, unread, limits } = await checkedPools(config);
  const rows = await rowsOf(config, checked, onProgress, limits);
  // No list at all is no answer when a factory could not be read. A server past its limit can never
  // answer, so the page asks for another one.
  if ((rows.length > 0 || unread.length > 0) && rows.every((row) => row.unread)) throw limits[0] ?? new Error('The pools could not be checked.');
  await cachePut(stateCacheKey(config), JSON.stringify({ pools: rows }));
  return { pools: rows };
}

/** Read only the named pools through the chain, for rows an indexer could not serve. */
export async function loadPoolRows(
  config: EngineConfig, ids: readonly string[], onProgress?: (progress: SyncProgress) => void,
) {
  const { checked } = await checkedPools(config, new Set(ids));
  return { pools: await rowsOf(config, checked, onProgress) };
}

/** Finish a deposit left half hashed. Anyone can, for free, so a closed tab costs nobody. */
export function finishPending(config: EngineConfig, poolId: string, onProgress?: (message: string) => void) {
  return finishHashing(poolOf(config, poolId), onProgress);
}

/**
 * Make a note and show it before anything is sent: a deposit without a saved note is lost. It names
 * its network, `networkId` as a page has it, and its pool, so it withdraws anywhere: see note-text.ts.
 */
export function newNote(pool: RawPool, network: string): string {
  return noteString(createNote(), pool, network);
}

/** Whether two addresses pay the same lock, however each is written. */
export function sameLock(first: string, second: string): boolean {
  const [a, b] = [first, second].map((address) => cashAddressToLockingBytecode(address));
  return typeof a !== 'string' && typeof b !== 'string' && bytesToHex(a.bytecode) === bytesToHex(b.bytecode);
}

/**
 * The lock a withdrawal pays. A note spends in one click and for good, so an address for
 * another network, one that says its wallet cannot hold tokens, or one of the pool's own, is
 * refused here.
 */
function recipientLock(config: EngineConfig, pool: Pool, recipient: string): Uint8Array {
  const decoded = cashAddressToLockingBytecode(recipient);
  if (typeof decoded === 'string') throw new Notice('That is not a valid address.');
  if (decoded.prefix !== config.addressPrefix) throw new Notice(`That address is for another network. Here they start with ${config.addressPrefix}:`);
  if (pool.raw.kind === 'token' && !decoded.tokenSupport) {
    throw new Notice('This pool pays tokens, so it needs a token-aware address: the part after the colon starts with z.');
  }
  const lock = bytesToHex(decoded.bytecode);
  if (pool.client.ownLocks().some((own) => bytesToHex(own) === lock)) {
    throw new Notice('This address belongs to the pool itself. Paying it would lose the money for good, so use another address.');
  }
  return decoded.bytecode;
}

/** What a failure says when nothing left this page, so the same note can try again. */
function unsentNotice(error: unknown): Notice {
  const { notice, message } = error as Notice;
  // One that already says so keeps what else it carries, as DepositCoinNeeded does.
  if (notice) return (error as Notice).unsent ? error as Notice : new Notice(message, true);
  if (/did not sign/.test(String(message))) return new Notice('The wallet did not sign, so nothing was sent.', true);
  console.warn(error);
  return new Notice('Nothing was sent. Check your connection, and that this wallet can cover the deposit and its network fees.', true);
}

/**
 * Add the hashing coins a deposit and its `finish` spend, when too few are free. Every pool shares
 * them, and anyone may sweep one that has stood unmoved for 1,440 blocks, so a quiet spell can
 * leave too few. The depositor's own wallet pays: the deposit is that wallet's anyway, and no
 * withdrawal spends a hashing coin. It has a provider of its own, so it is never taken for the
 * deposit itself, which is signed for one transaction that leaves.
 */
async function ensureHashing(provider: FulcrumProvider, wallet: EngineWallet, onProgress?: (message: string) => void, steps?: StepTracker) {
  if (!await hashingCoinsShort(provider)) return;
  steps?.start(HASHING_COINS_STEP);
  const userPrompt = HASHING_COINS_STEP.title;
  const signer = signerFor(
    wallet, provider,
    () => {
      steps?.asking();
      onProgress?.(approving(userPrompt));
    },
    () => {
      steps?.answered();
      onProgress?.('Adding the hashing coins your deposit needs…');
    },
    userPrompt,
  );
  // As many of the wallet's plain coins as it takes: its money is often spread over several.
  const funds = (await signer.getUtxos()).filter((coin: any) => !coin.token && isFree(coin));
  if (funds.length === 0) throw new Notice('Too few hashing coins are free, and this wallet has no plain coin to add them.');
  await topUpSidecars(provider, { utxos: funds, unlocker: signer.unlockP2PKH(), change: signer.getAddress() }, { workers: STEP_LEVELS, verifiers: 0 });
  steps?.done(HASHING_COINS_STEP.id);
}

/** Whether too few hashing coins are free for a deposit and its `finish`. */
async function hashingCoinsShort(provider: FulcrumProvider): Promise<boolean> {
  const workerLock = (cashAddressToLockingBytecode(workerContract(provider).address) as { bytecode: Uint8Array }).bytecode;
  return spendableCoins(await provider.getUtxosForLockingBytecode(workerLock)).length < STEP_LEVELS;
}

/** A deposit's steps: a coin of the asset made first, when needed, then these. */
const DEPOSIT_ORDER = ['prepare', 'hashing', 'deposit', 'land'];
const HASHING_COINS_STEP: FlowStep = { id: 'hashing', title: 'Add the hashing coins your deposit needs', signs: true };
const LANDING_STEP: FlowStep = { id: 'land', title: 'Wait for your note to appear in the pool', signs: false };

/**
 * A token deposit's coin missing: the wallet holds enough of the asset, but on coins none of which a
 * deposit can spend alone, since TokenPool takes one fungible coin of under 1,500 satoshis. Nothing
 * was sent, and `prepareDepositCoin` makes such a coin from the wallet's own.
 */
export class DepositCoinNeeded extends Notice {
  readonly prepareCoin = true;

  constructor(amount: string) {
    super(`No single coin in this wallet can pay this deposit: it takes one coin of at least ${amount} holding under 1,500 satoshis. Your wallet can make one from its own coins first.`, true);
  }
}

/**
 * Deposit a note. A note pays once, so a second deposit of it is lost, and a signed
 * transaction that has left this page can land at any time, whatever any server says about
 * it. So a note is signed for one transaction that leaves, ever. If that one's outcome is
 * unknown, the person keeps the note, and depositing again means starting over with a new
 * one, which is safe whatever happened: if both land, both pay.
 *
 * `onSteps` hears its steps: the hashing coins it adds when too few are free, the deposit, and
 * its wait for the note to appear; the wallet approves each transaction.
 */
export async function deposit(
  config: EngineConfig, noteText: string, wallet: EngineWallet, onProgress?: (message: string) => void,
  onSteps?: (progress: StepProgress) => void,
) {
  let note: ReturnType<typeof parseNote>;
  let pool: Pool;
  let sending: FulcrumProvider;
  let depositor: PoolClient;
  try {
    note = parseNote(noteText);
    pool = await poolForNote(config, note);
    // A note pays what it names. A deposit on other terms would leave it naming an amount or asset
    // its pool does not have, which no page would withdraw.
    if (!hasNoteTerms(pool.raw, note)) throw new Notice('This note names another amount or asset than its pool, so nothing was sent.');
    // Whatever listed the pool, it takes a deposit only once its network's factory is seen to have
    // made it, read now: a pool made outside a factory can hold a second master.
    await requireFactoryMade(config, connect(config).reader, pool.raw, 'deposit');
    // Its own provider, so only this deposit's transaction can count as having left.
    sending = new FulcrumProvider(config.network, connect(config).reader);
    depositor = new PoolClient(definitionOf(pool.raw), sending);
  } catch (error) {
    throw unsentNotice(error);
  }
  const inPool = async () => {
    const view = await viewOf(pool);
    return view.pending === note.commitment || view.tree.layers[0].includes(note.commitment);
  };
  const left = () => sending.broadcasts > 0;
  // A deposit's fee is SolidCash's to set, and it pays 1 sat/B. A node asking more would
  // refuse it, so say that before the wallet is asked anything.
  if (await relayFloor(sending) > SDK_FLOOR) {
    throw new Notice('Nodes now ask a higher network fee than this page can pay yet, so nothing was sent.', true);
  }
  // The hashing coins' top-up has a provider of its own, so it never counts as the deposit leaving.
  const hashing = new FulcrumProvider(config.network, connect(config).reader);
  const steps = new StepTracker(!wallet.privateKey, () => sending.broadcasts + hashing.broadcasts, onSteps, DEPOSIT_ORDER);
  const depositStep: FlowStep = {
    id: 'deposit',
    title: `Deposit ${unitsText(note.amount, pool.raw.decimals)} ${pool.raw.symbol} into a private pool — and pay the withdrawal fee in advance`,
    signs: true,
  };
  // The SDK retries a refused broadcast by itself, and that must not reach the wallet.
  const signer = signerFor(
    wallet, sending,
    () => {
      if (left()) throw new Error('no second signature');
      steps.asking();
    },
    () => {
      steps.answered();
      onProgress?.('Sending your deposit…');
    },
    depositStep.title,
  );
  try {
    const definition = definitionOf(pool.raw);
    const requiredBch = depositValue(definition) + depositFeeOf(pool.raw.kind);
    const utxos = await signer.getUtxos();
    const plainBch = utxos.filter((coin: any) => !coin.token).reduce((sum: bigint, coin: any) => sum + coin.satoshis, 0n);
    if (plainBch < requiredBch) {
      throw new Notice(`This wallet holds ${unitsText(plainBch, 8)} BCH. Depositing into this pool needs ${unitsText(requiredBch, 8)} BCH, including its fees.`, true);
    }
    let tokenCoin: any;
    if (pool.raw.kind === 'token') {
      tokenCoin = utxos.find(isDepositCoin(pool.raw.asset!, note.amount));
      if (!tokenCoin) {
        const units = (value: bigint) => `${unitsText(value, pool.raw.decimals)} ${pool.raw.symbol}`;
        const spendable = utxos.filter((coin: any) => coin.token?.category === pool.raw.asset && !coin.token.nft)
          .reduce((sum: bigint, coin: any) => sum + coin.token.amount, 0n);
        if (spendable < note.amount) throw new Notice(`This wallet holds ${units(spendable)} that a deposit can spend. This deposit needs ${units(note.amount)}.`, true);
        // Enough of it, spread over coins none of which a deposit takes alone: one can be made.
        throw new DepositCoinNeeded(units(note.amount));
      }
    }
    steps.plan([...(await hashingCoinsShort(hashing) ? [HASHING_COINS_STEP] : []), depositStep, LANDING_STEP]);
    await ensureHashing(hashing, wallet, onProgress, steps);
    steps.start(depositStep);
    for (let attempt = 0; ; attempt += 1) {
      await finishHashing(pool, onProgress);
      // A local key has no prompt to wait for; the time there is building and broadcasting.
      onProgress?.(wallet.privateKey ? 'Building your deposit…' : 'Approve the deposit in your wallet…');
      try {
        await depositor.deposit(signer, note.commitment, await viewOf(pool), tokenCoin);
        break;
      } catch (error) {
        // Before anything leaves, losing a race costs only another try, in whatever words
        // it came. A wallet's refusal is a person's answer, so that is not asked again.
        const final = left() || (error as Notice).notice || /did not sign/.test(String((error as Error).message));
        if (final || attempt >= MOST_ATTEMPTS - 1) throw error;
        await sleep(1_000);
      }
    }
  } catch (error) {
    if (!left()) {
      steps.fail();
      throw unsentNotice(error);
    }
    if (!await inPool().catch(() => false)) {
      steps.fail();
      throw new Notice(DEPOSIT_MAY_HAVE_LANDED);
    }
  }

  steps.start(LANDING_STEP);
  onProgress?.('Waiting for your note to appear in the pool…');
  if (!await eventually(inPool)) {
    steps.fail();
    throw new Notice(DEPOSIT_MAY_HAVE_LANDED);
  }
  // The note is in. Its hashing can wait: anyone can finish it, and it is prepaid, unless
  // nodes now ask more, when only a wallet can, and the page says so.
  let waitsOnFee: bigint | undefined;
  const hashed = await finishHashing(pool, onProgress).then(() => true, (error) => {
    if (error instanceof FeeShortfall) waitsOnFee = error.missing;
    return false;
  });
  steps.finish();
  return { accepted: true, poolId: note.poolId, hashed, waitsOnFee };
}

/**
 * Make the coin a token pool's deposit spends, from the wallet's own coins, when it holds enough of
 * the asset but no coin a deposit takes alone: the asset spread over several coins, or sitting on
 * coins of 1,500 satoshis or more. One transaction from the wallet to itself (self-transfer.ts)
 * spends as many of its fungible coins of the asset as it takes, never one with an NFT, and pays
 * back one coin of exactly the deposit's amount on 1,000 satoshis, the rest of the asset in one
 * more coin, and the BCH change. A wallet this page holds no key for approves it once. The deposit
 * then spends the coin, unconfirmed. `onSteps` hears its one step.
 */
export async function prepareDepositCoin(
  config: EngineConfig, poolId: string, wallet: EngineWallet,
  onProgress?: (message: string) => void, onSteps?: (progress: StepProgress) => void,
): Promise<{ txid?: string }> {
  const { raw } = poolOf(config, poolId);
  if (raw.kind !== 'token' || !raw.asset) throw new Notice('Only a token pool\'s deposit spends a coin of its asset.', true);
  const asset = raw.asset.toLowerCase();
  const amount = BigInt(raw.denomination);
  const units = (value: bigint) => `${unitsText(value, raw.decimals)} ${raw.symbol}`;
  const provider = new FulcrumProvider(config.network, connect(config).reader);
  const coins = await provider.getUtxos(wallet.address);
  if (coins.some(isDepositCoin(asset, amount))) return {};
  const lock = cashAddressToLockingBytecode(wallet.address);
  if (typeof lock === 'string') throw new Notice('This wallet\'s address is not one this page can pay.', true);
  const transfer = depositCoinTransfer(coins, asset, amount, lock.bytecode, signatureBytesOf(wallet));
  if ('short' in transfer) {
    throw new Notice(transfer.short === 'asset'
      ? `This wallet holds less than ${units(amount)} that a deposit can spend.`
      : `This wallet holds too little BCH to make the coin of ${units(amount)}.`, true);
  }
  const step: FlowStep = { id: 'prepare', title: `Prepare a coin of exactly ${units(amount)} for this deposit`, signs: true };
  const steps = new StepTracker(!wallet.privateKey, () => provider.broadcasts, onSteps, DEPOSIT_ORDER);
  steps.plan([step]);
  steps.start(step);
  onProgress?.(`Preparing a coin of exactly ${units(amount)} for this deposit…`);
  try {
    const txid = await sendSelfTransfer(provider, transfer, lock.bytecode, wallet, step.title, {
      asking: () => {
        steps.asking();
        onProgress?.(approving(step.title));
      },
      answered: () => steps.answered(),
    });
    await waitForOwnCoin(provider, wallet.address, txid, 0);
    steps.finish();
    return { txid };
  } catch (error) {
    steps.fail();
    if (refusedToSign(error)) throw new Notice('Your wallet did not approve the coin, so nothing was sent.', true);
    if ((error as Notice).notice) throw error;
    console.warn(error);
    // It only moves coins within the wallet, so whatever went out, trying again is safe.
    throw new Notice(provider.broadcasts > 0
      ? 'The coin may have been sent, but the server does not show it yet. Try again in a moment: if it went out, the deposit uses it.'
      : 'The coin could not be made, and nothing was sent. Check your connection and try again.', provider.broadcasts === 0);
  }
}

/**
 * Pay for the last step of adding a note to its pool, which its deposit prepaid, once nodes ask
 * more than that. Whoever pays it is tied to that deposit, so it is for the wallet that made the
 * deposit to pay, and never for the one that pays a withdrawal's fee. `mostTopUp` is what the
 * person was shown.
 */
export async function finishNote(
  config: EngineConfig, noteText: string, payer: EngineWallet, onProgress?: (message: string) => void,
  { mostTopUp, onSteps }: { mostTopUp?: bigint; onSteps?: (progress: StepProgress) => void } = {},
): Promise<{ hashed: boolean }> {
  const note = parseNote(noteText);
  const pool = await poolForNote(config, note);
  // The wallet that deposited pays this, so its own server reads the factories.
  await requireFactoryMade(config, connect(config).reader, pool.raw, 'withdrawal');
  if ((await viewOf(pool)).pending !== note.commitment) return { hashed: false };
  // The steps of paying the fee, its coins gathered first when no coin pays it alone.
  const steps = new StepTracker(!payer.privateKey, () => (pool.client.provider as FulcrumProvider).broadcasts, onSteps, FEE_ORDER);
  try {
    await finishHashing(pool, onProgress, payer, mostTopUp, steps);
  } catch (error) {
    if (steps.progress().total > 0) steps.fail();
    throw error;
  }
  if (steps.progress().total > 0) steps.finish();
  return { hashed: true };
}

/**
 * `paid` this recipient, `sent` and not yet shown, or `spent`, by what may be another
 * transaction. `paid` takes three things: the pool's Withdraw history holds this nullifier
 * hash, under any txid, since anyone who relays a withdrawal can change its txid and nothing it
 * does; that transaction pays this recipient one denomination; and the nullifier is spent in a
 * view the pool's own state reproduces. All of that still comes from one server, which could
 * keep the transaction to itself and show a pool that holds it, so the page never treats a
 * note as finished on this word: see ui.ts.
 */
export type WithdrawalOutcome = 'paid' | 'sent' | 'spent';

export interface WithdrawalOptions {
  /** A wallet the person chose to pay what nodes ask beyond the prepaid fee, and at most how much. */
  feeWallet?: EngineWallet;
  mostTopUp?: bigint;
  /**
   * Withdraw even from a pool no factory of this network made, which only a person who knows the
   * risk asks for: scripts/withdraw-note.ts takes it as --unlisted-pool. The page never does.
   */
  unlistedPool?: boolean;
  /** Hears the steps of `feeWallet` paying: its coins gathered first when no coin pays alone, then the fee. */
  onSteps?: (progress: StepProgress) => void;
}

/**
 * Pay a note to `recipient`. Its fee was prepaid, so it needs no wallet. Should nodes ever ask
 * more, `feeWallet` pays the rest, up to `mostTopUp`, with a coin that shows in the transaction,
 * so a page passes one only when the person chose to, and without one nothing is sent. It never
 * pays the note's own hashing, which would tie the deposit to the withdrawal: see `finishNote`.
 */
export async function withdraw(
  config: EngineConfig, noteText: string, recipient: string, onProgress?: (message: string) => void,
  proveWith: (input: Record<string, unknown>) => Promise<unknown> = (input) => prove(input, config.prover, onProgress),
  { feeWallet, mostTopUp, unlistedPool, onSteps }: WithdrawalOptions = {},
) {
  const note = parseNote(noteText);
  // The note names its pool, so this needs no list of pools, no indexer and nothing stored. All
  // of it is read through the withdrawal's own server, which the wallet's never hears of.
  const { payoutReader } = connect(config);
  const pool = await poolForNote(config, note, payoutReader);
  if (note.amount !== pool.client.pool.denomination) throw new Notice('This note is for another amount.');
  const lock = recipientLock(config, pool, recipient);
  // Before anything is built, the pool and the note's terms must be what its network's factory
  // made: a pool made elsewhere can be emptied by whoever made it, and a note's text cannot claim
  // another pool's amount or asset.
  if (!unlistedPool) await requireFactoryMade(config, payoutReader, pool.raw, 'withdrawal');

  onProgress?.('Reading the pool from the chain…');
  const { payout } = pool;
  // The pool pays any note in its tree at any stage, so only this note's own hashing has to
  // finish. Another note's, even one that can never finish, stops nothing here.
  if ((await viewOf(payout)).pending === note.commitment) await finishHashing(payout, onProgress);
  const spend = {
    nullifier: note.nullifier, secret: note.secret, commitment: note.commitment, nullifierHash: note.nullifierHash,
  };
  const proveAt = async () => payout.client.prove(spend, lock, await agreedView(config, pool), proveWith, onProgress);
  const nullifierHash = le32(note.nullifierHash);
  const spent = async () => (await viewOf(payout)).nullifiers.has(nullifierHash);
  const finished = (outcome: WithdrawalOutcome, tx?: { txid: string; size: number }) => ({
    accepted: true, outcome, poolId: note.poolId, txid: tx?.txid ?? '', size: tx?.size ?? 0,
    amount: pool.raw.denomination, recipient,
    pool: { symbol: pool.raw.symbol, decimals: pool.raw.decimals },
  });
  // A withdrawal is known by its nullifier hash, never its txid: what lands may be this page's
  // transaction with its txid changed on the way.
  const paying = () => payout.history.payment(nullifierHash, lock);
  /** A spent note: `paid` if what spent it pays this recipient, and `spent` if not. */
  const spentOutcome = async () => {
    const payment = await paying().catch(() => undefined);
    return payment ? finished('paid', payment) : finished('spent');
  };
  let proof = await proveAt();

  // A note pays once, so this can retry freely, whatever a server said went wrong. All
  // that is at stake is what the page ends up saying.
  onProgress?.('Sending the withdrawal…');
  const sending = new FulcrumProvider(config.network, (payout.client.provider as FulcrumProvider).reader);
  const sender = new PoolClient(definitionOf(pool.raw), sending);
  // The steps of a fee wallet's top-up, when nodes ask more than the pool prepaid.
  const steps = new StepTracker(!feeWallet?.privateKey, () => sending.broadcasts, onSteps, FEE_ORDER);
  let gathered = false;
  const attempts = async () => {
    for (let attempt = 0; attempt < MOST_ATTEMPTS; attempt += 1) {
      try {
        // A proof outlives up to 7 deposits landing after it was made, since it names a
        // recent root. Everything else the transaction names has to be read again now.
        const current = await viewOf(payout);
        if (attempt > 0 && current.nullifiers.has(nullifierHash)) return await spentOutcome();
        if (!payout.client.isFresh(proof, current)) {
          proof = await proveAt();
          continue;
        }
        const topUp = await topUpFor(
          sending, 'withdrawal', () => sender.withdrawalCall(proof, nullifierHash, lock, current),
          { payer: feeWallet, most: mostTopUp, onProgress, steps },
        );
        if (topUp?.gathered) gathered = true;
        const tx = await sender.submitWithdrawal(proof, nullifierHash, lock, current, topUp);
        if (topUp) steps.done('fee');
        onProgress?.('Waiting for the pool to show the withdrawal…');
        let payment: { txid: string; size: number } | undefined;
        const shown = async () => (payment = await paying()) !== undefined && spent();
        if (await eventually(shown)) return finished('paid', payment);
        if (await spent().catch(() => false)) return await spentOutcome();
        return finished('sent', { txid: tx.txid, size: tx.hex.length / 2 });
      } catch (error) {
        if (await spent().catch(() => false)) return await spentOutcome();
        // A person who refused to sign the fee has answered, and is not asked again.
        if (refusedToSign(error)) {
          throw new Notice(sending.broadcasts > 0 ? WITHDRAWAL_MAY_HAVE_LANDED : refusedFee(gathered), sending.broadcasts === 0 && !gathered);
        }
        // This page's own words are the last word only while nothing has left.
        if ((error as Notice).notice && sending.broadcasts === 0) throw error;
        await sleep(1_000);
      }
    }
    throw new Notice(sending.broadcasts > 0 ? WITHDRAWAL_MAY_HAVE_LANDED : 'The pool kept moving, so nothing was sent. Try again shortly.');
  };
  try {
    const result = await attempts();
    if (steps.progress().total > 0) steps.finish();
    return result;
  } catch (error) {
    if (steps.progress().total > 0) steps.fail();
    throw error;
  }
}

export interface WalletAssets {
  address: string;
  bch: string;
  tokens: Array<{
    category: string; symbol: string; decimals: number; name: string; amount: string;
    /** Of `amount`, what sits on coins that hold no NFT: what a deposit, or a coin made for one, can spend. */
    fungible: string;
    /** The most one coin holds that a deposit can spend alone: no NFT, and under 1,500 satoshis. */
    depositable: string;
  }>;
}

async function assetsFrom(fulcrum: Fulcrum, config: EngineConfig, address: string): Promise<WalletAssets> {
  const utxos = await fulcrum.listUnspent(scripthashOfAddress(address));
  let bch = 0n;
  const tokens = new Map<string, {
    category: string; symbol: string; decimals: number; name: string; amount: bigint; fungible: bigint; depositable: bigint;
  }>();
  for (const utxo of utxos) {
    bch += BigInt(utxo.value);
    if (!utxo.token_data || BigInt(utxo.token_data.amount) === 0n) continue;
    const known = config.pools.find((pool) => pool.asset === utxo.token_data!.category);
    const current = tokens.get(utxo.token_data.category) ?? {
      category: utxo.token_data.category,
      symbol: known?.symbol ?? utxo.token_data.category.slice(0, 8),
      decimals: known?.decimals ?? 0,
      name: known?.name ?? 'CashToken',
      amount: 0n,
      fungible: 0n,
      depositable: 0n,
    };
    const amount = BigInt(utxo.token_data.amount);
    current.amount += amount;
    if (!utxo.token_data.nft) {
      current.fungible += amount;
      if (BigInt(utxo.value) < DEPOSIT_COIN_LIMIT && amount > current.depositable) current.depositable = amount;
    }
    tokens.set(utxo.token_data.category, current);
  }
  return {
    address,
    bch: String(bch),
    tokens: [...tokens.values()].map((token) => ({
      ...token, amount: String(token.amount), fungible: String(token.fungible), depositable: String(token.depositable),
    })),
  };
}

export async function assets(config: EngineConfig, address: string) {
  return assetsFrom(connect(config).reader, config, address);
}

export interface TokenIdentity {
  category: string;
  name: string;
  symbol?: string;
  decimals?: number;
  icon?: string;
  description?: string;
  verified: boolean;
}

/** What each category's issuer published, from an index or the category's own authchain. */
export async function tokenIdentities(
  config: EngineConfig, categories: readonly string[],
): Promise<Record<string, TokenIdentity>> {
  const unique = [...new Set(categories.filter((category) => /^[0-9a-f]{64}$/i.test(category)))];
  if (unique.length === 0) return {};
  return resolveBcmrBatch(connect(config).reader, unique, { serviceUrl: config.bcmrServiceUrl });
}

export interface CreatePoolRequest {
  kind: PoolKind;
  denomination: bigint;
  name: string;
  symbol: string;
  decimals: number;
  asset?: string;
}

/** A creation's step in the step list: a transaction the wallet signs, under the words the wallet is shown. */
const creationStep = (step: PlannedCreationStep): FlowStep => ({
  id: step.id, title: step.prompt, signs: true, ...(step.earlier ? { earlier: true } : {}),
});

/**
 * What a creation that stopped sent, and what trying again does. A retry from this page goes on
 * from a prep that went out (factory.ts keeps it, and frees one that did not go out), and makes the
 * coins the steps before it made only if the wallet does not show them.
 */
const creationFailure = (
  { walletApproves, prepKept, deployerCoin }: { walletApproves: boolean; prepKept: boolean; deployerCoin: bigint },
): DescribeFailure => (failed, all, began) => {
  const made = all.some((entry) => entry !== failed && entry.state === 'done' && entry.sent > 0
    && (entry.step.id === 'seed' || entry.step.id === 'gather'));
  const madeBefore = made ? ' The coin made before it stays in your wallet, and trying again uses it.' : '';
  if (!failed) return { sent: 'Nothing was sent.', next: '' };
  if (failed.step.id === 'create') {
    const earlier = all.some((entry) => entry.step.id === 'prep' && entry.step.earlier);
    const only = walletApproves ? ', so your wallet is asked to approve only the creation' : '';
    const kept = `Try again from this page without reloading it: the next attempt spends that coin${only}. A reload forgets it, and a new attempt then leaves the ${deployerCoin.toLocaleString('en-US')} satoshis it holds behind.`;
    if (prepKept) {
      if (failed.sent === 0) return { sent: 'Nothing more was sent. The coin that names the pool, which went out with your earlier attempt, is kept.', next: kept };
      if (!earlier && failed.sent === 1) return { sent: 'The coin that names the pool went out, but the pool was not created.', next: kept };
      return {
        sent: 'The coin that names the pool went out, and the creation may have too.',
        next: `Refresh the pools first. If your pool is not listed, try again from this page without reloading it: the next attempt spends that coin${only}. A reload forgets it, and a new attempt then leaves the ${deployerCoin.toLocaleString('en-US')} satoshis it holds behind.`,
      };
    }
    if (failed.sent > 0) return { sent: 'A transaction went out, and the pool may have been created.', next: 'Refresh the pools before you try again.' };
    if (earlier || !began) return { sent: 'Nothing more was sent.', next: '' };
    return {
      sent: 'Nothing was sent. The coin that names the pool was signed but not sent, and the coins it would spend are free again.',
      next: walletApproves ? 'Trying again makes a new one, and asks your wallet to approve both again.' : 'Trying again makes a new one.',
    };
  }
  // The steps before the creation send only what moves coins within the wallet, and the prep goes out with the creation.
  if (!began) return { sent: `Nothing was sent.${madeBefore}`, next: '' };
  if (failed.sent > 0) {
    return { sent: 'Its transaction went out. It only moves coins within your wallet.', next: 'Trying again uses the coin it makes once your wallet shows it.' };
  }
  if (failed.step.id === 'prep') {
    return {
      sent: `Nothing was sent: the coin that names the pool is only signed at this step.${madeBefore}`,
      next: walletApproves ? 'Trying again asks your wallet to approve it again.' : 'Trying again starts from this step.',
    };
  }
  return { sent: `Nothing was sent at this step.${madeBefore}`, next: 'Trying again starts from this step.' };
};

/** The shared coins' top-up failing, once the pool stands. */
const sharedCoinsFailure = (refused: boolean): DescribeFailure => (failed) => {
  if (failed?.step.id !== 'shared') return undefined;
  return {
    sent: refused
      ? 'Your pool is created, but your wallet did not approve adding the shared hashing and verifier coins, so nothing more was sent.'
      : failed.sent > 0
        ? 'Your pool is created. The transaction adding the shared hashing and verifier coins went out, but this page cannot tell that it went through.'
        : 'Your pool is created, but the shared hashing and verifier coins were not added, and nothing more was sent.',
    next: 'Every pool shares those coins: the next pool created adds them if they are still short, and a deposit adds the hashing coins it needs.',
  };
};

/**
 * Make a pool from a wallet, through the network's factory of its kind. The pool's category is
 * the txid of a prep the wallet signs, which pays the factory's one-shot deployer coin, and a
 * token pool also opens with a coin of exactly one unit of its asset; the deployment module makes
 * the coins those spend first when the wallet has none. Each transaction the wallet is asked to
 * sign is named by its step, in the prompt and in `onProgress`.
 *
 * `onSteps` hears the steps: every transaction this creation sends, planned before the first, which
 * one is under way, and whether the wallet is being asked to approve it. A wallet this page holds no
 * key for approves each one in its own app. Once the pool stands, the shared coins' top-up failing
 * is said there and does not fail the creation: a retry would only meet the pool.
 */
export async function createPool(
  config: EngineConfig, request: CreatePoolRequest, wallet: EngineWallet,
  onProgress?: (message: string) => void, onSteps?: (progress: StepProgress) => void,
) {
  const { reader } = connect(config);
  const sending = new FulcrumProvider(config.network, reader);
  // Every transaction leaves through `sending`, so its count says what each step sent.
  const steps = new StepTracker(!wallet.privateKey, () => sending.broadcasts, onSteps, CREATION_ORDER);
  // One wallet request per transaction, each named by the work that transaction does.
  let prompt = 'Create a private pool';
  const signer = signerFor(
    wallet, sending,
    () => {
      steps.asking();
      onProgress?.(approving(prompt));
    },
    () => {
      steps.answered();
      onProgress?.(`Sending the transaction to ${prompt.toLowerCase()}…`);
    },
    () => prompt,
  );
  const factory = config.factories?.[request.kind];
  if (!factory) throw new Notice('This network has no factory for these pools yet.');
  onProgress?.('Finding the coins the pool needs…');
  const plan: PoolPlan = { id: 'new', ...request };
  const begin = (step: PoolCreationStep) => {
    prompt = step.prompt;
    steps.start(creationStep(step));
    onProgress?.(step.progress);
  };
  const through = (step: PoolCreationStep) => steps.done(step.id);
  let deployed: PoolPlan & { category: string };
  try {
    // A token pool's creation proves its slot in the factory's tree empty, so it needs the
    // factory's pools so far; the creation refuses a list that does not give the factory's root.
    const created = request.kind === 'token' ? await factoryPools(reader, 'token', factory, config.network) : [];
    steps.plan((await plannedCreationSteps(sending, signer, plan, factory)).map(creationStep));
    deployed = await createPoolWithSigner(sending, signer, plan, factory, created, begin, through);
  } catch (error) {
    steps.fail(creationFailure({
      walletApproves: !wallet.privateKey,
      prepKept: hasSentPrep(request.kind, factory, signer.getAddress()),
      deployerCoin: deployerCoinValue(request.kind),
    }));
    throw refusedToSign(error) ? new Notice('Your wallet did not approve this step.') : error;
  }
  try {
    await addSharedCoins(sending, signer, begin, through);
  } catch (error) {
    steps.fail(sharedCoinsFailure(refusedToSign(error)));
  }
  steps.finish();
  return { ...deployed, id: deployed.category, denomination: deployed.denomination.toString() };
}

// Follow the wallet address with a Fulcrum subscription. A WebSocket server pushes a new
// status; an HTTP endpoint cannot, so the page reloads the wallet after its own actions.
export async function watchAssets(
  config: EngineConfig,
  address: string,
  onChange: (assets: WalletAssets) => void,
): Promise<() => void> {
  const { reader } = connect(config);
  let last = '';
  let stopped = false;
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const emit = async () => {
    if (stopped) return;
    try {
      const next = await assetsFrom(reader, config, address);
      const key = JSON.stringify(next);
      if (key !== last) { last = key; onChange(next); }
    } catch { /* transient Fulcrum error; the next notification retries */ }
  };
  if (/^wss?:\/\//i.test(config.fulcrumUrl)) {
    try {
      unsubscribe = await reader.subscribeScripthash(scripthashOfAddress(address), () => { void emit(); });
      // A ping keeps the socket, and with it the subscription, alive across idle periods.
      keepAlive = setInterval(() => { void reader.call('server.ping').catch(() => undefined); }, 60_000);
    } catch { /* the page still reloads on its own actions */ }
  }
  void emit();
  return () => {
    stopped = true;
    unsubscribe?.();
    if (keepAlive) clearInterval(keepAlive);
  };
}

export { parseNote };
export { prepareProver } from './prover';
