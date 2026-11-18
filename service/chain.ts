// A local chain for development and tests. It is SolidCash's production-profile mock
// (BCH's size limits, the standard relay VM, dust, and no coin the network does not
// hold) with the Electrum view the browser reads. It holds no pool rules: what it
// accepts is what the VM accepts, so the contracts are tested as they will run.
//
// Its state is its transactions: they are saved as they arrive and replayed on start.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TransactionBuilder } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';

const hex = (bytes: Uint8Array) => binToHex(bytes);
const scripthash = (lock: Uint8Array) => hex(Uint8Array.from(sha256.hash(lock)).reverse());
const reversed = (bytes: Uint8Array) => Uint8Array.from(bytes).reverse();

export class LocalChain {
  readonly provider: any = new MockNetworkProvider({ profile: 'production' });
  private readonly locks = new Map<string, Uint8Array>();
  private readonly history = new Map<string, Set<string>>();
  private readonly raw: string[] = [];
  private replaying = false;
  faucet: any;
  /** Where a saved chain this build could not read was put on start, if there was one. */
  setAside: string | undefined;

  private constructor(private readonly statePath: string) {}

  static async open(statePath: string): Promise<LocalChain> {
    const chain = new LocalChain(statePath);
    await chain.start();
    return chain;
  }

  private async start() {
    const send = this.provider.sendRawTransaction.bind(this.provider);
    this.provider.sendRawTransaction = async (txHex: string) => {
      const txid = await send(txHex);
      await this.record(txHex, txid);
      return txid;
    };
    const sendPrepared = this.provider.sendPreparedTransaction?.bind(this.provider);
    if (sendPrepared) {
      this.provider.sendPreparedTransaction = async (prepared: { rawHex: string }) => {
        const txid = await sendPrepared(prepared);
        await this.record(prepared.rawHex, txid);
        return txid;
      };
    }
    // The first signer is the chain's own funded account, the same on every start.
    [this.faucet] = await this.provider.getSigners(1, { satoshis: 2_000_000_000n, fundingUtxos: 16, genesisFundingUtxos: 8 });
    for (const coin of await this.faucet.getUtxos()) {
      const parent = decodeTransaction(hexToBin(await this.provider.getRawTransaction(coin.txid)));
      if (typeof parent !== 'string') this.index(coin.txid, parent.outputs.map((output) => output.lockingBytecode));
    }
    if (existsSync(this.statePath)) {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { saved = undefined; }
      if (!Array.isArray(saved) || saved.some((txHex) => typeof txHex !== 'string')) {
        // An older service saved its chain in another form. It stays beside the new one, renamed.
        this.setAside = `${this.statePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.old`;
        renameSync(this.statePath, this.setAside);
      } else {
        this.replaying = true;
        for (const txHex of saved as string[]) await this.provider.sendRawTransaction(txHex);
        this.replaying = false;
      }
    }
  }

  private index(txid: string, locks: Uint8Array[]) {
    for (const lock of locks) {
      const key = scripthash(lock);
      this.locks.set(key, lock);
      if (!this.history.has(key)) this.history.set(key, new Set());
      this.history.get(key)!.add(txid);
    }
  }

  private async record(txHex: string, txid: string) {
    const decoded = decodeTransaction(hexToBin(txHex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const spent = [];
    for (const input of decoded.inputs) {
      const parentHex = await this.provider.getRawTransaction(hex(reversed(reversed(input.outpointTransactionHash))));
      const parent = decodeTransaction(hexToBin(parentHex));
      if (typeof parent !== 'string') spent.push(parent.outputs[input.outpointIndex].lockingBytecode);
    }
    this.index(txid, [...spent, ...decoded.outputs.map((output) => output.lockingBytecode)]);
    this.raw.push(txHex);
    if (!this.replaying) {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.raw));
      renameSync(`${this.statePath}.tmp`, this.statePath);
    }
  }

  // ---- the Electrum methods the browser and SolidCash call ----

  async rpc(method: string, params: any[]): Promise<unknown> {
    switch (method) {
      case 'server.version': return ['pools-service 0.1', '1.5'];
      case 'server.ping': return null;
      case 'blockchain.headers.get_tip': return { height: await this.provider.getBlockHeight(), hex: '' };
      case 'blockchain.transaction.get': return this.provider.getRawTransaction(params[0]);
      case 'blockchain.transaction.get_height': return 0;
      case 'blockchain.transaction.broadcast': return this.provider.sendRawTransaction(params[0]);
      // The mock relays at 1,000 sat per 1,000 bytes, BCHN's default, and Fulcrum says it in BCH.
      case 'blockchain.relayfee': return 0.00001;
      case 'blockchain.scripthash.get_history':
        return [...(this.history.get(params[0]) ?? [])].map((tx_hash) => ({ tx_hash, height: 0 }));
      // A lock's mempool part, which the page's history reads ask beside its history. Every
      // transaction here is unconfirmed, so it is the whole history.
      case 'blockchain.scripthash.get_mempool':
        return [...(this.history.get(params[0]) ?? [])].map((tx_hash) => ({ tx_hash, height: 0 }));
      // Fulcrum's first use (1.9.6 and later), which the page's history reads ask before a
      // history, as on mainnet: the first transaction that touched the lock, or null for one
      // nothing touched.
      case 'blockchain.scripthash.get_first_use': {
        const [first] = this.history.get(params[0]) ?? [];
        return first === undefined ? null : { tx_hash: first, height: 0 };
      }
      // A lock's balance, which the page asks only when a shared lock lists no coins, to tell a
      // server past its limit from a lock swept for real. Every coin here is unconfirmed, as in
      // listunspent below, so the balance is their sum.
      case 'blockchain.scripthash.get_balance': {
        const lock = this.locks.get(params[0]);
        const coins = lock ? await this.provider.getUtxosForLockingBytecode(lock) : [];
        return { confirmed: 0, unconfirmed: coins.reduce((sum: number, coin: any) => sum + Number(coin.satoshis), 0) };
      }
      case 'blockchain.scripthash.listunspent': {
        const lock = this.locks.get(params[0]);
        if (!lock) return [];
        const coins = await this.provider.getUtxosForLockingBytecode(lock);
        return coins.map((coin: any) => ({
          tx_hash: coin.txid, tx_pos: coin.vout, height: 0, value: Number(coin.satoshis),
          ...(coin.token ? { token_data: { ...coin.token, amount: String(coin.token.amount) } } : {}),
        }));
      }
      default: throw new Error(`method ${method} is not served here`);
    }
  }

  /** Test funds for an address: BCH, and a coin of each token pool's asset. */
  async fund(address: string, tokens: Array<{ category: string; amount: bigint }>, satoshis = 5_000_000n): Promise<string> {
    const coins = (await this.faucet.getUtxos()).sort((a: any, b: any) => Number(b.satoshis - a.satoshis));
    const builder = new TransactionBuilder({ provider: this.provider });
    builder.addInput(coins.find((coin: any) => !coin.token), this.faucet.unlockP2PKH());
    builder.addOutput({ to: address, amount: satoshis });
    for (const { category, amount } of tokens) {
      const coin = coins.find((candidate: any) => candidate.token?.category === category && candidate.token.amount >= amount);
      if (!coin) continue;
      builder.addInput(coin, this.faucet.unlockP2PKH());
      builder.addOutput({ to: this.lockOf(address), amount: 1_000n, token: { category, amount } });
      if (coin.token.amount > amount) {
        builder.addOutput({ to: this.lockOf(this.faucet.getAddress()), amount: 1_000n, token: { category, amount: coin.token.amount - amount } });
      }
    }
    builder.addBchChangeOutputIfNeeded({ to: this.faucet.getAddress(), feeRate: 1.0 });
    return (await builder.send()).txid;
  }

  lockOf(address: string): Uint8Array {
    return (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
  }
}
