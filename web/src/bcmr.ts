// Bitcoin Cash Metadata Registries (BCMR): a CashToken category's name, symbol, decimals and
// icon, as its issuer published them. This is the browser's resolver, and nothing it reads
// is trusted.
//
// Sources, in the order resolution takes them, each falling through on a miss:
//  1. localStorage (`pools.bcmr.v2:<category>`), written only from identities parsed here;
//  2. the registry this app serves itself, at `<hostedBase>/bcmr/<category>.json`;
//  3. a BCMR index (`bcmr.paytaca.com`, one registry per request) or a marketplace-style
//     service (`/bcmr?ids=<category>`);
//  4. the category's authchain, read from Fulcrum: output 0 of the category transaction, then
//     output 0 of each transaction that spends the one before, up to the authhead (an output 0
//     that is unspent or unspendable). The latest publication output on that chain
//     (`OP_RETURN "BCMR" <sha256> <uri...>`) names the registry, and only bytes whose sha256
//     matches the publication are accepted. Only that answer is `verified`.
//
// A registry is anyone's to write, so it is read as hostile data: every URI must be https on a
// public host (or an IPFS CID through a gateway), bodies are capped at 2 MiB and read no
// further, the walk and its per-lock candidate list are bounded, and every field is
// re-validated before it reaches a page.

import { Fulcrum, bytesToHex, hexToBytes, scripthashOfLock } from './fulcrum';
import { binToUtf8, decodeAuthenticationInstructions, decodeTransaction, sha256 } from './libauth';

export type BcmrIdentity = {
  category: string;
  name: string;
  symbol?: string;
  decimals?: number;
  icon?: string;
  description?: string;
  verified: boolean;
  /** From a registry this app pins and serves itself (web/public/bcmr): the app vouches for it. */
  pinned?: boolean;
};

export type BcmrOptions = { serviceUrl?: string; hostedBase?: string };

/** How long one index, service or hosted-registry request may take. */
export const BCMR_FETCH_TIMEOUT_MS = 15_000;
/** How long a publication's sources have, together, to serve its registry: they are asked at once. */
export const BCMR_REGISTRY_FETCH_BUDGET_MS = 10_000;
/** The most a registry may be: a large registry runs to a few hundred kilobytes. */
export const BCMR_REGISTRY_BYTES_LIMIT = 2 * 1024 * 1024;
/** The IPFS gateways a registry or an icon is tried at, in order. */
export const IPFS_GATEWAYS: readonly string[] = [
  'https://ipfs.io', 'https://dweb.link', 'https://gateway.pinata.cloud', 'https://ipfs.pat.mn',
];

/** How many authchain transactions a walk follows before it gives up. */
const AUTHCHAIN_STEP_LIMIT = 64;
/** How many transactions of one lock's history a walk reads looking for a spender. */
const SPENDER_CANDIDATE_LIMIT = 256;
// v4: identities gained `pinned`, and an answer cached unverified is checked again.
const CACHE_PREFIX = 'pools.bcmr.v4:';
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 400;
const MAXIMUM_DECIMALS = 18;
const OP_RETURN = 0x6a;
/** An IPFS CID in a URI: `ipfs://<cid>`, a gateway's `/ipfs/<cid>` path, or a bare CID. */
const CID = /(?:^ipfs:\/\/|\/ipfs\/|^)(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})/;
/** A BCMR symbol in plain ASCII, as a row shows one. */
const SYMBOL = /^[A-Za-z0-9$._-]{1,20}$/;
/** Characters that steer or hide text: controls, zero-width marks and bidirectional overrides. */
const HIDDEN_CHARACTERS = /[\p{Cc}\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
/** Names that only mean something on a local network. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|home\.arpa)$/;

/** A registry snapshot, as the JSON states it: any field may be missing or of any type. */
type Snapshot = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A body's bytes, read up to `limit`: undefined once it passes, and nothing past it is held. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  // A registry has no reason to sit on a bare address, and refusing every literal covers the private ranges.
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) return false;
  return host.includes('.') && !LOCAL_NAME.test(host);
}

/** `url` as a URL a page may fetch: https on a public host, with no credentials in it. */
function fetchableUrl(url: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  return parsed.protocol === 'https:' && isPublicHostname(parsed.hostname) ? parsed : undefined;
}

/** What a URI names on IPFS: its CID and any path under it, up to a character a gateway path has no use for. */
function ipfsContent(uri: string): { readonly content: string; readonly viaGateway: boolean } | undefined {
  const match = CID.exec(uri);
  if (match === null) return undefined;
  const cid = match[1];
  if (cid === undefined) return undefined;
  // The slice starts at the CID, so the content is the CID and any path under it.
  const content = /^[A-Za-z0-9._/-]*/.exec(uri.slice(match.index + match[0].length - cid.length))?.[0];
  if (content === undefined) return undefined;
  return { content, viaGateway: match[0].startsWith('/ipfs/') };
}

/** One place a registry may be fetched from. A host a publication names may not redirect the request elsewhere. */
type RegistrySource = { readonly url: string; readonly redirect: RequestRedirect };

/** Where a domain serves its registry, as the BCMR specification has it for a URI that is only a domain. */
export const WELL_KNOWN_REGISTRY = '/.well-known/bitcoin-cash-metadata-registry.json';

/**
 * Every URL a publication URI may be fetched from. An IPFS URI is tried at each gateway, after
 * the gateway the URI names itself. A URI with no scheme is https, as publication builders
 * write one, and one that names only a domain is that domain's well-known registry (a
 * publication of `example.com` is https://example.com/.well-known/bitcoin-cash-metadata-registry.json).
 * Anything but an IPFS CID or a public https URL is refused.
 */
export function registrySources(uri: string): RegistrySource[] {
  const trimmed = uri.trim();
  if (trimmed === '') return [];
  const ipfs = ipfsContent(trimmed);
  if (ipfs === undefined) {
    const named = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
      ? trimmed
      : /^[^/?#]+\/?$/.test(trimmed) ? `https://${trimmed.replace(/\/$/, '')}${WELL_KNOWN_REGISTRY}` : `https://${trimmed}`;
    const url = fetchableUrl(named);
    return url === undefined ? [] : [{ url: url.toString(), redirect: 'error' }];
  }
  const gateways: RegistrySource[] = IPFS_GATEWAYS.map((gateway) => ({
    url: `${gateway}/ipfs/${ipfs.content}`, redirect: 'follow',
  }));
  const own = ipfs.viaGateway ? fetchableUrl(trimmed) : undefined;
  return own === undefined ? gateways : [{ url: own.toString(), redirect: 'error' }, ...gateways];
}

/** A capped body: someone else's host learns nothing but an address, and no cookie goes with the request. */
async function fetchCapped(
  url: string, redirect: RequestRedirect, timeoutMs: number, cancel?: AbortSignal,
): Promise<Uint8Array> {
  const signal = cancel ?? (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetch(url, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = await readCapped(response.body, BCMR_REGISTRY_BYTES_LIMIT);
  if (bytes === undefined) throw new Error(`${url}: over ${BCMR_REGISTRY_BYTES_LIMIT} bytes`);
  return bytes;
}

/** A response body as JSON, or undefined when it is not JSON at all. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value;
  } catch {
    return undefined;
  }
}

/** The registry this app serves for a category, which is the app's own bytes and still unverified. */
async function hostedRegistry(hostedBase: string | undefined, category: string): Promise<unknown> {
  const base = (hostedBase ?? '').replace(/\/+$/, '');
  try {
    return parseJson(await fetchCapped(`${base}/bcmr/${category}.json`, 'follow', BCMR_FETCH_TIMEOUT_MS));
  } catch {
    // A release with no registry for this category leaves resolution to the index and the chain.
    return undefined;
  }
}

/** Whether `serviceUrl` is Paytaca's index, which takes one category per request. */
function isIndexService(serviceUrl: string): boolean {
  try {
    return new URL(serviceUrl).hostname === 'bcmr.paytaca.com';
  } catch {
    return false;
  }
}

/**
 * One category's registry as a BCMR service serves it: Paytaca's index answers the registry
 * itself, and a marketplace-style backend answers `{ [category]: registry }`.
 */
async function serviceRegistry(serviceUrl: string, category: string): Promise<unknown> {
  try {
    if (isIndexService(serviceUrl)) {
      return parseJson(await fetchCapped(
        `${serviceUrl}/api/registries/${category}/latest/`, 'follow', BCMR_FETCH_TIMEOUT_MS,
      ));
    }
    const answers = parseJson(await fetchCapped(
      `${serviceUrl}/bcmr?ids=${encodeURIComponent(category)}`, 'follow', BCMR_FETCH_TIMEOUT_MS,
    ));
    return isRecord(answers) ? answers[category] : undefined;
  } catch {
    // The chain walk answers what the service does not.
    return undefined;
  }
}

/**
 * A publication: the registry's SHA-256 and the URIs it is served at, or the CID that addresses
 * it in place of the hash (as mainnet-js reads one). Either commits the chain to the bytes.
 */
type Publication = { readonly hash?: Uint8Array; readonly cid?: string; readonly uris: readonly string[] };

/** The publication a locking bytecode states, if it is one. */
function publicationOf(lockingBytecode: Uint8Array): Publication | undefined {
  if (lockingBytecode.length < 2 || lockingBytecode[0] !== OP_RETURN) return undefined;
  const pushes: (Uint8Array | undefined)[] = [];
  for (const instruction of decodeAuthenticationInstructions(lockingBytecode.subarray(1))) {
    if ('malformed' in instruction) return undefined;
    pushes.push('data' in instruction ? instruction.data : undefined);
  }
  if (pushes.length < 2 || pushes.some((push) => push === undefined)) return undefined;
  const data = pushes as Uint8Array[];
  if (binToUtf8(data[0]) !== 'BCMR') return undefined;
  if (data[1].length === 32) return { hash: data[1], uris: data.slice(2).map((uri) => binToUtf8(uri)) };
  const cid = binToUtf8(data[1]);
  return data.length === 2 && CID.test(cid) ? { cid, uris: [`ipfs://${cid}`] } : undefined;
}

type DecodedTransaction = Exclude<ReturnType<typeof decodeTransaction>, string>;

type HistoryEntry = { readonly tx_hash: string; readonly height: number };

/** What one walk has read: transactions by txid, and each lock's history by its scripthash. */
type WalkReads = {
  readonly transactions: Map<string, Promise<DecodedTransaction | undefined>>;
  readonly histories: Map<string, Promise<readonly HistoryEntry[]>>;
};

/** A transaction the node serves, or undefined for one it does not. */
function transactionOf(reader: Fulcrum, txid: string, reads: WalkReads): Promise<DecodedTransaction | undefined> {
  let read = reads.transactions.get(txid);
  if (read === undefined) {
    read = (async () => {
      try {
        const raw: unknown = await reader.transaction(txid);
        const hex = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.hex === 'string' ? raw.hex : undefined;
        if (hex === undefined) return undefined;
        const decoded = decodeTransaction(hexToBytes(hex));
        return typeof decoded === 'string' ? undefined : decoded;
      } catch {
        return undefined;
      }
    })();
    reads.transactions.set(txid, read);
  }
  return read;
}

/** A lock's history, read once per walk; a server that will not answer leaves it empty. */
function historyOf(reader: Fulcrum, scripthash: string, reads: WalkReads): Promise<readonly HistoryEntry[]> {
  let history = reads.histories.get(scripthash);
  if (history === undefined) {
    history = reader.history(scripthash).then(
      (entries) => (Array.isArray(entries) ? entries : []).map((entry) => ({
        tx_hash: entry.tx_hash, height: typeof entry.height === 'number' ? entry.height : 0,
      })),
      () => [],
    );
    reads.histories.set(scripthash, history);
  }
  return history;
}

/** Whether `txid:0` is still unspent, which ends an authchain: that output is the identity's authhead. */
async function outputZeroUnspent(reader: Fulcrum, txid: string): Promise<boolean> {
  try {
    const info = await reader.call<unknown>('blockchain.utxo.get_info', [txid, 0]);
    return info !== null && info !== undefined;
  } catch {
    return false;
  }
}

/**
 * The transaction that spends `txid:0`, found in the history of that output's lock. Only a
 * transaction that can spend it is read: one confirmed in the parent's block or a later one,
 * or one in the mempool, and only the mempool's when the parent is unconfirmed.
 */
async function spenderOfOutputZero(
  reader: Fulcrum, txid: string, transaction: DecodedTransaction, reads: WalkReads,
): Promise<string | undefined> {
  const output = transaction.outputs.at(0);
  if (output === undefined) return undefined;
  const history = await historyOf(reader, scripthashOfLock(output.lockingBytecode), reads);
  const parent = history.find((entry) => entry.tx_hash === txid);
  const unconfirmed = (entry: HistoryEntry): boolean => entry.height <= 0;
  const candidates = history.filter((entry) => entry.tx_hash !== txid && (
    parent === undefined
      ? true
      : unconfirmed(parent) ? unconfirmed(entry) : unconfirmed(entry) || entry.height >= parent.height
  )).slice(0, SPENDER_CANDIDATE_LIMIT);
  for (const { tx_hash: candidate } of candidates) {
    const spender = await transactionOf(reader, candidate, reads);
    if (spender?.inputs.some((input) => input.outpointIndex === 0
      && bytesToHex(input.outpointTransactionHash) === txid)) {
      return candidate;
    }
  }
  return undefined;
}

/** What a walk found: the latest publication it passed, and whether it reached the authchain's head. */
type WalkResult = { readonly publication: Publication | undefined; readonly complete: boolean };

/**
 * The latest publication on the category's authchain. A walk that stops short of the head (the
 * step limit, or a spender the node does not show) says so: a later publication may have
 * replaced the one it found.
 */
async function latestPublication(reader: Fulcrum, category: string): Promise<WalkResult> {
  const reads: WalkReads = { transactions: new Map(), histories: new Map() };
  let txid = category;
  let latest: Publication | undefined;
  for (let step = 0; step < AUTHCHAIN_STEP_LIMIT; step += 1) {
    const transaction = await transactionOf(reader, txid, reads);
    if (transaction === undefined) break;
    for (const output of transaction.outputs) {
      const publication = publicationOf(output.lockingBytecode);
      if (publication !== undefined) latest = publication;
    }
    const identity = transaction.outputs.at(0);
    // An output 0 that is unspendable, or still unspent, is the head: this transaction is the authhead.
    if (identity === undefined || identity.lockingBytecode[0] === OP_RETURN
      || await outputZeroUnspent(reader, txid)) {
      return { publication: latest, complete: true };
    }
    const spender = await spenderOfOutputZero(reader, txid, transaction, reads);
    if (spender === undefined) break;
    txid = spender;
  }
  return { publication: latest, complete: false };
}

/** A registry, and whether its bytes are the ones the chain committed to. */
type FetchedRegistry = { readonly registry: Record<string, unknown>; readonly committed: boolean };

/**
 * The registry a publication names: the first of its sources to serve bytes the publication
 * commits to by hash. Bytes that contradict the hash are refused. A publication that states
 * only a CID has no hash to check, so its bytes are accepted unverified. Every source is
 * asked at once within one budget, and the rest are cancelled once one serves.
 */
async function fetchRegistry(publication: Publication): Promise<FetchedRegistry | undefined> {
  const sources = publication.uris.flatMap(registrySources);
  if (sources.length === 0) return undefined;
  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), BCMR_REGISTRY_FETCH_BUDGET_MS);
  const serve = async ({ url, redirect }: RegistrySource): Promise<FetchedRegistry> => {
    const bytes = await fetchCapped(url, redirect, BCMR_REGISTRY_FETCH_BUDGET_MS, controller.signal);
    if (publication.hash !== undefined && bytesToHex(sha256.hash(bytes)) !== bytesToHex(publication.hash)) {
      throw new Error(`${url}: not the bytes the publication commits to`);
    }
    const registry = parseJson(bytes);
    if (!isRecord(registry)) throw new Error(`${url}: not a registry`);
    return { registry, committed: publication.hash !== undefined };
  };
  try {
    return await Promise.any(sources.map(serve));
  } catch {
    // No source served the committed bytes within the budget.
    return undefined;
  } finally {
    clearTimeout(budget);
    controller.abort();
  }
}

/** The snapshot in effect: the latest whose timestamp is not in the future. */
function currentSnapshot(history: Record<string, unknown>): Snapshot | undefined {
  const now = Date.now();
  const latest = Object.keys(history)
    .map((time) => ({ time, at: Date.parse(time) }))
    .filter(({ at }) => Number.isFinite(at) && at <= now)
    .sort((left, right) => right.at - left.at)[0];
  const snapshot = latest === undefined ? undefined : history[latest.time];
  return isRecord(snapshot) ? snapshot : undefined;
}

/**
 * A registry's snapshot of a category: the one in effect in the category's identity history,
 * or the identity whose token states the category. A single snapshot with no history around
 * it is taken as it is.
 */
function snapshotOf(registry: unknown, category: string): Snapshot | undefined {
  if (!isRecord(registry) || !isRecord(registry.identities)) return undefined;
  const identities = registry.identities;
  const asSnapshot = (entry: unknown): Snapshot | undefined => {
    if (!isRecord(entry)) return undefined;
    const keys = Object.keys(entry);
    if (keys.length > 0 && keys.every((key) => /^\d{4}-/.test(key))) return currentSnapshot(entry);
    return typeof entry.name === 'string' ? entry : undefined;
  };
  for (const [key, entry] of Object.entries(identities)) {
    if (key.toLowerCase() !== category) continue;
    const own = asSnapshot(entry);
    if (own !== undefined) return own;
  }
  for (const entry of Object.values(identities)) {
    const snapshot = asSnapshot(entry);
    if (snapshot === undefined || !isRecord(snapshot.token)) continue;
    if (typeof snapshot.token.category === 'string' && snapshot.token.category.toLowerCase() === category) {
      return snapshot;
    }
  }
  return undefined;
}

/** Text someone else wrote, as a row shows it: without steering characters, trimmed and short. */
function displayText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(HIDDEN_CHARACTERS, '').trim().slice(0, limit);
  return text === '' ? undefined : text;
}

/** Decimals as the CHIP states them, or as some registries write them in a string. */
function registryDecimals(value: unknown): number | undefined {
  const decimals = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= MAXIMUM_DECIMALS
    ? decimals : undefined;
}

/**
 * An icon as a URL the page will show: IPFS through the first gateway, otherwise a public https
 * URL. The app's own registry may also name a path on this origin, which is how the local devnet
 * serves the pre-cached icons it ships with.
 */
function iconUrl(uri: unknown, hosted = false): string | undefined {
  if (typeof uri !== 'string') return undefined;
  const trimmed = uri.trim();
  if (trimmed === '') return undefined;
  if (hosted && /^\/(?!\/)/.test(trimmed)) return trimmed;
  const ipfs = ipfsContent(trimmed);
  if (ipfs !== undefined) return `${IPFS_GATEWAYS[0]}/ipfs/${ipfs.content}`;
  return fetchableUrl(trimmed)?.toString();
}

/** The identity a snapshot states, or undefined when it states no usable name. */
function identityFrom(
  category: string, snapshot: Snapshot, verified: boolean, hosted = false,
): BcmrIdentity | undefined {
  const name = displayText(snapshot.name, NAME_LIMIT);
  if (name === undefined) return undefined;
  const token = isRecord(snapshot.token) ? snapshot.token : undefined;
  const uris = isRecord(snapshot.uris) ? snapshot.uris : undefined;
  const symbol = typeof token?.symbol === 'string' && SYMBOL.test(token.symbol) ? token.symbol : undefined;
  const decimals = token === undefined ? undefined : registryDecimals(token.decimals);
  const description = displayText(snapshot.description, DESCRIPTION_LIMIT);
  const icon = uris === undefined ? undefined : iconUrl(uris.icon, hosted);
  return {
    category,
    name,
    verified,
    ...(hosted ? { pinned: true } : {}),
    ...(symbol === undefined ? {} : { symbol }),
    ...(decimals === undefined ? {} : { decimals }),
    ...(icon === undefined ? {} : { icon }),
    ...(description === undefined ? {} : { description }),
  };
}

const categoryKey = (category: string): string => category.replace(/^0x/, '').toLowerCase();

function storage(): Storage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const cacheKey = (category: string): string => `${CACHE_PREFIX}${categoryKey(category)}`;

/** A category's cached identity, or undefined when there is none or the entry is corrupt. */
export function cachedBcmr(category: string): BcmrIdentity | undefined {
  const store = storage();
  if (store === undefined) return undefined;
  try {
    const stored = store.getItem(cacheKey(category));
    if (stored === null) return undefined;
    const entry: unknown = JSON.parse(stored);
    if (!isRecord(entry)) return undefined;
    const { name, symbol, decimals, icon, description, verified, pinned } = entry;
    if (typeof entry.category !== 'string' || categoryKey(entry.category) !== categoryKey(category)) return undefined;
    if (typeof name !== 'string' || name === '') return undefined;
    return {
      category: categoryKey(category),
      name,
      verified: verified === true,
      ...(pinned === true ? { pinned: true } : {}),
      ...(typeof symbol === 'string' ? { symbol } : {}),
      ...(typeof decimals === 'number' && Number.isInteger(decimals) ? { decimals } : {}),
      ...(typeof icon === 'string' ? { icon } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    };
  } catch {
    // Corrupt JSON, or storage that refuses to be read, is a miss.
    return undefined;
  }
}

/** Caches a parsed identity. Storage is best effort: a full quota leaves resolution to the network. */
export function cacheBcmr(identity: BcmrIdentity): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(cacheKey(identity.category), JSON.stringify(identity));
  } catch {
    // Best effort.
  }
}

/** The identity the chain itself names: the walk's latest publication, and the bytes it commits to. */
async function walkedIdentity(reader: Fulcrum, category: string): Promise<BcmrIdentity | undefined> {
  const { publication, complete } = await latestPublication(reader, category);
  if (publication === undefined) return undefined;
  const fetched = await fetchRegistry(publication);
  if (fetched === undefined) return undefined;
  const snapshot = snapshotOf(fetched.registry, category);
  if (snapshot === undefined) return undefined;
  return identityFrom(category, snapshot, complete && fetched.committed);
}

// ---- verifying what an index or the cache answered ------------------------------------------

/** Who is told when the chain verifies an identity that was shown unverified. */
const verifiedListeners = new Set<(identity: BcmrIdentity) => void>();

/**
 * Be told of each identity the chain verifies after an index or this browser's cache gave it
 * unverified, so a page can replace what it shows. Returns the way to stop being told.
 */
export function onBcmrVerified(listener: (identity: BcmrIdentity) => void): () => void {
  verifiedListeners.add(listener);
  return () => { verifiedListeners.delete(listener); };
}

/** The categories this page has walked, or is walking, behind an unverified answer: each once. */
const verifying = new Set<string>();
/** How many such walks run at once, so a wallet of many tokens does not flood its server. */
const VERIFY_CONCURRENCY = 3;
let verifyRunning = 0;
const verifyWaiting: Array<() => void> = [];

/**
 * Walk a category's authchain behind an answer shown unverified. An identity the chain verifies
 * is cached and given to every listener; anything else leaves the answer as it was.
 */
function verifyLater(reader: Fulcrum, category: string): void {
  if (verifying.has(category)) return;
  verifying.add(category);
  const run = async (): Promise<void> => {
    verifyRunning += 1;
    try {
      const walked = await walkedIdentity(reader, category).catch(() => undefined);
      if (walked?.verified) {
        cacheBcmr(walked);
        for (const listener of verifiedListeners) {
          try { listener(walked); } catch { /* a listener's own failure is its own */ }
        }
      }
    } finally {
      verifyRunning -= 1;
      verifyWaiting.shift()?.();
    }
  };
  if (verifyRunning < VERIFY_CONCURRENCY) void run();
  else verifyWaiting.push(() => { void run(); });
}

/**
 * What resolution reads when nothing is cached: the app's own registry, an index, then the chain.
 * An index answers at once and is shown unverified, as it says; the chain is walked behind it, and
 * an identity the chain verifies replaces it (onBcmrVerified).
 */
async function resolveFresh(
  reader: Fulcrum, category: string, options: BcmrOptions,
): Promise<BcmrIdentity | undefined> {
  const hosted = snapshotOf(await hostedRegistry(options.hostedBase, category), category);
  if (hosted !== undefined) return identityFrom(category, hosted, false, true);
  const serviceUrl = options.serviceUrl?.replace(/\/+$/, '');
  if (serviceUrl !== undefined && serviceUrl !== '') {
    const served = snapshotOf(await serviceRegistry(serviceUrl, category), category);
    if (served !== undefined) {
      verifyLater(reader, category);
      return identityFrom(category, served, false);
    }
  }
  try {
    return await walkedIdentity(reader, category);
  } catch {
    return undefined;
  }
}

/** The resolutions running now, by category, so a page that asks twice does the work once. */
const inFlight = new Map<string, Promise<BcmrIdentity | undefined>>();

function resolveOnce(
  category: string, start: () => Promise<BcmrIdentity | undefined>,
): Promise<BcmrIdentity | undefined> {
  const running = inFlight.get(category);
  if (running !== undefined) return running;
  const promise = start();
  inFlight.set(category, promise);
  const clear = (): void => {
    if (inFlight.get(category) === promise) inFlight.delete(category);
  };
  promise.then(clear, clear);
  return promise;
}

/**
 * The metadata a category's issuer published, or undefined when none resolves: the browser's
 * cache, the registry this app serves, a BCMR service, then the category's authchain. Only the
 * last is `verified`, and only when the walk reached the authhead and the bytes matched the
 * publication. Successful identities are cached; misses are not, so a registry written after
 * one is found next time. An answer a BCMR service or the cache gives unverified is returned at
 * once, and the authchain is walked behind it, once per category a page: see onBcmrVerified.
 */
export async function resolveBcmr(
  reader: Fulcrum, category: string, options: BcmrOptions = {},
): Promise<BcmrIdentity | undefined> {
  const key = categoryKey(category);
  return resolveOnce(key, async () => {
    const cached = cachedBcmr(key);
    if (cached !== undefined) {
      // An identity cached unverified is checked against the chain once a page; a pinned one is
      // the app's own word, which a walk does not replace.
      if (!cached.verified && !cached.pinned) verifyLater(reader, key);
      return cached;
    }
    const identity = await resolveFresh(reader, key, options);
    if (identity !== undefined) cacheBcmr(identity);
    return identity;
  });
}

/** Several categories' identities, keyed by category; a category with no registry is left out. */
export async function resolveBcmrBatch(
  reader: Fulcrum, categories: readonly string[], options: BcmrOptions = {},
): Promise<Record<string, BcmrIdentity>> {
  const identities = await Promise.all(categories.map((category) => resolveBcmr(reader, category, options)));
  const found: Record<string, BcmrIdentity> = {};
  for (const identity of identities) {
    if (identity !== undefined) found[identity.category] = identity;
  }
  return found;
}
