// A pool made through its factory on a mock that enforces BCH's limits, the standard relay VM
// and dust, and mints no coins. The transactions are the ones the app sends: the factory's
// `create`, then everything through PoolClient, and a proof here is a real one under the
// production key, which @solidpool/verifier ships (verifier:check holds it to
// service/verifier/tornado-bn254-3in.json).
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { TransactionBuilder } from '@solidcash/solidcash';
import {
  cashAddressToLockingBytecode, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hash256, hexToBin, binToHex, sha256,
} from '@bitauth/libauth';
import { PoolClient, fromLe, type FeeTopUp, type PoolHistory } from '../../../web/src/pool-client';
import { SEED_TOKENS } from '../../../web/src/pools';
import { deployPool } from '../../../scripts/lib/deploy';
import { deployFactory } from '../../../web/src/factory';
import { createNote } from '../../../web/src/note';
import { ChainHistory } from '../../../web/src/history';

export const lockOf = (address: string) => (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
/** 10^6: a pool's constructor takes powers of ten, and 0.01 BCH is the smallest BCH one. */
export const DENOMINATION = 1_000_000n;
/** Each mock signer coin. One coin covers a deposit, as the attacks that fund from one coin need. */
export const SIGNER_COIN = 10_000_000n;
export const ASSET = 'a1b2c3d4e5f60718293a4b5c6d7e8f900123456789abcdef0011223344556677';
export const FOREIGN = 'f00dfacecafebeef0123456789abcdef0123456789abcdef1122334455667788';

export interface Spend { nullifier: bigint; secret: bigint; commitment: bigint; nullifierHash: bigint }

/**
 * A pool's fees are constants in its code, sized for a 1 sat/B relay floor. Should the floor rise
 * past them, the client tops a finish or a withdrawal up with a wallet's coin. This is such a
 * top-up from `payer`'s largest plain coin.
 */
export async function topUpFrom(payer: any, amount: bigint): Promise<FeeTopUp> {
  const [coin] = (await payer.getUtxos()).filter((c: any) => !c.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis));
  return { coin, unlocker: payer.unlockP2PKH(), change: lockOf(payer.getAddress()), amount };
}

/**
 * A call's transaction as the SDK builds it, judged by the standard VM and not sent, with what
 * it pays the miner and whether `topUp`'s change comes back. A top-up is judged this way beside
 * the step it tops up, which then goes out as it would today.
 */
export async function builtVerdict(call: any, topUp: FeeTopUp): Promise<{ verdict: true | string; fee: bigint; changeBack: boolean }> {
  const { transaction, sourceOutputs } = (await call.build()).buildLibauthProgram();
  const total = (outputs: any[]): bigint => outputs.reduce((sum: bigint, output: any) => sum + BigInt(output.valueSatoshis), 0n);
  const change = BigInt(topUp.coin.satoshis) - topUp.amount;
  return {
    verdict: createVirtualMachineBch2026(true).verify({ transaction, sourceOutputs }) as true | string,
    fee: total(sourceOutputs) - total(transaction.outputs),
    changeBack: transaction.outputs.some((output: any) => output.valueSatoshis === change && binToHex(output.lockingBytecode) === binToHex(topUp.change)),
  };
}
export const newSpend = (): Spend => {
  const { nullifier, secret, commitment, nullifierHash } = createNote();
  return { nullifier, secret, commitment, nullifierHash };
};

export async function poolOnMock(kind: 'bch' | 'token') {
  const provider: any = new MockNetworkProvider({ profile: 'production' });
  const signers = await provider.getSigners(4, { fundingUtxos: 16, genesisFundingUtxos: 4, satoshis: SIGNER_COIN });
  const [alice] = signers;

  let nextCoin = 0;
  const addCoin = async (owner: any, satoshis: bigint, token?: any) => {
    nextCoin += 1;
    const coin = { txid: `${'c0'.repeat(31)}${nextCoin.toString(16).padStart(2, '0')}`, vout: 0, satoshis, ...(token ? { token } : {}) };
    await provider.seedUtxo(owner.getAddress(), coin);
    return coin;
  };
  if (kind === 'token') await addCoin(alice, 1_200n, { category: ASSET, amount: SEED_TOKENS });

  // What Fulcrum would answer, from every transaction this mock accepted.
  const transactions: string[] = [];
  const broadcast = provider.sendRawTransaction.bind(provider);
  provider.sendRawTransaction = async (hex: string) => {
    const txid = await broadcast(hex);
    transactions.push(hex);
    return txid;
  };
  const txidOf = (hex: string) => binToHex(hash256(hexToBin(hex)).slice().reverse());
  const scripthashOf = (lock: Uint8Array) => binToHex(sha256.hash(lock).slice().reverse());
  const reader = {
    // As Fulcrum lists them: every transaction that pays to the address or spends from it.
    async history(scripthash: string) {
      const paysTo = (tx: any) => tx.outputs.some((output: any) => scripthashOf(output.lockingBytecode) === scripthash);
      const spendsFrom = (tx: any) => tx.inputs.some((input: any) => {
        const parent = transactions.find((hex) => txidOf(hex) === binToHex(input.outpointTransactionHash));
        const spent = parent && (decodeTransaction(hexToBin(parent)) as any).outputs[input.outpointIndex];
        return spent !== undefined && scripthashOf(spent.lockingBytecode) === scripthash;
      });
      return transactions
        .filter((hex) => { const tx = decodeTransaction(hexToBin(hex)) as any; return paysTo(tx) || spendsFrom(tx); })
        .map((hex) => ({ tx_hash: txidOf(hex), height: 1 }));
    },
    // Fulcrum's get_first_use, which vouches for an empty history: this one has no limit to cut it.
    async firstUse(scripthash: string) {
      const [first] = await reader.history(scripthash);
      return first ?? null;
    },
    async transaction(txid: string) {
      return transactions.find((hex) => txidOf(hex) === txid);
    },
  };

  // The factory's genesis spends a coin of a real transaction, so its genesis check reads that
  // transaction as it would on a network: the mock's own coins come from nowhere.
  const factoryFunding = await (async () => {
    const [coin] = (await alice.getUtxos()).filter((candidate: any) => !candidate.token);
    const builder = new TransactionBuilder({ provider });
    builder.addInput(coin, alice.unlockP2PKH());
    builder.addOutput({ to: alice.getAddress(), amount: 500_000n });
    builder.addBchChangeOutputIfNeeded({ to: alice.getAddress(), feeRate: 1.0 });
    const { txid } = await builder.send();
    return (await alice.getUtxos()).find((candidate: any) => candidate.txid === txid && candidate.vout === 0);
  })();
  const factory = (await deployFactory(kind, alice, {
    fundingUtxo: factoryFunding, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress(),
  })).categoryId as string;
  const { category } = await deployPool(provider, alice, {
    id: kind === 'bch' ? 'bch' : 'usdt', kind, name: 'test', symbol: kind === 'bch' ? 'BCH' : 'USDT', decimals: 8,
    denomination: DENOMINATION, ...(kind === 'token' ? { asset: ASSET } : {}),
  }, factory);
  await provider.mine(12); // Some blocks on top, as a pool in use has; a genesis counts without them.
  const client = new PoolClient({
    id: 'pool', kind, denomination: DENOMINATION, category, ...(kind === 'token' ? { asset: ASSET } : {}),
  }, provider);

  // The browser's own history over the mock's transactions: records outside a pool's
  // transaction are skipped exactly as Fulcrum's would be.
  const history: PoolHistory = new ChainHistory(reader as any, client);
  const view = () => client.view(history);
  const finishDeposit = async () => client.finish(await view());
  return { provider, signers, client, history, view, finishDeposit, addCoin, reader, transactions, factory };
}

export function reporter() {
  let failures = 0;
  const check = (condition: unknown, message: string) => {
    if (!condition) { failures += 1; console.log('FAILED  ', message); } else console.log('ok      ', message);
  };
  const rejects = async (label: string, reason: RegExp, attempt: () => Promise<unknown>) => {
    try {
      await attempt();
      failures += 1;
      console.log('ACCEPTED', label);
    } catch (error) {
      const text = String((error as Error).message);
      if (reason.test(text)) console.log('refused ', label);
      else { failures += 1; console.log('WRONG   ', label, '->', text.slice(0, 200)); }
    }
  };
  const finish = () => {
    console.log(failures === 0 ? 'PASS' : `${failures} FAILED`);
    // Under Vitest a failed check is the test's failure; the process belongs to the runner.
    if (process.env.VITEST) {
      if (failures > 0) throw new Error(`${failures} contract check${failures === 1 ? '' : 's'} failed`);
      return;
    }
    process.exit(failures === 0 ? 0 : 1);
  };
  return { check, rejects, finish };
}
