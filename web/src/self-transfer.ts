// A transaction from a wallet to itself, which makes the one coin a step needs when the wallet's
// money is spread over coins none of which can do it alone: a plain coin of at least so many
// satoshis, or a coin of a token that a deposit can spend. It spends only the wallet's own P2PKH
// coins and pays only the wallet, so it is built here with libauth, as any wallet would build it,
// and not through SolidCash: no contract is involved. A wallet this page holds no key for signs it
// through `bch_signTransaction`, as it signs everything else, and this page's own key signs it here.
import { genesisOutpointKey, isReservedGenesisOutpoint } from '@solidcash/solidcash/stateful';
import {
  SigningSerializationFlag, binToHex, createVirtualMachineBch2026, decodeTransaction, encodeDataPush,
  encodeSigningSerializationBch, encodeTokenPrefix, encodeTransaction, encodeTransactionInputSequenceNumbersForSigning,
  encodeTransactionOutpoints, encodeTransactionOutput, encodeTransactionOutputsForSigning, hash256, hexToBin,
  secp256k1, valueSatoshisToBin,
} from './libauth';

/** The relay floor a self-transfer pays unless told another, in satoshis per 1,000 bytes: 1 sat/B. */
export const DEFAULT_FEE_PER_KB = 1_000n;
/** The fee of `bytes` at `perKb` satoshis per 1,000 bytes, rounded up as a node rounds its floor. */
const feeOf = (bytes: bigint, perKb: bigint): bigint => (bytes * perKb + 999n) / 1_000n;
/** A plain P2PKH output under this is dust no node relays. */
export const P2PKH_DUST = 546n;
/** What a token coin made here holds in BCH: above a token output's dust, and under a deposit's limit. */
export const TOKEN_COIN_SATOSHIS = 1_000n;
/** A token deposit takes its coin of the asset only if the coin holds fewer satoshis than this (TokenPool.scash, `deposit`). */
export const DEPOSIT_COIN_LIMIT = 1_500n;
/** A Schnorr signature and its sighash byte, as this page signs. */
export const SCHNORR_SIGNATURE_BYTES = 65;
/** The longest ECDSA signature and its sighash byte: a wallet may sign with either, so a fee for its signature allows for this. */
export const LONGEST_SIGNATURE_BYTES = 73;

const SIGHASH_ALL_FORKID = SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId;
const FINAL_SEQUENCE = 0xffffffff;

/** A coin of the wallet's, as the page's provider lists it. */
export interface WalletCoin {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: { category: string; amount: bigint; nft?: unknown };
}

/** What a self-transfer pays the wallet, before its change. */
export interface PaidOutput {
  satoshis: bigint;
  token?: { category: string; amount: bigint };
}

export interface SelfTransfer {
  /** The coins it spends: exactly these, in this order. */
  inputs: WalletCoin[];
  /** What it pays the wallet, in this order; any BCH change follows. */
  outputs: PaidOutput[];
  /** BCH change back to the wallet, never under dust, or none when what is left is less. */
  change?: bigint;
  /** What it pays the miner: its size, with the change output if it has one, at the relay floor it was built for. */
  fee: bigint;
  /** The signature its fee allows for on each input. */
  signatureBytes: number;
}

/** Why a self-transfer cannot be made: the wallet holds too little of the asset, or of BCH. */
export interface Short { short: 'asset' | 'bch' }

export const isPlain = (coin: WalletCoin): boolean => coin.token === undefined;
/** A coin a transaction here may spend: not one a pool's creation holds for its retry (factory.ts). */
export const isFree = (coin: WalletCoin): boolean => !isReservedGenesisOutpoint(genesisOutpointKey(coin.txid, coin.vout));
/** Whether a token pool's deposit of `amount` of `asset` can spend this coin: fungible only, and under 1,500 satoshis. */
export const isDepositCoin = (asset: string, amount: bigint) => (coin: WalletCoin): boolean => coin.token?.category === asset
  && !coin.token.nft && coin.token.amount >= amount && coin.satoshis < DEPOSIT_COIN_LIMIT;

const total = (values: Array<{ satoshis: bigint }>): bigint => values.reduce((sum, value) => sum + value.satoshis, 0n);
const bySatoshis = (a: WalletCoin, b: WalletCoin): number => (a.satoshis === b.satoshis ? 0 : (a.satoshis > b.satoshis ? -1 : 1));

const libauthToken = (token: { category: string; amount: bigint }) => ({ category: hexToBin(token.category), amount: token.amount });

/** The transaction with `unlocking` in each input. */
function draft(inputs: WalletCoin[], outputs: PaidOutput[], change: bigint | undefined, lock: Uint8Array, unlocking: Uint8Array): any {
  return {
    version: 2,
    locktime: 0,
    inputs: inputs.map((coin) => ({
      outpointTransactionHash: hexToBin(coin.txid), outpointIndex: coin.vout, sequenceNumber: FINAL_SEQUENCE, unlockingBytecode: unlocking,
    })),
    outputs: [
      ...outputs.map((output) => ({
        lockingBytecode: lock, valueSatoshis: output.satoshis, ...(output.token ? { token: libauthToken(output.token) } : {}),
      })),
      ...(change === undefined ? [] : [{ lockingBytecode: lock, valueSatoshis: change }]),
    ],
  };
}

/** Its size once signed, each input's signature `signatureBytes` long. */
const sizeOf = (inputs: WalletCoin[], outputs: PaidOutput[], change: bigint | undefined, lock: Uint8Array, signatureBytes: number): bigint => {
  // A P2PKH unlocking: the signature's push, then the 33-byte public key's.
  const placeholder = new Uint8Array(1 + signatureBytes + 1 + 33);
  return BigInt(encodeTransaction(draft(inputs, outputs, change, lock, placeholder)).length);
};

/**
 * `required` and as many of `candidates`, largest first, as it takes to pay `outputs`, the fee at
 * `perKb` and a change output of at least dust. Only once no coin is left to add does what is over
 * the fee, under dust, go to the fee with no change output.
 */
function fund(
  required: WalletCoin[], outputs: PaidOutput[], candidates: WalletCoin[], lock: Uint8Array, signatureBytes: number, perKb: bigint,
): SelfTransfer | Short {
  const inputs = [...required];
  const rest = [...candidates].sort(bySatoshis);
  for (;;) {
    const left = total(inputs) - total(outputs);
    const fee = feeOf(sizeOf(inputs, outputs, P2PKH_DUST, lock, signatureBytes), perKb);
    if (left - fee >= P2PKH_DUST) return { inputs, outputs, change: left - fee, fee, signatureBytes };
    const next = rest.shift();
    if (!next) {
      const bare = feeOf(sizeOf(inputs, outputs, undefined, lock, signatureBytes), perKb);
      return left >= bare ? { inputs, outputs, fee: left, signatureBytes } : { short: 'bch' };
    }
    inputs.push(next);
  }
}

/**
 * One plain coin of `satoshis`, from the wallet's plain coins, largest first, as many as it takes:
 * for a step that spends one coin when no coin holds that much alone. A fee top-up's coin is
 * gathered while nodes ask more than 1 sat/B, so it pays their floor, `perKb`.
 */
export function gatherTransfer(
  coins: WalletCoin[], satoshis: bigint, lock: Uint8Array, signatureBytes: number, perKb = DEFAULT_FEE_PER_KB,
): SelfTransfer | Short {
  return fund([], [{ satoshis }], coins.filter(isPlain).filter(isFree), lock, signatureBytes, perKb);
}

/**
 * One coin of exactly `amount` of `asset` on 1,000 sat, which a deposit of that amount can spend:
 * from the wallet's fungible coins of the asset, largest first, as many as it takes, never one that
 * holds an NFT. What they hold beyond `amount` comes back in one coin, also on 1,000 sat; plain
 * coins pay what their own satoshis do not, and BCH change comes back.
 */
export function depositCoinTransfer(
  coins: WalletCoin[], asset: string, amount: bigint, lock: Uint8Array, signatureBytes: number, perKb = DEFAULT_FEE_PER_KB,
): SelfTransfer | Short {
  const free = coins.filter(isFree);
  const ofAsset = free
    .filter((coin) => coin.token?.category === asset && !coin.token.nft && coin.token.amount > 0n)
    .sort((a, b) => (a.token!.amount === b.token!.amount ? bySatoshis(a, b) : (a.token!.amount > b.token!.amount ? -1 : 1)));
  const chosen: WalletCoin[] = [];
  let held = 0n;
  for (const coin of ofAsset) {
    if (held >= amount) break;
    chosen.push(coin);
    held += coin.token!.amount;
  }
  if (held < amount) return { short: 'asset' };
  const outputs: PaidOutput[] = [{ satoshis: TOKEN_COIN_SATOSHIS, token: { category: asset, amount } }];
  if (held > amount) outputs.push({ satoshis: TOKEN_COIN_SATOSHIS, token: { category: asset, amount: held - amount } });
  return fund(chosen, outputs, free.filter(isPlain), lock, signatureBytes, perKb);
}

/**
 * The transaction a wallet is asked to sign, every input's unlocking bytecode empty, and its source
 * outputs: each spent coin's lock, value and token, with the input's own fields, as
 * `bch_signTransaction` takes them.
 */
export function unsignedTransfer(transfer: SelfTransfer, lock: Uint8Array): { transaction: any; sourceOutputs: any[] } {
  if (transfer.inputs.some((coin) => coin.token?.nft !== undefined)) throw new Error('A self-transfer never spends an NFT.');
  const transaction = draft(transfer.inputs, transfer.outputs, transfer.change, lock, Uint8Array.of());
  const sourceOutputs = transfer.inputs.map((coin, index) => ({
    ...transaction.inputs[index],
    lockingBytecode: lock,
    valueSatoshis: coin.satoshis,
    ...(coin.token ? { token: libauthToken(coin.token) } : {}),
  }));
  return { transaction, sourceOutputs };
}

/** Each input signed with `privateKey`: SIGHASH_ALL|FORKID, Schnorr, as a wallet signs P2PKH. */
export function signLocally(transaction: any, sourceOutputs: any[], privateKey: Uint8Array): any {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const inputs = transaction.inputs.map((input: any, index: number) => {
    const source = sourceOutputs[index];
    const digest = hash256(encodeSigningSerializationBch({
      transactionOutpoints: encodeTransactionOutpoints(transaction.inputs),
      transactionOutputs: encodeTransactionOutputsForSigning(transaction.outputs),
      transactionSequenceNumbers: encodeTransactionInputSequenceNumbersForSigning(transaction.inputs),
      transactionUtxos: encodeTransactionOutputsForSigning(sourceOutputs),
      correspondingOutput: index < transaction.outputs.length ? encodeTransactionOutput(transaction.outputs[index]) : undefined,
      coveredBytecode: source.lockingBytecode,
      locktime: transaction.locktime,
      outpointIndex: input.outpointIndex,
      outpointTransactionHash: input.outpointTransactionHash,
      outputTokenPrefix: encodeTokenPrefix(source.token),
      outputValue: valueSatoshisToBin(source.valueSatoshis),
      sequenceNumber: input.sequenceNumber,
      signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID),
      version: transaction.version,
    }));
    const signature = secp256k1.signMessageHashSchnorr(privateKey, digest);
    if (typeof signature === 'string') throw new Error(signature);
    return {
      ...input,
      unlockingBytecode: Uint8Array.from([...encodeDataPush(Uint8Array.from([...signature, SIGHASH_ALL_FORKID])), ...encodeDataPush(publicKey)]),
    };
  });
  return { ...transaction, inputs };
}

/**
 * What a wallet returned, once it is the transaction it was sent with only its inputs filled in,
 * and they verify. Anything else is refused, so nothing leaves this page that it did not judge.
 */
export function acceptSigned(sent: any, signedHex: string, sourceOutputs: any[]): any {
  const returned = decodeTransaction(hexToBin(signedHex));
  if (typeof returned === 'string') throw new Error(`The wallet returned a transaction that does not decode: ${returned}`);
  const bare = (transaction: any) => binToHex(encodeTransaction({
    ...transaction, inputs: transaction.inputs.map((input: any) => ({ ...input, unlockingBytecode: Uint8Array.of() })),
  }));
  if (bare(returned) !== bare(sent)) throw new Error('The wallet changed the transaction it was asked to sign.');
  if (returned.inputs.some((input: any) => input.unlockingBytecode.length === 0)) throw new Error('The wallet left an input unsigned.');
  return verified(returned, sourceOutputs);
}

const verified = (transaction: any, sourceOutputs: any[]): any => {
  const verdict = createVirtualMachineBch2026(true).verify({ transaction, sourceOutputs });
  if (verdict !== true) throw new Error(`The self-transfer does not verify: ${String(verdict)}`);
  return transaction;
};

/** A wallet that signs a self-transfer: with a key this page holds, or through `bch_signTransaction`. */
export interface TransferWallet {
  privateKey?: Uint8Array;
  signRequest?: (request: unknown) => Promise<{ signedTransaction: string } | undefined>;
}

/** The signature a wallet's fee allows for: this page's own Schnorr, or the longest a wallet may give. */
export const signatureBytesOf = (wallet: TransferWallet): number => (wallet.privateKey ? SCHNORR_SIGNATURE_BYTES : LONGEST_SIGNATURE_BYTES);

/**
 * Sign `transfer` and send it through `provider`, which waits until its server shows it. A wallet
 * this page holds no key for is asked once, under `userPrompt`: `asking` and `answered` hear that,
 * and a wallet that refuses, or a session that ended, signed nothing ("did not sign"). Its txid.
 */
export async function sendSelfTransfer(
  provider: { sendRawTransaction(hex: string): Promise<string> },
  transfer: SelfTransfer, lock: Uint8Array, wallet: TransferWallet, userPrompt: string,
  hooks: { asking?: () => void; answered?: () => void } = {},
): Promise<string> {
  const { transaction, sourceOutputs } = unsignedTransfer(transfer, lock);
  let signed: any;
  if (wallet.privateKey) signed = verified(signLocally(transaction, sourceOutputs, wallet.privateKey), sourceOutputs);
  else {
    if (!wallet.signRequest) throw new Error('This wallet cannot sign.');
    hooks.asking?.();
    const response = await wallet.signRequest({ transaction, sourceOutputs, broadcast: false, userPrompt }).catch(() => undefined);
    if (typeof response?.signedTransaction !== 'string') throw new Error('The wallet did not sign the transaction.');
    hooks.answered?.();
    signed = acceptSigned(transaction, response.signedTransaction, sourceOutputs);
  }
  return provider.sendRawTransaction(binToHex(encodeTransaction(signed)));
}

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** A coin a sent transaction paid the wallet, once its server lists it: the next step spends it, unconfirmed. */
export async function waitForOwnCoin(
  provider: { getUtxos(address: string): Promise<WalletCoin[]> }, address: string, txid: string, vout: number,
  { waitMs = 30_000, pollMs = 500 } = {},
): Promise<WalletCoin> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const coin = (await provider.getUtxos(address)).find((candidate) => candidate.txid === txid && candidate.vout === vout);
    if (coin) return coin;
    if (Date.now() >= deadline) throw new Error(`The coin was sent in ${txid}, but the server does not show it yet.`);
    await pause(pollMs);
  }
}
