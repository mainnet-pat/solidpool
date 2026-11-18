// Extract Tornado's Groth16 verifying key from the generated Solidity verifier.
//
//   tsx service/verifier/extract-vk.ts [path/to/Verifier.sol]           write the keys
//   tsx service/verifier/extract-vk.ts --check [path/to/Verifier.sol]   compare them, and write nothing
//
// Writes the keys in this directory, each with the full 7-point IC set: the 3-input key
// the pools' verifier is built from, and the older 2-input one, kept for reference.
//
// The source is tornado-core's contracts/Verifier.sol: a path given here, else the checkout
// TORNADO_CORE names, else one beside this repository. The keys are also pinned below by
// hash, as extracted from tornado-core 1ef6a26, whose Verifier.sol has the sha256 below too:
// a source must give exactly those keys, and with no source, --check holds the files to
// them. Tornado's public inputs are
// [root, nullifierHash, recipient, relayer, fee, refund]; the 3-input key keeps the first
// three and fixes the others to 0. Since 0 * IC = 0, IC0 is unchanged, so its statement is
// exactly Tornado's statement with the relayer's fields zeroed.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ROOT } from '../lib/config';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** tornado-core 1ef6a26's contracts/Verifier.sol, and the keys this script extracts from it. */
const VERIFIER_SOL_SHA256 = 'a2fd9a12dc008ae95e1f9da2968e7d017617e804f22aa0491d2e8a91d965a824';
const PINNED: Record<string, string> = {
  'tornado-bn254-folded.json': '198d195451286f5100956395e9d90bb51fc1f14a6989c15572d7b34e60b0b472',
  'tornado-bn254-3in.json': 'f2c954a49e56948b9c44fc31268b49a9c1de1b720ff6f072542c9730389d5fca',
};
const keyHash = (key: { vk: unknown; allIc: unknown }) => sha256(JSON.stringify({ vk: key.vk, allIc: key.allIc }));

const candidates = process.env.TORNADO_CORE
  ? [join(process.env.TORNADO_CORE, 'contracts', 'Verifier.sol')]
  : [join(ROOT, '..', 'tornado-core', 'contracts', 'Verifier.sol'), join(ROOT, '..', '..', 'tornado-core', 'contracts', 'Verifier.sol')];
const source = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? candidates.find((path) => existsSync(path));
if (source === undefined) {
  if (!check) {
    console.error('No Verifier.sol to extract the key from: give its path, set TORNADO_CORE, or put tornado-core beside this repository.');
    process.exit(1);
  }
  for (const [name, hash] of Object.entries(PINNED)) {
    if (keyHash(JSON.parse(readFileSync(join(here, name), 'utf8'))) !== hash) {
      console.error(`${name} is not the key pinned from tornado-core's Verifier.sol.`);
      process.exit(1);
    }
    console.log(`${name}: the pinned key; set TORNADO_CORE to extract it from Verifier.sol again`);
  }
  process.exit(0);
}
const src = readFileSync(source, 'utf8');

const g1 = (name) => {
  const m = src.match(new RegExp(`vk\\.${name}\\s*=\\s*Pairing\\.G1Point\\(uint256\\((\\d+)\\), uint256\\((\\d+)\\)\\)`));
  if (!m) throw new Error(`missing ${name}`);
  return { x: m[1], y: m[2] };
};

const g2 = (name) => {
  const m = src.match(new RegExp(`vk\\.${name}\\s*=\\s*Pairing\\.G2Point\\(\\[uint256\\((\\d+)\\), uint256\\((\\d+)\\)\\], \\[uint256\\((\\d+)\\), uint256\\((\\d+)\\)\\]\\)`));
  if (!m) throw new Error(`missing ${name}`);
  // snarkjs writes [imaginary, real] for each G2 coordinate; the fixture format
  // stores c0 = real, c1 = imaginary.
  return { x: { c0: m[2], c1: m[1] }, y: { c0: m[4], c1: m[3] } };
};

const ic = [];
for (let i = 0; i <= 6; i += 1) {
  const m = src.match(new RegExp(`vk\\.IC\\[${i}\\]\\s*=\\s*Pairing\\.G1Point\\(uint256\\((\\d+)\\), uint256\\((\\d+)\\)\\)`));
  if (!m) throw new Error(`missing IC[${i}]`);
  ic.push({ x: m[1], y: m[2] });
}

const origin = `tornado-core's contracts/Verifier.sol, sha256 ${sha256(src).slice(0, 16)}…: Groth16/BN254, 6 public inputs [root, nullifierHash, recipient, relayer, fee, refund].`;
const out = {
  provenance: `${origin} Runtime inputs root and nullifierHash; recipient/relayer/fee/refund fixed at 0 (IC0 unchanged).`,
  vk: {
    alpha: g1('alfa1'),
    beta: g2('beta2'),
    gamma: g2('gamma2'),
    delta: g2('delta2'),
    ic: [ic[0], ic[1], ic[2]],
  },
  fixtures: [],
  allIc: ic,
};
const keys = {
  'tornado-bn254-folded.json': out,
  'tornado-bn254-3in.json': {
    ...out,
    provenance: `${origin} Runtime inputs root, nullifierHash and recipient; relayer/fee/refund fixed at 0 (IC0 unchanged).`,
    vk: { ...out.vk, ic: [ic[0], ic[1], ic[2], ic[3]] },
  },
};
if (sha256(src) !== VERIFIER_SOL_SHA256) console.log(`${source} is not tornado-core 1ef6a26's Verifier.sol; its keys must still be the pinned ones`);
for (const [name, key] of Object.entries(keys)) {
  if (keyHash(key) !== PINNED[name]) {
    console.error(`${source} gives another key than the one pinned for ${name}. A new key is a new verifier: change the pin with it.`);
    process.exit(1);
  }
  const file = join(here, name);
  const text = JSON.stringify(key, null, 1) + '\n';
  if (!check) writeFileSync(file, text);
  else if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))) !== JSON.stringify(key)) {
    console.error(`${name} does not match ${source}.`);
    process.exit(1);
  }
  console.log(`${name}: ${key.vk.ic.length} of ${ic.length} IC points`);
}
