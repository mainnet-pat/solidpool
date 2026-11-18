// Check that the solidhat artifacts under contracts/artifacts/solidcash are what the
// sources compile to. `updatedAt` is the compiler's clock, so it is left out of the
// comparison; everything else must match, and a difference fails before a deployment.
//
// solidhat gives every source the same compiler options, so `allowUnsafeOperations`, which
// only the two deployers need, is set for all of them. The others are compiled again here
// without it, so the flag cannot hide a refusal in them.
//
// The pools pin the hashing and verifier locks that contracts/Sidecars.scash holds, so that file
// must be what MimcHash's source and the verifier's artifact give, or the pools would spend no
// coin; and the token deployer's empty root must be the client's.
//
// It first names the SolidCash it compiles with: the @solidcash packages package.json pins.
//
//   tsx scripts/check-contracts.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileString } from '@solidcash/solidc';
import { MimcTree } from '../web/src/mimc';
import { SparseTree } from '../web/src/sparse-tree';
import { mimcPrecompile } from './lib/mimc-script.ts';
import { SIDECARS_FILE, sidecarsSource } from './lib/sidecars.ts';
import { describeSolidcash, solidcashBuild } from './lib/solidcash-build.ts';

console.log(describeSolidcash(solidcashBuild()));

if (readFileSync(SIDECARS_FILE, 'utf8') !== sidecarsSource()) {
  console.error('contracts/Sidecars.scash does not match MimcHash and the verifier. Run `tsx scripts/sidecar-locks.ts`, then compile.');
  process.exit(1);
}
console.log('Sidecars: matches MimcHash and the verifier');

const root = new URL('..', import.meta.url).pathname;
const contracts = join(root, 'contracts');
const artifacts = join(contracts, 'artifacts', 'solidcash');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const le32 = (value: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0, n = value; i < 32; i += 1, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
};
const levels = 20;
const { zeros } = new MimcTree(levels);
const expectedZeros = zeros.slice(0, levels).map((zero) => hex(le32(zero))).join('');
const expectedRoot = hex(le32(zeros[levels]));

const resolver = (importPath: string, currentFile: string) => {
  const id = join(dirname(currentFile), importPath);
  return { id, source: readFileSync(id, 'utf8') };
};

const library = {
  userLibraries: [{
    name: 'mimc',
    code: hex(mimcPrecompile()),
    abi: { inputs: [{ name: 'pair', type: 'bytes' }], outputs: [{ type: 'bytes32' }] },
  }],
  inlineLibraries: { mimc: true },
};

const stable = (value: unknown): string => JSON.stringify(value, (key, field) => (key === 'updatedAt' ? undefined : field));

const compile = (name: string, options: object) => {
  const source = readFileSync(join(contracts, `${name}.scash`), 'utf8');
  if (name === 'BchPool' || name === 'TokenPool') {
    if (!source.includes(`bytes constant ZEROS = 0x${expectedZeros};`)) throw new Error(`${name}: ZEROS differ from the client's tree`);
    if (!source.includes(`bytes32 constant EMPTY_ROOT = 0x${expectedRoot};`)) throw new Error(`${name}: EMPTY_ROOT differs from the client's tree`);
  }
  if (name === 'TokenPoolDeployer' && !source.includes(`bytes32 constant EMPTY = 0x${hex(new SparseTree(128).root())};`)) {
    throw new Error(`${name}: EMPTY differs from the client's registry tree`);
  }
  return compileString(source, {
    ...options, importResolver: resolver, rootFileId: join(contracts, `${name}.scash`),
  } as any) as unknown as Record<string, unknown>;
};

const solidhat = { ...library, allowUnsafeOperations: true };
const expected: Array<[string, object]> = [
  ['BN254', { allowUnsafeOperations: true }],
  ['MimcHash', solidhat],
  ['BchPool', solidhat],
  ['TokenPool', solidhat],
  ['BchPoolDeployer', solidhat],
  ['TokenPoolDeployer', solidhat],
];

let stale = 0;
for (const [name, options] of expected) {
  const built = stable(compile(name, options));
  const file = join(artifacts, `${name}.json`);
  let same = false;
  try {
    same = stable(JSON.parse(readFileSync(file, 'utf8'))) === built;
  } catch {
    same = false;
  }
  if (!same) stale += 1;
  console.log(`${name}: ${same ? 'matches the source' : 'DOES NOT MATCH THE SOURCE'}`);
}
if (stale > 0) {
  console.error('Run `npm run solidhat:compile`, then compare the artifacts again.');
  process.exit(1);
}

// Without the flag, each of these must compile to the same code with no warning. A deployer's
// permissionless `create` is the only refusal the flag is there for.
const withoutUnsafe = new Set(['BN254', 'MimcHash', 'BchPool', 'TokenPool']);
const executable = (artifact: any) => JSON.stringify({
  bytecode: artifact.bytecode,
  abi: artifact.abi,
  stateLayout: artifact.stateLayout,
  functionBodies: artifact.functionBodies,
  delegateBytecode: artifact.delegateArtifact?.bytecode,
});
let unsafe = 0;
for (const [name, options] of expected) {
  if (!withoutUnsafe.has(name)) continue;
  const { allowUnsafeOperations: _, ...safe } = options as { allowUnsafeOperations?: boolean };
  const warnings: string[] = [];
  let built: unknown;
  try {
    built = compile(name, { ...safe, warningListener: ({ message }: { message: string }) => warnings.push(message) });
  } catch (error) {
    warnings.unshift(`refused: ${(error as Error).message}`);
  }
  const same = built !== undefined && executable(built) === executable(JSON.parse(readFileSync(join(artifacts, `${name}.json`), 'utf8')));
  if (warnings.length > 0 || !same) unsafe += 1;
  console.log(`${name} without allowUnsafeOperations: ${warnings.length === 0 && same ? 'the same code, no warning' : 'DIFFERS'}`);
  for (const warning of warnings) console.log(`  ${warning}`);
  if (built !== undefined && !same) console.log('  its bytecode, abi, state layout, function bodies or delegate differ from the artifact');
}
if (unsafe > 0) {
  console.error('Only the two deployers may need `allowUnsafeOperations` (solidcash.config.ts).');
  process.exit(1);
}
