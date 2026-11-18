// What the page shows across a network switch, in a real browser against the devnet: the pools of the
// network it left are not on screen while the next one is read, the servers a switch keeps are the
// next network's own, and a read begun before the switch that finishes after it does not bring the
// old pools back. The other network is a stand-in config the page is given, in its settings block and
// at /api/config, whose chain server never answers and which no request leaves this machine for.
//   APP_URL=... SERVICE_URL=... tsx test/ui-network.ts   (the app and the service running; test/app.ts runs it)
import { PAGE_SETTINGS_ID } from '../web/src/page-settings';
import { playwright } from './lib/browser';

const { chromium } = await playwright();

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:8787/';
const SERVICE_URL = (process.env.SERVICE_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const DEVNET_WS = (process.env.DEVNET_FULCRUM_URL ?? SERVICE_URL.replace(/^http/, 'ws')).replace(/\/+$/, '');
/** The app and its service: the only servers this page may reach. */
const reachable = [new URL(APP_URL).host, new URL(SERVICE_URL).host];

let failures = 0;
const check = (ok: unknown, label: string) => {
  if (!ok) failures += 1;
  console.log(ok ? 'ok      ' : 'FAILED  ', label);
};

const devnet = await (await fetch(new URL('/api/config?network=devnet', APP_URL))).json();
if (devnet.networkId !== 'devnet') throw new Error('The app serves no devnet: run it as test/app.ts does.');
/** Chipnet as the page is told of it: no indexer, no pools listed, and `factories` its own. */
const standIn = (factories: unknown) => ({
  ...devnet, network: 'chipnet', networkId: 'chipnet', networkLabel: 'chipnet', pools: [], factories,
  indexerUrl: undefined, fulcrumUrl: 'wss://chipnet.invalid:50004', broadcastUrl: 'wss://chipnet.invalid:50004',
  chain: 'bch:bchtest', addressPrefix: 'bchtest', localAccounts: false, faucetUrl: undefined,
});
// A page learns of chipnet when it loads: a Trustless page reads it from its HTML and asks nothing
// more. So the stand-in a part switches to is set before the page loads for it. The first part's
// factory is read through a server that never answers, so its read goes on for a while.
let chipnet: unknown = standIn({ bch: devnet.factories?.bch ?? 'ab'.repeat(32) });

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors: string[] = [];
page.on('pageerror', (error: Error) => errors.push(error.message));
// Nothing reaches any server but the app and its service: other requests are refused, and every other
// chain server, whether elsewhere or on this machine, is a stand-in that takes the connection and never
// answers.
await page.route((url: URL) => !reachable.includes(url.host), (route: any) => route.abort());
// Chipnet is the stand-in in the settings block of the page, which a Trustless page reads, and at
// /api/config, which a page that reads the indexer asks. The page itself is the app's, as served: a
// document Playwright served in its place would count as one from the internet, and Chromium's local
// network checks would then refuse it the devnet's service on this machine. So the stand-in is written
// into the page's own settings block as the parser adds it, before anything reads it, and the block is
// marked. The value is the one the latest init script set. Nothing in these scripts is a named
// function: tsx would wrap one in a helper the browser lacks.
await page.addInitScript((id: string) => {
  new MutationObserver((_records, observer) => {
    const element = document.getElementById(id);
    if (element === null) return;
    let page: any;
    // Until the parser has added all of its text, the block is not yet JSON: wait for the rest.
    try { page = JSON.parse(element.textContent ?? ''); } catch { return; }
    observer.disconnect();
    page.settings = { ...page.settings, chipnet: (window as any).chipnetStandIn };
    element.textContent = JSON.stringify(page);
    element.setAttribute('data-stand-in', '');
  }).observe(document, { childList: true, subtree: true, characterData: true });
}, PAGE_SETTINGS_ID);
const standInFrom = (value: unknown) => page.addInitScript((standIn: unknown) => { (window as any).chipnetStandIn = standIn; }, value);
await standInFrom(chipnet);
const pageLoads = { standIn: 0, missed: 0 };
/** Count a load of the page by whether its settings block took the stand-in. */
const counted = async () => {
  const marked = await page.evaluate((id: string) => document.getElementById(id)?.hasAttribute('data-stand-in') ?? false, PAGE_SETTINGS_ID);
  pageLoads[marked ? 'standIn' : 'missed'] += 1;
};
await page.route((url: URL) => url.pathname === '/api/config' && url.searchParams.get('network') === 'chipnet',
  (route: any) => route.fulfill({ json: chipnet }));
/** The devnet indexer's archive reads, held back while `holding`. */
let holding = false;
const held: Array<() => void> = [];
await page.route((url: URL) => url.pathname.startsWith('/api/indexer/archive/'), (route: any) => {
  if (holding) held.push(() => { void route.continue(); });
  else void route.continue();
});
await page.routeWebSocket(() => true, (ws: any) => {
  // The devnet's chain and the app's own socket go through; any other is the stand-in.
  if (ws.url().replace(/\/+$/, '') !== DEVNET_WS && new URL(ws.url()).host !== new URL(APP_URL).host) return;
  const server = ws.connectToServer();
  ws.onMessage((message: string) => server.send(message));
  server.onMessage((message: string) => ws.send(message));
});

const tiles = () => page.$$eval('.pool-tile-head', (heads: Element[]) => heads.length);
const poolsText = async () => (await page.textContent('#pools')) ?? '';
const listed = () => page.waitForFunction(() => document.querySelectorAll('.pool-tile-head').length > 0, null, { timeout: 120_000 });
const switchTo = async (network: string) => {
  await page.click('#networkPill');
  await page.waitForSelector('#settingsModal:not(.hidden)');
  await page.check(`input[name="network"][value="${network}"]`);
  await page.click('#settingsSave');
  await page.waitForFunction((name: string) => (document.getElementById('networkPill')?.textContent ?? '').toLowerCase().includes(name),
    network, { timeout: 30_000 });
};

await page.goto(APP_URL, { waitUntil: 'load' });
await counted();
await page.waitForSelector('#termsGate:not(.hidden)');
await page.check('#termsAgree');
await page.click('#termsAccept');
await page.evaluate(() => { localStorage.setItem('pools.network', 'devnet'); localStorage.setItem('pools.dataSource', 'indexer'); });
await page.reload({ waitUntil: 'load' });
await counted();
await listed();
// Its first paint reads each pool's archive by category from its service, which a deployment's ids must not stop.
check(await tiles() > 0 && (await page.textContent('#dataSource')) === 'Fast indexer', 'the devnet lists its pools, from its indexer');

// ---- while the next network is read ----
// Its factory is read through a server that never answers, so its read goes on for a while.
await switchTo('chipnet');
await page.waitForTimeout(1_500);
check(await tiles() === 0, `the devnet's pools are not on screen while chipnet is read (${await tiles()} tiles)`);

// ---- the servers a switch saves are those of the network switched to ----
// Settings offers each network's own servers, as the app names them for it, not a guess made on the
// network the page is on: this devnet's service is not on the service's usual port.
await switchTo('devnet');
const savedServers: Array<string | null> = await page.evaluate(() => [
  localStorage.getItem('pools.fulcrumEndpoint.devnet'), localStorage.getItem('pools.broadcastEndpoint.devnet'),
]);
check(savedServers.every((url) => url?.replace(/\/+$/, '') === DEVNET_WS),
  `switching to the devnet from chipnet keeps the devnet's own server for both sides (${savedServers.join(', ')})`);
// A pool read through it shows its deposits; one the page could not read says so instead.
const read = await page.waitForFunction(() => Array.from(document.querySelectorAll('.pool-tile-meta'))
  .some((meta) => /deposits/.test(meta.textContent ?? '')), null, { timeout: 60_000 }).then(() => true, () => false);
/** What the page shows of its read: its source, its pools, its catch-up and its last message. */
// No function inside is given a name: tsx would wrap a named one in a helper the browser lacks.
const shownRead = async (): Promise<string> => page.evaluate(() => {
  const [source, pools, sync, status] = ['dataSource', 'pools', 'syncText', 'status']
    .map((id) => (document.getElementById(id)?.textContent ?? '').replace(/\s+/g, ' ').trim());
  const syncing = !document.getElementById('syncStatus')?.classList.contains('hidden');
  return `${source}: ${pools || 'no pools'}${syncing ? `; ${sync}` : ''}${status ? `; "${status}"` : ''}`;
});
check(read, `and the devnet's pools are read through it (${await shownRead()})`);

// ---- a read begun before a switch, which finishes after it ----
// Back on the devnet, as a fresh page opens it, with a chipnet that lists nothing.
chipnet = standIn(null);
await standInFrom(chipnet);
await page.evaluate(() => { localStorage.setItem('pools.network', 'devnet'); localStorage.setItem('pools.dataSource', 'indexer'); });
await page.reload({ waitUntil: 'load' });
await counted();
await listed();
holding = true;
await page.click('#refreshBtn');
await page.waitForTimeout(500);
await switchTo('chipnet');
await page.waitForFunction(() => /No pools on chipnet/.test(document.getElementById('pools')?.textContent ?? ''), null, { timeout: 30_000 });
holding = false;
for (const release of held.splice(0)) release();
await page.waitForTimeout(2_000);
check(await tiles() === 0 && /No pools on chipnet/.test(await poolsText()),
  `a devnet read begun before the switch does not bring the devnet's pools back (${await tiles()} tiles)`);
check(errors.length === 0, `and the page raised no error (${errors.join('; ')})`);
check(pageLoads.standIn > 0 && pageLoads.missed === 0,
  `every load of the page held its settings, chipnet's the stand-in (${JSON.stringify(pageLoads)})`);

await browser.close();
console.log(failures === 0 ? 'PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
