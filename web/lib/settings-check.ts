// A production build and a production server both stop at a missing or malformed setting, naming
// it, rather than ship or serve a page on defaults nobody chose (deployment.ts, productionProblems).
// Then they ask each configured Fulcrum server whether it will do: Fulcrum 1.10 or later, on the
// network it is configured for (src/network-check.ts). A server that will not do stops them, and so
// does one that cannot be asked, whether it is down, misnamed or out of reach of this runtime: what
// was not checked is not used.
//
// A build made where no server can be reached, such as an image built with no network, may set
// SOLIDPOOL_OFFLINE_BUILD=1. It still checks every setting's form, skips only the servers, and says
// so loudly. A server always asks them as it starts, whatever that variable says.
import { checkServerAt, type CheckedNetwork } from '../src/network-check';
import {
  bareNetworkOf, networkValues, productionProblems, PUBLIC_NETWORKS, sourceUrl, type PublicNetworkId,
} from './deployment';

type Env = Record<string, string | undefined>;

/** Where a check runs: the build, which may be made offline, or the server, which never skips one. */
export type CheckPhase = 'build' | 'start';

/**
 * The servers a deployment names for mainnet and chipnet, each with the network it must follow:
 * every network's two, under its prefix or, on POOL_NETWORK's network, bare, read as the server
 * reads them (deployment.ts, networkValues).
 */
export function configuredServers(env: Env): Array<{ name: string; network: CheckedNetwork; url: string }> {
  const bare = bareNetworkOf(env);
  return PUBLIC_NETWORKS.flatMap((network) => {
    const values = networkValues(network, env, bare);
    return (['TRUSTLESS_FULCRUM_URL', 'TRUSTLESS_BROADCAST_URL'] as const).flatMap((variable) => {
      const { value, setBy } = values[variable];
      return value ? [{ name: setBy[0], network, url: value }] : [];
    });
  });
}

/** A factory a deployment names, and the server its genesis is read through as a server starts. */
export interface ConfiguredFactory {
  name: string;
  kind: 'bch' | 'token';
  network: PublicNetworkId;
  category: string;
  /** Its network's first server, or undefined where the deployment names none. */
  url?: string;
}

/**
 * The factories a deployment names for mainnet and chipnet, each to be read through its own
 * network's first server (factory-check.ts), as the servers above are named.
 */
export function configuredFactories(env: Env): ConfiguredFactory[] {
  const bare = bareNetworkOf(env);
  return PUBLIC_NETWORKS.flatMap((network) => {
    const values = networkValues(network, env, bare);
    const url = values.TRUSTLESS_FULCRUM_URL.value;
    return (['bch', 'token'] as const).flatMap((kind) => {
      const { value, setBy } = values[kind === 'bch' ? 'BCH_FACTORY' : 'TOKEN_FACTORY'];
      return value ? [{ name: setBy[0], kind, network, category: value.toLowerCase(), url }] : [];
    });
  });
}

/** Whether a build has been told it is made offline, and so leaves the servers to the start. */
export const offlineBuild = (env: Env, phase: CheckPhase): boolean => phase === 'build' && env.SOLIDPOOL_OFFLINE_BUILD === '1';

/**
 * Each configured server that will not do, or could not be checked, and the servers left unchecked
 * because the build is offline. `timeoutMs` bounds each call to a server.
 */
export async function serverProblems(
  env: Env = process.env, phase: CheckPhase = 'start', timeoutMs?: number,
): Promise<{ problems: string[]; skipped: string[] }> {
  const servers = configuredServers(env);
  if (offlineBuild(env, phase)) return { problems: [], skipped: servers.map(({ name, url }) => `${name} ${url}`) };
  const checked = await Promise.all(servers.map(async ({ name, network, url }) => ({
    name, url, ...(await checkServerAt(url, network, timeoutMs)),
  })));
  return {
    problems: checked.flatMap(({ name, url, problem, unreachable }) => {
      if (problem) return [`${name} ${url} will not do: ${problem}.`];
      if (unreachable) return [`${name} ${url} could not be checked (${unreachable}): which chain it follows and what it runs are unknown, so it is not used.`];
      return [];
    }),
    skipped: [],
  };
}

const report = (what: string, problems: string[]) => [
  `${what} until its settings are fixed:`,
  ...problems.map((problem) => `  - ${problem}`),
  'See PRODUCTION.md and web/.env.example.',
].join('\n');

const banner = (lines: string[]) => {
  const rule = '!'.repeat(78);
  return [rule, ...lines.map((line) => `!! ${line}`), rule].join('\n');
};

/**
 * The page links to the source its build was given: next.config.ts bakes SOURCE_URL into it as
 * NEXT_PUBLIC_SOURCE_URL. A server started with another would serve a Source link to a source
 * other than its own, so it stops. `built` is the baked value, which only Next's build of this
 * module has; a build, or a server Next did not build, is not held to it.
 */
export function builtSourceProblems(env: Env, phase: CheckPhase, built = process.env.NEXT_PUBLIC_SOURCE_URL): string[] {
  if (phase !== 'start' || built === undefined) return [];
  const running = sourceUrl(env) ?? '';
  return running === built ? [] : [
    `SOURCE_URL is ${running || 'not set'} here, but this build's page links to ${built || 'no source'}: build again with the source this server serves.`,
  ];
}

/** Each settings check runs once in a process, however often Next loads the config. */
const checked = new Map<string, Promise<string[]>>();

/** What stops this process, if anything: the settings' form, then the servers they name. */
export function settingsProblems(phase: CheckPhase, env: Env = process.env): Promise<string[]> {
  const key = `${phase} ${JSON.stringify(configuredServers(env))} ${JSON.stringify(productionProblems(env))} ${sourceUrl(env) ?? ''}`;
  let found = checked.get(key);
  if (!found) {
    found = (async () => {
      const problems = [...productionProblems(env), ...builtSourceProblems(env, phase)];
      if (problems.length) return problems;
      const servers = await serverProblems(env, phase);
      if (servers.skipped.length) {
        console.warn(banner([
          'SOLIDPOOL_OFFLINE_BUILD=1: this build did not ask its servers which chain they follow:',
          ...servers.skipped.map((server) => `  ${server}`),
          'The server built from it asks them as it starts, and stops if one will not do.',
        ]));
      }
      return servers.problems;
    })();
    checked.set(key, found);
  }
  return found;
}

/**
 * Stop this process if a setting is missing or malformed, or names a server that will not do or
 * cannot be checked. `what` is what will not happen until that is fixed.
 */
export async function stopWithoutSettings(what: string, phase: CheckPhase): Promise<void> {
  const problems = await settingsProblems(phase);
  if (problems.length) {
    console.error(report(what, problems));
    process.exit(1);
  }
}
