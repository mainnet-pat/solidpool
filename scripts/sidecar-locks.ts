// Write contracts/Sidecars.scash, the hashing and verifier locks the pools pin, from MimcHash's
// source and the verifier's artifact. Run it after changing either, before compiling the pools.
//
//   tsx scripts/sidecar-locks.ts            write it
//   tsx scripts/sidecar-locks.ts --check    compare, and write nothing
import { readFileSync, writeFileSync } from 'node:fs';
import { SIDECARS_FILE, sidecarsSource } from './lib/sidecars.ts';

const text = sidecarsSource();
let current = '';
try {
  current = readFileSync(SIDECARS_FILE, 'utf8');
} catch { /* not written yet */ }
if (process.argv.includes('--check')) {
  if (current !== text) {
    console.error('contracts/Sidecars.scash does not match MimcHash and the verifier. Run `tsx scripts/sidecar-locks.ts`.');
    process.exit(1);
  }
  console.log('contracts/Sidecars.scash matches MimcHash and the verifier');
} else if (current !== text) {
  writeFileSync(SIDECARS_FILE, text);
  console.log('wrote contracts/Sidecars.scash');
} else console.log('contracts/Sidecars.scash is up to date');
