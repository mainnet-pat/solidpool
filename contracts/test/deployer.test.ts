import { binToHex, encodeCashAddress, encodeTransaction, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { Signer } from '@solidcash/solidcash';
import { buildDeployerPreps, genesisOutpointKey, isReservedGenesisOutpoint } from '@solidcash/solidcash/stateful';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { describe, expect, it } from 'vitest';
import bchDeployer from '../artifacts/solidcash/BchPoolDeployer.json';
import tokenDeployer from '../artifacts/solidcash/TokenPoolDeployer.json';
import {
  connectFactory, createThroughFactory, deployFactory, deployerCoinLock, emptyRegistry, madeExponents, parsePoolCreated, registryKey, registryPath,
  registryTree, type PoolCreated,
} from '../../web/src/factory';
import { PoolClient } from '../../web/src/pool-client';
import { deployPoolWithSigner, type PoolCreationStep } from '../../web/src/deploy-pool';
import { signP2pkh } from '../../test/lib/sign';
import { lockOf } from './lib/setup';

const ASSET = 'a1b2c3d4e5f60718293a4b5c6d7e8f900123456789abcdef0011223344556677';
const OTHER = 'b2c3d4e5f60718293a4b5c6d7e8f900123456789abcdef0011223344556677a1';
const key = (byte: number) => new Uint8Array(32).fill(byte);

let serial = 0x100;
const nextTxid = () => (serial++).toString(16).padStart(64, '0');

async function setup(seed: number) {
  const provider: any = new MockNetworkProvider({ profile: 'production' });
  const alice = new Signer(key(seed), provider);
  const coin = async (satoshis = 200_000n, token?: any) => {
    const utxo = { txid: nextTxid(), vout: 0, satoshis, ...(token ? { token } : {}) };
    await provider.seedUtxo(alice.getAddress(), utxo);
    return utxo;
  };
  for (let i = 0; i < 4; i += 1) await coin(1_000_000n);
  return { provider, alice, coin };
}

const eventsOf = async (factory: any, kind: 'bch' | 'token'): Promise<PoolCreated[]> => (
  (await factory.queryEvents('PoolCreated')).map((event: any) => {
    const values = event.values as Record<string, unknown>;
    return {
      category: binToHex(values.category as Uint8Array),
      exponent: Number(values.exponent),
      ...(kind === 'token' ? { asset: binToHex(values.asset as Uint8Array) } : {}),
    };
  }));

describe('the BCH pool factory', () => {
  it('creates one pool per amount, and refuses a second', async () => {
    const { provider, alice, coin } = await setup(0x11);
    const deployed = await deployFactory('bch', alice);
    const factory = await connectFactory('bch', deployed.categoryId, alice);

    const first = await createThroughFactory(factory, provider, alice, { kind: 'bch', exponent: 6, prepCoin: await coin() });
    expect(madeExponents((await factory.getState()).made)).toEqual([6]);
    // The client refuses a second 0.01 BCH pool before anything spends, and the chain refuses one too.
    await expect(createThroughFactory(factory, provider, alice, { kind: 'bch', exponent: 6, prepCoin: await coin() }))
      .rejects.toThrow(/already has a pool/);
    const { preps } = await buildDeployerPreps({
      provider,
      children: [{ contractName: 'BchPool', deployer: (bchDeployer as any).childDeployers.BchPool }],
      fundingUtxos: [await coin()],
      authorSigner: alice.unlockP2PKH(),
      authorLockingBytecode: lockOf(alice.getAddress()),
      changeLockingBytecode: lockOf(alice.getAddress()),
    } as any);
    // The SDK runs the factory's own code first, and that run stops at its `made` check, before
    // its `new`: so the creation has no child, and nothing is sent.
    await expect(factory.create(6n).deploy({ deployerPreps: preps, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress() }), 'a second 0.01 BCH pool on chain')
      .rejects.toThrow(/OP_VERIFY|creates 0 children/);
    const second = await createThroughFactory(factory, provider, alice, { kind: 'bch', exponent: 7, prepCoin: await coin() });
    expect(madeExponents((await factory.getState()).made)).toEqual([6, 7]);

    // Each creation is an NFT of the factory's own category at its PoolCreated address.
    const events = await eventsOf(factory, 'bch');
    expect(events).toEqual([{ category: first, exponent: 6 }, { category: second, exponent: 7 }]);
  }, 900_000);

  // The pool's constructor bounds its exponent, and the factory's `new` runs it where the pool is born.
  it('cannot create a pool outside 0.01 to 100 BCH', async () => {
    const { provider, alice, coin } = await setup(0x22);
    const deployed = await deployFactory('bch', alice);
    const factory = await connectFactory('bch', deployed.categoryId, alice);
    for (const exponent of [5, 11]) {
      await expect(createThroughFactory(factory, provider, alice, { kind: 'bch', exponent, prepCoin: await coin() }), `exponent ${exponent}`)
        .rejects.toThrow(/constructor[\s\S]*OP_VERIFY/);
    }
    expect((await factory.getState()).made).toBe(0n);
    expect(await factory.queryEvents('PoolCreated')).toHaveLength(0);
  }, 900_000);
});

describe('the token pool factory', () => {
  it('creates one pool per asset and amount, keeps the root the client rebuilds, and refuses a second', async () => {
    const { provider, alice, coin } = await setup(0x33);
    const deployed = await deployFactory('token', alice);
    const factory = await connectFactory('token', deployed.categoryId, alice);
    const seed = (asset: string) => coin(1_200n, { category: asset, amount: 1n });
    const rootOnChain = async () => binToHex((await factory.getState()).registered);
    expect(await rootOnChain()).toBe(binToHex(emptyRegistry().root()));

    const create = async (asset: string, exponent: number) => createThroughFactory(factory, provider, alice, {
      kind: 'token', exponent, asset, created: await eventsOf(factory, 'token'), prepCoin: await coin(), tokenSeed: await seed(asset),
    });
    const first = await create(ASSET, 2);
    // A second slot proves its path through a tree that is no longer empty, so this also holds the
    // slot key and the leaf to what `create` packs: another key or leaf gives another root.
    const second = await create(OTHER, 2);
    const third = await create(ASSET, 3);
    const created = await eventsOf(factory, 'token');
    expect(created).toEqual([
      { category: first, exponent: 2, asset: ASSET }, { category: second, exponent: 2, asset: OTHER }, { category: third, exponent: 3, asset: ASSET },
    ]);
    expect(await rootOnChain()).toBe(binToHex(registryTree(created).root()));

    // The client refuses a taken slot before anything spends.
    await expect(create(ASSET, 2)).rejects.toThrow(/already have a pool/);
    // The chain refuses one too, whatever path the caller claims for it.
    const duplicate = async (siblings: Uint8Array[]) => {
      const { preps } = await buildDeployerPreps({
        provider,
        children: [{ contractName: 'TokenPool', deployer: (tokenDeployer as any).childDeployers.TokenPool }],
        fundingUtxos: [await coin()],
        authorSigner: alice.unlockP2PKH(),
        authorLockingBytecode: lockOf(alice.getAddress()),
        changeLockingBytecode: lockOf(alice.getAddress()),
      } as any);
      return factory.create(2n, hexToBin(ASSET), siblings).deploy({
        deployerPreps: preps, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress(),
        childTokenContainers: [{ utxo: await seed(ASSET), unlocker: alice.unlockP2PKH() }],
      });
    };
    const tree = registryTree(created);
    await expect(duplicate(registryPath(emptyRegistry(), registryKey(ASSET, 2))), 'the empty tree\'s path').rejects.toThrow();
    await expect(duplicate(registryPath(tree, registryKey(ASSET, 2))), 'the current tree\'s path').rejects.toThrow();
    expect(await eventsOf(factory, 'token')).toHaveLength(3);
    expect(await rootOnChain()).toBe(binToHex(tree.root()));

    // The pool's token container holds the seed's one unit.
    const pool = new PoolClient({ id: first, kind: 'token', denomination: 100n, category: first, asset: ASSET }, provider);
    const container = await provider.getUtxos(pool.contract.tokens[ASSET].address);
    expect(container.map((utxo: any) => [utxo.token?.category, utxo.token?.amount])).toEqual([[ASSET, 1n]]);
  }, 1_800_000);

  it('decodes its own events, and nothing else', () => {
    const event = (tokenDeployer as any).events.find((entry: any) => entry.name === 'PoolCreated');
    expect(event.signature).toBe('PoolCreated(bytes32,bytes32,uint8)');
    expect((bchDeployer as any).events.find((entry: any) => entry.name === 'PoolCreated').signature).toBe('PoolCreated(bytes32,uint8)');
    expect(parsePoolCreated('token', '00')).toBeUndefined();
    expect((tokenDeployer as any).childDeployers.TokenPool.tokenRows).toEqual([1]);
    expect((tokenDeployer as any).childDeployers.TokenPool.satoshiContainer).toBe('required');
  });

  it('is permissionless', () => {
    expect((bchDeployer as any).compiler.options.allowUnsafeOperations).toBe(true);
    expect((tokenDeployer as any).compiler.options.allowUnsafeOperations).toBe(true);
  });
});

// The app asks a wallet to sign each transaction of a pool's creation under the name of its step
// (deploy-pool.ts), and the page shows the same step while it waits. An external wallet takes its
// prompt when an unlocker is made (SolidCash's Signer.unlockP2PKH), so this records the step that
// was current at each one: what the wallet would show for the transaction that unlocker signs.
describe('a pool made from a wallet', () => {
  it('names each transaction it signs by its step, in order, and only the ones it sends', async () => {
    const provider: any = new MockNetworkProvider({ profile: 'production' });
    const alice = new Signer(key(0x77), provider);
    // No plain coin covers the prep alone, and the asset comes in a coin of five units: every step runs.
    for (let i = 0; i < 6; i += 1) await provider.seedUtxo(alice.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 45_000n });
    await provider.seedUtxo(alice.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 2_000n, token: { category: ASSET, amount: 5n } });
    const factories = {
      bch: (await deployFactory('bch', alice)).categoryId as string,
      token: (await deployFactory('token', alice)).categoryId as string,
    };
    const steps: string[] = [];
    const prompts: string[] = [];
    let current = '';
    const onStep = (step: PoolCreationStep) => { steps.push(step.prompt); current = step.prompt; };
    const unlock = alice.unlockP2PKH.bind(alice);
    (alice as any).unlockP2PKH = () => {
      if (prompts.at(-1) !== current) prompts.push(current);
      return unlock();
    };
    await deployPoolWithSigner(provider, alice, {
      id: 'tok', kind: 'token', name: 'test', symbol: 'TST', decimals: 0, denomination: 100n, asset: ASSET,
    }, factories.token, [], onStep);
    expect(steps).toEqual([
      'Prepare the one-unit token coin for the new pool',
      'Gather the coins that pay for the new pool',
      'Create the coin that names the new pool',
      'Create the new pool through its factory',
      'Add the hashing and verifier coins every pool shares',
    ]);
    expect(prompts, 'every unlocker is made under the step of the transaction it signs').toEqual(steps);
    // Every pool shares those coins, and a creation spends none, so the next one sends no top-up.
    steps.length = 0;
    prompts.length = 0;
    await deployPoolWithSigner(provider, alice, {
      id: 'bch', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination: 1_000_000n,
    }, factories.bch, [], onStep);
    expect(steps.slice(-2)).toEqual(['Create the coin that names the new pool', 'Create the new pool through its factory']);
    expect(steps).not.toContain('Add the hashing and verifier coins every pool shares');
    expect(prompts).toEqual(steps);
  }, 600_000);
});

// A wallet the page holds no key for, as Cashonize or WalletConnect is: it signs the empty inputs at its own lock and
// shows the prompt it is sent, which the page names by step, as the engine's signer does. SolidCash 0.51.0 failed every
// such creation, at its check before broadcast; 0.51.1 has the wallet sign the prep and then the creation.
describe('a pool made from a wallet the page holds no key for', () => {
  it('asks the wallet to sign each step, by name, and the pool is made', async () => {
    const provider: any = new MockNetworkProvider({ profile: 'production' });
    const owner = new Signer(key(0x31), provider);
    for (let i = 0; i < 2; i += 1) await provider.seedUtxo(owner.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const factory = (await deployFactory('bch', owner)).categoryId as string;

    const walletKey = key(0x37);
    const publicKey = secp256k1.derivePublicKeyCompressed(walletKey) as Uint8Array;
    const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
    const lock = binToHex(lockOf(address));
    // One coin: the prep spends it, the creation needs no other, and the prep's change pays the shared coins.
    await provider.seedUtxo(address, { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const asked: string[] = [];
    const wallet = {
      async signTransaction({ transaction, sourceOutputs, userPrompt }: any) {
        asked.push(userPrompt ?? '');
        const inputs = transaction.inputs.map((input: any, index: number) => (
          input.unlockingBytecode.length === 0 && binToHex(sourceOutputs[index].lockingBytecode) === lock
            ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, walletKey) }
            : input));
        return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
      },
    };
    let step = 'Create a private pool';
    const signer = Signer.external({ wallet, address, get userPrompt() { return step; } } as any, provider);
    const created = await deployPoolWithSigner(provider, signer, {
      id: 'ten', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination: 1_000_000_000n,
    }, factory, [], (next: PoolCreationStep) => { step = next.prompt; });
    expect(asked).toEqual([
      'Create the coin that names the new pool',
      'Create the new pool through its factory',
      'Add the hashing and verifier coins every pool shares',
    ]);
    const client = new PoolClient({ id: 'ten', kind: 'bch', denomination: 1_000_000_000n, category: created.category }, provider);
    expect((await client.contract.getState()).nextIndex).toBe(0n);
  }, 600_000);

  it('frees the coin a refused creation reserved, so the retry can use it', async () => {
    const provider: any = new MockNetworkProvider({ profile: 'production' });
    const owner = new Signer(key(0x31), provider);
    for (let i = 0; i < 2; i += 1) await provider.seedUtxo(owner.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const factory = (await deployFactory('bch', owner)).categoryId as string;

    const walletKey = key(0x38);
    const publicKey = secp256k1.derivePublicKeyCompressed(walletKey) as Uint8Array;
    const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
    const lock = binToHex(lockOf(address));
    const coin = { txid: nextTxid(), vout: 0, satoshis: 1_000_000n };
    await provider.seedUtxo(address, coin);
    // The wallet signs the prep, then refuses the creation once.
    let refuse = 'Create the new pool through its factory';
    const wallet = {
      async signTransaction({ transaction, sourceOutputs, userPrompt }: any) {
        if (userPrompt === refuse) return undefined;
        const inputs = transaction.inputs.map((input: any, index: number) => (
          input.unlockingBytecode.length === 0 && binToHex(sourceOutputs[index].lockingBytecode) === lock
            ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, walletKey) }
            : input));
        return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
      },
    };
    let step = 'Create a private pool';
    const signer = Signer.external({ wallet, address, get userPrompt() { return step; } } as any, provider);
    const pool = { id: 'ten', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination: 1_000_000_000n } as const;
    const onStep = (next: PoolCreationStep) => { step = next.prompt; };

    await expect(deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep)).rejects.toThrow();
    // Nothing went out, and the coin the prep spent is free again.
    expect((await provider.getUtxos(address)).some((utxo: any) => utxo.txid === coin.txid)).toBe(true);
    expect(isReservedGenesisOutpoint(genesisOutpointKey(coin.txid, coin.vout))).toBe(false);

    refuse = '';
    const created = await deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep);
    const client = new PoolClient({ id: 'ten', kind: 'bch', denomination: 1_000_000_000n, category: created.category }, provider);
    expect((await client.contract.getState()).nextIndex).toBe(0n);
  }, 600_000);

  it('keeps the coins of a prep that went out, though the server said its send failed', async () => {
    const chain: any = new MockNetworkProvider({ profile: 'production' });
    const owner = new Signer(key(0x31), chain);
    for (let i = 0; i < 2; i += 1) await chain.seedUtxo(owner.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const factory = (await deployFactory('bch', owner)).categoryId as string;

    // The page's provider counts each transaction it tries to send, as FulcrumProvider does. This
    // one's server relays the transaction it is armed for, then fails to show it, as FulcrumProvider
    // reports a server that took a transaction and cannot show it within its wait.
    let sends = 0;
    let failNext = false;
    const provider: any = new Proxy(chain, {
      get(target, name) {
        if (name === 'broadcasts') return sends;
        if (name === 'sendRawTransaction') {
          return async (hex: string) => {
            sends += 1;
            const txid = await target.sendRawTransaction(hex);
            if (failNext) {
              failNext = false;
              throw new Error('The server took this transaction and cannot show it.');
            }
            return txid;
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const walletKey = key(0x39);
    const publicKey = secp256k1.derivePublicKeyCompressed(walletKey) as Uint8Array;
    const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
    const lock = binToHex(lockOf(address));
    const coin = { txid: nextTxid(), vout: 0, satoshis: 1_000_000n };
    await chain.seedUtxo(address, coin);
    let refuse = 'Create the new pool through its factory';
    const wallet = {
      async signTransaction({ transaction, sourceOutputs, userPrompt }: any) {
        if (userPrompt === refuse) return undefined;
        const inputs = transaction.inputs.map((input: any, index: number) => (
          input.unlockingBytecode.length === 0 && binToHex(sourceOutputs[index].lockingBytecode) === lock
            ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, walletKey) }
            : input));
        return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
      },
    };
    let step = 'Create a private pool';
    const signer = Signer.external({ wallet, address, get userPrompt() { return step; } } as any, provider);
    const pool = { id: 'ten', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination: 1_000_000_000n } as const;
    const onStep = (next: PoolCreationStep) => { step = next.prompt; };
    const reserved = () => isReservedGenesisOutpoint(genesisOutpointKey(coin.txid, coin.vout));

    // Through a provider that counts, a refusal that sent nothing still frees the coin.
    await expect(deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep)).rejects.toThrow();
    expect(sends).toBe(0);
    expect(reserved()).toBe(false);

    // Now the prep goes out and its send fails. The coin it spent is gone, and it stays reserved,
    // so nothing here spends it again.
    refuse = '';
    failNext = true;
    await expect(deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep)).rejects.toThrow(/cannot show it/);
    expect(sends).toBe(1);
    expect((await chain.getUtxos(address)).some((utxo: any) => utxo.txid === coin.txid)).toBe(false);
    expect(reserved()).toBe(true);
  }, 600_000);

  it('makes the pool from a prep that went out when the creation is tried again', async () => {
    const chain: any = new MockNetworkProvider({ profile: 'production' });
    const owner = new Signer(key(0x31), chain);
    for (let i = 0; i < 2; i += 1) await chain.seedUtxo(owner.getAddress(), { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const factory = (await deployFactory('bch', owner)).categoryId as string;

    // The page's provider counts each send, and its server relays the next transaction and then
    // fails to show it: the prep goes out, and the creation fails before it is sent.
    let sends = 0;
    let failNext = false;
    let relayed = '';
    const provider: any = new Proxy(chain, {
      get(target, name) {
        if (name === 'broadcasts') return sends;
        if (name === 'sendRawTransaction') {
          return async (hex: string) => {
            sends += 1;
            const txid = await target.sendRawTransaction(hex);
            if (failNext) {
              failNext = false;
              relayed = txid;
              throw new Error('The server took this transaction and cannot show it.');
            }
            return txid;
          };
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const walletKey = key(0x3a);
    const publicKey = secp256k1.derivePublicKeyCompressed(walletKey) as Uint8Array;
    const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(publicKey) }).address;
    const lock = binToHex(lockOf(address));
    await chain.seedUtxo(address, { txid: nextTxid(), vout: 0, satoshis: 1_000_000n });
    const asked: string[] = [];
    const wallet = {
      async signTransaction({ transaction, sourceOutputs, userPrompt }: any) {
        asked.push(userPrompt ?? '');
        const inputs = transaction.inputs.map((input: any, index: number) => (
          input.unlockingBytecode.length === 0 && binToHex(sourceOutputs[index].lockingBytecode) === lock
            ? { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, walletKey) }
            : input));
        return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs })) };
      },
    };
    let step = 'Create a private pool';
    const signer = Signer.external({ wallet, address, get userPrompt() { return step; } } as any, provider);
    const pool = { id: 'ten', kind: 'bch', name: 'test', symbol: 'BCH', decimals: 8, denomination: 1_000_000_000n } as const;
    const onStep = (next: PoolCreationStep) => { step = next.prompt; };
    const deployerCoins = async () => chain.getUtxosForLockingBytecode(hexToBin(deployerCoinLock('bch')));

    failNext = true;
    await expect(deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep)).rejects.toThrow(/cannot show it/);
    expect((await deployerCoins()).map((utxo: any) => utxo.txid)).toEqual([relayed]);

    // The retry signs no new prep: it creates the pool from the one that went out.
    asked.length = 0;
    const created = await deployPoolWithSigner(provider, signer, pool as any, factory, [], onStep);
    expect(created.category).toBe(relayed);
    expect(asked).not.toContain('Create the coin that names the new pool');
    expect(asked).not.toContain('Gather the coins that pay for the new pool');
    // Its deployer coin is spent, and no deployer coin is left anywhere.
    expect(await deployerCoins()).toEqual([]);
    const client = new PoolClient({ id: 'ten', kind: 'bch', denomination: 1_000_000_000n, category: created.category }, provider);
    expect((await client.contract.getState()).nextIndex).toBe(0n);
  }, 600_000);
});
