// Make a pool through its factory, from a wallet: the browser's, a script's or a test's. The
// factory's `create` spends a one-shot coin that a prep transaction pays first, and the prep's
// txid becomes the pool's category; a token pool also needs a coin of exactly one unit of its
// asset. A wallet often has neither a coin large enough for the prep nor the one-unit coin, so
// this module makes them first and waits for them to appear. After the creation it tops up the
// hashing and verifier coins every pool shares, when they are short.
import { TransactionBuilder } from '@solidcash/solidcash';
import { genesisOutpointKey, isReservedGenesisOutpoint } from '@solidcash/solidcash/stateful';
import { cashAddressToLockingBytecode } from './libauth';
import { sidecarShortfall, topUpSidecars } from './pool-client';
import { connectFactory, createThroughFactory, hasSentPrep, type PoolCreated } from './factory';
import { isFree } from './self-transfer';
import { SEED_SATOSHIS, SEED_TOKENS, denominationRule, exponentOf, isPoolDenomination } from './pools';

export interface PoolPlan {
  id: string;
  kind: 'bch' | 'token';
  name: string;
  symbol: string;
  decimals: number;
  denomination: bigint;
  asset?: string;
}

/** The prep pays the factory's one-shot coin and the creation's author coin, with change to top up the shared coins. */
const PREP_SATOSHIS = 60_000n;
/** Room for the fee at 1 sat/B while the SDK sizes a change output. */
const FEE_ALLOWANCE = 2_000n;
/** A token change output carries its dust minimum in BCH. */
const TOKEN_CHANGE_RESERVE = 1_000n;
const COIN_WAIT_MS = 30_000;
const COIN_POLL_MS = 500;

/**
 * The transactions a creation can send, in the order they go: the one-unit token coin, a coin
 * gathered to pay for the prep, the prep, the creation, and the shared coins' top-up.
 */
export type CreationStepId = 'seed' | 'gather' | 'prep' | 'create' | 'shared';
export const CREATION_ORDER: readonly CreationStepId[] = ['seed', 'gather', 'prep', 'create', 'shared'];

/** The step a transaction belongs to, for the wallet prompt and the page's status. */
export interface PoolCreationStep {
  id: CreationStepId;
  /** What the wallet is asked to approve, e.g. "Create the new pool through its factory". */
  prompt: string;
  /** The same step as a status line, e.g. "Creating the new pool through its factory…". */
  progress: string;
}

const TOKEN_SEED_STEP: PoolCreationStep = {
  id: 'seed',
  prompt: 'Prepare the one-unit token coin for the new pool',
  progress: 'Preparing the one-unit token coin for the new pool…',
};
/** Only when no single coin covers the prep: this gathers several into one. */
const PREP_COIN_STEP: PoolCreationStep = {
  id: 'gather',
  prompt: 'Gather the coins that pay for the new pool',
  progress: 'Gathering the coins that pay for the new pool…',
};
/** The prep: its txid names the pool, and it pays the factory's one-shot deployer coin. */
const NAMING_STEP: PoolCreationStep = {
  id: 'prep',
  prompt: 'Create the coin that names the new pool',
  progress: 'Creating the coin that names the new pool…',
};
const CREATE_STEP: PoolCreationStep = {
  id: 'create',
  prompt: 'Create the new pool through its factory',
  progress: 'Creating the new pool through its factory…',
};
const SHARED_COINS_STEP: PoolCreationStep = {
  id: 'shared',
  prompt: 'Add the hashing and verifier coins every pool shares',
  progress: 'Adding the hashing and verifier coins every pool shares…',
};

/**
 * What is wrong with a plan. Each of these spends money that nothing can recover: a pool's
 * rules are fixed by its deployment, and a note that cannot be read or paid is lost.
 */
export function planProblems(plan: PoolPlan): string[] {
  const problems: string[] = [];
  // Notes an older page wrote carry a pool's id, and archives are read by it, so it stays in one form.
  if (typeof plan.id !== 'string' || !/^[a-z0-9]+$/.test(plan.id)) problems.push(`id "${plan.id}" must be a string of lowercase letters and digits`);
  if (!plan.name?.trim() || !plan.symbol?.trim()) problems.push('needs a name and a symbol');
  if (!Number.isInteger(plan.decimals) || plan.decimals < 0 || plan.decimals > 18) problems.push('decimals must be a whole number from 0 to 18');
  // The pool's constructor refuses any other denomination. The smallest BCH one is above the
  // 576 sat a P2SH32 payout needs to relay, and a full tree of the largest token one stays
  // under the CashToken limit.
  if (plan.kind === 'bch') {
    if (!isPoolDenomination('bch', plan.denomination)) problems.push(denominationRule('bch'));
    if (plan.asset !== undefined) problems.push('a BCH pool holds no asset');
  } else if (plan.kind === 'token') {
    if (!isPoolDenomination('token', plan.denomination)) problems.push(denominationRule('token'));
    if (!/^[0-9a-f]{64}$/.test(plan.asset ?? '')) problems.push('a token pool needs an asset, a category of 64 lowercase hex digits');
  } else problems.push(`kind "${plan.kind}" is neither bch nor token`);
  return problems;
}

/**
 * The same for a whole plan, before anything spends. A factory makes one pool of an amount, or of
 * an asset and amount, so a plan names each once: a second entry would be recorded under its own id
 * with the first one's pool.
 */
export function plansProblems(plans: PoolPlan[]): string[] {
  const named = plans.flatMap((plan) => planProblems(plan).map((problem) => `${plan.id}: ${problem}`));
  const ids = plans.map((plan) => plan.id);
  if (ids.length !== new Set(ids).size) named.push('two pools share an id, and a note names its pool by id');
  const amounts = new Map<string, string>();
  for (const plan of plans) {
    const amount = `${plan.kind} ${String(plan.denomination)} ${plan.asset ?? ''}`.trim();
    const first = amounts.get(amount);
    if (first !== undefined) named.push(`${plan.id}: the same amount as ${first}, and a factory makes one pool of an amount`);
    else amounts.set(amount, plan.id);
  }
  return named;
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const bySatoshis = (a: any, b: any) => Number(b.satoshis - a.satoshis);
const plain = (coins: any[]) => coins.filter((coin: any) => !coin.token);
const lockOf = (address: string): Uint8Array => {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
};

/** The coins, largest first, that together cover `needed` satoshis. Token coins are never spent here. */
function fundingFor(coins: any[], needed: bigint): any[] | undefined {
  const chosen: any[] = [];
  let total = 0n;
  for (const coin of plain(coins).sort(bySatoshis)) {
    chosen.push(coin);
    total += coin.satoshis;
    if (total >= needed) return chosen;
  }
  return undefined;
}

/** Wait for a sent transaction's output to be listed as a spendable coin. */
async function waitForCoin(
  signer: any, txid: string, vout: number, accept: (coin: any) => boolean, name: string,
): Promise<any> {
  const deadline = Date.now() + COIN_WAIT_MS;
  for (;;) {
    const coin = (await signer.getUtxos()).find((candidate: any) => (
      candidate.txid === txid && candidate.vout === vout && accept(candidate)
    ));
    if (coin) return coin;
    if (Date.now() >= deadline) throw new Error(`The ${name} coin was sent in ${txid}, but it is not visible yet.`);
    await pause(COIN_POLL_MS);
  }
}

/** The largest plain coin of at least `minimumSatoshis`, which a pool's prep can spend. */
export async function findPrepCoin(signer: any, minimumSatoshis: bigint = PREP_SATOSHIS): Promise<any> {
  // A coin a failed attempt reserved is not spendable until that attempt releases it; this
  // also keeps a stale reservation from making the next attempt reuse it.
  return plain(await signer.getUtxos())
    .filter((coin: any) => coin.satoshis >= minimumSatoshis
      && !isReservedGenesisOutpoint(genesisOutpointKey(coin.txid, coin.vout)))
    .sort(bySatoshis)[0];
}

/** A plain coin of at least `minimumSatoshis` for the prep, made by a self-transfer when the wallet has none. */
export async function ensurePrepCoin(
  provider: any, signer: any, minimumSatoshis: bigint, onStep?: (step: PoolCreationStep) => void,
): Promise<any> {
  const existing = await findPrepCoin(signer, minimumSatoshis);
  if (existing) return existing;
  const funding = fundingFor(await signer.getUtxos(), minimumSatoshis + FEE_ALLOWANCE);
  if (!funding) throw new Error(`This wallet has no plain BCH coin large enough to make the ${minimumSatoshis}-satoshi coin a pool's creation spends.`);
  onStep?.(PREP_COIN_STEP);
  const builder = new TransactionBuilder({ provider });
  for (const coin of funding) builder.addInput(coin, signer.unlockP2PKH());
  builder.addOutput({ to: signer.getAddress(), amount: minimumSatoshis });
  builder.addBchChangeOutputIfNeeded({ to: signer.getAddress(), feeRate: 1.0 });
  const { txid } = await builder.send();
  return waitForCoin(signer, txid, 0, (coin) => !coin.token && coin.satoshis >= minimumSatoshis, 'prep');
}

/** Whether a coin can open a token pool of `asset`: exactly one unit of it, no NFT, and the satoshis it needs. */
const isTokenSeed = (asset: string) => (coin: any): boolean => coin.token?.category === asset && !coin.token?.nft
  && coin.token.amount === SEED_TOKENS && coin.satoshis >= SEED_SATOSHIS;

/** The token container's opening coin: exactly one unit of the asset and no NFT. */
export async function ensureTokenSeed(
  provider: any, signer: any, asset: string, onStep?: (step: PoolCreationStep) => void,
): Promise<any> {
  const coins = await signer.getUtxos();
  const seedOf = isTokenSeed(asset);
  const existing = coins.find(seedOf);
  if (existing) return existing;

  // A larger coin of the asset is split, so the one-unit output leaves token change behind.
  const source = coins
    .filter((coin: any) => coin.token?.category === asset && !coin.token?.nft && coin.token.amount >= SEED_TOKENS)
    .sort((a: any, b: any) => (a.token.amount === b.token.amount ? bySatoshis(a, b) : (a.token.amount > b.token.amount ? -1 : 1)))[0];
  if (!source) throw new Error(`This wallet holds no coin of asset ${asset}; a token pool opens with a coin of exactly one unit.`);

  // A token output needs a locking bytecode: a CashAddress string may not say it is token-aware.
  const owner = lockOf(signer.getAddress());
  onStep?.(TOKEN_SEED_STEP);
  const builder = new TransactionBuilder({ provider });
  builder.addInput(source, signer.unlockP2PKH());
  builder.addOutput({ to: owner, amount: SEED_SATOSHIS, token: { category: asset, amount: SEED_TOKENS } });
  const hasChange = source.token.amount > SEED_TOKENS;
  if (hasChange) builder.addTokenChangeOutputIfNeeded({ category: asset, to: owner });

  const missing = SEED_SATOSHIS + (hasChange ? TOKEN_CHANGE_RESERVE : 0n) + FEE_ALLOWANCE - source.satoshis;
  if (missing > 0n) {
    const extras = fundingFor(coins.filter((coin: any) => coin !== source), missing);
    if (!extras) throw new Error(`The coin of ${asset} does not hold enough BCH to make the ${SEED_SATOSHIS}-satoshi seed coin.`);
    for (const coin of extras) builder.addInput(coin, signer.unlockP2PKH());
  }
  builder.addBchChangeOutputIfNeeded({ to: signer.getAddress(), feeRate: 1.0 });
  const { txid } = await builder.send();
  return waitForCoin(signer, txid, 0, seedOf, `${asset} seed`);
}

/** A step a creation expects to send. `earlier` marks a prep an earlier attempt sent: nothing is signed for it now. */
export type PlannedCreationStep = PoolCreationStep & { earlier?: true };

/**
 * The transactions a creation through `factoryCategory` will send, in order, as the wallet's coins
 * and the shared coins stand now, read before anything is signed: what `deployPoolWithSigner`
 * decides at each step, decided up front. The list can still change on the way, since the token
 * coin's transaction can spend the coin the prep would have, and someone else can add the shared
 * coins first. A prep that went out with an earlier attempt is listed as `earlier`, in its place.
 */
export async function plannedCreationSteps(
  provider: any, signer: any, plan: PoolPlan, factoryCategory: string,
): Promise<PlannedCreationStep[]> {
  const steps: PlannedCreationStep[] = [];
  if (plan.kind === 'token' && !(await signer.getUtxos()).some(isTokenSeed(plan.asset!))) steps.push(TOKEN_SEED_STEP);
  if (hasSentPrep(plan.kind, factoryCategory, signer.getAddress())) steps.push({ ...NAMING_STEP, earlier: true });
  else {
    if (!(await findPrepCoin(signer))) steps.push(PREP_COIN_STEP);
    steps.push(NAMING_STEP);
  }
  steps.push(CREATE_STEP);
  const short = await sidecarShortfall(provider);
  if (short.workers + short.verifiers > 0) steps.push(SHARED_COINS_STEP);
  return steps;
}

/**
 * Make a pool through the factory of category `factoryCategory`, and nothing after: every step
 * of `deployPoolWithSigner` but the shared coins. A token pool needs the factory's pools so far
 * (`created`, from its `PoolCreated` history), since its creation proves its slot empty; the
 * factory refuses a second pool of an amount, or of an asset and amount, whatever the wallet
 * tries. `onStep` hears each transaction the wallet is about to sign, and `onStepDone` hears it
 * through: sent, or for the prep, which goes out with the creation, signed.
 */
export async function createPoolWithSigner(
  provider: any, signer: any, plan: PoolPlan, factoryCategory: string, created: PoolCreated[] = [],
  onStep?: (step: PoolCreationStep) => void, onStepDone?: (step: PoolCreationStep) => void,
): Promise<PoolPlan & { category: string }> {
  const problems = planProblems(plan);
  if (problems.length) throw new Error(`Pool ${plan.id}: ${problems.join('; ')}.`);
  // A step a call below named is through once that call returns, or once the next step is named.
  let started: PoolCreationStep | undefined;
  const begin = (step: PoolCreationStep) => { started = step; onStep?.(step); };
  const end = () => {
    if (started) onStepDone?.(started);
    started = undefined;
  };

  // Make the token seed first, so the coin the prep spends is not spent to fund it.
  const tokenSeed = plan.kind === 'token' ? await ensureTokenSeed(provider, signer, plan.asset!, begin) : undefined;
  end();
  // A prep that went out with an earlier attempt that failed is spent by this one, so no coin is
  // made for a new prep (createThroughFactory).
  const prepCoin = hasSentPrep(plan.kind, factoryCategory, signer.getAddress())
    ? undefined : await ensurePrepCoin(provider, signer, PREP_SATOSHIS, begin);
  end();
  const factory = await connectFactory(plan.kind, factoryCategory, signer);
  const category = await createThroughFactory(factory, provider, signer, {
    kind: plan.kind, exponent: Number(exponentOf(plan.denomination)), prepCoin, created, factoryCategory,
    ...(plan.kind === 'token' ? { asset: plan.asset, tokenSeed } : {}),
  }, (step) => {
    end();
    begin(step === 'prep' ? NAMING_STEP : CREATE_STEP);
  });
  end();
  return { ...plan, category };
}

/**
 * Top up the hashing and verifier coins every pool shares, from the wallet's largest plain coin,
 * when they are short. Whether it sent anything.
 */
export async function addSharedCoins(
  provider: any, signer: any,
  onStep?: (step: PoolCreationStep) => void, onStepDone?: (step: PoolCreationStep) => void,
): Promise<boolean> {
  // The step is named before its unlocker is made, and only when there are coins to add. As many
  // of the wallet's plain coins as it takes pay for them.
  const short = await sidecarShortfall(provider);
  const funders = plain(await signer.getUtxos()).filter(isFree);
  if (funders.length === 0 || short.workers + short.verifiers === 0) return false;
  onStep?.(SHARED_COINS_STEP);
  await topUpSidecars(provider, { utxos: funders, unlocker: signer.unlockP2PKH(), change: signer.getAddress() });
  onStepDone?.(SHARED_COINS_STEP);
  return true;
}

/**
 * Make a pool through the factory of category `factoryCategory` (createPoolWithSigner), then top
 * up the coins every pool shares (addSharedCoins). `onStep` hears each transaction the wallet is
 * about to sign.
 */
export async function deployPoolWithSigner(
  provider: any, signer: any, plan: PoolPlan, factoryCategory: string, created: PoolCreated[] = [],
  onStep?: (step: PoolCreationStep) => void,
): Promise<PoolPlan & { category: string }> {
  const deployed = await createPoolWithSigner(provider, signer, plan, factoryCategory, created, onStep);
  await addSharedCoins(provider, signer, onStep);
  return deployed;
}
