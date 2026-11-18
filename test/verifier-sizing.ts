// The verifier sizes the same fillers whether the libauth it runs on charges OP_DEFINE bodies, as BCHN
// does, or not, as this project's copy does not (bitauth/libauth#166). The production proof is sized
// twice: on this project's libauth, which packages/verifier loads, and on a temporary copy of it whose
// OP_DEFINE charges the body it stores as stack-pushed bytes, the statement groth16_cashscript's pnpm
// patch adds. The unlockings must be the same bytes. Before the verifier measured its libauth, the
// charging one counted the 16,313 B of defined bodies twice and made every input about 22 B longer.
// Each run also spends them in its own VM, so the charging copy checks every input against its op
// budget as BCHN counts it; the service's verifier scripts count as this project's libauth does.
//   tsx test/verifier-sizing.ts
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--worker')) {
  const { verifierProgram, verifierUnlockings } = await import('../web/src/verifier');
  const { VM_CHARGES_DEFINE, lockingOf, spendAll } = await import('@solidpool/verifier');
  const proof = JSON.parse(readFileSync(join(ROOT, 'service', 'verifier', 'proofs', 'proof-recipient.json'), 'utf8'));
  const blob = proof.proof.replace(/^0x/, '');
  const word = (index: number) => BigInt(`0x${blob.slice(index * 64, index * 64 + 64)}`).toString();
  const fixture = {
    fixture: 0,
    publicInputs: proof.publicSignals.slice(0, 3).map((value: string) => BigInt(value).toString()),
    proof: {
      a: { x: word(0), y: word(1) },
      b: { x: { c0: word(3), c1: word(2) }, y: { c0: word(5), c1: word(4) } },
      c: { x: word(6), y: word(7) },
    },
  };
  const program = verifierProgram();
  const unlockings = await verifierUnlockings(fixture, program);
  const digest = createHash('sha256');
  for (const unlocking of unlockings) digest.update(unlocking);
  const lock = lockingOf(program);
  const runs = spendAll(unlockings.map(() => lock), unlockings, 'standard')
    .map(({ accepted, opCost, budget }: { accepted: boolean; opCost: number; budget: number }) => ({ accepted, opCost, budget }));
  console.log(JSON.stringify({ charges: VM_CHARGES_DEFINE, sizes: unlockings.map((u) => u.length), digest: digest.digest('hex'), runs }));
  process.exit(0);
}

// A copy of this project's libauth whose OP_DEFINE charges its body. libauth has no dependencies, and
// everything it loads is under build/.
const libauth = realpathSync(join(ROOT, 'node_modules', '@bitauth', 'libauth'));
const charging = mkdtempSync(join(tmpdir(), 'libauth-charges-define-'));
process.on('exit', () => rmSync(charging, { recursive: true, force: true }));
cpSync(join(libauth, 'package.json'), join(charging, 'package.json'));
cpSync(join(libauth, 'build'), join(charging, 'build'), { recursive: true });
const functions = join(charging, 'build', 'lib', 'vm', 'instruction-sets', 'bch', '2026', 'bch-2026-functions.js');
const counted = '        finalState.functionCount += 1;\n';
const source = readFileSync(functions, 'utf8');
if (source.split(counted).length !== 2) throw new Error(`OP_DEFINE in ${functions} has changed; patch its charge again`);
writeFileSync(functions, source.replace(counted, `${counted}        finalState.metrics.stackPushedBytes += functionBody.length;\n`));

// A resolve hook that sends every @bitauth/libauth import to the charging copy.
const hook = `export async function resolve(specifier, context, next) {
  if (specifier === '@bitauth/libauth' || specifier.startsWith('@bitauth/libauth/')) {
    return next(${JSON.stringify(pathToFileURL(charging).href)} + (specifier.slice(16) || '/build/index.js'), context);
  }
  return next(specifier, context);
}`;
const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;

interface Sizing { charges: boolean; sizes: number[]; digest: string; runs: { accepted: boolean; opCost: number; budget: number }[] }
const size = (label: string, nodeOptions: string): Sizing => {
  const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsx'), [fileURLToPath(import.meta.url), '--worker'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, nodeOptions].filter(Boolean).join(' ') },
  });
  if (run.status !== 0) throw new Error(`${label}: ${run.stderr}`);
  const sizing = JSON.parse(run.stdout.trim().split('\n').pop()!) as Sizing;
  console.log(`${label.padEnd(32)} charges OP_DEFINE bodies: ${sizing.charges ? 'yes' : 'no '}  ${sizing.sizes.join(' / ')} B  ${sizing.digest.slice(0, 16)}`);
  console.log(`${''.padEnd(32)} op cost ${sizing.runs.map(({ accepted, opCost, budget }) => `${accepted ? '' : 'REFUSED '}${opCost}/${budget}`).join('  ')}`);
  if (!sizing.runs.every(({ accepted, opCost, budget }) => accepted && opCost <= budget)) throw new Error(`${label}: an input is refused or over its op budget`);
  return sizing;
};

const stock = size("this project's libauth", '');
const patched = size('the copy that charges OP_DEFINE', `--import=data:text/javascript,${encodeURIComponent(register)}`);
if (stock.charges || !patched.charges) throw new Error('the two runs did not test one libauth of each kind');
if (stock.digest !== patched.digest) throw new Error('the two libauth copies size different unlockings');
console.log('PASS');
