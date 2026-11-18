// Where the deployment scripts take the deployer's key from: a file only its owner can read, or a
// prompt that shows nothing, never the environment (scripts/lib/network.ts, deployerKeySource).
//   tsx test/deployer-key.ts
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePrivateKeyWif, hexToBin } from '@bitauth/libauth';
import { WebSocketServer } from 'ws';
import { deployerKeySource } from '../scripts/lib/network';
import { reporter } from './lib/setup';

const { check, finish } = reporter();
const KEY = '3c'.repeat(32);
const folder = mkdtempSync(join(tmpdir(), 'deployer-key-'));
const keyFile = (name: string, text: string, mode: number) => {
  const file = join(folder, name);
  writeFileSync(file, text, { mode });
  return file;
};
const thrown = (attempt: () => unknown): string => {
  try { attempt(); return ''; } catch (error) { return (error as Error).message; }
};

// ---- the source, checked before anything connects ----
check(/environment reaches every process/.test(thrown(() => deployerKeySource({ DEPLOYER_KEY: KEY }, true))), 'DEPLOYER_KEY in the environment is refused');
check(/read by others \(mode 644\)/.test(thrown(() => deployerKeySource({ DEPLOYER_KEY_FILE: keyFile('open.key', KEY, 0o644) }, true))),
  'a key file others can read is refused');
const fromFile = deployerKeySource({ DEPLOYER_KEY_FILE: keyFile('own.key', `${KEY}\n`, 0o600) }, false);
check('key' in fromFile && fromFile.key === KEY, 'a key file only its owner reads is read, with no terminal needed');
const junk = thrown(() => deployerKeySource({ DEPLOYER_KEY_FILE: keyFile('junk.key', 'not-a-key-but-a-secret', 0o600) }, true));
check(/holds no private key/.test(junk) && !junk.includes('not-a-key-but-a-secret'), `a file that holds no key is refused without its text (${junk})`);
check(/DEPLOYER_KEY_FILE/.test(thrown(() => deployerKeySource({}, false))), 'with no file and no terminal, nothing is asked');
const asked = deployerKeySource({}, true);
check('prompt' in asked, 'with no file at a terminal, the key is asked for');
// The deploy command's --key-file: held to the same, and read before DEPLOYER_KEY_FILE.
const flagged = deployerKeySource({ DEPLOYER_KEY_FILE: keyFile('other.key', 'ff'.repeat(32), 0o600) }, false,
  { keyFile: keyFile('flag.key', KEY, 0o600) });
check('key' in flagged && flagged.key === KEY, 'a file named with --key-file is read before the one DEPLOYER_KEY_FILE names');
check(/^--key-file \S+ can be read by others \(mode 644\)/.test(thrown(() => deployerKeySource({}, true, { keyFile: keyFile('flag-open.key', KEY, 0o644) }))),
  'and refused, by that name, where others can read it');
check(/environment reaches every process/.test(thrown(() => deployerKeySource({ DEPLOYER_KEY: KEY }, true, { keyFile: keyFile('flag-env.key', KEY, 0o600) }))),
  'DEPLOYER_KEY is refused beside it too');
const wif = encodePrivateKeyWif(hexToBin(KEY), 'testnet');
const fromWif = deployerKeySource({}, false, { keyFile: keyFile('own.wif', `${wif}\n`, 0o600) });
check('key' in fromWif && fromWif.key === wif, 'a WIF in the file is read as it is');

// ---- a script refuses a key in its environment before it connects ----
const run = spawnSync('npx', ['tsx', 'scripts/top-up-sidecars.ts'], {
  encoding: 'utf8', input: '',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, POOL_NETWORK: 'regtest', FULCRUM_URL: 'ws://127.0.0.1:1', DEPLOYER_KEY: KEY },
});
check(run.status !== 0 && /DEPLOYER_KEY is not read/.test(run.stderr) && !`${run.stdout}${run.stderr}`.includes(KEY),
  `top-up-sidecars.ts refuses DEPLOYER_KEY before it connects, and shows no key (${run.stderr.split('\n').find((line) => /Error/.test(line)) ?? run.status})`);

// ---- at a terminal, the key is typed and not shown ----
// A regtest server that answers the checks the scripts make before they ask for the key.
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => { wss.once('listening', resolve); });
wss.on('connection', (socket) => socket.on('message', (data) => {
  const { id, method } = JSON.parse(String(data));
  const answers: Record<string, unknown> = {
    'server.version': ['Fulcrum 2.1.0', '1.4'],
    'server.features': { genesis_hash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206' },
    'blockchain.relayfee': 0.00001,
  };
  socket.send(JSON.stringify(method in answers
    ? { jsonrpc: '2.0', id, result: answers[method] }
    : { jsonrpc: '2.0', id, error: { code: 1, message: `${method} is not answered here` } }));
}));
const port = (wss.address() as AddressInfo).port;
const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasScript) {
  console.log('skipped  the terminal prompt: script(1), which gives the run a terminal, is not installed');
} else {
  // script(1) runs the command on a terminal of its own, which echoes what is typed unless the
  // program turns that off.
  const command = `POOL_NETWORK=regtest FULCRUM_URL=ws://127.0.0.1:${port} npx tsx scripts/top-up-sidecars.ts`;
  const child = spawn('script', ['-qec', command, '/dev/null'], { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let seen = '';
  let typed = false;
  child.stdout.on('data', (chunk) => {
    seen += String(chunk);
    if (!typed && seen.includes('Deployer key (not shown): ')) {
      typed = true;
      child.stdin.write(`${KEY}\r`);
    }
  });
  const exited = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 90_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  check(typed, 'the key is asked for once the server has passed its checks');
  check(typed && !seen.includes(KEY) && !seen.includes(KEY.slice(0, 8)) && !/\*{8}/.test(seen),
    `what is typed is not shown, nor its length (the run went on and stopped with ${exited})`);
  check(/deployer bchreg:|not answered here/.test(seen), 'and the run went on with the typed key');
}
wss.close();
rmSync(folder, { recursive: true, force: true });
finish();
