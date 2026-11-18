// What a creation may emit of its factory's own category, and what it may write on a master.
// SolidCash 0.51.1's count of a contract's own outputs passes over an immutable NFT at a bare OP_1
// lock, so before the factories refused it themselves, a creation could mint one holding a
// `PoolCreated` that names any pool, for anyone to move to the event address later: the bytecode
// audit of 2026-11-17, its cases A and P2. Now each factory refuses every output of its category
// but the master, the state record after it and the event after that. And a master's commitment is
// always empty, since all state lives in the state records: the factory's `create` requires its
// own master's, and `Deploy<C>` the new pool's. Each case is the SDK's creation, as the app makes
// it, with one thing added or changed, the builder's coins signed again, and judged by the VM: the
// SDK's creation is each refusal's control.
import { Signer } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hash256, hexToBin } from '@bitauth/libauth';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectFactory, createThroughFactory, deployFactory, deployerCoinLock, parsePoolCreated, poolCreatedLock, type PoolCreated,
} from '../../web/src/factory';
import { SEED_SATOSHIS, SEED_TOKENS } from '../../web/src/pools';
import { ASSET, lockOf } from './lib/setup';

const key = (byte: number) => new Uint8Array(32).fill(byte);
const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());
const decode = (hex: string) => decodeTransaction(hexToBin(hex)) as any;
const OP_1 = Uint8Array.of(0x51);
const OP_1_OP_NOP = Uint8Array.of(0x51, 0x61);
const vm = createVirtualMachineBch2026(true);
/**
 * The factories' own refusal, `require(held.split(32)[0] != own)`: OP_3 OP_PICK OP_EQUAL OP_NOT
 * OP_VERIFY, which appears nowhere else in either factory's code.
 */
const GUARD = [0x53, 0x79, 0x87, 0x91, 0x69];
/**
 * The factories' refusal of a commitment on their own master: OP_INPUTINDEX
 * OP_OUTPUTTOKENCOMMITMENT OP_0 OP_EQUALVERIFY, which appears nowhere else in either factory's code.
 */
const EMPTY_MASTER = [0xc0, 0xd2, 0x00, 0x88];
/**
 * `Deploy<C>`'s refusal of a commitment on the new pool's master: OP_PICK (the master's output)
 * OP_OUTPUTTOKENCOMMITMENT OP_0 OP_EQUALVERIFY.
 */
const EMPTY_POOL_MASTER = [0x79, 0xd2, 0x00, 0x88];

let serial = 0x400;

/** Two pools made through a new factory of `kind` as the app makes them, and every transaction the mock took. */
async function twoPools(kind: 'bch' | 'token') {
  const provider: any = new MockNetworkProvider({ profile: 'production' });
  const alice = new Signer(key(0x5a), provider);
  const sent: string[] = [];
  const broadcast = provider.sendRawTransaction.bind(provider);
  provider.sendRawTransaction = async (hex: string) => {
    const txid = await broadcast(hex);
    sent.push(hex);
    return txid;
  };
  // The coins the mock makes from nothing, by outpoint: the outputs a creation's inputs name.
  const seeded = new Map<string, any>();
  const coin = async (satoshis: bigint, token?: { category: string; amount: bigint }) => {
    const utxo = { txid: (serial++).toString(16).padStart(64, '0'), vout: 0, satoshis, ...(token ? { token } : {}) };
    await provider.seedUtxo(alice.getAddress(), utxo);
    seeded.set(`${utxo.txid}:0`, {
      lockingBytecode: lockOf(alice.getAddress()), valueSatoshis: satoshis,
      ...(token ? { token: { category: hexToBin(token.category), amount: token.amount } } : {}),
    });
    return utxo;
  };
  await coin(1_000_000n);
  const creator = (await deployFactory(kind, alice)).categoryId as string;
  const factory = await connectFactory(kind, creator, alice);
  const made: PoolCreated[] = [];
  for (const exponent of kind === 'bch' ? [6, 7] : [2, 3]) {
    const category = await createThroughFactory(factory, provider, alice, {
      kind, exponent, prepCoin: await coin(1_000_000n),
      ...(kind === 'token' ? { asset: ASSET, created: made, tokenSeed: await coin(SEED_SATOSHIS, { category: ASSET, amount: SEED_TOKENS }) } : {}),
    });
    made.push({ category, exponent, ...(kind === 'token' ? { asset: ASSET } : {}) });
  }
  const creations = made.map(({ category }) => sent.find((hex) => decode(hex).inputs
    .some((input: any) => input.outpointIndex === 0 && binToHex(input.outpointTransactionHash) === category))!);
  /** The output an input spends, from the mock's transactions or its seeded coins. */
  const sourceOf = (input: any) => {
    const outpoint = `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`;
    if (seeded.has(outpoint)) {
      const output = seeded.get(outpoint);
      return { ...output, ...(output.token ? { token: { ...output.token } } : {}) };
    }
    return { ...decode(sent.find((hex) => txidOf(hex) === binToHex(input.outpointTransactionHash))!).outputs[input.outpointIndex] };
  };
  return {
    kind, alice, creator, made, creations, sourceOf,
    spare: await coin(10_000n),
    attacker: lockOf(new Signer(key(0x66), provider).getAddress()),
    eventLock: poolCreatedLock(kind, creator, provider.network),
  };
}
type Fixture = Awaited<ReturnType<typeof twoPools>>;

/**
 * A creation with one thing changed, in it or in the outputs it spends, the builder's own coins
 * signed again, what the chain says of it, and where it refused it: `refusedBy(input, opcodes)`
 * holds when that input's script failed right after running those opcodes.
 */
function changed(pools: Fixture, creation: string, change: (tx: any, sourceOutputs: any[]) => void) {
  const tx = decode(creation);
  const sourceOutputs = tx.inputs.map(pools.sourceOf);
  change(tx, sourceOutputs);
  const own = binToHex(lockOf(pools.alice.getAddress()));
  tx.inputs.forEach((input: any, inputIndex: number) => {
    if (binToHex(sourceOutputs[inputIndex].lockingBytecode) !== own) return;
    input.unlockingBytecode = pools.alice.unlockP2PKH().generateUnlockingBytecode({ transaction: tx, sourceOutputs, inputIndex });
  });
  const verdict = vm.verify({ transaction: tx, sourceOutputs });
  const master = sourceOutputs.findIndex((output: any) => output.token?.nft?.capability === 'minting'
    && binToHex(output.token.category) === pools.creator);
  let refusal: { input: number; ran: number[] } | undefined;
  const failing = verdict === true ? null : /input index (\d+)/.exec(String(verdict));
  if (failing) {
    const input = Number(failing[1]);
    const failed = (vm.debug({ inputIndex: input, sourceOutputs, transaction: tx }) as any[]).find((state) => state.error !== undefined);
    // The instruction pointer has passed the instruction that failed.
    if (failed) refusal = { input, ran: failed.instructions.slice(Math.max(0, failed.ip - 8), failed.ip).map((instruction: any) => instruction.opcode) };
  }
  const refusedBy = (input: number, opcodes: number[]) => refusal !== undefined && refusal.input === input
    && refusal.ran.slice(-opcodes.length).join() === opcodes.join();
  return {
    tx, sourceOutputs, master, hex: binToHex(encodeTransaction(tx)), refusedBy,
    guarded: refusedBy(master, GUARD),
    chainTakesIt: verdict === true,
    verdict: verdict === true ? 'the chain takes it' : `the chain refuses it: ${verdict}`,
  };
}

describe.each(['bch', 'token'] as const)('what a creation through the %s factory emits of the factory\'s category', (kind) => {
  let pools: Fixture;
  beforeAll(async () => { pools = await twoPools(kind); }, 600_000);

  const nft = (capability: 'none' | 'mutable' | 'minting', commitment: Uint8Array) => ({
    category: hexToBin(pools.creator), amount: 0n, nft: { capability, commitment },
  });
  /** The second pool's own `PoolCreated`: what a forger would mint to vouch for a pool. */
  const naming = () => decode(pools.creations[1]).outputs
    .find((output: any) => output.token?.nft?.capability === 'none' && binToHex(output.token.category) === pools.creator).token.nft.commitment;
  const anchor = () => {
    const master = decode(pools.creations[0]).outputs.find((output: any) => output.token?.nft?.capability === 'minting'
      && binToHex(output.token.category) === pools.creator);
    return Uint8Array.from([0x53, 0x43, 0x49, 0x44, 0x01, ...new Uint8Array(10), ...master.lockingBytecode]);
  };

  it('takes the SDK\'s creations', () => {
    expect(parsePoolCreated(kind, naming())?.category).toBe(pools.made[1].category);
    for (const creation of pools.creations) {
      const { chainTakesIt, verdict } = changed(pools, creation, () => undefined);
      expect(chainTakesIt, verdict).toBe(true);
    }
  });

  // One output more than the SDK's creation of the first pool: an NFT of the factory's category.
  // SolidCash's own rules pass over the first four, which only the factories' loop refuses; the
  // rest they refuse as well.
  const outside: Array<[string, boolean, () => { lockingBytecode: Uint8Array; token: any }]> = [
    ['a PoolCreated naming another pool, at a bare OP_1 lock', true, () => ({ lockingBytecode: OP_1, token: nft('none', naming()) })],
    ['an NFT with no commitment, at a bare OP_1 lock', true, () => ({ lockingBytecode: OP_1, token: nft('none', new Uint8Array()) })],
    ['an NFT with no commitment, at the builder\'s address', true, () => ({ lockingBytecode: pools.attacker, token: nft('none', new Uint8Array()) })],
    ['an SCID anchor naming the factory\'s master, at the builder\'s address', true, () => ({ lockingBytecode: pools.attacker, token: nft('none', anchor()) })],
    ['a PoolCreated naming another pool, at the event\'s address', false, () => ({ lockingBytecode: pools.eventLock, token: nft('none', naming()) })],
    ['a PoolCreated naming another pool, at the builder\'s address', false, () => ({ lockingBytecode: pools.attacker, token: nft('none', naming()) })],
    ['a PoolCreated naming another pool, at OP_1 OP_NOP', false, () => ({ lockingBytecode: OP_1_OP_NOP, token: nft('none', naming()) })],
    ['a second minting NFT, at the builder\'s address', false, () => ({ lockingBytecode: pools.attacker, token: nft('minting', new Uint8Array()) })],
    ['a mutable NFT, at the builder\'s address', false, () => ({ lockingBytecode: pools.attacker, token: nft('mutable', new Uint8Array()) })],
  ];
  for (const [label, onlyTheLoop, output] of outside) {
    it(`refuses ${label}`, () => {
      const { chainTakesIt, guarded, verdict } = changed(pools, pools.creations[0], (tx) => {
        tx.outputs.push({ ...output(), valueSatoshis: 1_000n });
      });
      expect(chainTakesIt, verdict).toBe(false);
      if (onlyTheLoop) expect(guarded, `${label}: refused, but not by the factory's own loop`).toBe(true);
    });
  }

  // A master's commitment is always empty, since all state lives in the state records. SolidCash
  // keeps a master's commitment only in a function that touches no state, so the factory's `create`
  // requires its own master's itself; `Deploy<C>` requires the new pool's master, the output after
  // the event, to be born without one, and the pool's own functions keep it so.
  const commitment = (bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => i + 1);
  const deployerCoin = (sourceOutputs: any[]) => sourceOutputs
    .findIndex((output: any) => binToHex(output.lockingBytecode) === deployerCoinLock(kind).replace(/^0x/, ''));
  for (const bytes of [1, 128]) {
    it(`refuses a ${bytes}-byte commitment on the factory's master`, () => {
      const result = changed(pools, pools.creations[0], (tx, sourceOutputs) => {
        const master = sourceOutputs.findIndex((output: any) => output.token?.nft?.capability === 'minting');
        tx.outputs[master].token.nft.commitment = commitment(bytes);
      });
      expect(result.chainTakesIt, result.verdict).toBe(false);
      expect(result.refusedBy(result.master, EMPTY_MASTER), 'refused, but not by the factory\'s own rule').toBe(true);
    });
    it(`refuses a ${bytes}-byte commitment on the new pool's master, in Deploy<C>`, () => {
      const result = changed(pools, pools.creations[0], (tx, sourceOutputs) => {
        const master = sourceOutputs.findIndex((output: any) => output.token?.nft?.capability === 'minting');
        tx.outputs[master + 3].token.nft.commitment = commitment(bytes);
      });
      expect(result.chainTakesIt, result.verdict).toBe(false);
      expect(result.refusedBy(deployerCoin(result.sourceOutputs), EMPTY_POOL_MASTER), 'refused, but not by Deploy<C>\'s own rule').toBe(true);
    });
  }

  // The audit's case P2: a pool born through `Deploy<C>` with no factory beside it, paying an NFT of
  // the factory's category that names it to the event's address. No factory runs there, so the
  // chain judges that genesis without the factory's code: what stops it is that nothing can mint the
  // NFT. After a factory's genesis only its `create` can, and the creation that would is refused.
  it('leaves no NFT for a pool made without the factory to carry', () => {
    const mint = changed(pools, pools.creations[0], (tx) => {
      tx.outputs.push({ lockingBytecode: OP_1, valueSatoshis: 1_000n, token: nft('none', naming()) });
    });
    expect(mint.chainTakesIt, mint.verdict).toBe(false);
    expect(mint.guarded).toBe(true);

    const forged = mint.tx.outputs.length - 1;
    const genesis = changed(pools, pools.creations[1], (tx, sourceOutputs) => {
      // The factory's master and state record give way to the minted NFT and a coin of the builder's,
      // and their outputs to the builder's; the rest is the second pool's creation as the SDK made it.
      const master = sourceOutputs.findIndex((output: any) => output.token?.nft?.capability === 'minting');
      tx.inputs[master] = { outpointTransactionHash: hexToBin(txidOf(mint.hex)), outpointIndex: forged, sequenceNumber: 0, unlockingBytecode: new Uint8Array() };
      sourceOutputs[master] = mint.tx.outputs[forged];
      tx.inputs[master + 1] = { outpointTransactionHash: hexToBin(pools.spare.txid), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() };
      sourceOutputs[master + 1] = { lockingBytecode: lockOf(pools.alice.getAddress()), valueSatoshis: pools.spare.satoshis };
      tx.outputs[master] = { lockingBytecode: pools.attacker, valueSatoshis: 1_200n };
      tx.outputs[master + 1] = { lockingBytecode: pools.attacker, valueSatoshis: 1_200n };
    });
    // Handed that NFT, the chain would take the genesis, with a PoolCreated naming the pool at the
    // event's address. The NFT is an output of the creation the chain refuses, so it never can.
    expect(genesis.chainTakesIt, genesis.verdict).toBe(true);
  });
});
