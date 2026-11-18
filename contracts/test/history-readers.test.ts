// What the chain readers answer at a Fulcrum server's limits, and the faults a review of 9a1487c
// found in them (2026-11-17). The server is lib/fulcrum-stand-in.ts: Fulcrum as its source answers
// at its lowest max_history, 1,000, over the transactions of one pool made through its factory on
// the mock. Where code makes its own client from a URL, the stand-in serves over HTTP.
import { getDataNftAddress, getEventNftAddress } from '@solidcash/solidcash/stateful';
import { binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Fulcrum, HistoryLimit, wholeHistory } from '../../web/src/fulcrum';
import { OtherBytes } from '../../web/src/lineage';
import { ChainHistory } from '../../web/src/history';
import { connectFactory, factoryCoinLocks, factoryPools, poolCreatedLock } from '../../web/src/factory';
import { KeptTransactions, poolsToServe } from '../../web/src/listed-pools';
import { factoriesMade } from '../../web/src/listing';
import * as engine from '../../web/src/engine';
import { PoolClient, sidecarShortfall } from '../../web/src/pool-client';
import { FulcrumProvider } from '../../web/src/provider';
import { genesisProblems } from '../../scripts/lib/genesis';
import { Signer } from '@solidcash/solidcash';
import {
  bigIntToVmNumber, decodeAuthenticationInstructions, encodeDataPush, sha256, vmNumberToBigInt,
} from '@bitauth/libauth';
import { Discovery } from '../../indexer/discover';
import { ASSET, lockOf, poolOnMock, DENOMINATION } from './lib/setup';
import {
  fulcrumStandIn, padding, serveStandIn, txidOf, type StandInChain,
} from './lib/fulcrum-stand-in';

const decode = (hex: string) => decodeTransaction(hexToBin(hex)) as any;
/** An unlocking bytecode's pushes, and back, as the SDK writes them. */
const itemsOf = (unlocking: Uint8Array): Uint8Array[] => (decodeAuthenticationInstructions(unlocking) as any[]).map((instruction) => {
  if (instruction.data !== undefined) return instruction.data as Uint8Array;
  if (instruction.opcode >= 0x51 && instruction.opcode <= 0x60) return Uint8Array.of(instruction.opcode - 0x50);
  throw new Error(`not a push: ${instruction.opcode}`);
});
const unlockingOf = (items: Uint8Array[]): Uint8Array => Uint8Array.from(items.flatMap((item) => [...encodeDataPush(item)]));

// The page's transaction cache, IndexedDB in a browser and nothing in Node, watched here.
const { cached } = vi.hoisted(() => ({ cached: new Map<string, unknown>() }));
vi.mock('../../web/src/cache', () => ({
  cacheGet: async (key: string) => cached.get(key),
  cachePut: async (key: string, value: unknown) => { cached.set(key, value); },
  cacheHas: async (key: string) => cached.has(key),
  cacheClear: async () => { cached.clear(); },
}));

describe('the chain readers at a server\'s limits', () => {
  let pool: Awaited<ReturnType<typeof poolOnMock>>;
  let category: string;
  const sent = () => pool.transactions;
  /** The transaction that spends output 0 of `txid`'s: the genesis of category `txid`. */
  const spending = (txid: string) => sent().find((hex) => decode(hex).inputs
    .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === txid))!;
  const createdLock = () => poolCreatedLock('bch', pool.factory, 'regtest');
  const coinLocks = () => factoryCoinLocks('bch', pool.factory, 'regtest');

  beforeAll(async () => {
    pool = await poolOnMock('bch');
    category = pool.client.pool.category;
  }, 600_000);
  afterEach(() => { vi.restoreAllMocks(); });

  describe('/api/config\'s list, through the reader listed-pools.ts makes for its server', () => {
    const listed = { id: 'bch6', kind: 'bch' as const, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: DENOMINATION.toString() };
    let serial = 0;
    /** A deployment read through a stand-in served at a URL of its own, so nothing was seen through it before. */
    const deployedOn = async (chain: StandInChain) => {
      const served = await serveStandIn(fulcrumStandIn(chain));
      serial += 1;
      return {
        served,
        config: { network: 'regtest', fulcrumUrl: `${served.url}/${serial}`, factories: { bch: pool.factory }, pools: [{ ...listed, category }] },
      };
    };

    it('serves the factory\'s pool past an event address padded past the limit', async () => {
      const { served, config } = await deployedOn({ transactions: [...sent(), ...padding(createdLock())] });
      try {
        expect((await poolsToServe(config, [])).map((pool) => pool.category)).toEqual([category]);
        // From the factory's own chain: its coins, then its transactions by txid.
        expect(served.requests).toContain('blockchain.scripthash.listunspent');
      } finally {
        await served.close();
      }
    });

    it('keeps what it saw when every history it could read is past the limit, and never serves an empty list', async () => {
      const chain: StandInChain = { transactions: sent() };
      const { served, config } = await deployedOn(chain);
      try {
        expect((await poolsToServe(config, [])).map((pool) => pool.category)).toEqual([category]);
        chain.transactions = [...sent(), ...coinLocks().flatMap((lock) => padding(lock)), ...padding(createdLock())];
        const seen: string[][] = [];
        seen.push((await poolsToServe(config, [], { refresh: true })).map((pool) => pool.category));
        // Whatever a read in the background does meanwhile.
        for (let tries = 0; tries < 20; tries += 1) {
          await new Promise((resolve) => { setTimeout(resolve, 25); });
          seen.push((await poolsToServe(config, [])).map((pool) => pool.category));
        }
        expect(seen.every((categories) => categories.length === 1 && categories[0] === category)).toBe(true);
      } finally {
        await served.close();
      }
    });

    it('waits for a refresh to be read, so a request after one shows what that read found', async () => {
      const chain: StandInChain = { transactions: sent() };
      const { served, config } = await deployedOn(chain);
      try {
        expect(await poolsToServe({ ...config, pools: [] }, [])).toEqual([]);
        const asked = served.requests.length;
        await poolsToServe({ ...config, pools: [] }, [], { refresh: true });
        expect(served.requests.length).toBeGreaterThan(asked);
      } finally {
        await served.close();
      }
    });
  });

  describe('a reader that cannot name a lock\'s first transaction', () => {
    it('cannot vouch for an empty history: wholeHistory refuses it as the server\'s limit', async () => {
      const reader = { history: async () => [] };
      await expect(wholeHistory(reader, '00'.repeat(32))).rejects.toBeInstanceOf(HistoryLimit);
      // A history it shows is its server's whole confirmed part: Fulcrum cuts that part whole.
      expect(await wholeHistory({ history: async () => [{ tx_hash: 'aa'.repeat(32), height: 5 }] }, '00'.repeat(32)))
        .toEqual([{ tx_hash: 'aa'.repeat(32), height: 5 }]);
    });

    it('leaves factoryPools no way to read a padded event address as a factory with no pools', async () => {
      const full = fulcrumStandIn({ transactions: [...sent(), ...padding(createdLock())] });
      const before = { history: (scripthash: string) => full.history(scripthash), transaction: (txid: string) => full.transaction(txid) };
      await expect(factoryPools(before, 'bch', pool.factory, 'regtest')).rejects.toBeInstanceOf(HistoryLimit);
    });
  });

  describe('coins a server past its limit hides', () => {
    /** A pool client reading the stand-in through the page's own provider. */
    const clientOn = (chain: StandInChain) => {
      const reader = fulcrumStandIn(chain);
      const provider = new FulcrumProvider('regtest', reader);
      return { reader, provider, client: new PoolClient({ id: 'pool', kind: 'bch', denomination: DENOMINATION, category }, provider) };
    };
    const recordLock = () => lockOf(getDataNftAddress(pool.client.contract.inner, category));
    const masterLock = () => lockOf(pool.client.contract.address);

    it('are the server\'s limit at the pool\'s state record, not a broken pool', async () => {
      const deposits = lockOf(getEventNftAddress(pool.client.contract.inner, category, 'Deposit(uint32,bytes32)'));
      const { reader, client } = clientOn({ transactions: [...sent(), ...padding(recordLock())] });
      await expect(client.view(new ChainHistory(reader, client))).rejects.toBeInstanceOf(HistoryLimit);
      // The same with the events past the limit too, which the walk cannot get past without the record.
      const both = clientOn({ transactions: [...sent(), ...padding(recordLock()), ...padding(masterLock()), ...padding(deposits)] });
      await expect(both.client.view(new ChainHistory(both.reader, both.client))).rejects.toBeInstanceOf(HistoryLimit);
    });

    it('are the server\'s limit at the pool\'s master', async () => {
      const { provider } = clientOn({ transactions: [...sent(), ...padding(masterLock())] });
      await expect(provider.getUtxos(pool.client.contract.address)).rejects.toBeInstanceOf(HistoryLimit);
    });

    it('are the server\'s limit at the pool\'s satoshi coin', async () => {
      const satoshi = pool.client.contract.getSatoshiContainerAddress();
      const { provider } = clientOn({ transactions: [...sent(), ...padding(lockOf(satoshi))] });
      await expect(provider.getUtxos(satoshi)).rejects.toBeInstanceOf(HistoryLimit);
      // Unpadded, the pool's coin is there.
      expect((await clientOn({ transactions: sent() }).provider.getUtxos(satoshi)).length).toBe(1);
    });

    it('are the server\'s limit at the verifier and hashing locks every pool shares', async () => {
      const verifier = clientOn({ transactions: [...sent(), ...padding(pool.client.verifier.lock)] });
      await expect(verifier.client.coinsAt(pool.client.verifier.lock, 3)).rejects.toBeInstanceOf(HistoryLimit);
      await expect(sidecarShortfall(verifier.provider)).rejects.toBeInstanceOf(HistoryLimit);
      const hashing = clientOn({ transactions: [...sent(), ...padding(pool.client.workerLock)] });
      await expect(hashing.client.coinsAt(pool.client.workerLock, 10)).rejects.toBeInstanceOf(HistoryLimit);
      await expect(sidecarShortfall(hashing.provider)).rejects.toBeInstanceOf(HistoryLimit);
    });

    it('are not the server\'s limit where a shared lock was swept for real', async () => {
      // Anyone may sweep a verifier coin left unmoved for 1,440 blocks: a transaction that spends all three.
      const funding = sent().find((hex) => decode(hex).outputs
        .filter((output: any) => binToHex(output.lockingBytecode) === binToHex(pool.client.verifier.lock)).length === 3)!;
      const swept = binToHex(encodeTransaction({
        version: 2, locktime: 0,
        inputs: [0, 1, 2].map((outpointIndex) => ({ outpointTransactionHash: hexToBin(txidOf(funding)), outpointIndex, sequenceNumber: 1440, unlockingBytecode: new Uint8Array() })),
        outputs: [{ lockingBytecode: lockOf(pool.signers[3].getAddress()), valueSatoshis: 2_000n }],
      }));
      const { client, provider } = clientOn({ transactions: [...sent(), swept] });
      expect(await client.coinsAt(pool.client.verifier.lock, 3)).toEqual([]);
      expect((await sidecarShortfall(provider)).verifiers).toBe(3);
    });

    it('are not the server\'s limit where a shared lock holds only a miner\'s young reward', async () => {
      // A coinbase can pay any lock, and for 100 blocks nothing can spend it, so the provider
      // hides it. A lock whose only coins are those lists coins all the same: the server hides none.
      const funding = sent().find((hex) => decode(hex).outputs
        .filter((output: any) => binToHex(output.lockingBytecode) === binToHex(pool.client.verifier.lock)).length === 3)!;
      const swept = binToHex(encodeTransaction({
        version: 2, locktime: 0,
        inputs: [0, 1, 2].map((outpointIndex) => ({ outpointTransactionHash: hexToBin(txidOf(funding)), outpointIndex, sequenceNumber: 1440, unlockingBytecode: new Uint8Array() })),
        outputs: [{ lockingBytecode: lockOf(pool.signers[3].getAddress()), valueSatoshis: 2_000n }],
      }));
      const reward = binToHex(encodeTransaction({
        version: 2, locktime: 0,
        inputs: [{ outpointTransactionHash: new Uint8Array(32), outpointIndex: 0xffffffff, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of(0x51, 0x51) }],
        outputs: [{ lockingBytecode: pool.client.verifier.lock, valueSatoshis: 625_000_000n }],
      }));
      const { client } = clientOn({
        transactions: [...sent(), swept, reward], heights: new Map([[txidOf(reward), 95]]), tip: 100, coinbases: new Map([[95, txidOf(reward)]]),
      });
      expect(await client.coinsAt(pool.client.verifier.lock, 3)).toEqual([]);
    });

    it('are the server\'s limit at the factory\'s master and state record', async () => {
      const [master, record] = coinLocks();
      for (const lock of [master, record]) {
        const provider = new FulcrumProvider('regtest', fulcrumStandIn({ transactions: [...sent(), ...padding(lock)] }));
        const factory = await connectFactory('bch', pool.factory, provider);
        await expect(factory.getState().then(() => provider.getUtxosForLockingBytecode(lock))).rejects.toBeInstanceOf(HistoryLimit);
      }
    });
  });

  describe('a creation the server has under another txid', () => {
    const creation = () => spending(category);
    const factoryGenesis = () => txidOf(spending(pool.factory));
    /**
     * The creation with the factory's state record unlocked by flag OP_4 rather than OP_1, which
     * the chain takes (the VM below), so whoever relays or mines it can change its txid.
     */
    const resigned = () => {
      const tx = decode(creation());
      const record = tx.inputs.findIndex((input: any) => binToHex(input.unlockingBytecode.slice(0, 2)) === '0051');
      expect(record).toBe(1);
      const sourceOutputs = tx.inputs.map((input: any) => decode(sent().find((hex) => txidOf(hex) === binToHex(input.outpointTransactionHash))!)
        .outputs[input.outpointIndex]);
      tx.inputs[record] = { ...tx.inputs[record], unlockingBytecode: Uint8Array.from(tx.inputs[record].unlockingBytecode) };
      tx.inputs[record].unlockingBytecode[1] = 0x54;
      expect(createVirtualMachineBch2026(true).verify({ transaction: tx, sourceOutputs })).toBe(true);
      return binToHex(encodeTransaction(tx));
    };
    const quiet = () => {
      const logs: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
      vi.spyOn(console, 'error').mockImplementation((...parts) => { logs.push(parts.join(' ')); });
      return logs;
    };
    const archive = { add: () => undefined } as any;

    it('is found by the genesis check through its other leads', async () => {
      const reader = fulcrumStandIn({ transactions: sent() });
      expect(await genesisProblems(pool.client, reader, pool.factory, { creation: 'ff'.repeat(32) })).toEqual([]);
      const moved = fulcrumStandIn({ transactions: sent().map((hex) => (hex === creation() ? resigned() : hex)) });
      expect(await genesisProblems(pool.client, moved, pool.factory, { creation: txidOf(creation()) })).toEqual([]);
    });

    it('is still a problem when the server answers other bytes for the txid', async () => {
      const lying = fulcrumStandIn({ transactions: sent() }, { lies: new Map([[txidOf(creation()), resigned()]]) });
      expect(await genesisProblems(pool.client, lying, pool.factory, { creation: txidOf(creation()) }))
        .toEqual([`a server answered with other bytes for ${txidOf(creation())}`]);
    });

    it('is served by an indexer that saw the first txid in the mempool, and still once another is mined', async () => {
      quiet();
      // A genesis counts as soon as it is seen: the creation in the mempool, its factory one block deep.
      const chain: StandInChain = { transactions: sent(), heights: new Map([[txidOf(creation()), 0], [factoryGenesis(), 1]]), tip: 1 };
      const discovery = new Discovery('regtest', fulcrumStandIn(chain), [{ kind: 'bch', category: pool.factory }], undefined, archive);
      await discovery.start();
      discovery.stop();
      expect([...discovery.pools.keys()]).toEqual([category]);
      expect((discovery as any).pending.size).toBe(0);
      // The re-signed creation is mined instead; at the next block the indexer reads again.
      const moved = resigned();
      chain.transactions = sent().map((hex) => (hex === creation() ? moved : hex));
      chain.heights = new Map([[txidOf(moved), 2], [factoryGenesis(), 1]]);
      chain.tip = 2;
      await (discovery as any).rescan(discovery.factories[0]);
      expect([...discovery.pools.keys()]).toEqual([category]);
      expect(discovery.factories[0].created.get(category)?.txid).toBe(txidOf(moved));
    });

    it('is not lost by an indexer whose read of it failed once', async () => {
      quiet();
      const missing = new Set([txidOf(creation())]);
      // The factory's coins past the limit, so the indexer reads its event address.
      const chain: StandInChain = { transactions: [...sent(), ...coinLocks().flatMap((lock) => padding(lock))] };
      const discovery = new Discovery('regtest', fulcrumStandIn(chain, { missing }), [{ kind: 'bch', category: pool.factory }], undefined, archive);
      await discovery.start();
      expect(discovery.pools.size).toBe(0);
      missing.clear();
      await (discovery as any).rescan(discovery.factories[0]);
      discovery.stop();
      expect([...discovery.pools.keys()]).toEqual([category]);
    });
  });

  describe('a walk past a state record moved alone', () => {
    it('reads the input that held the record, not every input beside it', async () => {
      // Anyone can move a factory's state record alone, at any input index, so long as it comes
      // back at that index; here with 200 coins of a stranger's before it, each from a transaction
      // of its own. The VM takes the move.
      const K = 200;
      const stranger = new Signer(new Uint8Array(32).fill(0x33), pool.provider);
      const strangerLock = lockOf(stranger.getAddress());
      const parents = Array.from({ length: K }, (_, i) => binToHex(encodeTransaction({
        version: 2, locktime: 0,
        inputs: [{ outpointTransactionHash: sha256.hash(Uint8Array.from([0x70, i & 0xff, i >> 8])), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
        outputs: Array.from({ length: 101 }, () => ({ lockingBytecode: strangerLock, valueSatoshis: 2_000n })),
      })));
      const creation = spending(category);
      const created = decode(creation);
      const at = created.outputs.findIndex((output: any) => output.token?.nft?.capability === 'mutable' && binToHex(output.token.category) === pool.factory);
      const recordOutput = created.outputs[at];
      // The record's lock alone, flag 0: its commitment, lock, category and value kept.
      const alone = Uint8Array.from(created.inputs[1].unlockingBytecode);
      alone[1] = 0x00;
      const move: any = { version: 2, locktime: 0, inputs: [], outputs: [] };
      const sourceOutputs: any[] = [];
      for (const hex of parents) {
        move.inputs.push({ outpointTransactionHash: hexToBin(txidOf(hex)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() });
        sourceOutputs.push({ lockingBytecode: strangerLock, valueSatoshis: 2_000n });
        move.outputs.push({ lockingBytecode: strangerLock, valueSatoshis: 1_000n });
      }
      move.outputs[K - 1].valueSatoshis = BigInt(K) * 2_000n - 1_000n * BigInt(K - 1) - 60_000n;
      move.inputs.push({ outpointTransactionHash: hexToBin(txidOf(creation)), outpointIndex: at, sequenceNumber: 0, unlockingBytecode: alone });
      sourceOutputs.push(recordOutput);
      move.outputs.push({ ...recordOutput });
      move.inputs.forEach((input: any, inputIndex: number) => {
        if (inputIndex < K) input.unlockingBytecode = stranger.unlockP2PKH().generateUnlockingBytecode({ transaction: move, sourceOutputs, inputIndex });
      });
      expect(createVirtualMachineBch2026(true).verify({ transaction: move, sourceOutputs })).toBe(true);

      // With the factory's master past the limit, the walk starts from the record.
      const [master] = coinLocks();
      const reader = fulcrumStandIn({ transactions: [...sent(), ...parents, binToHex(encodeTransaction(move)), ...padding(master)] });
      expect(await factoryPools(reader, 'bch', pool.factory, 'regtest')).toEqual([{ category, exponent: 6, txid: txidOf(creation) }]);
      // The move, the creation and the factory's genesis.
      expect(reader.reads).toBe(3);
    });
  });

  describe('what a page says of a server past its limit', () => {
    const SWITCH = /Switch to another server/;
    /** The factory's coins and its event address both past the limit: nothing can answer but another server. */
    const capped = () => ({ transactions: [...sent(), ...coinLocks().flatMap((lock) => padding(lock)), ...padding(createdLock())] });
    const listedPool = () => ({ id: 'bch6', kind: 'bch' as const, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: DENOMINATION.toString(), category });
    const configOn = (url: string) => ({
      network: 'regtest', networkId: 'regtest', addressPrefix: 'bchreg', fulcrumUrl: url,
      pools: [listedPool()], factories: { bch: pool.factory }, prover: { circuitUrl: '', provingKeyUrl: '' },
    });

    it('is the server\'s limit when a factory cannot be read, kept beside the kinds left unread', async () => {
      const read = await factoriesMade(fulcrumStandIn(capped()), { bch: pool.factory }, 'regtest');
      expect(read.unread).toEqual(['bch']);
      expect(read.limits.bch).toBeInstanceOf(HistoryLimit);
    });

    it('asks for another server, not a connection check, when listing pools and before a deposit', async () => {
      const served = await serveStandIn(fulcrumStandIn(capped()));
      try {
        const listing = await engine.loadState(configOn(`${served.url}/list`)).catch((error) => error);
        expect(listing).toBeInstanceOf(HistoryLimit);
        const wallet = { address: pool.signers[1].getAddress(), signRequest: async () => { throw new Error('nothing is signed here'); } };
        const config = configOn(`${served.url}/deposit`);
        const refused = await engine.deposit(config, engine.newNote(listedPool(), 'regtest'), wallet).catch((error) => error);
        expect(refused.message).toMatch(SWITCH);
      } finally {
        await served.close();
      }
    });
  });

  describe('a history past the limit only by its mempool part', () => {
    it('is read whole: Fulcrum leaves that part out, and get_mempool counts it alone', async () => {
      // The event address holds the creation and 999 more confirmed entries, so 1,000: the limit.
      const confirmed = padding(createdLock(), 999);
      const pending = padding(createdLock(), 1)[0];
      const chain: StandInChain = { transactions: [...sent(), ...confirmed, pending], heights: new Map([[txidOf(pending), 0]]) };
      const reader = fulcrumStandIn(chain);
      const scripthash = binToHex(sha256.hash(createdLock()).slice().reverse());
      // What Fulcrum answers: the confirmed part, without the mempool's (src/Storage.cpp, getHistory).
      expect((await reader.history(scripthash)).some((entry: any) => entry.tx_hash === txidOf(pending))).toBe(false);
      const whole = await wholeHistory(reader, scripthash);
      expect(whole).toHaveLength(1_001);
      expect(whole.at(-1)).toEqual({ tx_hash: txidOf(pending), height: 0 });
    });

    it('is not taken for a whole one when get_first_use fails', async () => {
      const reader = {
        history: async () => [],
        firstUse: async () => { throw new Error('the server is busy'); },
      };
      await expect(wholeHistory(reader, '00'.repeat(32))).rejects.toThrow('the server is busy');
    });
  });

  describe('a server that answers other bytes for a txid', () => {
    const creation = () => spending(category);
    /** The creation as another valid transaction: its factory state record unlocked by flag OP_4. */
    const otherBytes = () => {
      const tx = decode(creation());
      tx.inputs[1] = { ...tx.inputs[1], unlockingBytecode: Uint8Array.from(tx.inputs[1].unlockingBytecode) };
      tx.inputs[1].unlockingBytecode[1] = 0x54;
      return binToHex(encodeTransaction(tx));
    };

    it('is refused by the page\'s client, and nothing of it is cached', async () => {
      const lies = new Map([[txidOf(creation()), otherBytes()]]);
      const served = await serveStandIn(fulcrumStandIn({ transactions: sent() }, { lies }));
      try {
        cached.clear();
        const fulcrum = new Fulcrum(served.url, 'review');
        await expect(fulcrum.transaction(txidOf(creation()))).rejects.toBeInstanceOf(OtherBytes);
        expect([...cached.keys()].some((key) => key.includes(txidOf(creation())))).toBe(false);
        // An honest answer is cached as before.
        const genesis = txidOf(spending(pool.factory));
        expect(await fulcrum.transaction(genesis)).toBe(spending(pool.factory));
        expect([...cached.keys()].some((key) => key.includes(genesis))).toBe(true);
      } finally {
        await served.close();
      }
    });

    it('is refused when factoryPools reads the event address', async () => {
      // The factory's coins past the limit, so its events come from the event address's history.
      const chain = { transactions: [...sent(), ...coinLocks().flatMap((lock) => padding(lock))] };
      const lying = fulcrumStandIn(chain, { lies: new Map([[txidOf(creation()), otherBytes()]]) });
      await expect(factoryPools(lying, 'bch', pool.factory, 'regtest')).rejects.toBeInstanceOf(OtherBytes);
      expect(await factoryPools(fulcrumStandIn(chain), 'bch', pool.factory, 'regtest'))
        .toEqual([{ category, exponent: 6, txid: txidOf(creation()) }]);
    });
  });

  describe('a walk past a creation with the factory\'s master after other inputs', () => {
    it('reads the input that held the master, not every input before it', async () => {
      // The chain lets a creation put the factory's master at any input index, after as many of
      // the builder's inputs and outputs, so long as the state record's unlocking names the
      // master's index and Deploy<C>'s names where the genesis and the author's coin moved to
      // (the factories' 2026-11-17 re-audit, finding 3). Here 50 of them, each from a transaction
      // of its own; the VM takes it.
      const n = 50;
      const alice = pool.signers[0];
      const own = lockOf(alice.getAddress());
      const parents = Array.from({ length: n }, (_, i) => binToHex(encodeTransaction({
        version: 2, locktime: 0,
        inputs: [{ outpointTransactionHash: sha256.hash(Uint8Array.from([0x71, i & 0xff, i >> 8])), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array() }],
        outputs: [{ lockingBytecode: own, valueSatoshis: 2_000n }],
      })));
      const creation = spending(category);
      const tx = decode(creation);
      const sourceOutputs = tx.inputs.map((input: any) => decode(sent().find((hex) => txidOf(hex) === binToHex(input.outpointTransactionHash))!)
        .outputs[input.outpointIndex]);
      tx.inputs.unshift(...parents.map((hex) => ({ outpointTransactionHash: hexToBin(txidOf(hex)), outpointIndex: 0, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() })));
      sourceOutputs.unshift(...parents.map(() => ({ lockingBytecode: own, valueSatoshis: 2_000n })));
      tx.outputs.unshift(...parents.map(() => ({ lockingBytecode: lockOf(pool.signers[2].getAddress()), valueSatoshis: 600n })));
      const record = itemsOf(tx.inputs[n + 1].unlockingBytecode);
      record[0] = bigIntToVmNumber(BigInt(n));
      tx.inputs[n + 1] = { ...tx.inputs[n + 1], unlockingBytecode: unlockingOf(record) };
      // Deploy<BchPool>'s genesisSidecarBase, genesisOutputBase and authorIndex.
      const deploy = itemsOf(tx.inputs[n + 2].unlockingBytecode);
      for (const at of [6, 7, 9]) deploy[at] = bigIntToVmNumber((vmNumberToBigInt(deploy[at]) as bigint) + BigInt(n));
      tx.inputs[n + 2] = { ...tx.inputs[n + 2], unlockingBytecode: unlockingOf(deploy) };
      tx.inputs.forEach((input: any, inputIndex: number) => {
        if (binToHex(sourceOutputs[inputIndex].lockingBytecode) !== binToHex(own)) return;
        input.unlockingBytecode = alice.unlockP2PKH().generateUnlockingBytecode({ transaction: tx, sourceOutputs, inputIndex });
      });
      expect(createVirtualMachineBch2026(true).verify({ transaction: tx, sourceOutputs })).toBe(true);

      const shifted = binToHex(encodeTransaction(tx));
      const reader = fulcrumStandIn({ transactions: [...sent().map((hex) => (hex === creation ? shifted : hex)), ...parents] });
      expect(await factoryPools(reader, 'bch', pool.factory, 'regtest')).toEqual([{ category, exponent: 6, txid: txidOf(shifted) }]);
      // The creation and the factory's genesis.
      expect(reader.reads).toBe(2);
    });
  });

  describe('a deposit\'s factory check, with one factory past its limit', () => {
    // A token factory nothing made, whose event address alone is past the limit.
    const TOKEN_FACTORY = 'ab'.repeat(32);
    const listedPool = () => ({ id: 'bch6', kind: 'bch' as const, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: DENOMINATION.toString(), category });
    const outsider = { id: 'cd', kind: 'bch' as const, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: DENOMINATION.toString(), category: 'cd'.repeat(32) };
    const wallet = () => ({ address: pool.signers[3].getAddress(), signRequest: async () => { throw new Error('nothing is signed here'); } });
    const depositOn = async (chain: StandInChain, into: typeof outsider) => {
      const served = await serveStandIn(fulcrumStandIn(chain));
      try {
        const config = {
          network: 'regtest', networkId: 'regtest', addressPrefix: 'bchreg', fulcrumUrl: `${served.url}/${into.id}`,
          pools: [listedPool(), outsider], factories: { bch: pool.factory, token: TOKEN_FACTORY }, prover: { circuitUrl: '', provingKeyUrl: '' },
        };
        return await engine.deposit(config, engine.newNote(into, 'regtest'), wallet()).catch((error) => error);
      } finally {
        await served.close();
      }
    };

    it('is decided by the pool\'s own kind: the token factory\'s limit stops no BCH deposit', async () => {
      const tokenCapped = { transactions: [...sent(), ...padding(poolCreatedLock('token', TOKEN_FACTORY, 'regtest'))] };
      // A pool the BCH factory made goes on past the check, to the wallet's funds.
      const made = await depositOn(tokenCapped, listedPool());
      expect(made.message).not.toMatch(/Switch to another server/);
      expect(made.message).toMatch(/This wallet holds/);
      // One it did not make is refused as such, not as the token factory's server limit.
      const other = await depositOn(tokenCapped, outsider);
      expect(other.message).toMatch(/not one this network's factories made/);
    });

    it('asks for another server when the factory of the pool\'s own kind is past its limit', async () => {
      const bchCapped = { transactions: [...sent(), ...coinLocks().flatMap((lock) => padding(lock)), ...padding(createdLock())] };
      const refused = await depositOn(bchCapped, outsider);
      expect(refused.message).toMatch(/Switch to another server/);
    });
  });

  describe('the transactions listed-pools.ts keeps', () => {
    it('are bounded by their bytes, the oldest dropped first', async () => {
      const hexOf = (byte: number, bytes: number) => byte.toString(16).padStart(2, '0').repeat(bytes);
      const kept = new KeptTransactions(1_000);
      let reads = 0;
      const read = async (txid: string) => { reads += 1; return hexOf(Number.parseInt(txid.slice(0, 2), 16), 400); };
      const [a, b, c] = ['0a', '0b', '0c'].map((byte) => byte.repeat(32));
      for (const txid of [a, b, a, b]) await kept.get(txid, read);
      expect(reads).toBe(2);
      await kept.get(c, read);
      // 1,200 bytes: the oldest, a, made way; b and c are still kept.
      expect(kept.bytes).toBe(800);
      for (const txid of [b, c]) await kept.get(txid, read);
      expect(reads).toBe(3);
      await kept.get(a, read);
      expect(reads).toBe(4);
      // A read that fails is not kept.
      await expect(kept.get('dd'.repeat(32), async () => { throw new Error('no such transaction'); })).rejects.toThrow('no such transaction');
      expect(await kept.get('dd'.repeat(32), read)).toBe(hexOf(0xdd, 400));
    });
  });
});


describe('a token pool\'s coin of the asset, past a server\'s limit', () => {
  let token: Awaited<ReturnType<typeof poolOnMock>>;
  beforeAll(async () => { token = await poolOnMock('token'); }, 600_000);

  it('is the server\'s limit, not a pool with no coin', async () => {
    const definition = { id: 'pool', kind: 'token' as const, denomination: DENOMINATION, category: token.client.pool.category, asset: ASSET };
    const address = token.client.contract.tokens[ASSET].address;
    const on = (transactions: string[]) => {
      const provider = new FulcrumProvider('regtest', fulcrumStandIn({ transactions }));
      void new PoolClient(definition, provider);
      return provider;
    };
    await expect(on([...token.transactions, ...padding(lockOf(address))]).getUtxos(address)).rejects.toBeInstanceOf(HistoryLimit);
    expect((await on(token.transactions).getUtxos(address)).filter((coin: any) => coin.token?.category === ASSET)).toHaveLength(1);
  });
});

