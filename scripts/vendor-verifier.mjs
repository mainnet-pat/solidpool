// Vendor the Groth16 verifier into packages/verifier from a groth16_cashscript checkout.
//
// The verifier is chunked/bn254 of github.com/mr-zwets/groth16_cashscript, the code behind verifier.cash. This takes
// the files that the package's entry and the service's verifier scripts (service/verifier/*.ts) reach by relative
// import, with the entry's types and the program's design notes, byte for byte. Against verifier.cash, upstream's
// main where the checkout forked from it, each file is unchanged, changed or added; verifier.cash.diff holds the
// changed files' diff from that commit. SOURCE.json records both commits, the commits between them that touch the
// files, and each file's status. The research scripts beside them stay upstream. package.json and README.md in
// packages/verifier are this repository's own: a dependency upstream pins differently is reported, not copied.
//   node scripts/vendor-verifier.mjs <groth16_cashscript checkout> [verifier.cash commit, default: fork from origin/main]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(project, 'packages', 'verifier');
if (process.argv.length < 3 || process.argv.length > 4) {
  console.error('usage: node scripts/vendor-verifier.mjs <groth16_cashscript checkout> [verifier.cash commit]');
  process.exit(1);
}
const checkout = resolve(process.argv[2]);
const PREFIX = 'chunked/bn254';
const source = join(checkout, PREFIX);
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== '@solidpool/verifier') {
  throw new Error(`${source} is not the @solidpool/verifier package`);
}
// The record names a commit, so the files must be that commit's.
if (git('status', '--porcelain', '--', PREFIX) !== '') throw new Error(`${source} has uncommitted changes`);
const commit = git('rev-parse', 'HEAD');
const base = git('rev-parse', process.argv[3] ?? git('merge-base', 'HEAD', 'origin/main'));

// The package's entry, and what service/verifier/*.ts import from it.
const ENTRIES = [
  'bn-native-sound/runtime.mjs',
  'bn-native-sound/script.mjs',
  'bn-native-sound/transaction.mjs',
  'bn-native-sound/vm.mjs',
  'bn-native-sound/protocol.mjs',
  'sound-si-gls/math.mjs',
];
const EXTRAS = ['bn-native-sound/runtime.d.ts', 'bn-native-sound/README.md'];
const files = new Set(EXTRAS);
const visit = (file) => {
  if (files.has(file)) return;
  files.add(file);
  if (!file.endsWith('.mjs')) return;
  const text = readFileSync(join(source, file), 'utf8');
  for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    visit(relative(source, resolve(dirname(join(source, file)), specifier)));
  }
};
ENTRIES.forEach(visit);
const list = [...files].sort();

// Each file against verifier.cash.
const inBase = (file) => {
  try {
    git('cat-file', '-e', `${base}:${PREFIX}/${file}`);
    return true;
  } catch {
    return false;
  }
};
const status = Object.fromEntries(list.map((file) => [file, !inBase(file)
  ? 'added'
  : git('diff', '--name-only', base, commit, '--', `${PREFIX}/${file}`) === '' ? 'unchanged' : 'changed']));
const changed = list.filter((file) => status[file] === 'changed');
const paths = list.map((file) => `${PREFIX}/${file}`);

// Replace what the last vendoring copied, and keep this repository's own files and node_modules.
const record = join(target, 'SOURCE.json');
const previous = existsSync(record) ? Object.keys(JSON.parse(readFileSync(record, 'utf8')).files) : [];
for (const file of previous) rmSync(join(target, file), { force: true });
for (const file of list) {
  mkdirSync(dirname(join(target, file)), { recursive: true });
  copyFileSync(join(source, file), join(target, file));
}
writeFileSync(join(target, 'verifier.cash.diff'), [
  `The vendored files that differ from verifier.cash: github.com/mr-zwets/groth16_cashscript main at ${base},`,
  `as the diff from that commit to ${commit}, with paths below ${PREFIX}. SOURCE.json lists every file's status.`,
  'Written by scripts/vendor-verifier.mjs.',
  '',
  `${git('diff', '--no-color', '--no-ext-diff', `--relative=${PREFIX}`, base, commit, '--', ...changed.map((file) => `${PREFIX}/${file}`))}\n`,
].join('\n'));
writeFileSync(record, `${JSON.stringify({
  repository: 'https://github.com/mr-zwets/groth16_cashscript',
  path: PREFIX,
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commit,
  upstream: { name: 'verifier.cash', branch: 'main', commit: base },
  changes: git('log', '--reverse', '--format=%h %s', `${base}..${commit}`, '--', ...paths).split('\n').filter(Boolean),
  files: status,
}, null, 2)}\n`);
console.log(`vendor-verifier: ${list.length} files from ${source} at ${commit}`);
console.log(`vendor-verifier: against verifier.cash ${base}: ${['unchanged', 'changed', 'added']
  .map((kind) => `${list.filter((file) => status[file] === kind).length} ${kind}`).join(', ')}`);

const upstream = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const ours = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
for (const [name, version] of Object.entries(upstream.dependencies ?? {})) {
  const mine = ours.dependencies?.[name] ?? ours.peerDependencies?.[name];
  if (mine !== version) console.warn(`vendor-verifier: upstream pins ${name} ${version}; packages/verifier/package.json has ${mine ?? 'nothing'}`);
}
