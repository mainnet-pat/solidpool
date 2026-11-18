// Deploy SolidPool to a network in one command: its two pool factories, the float of hashing and
// verifier coins every pool shares, and a check of both against the source.
//
//   npm run deploy -- <network> [--server <url>] [--key-file <path>]
//
// <network> is mainnet or chipnet, or regtest for a rehearsal on a local node (scripts/regtest.sh),
// which needs --server. Without --server the network is read from the first public Fulcrum server
// the page's Settings offer for it (web/src/known-servers.ts). The deployer's key, a WIF, is typed at
// a prompt that shows nothing, or read from a file only its owner can read (chmod 600): --key-file,
// or DEPLOYER_KEY_FILE. It is never taken from the command line or the environment, and anything on
// the command line of a key's form is refused before anything connects. Every guard of
// scripts/lib/network.ts applies, and mainnet refuses to run without CONFIRM_MAINNET=1.
//
// One process does three steps, and asks for the key once:
// 1. The factories, as scripts/deploy-factories.ts makes them, then the float. A file that names
//    both factories means they are made, and then only a float that has run short is topped up.
// 2. scripts/verify-deployment.ts <file> --write-web, at once: a genesis counts as soon as the server
//    shows it. Once every check passes it writes web/deployments/<network>.json, the page's copy.
// 3. The settings that name the deployment, for the app and the indexer.
// It makes no pool: pools are made from the page's Create pool, and scripts/deploy.ts makes them
// from a plan, for rehearsals and tests. A run that stops can be run again with the same command,
// which does what is left, and spends nothing once everything is done.
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_SERVERS } from '../web/src/known-servers';
import {
  FACTORIES_NEED, FACTORY_KINDS, factoriesStart, floatShortfall, makeFactories, topUpFloat,
} from './lib/factories';
import {
  REAL_NETWORKS, confirmMainnet, connectDeployer, hasKeyForm, plainHeld, readDeployment, webDeploymentFileOf,
  type RealNetwork,
} from './lib/network';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: npm run deploy -- <network> [--server <url>] [--key-file <path>]

Deploys SolidPool's two pool factories to <network>, with a float of the hashing and verifier
coins every pool shares, checks them against the source, and prints the settings that name
them. It makes no pool: pools are made from the page's Create pool.

  <network>          mainnet or chipnet, or regtest for a rehearsal on a local node
  --server <url>     the network's Fulcrum server, wss:// (or ws:// on this machine or its
                     private network). By default the first one the page's Settings offer:
                     ${KNOWN_SERVERS.mainnet[0].url} on mainnet,
                     ${KNOWN_SERVERS.chipnet[0].url} on chipnet. regtest needs one.
  --key-file <path>  a file only you can read (chmod 600) that holds the deployer's key, a WIF.
                     DEPLOYER_KEY_FILE names one too. Without either, the key is typed at a
                     prompt that shows nothing. It is never taken from the command line or
                     the environment.

Mainnet needs CONFIRM_MAINNET=1. The same command, run again, finishes a run that stopped.`;

interface Options { network: RealNetwork; server: string; keyFile?: string }

/** The command line, refused before anything connects, and never repeated where it holds a key. */
function parse(args: readonly string[]): Options | 'help' {
  // A key on the command line stays in the shell's history and in the list of processes.
  if (args.some((arg) => arg.split('=').some(hasKeyForm))) {
    throw new Error('Something on the command line has the form of a private key, a WIF or 64 hex digits, and is not shown. '
      + 'A key is never taken from the command line, where the shell\'s history and the list of processes keep it: '
      + 'type it at the prompt, or name a file only you can read (chmod 600) with --key-file. '
      + 'If that was a real key, take it out of your shell\'s history.');
  }
  const named: string[] = [];
  let server: string | undefined;
  let keyFile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return 'help';
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const option = equals > 0 ? arg.slice(0, equals) : arg;
    if (option === '--server' || option === '--key-file') {
      const value = equals > 0 ? arg.slice(equals + 1) : args[(i += 1)];
      if (!value || (equals < 0 && value.startsWith('-'))) throw new Error(`${option} needs a value.\n\n${USAGE}`);
      if (option === '--server') server = value; else keyFile = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`There is no option ${option}.\n\n${USAGE}`);
    } else {
      named.push(arg);
    }
  }
  if (named.length !== 1) throw new Error(`Name one network.\n\n${USAGE}`);
  const [network] = named;
  if (!(REAL_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`There is no network ${network} to deploy to: mainnet or chipnet, or regtest for a rehearsal.\n\n${USAGE}`);
  }
  if (network === 'regtest' && !server) {
    throw new Error('regtest is a local node\'s: name its Fulcrum server with --server, such as ws://127.0.0.1:60003 from scripts/regtest.sh.');
  }
  const known = network === 'regtest' ? undefined : KNOWN_SERVERS[network as 'mainnet' | 'chipnet'][0].url;
  return { network: network as RealNetwork, server: server ?? known!, keyFile };
}

/** An amount of satoshis, as people read one. */
const sat = (amount: bigint) => `${amount.toLocaleString('en-US')} sat`;
/** A path from where the command runs, where it is beneath it. */
const shown = (path: string) => (relative(process.cwd(), path).startsWith('..') ? path : relative(process.cwd(), path));

/** A line per row, its labels padded to one width. */
const table = (rows: Array<[string, string]>) => {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`);
};

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options === 'help') {
    console.log(USAGE);
    return 0;
  }
  const { network, server, keyFile } = options;
  confirmMainnet(network);
  // With no terminal to type it at, the key comes from a file (DEPLOYER_KEY itself is refused below).
  if (!process.stdin.isTTY && keyFile === undefined && !process.env.DEPLOYER_KEY_FILE?.trim() && process.env.DEPLOYER_KEY === undefined) {
    throw new Error('There is no terminal here to type the deployer\'s key at: name a file only you can read (chmod 600) that holds it, with --key-file.');
  }
  // The file is checked before anything connects, or a key is asked for.
  const start = factoriesStart(network);
  const deployer = await connectDeployer({ network, fulcrumUrl: server, keyFile });
  const { signer } = deployer;
  const before = await plainHeld(signer);
  const short = await floatShortfall(deployer);
  const shortCount = short.workers + short.verifiers;
  const web = webDeploymentFileOf(network);

  // What this run will do, before it spends anything.
  const named = (kind: string) => (kind === 'bch' ? 'BCH' : 'token');
  const toMake = FACTORY_KINDS.filter((kind) => !start.previous?.factories?.[kind]);
  const factoriesStep = toMake.length === 0
    ? `nothing: ${shown(start.out)} names both factories`
    : `${toMake.map((kind) => (start.previous?.pending?.[kind]
      ? `finish the ${named(kind)} factory an earlier run started`
      : `make the ${named(kind)} factory`)).join(', and ')}, writing ${shown(start.out)} as it goes; this needs ${sat(FACTORIES_NEED)} in plain coins`;
  const floatStep = shortCount === 0
    ? 'nothing: the shared hashing and verifier coins are not short'
    : `pay ${short.workers} hashing and ${short.verifiers} verifier coins of 1,000 sat, which every pool shares`;
  console.log(`\nThis run deploys SolidPool to ${network} through ${server}, from ${signer.getAddress()}, which holds ${sat(before)} in plain coins.`);
  console.log('It will:');
  console.log(`  1. factories: ${factoriesStep}`);
  console.log(`  2. shared coins: ${floatStep}`);
  console.log(`  3. check the deployment against the source with verify-deployment.ts --write-web${web ? `, which writes ${shown(web)} once every check passes` : ''}`);
  console.log('  4. print the settings that name it');
  console.log('It makes no pool: pools are made from the page\'s Create pool.\n');

  // 1. The factories, and the float.
  if (toMake.length > 0) await makeFactories(deployer, start);
  let toppedUp: string | undefined;
  try {
    toppedUp = await topUpFloat(deployer);
  } catch (error) {
    throw new Error(`The factories are made and written, but the shared coins were not topped up: ${(error as Error).message} `
      + 'Run the same command again.');
  }
  console.log(toppedUp ? `hashing and verifier coins topped up in ${toppedUp}` : 'hashing and verifier coins were not short');
  const spent = before - await plainHeld(signer);

  // 2. The check, as anyone checks a deployment: a process of its own, from the file alone.
  console.log(`\nverify-deployment.ts ${shown(start.out)} --write-web, through ${server}:`);
  const checked = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'scripts', 'verify-deployment.ts'), start.out, '--write-web'], {
    stdio: 'inherit', env: { ...process.env, FULCRUM_URL: server },
  });
  if (checked.error) throw new Error(`verify-deployment.ts did not run: ${checked.error.message}`);
  const passed = checked.status === 0;

  console.log('');
  table([
    ['factories', toMake.length === 0 ? 'made by an earlier run' : `done in this run: ${toMake.map(named).join(' and ')}`],
    ['shared coins', toppedUp ? `topped up in ${toppedUp}` : 'were not short'],
    ['check', passed ? 'every check passed' : 'REFUSED: see what verify-deployment.ts says above'],
    ['spent', `${sat(spent)} in this run`],
  ]);
  if (!passed) {
    console.log('\nNothing that verify-deployment.ts refuses is fit to name in the app\'s settings. Look at what it names, and run the same command again.');
    return 1;
  }

  // 3. The settings that name the deployment.
  const { factories, events } = readDeployment(start.out);
  if (network === 'regtest') {
    console.log('\nregtest is a rehearsal, which no app or indexer serves. Its factories, and the addresses their PoolCreated events are paid to:');
    table(FACTORY_KINDS.map((kind): [string, string] => [`${kind} factory`, `${factories[kind]}, events at ${events[kind]}`]));
    return 0;
  }
  const prefix = network.toUpperCase();
  console.log(`\nThe settings that name this deployment, for ${network}:`);
  console.log(`  ${prefix}_BCH_FACTORY=${factories.bch}`);
  console.log(`  ${prefix}_TOKEN_FACTORY=${factories.token}`);
  console.log(`In web/.env these two are what the app reads for ${network}. The unprefixed BCH_FACTORY and TOKEN_FACTORY`);
  console.log(`still mean POOL_NETWORK's network (POOL_NETWORK=${network} for one that opens on ${network}), and the indexer`);
  console.log('container reads those. The addresses the factories\' PoolCreated events are paid to, which the indexer follows:');
  table(FACTORY_KINDS.map((kind): [string, string] => [kind, events[kind]!]));
  console.log('PRODUCTION.md ("Deploy") lists the rest: the two Fulcrum servers, SITE_URL, SOURCE_URL, WALLETCONNECT_PROJECT_ID and');
  console.log(`INDEXER_URL. Commit ${shown(start.out)} and ${shown(web!)}, which name the factories now.`);
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`deploy: ${(error as Error).message}`);
  // The server's socket would keep this process alive.
  process.exit(1);
});
