// How a Fulcrum server's chain is told (web/src/network-check.ts), against a server that answers as
// each chain would. No network: the checkpoints are BCHN's, and the scripts and the indexer meet
// real servers.
//   tsx test/network-check.ts
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import {
  checkServerAt, publicChainOf, serverNetworkProblem, serverSoftwareProblem, serverUrlProblem, type ServerCall,
} from '../web/src/network-check';
import { connectServer } from '../scripts/lib/network';
import { Fulcrum } from '../web/src/fulcrum';
import { reporter } from './lib/setup';

const { check, finish } = reporter();

const MAINNET_GENESIS = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const TESTNET4_GENESIS = '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b';
const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const MAINNET_CHECKPOINT = { height: 951145, hash: '000000000000000000f64dbed68370486f945097ba90b17e30d7bf5c43df7a60' };
const CHIPNET_CHECKPOINT = { height: 284827, hash: '000000007af65a6e8853f858b3f2a8e7edabe41e6264410276705b324267d7d8' };
/** A header whose parent is `parent`, as a server sends it: version, then the parent's bytes reversed. */
const headerAfter = (parent: string) => `00000020${parent.match(/../g)!.reverse().join('')}${'11'.repeat(32)}${'22'.repeat(12)}`;
const server = (
  genesis: string | undefined, headers: Record<number, string> = {}, software = 'Fulcrum 2.1.0',
): ServerCall => async (method, params) => {
  if (method === 'server.version') return [software, '1.4'];
  if (method === 'server.features') return genesis === undefined ? {} : { genesis_hash: genesis, hash_function: 'sha256' };
  if (method === 'blockchain.block.header') {
    const header = headers[Number(params[0])];
    if (header === undefined) throw new Error('height out of range');
    return header;
  }
  throw new Error(`unknown method ${method}`);
};
const follows = async (network: 'mainnet' | 'chipnet' | 'regtest', call: ServerCall, label: string) => {
  const problem = await serverNetworkProblem(network, call);
  check(problem === undefined, `${label} follows ${network}${problem ? `: ${problem}` : ''}`);
};
const refused = async (network: 'mainnet' | 'chipnet' | 'regtest', call: ServerCall, pattern: RegExp, label: string) => {
  const problem = await serverNetworkProblem(network, call);
  check(problem !== undefined && pattern.test(problem), `${label} is not ${network}: ${problem ?? 'accepted'}`);
};
check(headerAfter(MAINNET_CHECKPOINT.hash).length === 160, 'a test header is 80 bytes');
const mainnet = server(MAINNET_GENESIS, { [MAINNET_CHECKPOINT.height + 1]: headerAfter(MAINNET_CHECKPOINT.hash) });
const chipnet = server(TESTNET4_GENESIS, { [CHIPNET_CHECKPOINT.height + 1]: headerAfter(CHIPNET_CHECKPOINT.hash) });
await follows('mainnet', mainnet, 'a mainnet server');
await follows('chipnet', chipnet, 'a chipnet server');
await follows('regtest', server(REGTEST_GENESIS), 'a regtest server');
await refused('chipnet', mainnet, /follows mainnet/, 'a mainnet server');
await refused('mainnet', chipnet, /chipnet or testnet4/, 'a chipnet server');
// Same genesis, another chain past the split: BTC, BSV or eCash beside mainnet, testnet4 beside chipnet.
await refused('mainnet', server(MAINNET_GENESIS, { [MAINNET_CHECKPOINT.height + 1]: headerAfter('33'.repeat(32)) }),
  /another chain with mainnet's genesis/, 'a chain that split from mainnet');
await refused('chipnet', server(TESTNET4_GENESIS, { [CHIPNET_CHECKPOINT.height + 1]: headerAfter('44'.repeat(32)) }),
  /another chain with chipnet's genesis/, 'testnet4');
await refused('mainnet', server(MAINNET_GENESIS), /no block 951146/, 'a server short of the checkpoint');
await refused('mainnet', server(MAINNET_GENESIS, { [MAINNET_CHECKPOINT.height + 1]: 'beef' }), /no header/, 'a server with a malformed header');
await refused('chipnet', server('00'.repeat(32)), /genesis 0{64}/, 'the devnet\'s service');
await refused('regtest', chipnet, /chipnet or testnet4, not regtest/, 'a chipnet server');
await refused('chipnet', server(undefined), /named no genesis/, 'a server that names no genesis');
const noFeatures: ServerCall = async (method) => {
  if (method === 'server.version') return ['Fulcrum 2.1.0', '1.4'];
  throw new Error('unknown method');
};
await refused('chipnet', noFeatures, /did not say/, 'a server that answers but names no chain');
let thrown = '';
try { await serverNetworkProblem('chipnet', async () => { throw new Error('closed'); }); } catch (error) { thrown = (error as Error).message; }
check(thrown === 'closed', `a server that does not answer is not refused but thrown, since it may only be down (${thrown})`);

// ---- Fulcrum 1.10 or later, which answers blockchain.scripthash.get_first_use ----
const chipnetRunning = (software: string) => server(TESTNET4_GENESIS, { [CHIPNET_CHECKPOINT.height + 1]: headerAfter(CHIPNET_CHECKPOINT.hash) }, software);
for (const software of ['Fulcrum 1.10.0', 'Fulcrum 1.11.1', 'Fulcrum 2.1.0']) await follows('chipnet', chipnetRunning(software), software);
for (const software of ['Fulcrum 1.9.8', 'Fulcrum 1.2.4', 'ElectrumX 1.16.0', 'SolidPool devnet', '']) {
  await refused('chipnet', chipnetRunning(software), /Fulcrum 1\.10 or later/, software || 'nameless software');
}
check(serverSoftwareProblem('not a list') !== undefined && serverSoftwareProblem(['Fulcrum 1.10']) === undefined, 'the answer is read as Electrum gives it');
check(publicChainOf(MAINNET_GENESIS) !== undefined && publicChainOf(TESTNET4_GENESIS) !== undefined, 'mainnet and chipnet are public chains');
check(publicChainOf(REGTEST_GENESIS) === undefined && publicChainOf('00'.repeat(32)) === undefined && publicChainOf(undefined) === undefined,
  'regtest and the devnet are not');

// ---- TLS on the public networks, the devnet's plain socket kept ----
for (const [network, url] of [
  ['mainnet', 'ws://electrum.example.org:50003'], ['chipnet', 'https://chipnet.example.org'],
  ['chipnet', '/api/fulcrum'], ['mainnet', 'wss://'], ['chipnet', 'electrum.example.org:50004'],
]) check(serverUrlProblem(network, url) !== undefined, `${network} refuses ${url}`);
for (const [network, url] of [
  ['mainnet', 'wss://electrum.example.org:50004'], ['chipnet', ' WSS://chipnet.example.org:50004 '],
  ['devnet', 'ws://127.0.0.1:8788'], ['devnet', 'http://192.168.1.5:8788'],
]) check(serverUrlProblem(network, url) === undefined, `${network} takes ${url}`);

// ---- a script or the indexer: TLS, or a plain socket only to this machine or its private network ----
const nearby = (network: string, url: string) => serverUrlProblem(network, url, { nearbyPlain: true });
for (const url of [
  'ws://electrum.example.org:50003', 'ws://203.0.113.5:50003', 'ws://[2001:db8::1]:50003', 'http://127.0.0.1:50003', 'tcp://127.0.0.1:50001',
]) check(nearby('mainnet', url) !== undefined && nearby('chipnet', url) !== undefined, `a script refuses mainnet and chipnet from ${url}`);
for (const url of [
  'wss://electrum.example.org:50004', 'ws://127.0.0.1:50003', 'ws://localhost:50003', 'ws://10.1.2.3:50003', 'ws://172.20.0.4:50003',
  'ws://192.168.1.5:50003', 'ws://[::1]:50003', 'ws://[fd12::1]:50003', 'ws://[::ffff:10.0.0.1]:50003', 'ws://fulcrum-mainnet:50003',
  'ws://fulcrum.internal:50003',
]) check(nearby('mainnet', url) === undefined, `a script takes mainnet from ${url}`);
check(nearby('regtest', 'ws://electrum.example.org:50003') === undefined, 'and any socket for a rehearsal on regtest');
// connectServer refuses such a server before it opens a socket to it.
const keptSocket = globalThis.WebSocket;
const tried: string[] = [];
(globalThis as { WebSocket?: unknown }).WebSocket = class { constructor(url: string) { tried.push(url); throw new Error('no network in this test'); } };
let refusedPlain = '';
try { await connectServer('chipnet', 'ws://203.0.113.5:50003'); } catch (error) { refusedPlain = (error as Error).message; }
globalThis.WebSocket = keptSocket;
check(/plain ws:\/\/ only from this machine/.test(refusedPlain) && tried.length === 0, `connectServer refuses a plain socket across the internet before opening it (${refusedPlain || tried.join(', ')})`);


// ---- each call within its own time, over a real socket ----
// A regtest server on this machine that answers each call after `delay` ms, or never.
const slowServer = async (delay: number | undefined) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => { wss.once('listening', resolve); });
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const { id, method } = JSON.parse(String(data));
    const result = method === 'server.version' ? ['Fulcrum 2.1.0', '1.4'] : { genesis_hash: REGTEST_GENESIS };
    if (delay !== undefined) setTimeout(() => socket.send(JSON.stringify({ jsonrpc: '2.0', id, result })), delay);
  }));
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, close: () => wss.close() };
};
// Two calls of 300 ms each: a budget of 500 ms for the whole check once called that "did not
// answer in time", and a start took a server unchecked.
const slow = await slowServer(300);
const answered = await checkServerAt(slow.url, 'regtest', 500);
check(!answered.problem && !answered.unreachable, `a server that answers each call in time is checked, however many calls (${JSON.stringify(answered)})`);
slow.close();
const silent = await slowServer(undefined);
const started = Date.now();
const unanswered = await checkServerAt(silent.url, 'regtest', 300);
check(unanswered.unreachable !== undefined && Date.now() - started < 2_000, `one that never answers is unreachable once a call's time is up (${unanswered.unreachable})`);
silent.close();
const kept = globalThis.WebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket = undefined;
const noSocket = await checkServerAt('wss://electrum.example.org:50004', 'mainnet');
globalThis.WebSocket = kept;
check(/no WebSocket/.test(noSocket.problem ?? ''), `a runtime with no WebSocket cannot check one, which is a problem (${noSocket.problem ?? JSON.stringify(noSocket)})`);


// ---- every connection a client opens is asked again, after a reconnect too ----
// A server that answers as regtest, then, once it drops its connections, as chipnet.
{
  let genesis = REGTEST_GENESIS;
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => { wss.once('listening', resolve); });
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const { id, method } = JSON.parse(String(data));
    const result = method === 'server.version' ? ['Fulcrum 2.1.0', '1.4'] : method === 'server.features' ? { genesis_hash: genesis } : 0.00001;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }));
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  Fulcrum.connectionCheck = (_url, call) => serverNetworkProblem('regtest', call);
  const client = new Fulcrum(url);
  const first = await client.call('blockchain.relayfee').then((fee) => String(fee), (error) => (error as Error).message);
  check(first === '0.00001', `a client's first connection is checked and used (${first})`);
  genesis = TESTNET4_GENESIS;
  for (const socket of wss.clients) socket.close();
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  const after = await client.call('blockchain.relayfee').then((fee) => `answered ${fee}`, (error) => (error as Error).message);
  check(/chipnet or testnet4, not regtest/.test(after), `after a reconnect to a server of another chain, nothing goes over it (${after})`);
  Fulcrum.connectionCheck = undefined;
  client.close();
  wss.close();
}

finish();
