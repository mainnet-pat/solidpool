// Every history the app relies on, read past a server's limit. Fulcrum counts every confirmed
// transaction of a lock against its `max_history` before it looks at any height, and past it
// answers `get_history` as if the lock had none (src/Storage.cpp, Storage::getHistory), and
// `listunspent` the same way past as many unspent coins (Storage::listUnspent). Its
// `get_first_use` reads the first entry alone, with no limit (Storage::getFirstUse). Anyone can
// pay a lock plain coins until it passes, so the server below is that Fulcrum at its lowest
// allowed limit, 1,000, over the transactions of one pool made through its factory on the mock:
// two deposits and a withdrawal. Each case pads a lock past the limit, or pays one first, and
// asks for what the app asks.
//
// The same readers count a `PoolCreated` only where the factory's `create` writes it. A creation
// can also mint an NFT of the factory's category at a bare OP_1 lock, which the factory's census
// leaves out, with a commitment naming any pool, and anyone can then pay it to the event address,
// even in a pool's genesis that no factory ran. The chain took both shapes from the factories as
// they were on 2026-11-17 (the bytecode audit ran them in the VM), and what is on chain stays; a
// reader refuses them from any factory. Here they are read, not sent.
import { Signer } from '@solidcash/solidcash';
import { getDataNftAddress, getEventNftAddress } from '@solidcash/solidcash/stateful';
import { binToHex, decodeTransaction, encodeTransaction, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HistoryLimit, type FulcrumUtxo } from '../../web/src/fulcrum';
import { ChainHistory } from '../../web/src/history';
import {
  connectFactory, deployerCoinLock, factoryCoinLocks, factoryPools, poolCreatedLock, registryTree,
} from '../../web/src/factory';
import { le32 } from '../../web/src/pool-client';
import { factoryGenesisProblems, genesisProblems } from '../../scripts/lib/genesis';
import { proveStatement } from '../../service/lib/verifier';
import { Discovery } from '../../indexer/discover';
import { lockOf, newSpend, poolOnMock } from './lib/setup';

/** Fulcrum's lowest `max_history`: past it a lock reads as having no history. */
const MAX_HISTORY = 1_000;
const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());
const scripthashOf = (lock: Uint8Array) => binToHex(sha256.hash(lock).slice().reverse());
const decode = (hex: string) => decodeTransaction(hexToBin(hex)) as any;

let junkCount = 0;
/** A stranger's transaction paying 1,000 sat to each of `locks`. */
const junk = (...locks: Uint8Array[]) => {
  junkCount += 1;
  return binToHex(encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [{
      outpointTransactionHash: sha256.hash(Uint8Array.from([...new TextEncoder().encode('junk'), ...le32(BigInt(junkCount))])),
      outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(),
    }],
    outputs: locks.map((lockingBytecode) => ({ lockingBytecode, valueSatoshis: 1_000n })),
  }));
};
/** `count` of them at `lock`: past the limit when `count` passes it. */
const padding = (lock: Uint8Array, count = MAX_HISTORY + 1) => Array.from({ length: count }, () => junk(lock));

type Method = 'firstUse' | 'listUnspent' | 'transactionHeight';

/**
 * Fulcrum over these transactions, in this order, each confirmed at height 1 of a chain 100
 * blocks long, with a `max_history` of 1,000. `without` leaves methods out, as a server before
 * Fulcrum 1.10, or a stand-in for one, has none of them.
 */
function fulcrumOf(transactions: string[], { without = [] as Method[] } = {}) {
  const byTxid = new Map(transactions.map((hex) => [txidOf(hex), hex]));
  const decoded = new Map(transactions.map((hex) => [txidOf(hex), decode(hex)]));
  const touching = new Map<string, string[]>();
  const spent = new Set<string>();
  const touch = (lock: Uint8Array, txid: string) => {
    const list = touching.get(scripthashOf(lock)) ?? [];
    if (list.at(-1) !== txid) list.push(txid);
    touching.set(scripthashOf(lock), list);
  };
  for (const [txid, tx] of decoded) {
    for (const input of tx.inputs) {
      const parent = binToHex(input.outpointTransactionHash);
      spent.add(`${parent}:${input.outpointIndex}`);
      const output = decoded.get(parent)?.outputs[input.outpointIndex];
      if (output) touch(output.lockingBytecode, txid);
    }
    for (const output of tx.outputs) touch(output.lockingBytecode, txid);
  }
  const reader: any = {
    url: 'ws://fulcrum.test',
    calls: [] as string[],
    async history(scripthash: string, fromHeight = 0) {
      reader.calls.push('history');
      const list = touching.get(scripthash) ?? [];
      return list.length > MAX_HISTORY ? [] : list.map((tx_hash) => ({ tx_hash, height: 1 })).filter((entry) => entry.height >= fromHeight);
    },
    async firstUse(scripthash: string) {
      const [first] = touching.get(scripthash) ?? [];
      return first === undefined ? null : { tx_hash: first, height: 1 };
    },
    async listUnspent(scripthash: string): Promise<FulcrumUtxo[]> {
      const coins: FulcrumUtxo[] = [];
      for (const [txid, tx] of decoded) {
        tx.outputs.forEach((output: any, vout: number) => {
          if (spent.has(`${txid}:${vout}`) || scripthashOf(output.lockingBytecode) !== scripthash) return;
          const { token } = output;
          coins.push({
            tx_hash: txid, tx_pos: vout, height: 1, value: Number(output.valueSatoshis),
            ...(token ? { token_data: {
              category: binToHex(token.category), amount: String(token.amount),
              ...(token.nft ? { nft: { capability: token.nft.capability, commitment: binToHex(token.nft.commitment) } } : {}),
            } } : {}),
          });
        });
      }
      return coins.length > MAX_HISTORY ? [] : coins;
    },
    async transaction(txid: string) {
      const hex = byTxid.get(txid);
      if (hex === undefined) throw new Error('No transaction matching the requested hash was found');
      return hex;
    },
    async transactionHeight(txid: string) {
      if (!byTxid.has(txid)) throw new Error('No transaction matching the requested hash was found');
      return 1;
    },
    async call(method: string) {
      if (method === 'blockchain.headers.get_tip') return { height: 100 };
      if (method === 'blockchain.transaction.id_from_pos') return '00'.repeat(32);
      return null;
    },
    async subscribeScripthash() { return () => undefined; },
    async subscribeHeaders() { return () => undefined; },
  };
  for (const method of without) delete reader[method];
  return reader;
}

/** Only what a reader had before this: a lock's history and transactions by txid. */
const historyOnly: Method[] = ['firstUse', 'listUnspent', 'transactionHeight'];

/** The transaction among these that spends output 0 of `txid`'s: the genesis of category `txid`. */
const spendingFrom = (transactions: string[], txid: string) => transactions.find((hex) => decode(hex).inputs
  .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === txid))!;

/**
 * A pool's creation as the chain also takes it: with one more output, an NFT of the factory's
 * category at a bare OP_1 lock, whose commitment is the creation's own `PoolCreated` naming the
 * category ee..ee instead. Then the transaction that pays that NFT to the event address, which
 * anyone can send, since OP_1 is all its lock asks.
 */
function forgedEvent(creation: string, factory: string, eventLock: Uint8Array): { forged: string; move: string } {
  const tx = decode(creation);
  const event = tx.outputs.find((output: any) => binToHex(output.lockingBytecode) === binToHex(eventLock)
    && output.token?.nft?.capability === 'none');
  const commitment = Uint8Array.from(event.token.nft.commitment);
  commitment.set(hexToBin('ee'.repeat(32)), 1);
  const nft = { category: hexToBin(factory), amount: 0n, nft: { capability: 'none', commitment } };
  tx.outputs.push({ lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 1_000n, token: nft });
  const forged = binToHex(encodeTransaction(tx));
  const move = binToHex(encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [{ outpointTransactionHash: hexToBin(txidOf(forged)), outpointIndex: tx.outputs.length - 1, sequenceNumber: 0xfffffffe, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: eventLock, valueSatoshis: 800n, token: nft }],
  } as any));
  return { forged, move };
}

describe('history reach', () => {
  let pool: Awaited<ReturnType<typeof poolOnMock>>;
  let category: string;
  /** The transaction that made the pool, the one the factory's genesis, and the factory's category's own. */
  let creation: string;
  let factoryGenesis: string;
  let deployerLock: Uint8Array;
  let poolCoins: { master: Uint8Array; record: Uint8Array; satoshi: Uint8Array };
  let deposits: Uint8Array;
  let withdrawn: { nullifierHash: Uint8Array; recipient: Uint8Array };
  const sent = () => pool.transactions;
  const eventLock = (signature: string) => lockOf(getEventNftAddress(pool.client.contract.inner, category, signature));
  const spending = (outpointTxid: string) => spendingFrom(sent(), outpointTxid);

  beforeAll(async () => {
    pool = await poolOnMock('bch');
    const { client, signers: [alice] } = pool;
    category = client.pool.category;
    creation = spending(category);
    factoryGenesis = spending(pool.factory);
    const factoryTx = sent().find((hex) => txidOf(hex) === pool.factory)!;
    deployerLock = decode(factoryTx).outputs[0].lockingBytecode;
    poolCoins = {
      master: lockOf(client.contract.address),
      record: lockOf(getDataNftAddress(client.contract.inner, category)),
      satoshi: lockOf(client.contract.getSatoshiContainerAddress()),
    };
    deposits = eventLock('Deposit(uint32,bytes32)');
    const note = newSpend();
    await client.deposit(alice, note.commitment, await pool.view());
    await client.finish(await pool.view());
    await client.deposit(alice, newSpend().commitment, await pool.view());
    await client.finish(await pool.view());
    const recipient = lockOf(new Signer(new Uint8Array(32).fill(0x77), pool.provider).getAddress());
    await client.withdraw(note, recipient, await pool.view(), proveStatement);
    withdrawn = { nullifierHash: le32(note.nullifierHash), recipient };
  }, 1_800_000);

  afterEach(() => { vi.restoreAllMocks(); });

  describe('a pool\'s genesis', () => {
    it('is found with nothing padded, as before', async () => {
      expect(await genesisProblems(pool.client, fulcrumOf(sent()), pool.factory)).toEqual([]);
      expect(await genesisProblems(pool.client, fulcrumOf(sent(), { without: historyOnly }), pool.factory)).toEqual([]);
    });

    it('is found past a deployer-coin lock padded past the limit, which every pool of the kind shares', async () => {
      const padded = [...sent(), ...padding(hexToBin(deployerCoinLock('bch')))];
      const reader = fulcrumOf(padded);
      expect(await genesisProblems(pool.client, reader, pool.factory)).toEqual([]);
      // Through the first transaction at the pool's own coins' locks, with no history read.
      expect(reader.calls).toEqual([]);
    });

    it('is found from the transaction a caller read its event in', async () => {
      const padded = [...sent(), ...padding(hexToBin(deployerCoinLock('bch')))];
      const reader = fulcrumOf(padded, { without: ['firstUse', 'listUnspent'] });
      expect(await genesisProblems(pool.client, reader, pool.factory, { creation: txidOf(creation) })).toEqual([]);
    });

    it('is found through the factory\'s own chain when a stranger paid the pool\'s locks first', async () => {
      // Paid between the prep and the creation: the first use of each lock is the stranger's.
      const first = junk(poolCoins.record, poolCoins.satoshi);
      const at = sent().indexOf(creation);
      const padded = [...sent().slice(0, at), first, ...sent().slice(at), ...padding(hexToBin(deployerCoinLock('bch')))];
      const reader = fulcrumOf(padded);
      expect((await reader.firstUse(scripthashOf(poolCoins.record))).tx_hash).toBe(txidOf(first));
      expect(await genesisProblems(pool.client, reader, pool.factory)).toEqual([]);
    });

    it('is a server\'s limit, thrown, not a problem of the pool, when nothing else leads to it', async () => {
      const padded = [...sent(), ...padding(hexToBin(deployerCoinLock('bch')))];
      await expect(genesisProblems(pool.client, fulcrumOf(padded, { without: historyOnly }), pool.factory))
        .rejects.toBeInstanceOf(HistoryLimit);
    });

    it('is still a problem of the pool when the server shows everything', async () => {
      // Another factory's category, whose chain names no such pool.
      expect(await genesisProblems(pool.client, fulcrumOf(sent()), 'ab'.repeat(32)))
        .toEqual([`no PoolCreated event of ${'ab'.repeat(32)} in the genesis names this pool`]);
    });
  });

  describe('a factory\'s genesis', () => {
    it('is found past the deployer\'s own address padded past the limit', async () => {
      const padded = [...sent(), ...padding(deployerLock)];
      expect(await factoryGenesisProblems('bch', pool.factory, fulcrumOf(padded), pool.provider)).toEqual([]);
      expect(await factoryGenesisProblems('bch', pool.factory, fulcrumOf(padded, { without: ['firstUse'] }), pool.provider)).toEqual([]);
      expect(await factoryGenesisProblems('bch', pool.factory, fulcrumOf(padded, { without: ['firstUse', 'listUnspent'] }), pool.provider, {
        genesis: txidOf(factoryGenesis),
      })).toEqual([]);
    });

    it('is a server\'s limit, thrown, when only that history could lead to it', async () => {
      const padded = [...sent(), ...padding(deployerLock)];
      await expect(factoryGenesisProblems('bch', pool.factory, fulcrumOf(padded, { without: historyOnly }), pool.provider))
        .rejects.toBeInstanceOf(HistoryLimit);
    });
  });

  describe('the factory\'s pools', () => {
    const createdLock = () => poolCreatedLock('bch', pool.factory, 'regtest');

    it('are read from its own chain past an event address padded past the limit, each with its creation', async () => {
      const reader = fulcrumOf([...sent(), ...padding(createdLock())]);
      expect(await factoryPools(reader, 'bch', pool.factory, 'regtest'))
        .toEqual([{ category, exponent: 6, txid: txidOf(creation) }]);
      expect(reader.calls).toEqual([]);
    });

    it('are read from the event address where the server shows none of the factory\'s coins', async () => {
      const coins = factoryCoinLocks('bch', pool.factory, 'regtest').flatMap((lock) => padding(lock));
      expect(await factoryPools(fulcrumOf([...sent(), ...coins]), 'bch', pool.factory, 'regtest'))
        .toEqual([{ category, exponent: 6, txid: txidOf(creation) }]);
    });

    it('are a server\'s limit, thrown, when both are past it, and never an empty list', async () => {
      const coins = factoryCoinLocks('bch', pool.factory, 'regtest').flatMap((lock) => padding(lock));
      await expect(factoryPools(fulcrumOf([...sent(), ...coins, ...padding(createdLock())]), 'bch', pool.factory, 'regtest'))
        .rejects.toBeInstanceOf(HistoryLimit);
    });

    it('are listed by the indexer past a padded event address, and a server past its limit is logged as one', async () => {
      const archive = { add: () => undefined } as any;
      const listed = new Discovery('regtest', fulcrumOf([...sent(), ...padding(createdLock())]), [{ kind: 'bch', category: pool.factory }], undefined, archive);
      await listed.start();
      listed.stop();
      expect([...listed.pools.keys()]).toEqual([category]);

      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const coins = factoryCoinLocks('bch', pool.factory, 'regtest').flatMap((lock) => padding(lock));
      const blind = fulcrumOf([...sent(), ...coins, ...padding(createdLock())]);
      const blinded = new Discovery('regtest', blind, [{ kind: 'bch', category: pool.factory }], undefined, archive);
      await blinded.start();
      blinded.stop();
      expect(blinded.pools.size).toBe(0);
      expect(errors.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/max_history/);
    });
  });

  describe('a forged PoolCreated', () => {
    const createdLock = () => poolCreatedLock('bch', pool.factory, 'regtest');
    const archive = { add: () => undefined } as any;
    /** The chain up to the pool's creation, where a changed creation goes in its place. */
    const before = () => sent().slice(0, sent().indexOf(creation));
    const ofCategory = (output: any, of: string, capability: string) => output?.token?.nft?.capability === capability
      && binToHex(output.token.category) === of;

    it('is told from the real one by where a creation puts it', () => {
      // The factory's master, its state record, the event, the pool's master: what the readers ask.
      const { outputs } = decode(creation);
      expect(ofCategory(outputs[0], pool.factory, 'minting')).toBe(true);
      expect(ofCategory(outputs[1], pool.factory, 'mutable')).toBe(true);
      expect(ofCategory(outputs[2], pool.factory, 'none') && binToHex(outputs[2].lockingBytecode) === binToHex(createdLock())).toBe(true);
      expect(ofCategory(outputs[3], category, 'minting') && binToHex(outputs[3].lockingBytecode) === binToHex(poolCoins.master)).toBe(true);
    });

    it('is not listed when a creation minted it at a bare OP_1 lock and anyone paid it to the event address', async () => {
      const { forged, move } = forgedEvent(creation, pool.factory, createdLock());
      const chain = [...before(), forged, move];
      const coins = factoryCoinLocks('bch', pool.factory, 'regtest').flatMap((lock) => padding(lock));
      // From the factory's own chain, from the event address's history, and from a reader of before.
      for (const reader of [fulcrumOf(chain), fulcrumOf([...chain, ...coins]), fulcrumOf(chain, { without: historyOnly })]) {
        expect(await factoryPools(reader, 'bch', pool.factory, 'regtest')).toEqual([{ category, exponent: 6, txid: txidOf(forged) }]);
      }
      // The creation that minted it is still the pool's: the chain took it, and the factory makes
      // no second pool of its amount.
      expect(await genesisProblems(pool.client, fulcrumOf(chain), pool.factory)).toEqual([]);
      const discovery = new Discovery('regtest', fulcrumOf([...chain, ...coins]), [{ kind: 'bch', category: pool.factory }], undefined, archive);
      await discovery.start();
      discovery.stop();
      expect([...discovery.pools.keys()]).toEqual([category]);
      expect((discovery as any).pending.size).toBe(0);
    });

    it('does not make a pool the factory\'s when it was born through the deployer coin with no factory beside it', async () => {
      // The factory's master and state record give way to two plain coins, one of them holding
      // an event NFT minted as above, now naming this pool, and paid to the event address.
      const tx = decode(creation);
      tx.inputs[0] = { ...tx.inputs[0], outpointTransactionHash: hexToBin('c1'.repeat(32)), outpointIndex: 0 };
      tx.inputs[1] = { ...tx.inputs[1], outpointTransactionHash: hexToBin('c2'.repeat(32)), outpointIndex: 0 };
      const stranger = lockOf(new Signer(new Uint8Array(32).fill(0x66), pool.provider).getAddress());
      tx.outputs[0] = { lockingBytecode: stranger, valueSatoshis: 1_200n };
      tx.outputs[1] = { lockingBytecode: stranger, valueSatoshis: 1_200n };
      const born = binToHex(encodeTransaction(tx));
      const chain = [...before(), born];
      const refused = [`no PoolCreated event of ${pool.factory} in the genesis names this pool`];
      expect(await genesisProblems(pool.client, fulcrumOf(chain), pool.factory)).toEqual(refused);
      expect(await genesisProblems(pool.client, fulcrumOf(chain, { without: historyOnly }), pool.factory)).toEqual(refused);
      const coins = factoryCoinLocks('bch', pool.factory, 'regtest').flatMap((lock) => padding(lock));
      expect(await factoryPools(fulcrumOf([...chain, ...coins]), 'bch', pool.factory, 'regtest')).toEqual([]);
    });
  });

  describe('a pool\'s history', () => {
    it('is read from the pool\'s own chain past an event address padded past the limit', async () => {
      const padded = [...sent(), ...padding(deposits)];
      const history = new ChainHistory(fulcrumOf(padded), pool.client);
      expect((await history.deposits()).map((record) => record.leafIndex)).toEqual([0, 1]);
      expect(await history.withdrawals()).toHaveLength(1);
      const view = await pool.client.view(history);
      expect(view.tree.size).toBe(2);
      expect(view.nullifiers.has(withdrawn.nullifierHash)).toBe(true);
    });

    it('finds a withdrawal\'s payment past a Withdraw address padded past the limit', async () => {
      const withdrawals = eventLock('Withdraw(bytes32)');
      const history = new ChainHistory(fulcrumOf([...sent(), ...padding(withdrawals)]), pool.client);
      expect(await history.payment(withdrawn.nullifierHash, withdrawn.recipient)).toBeDefined();
    });

    it('is a server\'s limit, thrown, when the pool\'s coins are past it too, never a pool with no notes', async () => {
      const padded = [...sent(), ...padding(deposits), ...padding(poolCoins.master), ...padding(poolCoins.record)];
      const history = new ChainHistory(fulcrumOf(padded), pool.client);
      await expect(history.deposits()).rejects.toBeInstanceOf(HistoryLimit);
      await expect(pool.client.view(history)).rejects.toBeInstanceOf(HistoryLimit);
    });
  });
});

describe('a forged PoolCreated on the token factory', () => {
  let token: Awaited<ReturnType<typeof poolOnMock>>;
  beforeAll(async () => { token = await poolOnMock('token'); }, 1_800_000);

  it('is not listed, so the factory\'s tree is rebuilt as the factory holds it, not refused as taken', async () => {
    // The forged event names another category at the same asset and amount: the same slot.
    const category = token.client.pool.category;
    const creation = spendingFrom(token.transactions, category);
    const createdLock = poolCreatedLock('token', token.factory, 'regtest');
    const { forged, move } = forgedEvent(creation, token.factory, createdLock);
    const chain = [...token.transactions.slice(0, token.transactions.indexOf(creation)), forged, move];
    const { registered } = await (await connectFactory('token', token.factory, token.provider)).getState();
    const coins = factoryCoinLocks('token', token.factory, 'regtest').flatMap((lock) => padding(lock));
    for (const reader of [fulcrumOf(chain), fulcrumOf([...chain, ...coins]), fulcrumOf(chain, { without: historyOnly })]) {
      const listed = await factoryPools(reader, 'token', token.factory, 'regtest');
      expect(listed.map((created) => created.category)).toEqual([category]);
      expect(binToHex(registryTree(listed).root())).toBe(binToHex(registered));
    }
  });
});
