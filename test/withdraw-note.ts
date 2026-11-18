// scripts/withdraw-note.ts's own rules, which need no chain: how it reads an older note in the
// current form, and which servers it reads through. test/app-flows.ts withdraws through it on a
// local chain.
//   tsx test/withdraw-note.ts
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCashAddress } from '@bitauth/libauth';
import { WebSocketServer } from 'ws';
import { readNoteText } from '../web/src/note-text';
import { inCurrentForm, serversProblem } from '../scripts/lib/withdraw-note';
import { reporter } from './lib/setup';

const { check, rejects, finish } = reporter();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- an older note, read in the current form ----
const category = 'ab'.repeat(32);
const asset = 'cd'.repeat(32);
const secret = '11'.repeat(62);
const older = (named: string, amount = '1000000') => readNoteText(`bchnote-${named}-${amount}-0x${secret}`)!;
const current = (text: string) => readNoteText(text);

const bch = current(inCurrentForm(older(category), 'chipnet', { kind: 'bch' }));
check(bch?.network === 'chipnet' && bch.kind === 'bch' && bch.category === category && bch.amount === 1_000_000n && bch.preimageHex === secret,
  'an older note naming a category reads as a current BCH note, with its secret');
const token = current(inCurrentForm(older(category, '100'), 'mainnet', { kind: 'token', asset: asset.toUpperCase() }));
check(token?.kind === 'token' && token.asset === asset && token.amount === 100n && token.network === 'mainnet',
  'and as a token note, with its asset in lowercase');
const byId = current(inCurrentForm(older('bch001'), 'chipnet', { kind: 'bch', category: category.toUpperCase() }));
check(byId?.category === category, 'one naming its pool by an id takes the category named beside it');
await rejects('an id with no category', /CATEGORY=/, async () => inCurrentForm(older('bch001'), 'chipnet', { kind: 'bch' }));
await rejects('a category other than the note\'s', /not the one this note names/,
  async () => inCurrentForm(older(category), 'chipnet', { kind: 'bch', category: 'ef'.repeat(32) }));
await rejects('no kind', /KIND=bch or KIND=token/, async () => inCurrentForm(older(category), 'chipnet', { asset }));
await rejects('a kind nobody knows', /KIND=bch or KIND=token/, async () => inCurrentForm(older(category), 'chipnet', { kind: 'nft' }));
await rejects('a token pool with no asset', /only a token pool, has an asset/, async () => inCurrentForm(older(category), 'chipnet', { kind: 'token' }));
await rejects('a BCH pool with an asset', /only a token pool, has an asset/, async () => inCurrentForm(older(category), 'chipnet', { kind: 'bch', asset }));
await rejects('a current note, which names all of it', /itself/,
  async () => inCurrentForm(readNoteText(`bchnote-chipnet-bch-${category}-1000000-0x${secret}`)!, 'chipnet', { kind: 'bch' }));

// ---- the servers it reads through ----
// The page keeps a server named in Settings only over TLS on mainnet and chipnet, and only once it
// runs Fulcrum 1.10 or later on that network's own chain (web/src/network-check.ts). The script holds
// FULCRUM_URL and BROADCAST_URL to the same, before it reads anything through them.
{
  const asked: string[] = [];
  const answers: Record<string, { problem?: string; unreachable?: string }> = {
    'wss://chain.example': {}, 'wss://other.example': { problem: 'it follows testnet3, not chipnet' }, 'wss://down.example': { unreachable: 'no connection' },
  };
  const stand = async (url: string) => { asked.push(url); return answers[url] ?? {}; };
  check(await serversProblem('chipnet', { FULCRUM_URL: 'wss://chain.example', BROADCAST_URL: undefined }, stand) === undefined,
    'a chipnet server over TLS that answers as chipnet\'s will do, and a second server need not be named');
  check(/^FULCRUM_URL will not do for mainnet: mainnet is read over TLS only/.test(
    await serversProblem('mainnet', { FULCRUM_URL: 'ws://chain.example' }, stand) ?? ''), 'a server without TLS will not');
  check(/^BROADCAST_URL will not do for chipnet: it follows testnet3/.test(
    await serversProblem('chipnet', { FULCRUM_URL: 'wss://chain.example', BROADCAST_URL: 'wss://other.example' }, stand) ?? ''),
  'nor a second server on another chain');
  check(/did not answer \(no connection\)/.test(await serversProblem('chipnet', { FULCRUM_URL: 'wss://down.example' }, stand) ?? ''),
    'nor one that does not answer');
  check(!asked.includes('ws://chain.example'), 'and a server without TLS is not asked anything');
}

// The script itself, as a person runs it: it refuses the server before reading through it.
{
  const note = `bchnote-chipnet-bch-${category}-1000000-0x${secret}`;
  const recipient = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(7) }).address;
  const run = (env: Record<string, string>) => new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(join(ROOT, 'node_modules', '.bin', 'tsx'), [join(ROOT, 'scripts', 'withdraw-note.ts')], {
      cwd: ROOT,
      env: { ...process.env, NOTE: note, RECIPIENT: recipient, BCH_FACTORY: 'ef'.repeat(32), BROADCAST_URL: '', ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code) => { clearTimeout(timer); done({ code, output }); });
  });

  // A plain WebSocket server that records whoever connects.
  const plain = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((done) => { plain.on('listening', done); });
  let connections = 0;
  plain.on('connection', (socket) => { connections += 1; socket.close(); });
  const plainUrl = `ws://127.0.0.1:${(plain.address() as { port: number }).port}`;
  const overPlain = await run({ FULCRUM_URL: plainUrl });
  check(overPlain.code !== 0 && /FULCRUM_URL will not do for chipnet: chipnet is read over TLS only/.test(overPlain.output) && connections === 0,
    'a server without TLS is refused, and nothing connects to it');
  await new Promise((done) => { plain.close(done); });

  // A port nothing listens on, over TLS.
  const probe = createServer();
  await new Promise<void>((done) => { probe.listen(0, '127.0.0.1', done); });
  const closed = (probe.address() as { port: number }).port;
  await new Promise((done) => { probe.close(done); });
  const silent = await run({ FULCRUM_URL: `wss://127.0.0.1:${closed}` });
  check(silent.code !== 0 && /FULCRUM_URL will not do for chipnet: it did not answer/.test(silent.output),
    'a server that does not answer is refused before the withdrawal reads anything');
}

finish();
