// What the deployment scripts refuse, or check, before they connect, spend or write the page's copy.
//   tsx test/deploy-scripts.ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePrivateKeyWif } from '@bitauth/libauth';
import { WebSocketServer } from 'ws';
import { reporter } from './lib/setup';

const { check, finish } = reporter();
const folder = mkdtempSync(join(tmpdir(), 'deploy-scripts-'));
const keyFile = join(folder, 'deployer.key');
writeFileSync(keyFile, '11'.repeat(32), { mode: 0o600 });
const file = join(folder, 'regtest.json');
writeFileSync(file, JSON.stringify({
  network: 'regtest', solidcash: { version: '0.0.1' }, factories: { bch: 'aa'.repeat(32), token: 'bb'.repeat(32) }, events: {}, pools: [],
}));
const plan = join(folder, 'plan.json');
writeFileSync(plan, JSON.stringify({ pools: [{ id: 'bch1', kind: 'bch', name: 'Bitcoin Cash', symbol: 'BCH', decimals: 8, denomination: '1000000' }] }));
// Nothing listens on port 1: a script that gets as far as connecting fails there instead.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, POOL_NETWORK: 'regtest', FULCRUM_URL: 'ws://127.0.0.1:1', DEPLOYER_KEY_FILE: keyFile, DEPLOYMENT_FILE: file };
const run = (args: string[]) => spawnSync('npx', ['tsx', ...args], { encoding: 'utf8', input: '', env });

const deployed = run(['scripts/deploy.ts', plan]);
check(deployed.status !== 0 && /made with SolidCash 0\.0\.1/.test(deployed.stderr) && !/WebSocket/.test(deployed.stderr),
  `deploy.ts refuses a deployment made with another SolidCash before it connects (${deployed.stderr.split('\n').find((line) => /^Error/.test(line)) ?? deployed.status})`);

const verified = run(['scripts/verify-deployment.ts', file, '--write-web']);
check(/^artifacts match their sources$/m.test(verified.stdout) && verified.stdout.indexOf('artifacts') < (verified.stdout.indexOf('factory') >>> 0),
  `verify-deployment --write-web holds the artifacts to their sources first (${verified.stdout.split('\n').filter((line) => /^artifacts|^SolidCash/.test(line)).join(' | ')})`);
check(verified.status !== 0, 'and writes nothing when it cannot go on');

// The environment's factories are the deployment's, or refused.
const named = spawnSync('npx', ['tsx', 'scripts/verify-deployment.ts', file], {
  encoding: 'utf8', input: '', env: { ...env, BCH_FACTORY: 'aa'.repeat(32), TOKEN_FACTORY: 'cc'.repeat(32) },
});
check(/^BCH_FACTORY is the deployment's bch factory/m.test(named.stdout) && /^TOKEN_FACTORY REFUSED$/m.test(named.stdout),
  `verify-deployment holds BCH_FACTORY and TOKEN_FACTORY to the deployment's own (${named.stdout.split('\n').filter((line) => /_FACTORY/.test(line)).join(' | ')})`);

// ---- the deploy command (scripts/deploy-network.ts) ----
// A server that counts who connects to it: nothing below may. The runs are spawned, not run in
// step, so that this process can answer one that did.
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => { wss.once('listening', resolve); });
let connected = 0;
wss.on('connection', (socket) => {
  connected += 1;
  socket.close();
});
const server = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
const command = (args: string[]) => new Promise<{ status: number | null; out: string }>((resolve) => {
  const child = spawn('npx', ['tsx', 'scripts/deploy-network.ts', ...args], { env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  child.on('exit', (status) => resolve({ status, out }));
});
const said = (out: string) => out.split('\n').find((line) => /^deploy:/.test(line)) ?? out.trim().split('\n')[0];

const usage = await command(['--help']);
check(usage.status === 0 && /^Usage: npm run deploy -- <network> \[--server <url>\] \[--key-file <path>\]$/m.test(usage.out),
  'the deploy command prints its usage');
const unknown = await command(['testnet', '--server', server, '--key-file', keyFile]);
check(unknown.status !== 0 && /no network testnet/.test(unknown.out), `it refuses a network it does not know (${said(unknown.out)})`);
const bare = await command(['regtest', '--key-file', keyFile]);
check(bare.status !== 0 && /--server/.test(said(bare.out)), `and regtest without --server (${said(bare.out)})`);
// A key typed on the command line, as an argument or an option's value, is refused and not repeated.
const wif = encodePrivateKeyWif(new Uint8Array(32).fill(0x11), 'testnet');
const keys: Array<[string, string, string[]]> = [
  ['a WIF', wif, ['regtest', '--server', server, wif]],
  ['a WIF as an option\'s value', wif, ['chipnet', '--server', server, `--key-file=${wif}`]],
  ['64 hex digits', '3c'.repeat(32), ['regtest', '--server', server, '--key', `0x${'3c'.repeat(32)}`]],
];
for (const [what, key, args] of keys) {
  const run = await command(args);
  check(run.status !== 0 && /form of a private key/.test(run.out) && !run.out.includes(key) && !run.out.includes(key.slice(4, 16)),
    `and ${what} on its command line, before anything connects, without repeating it (${said(run.out).slice(0, 80)}…)`);
}
const mainnet = await command(['mainnet', '--server', server, '--key-file', keyFile]);
check(mainnet.status !== 0 && /CONFIRM_MAINNET=1/.test(mainnet.out), `and mainnet without CONFIRM_MAINNET=1 (${said(mainnet.out).slice(0, 60)}…)`);
check(connected === 0, `none of those runs connected to the server (${connected} did)`);
wss.close();

rmSync(folder, { recursive: true, force: true });
finish();
