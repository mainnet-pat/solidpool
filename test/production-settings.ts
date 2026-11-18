// What a production server refuses to start without (web/lib/deployment.ts, productionProblems).
//   tsx test/production-settings.ts
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { availableNetworks, configFor, defaultNetwork, productionProblems } from '../web/lib/deployment';
import { keptFor } from '../web/lib/kept';
import { pageSettings, settingsJson } from '../web/lib/page-config';
import { devnetFaucetUrl, devnetFulcrumUrl, serviceChainUrl } from '../web/lib/proxy';
import { builtSourceProblems, configuredFactories, configuredServers, serverProblems } from '../web/lib/settings-check';
import { networkFor } from '../web/src/page-settings';
import { reporter } from './lib/setup';

const { check, finish } = reporter();

/**
 * Each network's factories as the page's own copy of its deployment names them, or made-up ones while
 * it names none: production holds the settings to that copy, so once a network is deployed these are
 * its real factories, and the checks below hold either way.
 */
const factoriesOf = (network: 'mainnet' | 'chipnet', bch: string, token: string): { bch: string; token: string } => {
  const copy = JSON.parse(readFileSync(new URL(`../web/deployments/${network}.json`, import.meta.url), 'utf8'));
  return { bch: copy.factories?.bch ?? bch, token: copy.factories?.token ?? token };
};
const CHIPNET_FACTORIES = factoriesOf('chipnet', 'ab'.repeat(32), 'cd'.repeat(32));
const MAINNET_FACTORIES = factoriesOf('mainnet', '1a'.repeat(32), '2b'.repeat(32));
const FACTORY = CHIPNET_FACTORIES.bch;
const TOKEN = CHIPNET_FACTORIES.token;
/** A factory no copy names. */
const OTHER = 'ee'.repeat(32);
const PUBLIC = {
  POOL_NETWORK: 'chipnet',
  TRUSTLESS_FULCRUM_URL: 'wss://one.example.org:50004',
  TRUSTLESS_BROADCAST_URL: 'wss://two.example.org:50004',
  BCH_FACTORY: FACTORY,
  TOKEN_FACTORY: TOKEN,
  WALLETCONNECT_PROJECT_ID: '0123456789abcdef0123456789abcdef',
  SITE_URL: 'https://pools.example.org',
  SOURCE_URL: 'https://code.example.org/solidpool/tree/0123456789abcdef',
};
/** PUBLIC, opening on mainnet, with mainnet's factories under the bare names. */
const ON_MAINNET = { ...PUBLIC, POOL_NETWORK: 'mainnet', BCH_FACTORY: MAINNET_FACTORIES.bch, TOKEN_FACTORY: MAINNET_FACTORIES.token };
const refuses = (env: Record<string, string | undefined>, pattern: RegExp, label: string) => {
  const problems = productionProblems(env);
  check(problems.some((problem) => pattern.test(problem)), `${label}: ${problems.find((problem) => pattern.test(problem)) ?? problems.join(' | ') ?? 'nothing refused'}`);
};

// ---- a public deployment names everything ----
check(productionProblems(PUBLIC).length === 0, `a complete chipnet deployment starts (${productionProblems(PUBLIC).join(' | ')})`);
check(productionProblems(ON_MAINNET).length === 0, `and a complete mainnet one (${productionProblems(ON_MAINNET).join(' | ')})`);
check(productionProblems({ ...PUBLIC, INDEXER_URL: 'https://indexer.example.org' }).length === 0, 'with a public https indexer');
refuses({}, /Set POOL_NETWORK/, 'no settings at all');
refuses({ ...PUBLIC, POOL_NETWORK: undefined }, /Set POOL_NETWORK/, 'no network');
refuses({ ...PUBLIC, POOL_NETWORK: 'testnet4' }, /not "testnet4"/, 'an unknown network');
refuses({ ...PUBLIC, TRUSTLESS_FULCRUM_URL: undefined }, /Set CHIPNET_TRUSTLESS_FULCRUM_URL or TRUSTLESS_FULCRUM_URL/, 'no chain server');
refuses({ ...PUBLIC, TRUSTLESS_BROADCAST_URL: '  ' }, /Set CHIPNET_TRUSTLESS_BROADCAST_URL or TRUSTLESS_BROADCAST_URL/, 'a blank withdrawal server');
refuses({ ...PUBLIC, TRUSTLESS_BROADCAST_URL: PUBLIC.TRUSTLESS_FULCRUM_URL }, /same server/, 'one server for both sides');
refuses({ ...PUBLIC, TRUSTLESS_FULCRUM_URL: 'ws://one.example.org:50003' }, /wss:\/\//, 'a plain WebSocket');
refuses({ ...PUBLIC, MAINNET_TRUSTLESS_FULCRUM_URL: 'https://x.example.org' }, /MAINNET_TRUSTLESS_FULCRUM_URL must be a wss/, 'the other tab\'s server over https');
refuses({ ...PUBLIC, WALLETCONNECT_PROJECT_ID: undefined }, /Set WALLETCONNECT_PROJECT_ID/, 'no WalletConnect project');
refuses({ ...PUBLIC, WALLETCONNECT_PROJECT_ID: 'my-project' }, /32 hex/, 'a malformed WalletConnect project');
check(productionProblems({ ...PUBLIC, WALLETCONNECT_PROJECT_ID: undefined, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: PUBLIC.WALLETCONNECT_PROJECT_ID }).length === 0,
  'the public name of the WalletConnect setting counts too');

// ---- one server, however its URL is written ----
refuses({ ...PUBLIC, TRUSTLESS_BROADCAST_URL: 'wss://ONE.example.org:50004/' }, /same server/, 'one server for both sides, in capitals with a trailing slash');
refuses({ ...PUBLIC, TRUSTLESS_FULCRUM_URL: 'wss://one.example.org:443', TRUSTLESS_BROADCAST_URL: 'wss://one.example.org/' }, /same server/,
  'or with its default port written out');
check(productionProblems({ ...PUBLIC, TRUSTLESS_BROADCAST_URL: 'wss://one.example.org:50005' }).length === 0, 'another port is another server');

// ---- the WalletConnect project the check passes is the one the page is given ----
process.env.WALLETCONNECT_PROJECT_ID = '';
process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = PUBLIC.WALLETCONNECT_PROJECT_ID;
check(productionProblems({ ...PUBLIC, WALLETCONNECT_PROJECT_ID: '', NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: PUBLIC.WALLETCONNECT_PROJECT_ID }).length === 0
  && configFor('chipnet')?.walletConnectProjectId === PUBLIC.WALLETCONNECT_PROJECT_ID,
  `a blank WALLETCONNECT_PROJECT_ID gives way to its public name, in the check and in the page's config (${JSON.stringify(configFor('chipnet')?.walletConnectProjectId)})`);
delete process.env.WALLETCONNECT_PROJECT_ID;
delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// ---- a bundled factory is the same factory in any case ----
check(productionProblems(PUBLIC, { bundled: { chipnet: { factories: { bch: FACTORY.toUpperCase(), token: TOKEN } } } }).length === 0,
  'a bundled factory written in capitals matches BCH_FACTORY');
check(productionProblems(PUBLIC, { bundled: { chipnet: { factories: { bch: OTHER, token: TOKEN } } } }).some((problem) => /BCH_FACTORY names another factory/.test(problem)),
  'and another bundled factory does not');

// ---- POOL_NETWORK, read exactly as the server reads it ----
// A value the checks would trim but the server would not read as a network once let the server
// serve chipnet on a mainnet deployment's servers and factories.
for (const value of ['mainnet ', ' chipnet', 'mainnet\r', 'Mainnet', 'CHIPNET', 'local ']) {
  refuses({ ...PUBLIC, POOL_NETWORK: value }, /written exactly/, `POOL_NETWORK ${JSON.stringify(value)}`);
}
for (const value of ['mainnet', 'chipnet'] as const) {
  process.env.POOL_NETWORK = value;
  const env = value === 'mainnet' ? ON_MAINNET : PUBLIC;
  check(productionProblems(env).length === 0 && defaultNetwork() === value,
    `POOL_NETWORK=${value} passes, and the server serves ${defaultNetwork()}`);
}
delete process.env.POOL_NETWORK;

// ---- the factories, whenever the page reads the chain itself ----
refuses({ ...PUBLIC, BCH_FACTORY: undefined }, /Set CHIPNET_BCH_FACTORY or BCH_FACTORY to the category of chipnet's BCH pool factory/, 'no BCH factory');
refuses({ ...PUBLIC, TOKEN_FACTORY: '' }, /Set CHIPNET_TOKEN_FACTORY or TOKEN_FACTORY/, 'no token factory');
refuses({ ...PUBLIC, BCH_FACTORY: FACTORY.slice(2) }, /BCH_FACTORY is a factory's category, 64 hex/, 'a short category');
refuses({ ...PUBLIC, TOKEN_FACTORY: `${OTHER.slice(2)}zz` }, /TOKEN_FACTORY is a factory's category/, 'a category that is not hex');
check(productionProblems({ ...PUBLIC, BCH_FACTORY: FACTORY.toUpperCase() }).length === 0, 'a category in capitals');
const devnet = { POOL_NETWORK: 'local', DEVNET_ENABLED: '1' };
check(productionProblems(devnet).length === 0, 'a devnet test deployment needs no factories of its own');
// The bare names are POOL_NETWORK's network's, and the devnet's servers and factories are its service's.
refuses({ ...devnet, TRUSTLESS_FULCRUM_URL: 'wss://one.example.org:50004' }, /TRUSTLESS_FULCRUM_URL names a setting of POOL_NETWORK's network, and POOL_NETWORK=local is the devnet/,
  'a test deployment\'s bare server names no network');
refuses({ ...devnet, CHIPNET_TRUSTLESS_FULCRUM_URL: 'wss://one.example.org:50004' }, /Set CHIPNET_BCH_FACTORY to/,
  'and one that reads a public network from a server of its own needs that network whole');

// ---- the devnet only where asked for ----
refuses({ POOL_NETWORK: 'local' }, /DEVNET_ENABLED=1/, 'the devnet in production without DEVNET_ENABLED');
refuses({ POOL_NETWORK: 'devnet', DEVNET_ENABLED: '0' }, /DEVNET_ENABLED=1/, 'nor with it off');
// Beside mainnet or chipnet it would offer the devnet's faucet and page-held keys.
refuses({ ...PUBLIC, DEVNET_ENABLED: '1' }, /DEVNET_ENABLED=1 offers the devnet/, 'the devnet beside chipnet');
refuses({ ...ON_MAINNET, DEVNET_ENABLED: '1' }, /DEVNET_ENABLED=1 offers the devnet/, 'or beside mainnet');

// ---- an indexer every browser reaches ----
for (const url of [
  'http://indexer.example.org', 'https://localhost:8080', 'https://indexer-mainnet:8080', 'https://127.0.0.1',
  'https://10.1.2.3', 'https://192.168.1.10:8443', 'https://172.20.0.4', 'https://[::1]:8080', 'https://[fd12::1]',
  'https://indexer.internal', 'https://box.local', 'not a url',
]) refuses({ ...PUBLIC, INDEXER_URL: url }, /INDEXER_URL must be a public https/, `INDEXER_URL ${url}`);
check(productionProblems({ ...PUBLIC, INDEXER_URL: 'https://203.0.113.9' }).length === 0, 'a public address is reachable');
check(productionProblems({ ...PUBLIC, INDEXER_URL: 'https://fd.example.org' }).length === 0, 'and a name that starts like a private IPv6 address');
refuses({ ...PUBLIC, BCMR_SERVICE_URL: 'http://bcmr.example.org' }, /BCMR_SERVICE_URL must be an https/, 'token metadata over plain http');

// ---- the public origin link previews point to ----
refuses({ ...PUBLIC, SITE_URL: undefined }, /Set SITE_URL/, 'no SITE_URL');
for (const url of ['http://pools.example.org', 'https://localhost:8787', 'https://10.0.0.2']) {
  refuses({ ...PUBLIC, SITE_URL: url }, /SITE_URL must be the public https/, `SITE_URL ${url}`);
}
check(productionProblems({ ...PUBLIC, SITE_URL: undefined, NEXT_PUBLIC_SITE_URL: 'https://pools.example.org' }).length === 0, 'its public name counts too');
check(productionProblems({ POOL_NETWORK: 'local', DEVNET_ENABLED: '1' }).length === 0, 'a devnet test deployment needs none');

// ---- the exact source the page links to ----
refuses({ ...PUBLIC, SOURCE_URL: undefined }, /Set SOURCE_URL/, 'no SOURCE_URL');
refuses({ ...PUBLIC, SOURCE_URL: '  ' }, /Set SOURCE_URL/, 'a blank SOURCE_URL');
refuses({ ...ON_MAINNET, SOURCE_URL: undefined }, /Set SOURCE_URL/, 'no SOURCE_URL on mainnet');
for (const url of [
  'http://code.example.org/solidpool', 'https://localhost:3000/solidpool', 'https://10.0.0.2/solidpool',
  'https://source:8080/solidpool', 'git@code.example.org:solidpool.git', 'ftp://code.example.org/solidpool', 'not a url',
]) refuses({ ...PUBLIC, SOURCE_URL: url }, /SOURCE_URL must be a public https/, `SOURCE_URL ${url}`);
check(productionProblems({ POOL_NETWORK: 'local', DEVNET_ENABLED: '1' }).length === 0, 'a devnet test deployment needs no SOURCE_URL');
refuses({ POOL_NETWORK: 'local', DEVNET_ENABLED: '1', SOURCE_URL: 'http://code.example.org/solidpool' }, /SOURCE_URL must be a public https/,
  'but one it names is held to https');
// The page links to the source its build baked in, so a server started with another stops.
check(builtSourceProblems({ SOURCE_URL: ` ${PUBLIC.SOURCE_URL} ` }, 'start', PUBLIC.SOURCE_URL).length === 0,
  'a server started with the source its build links to starts');
const otherSource = builtSourceProblems({ SOURCE_URL: 'https://code.example.org/solidpool/tree/fedcba' }, 'start', PUBLIC.SOURCE_URL);
check(otherSource.some((problem) => /this build's page links to https:\/\/code\.example\.org\/solidpool\/tree\/0123456789abcdef/.test(problem)),
  `one started with another source stops (${otherSource.join(' | ')})`);
check(builtSourceProblems({}, 'start', PUBLIC.SOURCE_URL).length === 1, 'and so does one started with none');
check(builtSourceProblems({ SOURCE_URL: 'https://code.example.org/solidpool/tree/fedcba' }, 'build', PUBLIC.SOURCE_URL).length === 0,
  'a build is not held to another build\'s source');
check(builtSourceProblems({ SOURCE_URL: PUBLIC.SOURCE_URL }, 'start', undefined).length === 0, 'nor is a server Next did not build');


// ---- every public network under names of its own ----
// Each network's servers, factories and indexer carry its prefix, so one deployment offers both;
// the bare names are POOL_NETWORK's network's, as they were when a deployment named only that one.
const MAINNET = {
  MAINNET_TRUSTLESS_FULCRUM_URL: 'wss://mainnet-one.example.org:50004',
  MAINNET_TRUSTLESS_BROADCAST_URL: 'wss://mainnet-two.example.org:50004',
  MAINNET_BCH_FACTORY: MAINNET_FACTORIES.bch,
  MAINNET_TOKEN_FACTORY: MAINNET_FACTORIES.token,
};
const CHIPNET = {
  CHIPNET_TRUSTLESS_FULCRUM_URL: 'wss://chipnet-one.example.org:50004',
  CHIPNET_TRUSTLESS_BROADCAST_URL: 'wss://chipnet-two.example.org:50004',
  CHIPNET_BCH_FACTORY: CHIPNET_FACTORIES.bch,
  CHIPNET_TOKEN_FACTORY: CHIPNET_FACTORIES.token,
};
const COMMON = { WALLETCONNECT_PROJECT_ID: PUBLIC.WALLETCONNECT_PROJECT_ID, SITE_URL: PUBLIC.SITE_URL, SOURCE_URL: PUBLIC.SOURCE_URL };
const BOTH = { POOL_NETWORK: 'chipnet', ...COMMON, ...MAINNET, ...CHIPNET };
check(productionProblems(BOTH).length === 0, `a deployment that sets up both public networks starts (${productionProblems(BOTH).join(' | ')})`);
check(productionProblems({ ...BOTH, POOL_NETWORK: 'mainnet' }).length === 0, 'opening on either');
check(productionProblems({ ...PUBLIC, ...MAINNET }).length === 0, 'and so does one that names POOL_NETWORK\'s bare and the other\'s by its prefix');
check(productionProblems({
  ...COMMON, POOL_NETWORK: 'chipnet', CHIPNET_TRUSTLESS_FULCRUM_URL: CHIPNET.CHIPNET_TRUSTLESS_FULCRUM_URL,
  TRUSTLESS_BROADCAST_URL: CHIPNET.CHIPNET_TRUSTLESS_BROADCAST_URL, CHIPNET_BCH_FACTORY: FACTORY, TOKEN_FACTORY: TOKEN,
}).length === 0, 'or POOL_NETWORK\'s settings under either name, one by one');
check(productionProblems({ ...BOTH, MAINNET_INDEXER_URL: 'https://mainnet-indexer.example.org', CHIPNET_INDEXER_URL: 'https://chipnet-indexer.example.org' }).length === 0,
  'with an indexer for each');
refuses({ ...BOTH, MAINNET_TRUSTLESS_BROADCAST_URL: 'ws://mainnet-two.example.org:50003' }, /MAINNET_TRUSTLESS_BROADCAST_URL must be a wss/,
  'the other network\'s second server over plain ws');
refuses({ ...BOTH, MAINNET_TRUSTLESS_BROADCAST_URL: 'wss://MAINNET-ONE.example.org:50004/' },
  /MAINNET_TRUSTLESS_BROADCAST_URL names the same server as MAINNET_TRUSTLESS_FULCRUM_URL/, 'one server for both of its sides');
refuses({ ...BOTH, CHIPNET_TOKEN_FACTORY: 'not a category' }, /CHIPNET_TOKEN_FACTORY is a factory's category/, 'a malformed factory under a prefix');
refuses({ ...BOTH, MAINNET_INDEXER_URL: 'https://indexer-mainnet:8080' }, /MAINNET_INDEXER_URL must be a public https/, 'an indexer inside the compose network');
check(productionProblems(BOTH, { bundled: { mainnet: { factories: { bch: OTHER, token: MAINNET.MAINNET_TOKEN_FACTORY } } } })
  .some((problem) => /^MAINNET_BCH_FACTORY names another factory than web\/deployments\/mainnet\.json/.test(problem)),
'each network\'s factories agree with its own bundled deployment');

// ---- a network is offered whole, or not at all ----
const partly = productionProblems({ ...PUBLIC, MAINNET_INDEXER_URL: 'https://mainnet-indexer.example.org' });
check(['MAINNET_TRUSTLESS_FULCRUM_URL', 'MAINNET_TRUSTLESS_BROADCAST_URL', 'MAINNET_BCH_FACTORY', 'MAINNET_TOKEN_FACTORY']
  .every((name) => partly.some((problem) => problem.startsWith(`Set ${name} to `) && /MAINNET_INDEXER_URL offers mainnet/.test(problem)))
  && partly.length === 4, `a network set up in part is refused, naming each setting it lacks and what offers it (${partly.join(' | ')})`);
refuses({ ...BOTH, MAINNET_TOKEN_FACTORY: '' }, /^Set MAINNET_TOKEN_FACTORY to the category of mainnet's token pool factory/, 'one that lacks a factory');
refuses({ ...BOTH, CHIPNET_TRUSTLESS_BROADCAST_URL: '' }, /^Set CHIPNET_TRUSTLESS_BROADCAST_URL or TRUSTLESS_BROADCAST_URL to a second Fulcrum server of chipnet/,
  'and POOL_NETWORK\'s, under either of its names');
// POOL_NETWORK names the network a fresh page opens on, which must be one the deployment offers.
refuses({ ...COMMON, ...CHIPNET, POOL_NETWORK: 'mainnet' },
  /^POOL_NETWORK is mainnet, but nothing here sets mainnet up: set MAINNET_TRUSTLESS_FULCRUM_URL.*or set POOL_NETWORK to chipnet, which this deployment offers/,
  'POOL_NETWORK naming a network the deployment does not set up');
refuses({ ...COMMON, POOL_NETWORK: 'chipnet' }, /^POOL_NETWORK is chipnet, but nothing here sets chipnet up/, 'or a deployment that sets up none');

// ---- a prefixed and a bare name for one setting ----
// They must agree: nothing tells which is meant, so production refuses, and elsewhere the network
// is not served and the page says why.
refuses({ ...BOTH, BCH_FACTORY: OTHER }, /^CHIPNET_BCH_FACTORY and BCH_FACTORY name different factories for chipnet/, 'two factories for one');
refuses({ ...BOTH, TRUSTLESS_FULCRUM_URL: 'wss://elsewhere.example.org:50004' },
  /^CHIPNET_TRUSTLESS_FULCRUM_URL and TRUSTLESS_FULCRUM_URL name different servers for chipnet/, 'two servers for one');
refuses({ ...BOTH, CHIPNET_INDEXER_URL: 'https://chipnet-indexer.example.org', INDEXER_URL: 'https://other-indexer.example.org' },
  /^CHIPNET_INDEXER_URL and INDEXER_URL name different indexers for chipnet/, 'two indexers for one');
// The bare names follow POOL_NETWORK, never the other network.
refuses({ ...BOTH, POOL_NETWORK: 'mainnet', BCH_FACTORY: CHIPNET.CHIPNET_BCH_FACTORY },
  /^MAINNET_BCH_FACTORY and BCH_FACTORY name different factories for mainnet/, 'a bare factory on a mainnet deployment is mainnet\'s');
check(productionProblems({
  ...BOTH, BCH_FACTORY: CHIPNET.CHIPNET_BCH_FACTORY.toUpperCase(), TRUSTLESS_FULCRUM_URL: 'wss://Chipnet-One.example.org:50004/',
}).length === 0, 'one factory or server, however each name writes it, agrees');

// ---- the names the other network's servers had ----
// Nothing reads them now, so a deployment that still sets one is refused rather than started
// without that server.
for (const [old, current] of [
  ['MAINNET_FULCRUM_URL', 'MAINNET_TRUSTLESS_FULCRUM_URL'], ['MAINNET_BROADCAST_URL', 'MAINNET_TRUSTLESS_BROADCAST_URL'],
  ['CHIPNET_FULCRUM_URL', 'CHIPNET_TRUSTLESS_FULCRUM_URL'], ['CHIPNET_BROADCAST_URL', 'CHIPNET_TRUSTLESS_BROADCAST_URL'],
]) refuses({ ...BOTH, [old]: 'wss://old.example.org:50004' }, new RegExp(`^${old} is no longer read: name that server as ${current}\\.`), `${old}, an old name`);
refuses({ ...devnet, MAINNET_FULCRUM_URL: 'wss://old.example.org:50004' }, /^MAINNET_FULCRUM_URL is no longer read/, 'in a devnet test deployment too');

// ---- the other network, only from a server the deployment names ----
// A production server of chipnet once offered mainnet from public servers nobody configured or
// checked, and read mainnet's factories through them itself.
const PUBLIC_HOSTS = /imaginary\.cash|bch\.ninja|electroncash\.dk|loping\.net/;
/** What `read` makes of a server's settings, with `env` set while it reads: a production server's, unless `nodeEnv` says otherwise. */
const withEnv = <T>(env: Record<string, string>, read: () => T, nodeEnv = 'production'): T => {
  const before = { ...process.env };
  Object.assign(process.env, { NODE_ENV: nodeEnv }, env);
  try {
    return read();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
};
const served = (env: Record<string, string>) => withEnv(env, () => (
  { networks: availableNetworks().map((network) => network.id), mainnet: configFor('mainnet'), chipnet: configFor('chipnet') }));
const alone = served({ ...PUBLIC });
check(!alone.networks.includes('mainnet') && alone.mainnet === undefined, `a chipnet deployment that names no mainnet server offers no mainnet (${alone.networks.join(', ')})`);
check(!PUBLIC_HOSTS.test(JSON.stringify(alone)), 'and its config names no public server');
const oldName = served({ ...PUBLIC, MAINNET_FULCRUM_URL: 'wss://own-mainnet.example.org:50004' });
check(!oldName.networks.includes('mainnet') && oldName.mainnet === undefined, 'nor does one that names it by its old name, which nothing reads');
const both = served({ ...BOTH, MAINNET_INDEXER_URL: 'https://mainnet-indexer.example.org', CHIPNET_INDEXER_URL: 'https://chipnet-indexer.example.org' });
check(both.networks.includes('mainnet') && both.networks.includes('chipnet')
  && both.mainnet?.fulcrumUrl === MAINNET.MAINNET_TRUSTLESS_FULCRUM_URL && both.mainnet?.broadcastUrl === MAINNET.MAINNET_TRUSTLESS_BROADCAST_URL
  && both.mainnet?.factories?.bch === MAINNET.MAINNET_BCH_FACTORY && both.mainnet?.factories?.token === MAINNET.MAINNET_TOKEN_FACTORY
  && both.mainnet?.indexerUrl === 'https://mainnet-indexer.example.org',
`one that sets up mainnet offers it from its own servers, with its own factories and indexer (${JSON.stringify(both.mainnet && { ...both.mainnet, pools: undefined })})`);
check(both.chipnet?.fulcrumUrl === CHIPNET.CHIPNET_TRUSTLESS_FULCRUM_URL && both.chipnet?.broadcastUrl === CHIPNET.CHIPNET_TRUSTLESS_BROADCAST_URL
  && both.chipnet?.factories?.bch === CHIPNET.CHIPNET_BCH_FACTORY && both.chipnet?.factories?.token === CHIPNET.CHIPNET_TOKEN_FACTORY
  && both.chipnet?.indexerUrl === 'https://chipnet-indexer.example.org', 'and chipnet keeps its own');
const mixed = served({ ...PUBLIC, ...MAINNET });
check(mixed.chipnet?.factories?.bch === FACTORY && mixed.chipnet?.fulcrumUrl === PUBLIC.TRUSTLESS_FULCRUM_URL
  && mixed.mainnet?.factories?.bch === MAINNET.MAINNET_BCH_FACTORY && mixed.mainnet?.fulcrumUrl === MAINNET.MAINNET_TRUSTLESS_FULCRUM_URL,
'POOL_NETWORK\'s bare settings stay its own beside the other network\'s');
// Outside production a network keeps its public servers and bundled factories where nothing names
// others, and two names that disagree are reported on the page, with that network not served.
const dev = withEnv({ ...BOTH, BCH_FACTORY: OTHER, DEPLOYMENT_FILE: '/nonexistent/local.json' }, () => pageSettings(), 'development');
const devChipnet = dev.settings.chipnet;
const devMainnet = dev.settings.mainnet;
check(devChipnet !== undefined && 'error' in devChipnet && /CHIPNET_BCH_FACTORY and BCH_FACTORY name different factories for chipnet/.test(devChipnet.error)
  && devMainnet !== undefined && !('error' in devMainnet) && devMainnet.factories?.bch === MAINNET.MAINNET_BCH_FACTORY,
`outside production, a network whose two names disagree is not served, and the page says why (${JSON.stringify(devChipnet)})`);
// Compose passes a setting the .env leaves out as an empty string: an optional URL left blank takes
// its default, never the empty string.
const blanks = withEnv({
  POOL_NETWORK: 'chipnet', BCMR_SERVICE_URL: '', WALLETCONNECT_RELAY_URL: '', NEXT_PUBLIC_CIRCUIT_URL: '', NEXT_PUBLIC_PROVING_KEY_URL: ' ',
}, () => configFor('chipnet'), 'development');
check(blanks?.bcmrServiceUrl === 'https://bcmr.paytaca.com' && blanks?.walletConnectRelayUrl === null
  && blanks?.prover.circuitUrl === '/prover/withdraw.json' && blanks?.prover.provingKeyUrl === '/prover/withdraw_proving_key.bin',
  `blank optional URLs, as compose passes unset ones, take their defaults (${JSON.stringify(blanks && { bcmr: blanks.bcmrServiceUrl, relay: blanks.walletConnectRelayUrl, prover: blanks.prover })})`);
const devDefaults = withEnv({ POOL_NETWORK: 'chipnet', MAINNET_BCH_FACTORY: MAINNET.MAINNET_BCH_FACTORY }, () => configFor('mainnet'), 'development');
check(devDefaults?.factories?.bch === MAINNET.MAINNET_BCH_FACTORY && PUBLIC_HOSTS.test(devDefaults?.fulcrumUrl ?? ''),
  `and a setting overrides one default there, the rest kept (${devDefaults?.fulcrumUrl})`);

// ---- the settings a page opens with ----
// The server writes them into the page, for it to read without asking this app's /api, and
// /api/config serves the same reading.
const inPage = withEnv({ ...BOTH, MAINNET_INDEXER_URL: 'https://mainnet-indexer.example.org' }, () => pageSettings('pools.example.org'));
const chipnetInPage = inPage.settings.chipnet;
const mainnetInPage = inPage.settings.mainnet;
check(inPage.defaultNetwork === 'chipnet' && chipnetInPage !== undefined && !('error' in chipnetInPage)
  && chipnetInPage.fulcrumUrl === CHIPNET.CHIPNET_TRUSTLESS_FULCRUM_URL && chipnetInPage.broadcastUrl === CHIPNET.CHIPNET_TRUSTLESS_BROADCAST_URL
  && mainnetInPage !== undefined && !('error' in mainnetInPage)
  && inPage.networks.find((network) => network.id === 'mainnet')?.fulcrumUrl === MAINNET.MAINNET_TRUSTLESS_FULCRUM_URL,
  `a page holds each offered network's settings and its own servers, and opens on the deployment's (${JSON.stringify(inPage.networks)})`);
check(mainnetInPage !== undefined && !('error' in mainnetInPage) && chipnetInPage !== undefined && !('error' in chipnetInPage)
  && JSON.stringify(mainnetInPage.factories) === JSON.stringify({ bch: MAINNET.MAINNET_BCH_FACTORY, token: MAINNET.MAINNET_TOKEN_FACTORY })
  && JSON.stringify(chipnetInPage.factories) === JSON.stringify({ bch: CHIPNET.CHIPNET_BCH_FACTORY, token: CHIPNET.CHIPNET_TOKEN_FACTORY })
  && mainnetInPage.indexerUrl === 'https://mainnet-indexer.example.org' && chipnetInPage.indexerUrl === undefined,
  'each with its own factories and indexer');
check(networkFor(inPage, 'mainnet') === 'mainnet' && networkFor(inPage, 'devnet') === 'chipnet' && networkFor(inPage, null) === 'chipnet',
  'it opens the network its browser chose while that one is offered, else the deployment\'s');
check(!PUBLIC_HOSTS.test(JSON.stringify(withEnv({ ...PUBLIC }, () => pageSettings()))), 'and a chipnet deployment\'s name no public server');
// With no server to read either network from, and no devnet, it offers none, and says why.
const unserved = withEnv({ ...PUBLIC, TRUSTLESS_FULCRUM_URL: '', TRUSTLESS_BROADCAST_URL: '', DEPLOYMENT_FILE: '/nonexistent/local.json' },
  () => pageSettings());
const unservedChipnet = unserved.settings.chipnet;
check(unserved.defaultNetwork === 'chipnet' && unservedChipnet !== undefined && 'error' in unservedChipnet
  && /no chipnet deployment/.test(unservedChipnet.error),
  `a deployment that serves no network says why, as /api/config does (${JSON.stringify(unserved.settings)})`);
const hostile = { label: '</script><script>alert(1)</script><!-- & \u2028 \u2029' };
const written = settingsJson(hostile);
check(!/[<>&\u2028\u2029]/.test(written) && JSON.parse(written).label === hostile.label,
  `no value can end the element that holds them, and each reads back as it was (${written})`);

// ---- the devnet's service, as this server reads it ----
// The page may reach the service at the host it opened the app at, but this server's own read of
// the devnet's pools (api/config) takes no host from a request.
check(devnetFulcrumUrl('attacker.invalid:8787') === 'ws://attacker.invalid:8788' && serviceChainUrl() === 'ws://127.0.0.1:8788',
  `a request's host names the page's server only, never this server's (${serviceChainUrl()})`);
// The page asks the service for test coins itself, on the host and port it reads the chain at.
check(devnetFaucetUrl('attacker.invalid:8787') === 'http://attacker.invalid:8788/faucet' && devnetFaucetUrl() === 'http://127.0.0.1:8788/faucet',
  `the devnet's faucet is its service's, beside its chain (${devnetFaucetUrl('attacker.invalid:8787')})`);

// ---- the indexer's pool list, read once for a burst of requests ----
{
  let reads = 0;
  const list = keptFor(200, async (url: string) => { reads += 1; return [url]; });
  await Promise.all([list('https://indexer.example.org'), list('https://indexer.example.org'), list('https://indexer.example.org')]);
  check(reads === 1, `three requests at once read the indexer's list once (${reads})`);
  await list('https://indexer.example.org');
  check(reads === 1, 'and one soon after is answered from what was kept');
  await new Promise((resolve) => { setTimeout(resolve, 250); });
  await list('https://indexer.example.org');
  check(reads === 2, `and once that time is up it is read again (${reads})`);
  let failures = 0;
  const failing = keptFor(10_000, async () => { failures += 1; throw new Error('indexer down'); });
  await failing('x').catch(() => undefined);
  await failing('x').catch(() => undefined);
  check(failures === 2, 'a read that throws is not kept');
}

// ---- a server that cannot be checked is not used ----
// Nothing listens on port 1, as for a misspelt host or port: a build or start once only named it.
const unchecked = { ...PUBLIC, TRUSTLESS_FULCRUM_URL: 'wss://127.0.0.1:1', TRUSTLESS_BROADCAST_URL: 'wss://127.0.0.1:2' };
const atStart = await serverProblems(unchecked, 'start', 2_000);
check(atStart.problems.length === 2 && atStart.problems.every((problem) => /could not be checked/.test(problem)),
  `a start stops at servers it cannot check (${atStart.problems.join(' | ')})`);
const atBuild = await serverProblems(unchecked, 'build', 2_000);
check(atBuild.problems.length === 2, 'and so does a build');
const offline = await serverProblems({ ...unchecked, SOLIDPOOL_OFFLINE_BUILD: '1' }, 'build', 2_000);
check(offline.problems.length === 0 && offline.skipped.length === 2, 'a build told it is offline leaves them to the start, and says which');
const offlineStart = await serverProblems({ ...unchecked, SOLIDPOOL_OFFLINE_BUILD: '1' }, 'start', 2_000);
check(offlineStart.problems.length === 2, 'but a start asks them whatever SOLIDPOOL_OFFLINE_BUILD says');
const handedOff = await serverProblems({ ...unchecked, SOLIDPOOL_SERVERS_CHECKED: '1' }, 'start', 2_000);
check(handedOff.problems.length === 2, 'and nothing in the environment tells it they were checked already');

// ---- a start checks every network it offers ----
// Stand-ins for Fulcrum on this machine, each answering as its chain would: its software, its
// genesis, and the block past the chain's last split (web/src/network-check.ts). Each refuses every
// other call, as a server refuses a transaction it does not have, and keeps what it was asked.
const GENESIS = {
  mainnet: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  chipnet: '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b',
};
const CHECKPOINT = {
  mainnet: { height: 951145, hash: '000000000000000000f64dbed68370486f945097ba90b17e30d7bf5c43df7a60' },
  chipnet: { height: 284827, hash: '000000007af65a6e8853f858b3f2a8e7edabe41e6264410276705b324267d7d8' },
};
const standIn = async (chain: 'mainnet' | 'chipnet') => {
  const asked: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => { wss.once('listening', resolve); });
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const { id, method, params } = JSON.parse(String(data));
    asked.push(`${method} ${JSON.stringify(params)}`);
    const { height, hash } = CHECKPOINT[chain];
    const answer = method === 'server.version' ? { result: ['Fulcrum 2.1.0', '1.4'] }
      : method === 'server.features' ? { result: { genesis_hash: GENESIS[chain], hash_function: 'sha256' } }
        : method === 'blockchain.block.header' && params?.[0] === height + 1
          ? { result: `00000020${hash.match(/../g)!.reverse().join('')}${'11'.repeat(32)}${'22'.repeat(12)}` }
          : { error: { code: 2, message: `${method} is not answered here` } };
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
  }));
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    asked,
    close: () => { for (const client of wss.clients) client.terminate(); wss.close(); },
  };
};
const stands = {
  mainnetOne: await standIn('mainnet'), mainnetTwo: await standIn('mainnet'),
  chipnetOne: await standIn('chipnet'), chipnetTwo: await standIn('chipnet'),
};
// The start reads its settings from the environment as given: plain ws:// to this machine passes
// here, which the settings' form check (above) refuses to a real deployment.
const atHome = {
  ...BOTH,
  MAINNET_TRUSTLESS_FULCRUM_URL: stands.mainnetOne.url, MAINNET_TRUSTLESS_BROADCAST_URL: stands.mainnetTwo.url,
  CHIPNET_TRUSTLESS_FULCRUM_URL: stands.chipnetOne.url, CHIPNET_TRUSTLESS_BROADCAST_URL: stands.chipnetTwo.url,
};
check(configuredServers(atHome).map(({ name, network }) => `${name} ${network}`).join(', ')
  === 'MAINNET_TRUSTLESS_FULCRUM_URL mainnet, MAINNET_TRUSTLESS_BROADCAST_URL mainnet, CHIPNET_TRUSTLESS_FULCRUM_URL chipnet, CHIPNET_TRUSTLESS_BROADCAST_URL chipnet',
  'a start asks after each offered network\'s two servers, each held to its own network');
check(configuredServers({ ...PUBLIC, ...MAINNET }).map(({ name, network }) => `${name} ${network}`).join(', ')
  === 'MAINNET_TRUSTLESS_FULCRUM_URL mainnet, MAINNET_TRUSTLESS_BROADCAST_URL mainnet, TRUSTLESS_FULCRUM_URL chipnet, TRUSTLESS_BROADCAST_URL chipnet',
  'POOL_NETWORK\'s under their bare names too');
const allFour = await serverProblems(atHome, 'start', 2_000);
check(allFour.problems.length === 0 && Object.values(stands).every((stand) => stand.asked.some((call) => call.startsWith('server.features'))),
  `and asks each of them which chain it follows (${allFour.problems.join(' | ') || 'all four follow theirs'})`);
const crossed = await serverProblems({ ...atHome, MAINNET_TRUSTLESS_BROADCAST_URL: stands.chipnetTwo.url }, 'start', 2_000);
check(crossed.problems.length === 1 && /^MAINNET_TRUSTLESS_BROADCAST_URL ws:\/\/127\.0\.0\.1:\d+ will not do: it follows chipnet or testnet4, not mainnet/.test(crossed.problems[0]),
  `so a server of another chain stops it on the network it does not open on too (${crossed.problems.join(' | ')})`);
for (const stand of Object.values(stands)) stand.close();
// Then it reads each network's factories' geneses through that network's first server
// (web/lib/factory-check.ts, which loads SolidCash and so runs only in the server Next builds).
const factoryReads = (env: Record<string, string>) => configuredFactories(env)
  .map(({ name, network, category, url }) => `${name} ${network} ${category.slice(0, 4)} ${url}`).join(', ');
check(factoryReads(atHome) === [
  `MAINNET_BCH_FACTORY mainnet ${MAINNET_FACTORIES.bch.slice(0, 4)} ${stands.mainnetOne.url}`, `MAINNET_TOKEN_FACTORY mainnet ${MAINNET_FACTORIES.token.slice(0, 4)} ${stands.mainnetOne.url}`,
  `CHIPNET_BCH_FACTORY chipnet ${CHIPNET_FACTORIES.bch.slice(0, 4)} ${stands.chipnetOne.url}`, `CHIPNET_TOKEN_FACTORY chipnet ${CHIPNET_FACTORIES.token.slice(0, 4)} ${stands.chipnetOne.url}`,
].join(', '), `and reads each offered network's factories through its own first server (${factoryReads(atHome)})`);
check(factoryReads({ ...PUBLIC, ...MAINNET, BCH_FACTORY: FACTORY.toUpperCase() }) === [
  `MAINNET_BCH_FACTORY mainnet ${MAINNET_FACTORIES.bch.slice(0, 4)} ${MAINNET.MAINNET_TRUSTLESS_FULCRUM_URL}`, `MAINNET_TOKEN_FACTORY mainnet ${MAINNET_FACTORIES.token.slice(0, 4)} ${MAINNET.MAINNET_TRUSTLESS_FULCRUM_URL}`,
  `BCH_FACTORY chipnet ${FACTORY.slice(0, 4)} ${PUBLIC.TRUSTLESS_FULCRUM_URL}`, `TOKEN_FACTORY chipnet ${TOKEN.slice(0, 4)} ${PUBLIC.TRUSTLESS_FULCRUM_URL}`,
].join(', '), `POOL_NETWORK's bare ones through its bare server, in lower case (${factoryReads({ ...PUBLIC, ...MAINNET, BCH_FACTORY: FACTORY.toUpperCase() })})`);

finish();
