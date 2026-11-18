// A pool's history, read from Fulcrum alone. Deposit and Withdraw are event NFTs of the
// pool's own category, and a spent one stays in the history of its address.
//
// Not everything of that category at an event's address is an event, and the chain holds
// the others for good, so they are skipped and never refused:
// - after 144 blocks anyone can spend an event back to its own address, and an NFT moved
//   out through a bare OP_1 lock can go there too. Neither is in a transaction of the
//   pool's, whose first output is the recreated master;
// - a transaction of the pool's refuses every other record of its category except one with
//   an empty commitment, or the SDK's 40-byte-or-longer anchor, and neither parses as an
//   event.
//
// PoolClient.view checks whatever is left against the pool's state, so a server that
// hides or invents events is caught there.
//
// Anyone can also pay an event's address plain coins, about 800 sat each, and past Fulcrum's
// `max_history` the server answers that address's history as if it had none. Such a cut
// history (HistoryLimit) is not read as no events: the pool's own transactions are read instead,
// back by txid from the one that holds the master now (lineage.ts). Every call of the pool's
// spends the master the one before it made, so the walk passes every event, and reads every
// transaction of the pool's, not only those with an event.
import { getDataNftAddress, getEventNftAddress } from '@solidcash/solidcash/stateful';
import { Fulcrum, HistoryLimit, bytesToHex, hexToBytes, scripthashOfLock, wholeHistory } from './fulcrum';
import { cashAddressToLockingBytecode, decodeTransaction } from './libauth';
import { headOf, lineage, type Decoded } from './lineage';
import { fromLe, type DepositRecord, type PoolClient, type PoolHistory } from './pool-client';

type Output = Exclude<ReturnType<typeof decodeTransaction>, string>['outputs'][number];
/**
 * An event, and the transaction of the pool's that holds it: its size, and for a withdrawal the
 * locks it pays one denomination of the pool, in hex.
 */
interface Event { commitment: Uint8Array; txid: string; size: number; payees: string[] }

const HASH_PUSH = 0x20;
const DEPOSIT = 'Deposit(uint32,bytes32)';
const WITHDRAW = 'Withdraw(bytes32)';
const NO_PAYEES: string[] = [];
/** A leaf index below 2^20 is 3 bytes as a VM number. */
const LONGEST_NUMBER = 4;

/** An event's first argument: a VM number. OP_0 and OP_1..OP_16 are their own encoding. */
function readNumber(bytes: Uint8Array): { value: number; next: number } | undefined {
  const op = bytes[0];
  if (op === 0x00) return { value: 0, next: 1 };
  if (op >= 0x51 && op <= 0x60) return { value: op - 0x50, next: 1 };
  if (op === undefined || op < 1 || op > LONGEST_NUMBER || bytes.length < 1 + op) return undefined;
  return { value: Number(fromLe(bytes.subarray(1, 1 + op))), next: 1 + op };
}

/** A commitment's Deposit event, or nothing if it is not one. */
export const parseDeposit = (commitment: Uint8Array): DepositRecord | undefined => {
  const index = readNumber(commitment);
  if (!index || commitment.length !== index.next + 33 || commitment[index.next] !== HASH_PUSH) return undefined;
  return { leafIndex: index.value, commitment: fromLe(commitment.subarray(index.next + 1)) };
};

/** A commitment's Withdraw event, or nothing if it is not one. */
export const parseWithdrawal = (commitment: Uint8Array): Uint8Array | undefined => (
  commitment.length === 33 && commitment[0] === HASH_PUSH ? commitment.subarray(1) : undefined);

/** The same history from a server's archive, which PoolClient.view checks like any other. */
export class ArchiveHistory implements PoolHistory {
  private read: Promise<{ deposits: DepositRecord[]; withdrawals: Uint8Array[] }> | null = null;

  constructor(private readonly url: string, private readonly poolId: string) {}

  private async fetchRecords() {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/archive/${this.poolId}`);
    if (!response.ok) throw new Error(`archive: HTTP ${response.status}`);
    const body = await response.json() as { deposits: Array<{ leafIndex: number; commitment: string }>; withdrawals: string[] };
    return {
      deposits: body.deposits.map(({ leafIndex, commitment }) => ({ leafIndex, commitment: BigInt(commitment) })),
      withdrawals: body.withdrawals.map(hexToBytes),
    };
  }

  private records() {
    // Each view asks for both lists, so they come from one read.
    this.read ??= this.fetchRecords().finally(() => { this.read = null; });
    return this.read;
  }

  async deposits() { return (await this.records()).deposits; }
  async withdrawals() { return (await this.records()).withdrawals; }
}

export class ChainHistory implements PoolHistory {
  // Transactions never change, so one page reads each of them once.
  private readonly seen = new Map<string, Event[]>();
  /** The pool's transactions a walk has read, newest first. */
  private walked: string[] = [];
  private walking: Promise<string[] | undefined> | null = null;

  constructor(private readonly reader: Fulcrum, private readonly client: PoolClient) {}

  private lockOf(signature: string): Uint8Array {
    return this.lockAt(getEventNftAddress(this.client.contract.inner, this.client.pool.category, signature));
  }

  private lockAt(address: string): Uint8Array {
    const decoded = cashAddressToLockingBytecode(address);
    if (typeof decoded === 'string') throw new Error(decoded);
    return decoded.bytecode;
  }

  /**
   * The transactions to read a signature's events from, oldest first: its address's history, or
   * every transaction of the pool's when the server's limit cut that history short.
   */
  private async transactionsOf(signature: string): Promise<string[]> {
    try {
      return (await wholeHistory(this.reader, scripthashOfLock(this.lockOf(signature)))).map((entry) => entry.tx_hash);
    } catch (error) {
      if (!(error instanceof HistoryLimit)) throw error;
      const walked = await this.walk();
      if (walked === undefined) throw error;
      return walked;
    }
  }

  /**
   * The pool's transactions, oldest first, read back by txid from the one that holds its master
   * now to its creation, or to the newest one an earlier walk read. Undefined when the server
   * shows neither the master nor the state record. Each one's events are kept as it is read.
   */
  private walk(): Promise<string[] | undefined> {
    this.walking ??= (async () => {
      const { category } = this.client.pool;
      const head = await headOf(this.reader, category, [
        this.lockAt(this.client.contract.address), this.lockAt(getDataNftAddress(this.client.contract.inner, category)),
      ]);
      if (head === undefined) return undefined;
      const known = new Set(this.walked);
      let joined: string | undefined;
      const isKnown = (txid: string) => {
        if (known.has(txid)) joined = txid;
        return joined !== undefined;
      };
      const fresh: string[] = [];
      for await (const { txid, transaction, size } of lineage(this.reader, category, head, isKnown)) {
        fresh.push(txid);
        for (const signature of [DEPOSIT, WITHDRAW]) this.seen.set(`${signature}:${txid}`, this.eventsOf(signature, txid, transaction, size));
      }
      // A walk stops at the first transaction an earlier one read, so what that one read before it
      // still holds. One that went past every such transaction read the chain whole.
      this.walked = [...fresh, ...(joined === undefined ? [] : this.walked.slice(this.walked.indexOf(joined)))];
      return this.walked.slice().reverse();
    })().finally(() => { this.walking = null; });
    return this.walking;
  }

  /** A transaction's events of one signature, if it is the pool's. */
  private eventsOf(signature: string, txid: string, decoded: Decoded, size: number): Event[] {
    const lockHex = bytesToHex(this.lockOf(signature));
    const masterHex = bytesToHex(this.lockAt(this.client.contract.address));
    const category = this.client.pool.category;
    const [master] = decoded.outputs;
    const ofThePool = master !== undefined && bytesToHex(master.lockingBytecode) === masterHex
      && master.token?.nft?.capability === 'minting' && bytesToHex(master.token.category) === category;
    const payees = ofThePool && signature === WITHDRAW
      ? decoded.outputs.filter((output) => this.paysOne(output)).map((output) => bytesToHex(output.lockingBytecode))
      : NO_PAYEES;
    return !ofThePool ? [] : decoded.outputs
      .filter((output) => bytesToHex(output.lockingBytecode) === lockHex
        && output.token?.nft?.capability === 'none' && bytesToHex(output.token.category) === category)
      .map((output) => ({ commitment: output.token!.nft!.commitment, txid, size, payees }));
  }

  /** A transaction's events of one signature, if it is the pool's, read once. */
  private async eventsIn(signature: string, txid: string): Promise<Event[]> {
    const key = `${signature}:${txid}`;
    let events = this.seen.get(key);
    if (!events) {
      const raw = await this.reader.transaction(txid);
      const hex = typeof raw === 'string' ? raw : (raw as { hex: string }).hex;
      const decoded = decodeTransaction(hexToBytes(hex));
      if (typeof decoded === 'string') throw new Error(decoded);
      events = this.eventsOf(signature, txid, decoded, hex.length / 2);
      this.seen.set(key, events);
    }
    return events;
  }

  /** Whether an output carries one denomination of the pool, as `withdraw` pays its recipient. */
  private paysOne({ valueSatoshis, token }: Output): boolean {
    const { kind, denomination, asset } = this.client.pool;
    return kind === 'bch'
      ? !token && valueSatoshis === denomination
      : token !== undefined && !token.nft && bytesToHex(token.category) === asset && token.amount === denomination;
  }

  private async events(signature: string): Promise<Event[]> {
    const found: Event[] = [];
    for (const txid of await this.transactionsOf(signature)) found.push(...await this.eventsIn(signature, txid));
    return found;
  }

  /**
   * The withdrawal that spent a nullifier hash, under whatever txid it landed: anyone who relays
   * a withdrawal can change its txid, though not what it does. Newest first, since a withdrawal
   * just sent is at the end. A page asks this of the server its withdrawal went out through,
   * which has seen that withdrawal already.
   */
  async withdrawalOf(nullifierHash: Uint8Array): Promise<Event | undefined> {
    const wanted = bytesToHex(nullifierHash);
    for (const txid of (await this.transactionsOf(WITHDRAW)).slice().reverse()) {
      const event = (await this.eventsIn(WITHDRAW, txid)).find(({ commitment }) => {
        const hash = parseWithdrawal(commitment);
        return hash !== undefined && bytesToHex(hash) === wanted;
      });
      if (event) return event;
    }
    return undefined;
  }

  /**
   * The withdrawal that spent a nullifier hash, if it pays `lock` one denomination of the pool,
   * as the pool's `withdraw` pays its recipient. That it is in the pool's own state is the
   * caller's to check.
   */
  async payment(nullifierHash: Uint8Array, lock: Uint8Array): Promise<{ txid: string; size: number } | undefined> {
    const withdrawal = await this.withdrawalOf(nullifierHash);
    if (!withdrawal?.payees.includes(bytesToHex(lock))) return undefined;
    return { txid: withdrawal.txid, size: withdrawal.size };
  }

  async deposits(): Promise<DepositRecord[]> {
    return (await this.events(DEPOSIT)).flatMap(({ commitment }) => parseDeposit(commitment) ?? []);
  }

  async withdrawals(): Promise<Uint8Array[]> {
    return (await this.events(WITHDRAW)).flatMap(({ commitment }) => parseWithdrawal(commitment) ?? []);
  }
}
