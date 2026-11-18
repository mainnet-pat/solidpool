// The app in a real browser, against the service's local chain: connect, fund, deposit,
// prove and withdraw in each kind of pool. Nothing here reaches the service except its
// Electrum view and its faucet: the browser does the rest.
//   APP_URL=... FULCRUM_URL=... tsx test/ui.ts       (the app and the service running)
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, encodeCashAddress, encodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import { playwright } from './lib/browser';
import { signP2pkh } from './lib/sign';
import { DEVNET_ACCOUNT_KEY_HEX } from '../web/src/devnet-account';

const { chromium } = await playwright();

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:8787/';
// The devnet's chain is the service's Electrum WebSocket, which the page reads directly, and its
// HTTP endpoint, which this test reads to check the page's work.
const SERVICE_URL = (process.env.SERVICE_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const DEVNET_WS = process.env.DEVNET_FULCRUM_URL ?? SERVICE_URL.replace(/^http/, 'ws');
const FULCRUM_URL = process.env.FULCRUM_URL;
const SHOTS = process.env.SHOTS;
// The devnet's faucet, which the page asks at its service, on the host and port of its chain.
const DEVNET_FAUCET = `${new URL(DEVNET_WS.replace(/^ws/i, 'http')).origin}/faucet`;
// The servers the user or the deployment chose, and nothing else.
const ALLOWED = [FULCRUM_URL, process.env.ARCHIVE_URL, DEVNET_FAUCET].filter((url): url is string => Boolean(url));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP_URL).origin });
const page = await context.newPage();
const errors: string[] = [];
/** The paths under /api this app was asked for, in order. */
const apiCalls: string[] = [];
const foreign: string[] = [];
page.on('request', (request: any) => {
  // The liveness check below deliberately probes a dead server.
  if (request.url().startsWith('ws://127.0.0.1:1')) return;
  const url = new URL(request.url());
  if (url.origin === new URL(APP_URL).origin && url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
  if (url.origin !== new URL(APP_URL).origin && !ALLOWED.some((origin) => url.href.startsWith(origin))) foreign.push(url.href);
});
page.on('pageerror', (error: Error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message: any) => {
  if (message.type() !== 'error') return;
  if (/127\.0\.0\.1:1/.test(message.text())) return; // the intentional dead-server probe
  errors.push(`console: ${message.text()}`);
  console.log('browser error:', message.text().slice(0, 300));
});
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(`assert: ${message}`); };

// A relay floor some server's nodes ask, played on the page's own connection to the chain. A
// route only takes connections opened after it, so it is in place before the page opens one,
// and passes everything through until a test sets a floor.
const relay: { floor?: number; raised: boolean } = { raised: false };
await page.routeWebSocket((url: URL) => url.href.replace(/\/+$/, '') === DEVNET_WS.replace(/\/+$/, ''), (ws: any) => {
  const server = ws.connectToServer();
  const broadcasts = new Set<unknown>();
  ws.onMessage((message: string) => {
    const request = JSON.parse(String(message));
    if (relay.floor !== undefined && request.method === 'blockchain.relayfee') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: relay.raised ? relay.floor : 0.00001 }));
      return;
    }
    if (relay.floor !== undefined && request.method === 'blockchain.transaction.broadcast') broadcasts.add(request.id);
    server.send(message);
  });
  server.onMessage((message: string) => {
    const response = JSON.parse(String(message));
    // The floor rises once a broadcast has gone through at the old one.
    if (broadcasts.delete(response.id)) relay.raised = true;
    ws.send(message);
  });
});
// The ledger starts as a skeleton in the page's own HTML, so it is never empty while the first read runs.
const served = await (await fetch(APP_URL)).text();
assert(/class="pool-tile pool-skeleton"/.test(served) && /id="pools" aria-busy="true"/.test(served),
  'the page as served shows a skeleton of the ledger');
await page.goto(APP_URL, { waitUntil: 'load' });

// Nothing can be used until the terms are accepted, and nothing else closes them.
await page.waitForSelector('#termsGate:not(.hidden)');
const held = () => page.$eval('header', (el: HTMLElement) => el.inert);
assert(await held(), 'the terms hold the page');
await page.keyboard.press('Escape');
await page.mouse.click(3, 3);
assert(await page.isVisible('#termsGate'), 'Escape and the backdrop do not dismiss the terms');
assert(await page.isDisabled('#termsAccept'), 'accepting takes the check mark');
await page.check('#termsAgree');
await page.uncheck('#termsAgree');
assert(await page.isDisabled('#termsAccept'), 'clearing the check mark takes it back');
await page.check('#termsAgree');
await page.click('#termsAccept');
assert(await page.isHidden('#termsGate') && !(await held()), 'accepting lets the page go');

// New terms ask again.
await page.evaluate(() => localStorage.setItem('pools.termsAccepted', 'an older version'));
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('#termsGate:not(.hidden)');
assert(await page.isDisabled('#termsAccept'), 'new terms start without the check mark');
await page.check('#termsAgree');
await page.click('#termsAccept');

if (FULCRUM_URL) await page.evaluate((url: string) => localStorage.setItem('pools.fulcrumEndpoint', url), FULCRUM_URL);
await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.pool-tile-head[data-symbol="BCH"]', { timeout: 120_000 });
await page.waitForFunction(() => document.querySelector('.dot.ok'), null, { timeout: 120_000 });
assert((await page.textContent('#dataSource')) === 'Trustless', 'the first paint reads the chain itself: Trustless is the default');
assert(await page.$('#pools .pool-skeleton') === null && (await page.getAttribute('#pools', 'aria-busy')) === 'false',
  'the skeleton gives way to the pools once they are read');
assert(apiCalls.length === 0, `a first visit asks this app's /api for nothing (${apiCalls.join(', ')})`);
await page.click('#dataSource');
await page.waitForSelector('#settingsModal:not(.hidden)');
const focusedSource = await page.evaluate(() => {
  const el = document.activeElement as HTMLInputElement | null;
  return { name: el?.getAttribute('name'), value: el?.value };
});
assert(focusedSource.name === 'dataSource' && focusedSource.value === 'trustless',
  'the source badge opens Settings at the selected source');
await page.click('details.advanced summary');
const endpoints = {
  indexer: await page.inputValue('#indexerServer'),
  chain: await page.inputValue('#fulcrumServer'),
  withdrawal: await page.inputValue('#broadcastServer'),
};
assert(endpoints.indexer === '__app', 'the app indexer is selected by default');
assert((await page.textContent('#indexerHint'))?.includes('/api/indexer'), 'its endpoint is shown');
assert(await page.isHidden('#indexerEndpoint'), 'the custom indexer field starts hidden');
assert(endpoints.chain === DEVNET_WS, `the chain server is the service's WebSocket: ${endpoints.chain}`);
assert(endpoints.withdrawal === DEVNET_WS, 'the devnet has one server, selected explicitly');
assert(await page.isVisible('#withdrawalWarn'), 'using one server for both sides warns about privacy');
assert(!(await page.$('#fulcrumServer option[value="wss://electrum.imaginary.cash:50004"]')),
  'servers from other chains are not offered on the devnet');
assert(!(await page.isVisible('#fulcrumEndpoint')) && !(await page.isVisible('#broadcastEndpoint')),
  'known servers do not show the custom fields');
await page.check('input[name="network"][value="mainnet"]');
assert((await page.inputValue('#broadcastServer')) === 'wss://electroncash.dk:50004',
  'mainnet defaults to a second server for withdrawals');
assert(await page.isHidden('#withdrawalWarn'), 'a different second server shows no warning');
assert(!(await page.$('#fulcrumServer option[value="wss://chipnet.bch.ninja:50004"]')),
  'chipnet servers are not offered on mainnet');
await page.selectOption('#broadcastServer', '__same');
assert(await page.isVisible('#withdrawalWarn'), 'choosing the same server warns about privacy');
await page.check('input[name="network"][value="devnet"]');
await page.selectOption('#indexerServer', '__custom');
assert(await page.isVisible('#indexerEndpoint'), 'choosing a custom indexer shows its field');
await page.fill('#indexerEndpoint', '/api/indexer');
await page.selectOption('#fulcrumServer', '__custom');
assert(await page.isVisible('#fulcrumEndpoint'), 'choosing a custom server shows its field');
await page.fill('#fulcrumEndpoint', 'ws://127.0.0.1:1');
await page.click('#settingsSave');
await page.waitForFunction(() => /did not answer/.test(document.getElementById('settingsStatus')?.textContent ?? ''), null, { timeout: 15_000 });
assert(!(await page.isHidden('#settingsModal')), 'a dead server is not accepted');
await page.selectOption('#fulcrumServer', DEVNET_WS);
await page.click('#settingsSave');
await page.waitForFunction(() => /Saved in this browser/.test(document.getElementById('settingsStatus')?.textContent ?? ''), null, { timeout: 15_000 });
const savedServers = await page.evaluate(() => ({
  indexer: localStorage.getItem('pools.indexerUrl.devnet'),
  chain: localStorage.getItem('pools.fulcrumEndpoint.devnet'),
  withdrawal: localStorage.getItem('pools.broadcastEndpoint.devnet'),
}));
assert(savedServers.indexer === '/api/indexer'
  && savedServers.chain === DEVNET_WS && savedServers.withdrawal === DEVNET_WS,
  `selected servers are stored: ${JSON.stringify(savedServers)}`);
await page.keyboard.press('Escape');
assert(await page.isHidden('#settingsModal'), 'Escape closes Settings opened from the source badge');
// What follows reads the fast indexer, as a person may choose it in Settings, until the switch back
// to Trustless further down.
await page.click('#dataSource');
await page.waitForSelector('#settingsModal:not(.hidden)');
await page.check('input[name="dataSource"][value="indexer"]');
await page.click('#settingsSave');
await page.waitForFunction(() => document.getElementById('dataSource')?.textContent === 'Fast indexer', null, { timeout: 120_000 });
await page.waitForSelector('.pool-tile-head[data-symbol="BCH"]', { timeout: 120_000 });
assert(apiCalls.includes('/api/config'), 'choosing the fast indexer asks /api/config');
assert(await page.isHidden('#termsGate'), 'accepted terms are not asked again');
await page.click('#termsBtn');
assert(await page.isVisible('[data-close="termsModal"]') && !(await held()), 'the footer shows the terms to read');
await page.keyboard.press('Escape');
assert(await page.isHidden('#termsModal'), 'Escape closes the terms once accepted');
assert(/devnet/.test((await page.textContent('#networkPill')) ?? ''), 'the local chain says it is the devnet');
assert(await page.isHidden('#assetsList'), 'the wallet section starts collapsed');
await page.click('#walletToggle');
assert(await page.isVisible('#assetsList'), 'the wallet section expands on click');
assert((await page.getAttribute('#walletToggle', 'aria-expanded')) === 'true', 'and says it is open');
await page.click('#walletToggle');
assert(await page.isHidden('#assetsList'), 'the wallet section collapses again');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/home.png`, fullPage: true });

await page.click('.pool-tile-head[data-symbol="BCH"]');
await page.waitForSelector('#poolModal:not(.hidden)');
await page.click('#poolModal .pool[data-pool="bch"]');
await page.click('#depositBtn');
await page.click('#connectLocal');
await page.waitForSelector('#accountModal:not(.hidden)');
const address = (await page.textContent('#accountAddress')) ?? '';
assert(address.startsWith('bchtest:'), 'local account address');
const ownTokenForm = encodeCashAddress({
  prefix: 'bchtest', type: 'p2pkhWithTokens', payload: (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode.subarray(3, 23),
}).address;
assert(await page.isVisible('#addressSwitch'), 'the wallet offers both address forms');
await page.click('#addressSwitch');
assert((await page.textContent('#accountAddress')) === ownTokenForm, 'the rotate icon shows the token address');
await page.click('#addressSwitch');
assert((await page.textContent('#accountAddress')) === address, 'and returns to the cash address');
await page.click('#faucetBtn');
await page.waitForFunction(() => /USDT/.test(document.getElementById('accountAssets')?.textContent ?? ''), null, { timeout: 60_000 });
console.log('funded', (await page.textContent('#accountAssets'))?.replace(/\s+/g, ' ').trim());
await page.click('[data-close="accountModal"]');

const status = () => page.textContent('#status');
/** The connected wallet's satoshis, asked of the local chain's Electrum view from here, not the page. */
const walletSatoshis = async (): Promise<number> => {
  const lock = (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
  const response = await fetch(`${SERVICE_URL}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.scripthash.listunspent', params: [binToHex(sha256.hash(lock).reverse())] }),
  });
  const { result } = await response.json() as { result: Array<{ value: number }> };
  return result.reduce((sum, coin) => sum + coin.value, 0);
};
const randomKeyHash = () => crypto.getRandomValues(new Uint8Array(20));
const plainAddress = () => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: randomKeyHash() }).address;
const tokenAddress = () => encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: randomKeyHash() }).address;
const mainnetAddress = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: randomKeyHash() }).address;
const statusIs = (pattern: RegExp) => page.waitForFunction((source: string) => new RegExp(source).test(document.getElementById('status')?.textContent ?? ''), pattern.source, { timeout: 30_000 });
const interval = setInterval(() => { void status().then((text: string | null) => console.log('status:', text?.slice(0, 120))).catch(() => {}); }, 20_000);
/**
 * A deposit and its withdrawal. With `floor`, the server says its node relays only that many BCH
 * per 1,000 bytes from the moment the deposit has left, more than the pool prepaid for its last
 * step and for the withdrawal: the page must offer each, and take each from the wallet once asked.
 */
const runPool = async (poolId: string, recipient: string, { floor }: { floor?: number } = {}) => {
  if (!(await page.$(`#poolModal:not(.hidden) .pool[data-pool="${poolId}"]`))) {
    if (!(await page.isHidden('#poolModal'))) await page.keyboard.press('Escape');
    await page.click(`.pool-tile-head[data-symbol="${poolId.toUpperCase()}"]`);
    await page.waitForSelector(`#poolModal:not(.hidden) .pool[data-pool="${poolId}"]`);
  }
  if (!(await page.$(`#poolModal .pool[data-pool="${poolId}"][aria-expanded="true"]`))) {
    await page.click(`#poolModal .pool[data-pool="${poolId}"]`);
  }
  await page.waitForFunction(() => (document.getElementById('depositSummary')?.textContent ?? '').length > 0);
  await page.click('#depositBtn');
  await page.waitForSelector('#noteModal:not(.hidden)');
  assert(await page.$eval('footer', (el: HTMLElement) => el.inert), 'nothing behind an unsaved note can be reached');
  const note = (await page.textContent('#depositOut .note')) ?? '';
  // A note names its network and its pool's kind and category, so it withdraws on any page.
  assert(/^bchnote-devnet-(bch|token)-[0-9a-f]{64}-/.test(note), `${poolId} note: ${note.slice(0, 40)}`);
  // Nothing goes out until the note is saved, and saved means something happened.
  await page.keyboard.press('Escape');
  assert(!(await page.$eval('#noteModal', (el: Element) => el.classList.contains('hidden'))), 'Escape does not dismiss an unsaved note');
  assert(await page.$eval('#noteDone', (el: HTMLButtonElement) => el.disabled), 'the deposit waits for a saved note');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/note-${poolId}.png` });
  if (poolId === 'bch') {
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#noteDownload')]);
    assert(readFileSync(await download.path(), 'utf8').trim() === note, 'the download holds the note');
  } else {
    await page.click('#noteCopy');
    assert((await page.evaluate(() => navigator.clipboard.readText())) === note, 'the clipboard holds the note');
  }
  if (floor) Object.assign(relay, { floor, raised: false });
  await page.click('#noteDone');
  const settled = () => page.waitForFunction(() => /in the pool|Nothing was sent|may have gone through/.test(document.getElementById('noteTitle')?.textContent ?? ''), null, { timeout: 300_000 });
  await settled();
  const title = await page.textContent('#noteTitle');
  assert(title?.includes('Your deposit is in the pool'), `${poolId} deposit: ${title}: ${await page.textContent('#noteStatus')}`);
  if (floor) {
    assert(/needs more network fee than the deposit prepaid/.test(await page.textContent('#noteStatus') ?? ''),
      'a deposit whose last step now waits on a fee says so');
  }
  assert((await page.textContent('#depositOut .note')) === note, 'the note stays on screen until the deposit is settled');
  await page.click('#noteDone');
  assert(await page.$eval('#noteModal', (el: Element) => el.classList.contains('hidden')), 'Done closes it');
  console.log(`${poolId} deposited`);

  await page.fill('#note', note);
  assert((await page.inputValue('#recipient')) === '', 'nothing fills in the recipient');
  for (const own of [address, ownTokenForm]) {
    await page.fill('#recipient', own);
    assert(!(await page.$eval('#withdrawBtn', (el: HTMLButtonElement) => el.disabled)),
      `the devnet allows paying the connected wallet: ${own}`);
    assert(await page.isVisible('#recipientWarn'), 'and it says what that means');
  }
  await page.fill('#recipient', mainnetAddress);
  await page.click('#withdrawBtn');
  await statusIs(/another network/);
  if (poolId === 'usdt') {
    await page.fill('#recipient', plainAddress());
    await page.click('#withdrawBtn');
    await statusIs(/token-aware/);
  }
  await page.fill('#recipient', recipient);
  let walletBefore = 0;
  let paidHashing = 0;
  if (floor) {
    const statusMatches = (pattern: RegExp) => page.waitForFunction((source: string) => new RegExp(source).test(document.getElementById('status')?.textContent ?? ''), pattern.source, { timeout: 300_000 });
    await page.click('#withdrawBtn');
    await statusMatches(/still being added to the pool/);
    assert(await page.isVisible('#feeOffer') && /tied to your deposit/.test(await page.textContent('#feeOfferText') ?? ''),
      'a withdrawal whose note still waits on its last step stops, and offers that step to the wallet that deposited');
    const beforeHashing = await walletSatoshis();
    await page.click('#feeOfferBtn');
    await statusMatches(/in the pool now/);
    paidHashing = beforeHashing - await walletSatoshis();
    assert(await page.isHidden('#feeOffer') && paidHashing > 0 && paidHashing < 300_000, `that wallet paid ${paidHashing} sat to add the note`);
    await page.click('#withdrawBtn');
    await statusMatches(/for this withdrawal than its pool prepaid/);
    assert(await page.isVisible('#feeOffer') && /coin shows in the withdrawal/.test(await page.textContent('#feeOfferText') ?? ''),
      'then the withdrawal stops, and offers the connected wallet for its own fee, saying what that shows');
    walletBefore = await walletSatoshis();
    await page.click('#feeOfferBtn');
  } else {
    await page.click('#withdrawBtn');
  }
  await page.waitForFunction(() => /Withdrawal sent/.test(document.getElementById('status')?.textContent ?? '') || document.getElementById('status')?.classList.contains('err') && !/another network|token-aware/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 300_000 });
  const finished = await status();
  assert(finished?.includes('Withdrawal sent'), `${poolId} withdrawal: ${finished}`);
  assert((await page.inputValue('#recipient')) === '', 'a finished withdrawal clears its recipient');
  assert((await page.inputValue('#note')) === note, 'a finished withdrawal keeps its note: the page has only a server\'s word');
  const out = (await page.textContent('#withdrawOut'))?.replace(/\s+/g, ' ') ?? '';
  const size = Number(/Transaction size: (\d+) bytes/.exec(out)?.[1] ?? 0);
  assert(size > 30_000 && size < 100_000, `${poolId} withdrawal is a proof transaction of ${size} B`);
  if (floor) {
    relay.floor = undefined;
    const paid = walletBefore - await walletSatoshis();
    assert(await page.isHidden('#feeOffer') && paid > 0 && paid < 100_000, `the connected wallet paid ${paid} sat of its fee`);
    // One of its coins pays the fee alone, so paying it was one step, which this account signed.
    const feeSteps = await page.$$eval('#feeSteps .flow-step', (items) => items.map((item) => [
      (item.querySelector('.flow-step-title')?.textContent ?? '').replace(/^Step \d+ of \d+: /, ''), (item as HTMLElement).dataset.state,
    ].join(': ')));
    assert(await page.isVisible('#feeSteps') && feeSteps.join(' / ') === 'Pay the network fee of a private withdrawal: done',
      `the fee's step shows, done: ${feeSteps.join(' / ')}`);
    console.log(`${poolId} withdrawn at a relay floor of ${floor} BCH/kB, ${size} B, the wallet paying ${paidHashing} sat to add the note and ${paid} to withdraw it`);
  }
  console.log(`${poolId} withdrawn, ${size} B`);
};

await runPool('bch', plainAddress());
await runPool('usdt', tokenAddress());
// The devnet also allows sending the withdrawal back to the connected wallet.
await runPool('bch', address);
// Nodes asking 2 sat/B: the connected wallet, offered, pays what the pool did not prepay.
await runPool('bch', plainAddress(), { floor: 0.00002 });

await page.waitForFunction(() => /USDT\s*0 deposits · \d+ paid out/.test((document.getElementById('pools')?.textContent ?? '').replace(/\s+/g, ' ')), null, { timeout: 30_000 });
const ledger = (await page.textContent('#pools'))?.replace(/\s+/g, ' ').trim();
console.log('ledger', ledger);

// A flow of several transactions lists them as steps: done, under way, to come. This records each
// change of a flow's list, as a person would read it, from now on.
type StepSnapshot = {
  role: string | null; live: string | null;
  steps: Array<{ title: string; state?: string; current: string | null; note: string }>;
};
const watchSteps = (selector: string) => page.evaluate((flowSelector: string) => {
  const flow = document.querySelector(flowSelector) as HTMLElement;
  const seen: unknown[] = [];
  (window as any).__steps = seen;
  new MutationObserver(() => seen.push({
    role: flow.getAttribute('role'), live: flow.getAttribute('aria-live'),
    steps: Array.from(flow.querySelectorAll('.flow-step')).map((item) => ({
      title: (item.querySelector('.flow-step-title')?.textContent ?? '').replace(/^Step \d+ of \d+: /, ''),
      state: (item as HTMLElement).dataset.state, current: item.getAttribute('aria-current'),
      note: item.querySelector('.flow-step-note')?.textContent ?? '',
    })),
  })).observe(flow, { subtree: true, childList: true, characterData: true, attributes: true });
}, selector);
const seenSteps = () => page.evaluate(() => (window as any).__steps) as Promise<StepSnapshot[]>;
/** A creation through the dialog in `scope` is over: its button closes the dialog, or it failed. */
const creationOver = (scope: string) => page.waitForFunction((selector: string) => {
  const button = document.querySelector(`${selector} #createPoolConfirm`);
  return button?.textContent === 'Done' || /\berr\b/.test(document.querySelector(`${selector} #createPoolStatus`)?.className ?? '');
}, scope, { timeout: 240_000 });
const SEED_STEP = 'Prepare the one-unit token coin for the new pool';
const PREP_STEP = 'Create the coin that names the new pool';
const CREATE_STEP = 'Create the new pool through its factory';
const APPEAR_STEP = 'Wait for the pool to appear';
/** The creation's steps came in order, one at a time, and ended done; this browser's account was never asked to approve. */
const checkSteps = (label: string, seen: StepSnapshot[], expected: string[]) => {
  assert(seen.length > 0 && seen.every((snapshot) => snapshot.role === 'status' && snapshot.live === 'polite'),
    `${label}: the steps are drawn, and announced as they change`);
  const last = seen.at(-1)!;
  const titles = last.steps.filter((step) => step.state !== 'skipped').map((step) => step.title);
  // The shared coins' top-up, and gathering coins for the prep, come only when needed.
  const needed = titles.filter((title) => !/^(Add the hashing|Gather the coins)/.test(title));
  assert(needed.join(' / ') === [...expected, APPEAR_STEP].join(' / '), `${label}: the steps, in order: ${titles.join(' / ')}`);
  assert(last.steps.every((step) => step.state === 'done' || step.state === 'skipped') && last.steps.at(-1)?.note === 'Listed',
    `${label}: every step ends done, and the pool is listed: ${JSON.stringify(last.steps)}`);
  const order = seen.flatMap((snapshot) => snapshot.steps.filter((step) => step.state === 'current').map((step) => step.title))
    .filter((title, index, all) => all[index - 1] !== title);
  assert(order.every((title, index) => index === 0 || titles.indexOf(title) > titles.indexOf(order[index - 1]))
    && order.includes(CREATE_STEP) && order.at(-1) === APPEAR_STEP, `${label}: one step at a time, in that order: ${order.join(' / ')}`);
  assert(seen.some((snapshot) => snapshot.steps.some((step) => step.state === 'current' && step.current === 'step')),
    `${label}: the step under way is marked current`);
  const notes = seen.flatMap((snapshot) => snapshot.steps.map((step) => step.note));
  assert(!notes.some((note) => /Open your wallet|Needs your approval/.test(note)) && notes.some((note) => /No approval needed/.test(note)),
    `${label}: this browser's account is never asked to approve, and the steps say so`);
};

// A pool this browser makes is not in the indexer; it must still be read from the chain and usable.
await page.click('#addPoolBtn');
await page.waitForFunction(() => !!document.querySelector('#addPoolBody .add-asset[data-add-asset]'), null, { timeout: 120_000 });
await page.locator('#addPoolBody .add-asset', { hasText: 'USDC' }).first().click();
await page.waitForSelector('#addPoolBody .add-pool-form:not(.hidden)');
await page.selectOption('#addPoolBody #poolDenomination', { label: '1 USDC' });
await watchSteps('#addPoolBody #createPoolProgress');
await page.click('#addPoolBody #createPoolConfirm');
await creationOver('#addPoolBody');
const usdcOutcome = await page.textContent('#addPoolBody #createPoolStatus');
assert(/pool is ready/.test(usdcOutcome ?? ''), `the USDC pool is created: ${usdcOutcome}`);
checkSteps('USDC', await seenSteps(), [SEED_STEP, PREP_STEP, CREATE_STEP]);
await page.click('#addPoolBody #createPoolConfirm');
assert(await page.isHidden('#addPoolModal'), 'Done closes the dialog');
assert(/New pool created/.test(await status() ?? '') && await page.isVisible('#statusBar'), 'the created pool leaves a message');
await page.click('#statusBar');
assert(await page.isHidden('#statusBar'), 'clicking the message dismisses it');
await page.waitForSelector('.pool-tile-head[data-symbol="USDC"]', { timeout: 120_000 });
await page.click('.pool-tile-head[data-symbol="USDC"]');
await page.waitForSelector('#poolModal:not(.hidden)');
await page.waitForFunction(() => {
  const row = Array.from(document.querySelectorAll('#poolModalBody .pool-denom-main'))
    .find((entry) => /1 USDC/.test(entry.textContent ?? ''));
  return row?.querySelector('button')?.disabled === false;
}, null, { timeout: 120_000 });
const created = await page.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#poolModalBody .pool-denom-main'))
    .find((entry) => /1 USDC/.test(entry.textContent ?? ''));
  const button = row?.querySelector('button') as HTMLButtonElement | null | undefined;
  return { text: row?.textContent?.replace(/\s+/g, ' ').trim(), disabled: button?.disabled };
});
assert(created.text?.includes('0 deposits') && created.disabled === false, `a new pool is checked on chain: ${created.text}`);
await page.keyboard.press('Escape');

// A BCH pool, from the wallet's own list: the same steps, in the dialog that opens there.
await page.click('#walletToggle');
await page.waitForSelector('#assetsList [data-create="bch"]:not([disabled])', { timeout: 60_000 });
await page.click('#assetsList [data-create="bch"]');
await page.waitForSelector('#createPoolModal:not(.hidden) #createPoolBody #createPoolConfirm');
await watchSteps('#createPoolBody #createPoolProgress');
await page.click('#createPoolBody #createPoolConfirm');
assert(await page.isHidden('#createPoolModal [data-close]'), 'a creation under way holds its dialog open');
await creationOver('#createPoolBody');
const bchOutcome = await page.textContent('#createPoolBody #createPoolStatus');
assert(/pool is ready/.test(bchOutcome ?? ''), `the BCH pool is created: ${bchOutcome}`);
checkSteps('BCH', await seenSteps(), [PREP_STEP, CREATE_STEP]);
await page.click('#createPoolBody #createPoolConfirm');
assert(await page.isHidden('#createPoolModal'), 'Done closes the dialog');
await page.click('#walletToggle');

// ---- a token deposit whose coin is made first ----
// The account's USDT is split so that no coin of it is one a deposit takes: two coins of half the
// pool's amount, and the rest on a coin of 2,000 sat, more than a deposit's coin may hold. The pool's
// dialog offers to make the coin before any note is shown, and the deposit then goes through.
const electrum = async (method: string, params: unknown[]): Promise<any> => {
  const response = await fetch(`${SERVICE_URL}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
};
const usdtAsset = ((await page.getAttribute('.pool-tile-head[data-symbol="USDT"]', 'data-asset')) ?? '').replace(/^token:/, '');
const accountLock = (cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode;
type Listed = { tx_hash: string; tx_pos: number; value: number; token_data?: { category: string; amount: string; nft?: unknown } };
const listed = await electrum('blockchain.scripthash.listunspent', [binToHex(sha256.hash(accountLock).reverse())]) as Listed[];
const usdtCoins = listed.filter((coin) => coin.token_data?.category === usdtAsset && !coin.token_data.nft);
const feeCoin = listed.filter((coin) => !coin.token_data).sort((a, b) => b.value - a.value)[0];
const usdtHeld = usdtCoins.reduce((sum, coin) => sum + BigInt(coin.token_data!.amount), 0n);
const USDT_AMOUNT = 1_000_000n;
assert(usdtHeld >= 2n * USDT_AMOUNT && feeCoin !== undefined, `the account holds ${usdtHeld} USDT units to split, and a plain coin`);
const splitInputs = [...usdtCoins, feeCoin].map((coin) => ({
  outpointTransactionHash: hexToBin(coin.tx_hash), outpointIndex: coin.tx_pos, sequenceNumber: 0xffffffff, unlockingBytecode: Uint8Array.of(),
}));
const splitSources = [...usdtCoins, feeCoin].map((coin, index) => ({
  ...splitInputs[index], lockingBytecode: accountLock, valueSatoshis: BigInt(coin.value),
  ...(coin.token_data ? { token: { category: hexToBin(coin.token_data.category), amount: BigInt(coin.token_data.amount) } } : {}),
}));
const usdtOutput = (amount: bigint, satoshis: bigint) => ({ lockingBytecode: accountLock, valueSatoshis: satoshis, token: { category: hexToBin(usdtAsset), amount } });
const devnetKey = hexToBin(DEVNET_ACCOUNT_KEY_HEX);
const split = (change: bigint) => {
  const transaction = {
    version: 2, locktime: 0, inputs: splitInputs,
    outputs: [
      usdtOutput(USDT_AMOUNT / 2n, 1_000n), usdtOutput(USDT_AMOUNT / 2n, 1_000n), usdtOutput(usdtHeld - USDT_AMOUNT, 2_000n),
      { lockingBytecode: accountLock, valueSatoshis: change },
    ],
  };
  return encodeTransaction({
    ...transaction, inputs: splitInputs.map((input, index) => ({ ...input, unlockingBytecode: signP2pkh(transaction, splitSources, index, devnetKey) })),
  });
};
// Its size does not depend on what its change holds, so it pays 1 sat/B exactly.
const left = splitSources.reduce((sum, source) => sum + source.valueSatoshis, 0n) - 4_000n;
await electrum('blockchain.transaction.broadcast', [binToHex(split(left - BigInt(split(left).length)))]);
// The page reads the wallet again as its section opens.
await page.click('#walletToggle');
await page.waitForFunction(() => !/Loading balances/.test(document.getElementById('accountAssets')?.textContent ?? ''), null, { timeout: 60_000 });
await page.click('#walletToggle');
await page.click('.pool-tile-head[data-symbol="USDT"]');
await page.waitForSelector('#poolModal:not(.hidden) .pool[data-pool="usdt"]');
await page.click('#poolModal .pool[data-pool="usdt"]');
await page.waitForSelector('#prepareCoinBtn:not(.hidden)', { timeout: 60_000 });
assert(await page.isHidden('#depositBtn') && /No single coin in your wallet can pay this deposit/.test(await page.textContent('#depositSummary') ?? ''),
  'a wallet whose USDT no coin can deposit alone is offered a coin made from its own, before any note');
await watchSteps('#prepareSteps');
await page.click('#prepareCoinBtn');
await page.waitForFunction(() => (document.getElementById('prepareStatus')?.textContent ?? '') !== '', null, { timeout: 120_000 });
const prepared = await page.textContent('#prepareStatus');
assert(/The coin is ready/.test(prepared ?? ''), `the coin is made: ${prepared}`);
const preparing = await seenSteps();
const PREPARE_STEP = 'Prepare a coin of exactly 10000 USDT for this deposit';
const DEPOSIT_STEP = 'Deposit 10000 USDT into a private pool — and pay the withdrawal fee in advance';
assert(preparing.at(-1)!.steps.map((step) => `${step.title}: ${step.state}`).join(' / ') === `${PREPARE_STEP}: done / ${DEPOSIT_STEP}: todo`,
  `its steps are making the coin, then the deposit to come: ${JSON.stringify(preparing.at(-1)!.steps)}`);
const preparingNotes = preparing.flatMap((snapshot) => snapshot.steps.map((step) => step.note));
assert(preparingNotes.some((note) => /No approval needed/.test(note)) && !preparingNotes.some((note) => /Open your wallet|Needs your approval/.test(note)),
  'and this browser\'s account is not asked to approve it');
assert(!(await page.isHidden('#depositBtn')) && await page.isHidden('#prepareCoinBtn'), 'once the coin is made, the deposit goes on');
await watchSteps('#noteSteps');
await page.click('#depositBtn');
await page.waitForSelector('#noteModal:not(.hidden)');
await page.click('#noteCopy');
await page.click('#noteDone');
await page.waitForFunction(() => /in the pool|Nothing was sent|may have gone through/.test(document.getElementById('noteTitle')?.textContent ?? ''), null, { timeout: 300_000 });
const madeTitle = await page.textContent('#noteTitle');
assert(madeTitle?.includes('Your deposit is in the pool'), `the deposit spends the coin made for it: ${madeTitle}: ${await page.textContent('#noteStatus')}`);
const depositing = (await seenSteps()).at(-1)!.steps;
assert(depositing[0]?.title === PREPARE_STEP && depositing.some((step) => step.title === DEPOSIT_STEP)
  && depositing.every((step) => step.state === 'done'), `the deposit's steps follow the coin's, and all end done: ${depositing.map((step) => step.title).join(' / ')}`);
await page.click('#noteDone');
console.log('usdt deposited from a coin made for it');

// The indexer paints first; switching to trustless catches up and caches the chain.
await page.click('#networkPill');
await page.waitForSelector('#settingsModal:not(.hidden)');
await page.check('input[name="dataSource"][value="trustless"]');
await page.click('#settingsSave');
await page.waitForFunction(() => document.getElementById('dataSource')?.textContent === 'Trustless', null, { timeout: 120_000 });
await page.waitForFunction(() => document.getElementById('syncStatus')?.classList.contains('hidden'), null, { timeout: 120_000 });
// The cache lands when the chain read finishes; poll instead of assuming a fixed delay.
const cached = await page.evaluate(`(async () => {
  const hasState = () => new Promise((resolve) => {
    const request = indexedDB.open('pools-trustless-cache', 1);
    request.onsuccess = () => {
      const keys = request.result.transaction('records', 'readonly').objectStore('records').getAllKeys();
      keys.onsuccess = () => resolve(keys.result.some((key) => String(key).startsWith('state:')));
      keys.onerror = () => resolve(false);
    };
    request.onerror = () => resolve(false);
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await hasState()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
})()`) as boolean;
assert(cached, 'trustless state is cached in IndexedDB');
if (SHOTS) await page.screenshot({ path: `${SHOTS}/after.png`, fullPage: true });

// Trustless asks this app's /api for nothing: its settings come with the page and the devnet's faucet
// is its service's. From a reload on, through the catch-up, the faucet and a switch to another network
// and back, no path of this app under /api is asked for.
const trustlessFrom = apiCalls.length;
// Any chain server but the devnet's is a stand-in that takes the connection and never answers, so the
// switch reaches no public server.
await page.routeWebSocket((url: URL) => url.href.replace(/\/+$/, '') !== DEVNET_WS.replace(/\/+$/, '')
  && url.host !== new URL(APP_URL).host, () => {});
/** The devnet read trustless and caught up: its pools on screen, the catch-up done, the chain answering. */
const caughtUp = () => page.waitForFunction(() => document.querySelector('.pool-tile-head[data-symbol="BCH"]') !== null
  && document.getElementById('dataSource')?.textContent === 'Trustless'
  && document.getElementById('syncStatus')?.classList.contains('hidden') === true
  && document.querySelector('#networkPill .dot.ok') !== null, null, { timeout: 120_000 });
await page.reload({ waitUntil: 'load' });
await caughtUp();
await page.click('#connect');
await page.click('#connectLocal');
await page.waitForSelector('#accountModal:not(.hidden)');
assert(await page.isVisible('#faucetBtn'), 'a Trustless devnet page offers its faucet');
const unfunded = await walletSatoshis();
await page.click('#faucetBtn');
await page.waitForFunction(() => {
  const button = document.getElementById('faucetBtn') as HTMLButtonElement | null;
  return button !== null && !button.disabled && button.textContent === 'Get test funds';
}, null, { timeout: 60_000 });
const funded = await walletSatoshis();
assert(funded > unfunded && !(await page.$('#accountAssets .err')),
  `the faucet funds the wallet (${unfunded} to ${funded} sat): ${(await page.textContent('#accountAssets'))?.replace(/\s+/g, ' ').trim()}`);
await page.click('[data-close="accountModal"]');
for (const network of ['chipnet', 'devnet']) {
  await page.click('#networkPill');
  await page.waitForSelector('#settingsModal:not(.hidden)');
  await page.check(`input[name="network"][value="${network}"]`);
  await page.click('#settingsSave');
  await page.waitForFunction((name: string) => (document.getElementById('networkPill')?.textContent ?? '').includes(name),
    network, { timeout: 30_000 });
}
await caughtUp();
const trustlessApi = apiCalls.slice(trustlessFrom);
assert(trustlessApi.length === 0, `a Trustless page asked this app for ${trustlessApi.join(', ')}`);
console.log('trustless: no request to this app\'s /api through a reload, the faucet and a network switch and back');
assert(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
assert(foreign.length === 0, `third-party requests: ${foreign.slice(0, 3).join(' ')}`);
for (const route of ['/api/state', '/api/deposit', '/api/withdraw', '/api/wallet', '/api/fulcrum']) assert(!apiCalls.includes(route), `${route} must not exist`);

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
const response = await mobile.goto(APP_URL, { waitUntil: 'load' });
await mobile.waitForSelector('#termsGate:not(.hidden)', { timeout: 60_000 });
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert(overflow === 0, `horizontal overflow at 390px: ${overflow}`);

// A missed escape must not become a script.
const policy = response.headers()['content-security-policy'] ?? '';
assert(/script-src[^;]*'nonce-/.test(policy) && !/script-src[^;]*'unsafe-inline'/.test(policy), `script policy: ${policy}`);
const ran = await mobile.evaluate(async () => {
  const injected = document.createElement('div');
  injected.innerHTML = '<img src="/no-such-image" onerror="window.__ran = true">';
  document.body.appendChild(injected);
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  return (window as any).__ran === true;
});
assert(!ran, 'an injected handler does not run');

// No request can stop the service.
if (process.env.ARCHIVE_URL) {
  const service = new URL(process.env.ARCHIVE_URL);
  await new Promise<void>((resolve) => {
    const socket = connect(Number(service.port), service.hostname, () => socket.end('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
    socket.resume();
  });
  assert((await fetch(`${service.origin}/health`)).ok, 'the service survives a request it cannot parse');
}
clearInterval(interval);
await browser.close();
console.log('UI PASS');
process.exit(0);
