// The shipped browser prover against the production circuit and proving key, for one fixed
// witness. The proof it makes must be the fixture the shipped verifier accepts, and the
// proving path must fetch its assets by URL and run in Web Workers. This bundles with
// esbuild; the Next (Turbopack) bundle the app ships is tested by test:app.
//   tsx test/prover-compat.ts
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { parseNote } from '../web/src/note';
import { NOTE_PREFIX } from '../web/src/brand';
import { MimcTree, mimcSponge } from '../web/src/mimc';
import { verifierProgram, verifierUnlockings } from '../web/src/verifier';
import { lockingOf, spendAll } from '@solidpool/verifier';
import { playwright } from './lib/browser';

const { chromium } = await playwright();

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PROVER_FILE = join(ROOT, 'web', 'src', 'prover.ts');
const CIRCUIT_FILE = join(ROOT, 'web', 'public', 'prover', 'withdraw.json');
const KEY_FILE = join(ROOT, 'web', 'public', 'prover', 'withdraw_proving_key.bin');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const decimal = (value: unknown) => /^\d+$/.test(String(value));

// ---- the fixed witness: constants, a note the shipped note code confirms, and a path the
// shipped tree confirms. Nothing here depends on a random note or on the chain.
const le31 = (value: bigint) => {
  const out = new Uint8Array(31);
  let rest = value;
  for (let i = 0; i < 31; i += 1) { out[i] = Number(rest & 0xffn); rest >>= 8n; }
  return out;
};
const preimage = new Uint8Array(62);
preimage.set(le31(0x1234567890abcdefn), 0);
preimage.set(le31(0xfedcba0987654321n), 31);
const note = parseNote(`${NOTE_PREFIX}-compat-1000-0x${hex(preimage)}`);

const tree = new MimcTree(20, [note.commitment]);
const { pathElements, pathIndices } = tree.path(0);
const recipient = (0x1111111111111111111111111111111111111111n).toString();
const input = {
  root: tree.root().toString(),
  nullifierHash: note.nullifierHash.toString(),
  recipient,
  relayer: '0',
  fee: '0',
  refund: '0',
  nullifier: note.nullifier.toString(),
  secret: note.secret.toString(),
  pathElements: pathElements.map(String),
  pathIndices: pathIndices.map(String),
};
assert(pathElements.length === 20 && pathIndices.length === 20, 'the witness has a 20-level path');
let pathRoot = note.commitment;
for (let depth = 0; depth < 20; depth += 1) {
  pathRoot = Number(pathIndices[depth]) === 0
    ? mimcSponge([pathRoot, pathElements[depth]])
    : mimcSponge([pathElements[depth], pathRoot]);
}
assert(pathRoot.toString() === input.root, 'the witness path reaches the witness root');
assert(input.relayer === '0' && input.fee === '0' && input.refund === '0',
  'the fixed witness spends no relayer fee and no refund');

// ---- the shipped prover source: browser imports, no Node built-ins ----
const proverSource = readFileSync(PROVER_FILE, 'utf8');
assert(/import\('websnark\/build\/websnark\.js'\)/.test(proverSource),
  'the prover loads websnark\'s browser build');
for (const pattern of [/from\s+['"]node:/, /\brequire\s*\(/, /\bprocess\s*\./, /\bBuffer\b/]) {
  assert(!pattern.test(proverSource), `the prover source does not use ${pattern}`);
}

// ---- bundle the shipped prover for a page, as Next does: no aliases, injects or shims ----
const outdir = mkdtempSync(join(tmpdir(), 'prover-compat-'));
const bundlePath = join(outdir, 'prover.js');
await build({
  entryPoints: [PROVER_FILE],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: bundlePath,
  absWorkingDir: ROOT,
  nodePaths: [join(ROOT, 'node_modules'), join(ROOT, 'web', 'node_modules')],
  logLevel: 'silent',
});

const served = new Map<string, { body: Uint8Array; type: string }>([
  ['/prover/withdraw.json', { body: readFileSync(CIRCUIT_FILE), type: 'application/json' }],
  ['/prover/withdraw_proving_key.bin', { body: readFileSync(KEY_FILE), type: 'application/octet-stream' }],
  ['/prover.js', { body: readFileSync(bundlePath), type: 'text/javascript' }],
]);
const assets = { circuitUrl: '/prover/withdraw.json', provingKeyUrl: '/prover/withdraw_proving_key.bin' };
const requested: string[] = [];
const html = '<!doctype html><meta charset="utf-8"><script type="module">'
  + 'import * as prover from "./prover.js"; window.prover = prover;'
  + '</script>';
const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  requested.push(path);
  const file = served.get(path);
  if (!file) {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
    return;
  }
  response.writeHead(200, { 'content-type': file.type });
  response.end(file.body);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (error: Error) => pageErrors.push(error.message));
const workers: string[] = [];
page.on('worker', (worker) => workers.push(worker.url()));

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => Boolean((window as any).prover), null, { timeout: 60_000 });
const workersBeforeProve = workers.length;

const outcome = await page.evaluate(`(async () => {
  const progress = [];
  const fixture = await window.prover.prove(${JSON.stringify(input)}, ${JSON.stringify(assets)},
    (message) => progress.push(message));
  // websnark's globals are gone once the prover holds its functions, and a second proof still runs on them.
  const globalsLeft = ['groth16', 'genZKSnarkProofAndWitness', 'genZKSnarkProof', 'zkSnarkProofToSolidityInput']
    .filter((name) => name in window);
  const again = await window.prover.prove(${JSON.stringify(input)}, ${JSON.stringify(assets)});
  return { fixture, progress, globalsLeft, again };
})()`) as {
  fixture: {
    publicInputs: string[];
    proof: { a: { x: string; y: string }; b: { x: { c0: string; c1: string }; y: { c0: string; c1: string } }; c: { x: string; y: string } };
  };
  progress: string[];
  globalsLeft: string[];
  again: { publicInputs: string[]; proof: { a: { x: string } } };
};

await browser.close();
server.close();
rmSync(outdir, { recursive: true, force: true });

assert(pageErrors.length === 0, `the page raised no errors: ${pageErrors.join('; ')}`);
const { fixture } = outcome;
const fixturePath = process.env.PROVER_COMPAT_FIXTURE;
if (fixturePath) writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

// ---- the fixture's shape is the one the verifier reads ----
assert(Array.isArray(fixture.publicInputs) && fixture.publicInputs.length === 3,
  'the fixture carries three public inputs');
for (const value of fixture.publicInputs) assert(decimal(value), `public input ${value} is a decimal field element`);
assert(fixture.publicInputs[0] === input.root, 'the first public input is the witness root');
assert(fixture.publicInputs[1] === input.nullifierHash, 'the second public input is the witness nullifier hash');
assert(fixture.publicInputs[2] === input.recipient, 'the third public input is the witness recipient');
const proofShape = {
  a: ['x', 'y'],
  b: ['x', 'y'],
  c: ['x', 'y'],
};
for (const [point, coordinates] of Object.entries(proofShape)) {
  const value = (fixture.proof as any)[point];
  assert(value && typeof value === 'object', `the fixture has proof point ${point}`);
  for (const coordinate of coordinates) {
    if (point === 'b') {
      assert(value[coordinate] && decimal(value[coordinate].c0) && decimal(value[coordinate].c1),
        `proof ${point}.${coordinate} is a pair of decimal field elements`);
    } else {
      assert(decimal(value[coordinate]), `proof ${point}.${coordinate} is a decimal field element`);
    }
  }
}

// ---- the page keeps no handle on the prover, and proofs are re-randomised ----
assert(outcome.globalsLeft.length === 0, `websnark's window globals are removed: ${outcome.globalsLeft.join(', ')}`);
assert(JSON.stringify(outcome.again.publicInputs) === JSON.stringify(fixture.publicInputs),
  'a second proof of the same witness has the same public inputs');
assert(outcome.again.proof.a.x !== fixture.proof.a.x, 'a second proof of the same witness is a different proof');

// ---- proving ran in Web Workers, with the circuit and key fetched by URL ----
assert(workersBeforeProve === 0, 'loading the prover module starts no worker; proving does');
assert(workers.length > 0, 'the prover started at least one Web Worker');
assert(workers.every((url) => url.startsWith('blob:')), 'the prover runs its workers from blobs');
assert(outcome.progress.some((message) => /Loading circuit/.test(message)), 'the prover announced the circuit download');
assert(requested.includes(assets.circuitUrl), `the page fetched the circuit from ${assets.circuitUrl}`);
assert(requested.includes(assets.provingKeyUrl), `the page fetched the proving key from ${assets.provingKeyUrl}`);
assert(!requested.some((path) => path.includes('engine') || path.includes('wallet')),
  'the prover fetched no engine or wallet artifact');

// ---- the shipped verifier and the libauth BCH VM accept exactly this fixture ----
const program = verifierProgram();
const unlockings = await verifierUnlockings(fixture, program);
const lock = lockingOf(program);
const runs = Object.fromEntries(['consensus', 'standard'].map((mode) => [mode, spendAll(
  unlockings.map(() => lock), unlockings, mode,
)])) as Record<string, { accepted: boolean; opCost: number; budget: number; length: number }[]>;
for (const [mode, entries] of Object.entries(runs)) {
  assert(entries.every((entry) => entry.accepted), `the BCH VM accepts all three unlockings in ${mode} mode`);
  assert(entries.every((entry) => entry.length <= 10_000 && entry.opCost <= entry.budget),
    `every unlocking fits its input's 10 kB limit and op budget in ${mode} mode`);
}

// The acceptance above must depend on the new proof, so one changed public input is refused.
// The verifier refuses it while building the unlocking, or the VM refuses the built one.
const tampered = JSON.parse(JSON.stringify(fixture));
tampered.publicInputs[0] = (BigInt(tampered.publicInputs[0]) + 1n).toString();
let refused = false;
try {
  const tamperedRun = await verifierUnlockings(tampered, program);
  refused = !spendAll(tamperedRun.map(() => lock), tamperedRun, 'standard').every((entry) => entry.accepted);
} catch (error) {
  refused = /Groth16 equation fails|bad point/.test(String((error as Error).message));
}
assert(refused, 'the verifier refuses the same proof for a changed root');

console.log(`public inputs ${fixture.publicInputs.join(' / ')}`);
console.log(`proof points a.x ${fixture.proof.a.x.slice(0, 12)}…, b.x.c0 ${fixture.proof.b.x.c0.slice(0, 12)}…, c.y ${fixture.proof.c.y.slice(0, 12)}…`);
console.log(`workers ${workers.length}; circuit ${assets.circuitUrl}; key ${assets.provingKeyUrl}`);
console.log(`unlockings ${unlockings.map((unlocking) => unlocking.length).join(' / ')} B; accepted consensus and standard; tampered root refused`);
console.log('PASS');
