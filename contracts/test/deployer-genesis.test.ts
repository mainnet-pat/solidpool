// A pool made through BchPoolDeployer is read off chain by genesisProblems: its creation spends
// a one-shot deployer coin, so no later contract sees it. The factory's own genesis is read by
// factoryGenesisProblems, once: a second master kept there could mint any PoolCreated.
// Before SolidCash 0.51.0, `Deploy<BchPool>` let a creation pay the pool's state record or
// satoshi coin elsewhere, open the satoshi coin at 600 sat or open a second one; 0.51.0 refuses
// each on chain. Each case below is the SDK's own creation with one thing changed and the
// builder's coin signed again. The check has to find each one whatever the chain does, so the
// VM's verdict is printed, not asserted. The last part asks the reverse of the chain: that the
// check take every creation the chain takes, since a factory makes one pool of an amount.
import { Signer, TransactionBuilder } from '@solidcash/solidcash';
import { ContractFactory, buildDeployerPreps } from '@solidcash/solidcash/stateful';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import {
  binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hash256, hexToBin, sha256,
} from '@bitauth/libauth';
import { beforeAll, describe, expect, it } from 'vitest';
import bchDeployer from '../artifacts/solidcash/BchPoolDeployer.json';
import bchPool from '../artifacts/solidcash/BchPool.json';
import tokenDeployer from '../artifacts/solidcash/TokenPoolDeployer.json';
import tokenPool from '../artifacts/solidcash/TokenPool.json';
import { PoolClient } from '../../web/src/pool-client';
import { SEED_SATOSHIS, SEED_TOKENS } from '../../web/src/pools';
import { registryKey, registryPath, registryTree } from '../../web/src/factory';
import { factoryGenesisProblems, genesisProblems } from '../../scripts/lib/genesis';
import { ASSET, DENOMINATION, FOREIGN, lockOf } from './lib/setup';

/** DENOMINATION is 10^6, 0.01 BCH. */
const EXPONENT = 6n;
const key = (byte: number) => new Uint8Array(32).fill(byte);
const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());
const scripthashOf = (lock: Uint8Array) => binToHex(sha256.hash(lock).slice().reverse());
const decode = (hex: string) => decodeTransaction(hexToBin(hex)) as any;

/**
 * What Fulcrum would answer from these transactions. An address's history holds every
 * transaction that pays it or spends from it: a creation pays nothing to the deployer coin's
 * lock, and is found there because it spends that coin.
 */
function readerOf(transactions: string[], heightOf: (txid: string) => number) {
  const spentOutput = (input: any) => {
    const hex = transactions.find((candidate) => txidOf(candidate) === binToHex(input.outpointTransactionHash));
    return hex === undefined ? undefined : decode(hex).outputs[input.outpointIndex];
  };
  const touches = (hex: string, scripthash: string) => {
    const tx = decode(hex);
    return tx.outputs.some((output: any) => scripthashOf(output.lockingBytecode) === scripthash)
      || tx.inputs.some((input: any) => {
        const spent = spentOutput(input);
        return spent !== undefined && scripthashOf(spent.lockingBytecode) === scripthash;
      });
  };
  return {
    async history(scripthash: string) {
      return transactions.filter((hex) => touches(hex, scripthash)).map((hex) => ({ tx_hash: txidOf(hex), height: heightOf(txidOf(hex)) }));
    },
    async transaction(txid: string) {
      return transactions.find((hex) => txidOf(hex) === txid);
    },
  };
}

/**
 * One pool made through its kind's factory as deployer.test.ts and the app make it, and every
 * transaction the mock took.
 */
async function createPool(kind: 'bch' | 'token' = 'bch') {
  const provider: any = new MockNetworkProvider({ profile: 'production' });
  const alice = new Signer(key(0x55), provider);
  const sent: string[] = [];
  const broadcast = provider.sendRawTransaction.bind(provider);
  provider.sendRawTransaction = async (hex: string) => {
    const txid = await broadcast(hex);
    sent.push(hex);
    return txid;
  };
  // The coins the mock makes from nothing, by outpoint: the outputs a creation's inputs name.
  const seeded = new Map<string, any>();
  const seed = async (txid: string, satoshis: bigint, token?: { category: string; amount: bigint }) => {
    await provider.seedUtxo(alice.getAddress(), { txid, vout: 0, satoshis, ...(token ? { token } : {}) });
    seeded.set(`${txid}:0`, {
      lockingBytecode: lockOf(alice.getAddress()), valueSatoshis: satoshis,
      ...(token ? { token: { category: hexToBin(token.category), amount: token.amount } } : {}),
    });
  };
  await seed('a5'.repeat(32), 200_000n);
  await seed('b6'.repeat(32), 100_000n);
  // A token pool opens with one unit of its asset, from the creator's coin.
  if (kind === 'token') await seed('e8'.repeat(32), SEED_SATOSHIS, { category: ASSET, amount: SEED_TOKENS });
  // The factory's genesis spends a coin of a real transaction, so its check can read that
  // transaction: the mock's seeded coins come from nowhere.
  const builder = new TransactionBuilder({ provider });
  builder.addInput((await alice.getUtxos()).find((coin: any) => coin.txid === 'a5'.repeat(32))!, alice.unlockP2PKH());
  builder.addOutput({ to: alice.getAddress(), amount: 150_000n });
  builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
  const { txid: fundingTxid } = await builder.send();
  const fundingUtxo = (await alice.getUtxos()).find((coin: any) => coin.txid === fundingTxid && coin.vout === 0);
  const [deployer, child, childName] = kind === 'bch'
    ? [bchDeployer, bchPool, 'BchPool'] as const : [tokenDeployer, tokenPool, 'TokenPool'] as const;
  // The SDK types a creating call without its `deploy`.
  const factory: any = await new ContractFactory(deployer as any, alice)
    .deploy({ fundingUtxo, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress() } as any);
  factory.registerChild(child as any);
  const naming = (await alice.getUtxos()).find((coin: any) => coin.txid === 'b6'.repeat(32));
  const { preps } = await buildDeployerPreps({
    provider,
    children: [{ contractName: childName, deployer: (deployer as any).childDeployers[childName], authorValue: 20_000n }],
    fundingUtxos: [naming!],
    authorSigner: alice.unlockP2PKH(),
    authorLockingBytecode: alice.getLockingBytecode(),
    changeLockingBytecode: lockOf(alice.getAddress()),
  });
  const category: string = preps[0].category;
  const tokenSeed = (await alice.getUtxos()).find((coin: any) => coin.txid === 'e8'.repeat(32));
  const result = await (kind === 'bch'
    ? factory.create(EXPONENT)
    : factory.create(EXPONENT, hexToBin(ASSET), registryPath(registryTree([]), registryKey(ASSET, Number(EXPONENT))))
  ).deploy({
    deployerPreps: preps,
    funder: alice.unlockP2PKH(),
    changeAddress: alice.getAddress(),
    ...(kind === 'token' ? { childTokenContainers: [{ utxo: tokenSeed, unlocker: alice.unlockP2PKH() }] } : {}),
  });
  expect(result.childCategoryId).toBe(category);
  const creation = sent.find((hex) => decode(hex).inputs
    .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === category))!;
  const client = new PoolClient({
    id: 'pool', kind, denomination: DENOMINATION, category, ...(kind === 'token' ? { asset: ASSET } : {}),
  }, provider);
  const attacker = lockOf(new Signer(key(0x66), provider).getAddress());
  /** The output an input spends, from the mock's transactions or its seeded coins. */
  const sourceOf = (input: any) => {
    const outpoint = `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`;
    // A copy down to its token, so that a case that changes one changes it for that case alone.
    if (seeded.has(outpoint)) {
      const output = seeded.get(outpoint);
      return { ...output, ...(output.token ? { token: { ...output.token } } : {}) };
    }
    return { ...decode(sent.find((hex) => txidOf(hex) === binToHex(input.outpointTransactionHash))!).outputs[input.outpointIndex] };
  };
  return { kind, alice, sent, category, creator: factory.categoryId as string, creation, client, attacker, provider, sourceOf };
}
type Fixture = Awaited<ReturnType<typeof createPool>>;

const vm = createVirtualMachineBch2026(true);
/**
 * The creation with one thing changed, in it or in the outputs it spends, the builder's own coins
 * signed again, and what the chain says of it.
 */
function changed(pool: Fixture, change: (tx: any, sourceOutputs: any[]) => void) {
  const tx = decode(pool.creation);
  const sourceOutputs = tx.inputs.map(pool.sourceOf);
  change(tx, sourceOutputs);
  const own = binToHex(lockOf(pool.alice.getAddress()));
  tx.inputs.forEach((input: any, inputIndex: number) => {
    if (binToHex(sourceOutputs[inputIndex].lockingBytecode) !== own) return;
    input.unlockingBytecode = pool.alice.unlockP2PKH().generateUnlockingBytecode({ transaction: tx, sourceOutputs, inputIndex });
  });
  const verdict = vm.verify({ transaction: tx, sourceOutputs });
  return {
    hex: binToHex(encodeTransaction(tx)),
    chainTakesIt: verdict === true,
    verdict: verdict === true ? 'the chain takes it' : `the chain refuses it: ${verdict}`,
  };
}
/** genesisProblems on the mock's chain with this creation in place of the SDK's. */
const problemsOf = (pool: Fixture, creation: string, { creator = pool.creator, height = 1 }: { creator?: string; height?: number } = {}) => genesisProblems(
  pool.client,
  readerOf(pool.sent.map((hex) => (hex === pool.creation ? creation : hex)), (txid) => (txid === txidOf(creation) ? height : 1)),
  creator,
);

describe('the genesis check of a pool made through BchPoolDeployer', () => {
  let pool: Awaited<ReturnType<typeof createPool>>;
  beforeAll(async () => { pool = await createPool(); }, 600_000);

  const tampered = (change: (tx: any, sourceOutputs: any[]) => void) => changed(pool, change);
  const replaced = tampered;
  const problemsWith = (creation: string, options?: { creator?: string; height?: number }) => problemsOf(pool, creation, options);
  const satoshiLock = () => binToHex(lockOf(pool.client.contract.getSatoshiContainerAddress()));
  const satoshiCoin = (tx: any) => tx.outputs.find((output: any) => binToHex(output.lockingBytecode) === satoshiLock());
  const stateRecord = (tx: any) => tx.outputs.find((output: any) => output.token?.nft?.capability === 'mutable'
    && binToHex(output.token.category) === pool.category);

  it('finds nothing wrong with the SDK\'s creation, and finds its PoolCreated event', async () => {
    expect(await problemsWith(pool.creation)).toEqual([]);
  });

  // The factory's genesis: one master at the factory's lock, one state record that has made
  // nothing, the identity at output 0, and nothing else of its category.
  describe('the factory\'s own genesis', () => {
    const genesisOfFactory = () => pool.sent.find((hex) => decode(hex).inputs
      .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === pool.creator))!;
    const factoryProblemsWith = (change: (tx: any) => void, height = 1) => {
      const honest = genesisOfFactory();
      const tx = decode(honest);
      change(tx);
      const hex = binToHex(encodeTransaction(tx));
      return factoryGenesisProblems('bch', pool.creator, readerOf(pool.sent.map((candidate) => (candidate === honest ? hex : candidate)),
        (txid) => (txid === txidOf(hex) ? height : 1)), pool.provider);
    };
    const ofFactory = (output: any) => output.token && binToHex(output.token.category) === pool.creator;
    it('finds nothing wrong with the SDK\'s genesis', async () => {
      const found = await factoryProblemsWith(() => undefined); expect(found).toEqual([]);
    });
    it('finds a second master kept back', async () => {
      expect(await factoryProblemsWith((tx) => {
        tx.outputs.push({ ...tx.outputs.find((output: any) => ofFactory(output) && output.token.nft?.capability === 'minting'), lockingBytecode: pool.attacker });
      })).toEqual(['2 minting NFTs, not 1']);
    });
    it('finds a state record that says a pool was made', async () => {
      expect(await factoryProblemsWith((tx) => {
        // Output 0 is the identity; the other mutable NFT is the state record, `made` = 0.
        const record = tx.outputs.slice(1).find((output: any) => ofFactory(output) && output.token.nft?.capability === 'mutable');
        record.token.nft.commitment = Uint8Array.from([0x40]); // 2^6: a 0.01 BCH pool made already
      })).toEqual(['the state record is not that of a new factory']);
    });
    it('finds a second identity anchor', async () => {
      expect(await factoryProblemsWith((tx) => {
        tx.outputs.push({ ...tx.outputs.find((output: any) => ofFactory(output) && output.token.nft?.capability === 'none') });
      })).toEqual(['2 SCID anchors, not 1']);
    });
    // ContractFactory.deploy writes the anchor for a deployment a signer makes, as deploy-factories.ts makes it.
    it('finds a genesis with no identity anchor', async () => {
      expect(await factoryProblemsWith((tx) => {
        tx.outputs = tx.outputs.filter((output: any) => !(ofFactory(output) && output.token.nft?.capability === 'none'));
      })).toEqual(['0 SCID anchors, not 1']);
    });
    it('finds an NFT of the factory that is no anchor', async () => {
      expect(await factoryProblemsWith((tx) => {
        const anchor = tx.outputs.find((output: any) => ofFactory(output) && output.token.nft?.capability === 'none');
        tx.outputs.push({ ...anchor, token: { ...anchor.token, nft: { capability: 'none', commitment: Uint8Array.from([7]) } } });
      })).toEqual(['another NFT or token of the category']);
    });
    it('takes a genesis still in the mempool: nothing waits for blocks to bury it', async () => {
      expect(await factoryProblemsWith(() => undefined, 0)).toEqual([]);
    });
  });

  it('signs a changed creation as the SDK does', () => {
    const same = tampered(() => undefined);
    expect(same.chainTakesIt, same.verdict).toBe(true);
    expect(same.hex).toBe(pool.creation);
  });

  it('does not take another deployer\'s word for the pool', async () => {
    const other = 'c7'.repeat(32);
    expect(await problemsWith(pool.creation, { creator: other })).toEqual([`no PoolCreated event of ${other} in the genesis names this pool`]);
  });

  // The deployer's covenant pins its event, so this one is the check's own reading, not the chain's.
  it('does not take an event that names another pool', async () => {
    const { hex, verdict } = tampered((tx) => {
      const event = tx.outputs.find((output: any) => output.token?.nft?.capability === 'none' && binToHex(output.token.category) === pool.creator);
      event.token.nft.commitment[1] ^= 1; // The first byte of the category it names.
    });
    console.log(`an event naming another pool: ${verdict}`);
    expect(await problemsWith(hex, { creator: pool.creator })).toEqual([`no PoolCreated event of ${pool.creator} in the genesis names this pool`]);
  });

  it('takes a creation still in the mempool: nothing waits for blocks to bury it', async () => {
    expect(await problemsWith(pool.creation, { height: 0 })).toEqual([]);
  });

  const hostile: Array<[string, string, (tx: any) => void]> = [
    ['the state record paid to the builder', 'the state record is not at its lock', (tx) => {
      stateRecord(tx).lockingBytecode = pool.attacker;
    }],
    ['the satoshi coin paid to the builder', '0 satoshi coins, not 1', (tx) => {
      satoshiCoin(tx).lockingBytecode = pool.attacker;
    }],
    ['the satoshi coin opened at 600 sat', 'the satoshi coin holds 600 sat, under 1200', (tx) => {
      satoshiCoin(tx).valueSatoshis = 600n;
    }],
    ['a second coin at the satoshi coin\'s lock', '2 satoshi coins, not 1', (tx) => {
      tx.outputs.push({ lockingBytecode: hexToBin(satoshiLock()), valueSatoshis: 1_200n });
    }],
  ];
  for (const [label, problem, change] of hostile) {
    it(`finds ${label}`, async () => {
      const { hex, verdict } = tampered(change);
      console.log(`${label}: ${verdict}`);
      expect(await problemsWith(hex, { creator: pool.creator })).toEqual([problem]);
    });
  }

  // The factory's own covenant binds its `create` to a real creation: the one-shot deployer coin
  // whose prep's txid is the new category, the pool's genesis that coin's covenant pins, and one
  // PoolCreated naming it. Its uniqueness rests on this: a `create` that set `made` without a pool
  // being born would take an amount for nobody.
  const ofCategory = (output: any, category: string) => output.token && binToHex(output.token.category) === category;
  const binding: Array<[string, (tx: any, sourceOutputs: any[]) => void]> = [
    ['a plain coin of the builder\'s in the deployer coin\'s place', (tx, sourceOutputs) => {
      const at = tx.inputs.findIndex((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === pool.category);
      sourceOutputs[at] = { lockingBytecode: lockOf(pool.alice.getAddress()), valueSatoshis: sourceOutputs[at].valueSatoshis };
    }],
    ['the factory\'s state recording another amount as well', (tx) => {
      const record = tx.outputs.find((output: any) => ofCategory(output, pool.creator) && output.token.nft?.capability === 'mutable');
      record.token.nft.commitment = Uint8Array.from([0xc0]); // 2^6 + 2^7
    }],
    ['no PoolCreated', (tx) => {
      tx.outputs = tx.outputs.filter((output: any) => !(ofCategory(output, pool.creator) && output.token.nft?.capability === 'none'));
    }],
    ['a second PoolCreated', (tx) => {
      tx.outputs.push({ ...tx.outputs.find((output: any) => ofCategory(output, pool.creator) && output.token.nft?.capability === 'none') });
    }],
    ['no pool master', (tx) => {
      tx.outputs = tx.outputs.filter((output: any) => !(ofCategory(output, pool.category) && output.token.nft?.capability === 'minting'));
    }],
    ['a second pool master, kept by the builder', (tx) => {
      const master = tx.outputs.find((output: any) => ofCategory(output, pool.category) && output.token.nft?.capability === 'minting');
      tx.outputs.push({ ...master, lockingBytecode: pool.attacker });
    }],
  ];
  for (const [label, change] of binding) {
    it(`is refused by the chain: ${label}`, () => {
      const { chainTakesIt, verdict } = replaced(change);
      console.log(`${label}: ${verdict}`);
      expect(chainTakesIt, verdict).toBe(false);
    });
  }

  // A creation spends the prep's two coins: the deployer coin and, beside it, the author's coin at
  // output 1. The check reads what a creation makes, not what funds it, so here the chain is the
  // only judge: since SolidCash 0.51.0, `Deploy<C>` refuses a creation without the author's coin.
  it('is backed by the chain on a creation without its author\'s coin', () => {
    const { chainTakesIt, verdict } = tampered((tx) => {
      const author = tx.inputs.find((input: any) => input.outpointIndex === 1 && binToHex(input.outpointTransactionHash) === pool.category);
      // Another coin at the author's lock, worth the same, in its place.
      author.outpointTransactionHash = hexToBin('cc'.repeat(32));
      author.outpointIndex = 0;
    });
    console.log(`the author's coin replaced by another: ${verdict}`);
    expect(chainTakesIt).toBe(false);
  });

  // The control for 600 sat. An honest creation may open the coin above 1,200 sat. Since
  // SolidCash 0.51.0 the chain takes one at 1,201 too; before, `Deploy<C>`'s comparison was
  // reversed and refused it.
  it('takes a satoshi coin above 1,200 sat', async () => {
    const { hex, verdict } = tampered((tx) => { satoshiCoin(tx).valueSatoshis = 1_201n; });
    console.log(`the satoshi coin opened at 1,201 sat: ${verdict}`);
    expect(await problemsWith(hex, { creator: pool.creator })).toEqual([]);
  });
});

// A factory makes one pool of an amount, or of an asset and amount. A creation the chain takes and
// the check refuses would squat that amount for good: the factory refuses a second pool, and no
// page or indexer lists the first. So here, unlike above, the chain's verdict decides: whatever
// the chain takes, the check must take too. Each case is the SDK's creation with one thing added
// or changed, as a builder who wants the amount dead would send it.
describe.each(['bch', 'token'] as const)('a squat on the %s factory: what the chain takes, the check takes', (kind) => {
  let pool: Fixture;
  beforeAll(async () => { pool = await createPool(kind); }, 600_000);

  const ofPool = (output: any) => output.token && binToHex(output.token.category) === pool.category;
  const master = (tx: any) => tx.outputs.find((output: any) => ofPool(output) && output.token.nft?.capability === 'minting');
  const record = (tx: any) => tx.outputs.find((output: any) => ofPool(output) && output.token.nft?.capability === 'mutable');
  const at = (tx: any, address: string) => tx.outputs.find((output: any) => binToHex(output.lockingBytecode) === binToHex(lockOf(address)));
  const satoshiCoin = (tx: any) => at(tx, pool.client.contract.getSatoshiContainerAddress());
  const tokenCoin = (tx: any) => at(tx, pool.client.contract.tokens[ASSET].address);
  // The SDK's creation has no change: the author's coin pays it, and what is left is its fee, far
  // more than anything added here.
  const toBuilder = (token: any) => (tx: any) => {
    tx.outputs.push({ lockingBytecode: pool.attacker, valueSatoshis: 1_000n, token });
  };
  /** One more coin of the builder's, signed with the rest. */
  const addCoin = (tx: any, sourceOutputs: any[], output: any) => {
    tx.inputs.push({ outpointTransactionHash: hexToBin('f1'.repeat(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() });
    sourceOutputs.push({ lockingBytecode: lockOf(pool.alice.getAddress()), ...output });
  };
  const assetInput = (sourceOutputs: any[]) => sourceOutputs.findIndex((output: any) => output.token && binToHex(output.token.category) === ASSET);
  const category = () => hexToBin(pool.category);

  const squats: Array<[string, (tx: any, sourceOutputs: any[]) => void]> = [
    ['fungible tokens of the new category, paid to the builder', (tx) => toBuilder({ category: category(), amount: 1_000n })(tx)],
    ['an immutable NFT of the new category, paid to the builder', (tx) => toBuilder({ category: category(), amount: 0n, nft: { capability: 'none', commitment: Uint8Array.from([1]) } })(tx)],
    ['a second mutable NFT of the new category, paid to the builder', (tx) => toBuilder({ category: category(), amount: 0n, nft: { capability: 'mutable', commitment: record(tx).token.nft.commitment } })(tx)],
    ['the pool master paid to the builder', (tx) => { master(tx).lockingBytecode = pool.attacker; }],
    ['a fungible amount on the pool master', (tx) => { master(tx).token.amount = 1_000n; }],
    ['a fungible amount on the state record', (tx) => { record(tx).token.amount = 1_000n; }],
    ['a commitment on the pool master', (tx) => { master(tx).token.nft.commitment = Uint8Array.from([1]); }],
    ['the pool master at 1,000 sat', (tx) => { master(tx).valueSatoshis = 1_000n; }],
    ['the state record at 1,000 sat', (tx) => { record(tx).valueSatoshis = 1_000n; }],
    ['the state record holding another state', (tx) => { const nft = record(tx).token.nft; nft.commitment = Uint8Array.from([...nft.commitment.slice(0, -1), nft.commitment.at(-1) ^ 1]); }],
    ['tokens of the new category on the satoshi coin', (tx) => { satoshiCoin(tx).token = { category: category(), amount: 1n }; }],
    ['a token of another category on the satoshi coin', (tx, sourceOutputs) => {
      addCoin(tx, sourceOutputs, { valueSatoshis: 1_000n, token: { category: hexToBin(FOREIGN), amount: 5n } });
      satoshiCoin(tx).token = { category: hexToBin(FOREIGN), amount: 5n };
    }],
    ...(kind === 'token' ? [
      ['the token coin opened with 2 units', (tx: any, sourceOutputs: any[]) => {
        sourceOutputs[assetInput(sourceOutputs)].token.amount = 2n;
        tokenCoin(tx).token.amount = 2n;
      }],
      ['the token coin opened with all but 2^60 units a token can have', (tx: any, sourceOutputs: any[]) => {
        sourceOutputs[assetInput(sourceOutputs)].token.amount = 2n ** 63n - 1n - 2n ** 60n;
        tokenCoin(tx).token.amount = 2n ** 63n - 1n - 2n ** 60n;
      }],
      ['the token coin opened at 1,000 sat', (tx: any) => { tokenCoin(tx).valueSatoshis = 1_000n; }],
      ['the token coin holding another token', (tx: any, sourceOutputs: any[]) => {
        sourceOutputs[assetInput(sourceOutputs)].token.category = hexToBin(FOREIGN);
        tokenCoin(tx).token.category = hexToBin(FOREIGN);
      }],
      ['an NFT of the asset on the token coin', (tx: any, sourceOutputs: any[]) => {
        const nft = { capability: 'none', commitment: Uint8Array.from([9]) };
        sourceOutputs[assetInput(sourceOutputs)].token.nft = nft;
        tokenCoin(tx).token.nft = nft;
      }],
      // `Deploy<C>` reads the token coin's category as the asset's 32 bytes, which a mutable or
      // minting NFT would lengthen, and its commitment as empty, so an immutable NFT with no
      // commitment can ride beside the unit, brought in by whoever holds one of the asset's NFTs.
      ...(['none', 'mutable', 'minting'] as const).map((capability): [string, (tx: any, sourceOutputs: any[]) => void] => [
        `an immutable NFT of the asset with no commitment on the token coin, from a ${capability === 'none' ? 'plain' : capability} one`,
        (tx: any, sourceOutputs: any[]) => {
          addCoin(tx, sourceOutputs, { valueSatoshis: 1_000n, token: { category: hexToBin(ASSET), amount: 0n, nft: { capability, commitment: new Uint8Array() } } });
          tokenCoin(tx).token.nft = { capability: 'none', commitment: new Uint8Array() };
        },
      ]),
      ['no token coin, its unit burned', (tx: any) => { tx.outputs = tx.outputs.filter((output: any) => output !== tokenCoin(tx)); }],
      ['a second coin at the token coin\'s lock', (tx: any) => {
        tx.outputs.push({ lockingBytecode: tokenCoin(tx).lockingBytecode, valueSatoshis: 1_200n });
      }],
      ['a second coin of the asset at the token coin\'s lock', (tx: any, sourceOutputs: any[]) => {
        addCoin(tx, sourceOutputs, { valueSatoshis: 1_200n, token: { category: hexToBin(ASSET), amount: 1n } });
        tx.outputs.push({ lockingBytecode: tokenCoin(tx).lockingBytecode, valueSatoshis: 1_200n, token: { category: hexToBin(ASSET), amount: 1n } });
      }],
    ] as Array<[string, (tx: any, sourceOutputs: any[]) => void]> : []),
  ];

  it('starts from a creation the check takes', async () => {
    expect(await problemsOf(pool, pool.creation)).toEqual([]);
  });
  for (const [label, change] of squats) {
    it(label, async () => {
      const { hex, chainTakesIt, verdict } = changed(pool, change);
      // These the chain is known to take, so their case is no pass by default.
      if (/opened with|no commitment on the token coin/.test(label)) expect(chainTakesIt, verdict).toBe(true);
      const problems = chainTakesIt ? await problemsOf(pool, hex) : [];
      console.log(`${kind}: ${label}: ${verdict}${problems.length > 0 ? `, and the check finds: ${problems.join('; ')}` : ''}`);
      expect(problems, `${label}: ${verdict}`).toEqual([]);
    });
  }
});
