import { cacheClear } from '../src/cache';
import { loadIndexedRows } from '../src/indexer';
import { namesCategory, poolOfNote, readNoteText } from '../src/note-text';
import {
  checkServerAt, publicChainOf, serverCalls, serverGenesis, serverUrlProblem,
} from '../src/network-check';
import { KNOWN_SERVERS as PUBLIC_SERVERS, type KnownServer } from '../src/known-servers';
import { networkFor, readPageSettings, type PageSettings } from '../src/page-settings';
import { poolDenominations } from '../src/pools';
import { POOL_SKELETON, TERMS_VERSION } from './markup';
import { morph } from './morph';

// UI logic, mounted client-side. The state, notes, proofs and transactions all live in
// this browser, through the engine and the user's Fulcrum server.
// The wallet bundle is large and only the wallet dialogs need it; keep it off the first paint.
let walletApiPromise: Promise<any> | null = null;
const loadWalletApi = () => {
  if (!walletApiPromise) walletApiPromise = import('@solidpool/wallet');
  return walletApiPromise;
};
let ENGINE: any = null;

const NETWORK_KEY = 'pools.network';
const FULCRUM_KEY = 'pools.fulcrumEndpoint';
const BROADCAST_KEY = 'pools.broadcastEndpoint';
const INDEXER_KEY = 'pools.indexerUrl';
const TERMS_KEY = 'pools.termsAccepted';
const SOURCE_KEY = 'pools.dataSource';
/** Pools this browser made, on this network. A deployment file cannot list a pool after it is made. */
const CREATED_KEY = (network: string) => `pools.created.${network}`;

export async function mountUi(): Promise<void> {
  if (typeof window === 'undefined' || (window as any).__poolsUiMounted) return;
  (window as any).__poolsUiMounted = true;

const $ = (id: string): any => document.getElementById(id);
let STATE: any = null; // the pool rows, and the network they were read for
let OPEN: string | null = null; // the pool selected in the pool dialog
let POOL_VIEW: string | null = null; // the asset whose dialog is open
let REFRESH = 0; // so a late check cannot overwrite a newer refresh
const CHECKING = new Set<string>(); // pools a background chain read is still checking
let ACTIVE_SOURCE: 'indexer' | 'trustless' | null = null; // where the rows on screen came from
let CONNECTED: boolean | null = null;
// A note exists only on this page until the user keeps a copy, and it stays on screen
// until its deposit is settled one way or the other.
let pendingDeposit: { note: string; poolId: string } | null = null;
type NoteStep = 'unsaved' | 'saved' | 'sending' | 'done' | 'failed' | 'unknown';
let noteStep: NoteStep = 'unsaved';
let busy = false; // this page has a deposit or withdrawal in flight
const initialConfig = () => ({
  network: '', networkId: 'chipnet', networkLabel: '', networks: [],
  pools: [], walletConnectProjectId: null, walletConnectRelayUrl: null, chain: 'bch:bchtest',
  addressPrefix: 'bchtest', localAccounts: false, faucetUrl: undefined, bcmrServiceUrl: undefined,
  indexerUrl: undefined, fulcrumUrl: undefined, broadcastUrl: undefined, factories: undefined, prover: undefined,
});
let CONFIG: any = initialConfig();
/** BCMR identities already read, by category, so a redraw does not ask again. */
const IDENTITIES = new Map<string, any>();

const formatUnits = (value, decimals) => {
  const v = BigInt(value).toString().padStart(decimals + 1, '0');
  if (decimals === 0) return v;
  const whole = v.slice(0, -decimals);
  const frac = v.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
// Everything shown from a server or a chain is data, never markup.
const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
)[c]);
// A server's or a wallet's words are not this page's. A hostile Fulcrum could otherwise
// write instructions here, in the page's own voice.
const shown = (error: any): string => {
  if (error?.notice) return error.message;
  console.warn(error);
  return 'Something went wrong. Check your connection and try again. If it keeps happening, open Settings.';
};
const notice = (text: string) => Object.assign(new Error(text), { notice: true });
// Below this many notes a withdrawal is easy to tie to its deposit.
const THIN_POOL = 10;
const shortHash = (value: string, head = 8, tail = 6) => (value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value);
// BCH has no registry of its own, so its icon ships with the page.
const BCH_ICON = '/bch.svg';
// A BCMR icon where its issuer published one, and otherwise the symbol's first letter.
const assetIcon = (icon: string | undefined, symbol: string, size = 20) => (icon
  ? `<img class="asset-icon" src="${esc(icon)}" alt="" width="${size}" height="${size}" loading="lazy" />`
  : `<span class="asset-icon letter" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.max(10, Math.round(size * 0.48))}px">${esc((symbol || '?').slice(0, 1).toUpperCase())}</span>`);
// The rows of the network the page is on. A read made for another, which a refresh begun before a
// switch could finish after it, is never shown or acted on.
const statePools = (): any[] => (STATE?.network === CONFIG.networkId ? STATE.pools ?? [] : []);
const poolOf = (id) => statePools().find((p) => p.id === id);
const fmtAmount = (pool, value) => `${formatUnits(value, pool.decimals)} ${pool.symbol}`;

// The bar floats over the page, so a success clears itself and never covers the
// next action. Progress and errors stay until something replaces them.
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const setStatus = (text, cls = '') => {
  clearTimeout(statusTimer);
  $('status').className = 'status ' + cls;
  $('status').textContent = text;
  $('statusBar').classList.toggle('hidden', !text);
  if (cls === 'ok') statusTimer = setTimeout(() => $('statusBar').classList.add('hidden'), 6000);
};
const dismissStatus = () => {
  clearTimeout(statusTimer);
  $('statusBar').classList.add('hidden');
};
$('statusBar').addEventListener('click', dismissStatus);
$('statusBar').addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    dismissStatus();
  }
});

// A server belongs to the network it serves: the one chosen for mainnet must not be read on chipnet.
const networkKey = (base: string) => `${base}.${CONFIG.networkId}`;
// The unscoped key held the one server an older page used; it belonged to a test network. A
// public network reads it only if it is encrypted.
const legacy = (key: string) => {
  const value = CONFIG.networkId === 'mainnet' ? '' : localStorage.getItem(key) ?? '';
  return value && serverUrlProblem(CONFIG.networkId, value) ? '' : value;
};
// An older page proxied the devnet's chain through this app at /api/fulcrum, which is gone: a
// browser that saved it reads the chain's WebSocket again. One may also have saved a public
// network's server without TLS, which is not read now either.
const RETIRED_SERVER = '/api/fulcrum';
const saved = (key: string, network: string = CONFIG.networkId): string | null => {
  const value = localStorage.getItem(key);
  if (value !== RETIRED_SERVER && !(value && serverUrlProblem(network, value))) return value;
  localStorage.removeItem(key);
  return null;
};
const savedEndpoint = () => saved(networkKey(FULCRUM_KEY)) ?? legacy(FULCRUM_KEY);
const savedBroadcast = () => saved(networkKey(BROADCAST_KEY)) ?? legacy(BROADCAST_KEY);
const savedIndexer = () => localStorage.getItem(networkKey(INDEXER_KEY)) ?? '';

/**
 * A network's own servers, as the app names them: the page's for the network it is on, and for
 * another, those its settings list beside it, so that a switch in Settings offers the servers of the
 * network switched to, not a guess made on the network the page is on.
 */
const ownServers = (network: string): { fulcrumUrl?: string; broadcastUrl?: string } => (network === CONFIG.networkId
  ? CONFIG : (CONFIG.networks ?? []).find((choice: any) => choice.id === network) ?? {});
/** Fulcrum servers offered by the page. A custom one is checked before it is saved. */
/** The devnet's chain: the address the app names for it, else the service's default. */
const DEVNET_SERVER = 'ws://127.0.0.1:8788';
const devnetServer = (): string => ownServers('devnet').fulcrumUrl || DEVNET_SERVER;
// Mainnet's and chipnet's are named in src/known-servers.ts, which the deploy command reads too.
const KNOWN_SERVERS: Record<string, readonly KnownServer[]> = {
  ...PUBLIC_SERVERS,
  // The devnet's chain is the local service's Electrum WebSocket, at the address the app names for it.
  get devnet() { return [{ label: 'This app’s local chain', url: devnetServer() }]; },
};
const knownFor = (network: string) => KNOWN_SERVERS[network] ?? KNOWN_SERVERS.chipnet;
const defaultServer = (network: string): string => knownFor(network)[0]?.url ?? '';
const defaultChain = (network: string): string => ownServers(network).fulcrumUrl || defaultServer(network);
/** A second server, preferably a different operator, so one side cannot see both. */
const WITHDRAWAL_DEFAULT: Record<string, string> = {
  mainnet: 'wss://electroncash.dk:50004',
  chipnet: 'wss://chipnet.imaginary.cash:50004',
  get devnet() { return devnetServer(); },
};
const defaultWithdrawal = (network: string): string => {
  if (network === CONFIG.networkId) {
    // A custom chain has no second server of its own; the page uses it for both sides.
    if (savedEndpoint()) return defaultChain(network);
    return CONFIG.broadcastUrl || WITHDRAWAL_DEFAULT[network] || defaultChain(network);
  }
  return ownServers(network).broadcastUrl || WITHDRAWAL_DEFAULT[network] || defaultChain(network);
};
const serverNetwork = (url: string): string | undefined => {
  for (const [network, options] of Object.entries(KNOWN_SERVERS)) {
    if (options.some((option) => option.url === url)) return network;
  }
  return undefined;
};

/**
 * Ask a custom Fulcrum server whether it will do: on mainnet and chipnet it must run Fulcrum 1.10
 * or later and follow the chosen network, by its genesis and a block past the network's last split
 * (src/network-check.ts). The devnet has no fixed genesis, so there only a public network's server
 * is refused. Returns what is wrong, or undefined.
 */
async function checkFulcrum(url: string, network: string): Promise<string | undefined> {
  if (network === 'mainnet' || network === 'chipnet') {
    const { problem, unreachable } = await checkServerAt(url, network);
    if (unreachable) return 'did not answer';
    return problem ? `will not do for ${network}: ${problem}` : undefined;
  }
  let calls: ReturnType<typeof serverCalls>;
  try { calls = serverCalls(url); } catch { return 'did not answer'; }
  const { call, close } = calls;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve('did not answer in time'), 8_000); });
  const check = (async () => {
    try { await call('server.version', ['solidpool', '1.4']); } catch { return 'did not answer'; }
    const chain = publicChainOf(await serverGenesis(call).catch(() => undefined));
    return chain ? `follows ${chain}: choose that network above` : undefined;
  })();
  try {
    return await Promise.race([check, late]);
  } finally {
    clearTimeout(timer);
    close();
  }
}

/** An indexer answers the app's own archive shape, so a live one returns those two lists. */
async function checkIndexer(url: string): Promise<boolean> {
  const base = url.replace(/\/+$/, '');
  const pool = allPools()[0];
  try {
    const response = await fetch(`${base}/archive/${encodeURIComponent(pool?.category?.toLowerCase() ?? '')}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body === 'object' && body !== null
      && (Array.isArray(body.deposits) || Array.isArray(body.withdrawals));
  } catch { return false; }
}

function renderIndexerFields(network: string): void {
  const saved = localStorage.getItem(`${INDEXER_KEY}.${network}`) ?? '';
  const current = network === CONFIG.networkId ? CONFIG.indexerUrl ?? '' : '';
  $('indexerServer').innerHTML = '<option value="__app">This app’s indexer</option>'
    + '<option value="__custom">Custom indexer…</option>';
  $('indexerServer').value = saved ? '__custom' : '__app';
  $('indexerEndpoint').value = saved;
  $('indexerEndpoint').placeholder = current || '/api/indexer';
  $('indexerEndpoint').classList.toggle('hidden', !saved);
  $('indexerHint').textContent = saved
    ? 'A custom archive for the quick preview. It must serve the same /archive endpoints.'
    : network !== CONFIG.networkId
      ? 'The selected network’s app indexer is set when you switch to it.'
      : current
        ? `The app’s archive for the quick preview: ${current}`
        : 'This network has no indexer; the quick preview is unavailable.';
}
$('indexerServer').onchange = () => {
  const custom = $('indexerServer').value === '__custom';
  $('indexerEndpoint').classList.toggle('hidden', !custom);
  if (custom) $('indexerEndpoint').focus();
};

function updateWithdrawalWarning(): void {
  const chain = $('fulcrumServer').value === '__custom'
    ? $('fulcrumEndpoint').value.trim() : $('fulcrumServer').value;
  const withdrawal = $('broadcastServer').value === '__same' ? chain
    : $('broadcastServer').value === '__custom' ? $('broadcastEndpoint').value.trim() : $('broadcastServer').value;
  $('withdrawalWarn').classList.toggle('hidden', !chain || !withdrawal || withdrawal !== chain);
}

function renderServerFields(network: string): void {
  const chainDefault = defaultChain(network);
  const chainSaved = saved(`${FULCRUM_KEY}.${network}`, network) ?? '';
  const options = knownFor(network);
  const chainValue = chainSaved || chainDefault;
  const chainKnown = options.some((option) => option.url === chainValue);
  const serverOptions = options.map((option) => (
    `<option value="${esc(option.url)}">${esc(option.label)}</option>`)).join('');
  $('fulcrumServer').innerHTML = serverOptions + '<option value="__custom">Custom server…</option>';
  $('fulcrumServer').value = chainKnown ? chainValue : '__custom';
  $('fulcrumEndpoint').value = chainKnown ? '' : chainValue;
  $('fulcrumEndpoint').placeholder = chainDefault || 'wss://fulcrum.example.com:50004';
  $('fulcrumEndpoint').classList.toggle('hidden', chainKnown);

  const withdrawalSaved = saved(`${BROADCAST_KEY}.${network}`, network) ?? '';
  const withdrawalValue = withdrawalSaved || defaultWithdrawal(network);
  const withdrawalKnown = options.some((option) => option.url === withdrawalValue);
  $('broadcastServer').innerHTML = '<option value="__same">Same as the chain server</option>'
    + serverOptions + '<option value="__custom">Custom server…</option>';
  if (withdrawalKnown) $('broadcastServer').value = withdrawalValue;
  else $('broadcastServer').value = '__custom';
  $('broadcastEndpoint').value = withdrawalKnown ? '' : withdrawalValue;
  $('broadcastEndpoint').placeholder = defaultWithdrawal(network) || 'wss://fulcrum.example.com:50004';
  $('broadcastEndpoint').classList.toggle('hidden', $('broadcastServer').value !== '__custom');
  updateWithdrawalWarning();
}

const syncServerCustom = (selectId: string, inputId: string): void => {
  const custom = $(selectId).value === '__custom';
  $(inputId).classList.toggle('hidden', !custom);
  if (custom) $(inputId).focus();
  updateWithdrawalWarning();
};
$('fulcrumServer').onchange = () => syncServerCustom('fulcrumServer', 'fulcrumEndpoint');
$('broadcastServer').onchange = () => syncServerCustom('broadcastServer', 'broadcastEndpoint');
$('fulcrumEndpoint').oninput = updateWithdrawalWarning;
$('broadcastEndpoint').oninput = updateWithdrawalWarning;
$('networkChoices').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.name === 'network') {
    renderServerFields(input.value);
    renderIndexerFields(input.value);
  }
});

function createdPools(): any[] {
  try {
    const stored = JSON.parse(localStorage.getItem(CREATED_KEY(CONFIG.networkId)) ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function rememberPool(pool: any) {
  const pools = [...createdPools().filter((entry) => entry.id !== pool.id), pool];
  try { localStorage.setItem(CREATED_KEY(CONFIG.networkId), JSON.stringify(pools)); } catch { /* this visit still shows it */ }
}

/** A deployment's own pools, the ones this browser made on the same network, then those Trustless found through its factories. */
const allPools = () => {
  const seen = new Set<string>();
  const found = (STATE?.pools ?? []).filter((pool) => pool.network === CONFIG.networkId);
  return [...CONFIG.pools, ...createdPools(), ...found].filter((pool) => {
    if (seen.has(pool.id)) return false;
    seen.add(pool.id);
    return true;
  });
};

const engineConfig = () => {
  const fulcrumUrl = savedEndpoint() || CONFIG.fulcrumUrl;
  if (!fulcrumUrl) throw notice('Choose a server in Settings first.');
  const indexerUrl = savedIndexer() || CONFIG.indexerUrl;
  return {
    network: CONFIG.network, networkId: CONFIG.networkId, addressPrefix: CONFIG.addressPrefix,
    pools: allPools(), prover: CONFIG.prover, fulcrumUrl,
    bcmrServiceUrl: CONFIG.bcmrServiceUrl,
    ...(CONFIG.factories ? { factories: CONFIG.factories } : {}),
    ...(indexerUrl ? { indexerUrl } : {}),
    // Someone who brought their own server has no reason to tell the operator what they do,
    // so that replaces the page's servers and archives, and a blank second one means this one.
    broadcastUrl: savedBroadcast() || (savedEndpoint() ? undefined : CONFIG.broadcastUrl) || undefined,
    archiveUrl: savedEndpoint() ? undefined : CONFIG.archiveUrl || undefined,
    broadcastArchiveUrl: savedEndpoint() || savedBroadcast() ? undefined : CONFIG.broadcastArchiveUrl || undefined,
  };
};

const loadEngine = async () => {
  if (ENGINE === null) {
    // @ts-ignore -- browser-only public ESM bundle
    const engine = await import('@solidpool/engine');
    if (ENGINE === null) {
      ENGINE = engine;
      // A token shown unverified becomes verified here once the chain confirms it.
      engine.onTokenVerified(applyVerifiedIdentity);
    }
  }
  return ENGINE;
};

const unreadState = () => ({ pools: allPools().map((pool) => ({ ...pool, unread: true, hashing: false })) });

// Paying the wallet in use would undo what the pool is for. It is one lock however the
// address is written, so this compares locks.
const isOwnWallet = (recipient: string): boolean => Boolean(wallet && recipient)
  && (ENGINE?.sameLock(recipient, wallet.address) ?? recipient === wallet.address);

/** The devnet is for testing, so it may pay the wallet in use; a real network may not. */
const ownRecipientAllowed = (): boolean => CONFIG.networkId === 'devnet';

function renderRecipientWarning() {
  const own = isOwnWallet($('recipient').value.trim());
  const allowed = own && ownRecipientAllowed();
  const warn = $('recipientWarn');
  warn.classList.toggle('hidden', !own);
  warn.textContent = allowed
    ? 'Devnet only: this is your connected wallet, so the withdrawal can be linked to you. On a real network, use a different address.'
    : 'This is your connected wallet. Receiving here would link the withdrawal to you, so use a different address.';
  if (!busy) $('withdrawBtn').disabled = own && !allowed;
}

function updateHeader() {
  const dot = CONNECTED === null ? '' : CONNECTED ? 'ok' : 'bad';
  $('networkPill').innerHTML = `<span class="dot ${dot}"></span><span>${esc(CONFIG.networkLabel ?? CONFIG.network)}</span>`;
}

const assetKeyOf = (p: any): string => (p.kind === 'bch' ? 'bch' : `token:${p.asset ?? p.id}`);
const countOf = (value: any): bigint => {
  try { return BigInt(value ?? 0); } catch { return 0n; }
};
type PoolGroup = { key: string; name: string; symbol: string; icon?: string; pools: any[] };

function poolGroups(): PoolGroup[] {
  const groups = new Map<string, PoolGroup>();
  for (const p of statePools()) {
    const key = assetKeyOf(p);
    const group = groups.get(key) ?? {
      key,
      name: p.kind === 'bch' ? 'Bitcoin Cash' : (p.name ?? 'CashToken'),
      symbol: p.kind === 'bch' ? 'BCH' : (p.symbol ?? 'TOKEN'),
      icon: p.kind === 'bch' ? BCH_ICON : p.icon,
      pools: [],
    };
    group.pools.push(p);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'bch') return -1;
    if (b.key === 'bch') return 1;
    return `${a.name} ${a.symbol}`.localeCompare(`${b.name} ${b.symbol}`);
  });
}

/** The tiles stay a grid; a tile opens this dialog, which holds the denominations. */
function renderPools() {
  const pools = statePools();
  // Until something is read for this network, the ledger is a skeleton of the tiles to come, as the
  // page's HTML starts: never an empty grid. A read that ends, in rows or in an error, replaces it.
  const reading = pools.length === 0 && STATE?.network !== CONFIG.networkId;
  $('pools').setAttribute('aria-busy', String(reading));
  if (pools.length === 0) {
    morph($('pools'), reading ? POOL_SKELETON : `<div class="pool-empty"><p class="hint">No pools on ${esc(CONFIG.networkLabel || CONFIG.networkId)} yet. Connect a wallet and create one.</p></div>`);
    if (POOL_VIEW) hidePoolModal();
    return;
  }
  morph($('pools'), poolGroups().map((group) => {
    const known = group.pools.filter((p) => !p.unread);
    const notes = known.reduce((sum, p) => sum + countOf(p.notes), 0n);
    const spent = known.reduce((sum, p) => sum + countOf(p.spent), 0n);
    const waiting = group.pools.some((p) => CHECKING.has(p.id));
    const meta = known.length === 0
      ? (waiting ? 'Checking this pool…' : 'Could not check this pool')
      : known.length === group.pools.length
        ? `${notes.toString()} deposits · ${spent.toString()} paid out`
        : `${notes.toString()} deposits · ${spent.toString()} paid out · ${waiting ? 'checking' : 'some unchecked'}`;
    return `<section class="pool-tile" data-asset="${esc(group.key)}">
      <button class="pool-tile-head" data-asset="${esc(group.key)}" data-symbol="${esc(group.symbol)}" aria-haspopup="dialog">
        ${assetIcon(group.icon, group.symbol, 32)}
        <span class="pool-tile-name"><b>${esc(group.name)}</b><span class="mono">${esc(group.symbol)}</span></span>
        <span class="pool-tile-meta">${meta}</span>
        <span class="pool-tile-chevron" aria-hidden="true">›</span>
      </button>
    </section>`;
  }).join(''));
  document.querySelectorAll('.pool-tile-head').forEach((b) => (b as HTMLElement).onclick = () => {
    openPoolModal((b as HTMLElement).dataset.asset!);
  });
  if (POOL_VIEW) renderPoolModal();
}

function openPoolModal(key: string): void {
  POOL_VIEW = key;
  OPEN = null;
  renderPoolModal();
  openModal('poolModal');
}

function hidePoolModal(): void {
  OPEN = null;
  POOL_VIEW = null;
  $('depositDrawer').classList.add('hidden');
  closeModal('poolModal');
}

/** Why this wallet cannot deposit into the pool, or null when it can (or its balance is still loading). */
function depositBlocked(p: any): string | null {
  if (!walletAssetState) return null;
  const bch = countOf(walletAssetState.bch ?? 0n);
  const cost = BigInt(p.depositValue ?? (p.kind === 'bch' ? p.denomination : 0n)) + BigInt(p.depositFee ?? 0n);
  if (bch < cost) {
    return `This wallet holds ${formatUnits(bch, 8)} BCH; this deposit needs ${formatUnits(cost, 8)} BCH, including its fees.`;
  }
  if (p.kind === 'token') {
    const held = (walletAssetState.tokens ?? []).find((token: any) => token.category === p.asset);
    const amount = countOf(held?.amount ?? 0n);
    if (amount < BigInt(p.denomination)) {
      return `This wallet holds ${formatUnits(amount, p.decimals)} ${p.symbol}; this pool needs ${formatUnits(p.denomination, p.decimals)} ${p.symbol}.`;
    }
    // A coin that also holds an NFT is never spent for a deposit.
    const spendable = countOf(held?.fungible ?? held?.amount ?? 0n);
    if (spendable < BigInt(p.denomination)) {
      return `This wallet holds ${formatUnits(spendable, p.decimals)} ${p.symbol} that a deposit can spend, the rest on coins that also hold an NFT; this pool needs ${formatUnits(p.denomination, p.decimals)} ${p.symbol}.`;
    }
  }
  return null;
}

/**
 * Whether a deposit into this token pool must first have its coin made: the wallet holds enough of
 * the asset, but no coin a deposit takes alone, which is one fungible coin of at least the amount
 * holding under 1,500 satoshis. The wallet makes one from its own coins (prepareDepositCoin), before
 * a note is shown for a deposit that could not go ahead.
 */
function depositNeedsCoin(p: any): boolean {
  if (!p || p.kind !== 'token' || !walletAssetState || depositBlocked(p)) return false;
  const held = (walletAssetState.tokens ?? []).find((token: any) => token.category === p.asset);
  return held !== undefined && countOf(held.depositable ?? held.amount) < BigInt(p.denomination);
}

/** What making a deposit's coin takes, in one plain line. */
const prepareCoinLine = (): string => `${wallet?.privateKey
  ? 'One transaction, which this browser\'s account signs'
  : 'One approval in your wallet'}, a small network fee, and it moves coins only between your own.`;

/** The coin prepared for a deposit into a pool, and what its steps last said, while that pool is chosen. */
let prepared: { poolId: string; progress: any } | null = null;

/** The selected asset's denominations, and the deposit summary once one is chosen. */
function renderPoolModal(): void {
  const group = poolGroups().find((entry) => entry.key === POOL_VIEW);
  if (!group) { hidePoolModal(); return; }
  const known = group.pools.filter((p) => !p.unread);
  const notes = known.reduce((sum, p) => sum + countOf(p.notes), 0n);
  const spent = known.reduce((sum, p) => sum + countOf(p.spent), 0n);
  const waiting = group.pools.some((p) => CHECKING.has(p.id));
  const unchecked = known.length === group.pools.length ? '' : ` · ${waiting ? 'checking' : 'some unchecked'}`;
  $('poolModalTitle').textContent = group.name;
  $('poolModalAsset').innerHTML = `${assetIcon(group.icon, group.symbol, 40)}
    <div class="pool-modal-name"><b>${esc(group.symbol)}</b><span>${notes.toString()} deposits · ${spent.toString()} paid out${unchecked}</span></div>`;
  const denoms = [...group.pools].sort((a, b) => (BigInt(a.denomination) < BigInt(b.denomination) ? -1 : 1));
  const drawer = $('depositDrawer');
  const modal = drawer.closest('.modal') as HTMLElement | null;
  // Detach the drawer before replacing the rows, so a selected row can hold it next time.
  if (modal && drawer.parentElement !== modal) modal.appendChild(drawer);
  $('poolModalBody').innerHTML = denoms.map((p) => {
    const open = p.id === OPEN;
    return `<div class="pool-denom${open ? ' open' : ''}">
      <div class="pool-denom-main">
        <span class="denom-amount">${esc(formatUnits(p.denomination, p.decimals))} <span class="sym">${esc(p.symbol)}</span></span>
        <span class="denom-stat">${esc(p.notes ?? '–')} deposits · ${esc(p.spent ?? '–')} paid out</span>
        <button class="btn quiet pool" data-pool="${esc(p.id)}" aria-expanded="${open}"${p.unread ? ` disabled title="${CHECKING.has(p.id) ? 'Checking this pool…' : 'This pool could not be checked. Refresh to try again.'}"` : depositBlocked(p) ? ` disabled title="${esc(depositBlocked(p) ?? '')}"` : ''}>${open ? 'Close' : 'Deposit'}</button>
      </div>
    </div>`;
  }).join('');
  $('poolModalBody').querySelectorAll('.pool').forEach((b: any) => b.onclick = () => {
    OPEN = OPEN === b.dataset.pool ? null : b.dataset.pool;
    renderPoolModal();
  });
  const selected = OPEN ? poolOf(OPEN) : null;
  const show = Boolean(selected && !selected.unread);
  if (show) {
    const row = [...$('poolModalBody').querySelectorAll('.pool-denom')]
      .find((candidate: any) => candidate.querySelector(`[data-pool="${OPEN}"]`));
    if (row) {
      row.insertAdjacentElement('afterend', drawer);
      drawer.classList.remove('hidden');
      renderSummary();
    } else {
      drawer.classList.add('hidden');
    }
  } else {
    drawer.classList.add('hidden');
  }
}

function renderSummary() {
  const p = poolOf(OPEN);
  if (!p || p.unread) return;
  const sats = BigInt(p.depositValue) + BigInt(p.depositFee);
  const fees = p.kind === 'bch' ? sats - BigInt(p.denomination) : sats;
  const total = p.kind === 'bch' ? `${formatUnits(sats, 8)} BCH` : `${formatUnits(p.denomination, p.decimals)} ${p.symbol} + ${formatUnits(sats, 8)} BCH`;
  const needs = depositNeedsCoin(p);
  $('depositSummary').innerHTML = `
    <div><dt>You pay about</dt><dd>${esc(total)}</dd></div>
    <p class="hint">This includes ${esc(formatUnits(fees, 8))} BCH of network fees for the deposit and the future withdrawal. The receiving address pays nothing, and there is no service fee.</p>
    ${depositBlocked(p) ? `<p class="hint err">${esc(depositBlocked(p) ?? '')}</p>` : ''}
    ${needs ? `<p class="hint warn">No single coin in your wallet can pay this deposit: a pool takes one coin of at least ${esc(formatUnits(p.denomination, p.decimals))} ${esc(p.symbol)} holding under 1,500 satoshis. Prepare one from your own coins first.</p>
    <p class="hint">${esc(prepareCoinLine())}</p>` : ''}`;
  // The deposit goes on once its coin is there; until then, making the coin is what is offered.
  $('prepareCoinBtn').classList.toggle('hidden', !needs);
  $('depositBtn').classList.toggle('hidden', needs);
  // A coin made for this pool keeps its steps on show while the pool stays chosen.
  if (prepared?.poolId === p.id && prepared.progress) drawPrepare(p, prepared.progress);
  else {
    $('prepareSteps').classList.add('hidden');
    $('prepareStatus').textContent = '';
  }
}

/** The title the deposit's own step has, as the engine names it for the wallet. */
const depositTitle = (p: any): string => `Deposit ${formatUnits(p.denomination, p.decimals)} ${p.symbol} into a private pool — and pay the withdrawal fee in advance`;
const stepContext = (progress: any): StepContext => ({
  walletApproves: Boolean(progress?.walletApproves), waiting: progress?.waiting, asked: progress?.asked ?? 0,
});
/** Making a deposit's coin, then the deposit to come: two approvals in a wallet this page holds no key for. */
const prepareRows = (p: any, progress: any): StepRow[] => [
  ...stepRows(progress),
  { id: 'deposit', title: depositTitle(p), signs: true, state: 'todo' },
];
function drawPrepare(p: any, progress: any, flow: HTMLElement = $('prepareSteps')): void {
  drawSteps(flow, prepareRows(p, progress), stepContext(progress), !progress.over);
}

/**
 * The source this browser reads a network through: Trustless, unless the person chose the indexer in
 * Settings and the network has one, its own or the app's (`appIndexer`). Trustless is the default, so
 * a first visit reads the chain itself and asks this app's /api for nothing.
 */
const sourceFor = (network: string, appIndexer: string | undefined): 'indexer' | 'trustless' => {
  const available = Boolean(localStorage.getItem(`${INDEXER_KEY}.${network}`) || appIndexer);
  return localStorage.getItem(SOURCE_KEY) === 'indexer' && available ? 'indexer' : 'trustless';
};
/** The source of the network the page is on. */
const dataSource = (): 'indexer' | 'trustless' => sourceFor(CONFIG.networkId, CONFIG.indexerUrl);

function updateSourceBadge(): void {
  const source = ACTIVE_SOURCE ?? dataSource();
  const badge = $('dataSource');
  badge.textContent = source === 'indexer' ? 'Fast indexer' : 'Trustless';
  badge.title = source === 'indexer'
    ? 'Loaded quickly from the app indexer. Click to change how data loads.'
    : 'Checked against the chain through Fulcrum. Click to change how data loads.';
}

/**
 * The chain read's progress, in the pools' header, where it takes no room of its own: a short
 * "Syncing 3/12" in the place of Refresh, its full words for assistive technology and as a tooltip,
 * and a thin line along the header's edge. Nothing below moves when it comes or goes.
 */
function showSync(text: string, ratio: number): void {
  const counted = /(\d+) of (\d+)/.exec(text);
  $('syncText').textContent = counted ? `Syncing ${counted[1]}/${counted[2]}` : 'Syncing…';
  $('syncWords').textContent = text;
  $('syncStatus').title = text;
  $('syncStatus').classList.remove('hidden');
  $('syncLine').classList.remove('hidden');
  $('refreshBtn').classList.add('hidden');
  $('syncProgress').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
}
const hideSync = () => {
  $('syncStatus').classList.add('hidden');
  $('syncLine').classList.add('hidden');
  $('refreshBtn').classList.remove('hidden');
};
const updateSync = (progress: any): void => {
  const done = Number(progress?.done ?? 0);
  const total = Number(progress?.total ?? 0);
  showSync(total > 0 ? `Checking pool ${done} of ${total}…` : 'Catching up with the chain…',
    total > 0 ? done / total : 0);
};

function renderSourceChoices(): void {
  const selected = dataSource();
  const indexer = Boolean(savedIndexer() || CONFIG.indexerUrl);
  const choice = (value: string, label: string, hint: string, disabled = false) => `
    <label class="choice${disabled ? ' disabled' : ''}">
      <input type="radio" name="dataSource" value="${value}" ${value === selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span>${label}</span><span class="hint">${hint}</span>
    </label>`;
  $('sourceChoices').innerHTML = choice('indexer', 'Fast indexer', indexer ? 'Quick preview' : 'Not available here', !indexer)
    + choice('trustless', 'Trustless', 'Checks the chain through Fulcrum');
}

async function refresh() {
  const source = dataSource();
  const run = ++REFRESH;
  // What this reads is for the network it began on. A refresh begun since, as on a network switch,
  // makes it stale, and nothing stale is shown, said or acted on.
  const network = CONFIG.networkId;
  const current = () => run === REFRESH;
  updateSourceBadge();
  const apply = () => {
    if (OPEN && !poolOf(OPEN)) OPEN = null;
    // Fresh rows carry no token names or icons: give them the ones already known before they are
    // drawn, or each read would draw the bare rows first and flash back.
    applyKnownIdentities();
    updateHeader();
    renderPools();
    renderRecipientWarning();
    renderNoteInfo();
    if (ENGINE) {
      void resolvePoolIdentities();
      healPools();
    }
  };
  try {
    if (source === 'indexer' && (savedIndexer() || CONFIG.indexerUrl)) {
      try {
        const config = engineConfig();
        const made = createdPools().map((pool: any) => pool.id);
        const rows = await loadIndexedRows({ indexerUrl: config.indexerUrl, pools: config.pools }, made);
        if (!current()) return;
        STATE = { ...rows, network };
        CONNECTED = true;
        ACTIVE_SOURCE = 'indexer';
        updateSourceBadge();
        apply();
        // Pools this browser made are not in the indexer. Read those from the chain, after
        // the tiles are already on screen, and enable them when the check lands.
        const unchecked = STATE.pools.filter((pool: any) => pool.unread).map((pool: any) => pool.id);
        if (unchecked.length > 0 && run === REFRESH) {
          unchecked.forEach((id: string) => CHECKING.add(id));
          apply();
          void (async () => {
            const engine = await loadEngine().catch(() => undefined);
            const checked = engine
              ? await engine.loadPoolRows(engineConfig(), unchecked).catch(() => undefined)
              : undefined;
            if (run !== REFRESH) return;
            if (checked !== undefined) {
              const rows = new Map<string, any>(checked.pools.map((pool: any) => [pool.id, pool]));
              STATE = { ...STATE, pools: STATE.pools.map((pool: any) => rows.get(pool.id) ?? pool) };
            }
            unchecked.forEach((id: string) => CHECKING.delete(id));
            apply();
          })();
        } else {
          preloadEngine();
        }
        return;
      } catch {
        if (!current()) return;
        setStatus('Fast view is unavailable, so the app is checking the chain. This can take a moment.');
      }
    }
    const engine = await loadEngine();
    if (!current()) return;
    // Trustless: paint the last verified rows first, then read and verify each pool.
    ACTIVE_SOURCE = 'trustless';
    updateSourceBadge();
    const cached = await engine.cachedState(engineConfig()).catch(() => undefined);
    if (!current()) return;
    if (cached !== undefined) {
      STATE = { ...cached, network };
      CONNECTED = true;
      apply();
    }
    showSync(cached !== undefined ? 'Showing cached chain data; catching up…' : 'Catching up with the chain…', 0);
    let loaded: any;
    try {
      loaded = await engine.loadState(engineConfig(), (progress: any) => { if (current()) updateSync(progress); });
    } finally {
      if (current()) hideSync();
    }
    if (!current()) return;
    STATE = { ...loaded, network };
    CONNECTED = true;
    apply();
  } catch (error) {
    if (!current()) return;
    hideSync();
    ACTIVE_SOURCE = null;
    updateSourceBadge();
    STATE = { ...unreadState(), network };
    CONNECTED = false;
    OPEN = null;
    setStatus(shown(error), 'err');
    apply();
  }
}

/** The engine is for actions and token metadata; load it after the first paint unless it is needed sooner. */
function preloadEngine(): void {
  const start = () => {
    void loadEngine().then(() => {
      void resolvePoolIdentities();
      healPools();
    }).catch(() => undefined);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 2_000 });
  else setTimeout(start, 800);
}

/** What a token pool shows of its issuer's identity, over what its row says. */
const identityFields = (pool: any, found: any) => ({
  name: found.name ?? pool.name,
  symbol: found.symbol ?? pool.symbol,
  decimals: found.decimals ?? pool.decimals,
  icon: found.icon,
  verified: Boolean(found.verified),
  pinned: Boolean(found.pinned),
});

/** Every token pool on screen takes the identity this page already resolved for its asset. */
function applyKnownIdentities(): void {
  for (const pool of statePools()) {
    if (pool.kind !== 'token' || !pool.asset) continue;
    const found = IDENTITIES.get(pool.asset);
    if (found) Object.assign(pool, identityFields(pool, found));
  }
}

/** A token pool's name, symbol, decimals and icon come from its issuer where a registry resolves. */
async function resolvePoolIdentities() {
  if (!ENGINE) return;
  const pools = statePools().filter((pool) => pool.kind === 'token' && pool.asset);
  const categories = [...new Set(pools.map((pool) => pool.asset as string))];
  if (categories.length === 0) return;
  try {
    const engine = await loadEngine();
    const identities = await engine.tokenIdentities(engineConfig(), categories);
    let changed = false;
    for (const pool of pools) {
      const found = identities[pool.asset];
      if (!found) continue;
      IDENTITIES.set(pool.asset, found);
      const fields = identityFields(pool, found);
      if (Object.entries(fields).every(([key, value]) => pool[key] === value)) continue;
      Object.assign(pool, fields);
      changed = true;
    }
    if (changed) {
      renderPools();
      if (OPEN) renderSummary();
    }
  } catch { /* the deployment's own name and symbol still show */ }
}

/**
 * An identity the chain verified after an index or this browser's cache showed it unverified: the
 * engine walks the token's authchain behind the first answer (web/src/bcmr.ts). Its name, symbol,
 * decimals and icon are the issuer's own, published on chain, so they replace what was shown.
 */
function applyVerifiedIdentity(identity: any): void {
  IDENTITIES.set(identity.category, identity);
  const update = (target: any) => ({
    name: identity.name ?? target.name, symbol: identity.symbol ?? target.symbol,
    decimals: identity.decimals ?? target.decimals, icon: identity.icon, verified: true,
  });
  const pools = statePools().filter((pool) => pool.kind === 'token' && pool.asset === identity.category);
  for (const pool of pools) Object.assign(pool, update(pool));
  if (pools.length > 0) {
    renderPools();
    if (OPEN) renderSummary();
  }
  if (walletAssetState?.tokens?.some((token: any) => token.category === identity.category)) {
    renderAssets({
      ...walletAssetState,
      tokens: walletAssetState.tokens.map((token: any) => (token.category === identity.category ? { ...token, ...update(token) } : token)),
    });
  }
}

// A deposit whose tab closed halfway leaves its hashing to whoever comes next. It costs
// them nothing: the deposit prepaid it.
let healing = false;
async function healPools() {
  const stuck = statePools().find((p) => p.hashing);
  if (healing || busy || !stuck) return;
  healing = true;
  try {
    const engine = await loadEngine();
    await engine.finishPending(engineConfig(), stuck.id);
    await refresh();
  } catch { /* the next visit tries again */ }
  healing = false;
}
$('refreshBtn').onclick = () => { void refresh(); };

// A note names its pool, so redeeming needs no pool choice.
function renderNoteInfo() {
  const text = $('note').value.trim();
  const info = $('noteInfo');
  info.className = 'hint';
  info.textContent = '';
  if (!text) return;
  const note = readNoteText(text);
  const pool = note ? poolOfNote<any>(note, statePools()) : null;
  if (pool && BigInt(pool.denomination) === note!.amount) {
    const thin = pool.notes !== undefined && pool.notes !== null && pool.notes < THIN_POOL
      ? ` Only ${pool.notes} ${pool.notes === 1 ? 'deposit is' : 'deposits are'} in this pool, so withdrawing now would be easier to link to yours.` : '';
    info.textContent = `This note withdraws ${fmtAmount(pool, pool.denomination)}.${thin}`;
    return;
  }
  if (note?.network !== undefined && note.network !== CONFIG.networkId) {
    const name = (CONFIG.networks ?? []).find((network: any) => network.id === note.network)?.label ?? note.network;
    info.className = 'hint err';
    info.textContent = `This note is for ${name}. Choose it in Settings to withdraw.`;
    return;
  }
  // The note names its pool's category, so withdrawing finds the pool on the chain, and checks it.
  if (note && !pool && namesCategory(note)) {
    info.textContent = 'This pool is not listed here. Withdrawing first checks on the chain that this network\'s factory made it.';
    return;
  }
  info.className = 'hint err';
  info.textContent = note
    ? 'This note belongs to a pool that is not in this app.'
    : 'That does not look like a private note. Check that you copied all of it.';
}
$('note').oninput = () => { $('feeOffer').classList.add('hidden'); renderNoteInfo(); };
$('recipient').oninput = () => { $('feeOffer').classList.add('hidden'); renderRecipientWarning(); };

// ---- wallet ----
let wallet: any = null;
let walletAssetState: any = null;
let walletWatch: (() => void) | null = null;
const openModal = (id) => { $(id).classList.remove('hidden'); };
const closeModal = (id) => { $(id).classList.add('hidden'); };
document.querySelectorAll('[data-close]').forEach((el) => {
  (el as HTMLElement).onclick = () => closeModal((el as HTMLElement).dataset.close);
});
document.querySelectorAll('.modal-backdrop:not([data-sticky])').forEach((el) => {
  // A dialog held while it sends (holdDialog) is sticky for that long.
  el.addEventListener('mousedown', (e) => { if (e.target === el && !el.hasAttribute('data-sticky')) el.classList.add('hidden'); });
});
/** While a dialog's flow sends, nothing closes it: its steps say when to open the wallet. */
const holdDialog = (id: string, held: boolean) => {
  const backdrop = $(id);
  backdrop.toggleAttribute('data-sticky', held);
  backdrop.querySelectorAll('.modal-head [data-close]').forEach((el: Element) => el.classList.toggle('hidden', held));
};
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop:not([data-sticky])').forEach((m) => m.classList.add('hidden'));
});
// Closing the pool dialog forgets its selection, so the next tile opens clean.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && POOL_VIEW && !$('poolModal').hasAttribute('data-sticky')) hidePoolModal();
});
$('poolModal').addEventListener('mousedown', (e) => {
  if (e.target === $('poolModal') && !$('poolModal').hasAttribute('data-sticky')) hidePoolModal();
});
$('poolModal').querySelector('[data-close="poolModal"]').addEventListener('click', () => hidePoolModal());
$('termsBtn').onclick = () => openModal('termsModal');

function renderWallet() {
  const connected = wallet !== null;
  if (!connected) walletAssetState = null;
  $('accountBtn').classList.toggle('hidden', !connected);
  $('connect').classList.toggle('hidden', connected);
  if (connected) $('accountBtn').textContent = shortHash(String(wallet.address).replace(/^[a-z]+:/, ''), 6, 5);
  if (connected) void startWalletWatch();
  else stopWalletWatch();
}

function stopWalletWatch() {
  walletWatch?.();
  walletWatch = null;
}

async function startWalletWatch() {
  stopWalletWatch();
  if (!wallet) return;
  const { address } = wallet;
  const show = (next: any) => {
    void withIdentities(next).then((assets) => { if (wallet?.address === address) renderAssets(assets); }).catch(() => {});
  };
  try {
    const engine = await loadEngine();
    // The engine's reader watches the wallet too, so the pool calls and this watch share
    // one connection.
    const unsubscribe = await engine.watchAssets(engineConfig(), address, show);
    if (wallet?.address === address) walletWatch = unsubscribe;
    else unsubscribe();
  } catch { /* the next wallet refresh retries */ }
}

/** Add BCMR names, symbols, decimals and icons to what the wallet holds. */
async function withIdentities(raw: any) {
  const categories = [...new Set((raw.tokens ?? []).map((token: any) => token.category).filter((category: string) => !IDENTITIES.has(category)))];
  if (categories.length > 0) {
    try {
      const engine = await loadEngine();
      const found = await engine.tokenIdentities(engineConfig(), categories);
      for (const [category, identity] of Object.entries(found)) IDENTITIES.set(category, identity);
    } catch { /* the wallet's own category still shows */ }
  }
  return {
    ...raw,
    tokens: (raw.tokens ?? []).map((token: any) => {
      const identity = IDENTITIES.get(token.category);
      return identity === undefined ? token : {
        ...token,
        name: identity.name ?? token.name,
        symbol: identity.symbol ?? token.symbol,
        decimals: identity.decimals ?? token.decimals,
        icon: identity.icon,
        verified: identity.verified,
        pinned: Boolean(identity.pinned),
      };
    }),
  };
}

const poolsOfAsset = (asset: string | undefined) => allPools()
  .filter((pool) => (asset === undefined ? pool.kind === 'bch' : pool.kind === 'token' && pool.asset === asset));

function renderAssetView(a: any) {
  const list = $('assetsList');
  if (!wallet) {
    morph(list, `<div class="empty">
      <p>Connect a wallet to see your balance and create a pool for an asset you hold.</p>
      <button class="btn quiet" data-connect>Connect wallet</button>
    </div>`);
    return;
  }
  if (!a) {
    morph(list, '<div class="hint">Loading balances…</div>');
    return;
  }
  const existing = (asset?: string) => {
    const pools = poolsOfAsset(asset);
    return pools.length === 0 ? 'No pool yet' : `Pool amounts: ${pools.map((pool) => formatUnits(pool.denomination, pool.decimals)).join(', ')}`;
  };
  // Offer creation only for an amount that has no pool yet.
  const canCreate = (choice: any): boolean => draftFor(choice).available.length > 0;
  const bchChoice = { asset: undefined, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, icon: BCH_ICON };
  const bchRow = `<div class="asset-card">
    <div class="asset-row-main">
      ${assetIcon(BCH_ICON, 'BCH', 28)}
      <div class="asset-name"><b>Bitcoin Cash</b><span class="mono">BCH</span></div>
      <div class="asset-balance mono">${esc(formatUnits(a.bch, 8))} BCH</div>
      <button class="btn quiet" data-create="bch"${canCreate(bchChoice) ? '' : ' disabled title="Every amount for Bitcoin Cash already has a pool."'}>Create a pool</button>
    </div>
    <p class="hint">${esc(existing(undefined))}</p>
  </div>`;
  const tokenRows = (a.tokens ?? []).map((token: any) => {
    const choice = { ...token, asset: token.category };
    return `<div class="asset-card">
      <div class="asset-row-main">
        ${assetIcon(token.icon, token.symbol ?? '', 28)}
        <div class="asset-name"><b>${esc(token.name ?? 'CashToken')}</b>
          <span class="mono">${esc(token.symbol ?? token.category.slice(0, 8))}</span>
          ${token.verified === false && !token.pinned && !poolsOfAsset(token.category).length ? '<span class="tag unverified" title="The issuer has not published details this app can check.">unverified</span>' : ''}</div>
        <div class="asset-balance mono">${esc(formatUnits(token.amount, token.decimals ?? 0))} ${esc(token.symbol ?? '')}</div>
        <button class="btn quiet" data-create="${esc(token.category)}"${canCreate(choice) ? '' : ' disabled title="Every amount for this asset already has a pool."'}>Create a pool</button>
      </div>
      <p class="hint">${esc(existing(token.category))}</p>
    </div>`;
  }).join('');
  morph(list, `${bchRow}${tokenRows || '<p class="hint">No tokens in this wallet yet.</p>'}`);
}

function renderAssets(a: any) {
  walletAssetState = a;
  const row = (amount: string, symbol: string) => `<div class="asset-row"><span>${esc(symbol)}</span><span class="mono">${esc(amount)} ${esc(symbol)}</span></div>`;
  $('accountAssets').innerHTML = [row(formatUnits(a.bch, 8), 'BCH'), ...(a.tokens ?? []).map((token: any) => row(formatUnits(token.amount, token.decimals), token.symbol))].join('');
  renderAssetView(a);
  if (POOL_VIEW) renderPoolModal();
}

async function loadAssets() {
  if (!wallet) { renderAssetView(null); return; }
  $('accountAssets').innerHTML = '<div class="hint">Loading balances…</div>';
  try {
    const engine = await loadEngine();
    renderAssets(await withIdentities(await engine.assets(engineConfig(), wallet.address)));
  } catch (e) {
    $('accountAssets').innerHTML = `<div class="hint err">${esc(shown(e))}</div>`;
    $('assetsList').innerHTML = `<div class="hint err">${esc(shown(e))}</div>`;
  }
}

// ---- step lists ----
// A flow of several transactions shows each as a step: done, under way and to come. A wallet this
// page holds no key for asks its owner to approve each one in its own app, so the step under way
// says when it is waiting there, and which approval of how many it is. The engine reports the steps
// (web/src/step-progress.ts); the page adds its own, as waiting for a new pool to be listed.
type StepState = 'todo' | 'current' | 'done' | 'failed' | 'skipped';
interface StepRow {
  id: string;
  title: string;
  /** A transaction the wallet signs. */
  signs: boolean;
  /** Done by an earlier attempt: nothing is signed for it now. */
  earlier?: boolean;
  state: StepState;
  /** What to say under it, in place of what its state says. */
  note?: string;
  noteClass?: string;
}
/** What the step under way waits on, from the engine's progress. */
interface StepContext { walletApproves: boolean; waiting?: 'page' | 'wallet' | 'network'; asked: number }

/** A flow's own steps as rows, from the engine's progress. */
const stepRows = (progress: any): StepRow[] => (progress?.steps ?? []).map((step: any) => ({
  id: step.id, title: step.title, signs: step.signs, earlier: step.earlier, state: step.state,
}));

/** What a row says under its title. */
function stepNote(row: StepRow, approval: number | undefined, approvals: number, context: StepContext): { text: string; cls: string } {
  if (row.note !== undefined) return { text: row.note, cls: row.noteClass ?? '' };
  const of = approval === undefined ? '' : ` (${approval} of ${approvals})`;
  if (row.state === 'done') return { text: 'Done', cls: 'ok' };
  if (row.state === 'skipped') return { text: 'Not needed after all', cls: '' };
  if (row.state === 'failed') return { text: 'Stopped here', cls: 'err' };
  if (row.state === 'todo') return { text: approval === undefined ? '' : `Needs your approval${of}`, cls: '' };
  if (!row.signs) return { text: '', cls: '' };
  if (!context.walletApproves) return { text: 'No approval needed: this browser\'s account signs it.', cls: '' };
  if (context.waiting === 'wallet') return { text: `Open your wallet and approve${context.asked > 1 ? ' it again' : ''}${of}`, cls: 'warn' };
  if (context.waiting === 'network') return { text: 'Approved. Sending it…', cls: '' };
  return { text: `Preparing it for your wallet${of}…`, cls: '' };
}

/**
 * Draw `rows` into a flow's container: its list and its progress bar, which runs while `running`.
 * The items stay while the steps are the same, so a screen reader hears what changed, not the
 * whole list again.
 */
function drawSteps(flow: HTMLElement | null, rows: StepRow[], context: StepContext, running: boolean): void {
  if (!flow) return;
  // A flow that stopped before it planned a step has none to show.
  flow.classList.toggle('hidden', rows.length === 0);
  if (rows.length === 0) return;
  flow.querySelector('.progress')?.classList.toggle('hidden', !running);
  const list = flow.querySelector('.flow-steps') as HTMLElement;
  // The same step can name another amount or another fee from one flow to the next, so a list is
  // drawn again when its titles change too.
  const shape = JSON.stringify(rows.map((row) => [row.id, row.title]));
  if (list.dataset.shape !== shape) {
    list.dataset.shape = shape;
    list.innerHTML = rows.map((row, index) => `<li class="flow-step" data-step="${esc(row.id)}">
      <span class="step-n" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <span class="flow-step-title"><span class="sr">Step ${index + 1} of ${rows.length}: </span>${esc(row.title)}</span>
      <span class="hint flow-step-note"></span>
    </li>`).join('');
  }
  // A wallet this page holds no key for approves each transaction it signs in this flow; one an
  // earlier attempt sent, or one not needed after all, asks nothing.
  const asks = (row: StepRow) => context.walletApproves && row.signs && !row.earlier && row.state !== 'skipped';
  const approvals = rows.filter(asks).length;
  let approval = 0;
  rows.forEach((row, index) => {
    const item = list.children[index] as HTMLElement;
    item.dataset.state = row.state;
    if (row.state === 'current') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    const { text, cls } = stepNote(row, asks(row) ? ++approval : undefined, approvals, context);
    const note = item.querySelector('.flow-step-note') as HTMLElement;
    if (note.textContent !== text) note.textContent = text;
    note.className = `hint flow-step-note${cls ? ` ${cls}` : ''}`;
  });
}

const FLOW_MARKUP = (id: string, label: string) => `<div class="flow hidden" id="${id}" role="status" aria-live="polite" aria-atomic="false" aria-label="${esc(label)}">
      <div class="progress"><i></i></div>
      <ol class="flow-steps"></ol>
    </div>`;

// ---- create a pool ----
// A pool's name is the txid of a plain coin at output 0. A token pool also opens with a coin
// of exactly one unit of its asset; the deployment module makes either coin first when needed.
// The denominations a pool's constructor accepts: powers of ten, 0.01 to 100 BCH, and 10^0 to
// 10^12 units of a token (web/src/pools.ts). A token's ladder starts at one whole token; a token
// with more than 12 decimals gets the largest denomination only.
const BCH_LADDER = poolDenominations('bch');
/** Every token exponent the contract allows; sub-1 amounts appear when the token has decimals. */
const tokenLadder = () => poolDenominations('token');

/** At most three amounts in a choice's summary; the rest are behind an ellipsis. */
const summarizeAmounts = (amounts: bigint[], decimals: number, max = 3): string => {
  const shown = amounts.slice(0, max).map((amount) => formatUnits(amount, decimals));
  return amounts.length > max ? `${shown.join(', ')}, …` : shown.join(', ');
};
interface PoolDraft {
  kind: 'bch' | 'token';
  asset?: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  ladder: bigint[];
  taken: Set<string>;
  modal: string;
}
let creating: PoolDraft | null = null;

const choiceKey = (choice: any): string => (choice.asset === undefined ? 'bch' : choice.asset);

/** What a pool for this asset would pay, and the amounts the wallet can pay that have no pool yet. */
function draftFor(choice: any): { draft: PoolDraft; available: bigint[] } {
  const kind = choice.asset === undefined ? 'bch' : 'token';
  const ladder = kind === 'bch' ? BCH_LADDER : tokenLadder();
  const taken = new Set(poolsOfAsset(choice.asset).map((pool) => String(pool.denomination)));
  const available = ladder.filter((amount) => !taken.has(String(amount)));
  return {
    draft: {
      kind, ...(choice.asset === undefined ? {} : { asset: choice.asset }),
      name: choice.name ?? (kind === 'bch' ? 'Bitcoin Cash' : 'CashToken'),
      symbol: choice.symbol ?? (kind === 'bch' ? 'BCH' : 'TOKEN'),
      decimals: choice.decimals ?? 0,
      ...(choice.icon === undefined ? {} : { icon: choice.icon }),
      ladder, taken, modal: 'createPoolModal',
    },
    available,
  };
}

/** The denomination field and Create button, wherever choosing an asset happened. */
function renderCreateForm(container: any, available: bigint[], header: boolean): void {
  if (!creating) return;
  const draft = creating;
  const none = available.length === 0;
  const options = draft.ladder
    .map((amount) => {
      const taken = draft.taken.has(String(amount));
      return `<option value="${String(amount)}"${taken ? ' disabled' : ''}>${esc(formatUnits(amount, draft.decimals))} ${esc(draft.symbol)}${taken ? ' — already has a pool' : ''}</option>`;
    })
    .join('');
  container.innerHTML = `
    ${header ? `<div class="create-head">${assetIcon(draft.icon, draft.symbol, 34)}
      <div><b>${esc(draft.name)}</b><div class="hint mono">${esc(draft.symbol)}</div></div></div>` : ''}
    <div class="field">
      <label for="poolDenomination">Amount per deposit</label>
      <div class="select-wrap"><select id="poolDenomination">${options}</select></div>
      <div class="hint">Amounts that already have a pool are disabled. The pool is created now; the amount is paid when a note is deposited.</div>
    </div>
    <p class="hint">This creates a new pool on Bitcoin Cash, in a few transactions. ${wallet?.privateKey
    ? 'This browser\'s account signs them, so nothing asks for approval.'
    : 'Your wallet asks you to approve each one, and the steps below say when.'}${draft.kind === 'token' ? ` The pool also needs one unit of ${esc(draft.symbol)}.` : ''}</p>
    <button class="btn primary" id="createPoolConfirm"${none ? ' disabled' : ''}>Create pool</button>
    ${FLOW_MARKUP('createPoolProgress', 'Creating the pool')}
    <p class="hint" id="createPoolStatus" role="status" aria-live="polite">${none ? 'Every amount for this asset already has a pool.' : ''}</p>`;
  const select = container.querySelector('#poolDenomination') as HTMLSelectElement | null;
  if (select) select.value = String(available[0] ?? draft.ladder[0]);
  const button = container.querySelector('#createPoolConfirm') as HTMLButtonElement | null;
  if (button) button.onclick = () => void confirmCreatePool(button, container);
}

async function openCreatePool(asset?: string) {
  if (!wallet) { openConnect(); return; }
  const kind = asset === undefined ? 'bch' : 'token';
  let identity: any = kind === 'bch'
    ? { name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, icon: BCH_ICON }
    : IDENTITIES.get(asset!);
  if (kind === 'token' && !identity) {
    try {
      const engine = await loadEngine();
      const found = await engine.tokenIdentities(engineConfig(), [asset!]);
      identity = found[asset!];
      if (identity) IDENTITIES.set(asset!, identity);
    } catch { /* the wallet's own values below still work */ }
  }
  if (kind === 'token' && !identity) {
    const held = (await (await loadEngine()).assets(engineConfig(), wallet.address)).tokens
      .find((token: any) => token.category === asset);
    identity = held
      ? { name: held.name, symbol: held.symbol, decimals: held.decimals }
      : { name: 'CashToken', symbol: asset!.slice(0, 8), decimals: 0 };
  }
  const { draft, available } = draftFor({ ...identity, asset });
  creating = draft;
  renderCreateForm($('createPoolBody'), available, true);
  openModal('createPoolModal');
}

/** The assets this wallet holds, with the amounts it does not have a pool for yet. */
async function openAddPool() {
  if (!wallet) { openConnect(); return; }
  const body = $('addPoolBody');
  openModal('addPoolModal');
  body.innerHTML = '<p class="hint">Looking at your wallet…</p>';
  try {
    const engine = await loadEngine();
    const assets = await withIdentities(await engine.assets(engineConfig(), wallet.address));
    const choices: any[] = [];
    const bchAvailable = BCH_LADDER.filter((amount) => !poolsOfAsset(undefined).some((pool) => BigInt(pool.denomination) === amount));
    choices.push({ asset: undefined, name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, icon: BCH_ICON, available: bchAvailable });
    for (const token of assets.tokens ?? []) {
      const available = tokenLadder()
        .filter((amount) => !poolsOfAsset(token.category).some((pool) => BigInt(pool.denomination) === amount));
      choices.push({ ...token, asset: token.category, available });
    }
    body.innerHTML = `<p class="hint">Choose an asset and an amount. Amounts that already have a pool are disabled.</p>
      <div class="add-pool-list">${choices.map((choice, index) => {
        const disabled = choice.available.length === 0;
        const wide = summarizeAmounts(choice.available, choice.decimals ?? 0, 3);
        const narrow = summarizeAmounts(choice.available, choice.decimals ?? 0, 2);
        return `<section class="add-pool-choice">
        <button class="choice add-asset${disabled ? ' disabled' : ''}" data-add-asset="${esc(choiceKey(choice))}" aria-expanded="false" aria-controls="addPoolForm-${index}"${disabled ? ' disabled aria-disabled="true"' : ''}>
          ${assetIcon(choice.icon, choice.symbol ?? 'BCH', 28)}
          <span class="add-asset-name"><b>${esc(choice.name ?? choice.symbol ?? 'CashToken')}</b><span class="mono">${esc(choice.symbol ?? '')}</span></span>
          <span class="hint">${disabled ? 'Every amount already has a pool' : `<span class="denoms-wide">${esc(wide)}</span><span class="denoms-mobile">${esc(narrow)}</span> ${esc(choice.symbol ?? '')}`}</span>
          <span class="add-asset-chevron" aria-hidden="true">›</span>
        </button>
        <div class="add-pool-form hidden" id="addPoolForm-${index}"></div>
      </section>`;
      }).join('')}</div>`;
    const forms = [...body.querySelectorAll('.add-pool-form')];
    body.querySelectorAll('[data-add-asset]').forEach((button: any) => button.onclick = () => {
      // A creation under way keeps its form open.
      if (button.disabled || $('addPoolModal').hasAttribute('data-sticky')) return;
      const chosen = button.dataset.addAsset;
      const choice = choices.find((entry) => choiceKey(entry) === chosen);
      const form = button.parentElement.querySelector('.add-pool-form');
      const open = button.getAttribute('aria-expanded') === 'true';
      forms.forEach((other: any) => other.classList.add('hidden'));
      body.querySelectorAll('[data-add-asset]').forEach((other: any) => other.setAttribute('aria-expanded', 'false'));
      if (open) return;
      button.setAttribute('aria-expanded', 'true');
      form.classList.remove('hidden');
      const { draft, available } = draftFor(choice);
      creating = { ...draft, modal: 'addPoolModal' };
      renderCreateForm(form, available, false);
    });
  } catch (error) {
    body.innerHTML = `<p class="hint err">${esc(shown(error))}</p>`;
  }
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Read the pools until the list shows `id`, checked: a server shows a new pool a moment after it
 * lands, and a pool the indexer does not know is checked on chain after the list paints.
 */
async function untilListed(id: string): Promise<boolean> {
  const listed = () => statePools().some((pool) => pool.id === id && !pool.unread);
  for (let round = 0; round < 3; round += 1) {
    await refresh();
    for (let second = 0; second < 20 && !listed(); second += 1) await sleep(1_000);
    if (listed()) return true;
  }
  return false;
}

/** The creation's steps, then the page's own: the new pool appearing in the list. */
function drawCreation(flow: HTMLElement | null, progress: any, appear: StepState | 'late', running: boolean): void {
  // A creation that stopped before it planned its steps has none to show, not even the last.
  if (!progress?.steps?.length) {
    flow?.classList.add('hidden');
    return;
  }
  const created = progress.steps.some((step: any) => step.id === 'create' && step.state === 'done');
  const rows = stepRows(progress).map((row) => {
    // The prep is signed at its own step and goes out with the creation's.
    if (row.id !== 'prep') return row;
    if (row.earlier) return { ...row, note: 'Sent by your earlier attempt. This one spends it.', noteClass: 'ok' };
    if (row.state === 'done' && !created) return { ...row, note: 'Signed. It goes out with the next step.', noteClass: 'ok' };
    if (row.state === 'current' && progress.waiting === 'network') return { ...row, note: 'Approved. It goes out with the next step.' };
    return row;
  });
  const notes: Record<string, { note: string; noteClass: string }> = {
    todo: { note: '', noteClass: '' },
    current: { note: 'Waiting for the pool to appear…', noteClass: '' },
    done: { note: 'Listed', noteClass: 'ok' },
    late: { note: 'Not listed yet. Refresh the pools in a moment.', noteClass: 'warn' },
  };
  rows.push({
    id: 'appear', title: 'Wait for the pool to appear', signs: false, state: appear === 'late' ? 'done' : appear,
    ...(notes[appear] ?? notes.todo),
  });
  drawSteps(flow, rows, {
    walletApproves: Boolean(progress?.walletApproves), waiting: progress?.waiting, asked: progress?.asked ?? 0,
  }, running);
}

async function confirmCreatePool(button: HTMLButtonElement, scope: Element | Document) {
  // Once the pool is made, the button closes the dialog, and the page says so.
  if (button.dataset.done) {
    closeModal(button.dataset.done);
    setStatus(button.dataset.message ?? '', 'ok');
    return;
  }
  if (!creating || !wallet || busy) return;
  const draft = creating;
  const select = scope.querySelector('#poolDenomination') as HTMLSelectElement | null;
  const statusText = scope.querySelector('#createPoolStatus') as HTMLElement | null;
  const flow = scope.querySelector('#createPoolProgress') as HTMLElement | null;
  const say = (text: string, cls = '') => {
    if (!statusText) return;
    statusText.className = `hint${cls ? ` ${cls}` : ''}`;
    statusText.textContent = text;
  };
  if (select === null) return;
  button.disabled = true;
  select.disabled = true;
  busy = true;
  holdDialog(draft.modal, true);
  let progress: any;
  let appear: StepState | 'late' = 'todo';
  say('Reading your coins…');
  try {
    const engine = await loadEngine();
    const denomination = BigInt(select.value);
    if (draft.taken.has(String(denomination))) throw notice('That amount already has a pool.');
    const pool = await engine.createPool(engineConfig(), {
      kind: draft.kind, denomination, name: draft.name, symbol: draft.symbol, decimals: draft.decimals,
      ...(draft.asset ? { asset: draft.asset } : {}),
    }, wallet, undefined, (next: any) => {
      // The steps say the rest.
      if (!progress) say('');
      progress = next;
      drawCreation(flow, progress, appear, true);
    });
    rememberPool(pool);
    appear = 'current';
    drawCreation(flow, progress, appear, true);
    const listed = await untilListed(pool.id);
    appear = listed ? 'done' : 'late';
    drawCreation(flow, progress, appear, false);
    const amount = `${formatUnits(pool.denomination, pool.decimals)} ${pool.symbol}`;
    if (progress?.failure) say(`${progress.failure.sent} ${progress.failure.next}`, 'warn');
    else if (!listed) say(`Your ${amount} pool is created. This page does not list it yet: refresh the pools in a moment.`, 'warn');
    else say(`Your ${amount} pool is ready.`, 'ok');
    button.dataset.done = draft.modal;
    button.dataset.message = `New pool created: ${amount}.`;
    button.textContent = 'Done';
    button.disabled = false;
    await loadAssets();
  } catch (e) {
    if (progress) drawCreation(flow, progress, appear, false);
    say([shown(e), progress?.failure?.sent, progress?.failure?.next].filter(Boolean).join(' '), 'err');
    button.textContent = 'Try again';
    button.disabled = false;
    select.disabled = false;
  } finally {
    busy = false;
    holdDialog(draft.modal, false);
  }
}

$('assetsList').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('[data-connect]')) { openConnect(); return; }
  const button = target.closest('[data-create]') as HTMLElement | null;
  if (!button) return;
  const asset = button.dataset.create;
  void openCreatePool(asset === 'bch' ? undefined : asset);
});
$('walletToggle').onclick = () => {
  const toggle = $('walletToggle');
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  $('assetsList').classList.toggle('hidden', !open);
  $('assetsRefresh').classList.toggle('hidden', !open);
  if (open) void loadAssets();
};
$('assetsRefresh').onclick = () => { void loadAssets(); };
$('addPoolBtn').onclick = () => { void openAddPool(); };

let ADDRESS_FORMS: { cash: string; token: string } | null = null;
let ADDRESS_FORM: 'cash' | 'token' = 'cash';

function renderAccountAddress(): void {
  $('accountAddress').textContent = (ADDRESS_FORMS?.[ADDRESS_FORM]) ?? wallet?.address ?? '';
  const button = $('addressSwitch');
  button.classList.toggle('hidden', ADDRESS_FORMS === null);
  if (ADDRESS_FORMS !== null) {
    const other = ADDRESS_FORM === 'cash' ? 'token' : 'cash';
    button.title = `Show the ${other} address`;
    button.setAttribute('aria-label', `Show the ${other} address`);
    button.setAttribute('aria-pressed', String(ADDRESS_FORM === 'token'));
  }
}

async function openAccount() {
  if (!wallet) return;
  try {
    const api = await loadWalletApi();
    ADDRESS_FORMS = api.addressForms(wallet.address, CONFIG.addressPrefix);
  } catch { ADDRESS_FORMS = null; }
  if (!wallet) return;
  ADDRESS_FORM = ADDRESS_FORMS?.token === wallet.address ? 'token' : 'cash';
  renderAccountAddress();
  $('accountKind').textContent = wallet.walletName ?? 'Account';
  $('faucetBtn').classList.toggle('hidden', !CONFIG.faucetUrl);
  openModal('accountModal');
  loadAssets();
}

$('addressSwitch').onclick = () => {
  if (!ADDRESS_FORMS) return;
  ADDRESS_FORM = ADDRESS_FORM === 'cash' ? 'token' : 'cash';
  renderAccountAddress();
};

/** Wallet extensions detected in this page, by the BCH counterpart of EIP-6963. */
interface InjectedEntry { id: string; name: string; icon?: string; rdns?: string; provider: any }
const INJECTED = new Map<string, InjectedEntry>();
const INJECTED_BY_PROVIDER = new WeakMap<object, string>();
let injectedListening = false;

/** The injected wallet this browser last connected, so a refresh can reconnect it. */
interface SavedInjected { id: string; name: string; rdns?: string; network: string }
const INJECTED_KEY = 'pools.injected.v1';

const savedInjected = (): SavedInjected | null => {
  try {
    const value = JSON.parse(localStorage.getItem(INJECTED_KEY) ?? 'null');
    if (!value || typeof value.id !== 'string' || typeof value.network !== 'string') return null;
    return {
      id: value.id,
      name: typeof value.name === 'string' && value.name ? value.name : value.id,
      ...(typeof value.rdns === 'string' && value.rdns ? { rdns: value.rdns } : {}),
      network: value.network,
    };
  } catch { return null; }
};
const saveInjected = (entry: InjectedEntry): void => {
  try {
    localStorage.setItem(INJECTED_KEY, JSON.stringify({
      id: entry.id, name: entry.name, ...(entry.rdns ? { rdns: entry.rdns } : {}), network: CONFIG.networkId,
    }));
  } catch { /* the wallet still works for this visit */ }
};
const forgetInjected = (): void => {
  try { localStorage.removeItem(INJECTED_KEY); } catch { /* nothing to forget */ }
};

const injectedName = (provider: any): string => (
  provider?.isCashonize ? 'Cashonize'
    : provider?.isPaytaca ? 'Paytaca'
      : typeof provider?.walletName === 'string' && provider.walletName ? provider.walletName
        : 'Bitcoin Cash wallet');

function rememberInjected(provider: any, info?: any): void {
  if (!provider || typeof provider !== 'object' || typeof provider.request !== 'function') return;
  const prior = INJECTED_BY_PROVIDER.get(provider);
  const id = prior ?? String(info?.uuid ?? info?.rdns ?? injectedName(provider));
  INJECTED_BY_PROVIDER.set(provider, id);
  const name = typeof info?.name === 'string' && info.name.trim() ? info.name.trim() : injectedName(provider);
  const icon = typeof info?.icon === 'string' && info.icon ? info.icon : INJECTED.get(id)?.icon;
  const rdns = typeof info?.rdns === 'string' && info.rdns ? info.rdns : INJECTED.get(id)?.rdns;
  INJECTED.set(id, { id, name, ...(icon ? { icon } : {}), ...(rdns ? { rdns } : {}), provider });
  if (typeof document !== 'undefined') {
    const modal = document.getElementById('connectModal');
    if (modal !== null && !modal.classList.contains('hidden')) renderInjectedOptions();
  }
}

function discoverInjected(): void {
  if (injectedListening || typeof window === 'undefined') return;
  injectedListening = true;
  const cashonize = (window as any).cashonize;
  const bitcoincash = (window as any).bitcoincash;
  if (cashonize) rememberInjected(cashonize);
  if (bitcoincash) rememberInjected(bitcoincash);
  window.addEventListener('bitcoincash:announceProvider', (event: Event) => {
    const detail = (event as CustomEvent).detail as { info?: any; provider?: any } | undefined;
    if (detail?.provider) rememberInjected(detail.provider, detail.info);
  });
  // A wallet injected before this page listened announces once at document_start; ask again.
  window.dispatchEvent(new Event('bitcoincash:requestProvider'));
  // A provider injected after this page's scripts still gets found; an announcement is preferred.
  let polls = 0;
  const poll = setInterval(() => {
    const lateCashonize = (window as any).cashonize;
    const lateBitcoincash = (window as any).bitcoincash;
    if (lateCashonize) rememberInjected(lateCashonize);
    if (lateBitcoincash) rememberInjected(lateBitcoincash);
    polls += 1;
    if (polls >= 20) clearInterval(poll);
  }, 250);
}

function renderInjectedOptions(): void {
  const container = $('injectedOptions');
  if (!container) return;
  const entries = [...INJECTED.values()];
  container.classList.toggle('hidden', entries.length === 0);
  container.innerHTML = entries.map((entry) => `
    <button class="option injected" data-injected="${esc(entry.id)}" title="${esc(entry.rdns ?? entry.name)}">
      ${entry.icon
        ? `<img class="wallet-icon" src="${esc(entry.icon)}" alt="" width="26" height="26" />`
        : `<span class="wallet-icon letter" aria-hidden="true">${esc((entry.name || '?').slice(0, 1).toUpperCase())}</span>`}
      <span class="injected-copy"><b>Injected wallet · ${esc(entry.name)}</b>
        <span>Detected in this browser; signs in the wallet extension.</span></span>
    </button>`).join('');
  container.querySelectorAll('[data-injected]').forEach((button: any) => button.onclick = () => {
    const entry = INJECTED.get(button.dataset.injected);
    if (entry) void connectInjected(entry);
  });
}

/** The address a provider already offers, without asking it to open or grant a connection. */
async function injectedAddressOf(provider: any): Promise<string | undefined> {
  if (typeof provider.address === 'function') {
    const address = await provider.address().catch(() => undefined);
    if (typeof address === 'string' && address) return address;
  }
  if (typeof provider.request === 'function') {
    const accounts = await provider.request({ method: 'bch_getAddresses', params: {} }).catch(() => undefined);
    if (Array.isArray(accounts)) return accounts.find((value: unknown): value is string => typeof value === 'string');
  }
  return undefined;
}

async function connectInjected(entry: InjectedEntry, restore = false): Promise<void> {
  const provider = entry.provider;
  try {
    let address: string | undefined;
    if (restore) {
      // A page load asks only what the wallet already grants. A wallet that has forgotten
      // this site stays disconnected without a prompt, and the next refresh can try again.
      address = await injectedAddressOf(provider);
      if (!address) return;
    } else {
      if (typeof provider.connect === 'function') {
        await provider.connect({ chainId: CONFIG.chain });
      } else if (typeof provider.request === 'function') {
        await provider.request({ method: 'bch_requestAccounts', params: { chainId: CONFIG.chain } }).catch(() => undefined);
      }
      address = await injectedAddressOf(provider);
    }
    if (!address) throw notice('The injected wallet did not offer an account on this network.');
    if (!address.startsWith(`${CONFIG.addressPrefix}:`)) {
      if (restore) { forgetInjected(); return; }
      throw notice(`That account is not on ${CONFIG.networkLabel || CONFIG.networkId}.`);
    }
    const injected: any = {
      kind: 'injected',
      address,
      walletName: entry.name,
      signRequest: (request: unknown) => provider.request({ method: 'bch_signTransaction', params: request }),
      disconnect: async () => {
        cleanup();
        try { await provider.disconnect?.(); } catch { /* it may already be gone */ }
      },
    };
    let cleanup = (): void => {};
    const end = (): void => {
      if (wallet !== injected) return;
      cleanup();
      forgetInjected();
      wallet = null;
      walletAssetState = null;
      closeModal('accountModal');
      renderWallet();
      renderRecipientWarning();
      setStatus('Your wallet ended the session.');
    };
    const onAccounts = (accounts: unknown): void => {
      if (wallet !== injected) return;
      const next = Array.isArray(accounts)
        ? accounts.find((value: unknown): value is string => typeof value === 'string') : undefined;
      if (next === undefined) { end(); return; }
      injected.address = next;
      renderWallet();
      renderRecipientWarning();
    };
    provider.on?.('accountsChanged', onAccounts);
    provider.on?.('disconnect', end);
    cleanup = () => {
      provider.removeListener?.('accountsChanged', onAccounts);
      provider.removeListener?.('disconnect', end);
    };
    wallet = injected;
    saveInjected(entry);
    closeModal('connectModal');
    renderWallet();
    if (!restore) openAccount();
    renderRecipientWarning();
    void loadAssets();
  } catch (error) {
    if (restore) { forgetInjected(); return; }
    setStatus(shown(error), 'err');
  }
}

let restoringInjected = false;
let bootedNetwork: string | null = null;
/** Reconnect the wallet this browser last used, once its provider is on the page. */
function restoreInjected(): void {
  if (restoringInjected || wallet || bootedNetwork === null) return;
  const saved = savedInjected();
  if (!saved) return;
  if (saved.network !== bootedNetwork) { forgetInjected(); return; }
  restoringInjected = true;
  const entryForSaved = (): InjectedEntry | undefined => {
    const entries = [...INJECTED.values()];
    const exact = entries.find((entry) => entry.id === saved.id
      || (saved.rdns !== undefined && entry.rdns === saved.rdns));
    if (exact) return exact;
    const named = entries.filter((entry) => entry.name === saved.name);
    return named.length === 1 ? named[0] : undefined;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  function stopWaiting(): void {
    window.removeEventListener('bitcoincash:announceProvider', onAnnounce);
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
  }
  function onAnnounce(): void { attempt(); }
  function attempt(): boolean {
    const entry = entryForSaved();
    if (!entry) return false;
    stopWaiting();
    void connectInjected(entry, true).finally(() => { restoringInjected = false; });
    return true;
  }
  if (attempt()) return;
  window.addEventListener('bitcoincash:announceProvider', onAnnounce);
  // A provider can appear without an announcement; look for it while the page settles.
  poll = setInterval(() => { attempt(); }, 250);
  timer = setTimeout(() => {
    stopWaiting();
    restoringInjected = false;
  }, 5_000);
}

const openConnect = () => {
  renderInjectedOptions();
  $('connectLocal').classList.toggle('hidden', !CONFIG.localAccounts);
  const walletConnect = Boolean(CONFIG.walletConnectProjectId);
  $('connectWC').classList.remove('hidden');
  $('connectWC').disabled = !walletConnect;
  $('wcHint').textContent = walletConnect
    ? 'Scan the code with Cashonize, Paytaca, or another wallet app.'
    : 'WalletConnect is not set up for this deployment. Use a wallet in this browser instead.';
  openModal('connectModal');
};
$('connect').onclick = openConnect;
$('accountBtn').onclick = openAccount;
$('accountAddress').onclick = () => { void navigator.clipboard?.writeText($('accountAddress').textContent ?? ''); };

$('connectLocal').onclick = async () => {
  try {
    const api = await loadWalletApi();
    wallet = api.createLocalAccount(CONFIG.addressPrefix, CONFIG.localAccounts);
    forgetInjected();
  } catch (error) {
    setStatus(shown(error), 'err');
    return;
  }
  closeModal('connectModal');
  renderWallet();
  openAccount();
  renderRecipientWarning();
  void loadAssets();
};

const copyPairingUri = async (): Promise<void> => {
  const uri = $('pairingUri').textContent ?? '';
  if (!uri) return;
  try {
    await navigator.clipboard.writeText(uri);
    setStatus('Pairing link copied.', 'ok');
  } catch {
    setStatus('This browser refused to copy the link. Select it and copy it manually.', 'err');
  }
};
$('copyPairingUri').onclick = () => { void copyPairingUri(); };
$('pairingUri').onclick = () => { void copyPairingUri(); };

$('connectWC').onclick = async () => {
  closeModal('connectModal');
  $('pairingQr').removeAttribute('src');
  $('pairingQr').classList.add('hidden');
  $('pairingQrPlaceholder').classList.remove('hidden');
  $('pairingUri').textContent = '';
  $('copyPairingUri').classList.add('hidden');
  openModal('pairingModal');
  try {
    const api = await loadWalletApi();
    wallet = await api.connectWalletConnect({
      projectId: CONFIG.walletConnectProjectId,
      relayUrl: CONFIG.walletConnectRelayUrl ?? undefined,
      chain: CONFIG.chain,
      onUri: async (uri) => {
        $('pairingUri').textContent = uri;
        $('copyPairingUri').classList.remove('hidden');
        // Show the QR only once it is a real data URL; an empty src paints a broken image.
        $('pairingQr').classList.add('hidden');
        $('pairingQrPlaceholder').classList.remove('hidden');
        $('pairingQr').src = await api.qrDataUrl(uri);
        $('pairingQr').classList.remove('hidden');
        $('pairingQrPlaceholder').classList.add('hidden');
      },
      onEnded: () => {
        wallet = null;
        closeModal('accountModal');
        renderWallet();
        renderRecipientWarning();
        setStatus('Your wallet ended the session.');
      },
      onAddress: (address: string) => {
        if (!wallet) return;
        wallet.address = address;
        renderWallet();
        renderRecipientWarning();
      },
    });
    forgetInjected();
    closeModal('pairingModal');
    renderWallet();
    openAccount();
    renderRecipientWarning();
    void loadAssets();
  } catch (e) {
    closeModal('pairingModal');
    setStatus(shown(e), 'err');
  }
};

$('faucetBtn').onclick = async () => {
  if (!wallet || !CONFIG.faucetUrl) return;
  const b = $('faucetBtn'); b.disabled = true; b.textContent = 'Sending…';
  try {
    // The devnet's service hands out its test coins itself, so this asks the app nothing.
    const r = await (await fetch(CONFIG.faucetUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address }) })).json();
    if (r.error) throw new Error(r.error);
    await loadAssets();
  } catch (e) { $('accountAssets').innerHTML = `<div class="hint err">${esc(shown(e))}</div>`; }
  b.disabled = false; b.textContent = 'Get test funds';
};

$('disconnectBtn').onclick = async () => {
  try { await wallet?.disconnect?.(); } catch {}
  forgetInjected();
  wallet = null;
  walletAssetState = null;
  closeModal('accountModal');
  renderWallet();
  renderAssetView(null);
  setStatus('Wallet disconnected.');
  renderRecipientWarning();
};

// ---- deposit ----
// The note is made and shown first, and stays on screen until the deposit is settled. If
// the wallet refuses, nothing was sent and the note is simply unused. The reverse order,
// or a note gone from the page before its deposit lands, could lose a deposit.
const depositBtn = $('depositBtn');
const NOTE_STEPS: Record<NoteStep, { title: string; lede: string; next?: string; other?: string }> = {
  unsaved: {
    title: 'Save your private note',
    lede: 'This note is the only way to withdraw the deposit, and nobody can recover it for you. Copy or download it to go on. Nothing is sent until you confirm.',
    next: 'I saved it, deposit', other: 'Cancel',
  },
  saved: {
    title: 'Save your private note',
    lede: 'This note is the only way to withdraw the deposit, and nobody can recover it for you. Nothing is sent until you confirm.',
    next: 'I saved it, deposit', other: 'Cancel',
  },
  sending: { title: 'Depositing', lede: 'Keep this page open. Your deposit is on its way.' },
  done: { title: 'Your deposit is in the pool', lede: 'Keep your private note safe. It is the only way to withdraw.', next: 'Done' },
  failed: { title: 'Nothing was sent', lede: 'Your note is unused, so you can try again with it.', next: 'Try again', other: 'Close' },
  // A note pays once, so one whose deposit may have landed is never deposited again.
  unknown: {
    title: 'This deposit may have gone through',
    lede: 'Keep your note, and paste it under Withdraw later: it pays if the deposit landed. Starting over makes a new note. If both land, both pay.',
    other: 'Close',
  },
};
function renderNote(step: NoteStep, message = '') {
  noteStep = step;
  const { title, lede, next, other } = NOTE_STEPS[step];
  $('noteTitle').textContent = title;
  $('noteLede').textContent = lede;
  $('noteStatus').className = step === 'failed' ? 'hint err' : 'hint';
  $('noteStatus').textContent = message;
  $('noteDone').textContent = next ?? 'Depositing…';
  $('noteDone').disabled = step === 'unsaved' || step === 'sending';
  $('noteDone').classList.toggle('hidden', step === 'unknown');
  $('noteCancel').textContent = other ?? '';
  $('noteCancel').classList.toggle('hidden', !other);
  // Making the deposit's coin is offered only where it stopped for want of one.
  $('noteOffer').classList.add('hidden');
  if (step === 'unsaved') $('noteSteps').classList.add('hidden');
}
function closeNote() {
  pendingDeposit = null;
  prepared = null;
  $('depositOut').innerHTML = '';
  closeModal('noteModal');
  dialogHolds(false);
  depositBtn.disabled = false;
}

/** The deposit's steps in its dialog, after the coin made for it when one was. */
function drawDeposit(progress: any): void {
  const made = prepared && prepared.poolId === pendingDeposit?.poolId && prepared.progress?.over && !prepared.progress.failure
    && prepared.progress.steps.every((step: any) => step.state === 'done');
  drawSteps($('noteSteps'), [...(made ? stepRows(prepared!.progress) : []), ...stepRows(progress)], stepContext(progress), !progress.over);
}

/** Engine progress in plain words for someone who is not following the internals. */
const friendlyProgress = (text: string): string => {
  if (/Groth16|proof/i.test(text)) return 'Preparing your private withdrawal…';
  if (/Reading the pool/i.test(text)) return 'Checking the pool…';
  if (/Waiting for the pool to show/i.test(text)) return 'Waiting for the payment to appear…';
  if (/Waiting for your note to appear/i.test(text)) return 'Waiting for your deposit to land…';
  return text;
};

const dialogHolds = (held: boolean) => { document.querySelectorAll('header, main, footer').forEach((el) => { (el as HTMLElement).inert = held; }); };
depositBtn.onclick = async () => {
  if (busy) return;
  if (!wallet) { openConnect(); return; }
  const pool = allPools().find((candidate) => candidate.id === OPEN);
  if (!pool) return;
  const blocked = depositBlocked(pool);
  if (blocked) { setStatus(blocked, 'err'); return; }
  const engine = await loadEngine();
  const note = engine.newNote(pool, CONFIG.networkId);
  pendingDeposit = { note, poolId: pool.id };
  $('depositOut').innerHTML = `<code class="note">${esc(note)}</code>`;
  $('noteCopy').textContent = 'Copy';
  $('noteDownload').textContent = 'Download';
  renderNote('unsaved');
  // The note dialog takes over; the pool grid is what the user returns to.
  hidePoolModal();
  openModal('noteModal');
  // Nothing behind the dialog can be reached, by keyboard either, while it holds a note.
  dialogHolds(true);
  depositBtn.disabled = true;
};
const noteSaved = () => { if (noteStep === 'unsaved') renderNote('saved'); };
$('noteCopy').onclick = async () => {
  if (!pendingDeposit) return;
  try {
    await navigator.clipboard.writeText(pendingDeposit.note);
    $('noteCopy').textContent = 'Copied';
    noteSaved();
  } catch {
    $('noteStatus').textContent = 'This browser refused to copy it. Use Download.';
  }
};
$('noteDownload').onclick = () => {
  if (!pendingDeposit) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([`${pendingDeposit.note}\n`], { type: 'text/plain' }));
  link.download = `note-${pendingDeposit.poolId}-${Date.now()}.txt`;
  link.click();
  // Safari reads the link after this click returns, so it has to outlive it.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  $('noteDownload').textContent = 'Download again';
  noteSaved();
};
$('noteCancel').onclick = closeNote;
$('noteDone').onclick = async () => {
  const deposit = pendingDeposit;
  if (!deposit) return;
  if (noteStep === 'done') { closeNote(); return; }
  if (!wallet) { renderNote('failed', 'Your wallet is no longer connected. Close this, connect it again and start over.'); return; }
  let config;
  try {
    config = engineConfig();
  } catch (e) {
    renderNote('failed', shown(e));
    return;
  }
  renderNote('sending');
  busy = true;
  // Once the deposit's steps are drawn, they say what the status line said.
  let stepped = false;
  try {
    const engine = await loadEngine();
    const { hashed, waitsOnFee } = await engine.deposit(config, deposit.note, wallet, (text: string) => {
      if (!stepped) $('noteStatus').textContent = friendlyProgress(text);
    }, (progress: any) => {
      if (!stepped) $('noteStatus').textContent = '';
      stepped = true;
      drawDeposit(progress);
    });
    renderNote('done', hashed ? '' : waitsOnFee
      ? 'Its last step now needs more network fee than the deposit prepaid, so it cannot be withdrawn yet. Withdrawing it offers to pay that from this same wallet.'
      : 'The next visitor finishes adding it, at no cost. It cannot be withdrawn before then.');
    OPEN = null;
    busy = false;
    await refresh();
    if (wallet) await loadAssets();
  } catch (e) {
    if ((e as any)?.unsent) renderNote('failed', shown(e));
    else renderNote('unknown');
    // The wallet holds enough of the asset, on coins none of which the deposit takes alone, which
    // the page knew too late to say before the note: the coin can be made now, and the note waits.
    if ((e as any)?.prepareCoin) {
      $('noteOfferText').textContent = prepareCoinLine();
      $('noteOffer').classList.remove('hidden');
    }
  }
  busy = false;
};

$('noteOfferBtn').onclick = async () => {
  const deposit = pendingDeposit;
  const pool = deposit && poolOf(deposit.poolId);
  if (!deposit || !pool || !wallet || busy) return;
  const button = $('noteOfferBtn');
  button.disabled = true;
  $('noteDone').disabled = true;
  busy = true;
  try {
    const engine = await loadEngine();
    await engine.prepareDepositCoin(engineConfig(), deposit.poolId, wallet, undefined, (progress: any) => {
      prepared = { poolId: deposit.poolId, progress };
      drawPrepare(pool, progress, $('noteSteps'));
    });
    $('noteOffer').classList.add('hidden');
    $('noteStatus').className = 'hint ok';
    $('noteStatus').textContent = 'The coin is ready. Try again to deposit, with the same note.';
    void loadAssets();
  } catch (e) {
    $('noteStatus').className = 'hint err';
    $('noteStatus').textContent = shown(e);
  } finally {
    busy = false;
    button.disabled = false;
    $('noteDone').disabled = false;
  }
};

/** The coin a deposit spends, made before the note is shown, from the pool's dialog. */
$('prepareCoinBtn').onclick = async () => {
  const pool = poolOf(OPEN);
  if (!pool || !wallet || busy) return;
  const button = $('prepareCoinBtn');
  button.disabled = true;
  busy = true;
  holdDialog('poolModal', true);
  prepared = { poolId: pool.id, progress: undefined };
  $('prepareStatus').className = 'hint';
  $('prepareStatus').textContent = '';
  try {
    const engine = await loadEngine();
    await engine.prepareDepositCoin(engineConfig(), pool.id, wallet, undefined, (progress: any) => {
      prepared = { poolId: pool.id, progress };
      if (OPEN === pool.id) drawPrepare(pool, progress);
    });
    await loadAssets();
    if (OPEN === pool.id) {
      $('prepareStatus').className = 'hint ok';
      $('prepareStatus').textContent = 'The coin is ready. Continue to deposit.';
    }
  } catch (e) {
    $('prepareStatus').className = 'hint err';
    $('prepareStatus').textContent = shown(e);
  } finally {
    busy = false;
    button.disabled = false;
    holdDialog('poolModal', false);
  }
};
window.addEventListener('beforeunload', (event) => { if (pendingDeposit) event.preventDefault(); });

// ---- redeem ----
/**
 * Should nodes ever ask more than a pool prepaid, a wallet can pay the rest. Its coin shows in
 * the withdrawal, so the page only offers that, and says so.
 */
let feeOffer: { missing: bigint; step: 'hashing' | 'withdrawal' } | null = null;
function offerFee(missing: bigint, step: 'hashing' | 'withdrawal') {
  feeOffer = { missing, step };
  const satoshis = missing.toLocaleString('en-US');
  // Whoever pays the note's last step is tied to its deposit, and whoever pays the withdrawal's
  // fee to the withdrawal, so the two must come from different wallets.
  $('feeOfferText').textContent = step === 'hashing'
    ? `A connected wallet can pay the missing ${satoshis} satoshis. Whoever pays this is tied to your deposit, so connect the wallet you deposited with.`
    : `A connected wallet can pay the missing ${satoshis} satoshis. Its coin shows in the withdrawal, so use a wallet that has nothing to do with your deposit.`;
  $('feeOfferBtn').textContent = step === 'hashing' ? 'Pay it from the connected wallet' : 'Pay it from the connected wallet and withdraw';
  $('feeOffer').classList.remove('hidden');
}
/** A shortfall stops a step and is offered again: the page pays no more than about what it showed. */
const offered = (error: any): boolean => {
  if (typeof error?.missing !== 'bigint') return false;
  offerFee(error.missing, error.step);
  return true;
};

/**
 * A fee wallet's steps under the withdrawal: its coins gathered into one first when no coin pays
 * the fee alone, then the fee, each an approval in a wallet this page holds no key for.
 */
const drawFee = (progress: any) => {
  if (progress.total > 0) drawSteps($('feeSteps'), stepRows(progress), stepContext(progress), !progress.over);
};

async function payHashing(payer: any, mostTopUp: bigint) {
  if (busy) return;
  $('feeOffer').classList.add('hidden');
  $('feeSteps').classList.add('hidden');
  busy = true;
  $('progress').classList.remove('hidden');
  try {
    const engine = await loadEngine();
    const { hashed } = await engine.finishNote(engineConfig(), $('note').value, payer, (text) => setStatus(friendlyProgress(text)), { mostTopUp, onSteps: drawFee });
    setStatus(hashed
      ? 'Your note is in the pool now. If its withdrawal needs more fee too, pay that from a wallet with nothing to do with your deposit.'
      : 'This note is not waiting to be added to the pool.', hashed ? 'ok' : '');
  } catch (e) {
    setStatus(shown(e), 'err');
    offered(e);
  }
  busy = false;
  $('progress').classList.add('hidden');
}

async function runWithdrawal(feeWallet?: any, mostTopUp?: bigint) {
  const b = $('withdrawBtn');
  const recipient = $('recipient').value.trim();
  if (busy || (isOwnWallet(recipient) && !ownRecipientAllowed())) return;
  $('feeOffer').classList.add('hidden');
  $('feeSteps').classList.add('hidden');
  b.disabled = true;
  busy = true;
  $('progress').classList.remove('hidden');
  setStatus('Checking the pool…');
  try {
    const engine = await loadEngine();
    const r = await engine.withdraw(
      engineConfig(), $('note').value, recipient, (text) => setStatus(friendlyProgress(text)), undefined, { feeWallet, mostTopUp, onSteps: drawFee },
    );
    const { pool } = r;
    $('withdrawOut').innerHTML = r.outcome === 'spent' ? '' : `<div class="done">
      <p><b>${esc(fmtAmount(pool, r.amount))}</b> ${r.outcome === 'paid' ? 'paid to' : 'sent to'}</p>
      <p class="addr">${esc(r.recipient)}</p>
      <p class="txid">${esc(r.txid)}</p>
      <p class="hint">Transaction size: ${esc(r.size)} bytes · ${esc(pool.symbol)} pool</p>
      <p class="hint">Keep your private note until the recipient confirms the payment.</p>
    </div>`;
    if (r.outcome === 'paid') {
      setStatus(`Withdrawal sent. ${fmtAmount(pool, r.amount)} paid to ${r.recipient}.`, 'ok');
      // The note stays: this rests on a server, and only the recipient can settle it.
      $('recipient').value = '';
    } else if (r.outcome === 'sent') {
      setStatus('Sent, but the pool does not show it yet. Keep your note until the payment arrives.', 'err');
    } else {
      setStatus('This note has already been used, and this page cannot confirm where it paid. Check the recipient. If it was not you, someone else has your note.', 'err');
    }
    busy = false;
    // Reading this withdrawal back through the wallet's server would tie the two together.
    const { fulcrumUrl, broadcastUrl } = engineConfig();
    if (!broadcastUrl || broadcastUrl === fulcrumUrl) await refresh();
  } catch (e) {
    setStatus(shown(e), 'err');
    offered(e);
  }
  busy = false;
  $('progress').classList.add('hidden');
  b.disabled = false;
  renderRecipientWarning();
}
$('withdrawBtn').onclick = () => runWithdrawal();
$('feeOfferBtn').onclick = () => {
  if (!feeOffer) return undefined;
  if (!wallet) {
    setStatus('Connect a wallet under Your wallet first.', 'err');
    return undefined;
  }
  // What a proof's size moves between one try and the next, and no more.
  const mostTopUp = feeOffer.missing + feeOffer.missing / 10n;
  return feeOffer.step === 'hashing' ? payHashing(wallet, mostTopUp) : runWithdrawal(wallet, mostTopUp);
};

// ---- settings ----
const settingsStatus = (text, cls = '') => {
  $('settingsStatus').className = 'hint ' + cls;
  $('settingsStatus').textContent = text;
};
function renderNetworkChoices() {
  const choices = CONFIG.networks ?? [];
  $('networkChoices').innerHTML = choices.map((network: any) => `
    <label class="choice${network.available ? '' : ' disabled'}">
      <input type="radio" name="network" value="${esc(network.id)}"
        ${network.id === CONFIG.networkId ? 'checked' : ''} ${network.available ? '' : 'disabled'} />
      <span>${esc(network.label)}</span>
      ${network.local ? '<span class="tag">local</span>' : ''}
      ${network.available ? '' : `<span class="hint">${esc(network.reason ?? 'Not available')}</span>`}
    </label>`).join('');
}

function openSettings(focus?: 'source'): void {
  renderNetworkChoices();
  renderSourceChoices();
  renderIndexerFields(CONFIG.networkId);
  renderServerFields(CONFIG.networkId);
  settingsStatus('');
  openModal('settingsModal');
  if (focus === 'source') {
    const choices = $('sourceChoices');
    const selected = (choices.querySelector('input:checked') ?? choices.querySelector('input')) as HTMLInputElement | null;
    if (!selected) return;
    selected.focus({ preventScroll: true });
    (selected.closest('.choice') as HTMLElement | null)?.scrollIntoView({ block: 'center' });
  }
}
$('networkPill').onclick = () => openSettings();
$('dataSource').onclick = () => openSettings('source');
const validEndpoint = (url: string) => !url
  || /^(https?|wss?):\/\//i.test(url)
  || /^\/(?!\/)/.test(url); // this deployment's own proxy path, as the devnet uses
const validIndexer = (url: string) => !url
  || /^https?:\/\//i.test(url)
  || /^\/(?!\/)/.test(url);
$('settingsSave').onclick = async () => {
  const indexerPicked = $('indexerServer').value;
  const indexerUrl = indexerPicked === '__custom' ? $('indexerEndpoint').value.trim() : '';
  const chainPicked = $('fulcrumServer').value;
  const withdrawalPicked = $('broadcastServer').value;
  const endpoint = chainPicked === '__custom' ? $('fulcrumEndpoint').value.trim() : chainPicked;
  const broadcast = withdrawalPicked === '__same' ? endpoint
    : withdrawalPicked === '__custom' ? $('broadcastEndpoint').value.trim() : withdrawalPicked;
  const picked = document.querySelector('input[name="network"]:checked') as HTMLInputElement | null;
  const sourcePicked = document.querySelector('input[name="dataSource"]:checked') as HTMLInputElement | null;
  const nextNetwork = picked?.value ?? CONFIG.networkId;
  const previousSource = dataSource();
  const nextSource = sourcePicked?.value === 'trustless' ? 'trustless' : 'indexer';
  if (indexerPicked === '__custom' && !indexerUrl) { settingsStatus('Enter the indexer URL.', 'err'); return; }
  if (!validIndexer(indexerUrl)) { settingsStatus('Use an http(s) or app path URL for the indexer.', 'err'); return; }
  if (chainPicked === '__custom' && !endpoint) { settingsStatus('Enter the chain server URL.', 'err'); return; }
  if (withdrawalPicked === '__custom' && !broadcast) { settingsStatus('Enter the withdrawal server URL.', 'err'); return; }
  if (!validEndpoint(endpoint) || !validEndpoint(broadcast)) { settingsStatus('Use an http(s), ws(s) or app path URL.', 'err'); return; }
  // Nobody on the path may rewrite what a public network's server says.
  const plain = serverUrlProblem(nextNetwork, endpoint) ?? serverUrlProblem(nextNetwork, broadcast);
  if (plain) { settingsStatus(`${plain[0].toUpperCase()}${plain.slice(1)}.`, 'err'); return; }
  const chainServes = serverNetwork(endpoint);
  if (chainServes && chainServes !== nextNetwork) {
    settingsStatus(`That server serves ${chainServes}. Choose ${chainServes} above, or a ${nextNetwork} server.`, 'err');
    return;
  }
  const withdrawalServes = serverNetwork(broadcast);
  if (withdrawalServes && withdrawalServes !== nextNetwork) {
    settingsStatus(`That withdrawal server serves ${withdrawalServes}. Choose a ${nextNetwork} server.`, 'err');
    return;
  }
  $('settingsSave').disabled = true;
  settingsStatus('Checking the server…');
  try {
    // A custom indexer is asked only when the page is to read it: Trustless asks no indexer.
    if (indexerPicked === '__custom' && nextSource === 'indexer' && !(await checkIndexer(indexerUrl))) {
      settingsStatus('That indexer did not answer with an archive. Check the URL and try again.', 'err');
      return;
    }
    const chainProblem = chainPicked === '__custom' ? await checkFulcrum(endpoint, nextNetwork) : undefined;
    if (chainProblem) {
      settingsStatus(`That chain server ${chainProblem}. Check the URL and try again.`, 'err');
      return;
    }
    const withdrawalProblem = withdrawalPicked === '__custom' && broadcast !== endpoint
      ? await checkFulcrum(broadcast, nextNetwork) : undefined;
    if (withdrawalProblem) {
      settingsStatus(`That withdrawal server ${withdrawalProblem}. Check the URL and try again.`, 'err');
      return;
    }
  } finally {
    $('settingsSave').disabled = false;
  }
  localStorage.setItem(SOURCE_KEY, nextSource);
  // The chosen servers follow this browser, per network.
  if (indexerPicked === '__custom') localStorage.setItem(`${INDEXER_KEY}.${nextNetwork}`, indexerUrl);
  else localStorage.removeItem(`${INDEXER_KEY}.${nextNetwork}`);
  if (endpoint) localStorage.setItem(`${FULCRUM_KEY}.${nextNetwork}`, endpoint);
  else localStorage.removeItem(`${FULCRUM_KEY}.${nextNetwork}`);
  if (broadcast) localStorage.setItem(`${BROADCAST_KEY}.${nextNetwork}`, broadcast);
  else localStorage.removeItem(`${BROADCAST_KEY}.${nextNetwork}`);
  renderSourceChoices();
  if (nextNetwork !== CONFIG.networkId) {
    // A connected wallet belongs to the network it was opened on.
    try { await wallet?.disconnect?.(); } catch { /* the page still moves */ }
    forgetInjected();
    wallet = null;
    stopWalletWatch();
    localStorage.setItem(NETWORK_KEY, nextNetwork);
    settingsStatus(`Switching to ${nextNetwork}…`);
    closeModal('settingsModal');
    await boot();
    return;
  }
  if (dataSource() !== previousSource) {
    // Close Settings so the catch-up bar is visible while the trustless read runs. Each source has
    // its own settings, Trustless those this page came with and the indexer /api/config's, so the
    // page starts over from them, and nothing the other supplied stays.
    closeModal('settingsModal');
    await boot();
    return;
  }
  settingsStatus('Saved in this browser.', 'ok');
  await refresh();
  void startWalletWatch();
};
$('settingsClear').onclick = async () => {
  const previousSource = dataSource();
  localStorage.removeItem(networkKey(FULCRUM_KEY));
  localStorage.removeItem(networkKey(BROADCAST_KEY));
  localStorage.removeItem(networkKey(INDEXER_KEY));
  localStorage.removeItem(FULCRUM_KEY);
  localStorage.removeItem(BROADCAST_KEY);
  renderIndexerFields(CONFIG.networkId);
  renderServerFields(CONFIG.networkId);
  renderSourceChoices();
  settingsStatus('Using the app defaults.', 'ok');
  // Without its own indexer, a page that read one reads trustless, from the settings it came with.
  if (dataSource() !== previousSource) {
    await boot();
    return;
  }
  await refresh();
  void startWalletWatch();
};
$('settingsResetData').onclick = async () => {
  const button = $('settingsResetData');
  const question = 'Reset all data this app stores in this browser?\n\n'
    + 'This removes the browser wallet key, settings, cached chain data and remembered pools. '
    + 'Private notes are not stored here, so keep yours. This cannot be undone.';
  if (!window.confirm(question)) return;
  button.disabled = true;
  button.textContent = 'Resetting…';
  try {
    try { await wallet?.disconnect?.(); } catch { /* it may already be gone */ }
    wallet = null;
    stopWalletWatch();
    localStorage.clear();
    await cacheClear();
    location.reload();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Reset stored data';
    settingsStatus(shown(error), 'err');
  }
};

/**
 * CONFIG for the network this browser chose, from where its source reads. Trustless takes the
 * settings the server wrote into this page, and with them the deployment's own pools, which it
 * checks against the factories as it does every pool; it asks this app's /api for nothing. The
 * indexer asks /api/config, whose pools the app's server checked, the indexer's among them. Either
 * starts from the defaults: a network without an indexer or faucet must not inherit the previous
 * network's.
 */
async function loadConfig(): Promise<void> {
  // Read afresh each time, so nothing changed while one network was in use carries over.
  const page: PageSettings = readPageSettings() ?? { defaultNetwork: 'chipnet', networks: [], settings: {} };
  const id = networkFor(page, localStorage.getItem(NETWORK_KEY));
  const own: any = page.settings[id];
  try {
    if (sourceFor(id, own?.indexerUrl) === 'indexer') {
      const response = await fetch(`/api/config?network=${encodeURIComponent(id)}`);
      const config = await response.json();
      CONFIG = { ...initialConfig(), ...config };
      if (config.networkId) localStorage.setItem(NETWORK_KEY, config.networkId);
      if (config.error) throw notice(config.error);
      return;
    }
    if (!own) throw notice('This page came without its settings. Reload it.');
    CONFIG = { ...initialConfig(), ...own, networks: page.networks };
    localStorage.setItem(NETWORK_KEY, id);
    if (own.error) throw notice(own.error);
  } catch (error) {
    setStatus(shown(error), 'err');
  }
}

async function boot() {
  await loadConfig();
  bootedNetwork = CONFIG.networkId;
  // Nothing read for the network before stays on screen, or can be acted on, while this one is read.
  STATE = null;
  OPEN = null;
  renderPools();
  updateHeader();
  renderWallet();
  renderAssetView(null);
  await refresh();
  if (wallet) void loadAssets();
}

// ---- terms ----
// Nothing here can be used until the terms are accepted. The answer stays in this browser:
// a record of who accepted would be a record of who used the app.
const termsAccepted = () => { try { return localStorage.getItem(TERMS_KEY) === TERMS_VERSION; } catch { return false; } };
$('termsAgree').onchange = () => { $('termsAccept').disabled = !$('termsAgree').checked; };
$('termsAccept').onclick = () => {
  try { localStorage.setItem(TERMS_KEY, TERMS_VERSION); } catch { /* Asked again next visit. */ }
  closeModal('termsGate');
  dialogHolds(false);
  void restoreInjected();
};
if (!termsAccepted()) {
  $('termsAgree').checked = false;
  $('termsAccept').disabled = true;
  openModal('termsGate');
  dialogHolds(true);
}

  discoverInjected();
  await boot();
  if (termsAccepted()) void restoreInjected();
}
