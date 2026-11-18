// SolidCash's NetworkProvider over the browser's Fulcrum client, which speaks both
// WebSocket and HTTP. It reads and broadcasts, and hides only coins nothing can spend yet.
import { Fulcrum, HistoryLimit, bytesToHex, hexToBytes, scripthashOfLock, type FulcrumUtxo } from './fulcrum';
import { binToHex, cashAddressToLockingBytecode, hash256, hexToBin } from './libauth';

const toUtxo = (utxo: FulcrumUtxo) => ({
  txid: utxo.tx_hash,
  vout: utxo.tx_pos,
  satoshis: BigInt(utxo.value),
  blockHeight: utxo.height,
  ...(utxo.token_data ? { token: { ...utxo.token_data, amount: BigInt(utxo.token_data.amount) } } : {}),
});

/** How long a server has to show a transaction it took. */
const SHOW_WAIT_MS = 15_000;

const pause = (ms: number) => new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms); });

/** How many blocks must hold a coinbase before anything can spend it. */
const COINBASE_MATURITY = 100;
/** A block this deep stays where it is, so what it holds can be remembered. */
const SETTLED_DEPTH = 12;

export class FulcrumProvider {
  /** How many transactions this has tried to send. Past that, one may land whatever a server says. */
  broadcasts = 0;

  /** The coinbases of settled blocks. A newer block can still be replaced, so that is read each time. */
  private readonly coinbases = new Map<number, Promise<string>>();

  /** What a server must list at a lock while the lock has a history (mustShow), by lock in hex. */
  private readonly shown = new Map<string, (coins: FulcrumUtxo[]) => boolean>();

  constructor(readonly network: string, readonly reader: Fulcrum) {}

  /**
   * Refuse a listing of `lock` that lacks what `shows` asks for while the lock has a history, as
   * the server's limit (HistoryLimit). For a pool's or a factory's master and state record, which
   * never leave their locks: past its `max_history` Fulcrum lists only a lock's mempool coins, with
   * no error, and anyone can pay a lock that many coins for under 1 BCH.
   */
  mustShow(lock: Uint8Array, shows: (coins: FulcrumUtxo[]) => boolean): void {
    this.shown.set(bytesToHex(lock), shows);
  }

  /**
   * Refuse an empty listing of a lock every pool shares, the verifier's or the hashing coins', as
   * the server's limit when the lock holds coins all the same: the server lists none of them, the
   * lock has a first transaction, and its balance, which Fulcrum tallies up to its limit before it
   * stops, is not zero. A lock swept for real, as anyone may sweep a coin left unmoved for 1,440
   * blocks, has a balance of zero, and one whose only coins are a miner's young reward, which
   * getUtxosForLockingBytecode hides, lists them.
   */
  async refuseHiddenCoins(lock: Uint8Array): Promise<void> {
    const scripthash = scripthashOfLock(lock);
    if ((await this.reader.listUnspent(scripthash)).length > 0) return;
    if (await this.reader.firstUse(scripthash) === null) return;
    const { confirmed, unconfirmed } = await this.reader.balance(scripthash);
    if (Number(confirmed) + Number(unconfirmed) > 0) throw new HistoryLimit(scripthash);
  }

  private coinbaseOf(height: number, tip: number): Promise<string> {
    const read = () => this.reader.call<string>('blockchain.transaction.id_from_pos', [height, 0]);
    if (tip - height + 1 < SETTLED_DEPTH) return read();
    let txid = this.coinbases.get(height);
    if (!txid) {
      txid = read();
      this.coinbases.set(height, txid);
      txid.catch(() => this.coinbases.delete(height));
    }
    return txid;
  }

  /**
   * The coins a transaction can spend. A miner can pay a block's reward to any lock, and for
   * 100 blocks that coin looks like any other and sinks whatever spends it, so at a pool's
   * lock it could stop calls for all that time.
   */
  private async spendable(coins: FulcrumUtxo[]): Promise<FulcrumUtxo[]> {
    const confirmed = coins.filter((coin) => coin.height > 0);
    if (confirmed.length === 0) return coins;
    const tip = await this.getBlockHeight();
    const young = confirmed.filter((coin) => tip - coin.height + 1 < COINBASE_MATURITY);
    const coinbases = await Promise.all(young.map((coin) => this.coinbaseOf(coin.height, tip)));
    const immature = new Set(young.filter((coin, i) => coin.tx_hash === coinbases[i]).map((coin) => coin.tx_hash));
    return coins.filter((coin) => !immature.has(coin.tx_hash));
  }

  async getUtxos(address: string) {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') throw new Error(decoded);
    return this.getUtxosForLockingBytecode(decoded.bytecode);
  }

  async getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string) {
    const lock = typeof lockingBytecode === 'string' ? hexToBytes(lockingBytecode) : lockingBytecode;
    const scripthash = scripthashOfLock(lock);
    const listed = await this.reader.listUnspent(scripthash);
    const shows = this.shown.get(bytesToHex(lock));
    if (shows && !shows(listed) && await this.reader.firstUse(scripthash) !== null) throw new HistoryLimit(scripthash);
    return (await this.spendable(listed)).map(toUtxo);
  }

  async getBlockHeight(): Promise<number> {
    return (await this.reader.call<{ height: number }>('blockchain.headers.get_tip')).height;
  }

  async getRawTransaction(txid: string): Promise<string> {
    const raw = await this.reader.transaction(txid);
    return typeof raw === 'string' ? raw : (raw as { hex: string }).hex;
  }

  /**
   * Broadcast, then wait until the server can show it. A server sees a mempool a moment
   * after a node does, and a next step built before then would spend what this just spent.
   */
  async sendRawTransaction(txHex: string): Promise<string> {
    this.broadcasts += 1;
    const txid = await this.reader.broadcast(txHex);
    if (txid !== binToHex(hash256(hexToBin(txHex)).slice().reverse())) throw new Error('The server answered for another transaction.');
    for (const deadline = Date.now() + SHOW_WAIT_MS; Date.now() < deadline;) {
      const height = this.reader.call('blockchain.transaction.get_height', [txid]).catch(() => null);
      if (await Promise.race([height, pause(deadline - Date.now())]) !== null) return txid;
      await pause(250);
    }
    throw new Error('The server took this transaction and cannot show it.');
  }
}

export { bytesToHex };
