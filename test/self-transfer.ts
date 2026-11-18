// The transaction a wallet sends itself when its money is spread over coins none of which a step can
// spend alone (web/src/self-transfer.ts): a coin of a token for a deposit, or one plain coin of so
// many satoshis. Its inputs, outputs and fee as built, then signed by this page's key and by a
// wallet over bch_signTransaction, each judged by the VM.
//   tsx test/self-transfer.ts
import {
  binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction, hash160, hexToBin, secp256k1,
} from '@bitauth/libauth';
import { reporter } from './lib/setup';
import { signP2pkh } from './lib/sign';
import {
  LONGEST_SIGNATURE_BYTES, P2PKH_DUST, SCHNORR_SIGNATURE_BYTES, TOKEN_COIN_SATOSHIS, depositCoinTransfer, gatherTransfer,
  isDepositCoin, sendSelfTransfer, unsignedTransfer, type SelfTransfer, type Short, type WalletCoin,
} from '../web/src/self-transfer';

const { check, rejects, finish } = reporter();
const key = new Uint8Array(32).fill(0x52);
const pkh = hash160(secp256k1.derivePublicKeyCompressed(key) as Uint8Array);
const lock = Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
const ASSET = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
let made = 0;
const coin = (satoshis: bigint, token?: WalletCoin['token']): WalletCoin => {
  made += 1;
  return { txid: made.toString(16).padStart(64, '0'), vout: made % 3, satoshis, ...(token ? { token } : {}) };
};

// A wallet with its asset split over two coins of half a deposit, more of it on a coin that holds too
// much BCH for a deposit, the most on a coin that also holds an NFT, another token, and plain coins.
const halfA = coin(800n, { category: ASSET, amount: 500n });
const halfB = coin(800n, { category: ASSET, amount: 500n });
const rich = coin(2_000n, { category: ASSET, amount: 300n });
const withNft = coin(1_000n, { category: ASSET, amount: 5_000n, nft: { capability: 'none', commitment: '' } });
const other = coin(1_000n, { category: OTHER, amount: 9_000n });
const plains = [coin(30_000n), coin(20_000n), coin(10_000n)];
const coins = [halfA, halfB, rich, withNft, other, ...plains];

const built = (planned: SelfTransfer | Short): SelfTransfer => {
  if ('short' in planned) throw new Error(`short of ${planned.short}`);
  return planned;
};
const satoshisOf = (values: Array<{ satoshis: bigint }>) => values.reduce((sum, value) => sum + value.satoshis, 0n);
const sameCoins = (spent: WalletCoin[], expected: WalletCoin[]) => spent.length === expected.length && spent.every((input, index) => input === expected[index]);
/** The transaction as the network gets it, and whether it verifies, from what `sendSelfTransfer` sent. */
const sent: string[] = [];
const provider = { sendRawTransaction: async (hex: string) => { sent.push(hex); return 'sent'; } };
const judged = (transfer: SelfTransfer) => {
  const transaction = decodeTransaction(hexToBin(sent.at(-1)!));
  if (typeof transaction === 'string') throw new Error(transaction);
  const { sourceOutputs } = unsignedTransfer(transfer, lock);
  return { transaction, size: BigInt(encodeTransaction(transaction).length), verdict: createVirtualMachineBch2026(true).verify({ transaction, sourceOutputs }) };
};

// ---- a deposit's coin of the asset ----
const exact = built(depositCoinTransfer(coins, ASSET, 1_000n, lock, SCHNORR_SIGNATURE_BYTES));
check(sameCoins(exact.inputs, [halfA, halfB, plains[0]]),
  'the two halves are spent, and the largest plain coin pays what their satoshis cannot');
check(exact.outputs.length === 1 && exact.outputs[0].satoshis === TOKEN_COIN_SATOSHIS && exact.outputs[0].token?.category === ASSET
  && exact.outputs[0].token.amount === 1_000n, 'it pays one coin of exactly the deposit\'s amount, on 1,000 sat');
check(exact.change !== undefined && exact.change >= P2PKH_DUST
  && satoshisOf(exact.inputs) - satoshisOf(exact.outputs) - exact.change === exact.fee, 'and BCH change, never dust');
const unsigned = unsignedTransfer(exact, lock);
check(unsigned.transaction.inputs.every((input: any, index: number) => input.unlockingBytecode.length === 0
  && binToHex(input.outpointTransactionHash) === exact.inputs[index].txid && input.outpointIndex === exact.inputs[index].vout),
  'the transaction a wallet is asked to sign spends exactly those coins, unsigned');
check(unsigned.transaction.outputs.length === 2 && unsigned.transaction.outputs.every((output: any) => binToHex(output.lockingBytecode) === binToHex(lock))
  && binToHex(unsigned.transaction.outputs[0].token.category) === ASSET && unsigned.transaction.outputs[0].token.amount === 1_000n
  && unsigned.transaction.outputs[1].token === undefined && unsigned.transaction.outputs[1].valueSatoshis === exact.change,
  'and pays only the wallet: the coin, then the change');
check(unsigned.sourceOutputs.every((source: any, index: number) => binToHex(source.lockingBytecode) === binToHex(lock)
  && source.valueSatoshis === exact.inputs[index].satoshis
  && (exact.inputs[index].token === undefined ? source.token === undefined : binToHex(source.token.category) === ASSET)),
  'its source outputs carry each coin\'s lock, value and token, as bch_signTransaction takes them');
await sendSelfTransfer(provider, exact, lock, { privateKey: key }, 'unused');
const local = judged(exact);
check(local.verdict === true, `signed by this page's key, it verifies: ${String(local.verdict)}`);
check(local.size === exact.fee, `and pays 1 sat/B exactly: ${exact.fee} sat for ${local.size} B`);
check(isDepositCoin(ASSET, 1_000n)({ txid: 'made', vout: 0, satoshis: exact.outputs[0].satoshis, token: exact.outputs[0].token })
  && !isDepositCoin(ASSET, 1_000n)(rich) && !isDepositCoin(ASSET, 1_000n)(withNft), 'the coin it makes is one a deposit takes, as none of the others is');

const rest = built(depositCoinTransfer(coins, ASSET, 1_200n, lock, SCHNORR_SIGNATURE_BYTES));
check(sameCoins(rest.inputs, [halfA, halfB, rich]), 'more of the asset takes the coin too rich in BCH as well, whose satoshis pay the fee');
check(rest.outputs.length === 2 && rest.outputs.every((output) => output.satoshis === TOKEN_COIN_SATOSHIS && output.token?.category === ASSET)
  && rest.outputs[0].token!.amount === 1_200n && rest.outputs[1].token!.amount === 100n,
  'what they hold beyond the deposit comes back in one more coin of the asset, on 1,000 sat');
await sendSelfTransfer(provider, rest, lock, { privateKey: key }, 'unused');
const restSent = judged(rest);
check(restSent.verdict === true && restSent.size === rest.fee, `it verifies, at 1 sat/B: ${rest.fee} sat for ${restSent.size} B`);

const plannedCoins = [exact, rest].flatMap((transfer) => transfer.inputs);
check(!plannedCoins.some((input) => input.token?.nft !== undefined || input.token?.category === OTHER), 'no NFT, and no other token, is ever an input');
const short = depositCoinTransfer(coins, ASSET, 1_400n, lock, SCHNORR_SIGNATURE_BYTES);
check('short' in short && short.short === 'asset', 'an amount only the NFT\'s coin could make up is short of the asset');
let refusedNft = false;
try { unsignedTransfer({ ...exact, inputs: [withNft, ...exact.inputs] }, lock); } catch { refusedNft = true; }
check(refusedNft, 'and a transfer handed one to spend is refused before anything is signed');

// ---- one plain coin, gathered ----
const gathered = built(gatherTransfer(coins, 45_000n, lock, SCHNORR_SIGNATURE_BYTES));
check(sameCoins(gathered.inputs, [plains[0], plains[1]]), 'a plain coin no single coin covers takes the largest plain coins, as many as it needs');
check(gathered.outputs.length === 1 && gathered.outputs[0].satoshis === 45_000n && gathered.outputs[0].token === undefined
  && gathered.change !== undefined && gathered.change >= P2PKH_DUST, 'and pays the coin, then change');
await sendSelfTransfer(provider, gathered, lock, { privateKey: key }, 'unused');
const gatheredSent = judged(gathered);
check(gatheredSent.verdict === true && gatheredSent.size === gathered.fee, `it verifies, at 1 sat/B: ${gathered.fee} sat for ${gatheredSent.size} B`);
// A fee top-up's coin is gathered while nodes ask more than 1 sat/B, so it pays what they ask.
const atFloor = built(gatherTransfer(coins, 45_000n, lock, SCHNORR_SIGNATURE_BYTES, 2_000n));
await sendSelfTransfer(provider, atFloor, lock, { privateKey: key }, 'unused');
const atFloorSent = judged(atFloor);
check(atFloorSent.verdict === true && atFloor.fee === 2n * atFloorSent.size, `gathered at 2 sat/B, it pays that: ${atFloor.fee} sat for ${atFloorSent.size} B`);
const broke = gatherTransfer(coins, 70_000n, lock, SCHNORR_SIGNATURE_BYTES);
check('short' in broke && broke.short === 'bch', 'more than every plain coin holds is short of BCH, and token coins never make it up');

// ---- a wallet this page holds no key for ----
// It may sign with ECDSA, so the fee allows for its longest signature and stays at least 1 sat/B.
const forWallet = built(depositCoinTransfer(coins, ASSET, 1_000n, lock, LONGEST_SIGNATURE_BYTES));
const asked: any[] = [];
type Behaviour = 'sign' | 'refuse' | 'tamper' | 'skip';
const walletThat = (behaviour: Behaviour) => ({
  signRequest: async (request: any) => {
    asked.push(request);
    if (behaviour === 'refuse') throw new Error('User rejected the request');
    const { transaction, sourceOutputs } = request;
    const inputs = transaction.inputs.map((input: any, index: number) => (behaviour === 'skip' && index === 0
      ? input : { ...input, unlockingBytecode: signP2pkh(transaction, sourceOutputs, index, key) }));
    const outputs = behaviour === 'tamper'
      ? transaction.outputs.map((output: any, index: number) => (index === 1 ? { ...output, valueSatoshis: output.valueSatoshis - 100n } : output))
      : transaction.outputs;
    return { signedTransaction: binToHex(encodeTransaction({ ...transaction, inputs, outputs })) };
  },
});
const before = sent.length;
await rejects('a wallet that refuses', /did not sign/, () => sendSelfTransfer(provider, forWallet, lock, walletThat('refuse'), 'Prepare'));
await rejects('a wallet that changes an output', /changed the transaction/, () => sendSelfTransfer(provider, forWallet, lock, walletThat('tamper'), 'Prepare'));
await rejects('a wallet that leaves an input unsigned', /unsigned/, () => sendSelfTransfer(provider, forWallet, lock, walletThat('skip'), 'Prepare'));
check(sent.length === before, 'none of those sends anything');
asked.length = 0;
await sendSelfTransfer(provider, forWallet, lock, walletThat('sign'), 'Prepare a coin of exactly 10.00 USDT for this deposit');
const [request] = asked;
check(asked.length === 1 && request.broadcast === false && request.userPrompt === 'Prepare a coin of exactly 10.00 USDT for this deposit'
  && request.transaction.inputs.every((input: any) => input.unlockingBytecode.length === 0) && request.sourceOutputs.length === forWallet.inputs.length,
  'the wallet is asked once, not to broadcast, under the step\'s words, with the inputs to sign empty');
const walletSent = judged(forWallet);
check(walletSent.verdict === true, `what it signed verifies and is sent: ${String(walletSent.verdict)}`);
check(forWallet.fee === walletSent.size + 8n * BigInt(forWallet.inputs.length),
  `its fee is 1 sat/B at ECDSA's longest signature, ${forWallet.fee} sat, and a Schnorr signature leaves ${walletSent.size} B`);
finish();
