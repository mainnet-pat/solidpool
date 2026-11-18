// The client's own pieces, against what they must agree with: circomlibjs's MiMC, the note
// format, the tree the contract keeps, and the event encoding.
//   tsx contracts/test/client.ts (npm run test:contracts runs it with the other suites)
import { buildMimcSponge } from 'circomlibjs';
import { MimcTree, mimcSponge, FIELD } from '../../web/src/mimc';
import { NullifierTree, EMPTY_NULLIFIER_ROOT } from '../../web/src/nullifiers';
import { createNote, noteString, parseNote } from '../../web/src/note';
import { parseDeposit, parseWithdrawal } from '../../web/src/history';
import { depositValue, fittingSalt, fromLe, le32, recipientField, stepWitness, workerContract } from '../../web/src/pool-client';
import { statementFits, verifierProgram, verifierSweepUnlocking } from '../../web/src/verifier';
import { sha256 } from '../../web/src/libauth';
import {
  DENOMINATION_EXPONENTS, LEVELS, SEED_SATOSHIS, SEED_TOKENS, depositFeeOf, exponentOf, finishFeeOf, poolDenominations, withdrawFeeOf,
} from '../../web/src/pools';
import { readFileSync } from 'node:fs';
import { encodeCashAddress } from '@bitauth/libauth';
import { FulcrumProvider } from '../../web/src/provider';
import { planProblems, plansProblems, type PoolPlan } from '../../scripts/lib/deploy';
import { lockOf, reporter } from './lib/setup';

const { check, rejects, finish } = reporter();
const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(1) }).address;

// ---- the hash the circuit uses ----
// circomlibjs is iden3's JavaScript for circomlib's circuits. Its MiMCSponge has the 220 round
// constants of the circomlib commit tornado-core pins, which the circuit was compiled with.
const circomMimc = await buildMimcSponge();
for (const [a, b] of [[1n, 2n], [0n, 0n], [FIELD - 1n, 12345678901234567890n]]) {
  check(mimcSponge([a, b]) === circomMimc.F.toObject(circomMimc.multiHash([a, b])), `MiMC matches circomlibjs on (${String(a).slice(0, 8)}, ${String(b).slice(0, 8)})`);
}

// ---- a plan, before anything spends ----
{
  const plan: PoolPlan = { id: 'bch01', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: 10_000_000n };
  const token: PoolPlan = { id: 'usd', kind: 'token', name: 'Test USD', symbol: 'USD', decimals: 6, denomination: 1_000_000n, asset: 'ab'.repeat(32) };
  check(planProblems(plan).length === 0 && planProblems(token).length === 0, 'plans in order have no problems');
  const refused = (label: string, change: Partial<PoolPlan>, base = plan) => check(planProblems({ ...base, ...change }).length > 0, `a plan is refused: ${label}`);
  refused('an id a note could not carry', { id: 'bch-01' });
  refused('an id in capitals', { id: 'BCH' });
  refused('no id', { id: '' });
  refused('an id that is not a string', { id: 123 as unknown as string });
  refused('a denomination of zero', { denomination: 0n });
  refused('a negative denomination', { denomination: -1n });
  refused('a BCH payout under the dust floor of a P2SH32 lock', { denomination: 575n });
  refused('a BCH denomination that is no power of ten', { denomination: 20_000_000n });
  refused('a BCH denomination one satoshi off a power of ten', { denomination: 10_000_001n });
  refused('a BCH denomination under 0.01 BCH', { denomination: 100_000n });
  refused('a BCH denomination over 100 BCH', { denomination: 100_000_000_000n });
  for (const denomination of [1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n, 10_000_000_000n]) {
    check(planProblems({ ...plan, denomination }).length === 0, `a plan takes the BCH denomination ${denomination}`);
  }
  refused('a BCH pool with an asset', { asset: 'ab'.repeat(32) });
  refused('fractional decimals', { decimals: 1.5 });
  refused('decimals past 18', { decimals: 19 });
  refused('no symbol', { symbol: ' ' });
  refused('a kind nobody knows', { kind: 'nft' as PoolPlan['kind'] });
  refused('a token denomination of zero', { denomination: 0n }, token);
  refused('a token denomination no coin can hold', { denomination: 1n << 63n }, token);
  refused('a token denomination no coin can hold beside its seed', { denomination: (1n << 63n) - 1n }, token);
  refused('a token denomination that is no power of ten', { denomination: 5_000n }, token);
  refused('a token denomination over 10^12', { denomination: 10n ** 13n }, token);
  check(planProblems({ ...token, denomination: 1n }).length === 0 && planProblems({ ...token, denomination: 10n ** 12n }).length === 0,
    'a plan takes the token denominations 10^0 and 10^12');
  check(poolDenominations('bch').length === 5 && poolDenominations('token').length === 13, 'five BCH and thirteen token denominations');
  check(exponentOf(1n) === 0n && exponentOf(1_000_000n) === 6n && exponentOf(10n ** 12n) === 12n, 'a denomination gives the exponent a pool takes');
  for (const bad of [0n, 2n, 20_000_000n, 10_000_001n]) {
    let threw = false;
    try { exponentOf(bad); } catch { threw = true; }
    check(threw, `no exponent gives ${bad}`);
  }
  // A full tree of the largest token denomination fits a CashToken amount, beside the seed.
  check(poolDenominations('token').at(-1)! * (1n << BigInt(LEVELS)) + SEED_TOKENS <= (1n << 63n) - 1n, 'a full tree of the largest token denomination fits one coin');
  check(10n * poolDenominations('token').at(-1)! * (1n << BigInt(LEVELS)) > (1n << 63n) - 1n, 'and a full tree of the next power of ten would not');
  refused('a token pool with no asset', { asset: undefined }, token);
  refused('an asset in capitals', { asset: 'AB'.repeat(32) }, token);
  refused('an asset of the wrong length', { asset: 'ab'.repeat(31) }, token);
  check(plansProblems([plan, { ...plan, denomination: 100_000_000n }]).length === 1
    && plansProblems([plan, { ...plan, denomination: 100_000_000n }])[0].includes('share an id'), 'two pools cannot share an id');
  // A factory makes one pool of an amount, or of an asset and amount, so a plan naming one twice
  // once wrote both ids into the deployment file with one category, which verify-deployment refuses.
  check(plansProblems([plan, { ...plan, id: 'bch02' }]).some((problem) => /same amount/.test(problem)), 'two pools of one amount are refused');
  check(plansProblems([token, { ...token, id: 'usd2' }]).some((problem) => /same amount/.test(problem)), 'and two of one asset and amount');
  check(plansProblems([token, { ...token, id: 'usd2', asset: 'cd'.repeat(32) }, { ...plan, id: 'bch02', denomination: 100_000_000n }, plan]).length === 0,
    'while another asset or another amount is another pool');
  // The rule is a note's own, as notes named their pools before they named categories: what a plan
  // takes, such a note carries, and the reverse.
  const carried = (id: string) => { try { parseNote(`bchnote-${id}-1-0x${'00'.repeat(62)}`); return true; } catch { return false; } };
  for (const id of ['bch01', 'bch-01', 'BCH', '']) check(carried(id) === (planProblems({ ...plan, id }).length === 0), `a plan takes the id "${id}" exactly when a note can carry it`);
}

// ---- what a provider hides ----
// A miner's reward at a lock sinks whatever spends it for 100 blocks, and a recent block can change.
{
  let coinbase = 'cb'.repeat(32);
  const reads: number[] = [];
  const coins = [
    { tx_hash: 'cb'.repeat(32), tx_pos: 0, height: 100, value: 1_000 },
    { tx_hash: 'aa'.repeat(32), tx_pos: 0, height: 100, value: 1_000 },
    { tx_hash: 'bb'.repeat(32), tx_pos: 0, height: 0, value: 1_000 },
  ];
  let tip = 100;
  const reader: any = {
    listUnspent: async () => coins,
    call: async (method: string, params: number[]) => {
      if (method === 'blockchain.headers.get_tip') return { height: tip };
      reads.push(params[0]);
      return coinbase;
    },
  };
  const provider = new FulcrumProvider('chipnet', reader);
  const listed = async () => (await provider.getUtxos(address)).map((coin: any) => coin.txid.slice(0, 2)).join();
  check(await listed() === 'aa,bb', 'an immature coinbase is hidden, and other coins are not');
  coinbase = 'dd'.repeat(32);
  check(await listed() === 'cb,aa,bb', 'a recent block that changes is read again');
  coinbase = 'cb'.repeat(32);
  tip = 198;
  reads.length = 0;
  check(await listed() === 'aa,bb', 'a coinbase one block from spendable is hidden');
  await listed();
  await listed();
  check(reads.length === 1, 'a settled block is read once');
  tip = 199;
  check(await listed() === 'cb,aa,bb', 'and it shows at 100 blocks, when a transaction can spend it');
}

// ---- notes ----
{
  const note = createNote();
  const category = '1c'.repeat(32);
  const asset = 'a5'.repeat(32);
  const text = noteString(note, { kind: 'bch', category, denomination: 100_000n }, 'chipnet');
  const parsed = parseNote(text);
  check(new RegExp(`^bchnote-chipnet-bch-${category}-100000-0x[0-9a-f]{124}$`).test(text), 'the note format names the network, the pool\'s kind and category, and the amount');
  check(parsed.commitment === note.commitment && parsed.nullifierHash === note.nullifierHash, 'a note round-trips');
  check(parsed.network === 'chipnet' && parsed.kind === 'bch' && parsed.category === category && parsed.poolId === category
    && parsed.asset === undefined && parsed.amount === 100_000n, 'and reads back what it names');
  const tokenText = noteString(note, { kind: 'token', category, asset, denomination: '100' }, 'mainnet');
  const token = parseNote(tokenText);
  check(tokenText.startsWith(`bchnote-mainnet-token-${category}-${asset}-100-0x`) && token.kind === 'token' && token.asset === asset
    && token.network === 'mainnet' && token.commitment === note.commitment, 'a token pool\'s note names its asset too');
  check(parseNote(text.replace(category, category.toUpperCase())).category === category, 'a category in capitals reads as itself');
  // Notes written before notes named their pool's kind and network: by a deployment's id or a category.
  const secret = text.slice(-124);
  for (const older of [`bchnote-bch01-100000-0x${secret}`, `bchnote-${category}-100000-0x${secret}`, `tornado-bch-bch01-100000-0x${secret}`]) {
    const read = parseNote(older);
    check(read.commitment === note.commitment && read.network === undefined && read.kind === undefined && read.category === undefined
      && read.amount === 100_000n, `an older note still reads: ${older.slice(0, 24)}…`);
  }
  check(parseNote(`bchnote-bch01-100000-0x${secret}`).poolId === 'bch01' && parseNote(`bchnote-${category}-100000-0x${secret}`).poolId === category,
    'and names its pool as it did');
  check(createNote().commitment !== note.commitment, 'notes are random');
  await rejects('a note with the wrong prefix', /not a valid note/, async () => parseNote(text.replace('bchnote', 'other')));
  await rejects('a truncated note', /not a valid note/, async () => parseNote(text.slice(0, -2)));
  await rejects('a token note without its asset', /not a valid note/, async () => parseNote(tokenText.replace(`-${asset}`, '')));
  await rejects('a BCH note with an asset', /not a valid note/, async () => parseNote(text.replace(`${category}-`, `${category}-${asset}-`)));
  await rejects('a note of a kind nobody knows', /not a valid note/, async () => parseNote(text.replace('-bch-', '-nft-')));
  await rejects('a note of no amount', /not a valid note/, async () => parseNote(text.replace('-100000-', '-0-')));
  await rejects('a note in the old prefix in the new form', /not a valid note/, async () => parseNote(text.replace('bchnote', 'tornado-bch')));
}

// ---- the tree the contract keeps, leaf by leaf ----
{
  const zeros = new MimcTree(20).zeros;
  let frontier = zeros.slice(0, 20);
  const leaves: bigint[] = [];
  let agreed = true;
  for (let index = 0; index < 37; index += 1) {
    const leaf = BigInt(1_000 + index);
    const first = stepWitness(frontier, leaf, index, 1, zeros);
    const second = stepWitness(first.frontier, first.node, index, 2, zeros);
    leaves.push(leaf);
    const tree = new MimcTree(20, leaves);
    agreed &&= second.node === tree.root() && tree.rootAt(index + 1) === tree.root()
      && second.frontier.every((value, level) => value === tree.frontier()[level]);
    frontier = second.frontier;
  }
  check(agreed, 'the steps of 37 deposits reproduce the tree\'s roots and frontier');
  const tree = new MimcTree(20, leaves);
  const recent = tree.recentRoots(8);
  check(recent.length === 8 && recent[7] === tree.root() && recent[6] === new MimcTree(20, leaves.slice(0, -1)).root(), 'the recent roots run oldest first');
  check(new MimcTree(20, [1n]).recentRoots(8)[0] === zeros[20], 'a young pool pads them with the empty root');
}

// ---- spent nullifiers ----
{
  check(new NullifierTree([]).root().every((byte, i) => byte === EMPTY_NULLIFIER_ROOT[i]), 'an empty set has the empty root');
  const spent = [1n, 2n, 3n].map(le32);
  const tree = new NullifierTree(spent);
  check(tree.has(spent[0]) && !tree.has(le32(4n)), 'the set knows what it holds');
  check(tree.path(le32(4n)).length === 64, 'a path has 64 siblings');
}

// ---- a tree built in pieces is the tree ----
{
  for (const size of [0, 1, 2, 3, 7, 8, 9, 16, 33, 100]) {
    const leaves = Array.from({ length: size }, (_, i) => BigInt(i + 1) * 987654321n);
    const whole = new MimcTree(20, leaves);
    const grown = new MimcTree(20);
    for (let at = 0, step = 1; at < size; at += step, step = (step % 5) + 1) grown.append(leaves.slice(at, at + step));
    const same = grown.root() === whole.root() && grown.frontier().every((node, i) => node === whole.frontier()[i])
      && grown.layers.every((layer, depth) => layer.length === whole.layers[depth].length && layer.every((node, i) => node === whole.layers[depth][i]));
    if (!same) check(false, `a tree of ${size} built in pieces`);
  }
  const base = new MimcTree(20, [1n, 2n, 3n]);
  const copy = base.copy();
  copy.append([4n]);
  check(base.size === 3 && base.root() === new MimcTree(20, [1n, 2n, 3n]).root(), 'growing a copy leaves the original alone');
  check(copy.root() === new MimcTree(20, [1n, 2n, 3n, 4n]).root(), 'a tree built in pieces is the tree');
}

// ---- events ----
{
  const commitment = le32(0xabcdefn);
  const deposit = (index: number[]) => Uint8Array.from([...index, 0x20, ...commitment]);
  check(parseDeposit(deposit([0x00])).leafIndex === 0, 'an event for leaf 0');
  check(parseDeposit(deposit([0x60])).leafIndex === 16, 'an event for leaf 16');
  check(parseDeposit(deposit([0x01, 0x11])).leafIndex === 17, 'an event for leaf 17');
  check(parseDeposit(deposit([0x02, 0x00, 0x04])).leafIndex === 1_024, 'an event for leaf 1,024');
  check(fromLe(parseWithdrawal(Uint8Array.from([0x20, ...commitment]))!) === 0xabcdefn, 'a withdrawal event');
  const anchor = Uint8Array.from([0x53, 0x43, 0x49, 0x44, 0x01, ...new Uint8Array(35)]);
  check(parseDeposit(new Uint8Array()) === undefined && parseWithdrawal(new Uint8Array()) === undefined, 'an empty record is no event');
  check(parseDeposit(anchor) === undefined && parseWithdrawal(anchor) === undefined, 'an anchor is no event');
  check(parseDeposit(deposit([0x05, 1, 2, 3, 4, 5])) === undefined, 'a leaf index longer than a tree holds is no event');
  check(parseDeposit(deposit([0x00]).subarray(0, 33)) === undefined, 'a short record is no event');
}

// ---- the contracts and this code name the same numbers ----
for (const [file, kind] of [['BchPool', 'bch'], ['TokenPool', 'token']] as const) {
  const source = readFileSync(new URL(`../${file}.scash`, import.meta.url), 'utf8');
  check(source.includes(`int constant WITHDRAW_FEE = ${withdrawFeeOf(kind)};`), `${file} and the client agree on the withdrawal fee`);
  check(source.includes(`int constant FINISH_FEE = ${finishFeeOf(kind)};`), `${file} and the client agree on the finish fee`);
  check(depositFeeOf(kind) >= withdrawFeeOf(kind), `${file}'s quoted deposit fee covers its smaller step`);
  check(source.includes(`int constant SEED_SATOSHIS = ${SEED_SATOSHIS};`), `${file} and the deployment agree on the satoshi seed`);
  const { least, most } = DENOMINATION_EXPONENTS[kind];
  check(source.includes(`uint8 constant LEAST_EXPONENT = ${least};`) && source.includes(`uint8 constant MOST_EXPONENT = ${most};`),
    `${file} and the client agree on the denominations`);
}
check(depositValue({ kind: 'token', denomination: 5n }) === withdrawFeeOf('token') + finishFeeOf('token'), 'a token deposit pays the fees in BCH');

// ---- one verifier, and one hashing contract, for every pool ----
{
  const verifier = verifierProgram();
  const sidecars = readFileSync(new URL('../Sidecars.scash', import.meta.url), 'utf8');
  check(sidecars.includes(`bytes constant VERIFIER_LOCK = 0x${Buffer.from(verifier.lock).toString('hex')};`), 'the pools pin the verifier the client spends');
  check(sidecars.includes(`bytes constant WORKER_LOCK = 0x${Buffer.from(lockOf(workerContract({ network: 'chipnet' }).address)).toString('hex')};`), 'and the hashing coins it spends');
  check(verifier.pieces[0].length + verifier.pieces[1].length === 8175 && verifier.R.length === 80, 'the verifier keeps its size');
  check(verifierSweepUnlocking().length === 82, 'and a sweep of one of its coins is the redeem alone');
}
check(recipientField(Uint8Array.of(1), new Uint8Array(4)) < 1n << 248n, 'a recipient fits the proof\'s field');

// ---- a proof that fits ----
{
  const fits = await statementFits();
  const lock = Uint8Array.of(0x51);
  let tooLarge = 0;
  let healed = 0;
  for (let i = 0; i < 4_000; i += 1) {
    const root = BigInt(`0x${Buffer.from(sha256.hash(Uint8Array.of(1, i & 255, i >> 8))).toString('hex')}`) % FIELD;
    const nullifierHash = BigInt(`0x${Buffer.from(sha256.hash(Uint8Array.of(2, i & 255, i >> 8))).toString('hex')}`) % FIELD;
    if (fits([root, nullifierHash, recipientField(lock, new Uint8Array(4))])) continue;
    tooLarge += 1;
    if (fits([root, nullifierHash, recipientField(lock, fittingSalt(root, nullifierHash, lock, fits))])) healed += 1;
  }
  console.log(`${tooLarge} of 4,000 random statements were too large unsalted`);
  check(tooLarge > 0 && healed === tooLarge, 'a salt makes every one of them fit');
}
finish();
