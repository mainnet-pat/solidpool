// A network's two pool factories, and the float of hashing and verifier coins every pool shares:
// what scripts/deploy-factories.ts makes, and the deploy command (scripts/deploy-network.ts) first.
//
// Each factory is an ordinary genesis: the plain coin at vout 0 it spends names its category.
// Every pool of the network is then made through one of them (the app's Create pool, or
// scripts/deploy.ts from a plan), and each refuses a second pool of an amount, or of an asset and
// amount, on chain. The factories also keep the shared hashing and verifier coins topped up, at
// their first pool.
//
// A factory's category is the txid of the coin its genesis spends, so the coin is chosen first and
// its txid written to the deployment file, under `pending`, before the genesis goes out. A run that
// stops anywhere can be run again: it adopts a pending factory whose genesis went out, spends the
// same coin for one whose genesis did not, and makes only what is still missing.
import { existsSync } from 'node:fs';
import { selectGenesisFundingUtxo } from '@solidcash/solidcash/stateful';
import { deployFactory, factoryArtifact, poolCreatedAddress } from '../../web/src/factory';
import { SIDECARS_WANTED, sidecarShortfall, topUpSidecars } from '../../web/src/pool-client';
import { COIN_SATOSHIS, type PoolKind } from '../../web/src/pools';
import { factoryGenesisProblems } from './genesis';
import {
  deploymentFileOf, plainHeld, readDeployment, webCopyConflict, writeDeployment,
  type Deployer, type DeploymentFile, type RealNetwork,
} from './network';
import { solidcashBuild } from './solidcash-build';

export const FACTORY_KINDS: readonly PoolKind[] = ['bch', 'token'];

/**
 * Two geneses, each of which spends a plain coin at vout 0 that the SDK picks or makes, and the
 * float. On a network with no shared coins yet that is 40,275 sat, measured on the mock with the
 * SDK's own transactions: 12,946 for the geneses and 27,329 for the float and its fee. A run that
 * makes a factory asks for this much, and prints what it spent.
 */
export const FACTORIES_NEED = 100_000n;

/** Twice the shared coins one pool transaction spends, so two can be in flight before anyone tops up again. */
export const FLOAT = { workers: SIDECARS_WANTED.workers * 2, verifiers: SIDECARS_WANTED.verifiers * 2 };

/** A network's deployment file as a run finds it, read and checked before anything connects. */
export interface FactoriesStart {
  out: string;
  previous?: DeploymentFile;
  /** Whether an earlier run made a factory, or chose the coin of one. */
  started: boolean;
  /** Whether the file names both factories. */
  made: boolean;
}

/**
 * The deployment file of `network`, refused where a run would write over another network's, over
 * pools it did not make, or with another SolidCash than the one it was started with, or where the
 * page's copy names a factory the file does not.
 */
export function factoriesStart(network: RealNetwork, out = deploymentFileOf(network)): FactoriesStart {
  const previous = existsSync(out) ? readDeployment(out) : undefined;
  if (previous && previous.network !== network) throw new Error(`${out} is a ${previous.network} deployment, not ${network}.`);
  const conflict = webCopyConflict(network, out, previous);
  if (conflict) throw new Error(conflict);
  const started = Boolean(previous?.factories?.bch || previous?.factories?.token || previous?.pending?.bch || previous?.pending?.token);
  if (!started && previous?.pools?.length) throw new Error(`${out} lists pools but no factories, and this would write over them: move it aside first.`);
  // The two factories of a deployment come from one build, which the file records.
  const { version } = solidcashBuild();
  if (started && previous!.solidcash?.version !== version) {
    throw new Error(`${out} was started with SolidCash ${previous!.solidcash?.version}, and this is ${version}.`);
  }
  return { out, previous, started, made: Boolean(previous?.factories?.bch && previous.factories.token) };
}

/**
 * Make whichever factory the file does not name yet, writing the file after each, and return what
 * it names then. It asks the key for FACTORIES_NEED in plain coins first.
 */
export async function makeFactories(deployer: Deployer, { out, previous, started }: FactoriesStart): Promise<DeploymentFile> {
  const { network, reader, signer, provider, solidcash } = deployer;
  const plain = await plainHeld(signer);
  if (plain < FACTORIES_NEED) throw new Error(`The factories and their float need ${FACTORIES_NEED} sat in plain coins; this key holds ${plain}.`);

  const deployment: DeploymentFile = started
    ? { ...previous!, factories: { ...previous!.factories }, events: { ...previous!.events }, pending: { ...previous!.pending } }
    : { network, solidcash, factories: {}, events: {}, pending: {}, pools: [] };

  /** Record a factory as made, its category no longer pending. */
  const record = (kind: PoolKind, category: string, how: string) => {
    deployment.factories[kind] = category;
    deployment.events[kind] = poolCreatedAddress(kind, category, network);
    delete deployment.pending![kind];
    writeDeployment(out, deployment);
    console.log(`${kind} factory`, category, how);
  };

  /**
   * What became of a factory an earlier run had chosen the coin for: its genesis went out, or the
   * coin is still this key's to spend. Anything else stops the run, since only a look at the chain
   * can say what spent the coin.
   */
  const pendingFactory = async (kind: PoolKind, category: string): Promise<{ made: true } | { coin: any }> => {
    const coin = (await signer.getUtxos()).find((utxo: any) => utxo.txid === category && utxo.vout === 0 && !utxo.token);
    if (coin) return { coin };
    // Its genesis counts from the mempool on, as every genesis does.
    const problems = await factoryGenesisProblems(kind, category, reader, provider);
    if (problems.length === 0) return { made: true };
    throw new Error(`${out} names ${category} as the pending ${kind} factory, but its coin is spent and no sound factory genesis spends it `
      + `(${problems.join('; ')}). Look at that transaction before anything runs again.`);
  };

  for (const kind of FACTORY_KINDS) {
    const kept = deployment.factories[kind];
    if (kept) {
      console.log(`${kind} factory`, kept, `(made by an earlier run, from ${out})`);
      continue;
    }
    let coin: any;
    let how = '';
    const pending = deployment.pending?.[kind];
    if (pending) {
      const found = await pendingFactory(kind, pending);
      if ('made' in found) {
        record(kind, pending, '(its genesis went out in an earlier run that stopped before recording it: adopted)');
        continue;
      }
      ({ coin } = found);
      how = '(chosen by an earlier run that stopped before its genesis: made now from the same coin)';
    } else {
      // The genesis spends a plain coin at vout 0, which names the factory's category: chosen, and
      // made by a self-transfer when the key has none, before the category is written down.
      coin = await selectGenesisFundingUtxo(signer, factoryArtifact(kind));
      deployment.pending![kind] = coin.txid;
      writeDeployment(out, deployment);
    }
    const factory = await deployFactory(kind, signer, { fundingUtxo: coin, funder: signer.unlockP2PKH(), changeAddress: signer.getAddress() });
    if (factory.categoryId !== coin.txid) throw new Error(`The ${kind} factory was made as ${factory.categoryId}, not from the coin ${coin.txid} written down.`);
    record(kind, factory.categoryId, how);
  }
  console.log('wrote', out);
  return deployment;
}

/** How many hashing and verifier coins the shared locks lack for the float. */
export const floatShortfall = (deployer: Deployer) => sidecarShortfall(deployer.provider, FLOAT);

/**
 * Pay the hashing and verifier coins the shared locks lack for the float, from the key's largest
 * plain coin. Returns the transaction's id, or undefined when none was short and nothing was spent.
 */
export async function topUpFloat({ provider, signer }: Deployer): Promise<string | undefined> {
  const short = await sidecarShortfall(provider, FLOAT);
  if (short.workers + short.verifiers === 0) return undefined;
  // One plain coin pays them all, with room for the fee at 1 sat/B and the change.
  const needed = BigInt(short.workers + short.verifiers) * COIN_SATOSHIS + 2_000n;
  const funds = (await signer.getUtxos()).filter((coin: any) => !coin.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
  if (!funds || funds.satoshis < needed) {
    throw new Error(`The shared coins need one plain coin of at least ${needed} sat; this key's largest holds ${funds?.satoshis ?? 0n}.`);
  }
  const sent = await topUpSidecars(provider, { utxo: funds, unlocker: signer.unlockP2PKH(), change: signer.getAddress() }, FLOAT);
  return sent?.txid;
}
