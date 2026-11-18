import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import mainnet from '../deployments/mainnet.json';
import chipnet from '../deployments/chipnet.json';
import { KNOWN_SERVERS } from '../src/known-servers';
import { privateAddress } from '../src/network-check';
import { devnetFaucetUrl, devnetFulcrumUrl } from './proxy';

/** A Bitcoin Cash network this app can serve. `devnet` is the service's own chain. */
export type NetworkId = 'mainnet' | 'chipnet' | 'devnet';

/** A network a deployment names servers and factories for: all but the devnet, whose are its service's. */
export type PublicNetworkId = 'mainnet' | 'chipnet';
export const PUBLIC_NETWORKS: readonly PublicNetworkId[] = ['mainnet', 'chipnet'];

export interface DeploymentPool {
  id: string;
  kind: 'bch' | 'token';
  name: string;
  symbol: string;
  decimals: number;
  denomination: string;
  category: string;
  asset?: string;
}

export interface Deployment {
  network: 'mainnet' | 'chipnet';
  local?: boolean;
  /** The categories of the network's pool factories, which every pool is made through. */
  factories?: { bch?: string; token?: string } | null;
  pools: DeploymentPool[];
}

export interface NetworkChoice {
  id: NetworkId;
  label: string;
  available: boolean;
  reason?: string;
  local?: boolean;
}

const NETWORKS = ['mainnet', 'chipnet', 'devnet'] as const;

/** The devnet is for debugging: offered by `next dev`, and by a test deployment that asks for it. */
const DEVNET_ENABLED = process.env.NODE_ENV !== 'production' || process.env.DEVNET_ENABLED === '1';

const BUNDLED: Partial<Record<NetworkId, Deployment>> = {
  mainnet: mainnet as Deployment,
  chipnet: chipnet as Deployment,
};

/** The deployment the local service writes for its own chain, read only where that service can run. */
function localDeployment(): Deployment | undefined {
  if (!DEVNET_ENABLED) return undefined;
  const file = process.env.DEPLOYMENT_FILE ?? join(process.cwd(), '..', 'deployments', 'local.json');
  if (!existsSync(/* turbopackIgnore: true */ file)) return undefined;
  try {
    return JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')) as Deployment;
  } catch {
    return undefined;
  }
}

/** A network's deployment, or undefined where it has none (an absent devnet chain, a mistyped id). */
export function deploymentFor(id: string): Deployment | undefined {
  if (id === 'devnet') {
    const found = localDeployment();
    return found === undefined ? undefined : { ...found, network: 'chipnet', local: true };
  }
  return BUNDLED[id as NetworkId];
}

type Env = Record<string, string | undefined>;

/** What `POOL_NETWORK` may name: a public network, or the local service's chain under either name. */
export type NetworkSetting = 'mainnet' | 'chipnet' | 'local' | 'devnet';
const NETWORK_SETTINGS: readonly string[] = ['mainnet', 'chipnet', 'local', 'devnet'];

/**
 * The network `POOL_NETWORK` names, read exactly as written, or undefined when it names none. Every
 * reading of the setting goes through here, the production checks' and the server's alike, so they
 * cannot disagree: a value such as `mainnet ` is no network, which production refuses, rather than
 * mainnet to the checks and chipnet to the page.
 */
export function poolNetwork(env: Env = process.env): NetworkSetting | undefined {
  const value = env.POOL_NETWORK;
  return value !== undefined && NETWORK_SETTINGS.includes(value) ? value as NetworkSetting : undefined;
}

/** What a fresh page opens on: `POOL_NETWORK`, then chipnet, the network this app's test pools live on. */
export function defaultNetwork(): NetworkId {
  const named = process.env.POOL_NETWORK === undefined ? process.env.NEXT_PUBLIC_DEFAULT_NETWORK : poolNetwork();
  // The local service names its own chain `local`; the page calls that the devnet.
  if (named === 'local') return DEVNET_ENABLED ? 'devnet' : 'chipnet';
  return (NETWORKS as readonly string[]).includes(named ?? '') ? (named as NetworkId) : 'chipnet';
}

// ---- Each public network's settings -----------------------------------------------------------

/**
 * What a deployment names for each public network, under that network's prefix:
 * MAINNET_TRUSTLESS_FULCRUM_URL, CHIPNET_BCH_FACTORY and so on, so one deployment can offer both.
 * The same names bare name POOL_NETWORK's network, as they did when a deployment named no other,
 * and as the indexer reads its factories.
 */
export const NETWORK_VARIABLES = ['TRUSTLESS_FULCRUM_URL', 'TRUSTLESS_BROADCAST_URL', 'BCH_FACTORY', 'TOKEN_FACTORY', 'INDEXER_URL'] as const;
export type NetworkVariable = typeof NETWORK_VARIABLES[number];

/** A variable's name for one public network: MAINNET_BCH_FACTORY. */
export const prefixed = (id: PublicNetworkId, variable: NetworkVariable): string => `${id.toUpperCase()}_${variable}`;

/** One variable of a public network, as a deployment sets it. */
export interface NetworkValue {
  /** Its value, trimmed; undefined where no name sets it, or where two set it apart. */
  value?: string;
  /** The names it is set under, its prefixed one first. */
  setBy: string[];
  /** Why it is not read: its prefixed and its bare name name different things, and nothing tells which is meant. */
  conflict?: string;
}

const NAMED_THINGS: Record<NetworkVariable, string> = {
  TRUSTLESS_FULCRUM_URL: 'servers',
  TRUSTLESS_BROADCAST_URL: 'servers',
  BCH_FACTORY: 'factories',
  TOKEN_FACTORY: 'factories',
  INDEXER_URL: 'indexers',
};

/**
 * A public network's variables as `env` sets them: each under the network's prefix, and, where
 * `bare` is this network, under its bare name too. Where both are set they must name one factory,
 * in any case, or one server, however its URL is written; where they do not, neither is read.
 */
export function networkValues(id: PublicNetworkId, env: Env, bare: PublicNetworkId | undefined): Record<NetworkVariable, NetworkValue> {
  const values = {} as Record<NetworkVariable, NetworkValue>;
  for (const variable of NETWORK_VARIABLES) {
    const set = (id === bare ? [prefixed(id, variable), variable] : [prefixed(id, variable)]).flatMap((name) => {
      const value = env[name]?.trim();
      return value ? [{ name, value }] : [];
    });
    const setBy = set.map(({ name }) => name);
    const [first, second] = set;
    const agree = second === undefined || (variable.endsWith('_FACTORY')
      ? first.value.toLowerCase() === second.value.toLowerCase()
      : serverOf(first.value) === serverOf(second.value));
    values[variable] = agree
      ? { value: first?.value, setBy }
      : { setBy, conflict: `${first.name} and ${second.name} name different ${NAMED_THINGS[variable]} for ${id}` };
  }
  return values;
}

/** Whether a deployment sets anything for a public network: a production server offers it then, and only whole. */
export const setsUp = (values: Record<NetworkVariable, NetworkValue>): boolean => (
  NETWORK_VARIABLES.some((variable) => values[variable].setBy.length > 0));

/** The public network the bare names name, as the production checks read POOL_NETWORK: exactly. */
export function bareNetworkOf(env: Env): PublicNetworkId | undefined {
  const network = poolNetwork(env);
  return network === 'mainnet' || network === 'chipnet' ? network : undefined;
}

/**
 * The public network the bare names name on this server: the one a fresh page opens on, which is
 * bareNetworkOf's wherever the production checks pass. Outside production, with POOL_NETWORK
 * unset, that is NEXT_PUBLIC_DEFAULT_NETWORK's or chipnet, as it was before each network had names
 * of its own.
 */
function bareNetwork(): PublicNetworkId | undefined {
  const id = defaultNetwork();
  return id === 'devnet' ? undefined : id;
}

/** A public network's variables, as this server reads them. */
const servedValues = (id: PublicNetworkId) => networkValues(id, process.env, bareNetwork());

/**
 * Public servers a page starts on where nothing names one: for `next dev` and a devnet test
 * deployment only. A production server of mainnet or chipnet reads only servers its settings name,
 * which its build and start check.
 */
const knownUrl = (id: 'mainnet' | 'chipnet', label: string): string => {
  const server = KNOWN_SERVERS[id].find((known) => known.label === label);
  if (!server) throw new Error(`${label} is not among the known ${id} servers (web/src/known-servers.ts).`);
  return server.url;
};
const PUBLIC_SERVERS = {
  mainnet: { fulcrum: KNOWN_SERVERS.mainnet[0].url, broadcast: knownUrl('mainnet', 'electroncash.dk') },
  chipnet: { fulcrum: KNOWN_SERVERS.chipnet[0].url, broadcast: knownUrl('chipnet', 'chipnet.imaginary.cash') },
} as const;

/** Whether this is a production server of mainnet or chipnet, which uses no server its settings do not name. */
const servesPublicNetwork = (): boolean => {
  const network = poolNetwork();
  return process.env.NODE_ENV === 'production' && (network === 'mainnet' || network === 'chipnet');
};

/**
 * The servers a public network is read from: its TRUSTLESS_FULCRUM_URL and TRUSTLESS_BROADCAST_URL,
 * under its prefix or, on POOL_NETWORK's network, bare. A production server of mainnet or chipnet
 * offers no network whose servers it is not given, so it has none to fall back on; elsewhere a
 * network's first server takes its withdrawals too where it is named alone.
 */
export function chainServers(id: PublicNetworkId): { fulcrumUrl: string; broadcastUrl: string } | undefined {
  const values = servedValues(id);
  const fulcrum = values.TRUSTLESS_FULCRUM_URL.value;
  const broadcast = values.TRUSTLESS_BROADCAST_URL.value;
  if (fulcrum) return { fulcrumUrl: fulcrum, broadcastUrl: broadcast ?? fulcrum };
  if (servesPublicNetwork()) return undefined;
  return { fulcrumUrl: PUBLIC_SERVERS[id].fulcrum, broadcastUrl: broadcast ?? PUBLIC_SERVERS[id].broadcast };
}

/** The networks a page may choose, with the reason a choice is offered but empty. */
export function availableNetworks(): NetworkChoice[] {
  const listed: NetworkChoice[] = ([['mainnet', 'Mainnet'], ['chipnet', 'Chipnet']] as const)
    .filter(([id]) => chainServers(id) !== undefined)
    .map(([id, label]) => ({ id, label, available: true }));
  if (!DEVNET_ENABLED) return listed;
  const devnet = localDeployment();
  listed.push({
    id: 'devnet',
    label: 'Devnet',
    local: true,
    available: devnet !== undefined,
    ...(devnet === undefined ? { reason: 'Start the local service to use the devnet.' } : {}),
  });
  return listed;
}

/** Whether a network is the local service's chain: its Fulcrum is the app's proxy and its faucet is open. */
export function isDevnet(id: string): boolean {
  return id === 'devnet' && localDeployment() !== undefined;
}

/** The variables that name a network's pool factories, the same two the indexer reads. */
const FACTORY_VARIABLES = { bch: 'BCH_FACTORY', token: 'TOKEN_FACTORY' } as const;

/**
 * The factories a page trusts on a network: it finds every pool through their `PoolCreated` events,
 * lists only the pools they name, and deposits into no other. They are the deployment's, and the
 * network's BCH_FACTORY and TOKEN_FACTORY as well, under its prefix or, on POOL_NETWORK's network,
 * bare, so a deployment file need not name them. Where the two name different factories of a kind,
 * or the prefixed and the bare name do, nothing here can tell which is right, so this throws rather
 * than pick one, and the network is not served.
 */
export function trustedFactories(id: NetworkId, found: Deployment): { bch?: string; token?: string } | null {
  const values = found.local || id === 'devnet' ? undefined : servedValues(id);
  const factories: { bch?: string; token?: string } = {};
  for (const kind of ['bch', 'token'] as const) {
    const filed = found.factories?.[kind]?.trim().toLowerCase();
    const setting = values?.[FACTORY_VARIABLES[kind]];
    if (setting?.conflict) throw new Error(`${setting.conflict}, so this app serves no pools there.`);
    const named = setting?.value?.toLowerCase();
    if (filed && named && filed !== named) {
      throw new Error(`This app is set up with another ${kind === 'bch' ? 'BCH' : 'token'} pool factory than its ${id} deployment names, so it serves no pools there.`);
    }
    const factory = named || filed;
    if (factory) factories[kind] = factory;
  }
  return factories.bch || factories.token ? factories : null;
}

/**
 * Everything a browser needs to reach a network's pools, and none of it is secret. The browser
 * reads the chain from the Fulcrum server itself, over its WebSocket, so a trustless page needs no
 * indexer; on the devnet, the optional service is that server. It throws where a setting's
 * prefixed and bare names name different things, and where the environment and the deployment
 * name different factories (`trustedFactories`): the network is not served then.
 */
/**
 * An optional setting's value, or undefined where it is unset or blank: compose passes a variable
 * the .env leaves out as an empty string, which must mean its default, not an empty URL.
 */
const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export function configFor(id: NetworkId, requestHost?: string) {
  const found = deploymentFor(id);
  if (found === undefined) return undefined;
  const local = Boolean(found.local);
  const values = local || id === 'devnet' ? undefined : servedValues(id);
  const conflicts = values ? NETWORK_VARIABLES.flatMap((variable) => values[variable].conflict ?? []) : [];
  if (conflicts.length) throw new Error(`This app serves nothing on ${id}: ${conflicts.join('; ')}.`);
  const mainnetChain = id === 'mainnet';
  const servers = local ? undefined : chainServers(id as PublicNetworkId);
  // A production server of mainnet or chipnet serves no network it was given no server for.
  if (!local && servers === undefined) return undefined;
  const fulcrumUrl = local ? devnetFulcrumUrl(requestHost) : servers!.fulcrumUrl;
  return {
    network: found.network,
    networkId: id,
    networkLabel: local ? 'devnet' : mainnetChain ? 'mainnet' : 'chipnet',
    pools: found.pools,
    factories: trustedFactories(id, found),
    fulcrumUrl,
    // The local service's archive is the devnet's indexer; a real deployment may name one.
    indexerUrl: local ? '/api/indexer' : values?.INDEXER_URL.value,
    // A second server for withdrawals, so one operator does not see both sides. The page
    // still lets a person name another in Settings.
    broadcastUrl: local ? devnetFulcrumUrl(requestHost) : servers!.broadcastUrl,
    bcmrServiceUrl: optional('BCMR_SERVICE_URL') ?? 'https://bcmr.paytaca.com',
    prover: {
      circuitUrl: optional('NEXT_PUBLIC_CIRCUIT_URL') ?? '/prover/withdraw.json',
      provingKeyUrl: optional('NEXT_PUBLIC_PROVING_KEY_URL') ?? '/prover/withdraw_proving_key.bin',
    },
    // The deployment's own project, read as productionProblems reads it; `next dev` and the devnet
    // fall back to the public WalletConnect Cloud project the sibling apps use.
    walletConnectProjectId: walletConnectProject() ?? '3fd234b8e2cd0e1da4bc08a0011bbf64',
    walletConnectRelayUrl: optional('WALLETCONNECT_RELAY_URL') ?? null,
    chain: mainnetChain ? 'bch:bitcoincash' : 'bch:bchtest',
    addressPrefix: mainnetChain ? 'bitcoincash' : 'bchtest',
    // A key kept in a web page is for coins that are worth nothing, and those are the devnet's.
    localAccounts: local,
    faucetUrl: local ? devnetFaucetUrl(requestHost) : undefined,
  };
}

// ---- What production requires --------------------------------------------------------------

const CATEGORY = /^[0-9a-f]{64}$/;
const WALLETCONNECT_PROJECT = /^[0-9a-f]{32}$/;

const urlOf = (value: string): URL | undefined => {
  try { return new URL(value); } catch { return undefined; }
};

/**
 * The deployment's WalletConnect Cloud project: WALLETCONNECT_PROJECT_ID, or its public name when
 * that is unset or blank. productionProblems checks it and configFor serves it, from one reading.
 */
export function walletConnectProject(env: Env = process.env): string | undefined {
  return env.WALLETCONNECT_PROJECT_ID?.trim() || env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || undefined;
}

/** The deployment's public origin, for link previews: SITE_URL, or its public name. */
export function siteUrl(env: Env = process.env): string | undefined {
  return env.SITE_URL?.trim() || env.NEXT_PUBLIC_SITE_URL?.trim() || undefined;
}

/**
 * Where the exact source of this build is, such as its commit or tag in a public repository:
 * SOURCE_URL. The page as served is conveyed under the GPL-3.0, so its Source link points there:
 * next.config.ts bakes the value into the page at build time, and a server checks it is started
 * with the same one (settings-check.ts).
 */
export function sourceUrl(env: Env = process.env): string | undefined {
  return env.SOURCE_URL?.trim() || undefined;
}

/**
 * One server however its URL is written: the scheme, the host as URL lowercases it with any
 * default port dropped, and the path without a trailing slash.
 */
const serverOf = (value: string): string => {
  const url = urlOf(value);
  return url ? `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}` : value.trim().toLowerCase();
};

/** Whether every browser can reach a URL: https, at a public name or address. */
function publicHttps(value: string): boolean {
  const url = urlOf(value);
  if (url?.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host) || privateAddress(host)) return false;
  // A single label is a name inside one network, such as a compose service.
  return host.includes('.') || host.includes(':');
}

/**
 * The names the other network's servers had while a deployment named one network bare and the
 * other by these, and the names that replaced them. Nothing reads them now, so production refuses
 * them rather than start without a server someone meant to name.
 */
const REPLACED_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['MAINNET_FULCRUM_URL', 'MAINNET_TRUSTLESS_FULCRUM_URL'],
  ['MAINNET_BROADCAST_URL', 'MAINNET_TRUSTLESS_BROADCAST_URL'],
  ['CHIPNET_FULCRUM_URL', 'CHIPNET_TRUSTLESS_FULCRUM_URL'],
  ['CHIPNET_BROADCAST_URL', 'CHIPNET_TRUSTLESS_BROADCAST_URL'],
];

/**
 * Why a production server must not start, if it must not. A forgotten setting fails closed, so a
 * page never opens on a network, a server, a factory or a WalletConnect project that nobody
 * chose: the defaults above are for `next dev` and the devnet. A public deployment
 * (`POOL_NETWORK` mainnet or chipnet) offers each public network it sets anything for, and each
 * one whole: its two Fulcrum servers and its two factories. POOL_NETWORK names one of them, the
 * network a fresh page opens on, and the deployment names its WalletConnect project; the devnet
 * runs only in a test deployment that sets `DEVNET_ENABLED=1`. This checks each setting's form; a
 * production build and server also ask each server which chain it follows (settings-check.ts),
 * and a server reads each network's factories' geneses (factory-check.ts).
 */
export function productionProblems(
  env: Env = process.env,
  { bundled: bundledDeployments = BUNDLED }: { bundled?: Partial<Record<NetworkId, Pick<Deployment, 'factories'>>> } = {},
): string[] {
  const problems: string[] = [];
  const read = (name: string) => env[name]?.trim() ?? '';
  // Read as the server reads it (poolNetwork), so what passes here is what it serves.
  const network = poolNetwork(env);
  const known = network === 'mainnet' || network === 'chipnet';
  // Anything but the devnet's test deployment is held to what a public one needs.
  const isPublic = network !== 'local' && network !== 'devnet';
  if (!isPublic) {
    if (env.DEVNET_ENABLED !== '1') {
      problems.push('POOL_NETWORK=local is the devnet, which a production server runs only for a test deployment that sets DEVNET_ENABLED=1.');
    }
  } else if (!known) {
    problems.push(env.POOL_NETWORK
      ? `POOL_NETWORK is mainnet or chipnet, written exactly so, not ${JSON.stringify(env.POOL_NETWORK)}.`
      : 'Set POOL_NETWORK to mainnet or chipnet: the network a fresh page opens on, which this deployment offers with its two Fulcrum servers and two factories (web/.env.example).');
  }
  // The devnet brings its faucet, its routes to the local service and keys held in the page, none
  // of which belongs beside a public network.
  if (isPublic && env.DEVNET_ENABLED === '1') {
    problems.push('DEVNET_ENABLED=1 offers the devnet, its faucet and keys kept in the page: a mainnet or chipnet server runs without it. Unset it, or set POOL_NETWORK=local for a test deployment.');
  }

  for (const [old, current] of REPLACED_NAMES) {
    if (read(old)) problems.push(`${old} is no longer read: name that server as ${current}.`);
  }
  // The bare names are POOL_NETWORK's network's, and the devnet's servers and factories are its service's.
  if (!isPublic) {
    for (const variable of NETWORK_VARIABLES) {
      if (read(variable)) {
        problems.push(`${variable} names a setting of POOL_NETWORK's network, and POOL_NETWORK=${network} is the devnet, which reads its service: name a public network's under its prefix, such as ${prefixed('chipnet', variable)}.`);
      }
    }
  }

  // Each public network the deployment sets anything for is offered, and only whole: a page reads
  // it from its two servers and lists the pools of its two factories.
  const bare = bareNetworkOf(env);
  const offered: PublicNetworkId[] = [];
  for (const id of PUBLIC_NETWORKS) {
    const values = networkValues(id, env, bare);
    if (!setsUp(values)) continue;
    offered.push(id);
    const setBy = NETWORK_VARIABLES.flatMap((variable) => values[variable].setBy);
    const names = (variable: NetworkVariable) => (id === bare ? `${prefixed(id, variable)} or ${variable}` : prefixed(id, variable));
    const offeredBy = id === bare ? ''
      : ` ${setBy.join(', ')} ${setBy.length > 1 ? 'offer' : 'offers'} ${id}, which then needs its two servers and two factories; unset ${setBy.length > 1 ? 'them' : 'it'} to offer no ${id}.`;
    const lacks = (variable: NetworkVariable) => values[variable].value === undefined && values[variable].conflict === undefined;
    for (const variable of NETWORK_VARIABLES) {
      const { conflict } = values[variable];
      if (conflict) problems.push(`${conflict}: unset one, or set both alike.`);
    }
    if (lacks('TRUSTLESS_FULCRUM_URL')) {
      problems.push(`Set ${names('TRUSTLESS_FULCRUM_URL')} to the Fulcrum server a page reads ${id} from (wss://).${offeredBy}`);
    }
    if (lacks('TRUSTLESS_BROADCAST_URL')) {
      problems.push(`Set ${names('TRUSTLESS_BROADCAST_URL')} to a second Fulcrum server of ${id}, of another operator, which takes its withdrawals (wss://).${offeredBy}`);
    }
    const fulcrum = values.TRUSTLESS_FULCRUM_URL;
    const broadcast = values.TRUSTLESS_BROADCAST_URL;
    if (fulcrum.value && broadcast.value && serverOf(fulcrum.value) === serverOf(broadcast.value)) {
      problems.push(`${broadcast.setBy[0]} names the same server as ${fulcrum.setBy[0]}: name a second one, so no one server sees a wallet and its withdrawal.`);
    }
    // The factories a page indexes the network's pools from.
    const bundled = bundledDeployments[id]?.factories;
    for (const kind of ['bch', 'token'] as const) {
      const variable = FACTORY_VARIABLES[kind];
      const value = values[variable].value?.toLowerCase();
      if (lacks(variable)) {
        problems.push(`Set ${names(variable)} to the category of ${id}'s ${kind === 'bch' ? 'BCH' : 'token'} pool factory, 64 hex digits: deployments/${id}.json names it under factories.${offeredBy}`);
      } else if (value && CATEGORY.test(value) && bundled?.[kind] && bundled[kind]!.trim().toLowerCase() !== value) {
        problems.push(`${values[variable].setBy[0]} names another factory than web/deployments/${id}.json, which names ${bundled[kind]}.`);
      }
    }
  }
  if (known && !offered.includes(network)) {
    const prefix = `${network.toUpperCase()}_`;
    const other = offered.find((id) => id !== network);
    problems.push(`POOL_NETWORK is ${network}, but nothing here sets ${network} up: set ${prefix}TRUSTLESS_FULCRUM_URL, ${prefix}TRUSTLESS_BROADCAST_URL, ${prefix}BCH_FACTORY and ${prefix}TOKEN_FACTORY, or the same names without ${prefix}${other ? `, or set POOL_NETWORK to ${other}, which this deployment offers` : ''}.`);
  }

  // Each setting's form, under every name it may have. The page reads every server itself, from an
  // https page, so only an encrypted WebSocket reaches them.
  const everyName = (variable: NetworkVariable) => [variable, ...PUBLIC_NETWORKS.map((id) => prefixed(id, variable))];
  for (const name of [...everyName('TRUSTLESS_FULCRUM_URL'), ...everyName('TRUSTLESS_BROADCAST_URL'), 'WALLETCONNECT_RELAY_URL']) {
    const value = read(name);
    if (value && urlOf(value)?.protocol !== 'wss:') problems.push(`${name} must be a wss:// URL, not ${value}.`);
  }
  for (const name of [...everyName('BCH_FACTORY'), ...everyName('TOKEN_FACTORY')]) {
    const value = read(name);
    if (value && !CATEGORY.test(value.toLowerCase())) problems.push(`${name} is a factory's category, 64 hex digits.`);
  }
  // This server reads each indexer's pool list, and every browser its archive.
  for (const name of everyName('INDEXER_URL')) {
    const value = read(name);
    if (value && !publicHttps(value)) {
      problems.push(`${name} must be a public https:// URL, which browsers reach as well as this server, not ${value}.`);
    }
  }

  const project = walletConnectProject(env);
  if (isPublic && !project) {
    problems.push('Set WALLETCONNECT_PROJECT_ID to the WalletConnect Cloud project of this deployment, with its domain allowed there.');
  } else if (project && !WALLETCONNECT_PROJECT.test(project)) {
    problems.push('WALLETCONNECT_PROJECT_ID is a WalletConnect Cloud project id, 32 hex digits.');
  }

  const bcmr = read('BCMR_SERVICE_URL');
  if (bcmr && urlOf(bcmr)?.protocol !== 'https:') problems.push(`BCMR_SERVICE_URL must be an https:// URL, not ${bcmr}.`);

  // Link previews name the page's address; without it they would name this server's localhost.
  const site = siteUrl(env);
  if (isPublic && !site) problems.push('Set SITE_URL to the public https:// origin this deployment is served at, which link previews point to.');
  else if (site && !publicHttps(site)) problems.push(`SITE_URL must be the public https:// origin of this deployment, not ${site}.`);

  // The page as served is conveyed under the GPL-3.0: it links every browser to its source.
  const source = sourceUrl(env);
  if (isPublic && !source) {
    problems.push('Set SOURCE_URL to the public https:// address of this build\'s exact source, such as its commit or tag in a public repository: the page links to it.');
  } else if (source && !publicHttps(source)) {
    problems.push(`SOURCE_URL must be a public https:// address of this build's source, not ${source}.`);
  }
  return problems;
}
