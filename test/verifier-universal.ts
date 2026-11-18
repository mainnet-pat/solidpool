// The verifier entry as a browser would load it: esbuild for the browser, no aliases, no
// injects, no shims, and a page with no Node globals. It must accept the production proof
// and produce the same unlockings as the Node path. This bundles with esbuild; the Next
// (Turbopack) bundle the app ships is tested by test:app.
//   tsx test/verifier-universal.ts
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hexToBin } from '@bitauth/libauth';
import { build } from 'esbuild';
import { VERIFIER } from '../service/lib/config';
import { playwright } from './lib/browser';

const { chromium } = await playwright();

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const runtimePath = join(VERIFIER, 'bn-native-sound', 'runtime.mjs');

// ---- static: the runtime graph must not name a Node built-in or Node-only global ----
const graph = new Set<string>();
const visit = (file: string) => {
  if (graph.has(file)) return;
  graph.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const next = resolve(dirname(file), specifier);
    if (next.endsWith('.mjs') || next.endsWith('.js')) visit(next);
  }
};
visit(runtimePath);
for (const file of graph) {
  const source = readFileSync(file, 'utf8');
  const name = relative(ROOT, file);
  for (const [label, pattern] of [
    ['node: import', /from\s+['"]node:/],
    ['require', /\brequire\s*\(/],
    ['process', /\bprocess\s*\./],
    ['__dirname', /\b__dirname\b/],
    ['Buffer', /\bBuffer\b/],
  ] as const) {
    if (pattern.test(source)) throw new Error(`${name} still uses ${label}`);
  }
}
console.log(`runtime graph (${graph.size} files):`);
for (const file of graph) console.log(`  ${relative(ROOT, file)}`);

// ---- the production artifact's program, as verifierProgram builds it ----
const artifact = JSON.parse(readFileSync(join(ROOT, 'service', 'verifier', 'verifier-artifact-3in.json'), 'utf8'));
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
// One program for every pool: the code names none.
const code = hexToBin(artifact.codePieces.map((piece: { hex: string }) => piece.hex).join(''));
const redeem = hexToBin(artifact.redeemHex);
const firstPiece = artifact.codePieces[0].bytes;
const program = {
  R: redeem,
  pieces: [code.subarray(0, firstPiece), code.subarray(firstPiece)],
};
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// ---- the Node runtime's answer ----
const nodeVerifier: any = await import(pathToFileURL(runtimePath).href);
const nodeRun = nodeVerifier.transactionFor(fixture, program);
const nodeLock = nodeVerifier.lockingOf(program);
const nodeAccepted = (mode: string) => nodeVerifier.spendAll([nodeLock, nodeLock, nodeLock], nodeRun.unlockings, mode)
  .map((run: any) => run.accepted);

// ---- the same entry, bundled for the browser with no alias/inject/shim ----
const outdir = mkdtempSync(join(tmpdir(), 'verifier-universal-'));
const bundlePath = join(outdir, 'verifier.js');
await build({
  entryPoints: [runtimePath],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: bundlePath,
  absWorkingDir: ROOT,
  logLevel: 'silent',
});
const html = '<!doctype html><meta charset="utf-8"><script type="module">import * as verifier from "./verifier.js"; window.verifier = verifier;</script>';
const server = createServer((request, response) => {
  if (request.url === '/verifier.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(readFileSync(bundlePath));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(html);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (error: Error) => pageErrors.push(error.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => Boolean((window as any).verifier), null, { timeout: 30_000 });
await page.evaluate(`window.__verifierInput = ${JSON.stringify({
  fixture,
  R: [...program.R],
  pieces: program.pieces.map((piece) => [...piece]),
})}`);
const result = await page.evaluate(`(() => {
  const verifier = window.verifier;
  const input = window.__verifierInput;
  const program = { R: Uint8Array.from(input.R), pieces: input.pieces.map((piece) => Uint8Array.from(piece)) };
  const run = verifier.transactionFor(input.fixture, program);
  const lock = verifier.lockingOf(program);
  const runMode = (mode) => verifier.spendAll([lock, lock, lock], run.unlockings, mode).map((entry) => entry.accepted);
  const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    unlockings: run.unlockings.map((unlocking) => toHex(unlocking)),
    consensus: runMode('consensus'),
    standard: runMode('standard'),
  };
})()`) as { unlockings: string[]; consensus: boolean[]; standard: boolean[] };

await browser.close();
server.close();
rmSync(outdir, { recursive: true, force: true });

const nodeUnlockings = nodeRun.unlockings.map(hex);
if (JSON.stringify(result.unlockings) !== JSON.stringify(nodeUnlockings)) {
  throw new Error('the browser unlockings differ from the Node ones');
}
for (const [mode, accepted] of [['consensus', nodeAccepted('consensus')], ['standard', nodeAccepted('standard')]] as const) {
  if (!accepted.every(Boolean) || !result[mode].every(Boolean)) throw new Error(`the verifier refused a proof in ${mode}`);
}
if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join('; ')}`);
console.log(`browser verifier accepted 3 unlockings in consensus and standard mode; ${result.unlockings.map((x: string) => x.length / 2).join(' / ')} B`);
console.log('PASS');
