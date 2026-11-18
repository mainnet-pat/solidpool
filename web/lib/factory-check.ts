// The factories a production server trusts, checked as it starts: each offered network's two, its
// BCH_FACTORY and TOKEN_FACTORY, which must also be the ones its bundled deployment names
// (deployment.ts, productionProblems). Each one's genesis is read through that network's own first
// server, its TRUSTLESS_FULCRUM_URL, and held to what verify-deployment holds
// it to (scripts/lib/genesis.ts): one master at the factory's lock, one state record that has made
// nothing, its identity and nothing else of its category, from the mempool on. A page lists a pool only
// once one of these factories made it, so a factory whose genesis kept a second master back could
// otherwise vouch for pools of anyone's making.
//
// It runs where the server runs, from instrumentation.ts, and not in a build: it loads SolidCash.
import { factoryGenesisProblems } from '../../scripts/lib/genesis';
import { Fulcrum } from '../src/fulcrum';
import { FulcrumProvider } from '../src/provider';
import { PUBLIC_NETWORKS, type PublicNetworkId } from './deployment';
import { configuredFactories, type ConfiguredFactory } from './settings-check';

type Env = Record<string, string | undefined>;

/** Why one network's factories will not do, or could not be checked, read through its own first server. */
async function networkFactoryProblems(network: PublicNetworkId, named: ConfiguredFactory[]): Promise<string[]> {
  if (!named.length) return [];
  const { url } = named[0];
  if (!url) {
    return named.map(({ name, category }) => `${name} ${category} could not be checked: no server of ${network} is named, so it is not trusted.`);
  }
  const reader = new Fulcrum(url);
  const provider = new FulcrumProvider(network, reader);
  const problems: string[] = [];
  try {
    for (const { kind, name, category } of named) {
      try {
        const found = await factoryGenesisProblems(kind, category, reader as any, provider as any);
        problems.push(...found.map((problem) => `${name} ${category} is no sound ${kind} factory on ${network}: ${problem}.`));
      } catch (error) {
        problems.push(`${name} ${category} could not be checked through ${url} (${(error as Error).message}), so it is not trusted.`);
      }
    }
  } finally {
    reader.close();
  }
  return problems;
}

/** Why the factories this server would trust, on every network it offers, will not do, or could not be checked. */
export async function factoryProblems(env: Env = process.env): Promise<string[]> {
  const factories = configuredFactories(env);
  return (await Promise.all(PUBLIC_NETWORKS.map((network) => (
    networkFactoryProblems(network, factories.filter((factory) => factory.network === network)))))).flat();
}

/** Stop this process if a factory it would trust will not do. `what` is what will not happen. */
export async function stopOnFactories(what: string): Promise<void> {
  const problems = await factoryProblems();
  if (!problems.length) return;
  console.error([`${what} until its factories are sound:`, ...problems.map((problem) => `  - ${problem}`),
    'Run scripts/verify-deployment.ts on the deployment, and see PRODUCTION.md.'].join('\n'));
  process.exit(1);
}
