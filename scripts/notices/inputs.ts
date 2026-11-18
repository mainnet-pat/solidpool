// What the third-party inventory is made from, by hash: the two lockfiles, which pin every package
// the page and the images can carry, and the tool's own facts (config.json). The remake writes the
// hash into LICENSES/third-party.txt and THIRD_PARTY_NOTICES.md; the check reads it back, so a
// dependency that changes without a remake fails `npm test`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INPUTS = ['package-lock.json', 'web/package-lock.json', 'scripts/notices/config.json'] as const;

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Each input's own hash, shortened, and one hash of them all. */
export function inputsOf(root: string): { combined: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const path of INPUTS) files[path] = sha256(readFileSync(join(root, path))).slice(0, 16);
  const combined = sha256(INPUTS.map((path) => `${path} ${files[path]}`).join('\n'));
  return { combined, files };
}

/** The line the generated files carry. */
export const inputsLine = ({ combined, files }: ReturnType<typeof inputsOf>) =>
  `Inventory inputs: ${combined} ${INPUTS.map((path) => `${path}=${files[path]}`).join(' ')}`;

/** The hashes a generated file names, or undefined where it names none. */
export function recordedInputs(text: string): { combined: string; files: Record<string, string> } | undefined {
  const found = /Inventory inputs: ([0-9a-f]{64})((?: [^\s=]+=[0-9a-f]{16})*)/.exec(text);
  if (!found) return undefined;
  const files: Record<string, string> = {};
  for (const pair of found[2].trim().split(' ').filter(Boolean)) {
    const [path, hash] = pair.split('=');
    files[path] = hash;
  }
  return { combined: found[1], files };
}
