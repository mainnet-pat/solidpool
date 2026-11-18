// The licence texts the installed packages do not hold, fetched once and kept in
// scripts/notices/.cache/, which git ignores: an npm package's tarball, a Rust crate, or a file of a
// repository at a pinned commit or tag. A later remake reads the cache and needs no network.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');

/** The bytes at `url`, from the cache or else the network, kept under a name made from the URL. */
export async function fetchCached(url: string): Promise<Buffer> {
  const name = `${createHash('sha256').update(url).digest('hex').slice(0, 24)}-${url.split('/').pop()!.replace(/[^A-Za-z0-9._@-]/g, '_')}`;
  const file = join(CACHE, name);
  if (existsSync(file)) return readFileSync(file);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${file}.tmp`, bytes);
  renameSync(`${file}.tmp`, file);
  return bytes;
}

/** The files of a .tgz or .crate, by path, read without unpacking it anywhere. */
export function untar(gzipped: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gzipped);
  const files = new Map<string, Buffer>();
  const text = (from: number, length: number) => tar.subarray(from, from + length).toString('utf8').replace(/\0.*$/s, '');
  let longName: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const name = text(at, 100);
    if (!name) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = text(at + 156, 1);
    const prefix = text(at + 345, 155);
    const body = tar.subarray(at + 512, at + 512 + size);
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '');
    else if (type === '0' || type === '') {
      files.set(longName ?? (prefix ? `${prefix}/${name}` : name), Buffer.from(body));
      longName = undefined;
    } else longName = undefined;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)(\.|-|$)/i;

/** An npm package's tarball from the registry. */
export const npmTarball = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

/** The licence files at the root of an npm package's tarball, by name. */
export async function npmLicences(name: string, version: string): Promise<Array<{ file: string; text: string }>> {
  const files = untar(await fetchCached(npmTarball(name, version)));
  return [...files].filter(([path]) => /^[^/]+\/[^/]+$/.test(path) && LICENCE_FILE.test(path.split('/')[1]))
    .map(([path, bytes]) => ({ file: `${name}@${version}/${path.split('/')[1]}`, text: bytes.toString('utf8') }));
}

/** One file of a Rust crate, as crates.io serves it. */
export async function crateFile(name: string, version: string, file: string): Promise<{ file: string; text: string }> {
  const files = untar(await fetchCached(`https://static.crates.io/crates/${name}/${name}-${version}.crate`));
  const bytes = files.get(`${name}-${version}/${file}`);
  if (!bytes) throw new Error(`crate ${name} ${version} has no ${file}`);
  return { file: `${name}-${version}/${file}`, text: bytes.toString('utf8') };
}

export { LICENCE_FILE };
