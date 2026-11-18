// The third-party inventory: what the page, the app image and the indexer image ship, each
// component's licence and copyright holders, and their licence texts. It writes
// LICENSES/third-party.txt and the generated blocks of THIRD_PARTY_NOTICES.md, each naming the hash
// of the inputs it was made from (inputs.ts), which `npm run notices:check` compares.
//
//   npm run notices
//
// It builds what ships, as the images build it, and reads it:
// - the page and the app image: a production build of web/ (`next build`), whose standalone
//   server is the app image's, and Next's analysis of the same build (`next analyze`), which names
//   every module in every chunk, the browser's and the server's;
// - the indexer image: the esbuild bundle Dockerfile makes, through its metafile, and the
//   packages Dockerfile copies whole.
// Code a package's prebuilt file inlines is named by that file's own source map, or by
// config.json where the file has none. Licence texts are each installed package's own, or, for a
// package that ships none, the sources config.json names, fetched once into scripts/notices/.cache/.
// The build uses config.json's placeholder settings and is removed afterwards, so no build made
// with them is left to serve. It takes a few minutes; a cold cache also needs the network once.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { crateFile, fetchCached, LICENCE_FILE, npmLicences } from './fetch.ts';
import { inputsLine, inputsOf } from './inputs.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(ROOT, 'web');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'scripts/notices/config.json'), 'utf8'));
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)} s`;

type Where = 'P' | 'A' | 'I';
type Text = { file: string; text: string };
interface Component {
  name: string;
  version: string;
  licence: string;
  where: Set<Where>;
  texts: Text[];
  holders: string[];
  inside?: string;
  /** Where the texts came from, when not from the package itself. */
  textNote?: string;
  /** The package directory, for an installed package. */
  dir?: string;
}

// ---- building and reading what ships ------------------------------------------------------

// The build goes to web/.next, which a dev server or a real build may also be using, so this will
// not start while that folder exists. What it builds holds placeholder settings, so none of it is
// left once this ends, however it ends, and the files a build may rewrite are put back as they were.
const DIST = join(WEB, '.next');
if (existsSync(DIST)) {
  console.error('web/.next exists, and a dev server or a build may be using it. Stop it and remove web/.next, '
    + 'or run npm run notices in a worktree of its own (git worktree add).');
  process.exit(1);
}
const kept = ['next-env.d.ts', 'tsconfig.json'].map((name) => join(WEB, name)).filter((path) => existsSync(path))
  .map((path) => [path, readFileSync(path)] as const);
process.on('exit', () => {
  rmSync(DIST, { recursive: true, force: true });
  for (const [path, bytes] of kept) writeFileSync(path, bytes);
});

function run(args: string[], cwd: string, capture = false): string {
  const result = spawnSync(process.execPath, args, {
    cwd, env: { ...process.env, ...CONFIG.build.settings }, encoding: 'utf8', maxBuffer: 1 << 30,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed with ${result.status}`);
  return capture ? result.stdout : '';
}

const shipped = new Map<string, Set<Where>>(); // a package directory, relative to the root
const files = new Map<string, Set<Where>>(); // a shipped file inside a package
const mark = (map: Map<string, Set<Where>>, key: string, where: Where[]) => {
  const set = map.get(key) ?? new Set<Where>();
  for (const w of where) set.add(w);
  map.set(key, set);
};

/** The package directory that holds `path`: node_modules/<name>, or a directory of next/dist/compiled. */
function packageDir(path: string): string | undefined {
  const compiled = /^(.*node_modules\/next\/dist\/compiled\/(?:@[^/]+\/)?[^/]+)\//.exec(path);
  if (compiled) return compiled[1];
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) return undefined;
  const parts = path.slice(at + 'node_modules/'.length).split('/');
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return path.slice(0, at) + 'node_modules/' + name;
}

const note = (path: string, where: Where[]) => {
  const dir = packageDir(path);
  if (!dir) return;
  mark(shipped, dir, where);
  mark(files, path, where);
};

const next = join(WEB, 'node_modules/next/dist/bin/next');
console.log(`Building web/ as the app image does (${elapsed()})`);
run([next, 'build'], WEB);
console.log(`Analysing the build (${elapsed()})`);
run([next, 'analyze', '--output'], WEB);
const graph = run([next, 'analyze', 'export'], WEB, true);

for (const line of graph.split('\n')) {
  if (!line.startsWith('{')) continue;
  const record = JSON.parse(line);
  if (record.type !== 'part') continue;
  const path = String(record.source_path).replace(/^\[project\]\//, '');
  if (path.startsWith('[')) continue;
  // A chunk served to browsers is in the page, which the app image serves too.
  note(path, String(record.filename).startsWith('[client-fs]') ? ['P', 'A'] : ['A']);
}

// What the standalone trace copies into the app image beside the server's own chunks.
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const standalone = join(DIST, 'standalone');
for (const file of walk(standalone)) {
  const path = relative(standalone, file);
  if (path.includes('node_modules/')) note(path, ['A']);
}

// Next's nomodule polyfill reaches browsers as a chunk of its own, without a source map.
const polyfill = readFileSync(join(WEB, 'node_modules/next/dist/build/polyfills/polyfill-nomodule.js'));
const chunks = walk(join(DIST, 'static')).filter((file) => file.endsWith('.js'));
const servesPolyfill = chunks.some((file) => readFileSync(file).equals(polyfill));
console.log(`The page: ${chunks.length} JavaScript files, ${(chunks.reduce((sum, file) => sum + statSync(file).size, 0) / 1e6).toFixed(2)} MB`);

// The indexer image: Dockerfile's esbuild bundle, and the packages it copies whole.
console.log(`Bundling the indexer as Dockerfile does (${elapsed()})`);
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const esbuildCommand = /npx esbuild (\S+)((?:[^\n]*\\\n)*[^\n]*)/.exec(dockerfile);
if (!esbuildCommand) throw new Error('Dockerfile no longer bundles the indexer with `npx esbuild`: update scripts/notices/make.ts');
const bundle = await build({
  entryPoints: [esbuildCommand[1]], absWorkingDir: ROOT, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: [...esbuildCommand[2].matchAll(/--external:(\S+)/g)].map((match) => match[1]),
  outfile: 'dist/indexer.mjs', metafile: true, write: false, logLevel: 'error',
});
for (const output of Object.values(bundle.metafile!.outputs)) {
  for (const [path, input] of Object.entries(output.inputs)) if (input.bytesInOutput > 0) note(path, ['I']);
}
for (const match of dockerfile.matchAll(/COPY --from=build \/app\/(node_modules\/\S+)/g)) {
  for (const file of walk(join(ROOT, match[1]))) note(relative(ROOT, file), ['I']);
}

// ---- licences and copyright lines ----------------------------------------------------------

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';

/** The copyright lines of a licence text or a source comment, without the templates licences carry. */
const holdersOf = (text: string): string[] => [...new Set(text.split('\n').map((line) => line.replace(/^[\s/*#;]+/, '').trim()).filter((line) =>
  // A holder's line starts with Copyright or ©; the licences' own prose says "copyright" in lower case.
  (/^(Copyright|COPYRIGHT|©)\s/.test(line) || /\sCopyright \(c\) \d{4}/.test(line))
  && !/\[yyyy\]|\{year\}|<year>|notice|owner|Free Software Foundation|holder|license|licence|permission/i.test(line))
  .map((line) => line.replace(/\s+/g, ' ')))];

/**
 * Copyright lines in a package's own source comments, for one whose licence file names none. Built
 * and example files are skipped: they carry other packages' code.
 */
function sourceHolders(dir: string): string[] {
  const found = new Set<string>();
  const skipped = new Set(['node_modules', 'test', 'tests', 'build', 'dist', 'example', 'examples', 'benchmarks']);
  const visit = (path: string, depth: number) => {
    for (const name of readdirSync(path).sort()) {
      if (skipped.has(name) || name.startsWith('.')) continue;
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) { if (depth < 4) visit(child, depth + 1); continue; }
      if (!/\.(c|m)?js$|\.ts$/.test(name) || info.size > 4e6) continue;
      for (const match of readFileSync(child, 'utf8').matchAll(/Copyright\s+(?:\(c\)\s*|©\s*)?\d{4}(?:[-–]\d{4})?[^\n*"'`\\]{0,80}/gi)) {
        found.add(match[0].trim().replace(/\s+/g, ' '));
      }
    }
  };
  visit(dir, 0);
  return [...found].sort().slice(0, 6);
}

/** A package directory's licence files: its own, or for next's compiled ones, one folder down. */
function licenceFiles(dir: string): Text[] {
  const at = existsSync(join(dir, 'package.json')) || !existsSync(dir) ? dir
    : join(dir, readdirSync(dir).find((name) => existsSync(join(dir, name, 'package.json'))) ?? '');
  if (!existsSync(at)) return [];
  return readdirSync(at).filter((name) => LICENCE_FILE.test(name) && statSync(join(at, name)).isFile())
    .map((name) => ({ file: relative(ROOT, join(at, name)), text: read(join(at, name)) }));
}

/** A text of a configured source: installed, npm:<name>@<version>, crate:<name>@<version>/<file> or a URL. */
async function textsOf(spec: string, installed?: string): Promise<{ texts: Text[]; note: string }> {
  if (spec === 'installed') return { texts: installed ? licenceFiles(installed) : [], note: '' };
  const npm = /^npm:(.+)@([^@]+)$/.exec(spec);
  if (npm) return { texts: (await npmLicences(npm[1], npm[2])).map((t) => ({ ...t, text: t.text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n' })), note: `from ${npm[1]} ${npm[2]}'s npm package` };
  const crate = /^crate:(.+)@([^/]+)\/(.+)$/.exec(spec);
  if (crate) {
    const found = await crateFile(crate[1], crate[2], crate[3]);
    return { texts: [{ ...found, text: found.text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n' }], note: '' };
  }
  const text = (await fetchCached(spec)).toString('utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
  return { texts: [{ file: spec, text }], note: `the package ships none; this is ${spec}` };
}

/** The installed copy of `name` that code in `from` loads, as Node resolves it. */
function resolveFrom(from: string, name: string): string | undefined {
  for (let dir = join(ROOT, from); dir.startsWith(ROOT); dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return relative(ROOT, candidate);
    if (dir === ROOT) break;
  }
  return undefined;
}

const missingSource = (name: string): string | undefined => {
  const missing = CONFIG.missingTexts as Record<string, string>;
  return missing[name] ?? Object.entries(missing).find(([pattern]) => pattern.endsWith('/*') && name.startsWith(pattern.slice(0, -1)))?.[1];
};

const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages as Record<string, any>;
const webLock = JSON.parse(readFileSync(join(WEB, 'package-lock.json'), 'utf8')).packages as Record<string, any>;
const lockEntry = (dir: string) => (dir.startsWith('web/') ? webLock[dir.slice(4)] : lock[dir]);

const components: Component[] = [];

/** An installed package's component: its manifest, licence files and copyright lines. */
async function packageComponent(dir: string, where: Set<Where>, inside?: string): Promise<Component> {
  const abs = join(ROOT, dir);
  const compiled = /next\/dist\/compiled\/(.+)$/.exec(dir)?.[1];
  const manifestDir = existsSync(join(abs, 'package.json')) ? abs
    : join(abs, readdirSync(abs).find((name) => existsSync(join(abs, name, 'package.json'))) ?? '.');
  const manifest = existsSync(join(manifestDir, 'package.json')) ? JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8')) : {};
  let texts = licenceFiles(abs);
  let textNote: string | undefined;
  const name = compiled ?? manifest.name;
  const version = compiled ? (manifest.version ?? '') : manifest.version;
  const source = missingSource(name);
  if (!texts.length && source) {
    const found = await textsOf(source.replace('{version}', version));
    texts = found.texts;
    textNote = found.note;
  }
  const own = (CONFIG.partOfNext.names as string[]).includes(compiled ?? '');
  const first = texts[0]?.text ?? '';
  const fromText = /Apache License\s+Version 2\.0/.test(first) ? 'Apache-2.0'
    : /Permission is hereby granted, free of charge/.test(first) ? 'MIT'
      : /Permission to use, copy, modify, and\/or distribute/.test(first) ? 'ISC' : '';
  const licence = own ? 'MIT (part of next)'
    : typeof manifest.license === 'string' ? manifest.license
      : manifest.license?.type ?? (fromText || 'not stated');
  let holders = texts.flatMap((text) => holdersOf(text.text));
  // A GPL or Apache package may name its holders only in its sources' headers.
  if (!holders.length && /GPL|Apache/.test(licence)) holders = sourceHolders(manifestDir);
  return { name: compiled ? `${name} (vendored by next)` : name, version, licence, where: new Set(where), texts, holders, inside, textNote, dir };
}

console.log(`Reading licences (${elapsed()})`);
for (const [dir, where] of shipped) {
  if (!existsSync(join(ROOT, dir))) continue;
  components.push(await packageComponent(dir, where));
}

// Code that packages' prebuilt files inline, by their own source maps.
const byDir = new Map(components.map((component) => [component.dir!, component]));
const inlined = new Map<string, Component>();
for (const [path, where] of files) {
  const map = join(ROOT, `${path}.map`);
  if (!existsSync(map)) continue;
  let sources: string[] = [];
  try { sources = JSON.parse(readFileSync(map, 'utf8')).sources ?? []; } catch { continue; }
  const owner = byDir.get(packageDir(path)!);
  if (!owner) continue;
  for (const source of sources) {
    const at = source.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const parts = source.slice(at + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    if (name === owner.name) continue;
    const key = `${name} ${owner.name}`;
    const found = inlined.get(key);
    if (found) { for (const w of where) found.where.add(w); continue; }
    const installed = resolveFrom(owner.dir!, name);
    const component = installed
      ? await packageComponent(installed, where, owner.name)
      : { name, version: '', licence: 'not known', where: new Set(where), texts: [], holders: [], inside: owner.name };
    inlined.set(key, component);
  }
}
components.push(...inlined.values());

// Prebuilt files config.json describes, which no source map names.
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
for (const [key, described] of Object.entries(CONFIG.bundles as Record<string, any>)) {
  if (key === 'about') continue;
  const path = [...files.keys()].find((file) => file === `node_modules/${key}` || file.endsWith(`/node_modules/${key}`));
  if (!path) continue;
  const where = files.get(path)!;
  const owner = byDir.get(packageDir(path)!)!;
  const bytes = readFileSync(join(ROOT, path));
  if (sha256(bytes) !== described.sha256) {
    throw new Error(`${path} is not the file scripts/notices/config.json describes: review what it carries, then set its sha256 to ${sha256(bytes)}.`);
  }
  if (described.kind === 'dependencies') {
    for (const name of Object.keys(JSON.parse(readFileSync(join(ROOT, owner.dir!, 'package.json'), 'utf8')).dependencies ?? {})) {
      const installed = resolveFrom(owner.dir!, name);
      if (installed) components.push(await packageComponent(installed, where, owner.name));
    }
  } else if (described.kind === 'browserify') {
    for (const [name, code] of browserifyPackages(bytes.toString('utf8'), owner.name)) {
      const entry = described.embeds[name];
      if (!entry) throw new Error(`${path} carries ${name}, which scripts/notices/config.json does not list.`);
      const { texts, note } = await textsOf(entry.text, resolveFrom(owner.dir!, name));
      const installed = resolveFrom(owner.dir!, name);
      const installedManifest = installed ? JSON.parse(readFileSync(join(ROOT, installed, 'package.json'), 'utf8')) : {};
      const holders = [...new Set([...texts.flatMap((text) => holdersOf(text.text)), ...holdersOf(code)])];
      components.push({
        name, version: entry.version, licence: typeof installedManifest.license === 'string' ? installedManifest.license : licenceOf(texts),
        where: new Set(where), texts, holders, inside: owner.name, textNote: note || undefined,
      });
    }
  }
}

/** The packages a browserify bundle carries besides its own, with their modules' code, read without running them. */
function browserifyPackages(source: string, own: string): Map<string, string> {
  const marker = 'return r})()(';
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`${own}'s bundle is not a browserify bundle`);
  const context: { modules?: Record<string, [() => void, Record<string, number>]> } = {};
  vm.runInNewContext(`(function (e, n, t) { modules = e; })(${source.slice(at + marker.length)}`, context);
  const modules = context.modules!;
  const owners = new Map<string, string>();
  const entry = /\},\{\},\[(\d+)\]\)/.exec(source.slice(-200))?.[1] ?? Object.keys(modules)[0];
  const queue: Array<[string, string]> = [[entry, own]];
  while (queue.length) {
    const [id, pkg] = queue.shift()!;
    if (owners.has(id)) continue;
    owners.set(id, pkg);
    for (const [request, child] of Object.entries(modules[id][1])) {
      // A module the bundle was built without (browserify --exclude) has no number.
      if (child === undefined) continue;
      const bare = request.replace(/\/$/, '');
      const name = request.startsWith('.') ? pkg
        : bare === '_process' ? 'process'
          : bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
      queue.push([String(child), name]);
    }
  }
  const code = new Map<string, string>();
  for (const [id, pkg] of owners) if (pkg !== own) code.set(pkg, (code.get(pkg) ?? '') + modules[id][0].toString());
  return code;
}

function licenceOf(texts: Text[]): string {
  const first = texts[0]?.text ?? '';
  if (/Apache License\s+Version 2\.0/.test(first)) return 'Apache-2.0';
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3/.test(first)) return 'GPL-3.0';
  if (/Permission is hereby granted, free of charge/.test(first)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute/.test(first)) return 'ISC';
  if (/Redistribution and use in source and binary forms/.test(first)) return /Neither the name|Neither name/.test(first) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/This is free and unencumbered software/.test(first)) return 'Unlicense';
  return 'not stated';
}

// WebAssembly that packages embed, as config.json lists it.
for (const [name, described] of Object.entries(CONFIG.wasm as Record<string, any>)) {
  if (name === 'about') continue;
  const owner = components.find((component) => component.dir === `node_modules/${name}`);
  if (!owner) continue;
  if (lockEntry(owner.dir!)?.resolved !== described.resolved) {
    throw new Error(`${name} is no longer ${described.resolved}: review the WebAssembly it embeds in scripts/notices/config.json.`);
  }
  for (const embed of described.embeds) {
    const { texts } = await textsOf(embed.text);
    components.push({ name: embed.name, version: embed.version, licence: embed.licence, where: new Set(owner.where), texts, holders: texts.flatMap((text) => holdersOf(text.text)), inside: name });
  }
}

// core-js, in Next's nomodule polyfill.
if (servesPolyfill) {
  const version = /version:"(\d+\.\d+\.\d+)",mode:"global",copyright/.exec(polyfill.toString('utf8'))?.[1];
  if (!version) throw new Error("Next's polyfill names no core-js version: update scripts/notices/make.ts");
  const { texts } = await textsOf(`npm:core-js@${version}`);
  components.push({ name: 'core-js', version, licence: 'MIT', where: new Set<Where>(['P', 'A']), texts, holders: texts.flatMap((text) => holdersOf(text.text)), inside: 'next', textNote: `from core-js ${version}'s npm package` });
}

// ---- writing it ----------------------------------------------------------------------------

const inputs = inputsLine(inputsOf(ROOT));
const WHERE: Record<Where, string> = { P: 'the page', A: 'the app image', I: 'the indexer image' };
const whereOf = (set: Set<Where>) => (['P', 'A', 'I'] as Where[]).filter((w) => set.has(w));
const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
const isApache = (text: string) => /Apache License\s+Version 2\.0, January 2004/.test(text) && text.length > 9000;
const isGpl3 = (text: string) => /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(text);
const sortKey = (name: string) => name.replace(/^@/, '').toLowerCase();

// One entry per name and licence text, its versions and places merged.
interface Entry { name: string; versions: string[]; licence: string; where: Set<Where>; inside: Set<string>; texts: Text[]; holders: Set<string>; textNote?: string }
const entries = new Map<string, Entry>();
for (const component of components) {
  const key = `${component.name} ${component.texts.map((text) => norm(text.text)).join('|')}`;
  const entry = entries.get(key) ?? { name: component.name, versions: [], licence: component.licence, where: new Set<Where>(), inside: new Set<string>(), texts: component.texts, holders: new Set<string>(), textNote: component.textNote };
  const version = component.version + (component.inside ? ` (in ${component.inside})` : '');
  if (component.version && !entry.versions.includes(version)) entry.versions.push(version);
  for (const w of component.where) entry.where.add(w);
  if (component.inside) entry.inside.add(component.inside);
  for (const holder of component.holders) entry.holders.add(holder);
  entries.set(key, entry);
}

const text: string[] = [`SolidPool: licence texts of the third-party code it ships
==========================================================

This file holds the copyright notices and licence texts of the third-party code in the page
SolidPool serves and in its two images, as each component publishes them. THIRD_PARTY_NOTICES.md
lists the same components with where each one ships. The GPL-3.0 and Apache-2.0 texts are long;
entries under those licences name their copyright lines here and point to the full text in this
folder. The fonts' notices and licence are web/app/fonts/OFL.txt.

Made by \`npm run notices\` (scripts/notices/) from the installed packages' own licence files.
Where a package ships none, the entry says so and gives its repository's text where one exists.
${inputs}
`];
for (const entry of [...entries.values()].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)) || a.versions.join().localeCompare(b.versions.join()))) {
  const versions = entry.versions.map((version) => version.replace(/ \(in [^)]+\)$/, '')).filter((v, i, all) => all.indexOf(v) === i).join(', ');
  text.push('-'.repeat(100));
  text.push(`${entry.name}${versions ? ` ${versions}` : ''}  [${entry.licence}]`);
  text.push(`Ships in: ${whereOf(entry.where).map((w) => WHERE[w]).join(', ')}${entry.inside.size ? `, inside ${[...entry.inside].join(', ')}` : ''}`);
  text.push('-'.repeat(100));
  if (!entry.texts.length) {
    if (entry.holders.size) text.push(...entry.holders);
    const why = entry.licence.includes('part of next') ? 'It is covered by the licence of next (Next.js), listed under next.'
      : entry.licence.includes('GPL') ? 'Its licence is the GPL-3.0 by its package.json. Full text: LICENSES/GPL-3.0.txt.'
        : entry.licence.includes('Apache') ? 'Full text: LICENSES/Apache-2.0.txt.'
          : `Its licence is ${entry.licence} by its package.json.`;
    text.push(`(No licence text ships with this component${entry.holders.size ? '' : ', and no copyright line'}. ${why})`);
  }
  for (const t of entry.texts) {
    if (entry.textNote && !t.file.startsWith('node_modules') && !t.file.startsWith('web/')) text.push(`(${entry.textNote}.)`);
    if (isApache(t.text)) {
      const holders = [...entry.holders];
      text.push(...(holders.length ? holders : ['(no copyright line in the licence file)']));
      text.push('Licensed under the Apache License, Version 2.0: LICENSES/Apache-2.0.txt.');
    } else if (isGpl3(t.text)) {
      text.push(...entry.holders);
      text.push('Licensed under the GNU General Public License version 3 or later: LICENSES/GPL-3.0.txt.');
    } else {
      text.push(t.text.replace(/\n+$/, ''));
    }
    text.push('');
  }
}
writeFileSync(join(ROOT, 'LICENSES/third-party.txt'), text.join('\n') + '\n');

// THIRD_PARTY_NOTICES.md: the Corresponding Source table and the inventory, between their markers.
const cell = (value: string) => value.replace(/\|/g, '\\|');
const holdersCell = (holders: Iterable<string>) => [...new Set([...holders].map((holder) => holder
  .replace(/^copyright\s*(\(c\)|\(C\)|©)?\s*/i, '').replace(/\s*All rights reserved\.?/i, '').replace(/\s*<+[^>]*>+/g, '')
  .replace(/ \(https?:[^)]*\)/g, '').replace(/\.$/, '').trim()))].filter(Boolean).join('; ') || 'none published';
interface Row { name: string; licence: string; versions: string[]; where: Set<Where>; holders: Set<string> }
const rows = new Map<string, Row>();
for (const entry of entries.values()) {
  const key = `${entry.name} ${entry.licence}`;
  const row = rows.get(key) ?? { name: entry.name, licence: entry.licence, versions: [], where: new Set<Where>(), holders: new Set<string>() };
  for (const version of entry.versions) if (!row.versions.includes(version)) row.versions.push(version);
  for (const w of entry.where) row.where.add(w);
  for (const holder of entry.holders) row.holders.add(holder);
  rows.set(key, row);
}
// GPL first, then the licences that ask for notices, then those that ask for none.
const family = (licence: string) => (/GPL/.test(licence) ? 0 : /^Apache-2\.0$/.test(licence) ? 1 : /^BSD-[23]-Clause$/.test(licence) ? 2
  : /MIT|ISC/.test(licence) ? 3 : 4);
const byLicence = new Map<string, Row[]>();
for (const row of [...rows.values()].sort((a, b) => family(a.licence) - family(b.licence) || a.licence.localeCompare(b.licence) || sortKey(a.name).localeCompare(sortKey(b.name)))) {
  const list = byLicence.get(row.licence) ?? [];
  list.push(row);
  byLicence.set(row.licence, list);
}
const counts = (['P', 'A', 'I'] as Where[]).map((w) => new Set(components.filter((c) => c.where.has(w)).map((c) => `${c.name} ${c.version}`)).size);
const inventory: string[] = [
  `The page carries ${counts[0]} third-party components, the app image ${counts[1]} and the indexer image ${counts[2]}, by`,
  'name and version, counting code that other packages embed. **P** marks the page, **A** the app',
  'image, **I** the indexer image; a version "in" a package is a copy that package\'s own files carry.',
  '',
  `\`${inputs}\``,
];
for (const [licence, list] of byLicence) {
  inventory.push('', `### ${licence}`, '', '| Component | Version | Where | Copyright |', '| --- | --- | --- | --- |');
  for (const row of list) {
    inventory.push(`| ${cell(row.name)} | ${cell(row.versions.join(', ') || '—')} | ${whereOf(row.where).join(' ')} | ${cell(holdersCell(row.holders))} |`);
  }
}
const missing = [...entries.values()].filter((entry) => entry.textNote?.startsWith('the package ships none') || (!entry.texts.length && !entry.licence.includes('part of next')));
inventory.push('', '### Licence texts the packages leave out', '', '| Component | Licence | In third-party.txt |', '| --- | --- | --- |');
for (const entry of missing.sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)))) {
  inventory.push(`| ${cell(entry.name)} ${entry.versions.map((v) => v.replace(/ \(in [^)]+\)$/, '')).filter((v, i, all) => all.indexOf(v) === i).join(', ')} | ${cell(entry.licence)} | ${entry.texts.length ? `its repository's: ${entry.texts.map((t) => t.file).join(', ')}` : 'none published'} |`);
}

// The GPL-3.0 packages' sources, at the addresses the lockfiles pin.
const sourceOf = (dir: string): string => {
  const resolved: string = lockEntry(dir)?.resolved ?? '';
  const git = /^git\+(?:ssh:\/\/git@|https:\/\/)github\.com[/:]([^#]+?)(?:\.git)?#([0-9a-f]{40})$/.exec(resolved);
  if (git) return `[${git[1]} at ${git[2].slice(0, 7)}](https://github.com/${git[1]}/tree/${git[2]})`;
  return resolved ? `[${resolved.split('/').pop()}](${resolved})` : 'not in the lockfiles';
};
const gpl = components.filter((component) => /GPL/.test(component.licence) && component.where.has('P'));
const source: string[] = ['| Package | Version | Source |', '| --- | --- | --- |'];
const seen = new Set<string>();
for (const component of gpl.sort((a, b) => Number(Boolean(a.inside)) - Number(Boolean(b.inside)) || sortKey(a.name).localeCompare(sortKey(b.name)))) {
  if (seen.has(component.name)) continue;
  seen.add(component.name);
  const dir = component.dir ?? resolveFrom('node_modules', component.name) ?? `node_modules/${component.name}`;
  const noteFor = (CONFIG.sourceNotes as Record<string, string>)[component.name];
  const version = component.inside ? `${component.version}, inside ${component.inside}` : component.version;
  source.push(`| ${component.name} | ${cell(version)} | ${sourceOf(dir)}${noteFor ? `: ${noteFor}` : ''} |`);
}

const notices = join(ROOT, 'THIRD_PARTY_NOTICES.md');
let markdown = readFileSync(notices, 'utf8');
const replaceBlock = (name: string, body: string[]) => {
  const pattern = new RegExp(`(<!-- notices:${name}:start[^>]*-->\\n)[\\s\\S]*?(\\n<!-- notices:${name}:end -->)`);
  if (!pattern.test(markdown)) throw new Error(`THIRD_PARTY_NOTICES.md has no notices:${name} block`);
  markdown = markdown.replace(pattern, (_, start, end) => `${start}\n${body.join('\n')}\n${end}`);
};
replaceBlock('corresponding-source', source);
replaceBlock('inventory', inventory);
writeFileSync(notices, markdown);

console.log(`Wrote LICENSES/third-party.txt (${entries.size} entries) and THIRD_PARTY_NOTICES.md: page ${counts[0]}, app image ${counts[1]}, indexer image ${counts[2]} components (${elapsed()})`);
