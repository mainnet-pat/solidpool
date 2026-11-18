// A category's own transactions, followed back by txid. Every call of a contract moves its
// master: it spends the master the call before it made and makes the next one. So from the
// transaction that holds the master now, the inputs lead back through every call to the genesis
// that minted it, and no lock's history is read on the way. A history can be padded: anyone
// can pay a lock, and past Fulcrum's `max_history` the server answers as if the lock had none
// (see HistoryLimit). A walk only asks for the coins at the master's lock, which every call
// reads anyway, and then for transactions by txid, which no limit stops.
import { OtherBytes, bytesToHex, hexToBytes, scripthashOfLock, type FulcrumUtxo } from './fulcrum';
import { binToHex, decodeTransaction, hash256 } from './libauth';

export type Decoded = Exclude<ReturnType<typeof decodeTransaction>, string>;

/** What a walk reads: transactions by txid, and the coins at a lock. */
export interface LineageReader {
  transaction(txid: string): Promise<unknown>;
  listUnspent?(scripthash: string): Promise<FulcrumUtxo[]>;
}

/** One transaction of the category's, and `parent`, the one whose coin of the category it spent. */
export interface Link {
  txid: string;
  transaction: Decoded;
  /** Its size in bytes. */
  size: number;
  /** Undefined for the genesis, and for a transaction that spends no coin of the category. */
  parent?: string;
}

const NO_PARENT = '00'.repeat(32);

export { OtherBytes };

/** A transaction by txid, refused unless its bytes are that txid's. */
export async function readTransaction(reader: Pick<LineageReader, 'transaction'>, txid: string): Promise<{ transaction: Decoded; size: number }> {
  const raw = await reader.transaction(txid);
  const hex = typeof raw === 'string' ? raw : (raw as { hex?: string } | undefined)?.hex;
  if (typeof hex !== 'string') throw new Error(`a server has no transaction ${txid}`);
  const bytes = hexToBytes(hex);
  // Ask a server of your own: one that sides with a deployer could still show a signed
  // transaction that was never sent, but not other bytes under a txid.
  if (binToHex(hash256(bytes).slice().reverse()) !== txid) throw new OtherBytes(`a server answered with other bytes for ${txid}`);
  const transaction = decodeTransaction(bytes);
  if (typeof transaction === 'string') throw new Error(transaction);
  return { transaction, size: bytes.length };
}

/**
 * The transaction that holds the category's master now, or else its state record, as the coins
 * at `locks` show them. Undefined when no lock shows either, as when a server lists none of a
 * lock's coins past its limit, or the reader cannot list coins.
 */
export async function headOf(reader: LineageReader, category: string, locks: Uint8Array[]): Promise<string | undefined> {
  if (!reader.listUnspent) return undefined;
  const coins = (await Promise.all(locks.map((lock) => reader.listUnspent!(scripthashOfLock(lock))))).flat();
  const of = (capability: string) => coins.find((coin) => coin.token_data?.category === category
    && coin.token_data.nft?.capability === capability);
  return (of('minting') ?? of('mutable'))?.tx_hash;
}

/**
 * The category's transactions from `head` back to the genesis, newest first. Each one's parent
 * is the transaction whose coin of the category it spent: the master where it spent the master,
 * which every call does, and else the state record, which anyone can move alone. A call spends
 * both, so either way the walk passes every call. The genesis spends output 0 of the category's
 * own transaction, and ends the walk; so does a transaction that spends no coin of the category,
 * which only a server that named a wrong head could lead to. `known` ends the walk sooner, before
 * a transaction a caller has read already.
 */
export async function* lineage(
  reader: LineageReader, category: string, head: string, known: (txid: string) => boolean = () => false,
): AsyncGenerator<Link> {
  const reads = new Map<string, Promise<{ transaction: Decoded; size: number }>>();
  const read = (txid: string) => {
    let pending = reads.get(txid);
    if (!pending) {
      pending = readTransaction(reader, txid);
      reads.set(txid, pending);
    }
    return pending;
  };
  for (let txid: string | undefined = head; txid !== undefined && !known(txid);) {
    const { transaction, size } = await read(txid);
    // The genesis is the one transaction that spends output 0 of the category's own: it ends
    // the walk, and what funded it need not be read.
    if (transaction.inputs.some((input) => input.outpointIndex === 0 && bytesToHex(input.outpointTransactionHash) === category)) {
      yield { txid, transaction, size };
      return;
    }
    let master: string | undefined;
    let record: string | undefined;
    /** Whether input `index` spent the master. A state record it spent is kept as `record`. */
    const spendsMaster = async (index: number): Promise<boolean> => {
      const input = transaction.inputs[index];
      if (input === undefined) return false;
      const parent = bytesToHex(input.outpointTransactionHash);
      if (parent === NO_PARENT) return false;
      const spent = (await read(parent)).transaction.outputs[input.outpointIndex];
      const nft = spent?.token?.nft;
      if (!nft || bytesToHex(spent.token!.category) !== category) return false;
      if (nft.capability === 'minting') {
        master = parent;
        return true;
      }
      if (nft.capability === 'mutable') record ??= parent;
      return false;
    };
    // A call keeps the master and the state record at their own inputs' indexes, and a record
    // moved alone comes back at its own index too. So the inputs at the indexes whose outputs hold
    // them are read first, the master's before the record's: anyone can move a record alone
    // beside as many coins as a transaction holds, each from a transaction of its own.
    const held = transaction.outputs.flatMap((output, index) => {
      const capability = output.token?.nft?.capability;
      return bytesToHex(output.token?.category ?? new Uint8Array()) === category && (capability === 'minting' || capability === 'mutable')
        ? [{ index, master: capability === 'minting' }] : [];
    }).sort((a, b) => Number(b.master) - Number(a.master));
    for (const { index } of held) if (await spendsMaster(index)) break;
    // Every input, only for a transaction of another shape.
    if (master === undefined && record === undefined) {
      for (let index = 0; index < transaction.inputs.length; index += 1) if (await spendsMaster(index)) break;
    }
    const parent = master ?? record;
    // Only the next transaction's read is kept: a pool's walk can be long.
    for (const kept of reads.keys()) if (kept !== parent) reads.delete(kept);
    yield { txid, transaction, size, ...(parent === undefined ? {} : { parent }) };
    txid = parent;
  }
}
