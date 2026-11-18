// The page's notices, which every production build and dev server writes to public/licenses/
// (next.config.ts) and the page serves at /licenses/: SolidPool's LICENSE, THIRD_PARTY_NOTICES.md,
// the texts in LICENSES/ and the fonts' OFL.txt, copied from the repository, and NOTICE.txt, the
// page's Appropriate Legal Notices under section 5(d) of the GPL-3.0. The page as served includes
// GPL-3.0 code and is conveyed under that licence; "Licences" at its foot opens NOTICE.txt. The
// folder is made by each build, never kept: .gitignore leaves it out, and web/Dockerfile's build
// writes its own.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What each file in the folder is, in the order NOTICE.txt lists them. */
const DESCRIBED: Array<[string, string]> = [
  ['GPL-3.0.txt', 'the GNU General Public License, version 3'],
  ['LICENSE.txt', "SolidPool's ISC licence"],
  ['THIRD_PARTY_NOTICES.md', 'the third-party code and assets, their licences, and where their sources are'],
  ['third-party.txt', "each third-party component's copyright notice and licence text"],
  ['Apache-2.0.txt', 'the Apache License 2.0, which entries in third-party.txt refer to'],
  ['OFL.txt', "the SIL Open Font License 1.1 of the page's fonts"],
];

/** The folder's copies: their names there, and the repository files they come from. */
function sources(web: string): Array<[string, string]> {
  const root = join(web, '..');
  const licences = join(root, 'LICENSES');
  if (!existsSync(licences)) throw new Error(`The page's notices need ${licences}, which is missing.`);
  return [
    ['LICENSE.txt', join(root, 'LICENSE')],
    ['THIRD_PARTY_NOTICES.md', join(root, 'THIRD_PARTY_NOTICES.md')],
    ...readdirSync(licences).sort().map((name): [string, string] => [name, join(licences, name)]),
    ['OFL.txt', join(web, 'app', 'fonts', 'OFL.txt')],
  ];
}

/**
 * NOTICE.txt: SolidPool's copyright line, that the page as served includes GPL-3.0 code and may be
 * conveyed under that licence, that there is no warranty, and where the licence texts and the
 * source are. `files` are the folder's other files; `source` is SOURCE_URL, which only a
 * development or devnet build may leave unset.
 */
export function noticeText(copyright: string, source: string | undefined, files: readonly string[]): string {
  const listed = [
    ...DESCRIBED.filter(([name]) => files.includes(name)),
    ...files.filter((name) => !DESCRIBED.some(([known]) => known === name)).map((name): [string, string] => [name, '']),
  ];
  const width = Math.max(...listed.map(([name]) => name.length)) + 2;
  return [
    'SolidPool: notices for this page',
    '================================',
    '',
    copyright,
    '',
    'This page, as served, includes code under the GNU General Public License, version 3: websnark,',
    'with part of snarkjs, circomlibjs, ffjavascript, wasmcurves and wasmbuilder. You may copy,',
    'change and convey the page as served under that licence. SolidPool\'s own files are under the',
    'ISC licence (LICENSE.txt), and the other third-party code in the page keeps its own licence',
    '(THIRD_PARTY_NOTICES.md, third-party.txt).',
    '',
    'There is no warranty for this page or its code, to the extent permitted by applicable law. It',
    'is provided "as is", without warranty of any kind, either expressed or implied. Sections 15',
    'and 16 of GPL-3.0.txt, and LICENSE.txt, say so in full.',
    '',
    'The licence texts are in this folder, /licenses/:',
    ...listed.map(([name, what]) => `  ${name.padEnd(width)}${what}`.trimEnd()),
    '',
    source
      ? `The exact source of this build: ${source}`
      : 'This build names no address for its source: SOURCE_URL is not set, as only a development or\ndevnet build may leave it. A production build requires it.',
    '',
    'The sources of the GPL-3.0 packages, at the versions this build pins, are listed in',
    'THIRD_PARTY_NOTICES.md under "Corresponding Source".',
    '',
  ].join('\n');
}

/**
 * Write public/licenses/ under `web`. A file is replaced only when its text changes, by a rename,
 * so a build's processes, which may each load the config, never see one half written. A missing
 * source file stops the build: a page without its notices does not ship.
 */
export function writeLicences(web: string, source: string | undefined): void {
  const out = join(web, 'public', 'licenses');
  const files = new Map<string, string>();
  for (const [name, from] of sources(web)) {
    if (!existsSync(from)) throw new Error(`The page's notices need ${from}, which is missing.`);
    files.set(name, readFileSync(from, 'utf8'));
  }
  const copyright = files.get('LICENSE.txt')!.split('\n').map((line) => line.trim()).find((line) => /^Copyright\b/.test(line));
  if (!copyright) throw new Error('LICENSE has no copyright line for the page\'s notices.');
  files.set('NOTICE.txt', noticeText(copyright, source, [...files.keys()]));
  mkdirSync(out, { recursive: true });
  for (const [name, text] of files) {
    const target = join(out, name);
    if (existsSync(target) && readFileSync(target, 'utf8') === text) continue;
    const written = `${target}.${process.pid}.tmp`;
    writeFileSync(written, text);
    renameSync(written, target);
  }
}
