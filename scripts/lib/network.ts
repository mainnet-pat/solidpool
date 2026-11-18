// What every script that spends on a real network checks before it does: which network, that the
// server follows it, the deployer's key, the server's relay fee, and the SolidCash it builds with.
//
//   POOL_NETWORK=chipnet FULCRUM_URL=wss://... tsx scripts/<script>.ts
//   npm run deploy -- chipnet [--server wss://...] [--key-file <path>]
//
// The scripts name the network and server in POOL_NETWORK and FULCRUM_URL; the deploy command
// (scripts/deploy-network.ts) passes them, and a key file, from its command line. The deployer's key
// is typed at a prompt that does not show it, or read from a file only its owner can read (chmod
// 600): --key-file, or DEPLOYER_KEY_FILE. It is never taken from the environment, where a variable a
// shell exports reaches every process it starts, nor from the command line, which the shell's history
// and the list of processes keep. Mainnet refuses to run without CONFIRM_MAINNET=1. regtest is for
// rehearsals against a local node (scripts/regtest.sh).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Signer } from '@solidcash/solidcash';
import { seedLogicalNonce } from '@solidcash/solidcash/dist/network/logical-nonce.js';
import { Fulcrum } from '../../web/src/fulcrum';
import { FulcrumProvider } from '../../web/src/provider';
import { serverNetworkProblem, serverUrlProblem } from '../../web/src/network-check';
import { describeSolidcash, solidcashBuild } from './solidcash-build';

export type RealNetwork = 'mainnet' | 'chipnet' | 'regtest';
export const REAL_NETWORKS: readonly RealNetwork[] = ['mainnet', 'chipnet', 'regtest'];

export interface DeploymentFile {
  network: RealNetwork;
  solidcash: { version: string };
  /** The categories of the pool factories, which every pool here is made through. A run that stopped may have made one. */
  factories: { bch?: string; token?: string };
  /** The addresses their `PoolCreated` events are paid to, which an indexer follows. */
  events: { bch?: string; token?: string };
  /**
   * A factory's category, chosen and written down before its genesis goes out: the txid of the coin
   * that genesis spends. A run that stopped after writing it adopts the factory, or makes it from
   * that coin; verify-deployment refuses a file with one left.
   */
  pending?: { bch?: string; token?: string };
  pools: Array<{
    id: string; kind: 'bch' | 'token'; name: string; symbol: string; decimals: number; denomination: string;
    category: string; asset?: string; creator: string;
  }>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file the scripts keep: DEPLOYMENT_FILE, else deployments/<network>.json of this repository. */
export const deploymentFileOf = (network: string): string => (
  process.env.DEPLOYMENT_FILE ? resolve(process.env.DEPLOYMENT_FILE) : join(ROOT, 'deployments', `${network}.json`));

/**
 * The copy the app bundles, whose factories the page trusts: it lists a pool only once one of them
 * is seen on chain to have made it. A rehearsal's network has none.
 */
export const webDeploymentFileOf = (network: string): string | undefined => (
  network === 'mainnet' || network === 'chipnet' ? join(ROOT, 'web', 'deployments', `${network}.json`) : undefined);

export const readDeployment = (file: string): DeploymentFile => JSON.parse(readFileSync(file, 'utf8'));

/** Written beside the file and renamed over it, so a run that stops never leaves half a file. */
export function writeDeployment(file: string, deployment: DeploymentFile): void {
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(deployment, null, 2)}\n`);
  renameSync(next, file);
}

/**
 * Why the page's copy of a deployment and this one cannot both be right, if they cannot: the page
 * names factories that this file does not. A run that wrote this file again would leave the page
 * and the scripts on different factories.
 */
export function webCopyConflict(network: string, file: string, deployment?: Partial<DeploymentFile>): string | undefined {
  const web = webDeploymentFileOf(network);
  if (!web || !existsSync(web)) return undefined;
  const named = (readDeployment(web) as Partial<DeploymentFile>).factories ?? {};
  for (const kind of ['bch', 'token'] as const) {
    if (named[kind] && named[kind] !== deployment?.factories?.[kind]) {
      return `${web} names the ${kind} factory ${named[kind]}, which ${file} does not: restore ${file} from it before anything runs.`;
    }
  }
  return undefined;
}

/**
 * A server, refused unless it follows `network`. Mainnet and chipnet are read over TLS, or over a
 * plain ws:// only from this machine or its private network, before anything is asked: on any other
 * path a stranger could answer for the server, the genesis checks included.
 */
export async function connectServer(network: RealNetwork, fulcrumUrl: string) {
  const plain = serverUrlProblem(network, fulcrumUrl, { nearbyPlain: true });
  if (plain) throw new Error(`${fulcrumUrl}: ${plain}.`);
  const reader = new Fulcrum(fulcrumUrl);
  // The name is only a name, so the server has to agree before anything reads or spends. Mainnet's
  // guard means nothing if a chipnet run can point at a mainnet server.
  const problem = await serverNetworkProblem(network, (method, params) => reader.call(method, params));
  if (problem) throw new Error(`${fulcrumUrl} is not a ${network} server: ${problem}.`);
  return { reader, provider: new FulcrumProvider(network, reader) };
}

type Env = Record<string, string | undefined>;

const HEX_KEY = /^(0x)?[0-9a-f]{64}$/i;
const WIF_KEY = /^[1-9A-HJ-NP-Za-km-z]{51,52}$/;

/** Whether `text` has a private key's form: 64 hex digits, or a WIF. */
export const hasKeyForm = (text: string): boolean => HEX_KEY.test(text.trim()) || WIF_KEY.test(text.trim());

/** A key's form, checked without ever repeating it: 64 hex digits, or a WIF. */
function keyOfForm(text: string, from: string): string {
  const key = text.trim();
  if (HEX_KEY.test(key)) return key.replace(/^0x/i, '').toLowerCase();
  if (WIF_KEY.test(key)) return key;
  throw new Error(`${from} holds no private key: 64 hex digits or a WIF. Its value is not shown.`);
}

/**
 * Where the deployer's key will come from, checked before anything connects: a file, read now, or
 * else a prompt at this terminal, typed once the server has passed its checks. The file is
 * `keyFile`, which the deploy command takes as --key-file, else the one DEPLOYER_KEY_FILE names.
 * DEPLOYER_KEY itself is refused, since a key in the environment reaches every process that
 * environment starts, and a file others can read is refused too.
 */
export function deployerKeySource(
  env: Env = process.env, terminal = Boolean(process.stdin.isTTY), { keyFile }: { keyFile?: string } = {},
): { key: string } | { prompt: true } {
  // How the file is named, for the messages: the command line's option, or the variable.
  const option = keyFile === undefined ? 'DEPLOYER_KEY_FILE' : '--key-file';
  if (env.DEPLOYER_KEY !== undefined) {
    throw new Error('DEPLOYER_KEY is not read: a key in the environment reaches every process that environment starts. '
      + `Unset it, and type the key at the prompt or name a file only you can read in ${option}.`);
  }
  const file = (keyFile ?? env.DEPLOYER_KEY_FILE)?.trim();
  if (file) {
    let stat;
    try { stat = statSync(file); } catch { throw new Error(`${option} ${file} cannot be read.`); }
    if (!stat.isFile()) throw new Error(`${option} ${file} is not a file.`);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`${option} ${file} can be read by others (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it first.`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${option} ${file} belongs to another user.`);
    return { key: keyOfForm(readFileSync(file, 'utf8'), option) };
  }
  if (keyFile !== undefined) throw new Error('--key-file names no file.');
  if (!terminal) throw new Error('Name the deployer key\'s file in DEPLOYER_KEY_FILE (chmod 600), or run this at a terminal to type the key.');
  return { prompt: true };
}

/** Mainnet spends real money, so nothing runs there without CONFIRM_MAINNET=1. */
export function confirmMainnet(network: string, env: Env = process.env): void {
  if (network === 'mainnet' && env.CONFIRM_MAINNET !== '1') {
    throw new Error('This spends real money. Set CONFIRM_MAINNET=1 once an independent review of the contracts and verifier has passed.');
  }
}

/** The key, typed at this terminal with nothing shown, not even its length. */
function promptForKey(): Promise<string> {
  const input = process.stdin;
  process.stderr.write('Deployer key (not shown): ');
  return new Promise((resolve, reject) => {
    let typed = '';
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(typed);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') { done(); return; }
        if (char === '\u0003') { done(new Error('Stopped at the key prompt.')); return; }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
/** These scripts' transactions pay 1 sat/B: SolidCash 0.51.1 builds at that rate, and so do the scripts' own. */
const MOST_RELAY_FEE_PER_KB = 1_000n;

/** What a script names for connectDeployer: each is taken from the environment where it is not given. */
export interface DeployerOptions {
  /** The network: POOL_NETWORK otherwise. */
  network?: string;
  /** Its Fulcrum server: FULCRUM_URL otherwise. */
  fulcrumUrl?: string;
  /** A file that holds the key, held to what DEPLOYER_KEY_FILE is held to: DEPLOYER_KEY_FILE otherwise. */
  keyFile?: string;
}

/**
 * The network, the server, a provider and the deployer's signer, after every guard has passed. The
 * key is read or asked for once, here.
 */
export async function connectDeployer(options: DeployerOptions = {}) {
  const network = (options.network ?? process.env.POOL_NETWORK)?.trim() ?? '';
  const fulcrumUrl = (options.fulcrumUrl ?? process.env.FULCRUM_URL)?.trim() ?? '';
  const source = deployerKeySource(process.env, Boolean(process.stdin.isTTY), { keyFile: options.keyFile });
  if (!network || !fulcrumUrl) throw new Error('Set POOL_NETWORK and FULCRUM_URL.');
  if (!(REAL_NETWORKS as readonly string[]).includes(network)) throw new Error(`POOL_NETWORK is mainnet or chipnet, not ${network}.`);
  confirmMainnet(network);
  const { reader, provider } = await connectServer(network as RealNetwork, fulcrumUrl);
  // A transaction under the node's floor is refused at broadcast, after the steps before it spent.
  const relayFee = await reader.relayFee();
  if (relayFee > MOST_RELAY_FEE_PER_KB) {
    throw new Error(`${fulcrumUrl}'s node relays nothing under ${relayFee} sat per 1,000 bytes, and these transactions pay 1 sat/B.`);
  }
  // Typed only once the server has passed, so nobody types a key into a run that would stop anyway.
  const key = 'key' in source ? source.key : keyOfForm(await promptForKey(), 'The typed key');
  let signer: Signer;
  try {
    signer = new Signer(key, provider as any);
  } catch (error) {
    throw new Error(`The deployer key is not a usable private key (${(error as Error).message}). Its value is not shown.`);
  }
  // A factory's genesis anchors its identity at an address derived from the deployer and a count of
  // its deployments. SolidCash's own providers read that count off the chain before a deployment;
  // this one does not, so it is read here. Otherwise every run counts from 0, and a second run from
  // one key, such as one resuming after a stop, anchors where the first did: SolidCash then refuses
  // the factory after its genesis is sent, and the run records nothing.
  await seedLogicalNonce(provider as any, signer, new WeakSet());
  // The artifacts name the compiler too; a deployment records the packages behind its locks.
  const build = solidcashBuild();
  console.log(network, 'server', fulcrumUrl, 'relay fee', `${relayFee} sat/kB`);
  console.log('deployer', signer.getAddress(), `${await plainHeld(signer)} sat in plain coins`);
  console.log(describeSolidcash(build));
  return { network: network as RealNetwork, fulcrumUrl, reader, provider, signer, solidcash: { version: build.version } };
}

/** A deployer that has passed connectDeployer's guards. */
export type Deployer = Awaited<ReturnType<typeof connectDeployer>>;

/** What a signer holds in plain coins, those with no token, in satoshis. */
export async function plainHeld(signer: Signer): Promise<bigint> {
  return (await signer.getUtxos()).filter((coin: any) => !coin.token)
    .reduce((sum: bigint, coin: any) => sum + BigInt(coin.satoshis), 0n);
}
