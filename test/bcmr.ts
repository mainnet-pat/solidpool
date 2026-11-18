// How the page resolves a token's metadata (web/src/bcmr.ts), with no network: a stand-in Fulcrum
// server and a stand-in fetch.
// - A publication URI that is only a domain names that domain's well-known registry, as the BCMR
//   specification has it, which is how ParyonUSD publishes (mainnet-v1.paryonusd.com).
// - An index answers first, shown unverified; the authchain is walked behind it, and the identity
//   the chain verifies reaches onBcmrVerified.
//   tsx test/bcmr.ts
import {
  binToHex, encodeDataPush, encodeTransaction, sha256, utf8ToBin,
} from '@bitauth/libauth';
import { onBcmrVerified, registrySources, resolveBcmr, type BcmrIdentity } from '../web/src/bcmr';
import { reporter } from './lib/setup';

const { check, finish } = reporter();

// ---- where a publication URI is fetched ----
const urls = (uri: string) => registrySources(uri).map((source) => source.url);
const WELL_KNOWN = '/.well-known/bitcoin-cash-metadata-registry.json';
check(JSON.stringify(urls('mainnet-v1.paryonusd.com')) === JSON.stringify([`https://mainnet-v1.paryonusd.com${WELL_KNOWN}`]),
  `a bare domain is its well-known registry (${urls('mainnet-v1.paryonusd.com')})`);
check(JSON.stringify(urls('mainnet-v1.paryonusd.com/')) === JSON.stringify([`https://mainnet-v1.paryonusd.com${WELL_KNOWN}`]),
  'and so is one with a trailing slash');
check(JSON.stringify(urls('example.com/tokens/registry.json')) === JSON.stringify(['https://example.com/tokens/registry.json']),
  'a domain with a path is that path, over https');
check(JSON.stringify(urls('https://example.com/registry.json')) === JSON.stringify(['https://example.com/registry.json']),
  'an https URL is fetched as it is');
check(urls('http://example.com/registry.json').length === 0 && urls('localhost').length === 0 && urls('10.0.0.1').length === 0,
  'plain http, a local name and an address are refused');

// ---- an index answers first; the chain verifies behind it ----
const registryOf = (category: string, name: string, symbol: string) => ({
  version: { major: 1, minor: 0, patch: 0 },
  latestRevision: '2024-01-01T00:00:00.000Z',
  identities: { [category]: { '2024-01-01T00:00:00.000Z': { name, token: { category, symbol, decimals: 2 } } } },
});
const push = (bytes: Uint8Array) => encodeDataPush(bytes);
const hash256 = (bytes: Uint8Array) => sha256.hash(sha256.hash(bytes));

// The authchain: the authbase, whose txid is the category, then the transaction that spends its
// output 0 and publishes the registry under a bare domain, as ParyonUSD's does. That one's output
// 0 stays unspent, so it is the authhead.
const p2pkh = Uint8Array.from([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac]);
const authbase = encodeTransaction({
  version: 2,
  inputs: [{ outpointTransactionHash: new Uint8Array(32).fill(7), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of() }],
  outputs: [{ lockingBytecode: p2pkh, valueSatoshis: 1_000n }],
  locktime: 0,
});
const txid = binToHex(hash256(authbase).slice().reverse());
const registryBytes = utf8ToBin(JSON.stringify(registryOf(txid, 'Chain Name', 'CHN')));
const head = encodeTransaction({
  version: 2,
  // libauth keeps an outpoint's hash in display order, as a txid is written.
  inputs: [{ outpointTransactionHash: hash256(authbase).slice().reverse(), outpointIndex: 0, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of() }],
  outputs: [
    { lockingBytecode: p2pkh, valueSatoshis: 800n },
    { lockingBytecode: Uint8Array.from([0x6a, ...push(utf8ToBin('BCMR')), ...push(sha256.hash(registryBytes)), ...push(utf8ToBin('issuer.example'))]), valueSatoshis: 0n },
  ],
  locktime: 0,
});
const headId = binToHex(hash256(head).slice().reverse());

// A stand-in server: it serves both transactions, the history of the lock both output 0s pay, and
// says the authbase's output 0 is spent and the head's is not.
const served: Record<string, Uint8Array> = { [txid]: authbase, [headId]: head };
const reader = {
  transaction: async (asked: string) => { if (served[asked]) return binToHex(served[asked]); throw new Error('unknown transaction'); },
  history: async () => [{ tx_hash: txid, height: 1 }, { tx_hash: headId, height: 2 }],
  call: async (method: string, params: unknown[]) => {
    if (method === 'blockchain.utxo.get_info' && params[1] === 0) return params[0] === headId ? { value: 800 } : null;
    throw new Error(`unexpected ${method}`);
  },
} as any;

// A stand-in fetch: a marketplace-style index answers for the category, and the issuer's domain
// serves the registry at its well-known path. Every URL asked is kept.
const asked: string[] = [];
const indexAnswer = JSON.stringify({ [txid]: registryOf(txid, 'Index Name', 'IDX') });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  if (url === `https://index.example/bcmr?ids=${txid}`) return new Response(indexAnswer, { status: 200 });
  if (url === `https://issuer.example${WELL_KNOWN}`) return new Response(registryBytes.slice().buffer as ArrayBuffer, { status: 200 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const verified = new Promise<BcmrIdentity>((resolve) => { onBcmrVerified(resolve); });
const first = await resolveBcmr(reader, txid, { serviceUrl: 'https://index.example' });
check(first?.name === 'Index Name' && first.verified === false, `the index's answer comes first, unverified (${first?.name}, ${first?.verified})`);
const later = await Promise.race([verified, new Promise<undefined>((resolve) => { setTimeout(resolve, 10_000); })]);
check(later?.name === 'Chain Name' && later.symbol === 'CHN' && later.verified === true,
  `then the chain verifies the issuer's own identity behind it (${later?.name}, ${later?.verified})`);
check(asked.includes(`https://issuer.example${WELL_KNOWN}`), `fetched from the domain's well-known path (${asked.join(', ')})`);

// ---- a registry the app pins and serves itself ----
// The chipnet tMUSD registry in web/public/bcmr is the app's own word: it resolves pinned, before
// any index is asked, and no chain walk runs behind it to replace it.
const { readFileSync } = await import('node:fs');
const TMUSD = '9e390a944ba3cea414170fd63abe4071ca2985e78bbd57675dd683de27513312';
const pinnedFile = readFileSync(new URL(`../web/public/bcmr/${TMUSD}.json`, import.meta.url));
let chainReads = 0;
const quietReader = {
  transaction: async () => { chainReads += 1; throw new Error('not here'); },
  history: async () => { chainReads += 1; return []; },
  call: async () => { chainReads += 1; throw new Error('not here'); },
} as any;
const askedBefore = asked.length;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(url);
  if (url === `https://app.example/bcmr/${TMUSD}.json`) return new Response(pinnedFile.buffer.slice(pinnedFile.byteOffset, pinnedFile.byteOffset + pinnedFile.byteLength) as ArrayBuffer, { status: 200 });
  return new Response('not found', { status: 404 });
}) as typeof fetch;
let walkedPinned = false;
onBcmrVerified((identity) => { if (identity.category === TMUSD) walkedPinned = true; });
const pinned = await resolveBcmr(quietReader, TMUSD, { hostedBase: 'https://app.example', serviceUrl: 'https://index.example' });
await new Promise((resolve) => { setTimeout(resolve, 300); });
check(pinned?.name === 'Test Moria USD' && pinned.symbol === 'tMUSD' && pinned.decimals === 2
  && pinned.icon === 'https://meta.moria.money/m1.png' && pinned.pinned === true && pinned.verified === false,
  `the pinned chipnet tMUSD registry resolves, pinned (${JSON.stringify(pinned)})`);
check(asked.slice(askedBefore).every((url) => !url.startsWith('https://index.example')),
  `and no index is asked for it (${asked.slice(askedBefore).join(', ')})`);
check(chainReads === 0 && !walkedPinned, `and no chain walk runs behind it (${chainReads} reads)`);

finish();
