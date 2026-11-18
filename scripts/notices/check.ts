// Whether the third-party inventory was made from the lockfiles and config.json the repository
// holds now: LICENSES/third-party.txt and THIRD_PARTY_NOTICES.md each name the hash of what they
// were made from (inputs.ts). It builds nothing and reads no network, so `npm test` runs it first.
//
//   npm run notices:check
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUTS, inputsOf, recordedInputs } from './inputs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const now = inputsOf(ROOT);
const problems: string[] = [];
for (const file of ['LICENSES/third-party.txt', 'THIRD_PARTY_NOTICES.md']) {
  const recorded = recordedInputs(readFileSync(join(ROOT, file), 'utf8'));
  if (!recorded) {
    problems.push(`${file} names no inventory inputs.`);
    continue;
  }
  if (recorded.combined === now.combined) continue;
  const changed = INPUTS.filter((path) => recorded.files[path] !== now.files[path]);
  problems.push(`${file} was made before ${changed.length ? changed.join(', ') : 'its inputs'} changed.`);
}
if (problems.length) {
  console.error([
    'The third-party inventory is out of date:',
    ...problems.map((problem) => `  - ${problem}`),
    'Run `npm run notices` and commit what it writes (PRODUCTION.md).',
  ].join('\n'));
  process.exit(1);
}
console.log(`Third-party inventory: made from the lockfiles and config.json here (${now.combined.slice(0, 12)})`);
