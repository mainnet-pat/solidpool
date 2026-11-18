// Check a deployment against the source, so nobody has to take its word for it.
//
//   FULCRUM_URL=... tsx scripts/verify-deployment.ts deployments/mainnet.json [--write-web]
//
// The locks are derived here from the checked-in artifacts and each category, so a factory or
// pool with other code has another address and would hold no state. Each factory's genesis must
// hold one master, one state record that has made nothing, its identity and nothing else; each
// pool must be made through its kind's factory, whose `PoolCreated` names it. The artifacts must
// be what their sources compile to, which --write-web checks itself (scripts/check-contracts.ts),
// and the deployment must name the SolidCash they were built with.
//
// The server must follow the deployment's network. The page bundles its own copy of the file,
// web/deployments/<network>.json, and trusts the factories it names: it lists a pool, the file's
// own included, only once one of them is seen on chain to have made it. This says whether that copy
// is in step, and --write-web writes it only when every check here has passed.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factoryGenesisProblems, poolReport } from './lib/genesis';
import { REAL_NETWORKS, connectServer, webDeploymentFileOf, type DeploymentFile } from './lib/network';
import { solidcashBuild } from './lib/solidcash-build';
import { PoolClient } from '../web/src/pool-client';
import { poolCreatedAddress } from '../web/src/factory';
import { isPoolDenomination } from '../web/src/pools';

const args = process.argv.slice(2);
const writeWeb = args.includes('--write-web');
const [file] = args.filter((arg) => !arg.startsWith('--'));
const fulcrumUrl = process.env.FULCRUM_URL?.trim();
if (!file || !fulcrumUrl) throw new Error('Usage: FULCRUM_URL=... tsx scripts/verify-deployment.ts <deployment.json> [--write-web]');
const text = readFileSync(file, 'utf8');
const deployment = JSON.parse(text) as DeploymentFile;
if (!(REAL_NETWORKS as readonly string[]).includes(deployment.network)) throw new Error(`${file} names the network ${deployment.network}.`);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

let bad = 0;
const build = solidcashBuild();
console.log('SolidCash', deployment.solidcash?.version ?? '(not named)', 'deployed;', build.version, 'here');
if (deployment.solidcash?.version !== build.version) {
  // Other artifacts give other locks, which the checks below then refuse; the page's copy is never
  // written from a build the deployment was not made with.
  console.log('  note    ', 'the locks below are derived from this build\'s artifacts');
  if (writeWeb) bad += 1;
}
// The locks below are derived from the artifacts, so the page's copy is written only when they are
// what their sources compile to: artifacts changed before a deployment would match it here.
if (writeWeb) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const checked = spawnSync(join(root, 'node_modules', '.bin', 'tsx'), [join(root, 'scripts', 'check-contracts.ts')], { stdio: 'inherit' });
  console.log('artifacts', checked.status === 0 ? 'match their sources' : 'REFUSED: they are not what their sources compile to');
  if (checked.status !== 0) bad += 1;
}
// The app reads a network's factories as <NETWORK>_BCH_FACTORY and _TOKEN_FACTORY, and as the bare
// BCH_FACTORY and TOKEN_FACTORY where POOL_NETWORK names that network (prefixed() and networkValues()
// in web/lib/deployment.ts). Those of this deployment's network that are set here must be the
// deployment's own, whose geneses are checked below; another factory is refused, unchecked. Another
// network's settings are not this deployment's, so a shell that holds them changes nothing here.
const prefix = deployment.network === 'mainnet' || deployment.network === 'chipnet' ? deployment.network.toUpperCase() : undefined;
const factoryNames = (variable: string): string[] => [
  ...(prefix ? [`${prefix}_${variable}`] : []),
  ...(process.env.POOL_NETWORK?.trim() === deployment.network ? [variable] : []),
];
for (const [name, kind] of [...factoryNames('BCH_FACTORY').map((name) => [name, 'bch'] as const),
  ...factoryNames('TOKEN_FACTORY').map((name) => [name, 'token'] as const)]) {
  const named = process.env[name]?.trim().toLowerCase();
  if (!named) continue;
  if (named === deployment.factories?.[kind]) console.log(name, 'is the deployment\'s', kind, 'factory, checked below');
  else {
    console.log(name, 'REFUSED');
    console.log('  problem ', `the environment names ${named}, and the deployment ${deployment.factories?.[kind] ?? '(none)'}`);
    bad += 1;
  }
}
const { reader, provider } = await connectServer(deployment.network, fulcrumUrl);
if (!deployment.factories?.bch || !deployment.factories?.token) {
  console.log('the deployment does not name both factories');
  bad += 1;
}
for (const kind of ['bch', 'token'] as const) {
  if (deployment.pending?.[kind]) {
    console.log(`the ${kind} factory ${deployment.pending[kind]} is still pending: run deploy-factories.ts again to adopt or make it`);
    bad += 1;
  }
}
for (const kind of ['bch', 'token'] as const) {
  const category = deployment.factories?.[kind];
  if (!category) continue;
  const problems = await factoryGenesisProblems(kind, category, reader, provider);
  const events = poolCreatedAddress(kind, category, deployment.network);
  console.log(`${kind} factory`, problems.length ? 'REFUSED' : 'ok');
  for (const problem of problems) console.log('  problem ', problem);
  console.log('  category', category);
  console.log('  events  ', events);
  if (deployment.events?.[kind] !== events) {
    console.log('  problem ', `the deployment names the event address ${deployment.events?.[kind] ?? '(none)'}`);
    bad += 1;
  }
  if (problems.length) bad += 1;
}

const pools = Array.isArray(deployment.pools) ? deployment.pools : [];
if (pools !== deployment.pools) {
  console.log('the deployment has no list of pools');
  bad += 1;
}
for (const pool of pools) {
  const problems: string[] = [];
  // A note names its pool by id, and the page reads only a note of this form back.
  if (!/^[a-z0-9]+$/.test(String(pool.id))) problems.push(`its id ${pool.id} is not lowercase letters and digits`);
  if (pools.filter((other) => other.id === pool.id).length > 1) problems.push('another pool has its id');
  if (pools.filter((other) => other.category === pool.category).length > 1) problems.push('another pool has its category');
  if (!/^\d+$/.test(String(pool.denomination)) || !isPoolDenomination(pool.kind, BigInt(pool.denomination))) {
    problems.push(`${pool.denomination} is no ${pool.kind} pool's denomination`);
    console.log(pool.id, 'REFUSED');
    for (const problem of problems) console.log('  problem ', problem);
    bad += 1;
    continue;
  }
  const client = new PoolClient({ ...pool, denomination: BigInt(pool.denomination) }, provider);
  const factory = deployment.factories?.[pool.kind];
  if (!factory || pool.creator !== factory) problems.push(`its creator ${pool.creator} is not the deployment's ${pool.kind} factory`);
  const report = await poolReport(client, reader, factory ?? pool.creator);
  problems.push(...report.problems);
  console.log(pool.id, problems.length === 0 ? 'ok' : 'REFUSED');
  for (const problem of problems) console.log('  problem ', problem);
  console.log('  pool    ', client.contract.address);
  console.log('  creator ', pool.creator);
  console.log('  verifier', hex(client.verifier.lock), `${report.verifierCoins} coins, shared by every pool`);
  console.log('  workers ', hex(client.workerLock), `${report.workerCoins} coins, shared by every pool`);
  console.log('  satoshi ', client.contract.getSatoshiContainerAddress(), `${report.satoshiCoins} coins`);
  if (pool.asset) console.log('  token   ', client.contract.tokens[pool.asset].address, `${report.tokenCoins} coins`);
  console.log('  notes   ', report.notes, 'stage', report.stage);
  if (problems.length) bad += 1;
}

// The page's copy: the same file, byte for byte, written only once all of the above has passed.
const web = webDeploymentFileOf(deployment.network);
if (web) {
  const inStep = existsSync(web) && readFileSync(web, 'utf8') === text;
  console.log('web copy', web, inStep ? 'in step' : `differs from ${file}`);
  if (writeWeb && !inStep) {
    if (bad) console.log('  not written: the checks above did not all pass');
    else {
      writeFileSync(web, text);
      console.log('  written');
    }
  }
}
console.log(bad ? `${bad} REFUSED` : 'all checks passed');
process.exit(bad ? 1 : 0);
