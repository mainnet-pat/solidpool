// The tree's far ends. Reaching leaf 1,024 or the last leaf needs a million deposits, so
// these run a copy of the contract that starts at that index with a frontier computed
// here. Nothing else in the contract changes, and the root it reaches is compared with
// the tree the circuit proves against.
//   tsx contracts/test/tree-edges.ts (npm run test:contracts runs it with the other suites)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileString } from '@solidcash/solidc';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import { sha256 } from '@bitauth/libauth';
import { PoolClient, RECENT_ROOTS, depositValue, le32, poolArguments, stepWitness, topUpSidecars } from '../../web/src/pool-client';
import { MimcTree, mimcSponge } from '../../web/src/mimc';
import { SEED_SATOSHIS } from '../../web/src/pools';
import { DENOMINATION, SIGNER_COIN, lockOf, reporter } from './lib/setup';

const { check, rejects, finish } = reporter();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const packed = (values: bigint[]) => Uint8Array.from(Buffer.concat(values.map(le32)));
const contracts = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(contracts, 'BchPool.scash'), 'utf8');
// The pool imports its pinned hashing and verifier locks.
const resolver = (importPath: string, currentFile: string) => {
  const id = join(dirname(currentFile), importPath);
  return { id, source: readFileSync(id, 'utf8') };
};

/** The contract, starting with `leaves` notes behind it. */
function startingAt(leaves: number, frontier: bigint[], recent: bigint[]) {
  const digest = (bytes: Uint8Array) => `0x${hex(sha256.hash(bytes))}`;
  const patched = source
    .replace('this.treeState = sha256(ZEROS);', `this.treeState = ${digest(packed(frontier))}; this.nextIndex = ${leaves};`)
    .replace(/this\.recentRoots = sha256\(abi\.encodePacked\(\s*EMPTY_ROOT[^;]*;/, `this.recentRoots = ${digest(packed(recent))};`);
  if (patched === source) throw new Error('nothing patched');
  const { updatedAt: _updatedAt, ...artifact } = compileString(patched, { importResolver: resolver, rootFileId: join(contracts, 'BchPool.scash') } as any) as any;
  return artifact;
}

async function deployed(leaves: number, frontier: bigint[], recent: bigint[]) {
  const artifact = startingAt(leaves, frontier, recent);
  const provider: any = new MockNetworkProvider({ profile: 'production' });
  const [alice] = await provider.getSigners(1, { fundingUtxos: 8, genesisFundingUtxos: 2, satoshis: SIGNER_COIN });
  const funding = (await alice.getUtxos()).find((coin: any) => coin.vout === 0 && !coin.token && coin.satoshis >= 200_000n);
  const definition = { id: 'edge', kind: 'bch' as const, denomination: DENOMINATION, category: funding.txid };
  await StatefulContract.deploy(artifact, poolArguments(definition), {
    provider, fundingUtxo: funding, funder: alice.unlockP2PKH(), changeAddress: alice.getAddress(), initialBalance: SEED_SATOSHIS,
  } as any);
  const client = new PoolClient(definition, provider, artifact);
  const coin = (await alice.getUtxos()).filter((candidate: any) => !candidate.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
  await topUpSidecars(provider, { utxo: coin, unlocker: alice.unlockP2PKH(), change: alice.getAddress() });
  return { alice, client };
}

/** What the client needs of a pool's history, from a tree held here. */
const heldView = (zeros: bigint[], frontier: bigint[], recent: bigint[], index: number, stage: number, pending?: bigint): any => ({
  state: { nextIndex: BigInt(index), stage: BigInt(stage) },
  tree: { frontier: () => frontier, zeros, recentRoots: () => recent },
  pending,
});

/** Run a deposit and its finish, as the app does, from a frontier held here. */
async function insert(client: PoolClient, signer: any, zeros: bigint[], frontier: bigint[], recent: bigint[], index: number, leaf: bigint) {
  await client.deposit(signer, leaf, heldView(zeros, frontier, recent, index, 0));
  await client.finish(heldView(zeros, frontier, recent, index, 1, leaf));
  const first = stepWitness(frontier, leaf, index, 1, zeros);
  const second = stepWitness(first.frontier, first.node, index, 2, zeros);
  return { frontier: second.frontier, root: second.node };
}

// ---- crossing level 10, between the two hashing steps' ranges, against a real tree ----
{
  const leaves = Array.from({ length: 1_023 }, (_, i) => BigInt(i + 1));
  const tree = new MimcTree(20, leaves);
  const recent = tree.recentRoots(RECENT_ROOTS);
  const { alice, client } = await deployed(1_023, tree.frontier(), recent);

  let frontier = tree.frontier();
  let ring = recent;
  for (const index of [1_023, 1_024, 1_025]) {
    const leaf = BigInt(index + 1);
    const inserted = await insert(client, alice, tree.zeros, frontier, ring, index, leaf);
    const expected = new MimcTree(20, [...leaves, ...Array.from({ length: index - 1_022 }, (_, i) => BigInt(1_024 + i))]);
    check(inserted.root === expected.root(), `leaf ${index}: the contract's root is the circuit's tree root`);
    check(hex(inserted.frontier.map((x) => le32(x)).reduce((a, b) => Uint8Array.from([...a, ...b]))) === hex(packed(expected.frontier())), `leaf ${index}: the frontier matches`);
    frontier = inserted.frontier;
    ring = [...ring.slice(1), inserted.root];
  }
  const state = await client.contract.getState();
  check(hex(state.recentRoots) === hex(sha256.hash(packed(ring))), 'the recent roots match');
  check(Number(state.nextIndex) === 1_026 && Number(state.stage) === 0, 'the pool counted the notes');
}

// ---- the last leaf, then a full tree ----
{
  const last = 1_048_575;
  // Every bit of the index is 1, so every level hashes against the frontier.
  const zeros = new MimcTree(20).zeros;
  const frontier = zeros.slice(0, 20).map((_, level) => mimcSponge([BigInt(level + 1), BigInt(level + 2)]));
  const recent = Array.from({ length: RECENT_ROOTS }, (_, i) => BigInt(1_000 + i));
  const { alice, client } = await deployed(last, frontier, recent);
  const leaf = 424_242n;
  const inserted = await insert(client, alice, zeros, frontier, recent, last, leaf);
  let expected = leaf;
  for (let level = 0; level < 20; level += 1) expected = mimcSponge([frontier[level], expected]);
  check(inserted.root === expected, 'the last leaf hashes against the frontier at every level');
  const state = await client.contract.getState();
  check(Number(state.nextIndex) === 1_048_576, 'the tree is full');
  await rejects('a deposit into a full tree', /full/, () => client.deposit(alice, 5n, heldView(zeros, inserted.frontier, recent, 1_048_576, 0)));
  console.log('a deposit into this pool would need', depositValue(client.pool), 'sat');
}
finish();
