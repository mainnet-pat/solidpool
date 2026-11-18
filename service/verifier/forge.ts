// Forged withdrawals that reach the verifier's last comparison, on the production key. A real
// SDK-built withdrawal (proofs/withdrawal-bch.json) has its statement, its proof or one witness
// changed, and everything else rebuilt as the strongest prover would: nibbles, states, digests,
// ρ, z, handovers and the quotient. Each is refused at the guard named below while every other
// input accepts, so each case tests one guard and nothing in front of it. A re-randomised proof
// is accepted, as it must be: see L2 in AUDIT-2026-11-13.md.
//
//   tsx service/verifier/forge.ts
//
// The shipped prover refuses to carry a false statement to the VM. So this copies the generator
// into a temporary directory and applies forge-mode.patch there, which lets the prover skip its
// own checks and return each identity's quotient. The generator itself, and the page's bundle,
// never hold that code. tamper.ts covers the checks in front of these guards.
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binToHex, createVirtualMachineBch2026, decodeAuthenticationInstructions, decodeTransaction,
  encodeAuthenticationInstruction, encodeDataPush, flattenBinArray, hexToBin, sha256,
} from '@bitauth/libauth';
import { VERIFIER } from '../lib/config';
import { verifierProgram } from '../../web/src/verifier';
import artifact from './verifier-artifact-3in.json';

const here = dirname(fileURLToPath(import.meta.url));
// The production key, through the global math.mjs reads.
(globalThis as any).__BN_VK_FIXTURES__ = JSON.parse(readFileSync(join(here, 'tornado-bn254-3in.json'), 'utf8'));

let failures = 0;
const check = (condition: unknown, label: string) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'ok      ' : 'FAILED  '} ${label}`);
};

// ---- the generator, with forge mode, in a directory of its own ----
/** Apply a unified diff to the copy. Every hunk must match its file exactly once. */
function applyPatch(root: string, patch: string) {
  const file = join(root, /^\+\+\+ b\/(\S+)/m.exec(patch)![1]);
  let text = readFileSync(file, 'utf8');
  for (const hunk of patch.split(/^@@[^\n]*\n/m).slice(1)) {
    const lines = hunk.replace(/\n$/, '').split('\n');
    const side = (dropped: string) => lines.filter((line) => line[0] !== dropped).map((line) => line.slice(1)).join('\n');
    if (text.split(side('+')).length !== 2) throw new Error(`forge-mode.patch does not apply to ${file}: has the prover changed?`);
    text = text.replace(side('+'), () => side('-'));
  }
  writeFileSync(file, text);
}
const copy = mkdtempSync(join(tmpdir(), 'verifier-forge-'));
process.on('exit', () => rmSync(copy, { recursive: true, force: true }));
for (const dir of ['bn-native-sound', 'sound-si-gls']) {
  const from = join(VERIFIER, dir);
  const to = join(copy, dir);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).filter((file) => file.endsWith('.mjs'))) copyFileSync(join(from, name), join(to, name));
}
// The runtime's helpers and its VK data sit one level above the two directories.
for (const name of ['assert.mjs', 'bytes.mjs', 'vk-3in.json']) copyFileSync(join(VERIFIER, name), join(copy, name));
// The copy loads each of the package's dependencies from where the package itself finds it.
const installed = (name: string): string => {
  for (let dir = VERIFIER; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return realpathSync(join(dir, 'node_modules', name));
    if (dirname(dir) === dir) throw new Error(`${name} is not installed where packages/verifier can load it`);
  }
};
const manifest = JSON.parse(readFileSync(join(VERIFIER, 'package.json'), 'utf8'));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
  mkdirSync(dirname(join(copy, 'node_modules', name)), { recursive: true });
  symlinkSync(installed(name), join(copy, 'node_modules', name), 'dir');
}
applyPatch(copy, readFileSync(join(here, 'forge-mode.patch'), 'utf8'));
const generator = join(copy, 'bn-native-sound');
const { buildProgram } = await import(join(generator, 'script.mjs'));
const { transactionFor } = await import(join(generator, 'transaction.mjs'));
const { encodeUnlocking } = await import(join(generator, 'vm.mjs'));
const P = await import(join(generator, 'protocol.mjs'));
const { p, r, F2, B_TWIST, g1, g2 }: { p: bigint; r: bigint; F2: any; B_TWIST: any; g1: any; g2: any } = await import(join(copy, 'sound-si-gls', 'math.mjs'));

// ---- the withdrawal, and the page's verifier for its pool ----
const fixture = JSON.parse(readFileSync(join(here, 'proofs', 'withdrawal-bch.json'), 'utf8'));
const base = decodeTransaction(hexToBin(fixture.transaction));
if (typeof base === 'string') throw new Error(base);
const sources = fixture.sourceOutputs.map((output: any) => ({
  lockingBytecode: hexToBin(output.lockingBytecode),
  valueSatoshis: BigInt(output.valueSatoshis),
  ...(output.token ? {
    token: {
      category: hexToBin(output.token.category),
      amount: BigInt(output.token.amount),
      ...(output.token.nft ? { nft: { capability: output.token.nft.capability, commitment: hexToBin(output.token.nft.commitment) } } : {}),
    },
  } : {}),
}));
const n = base.inputs.length;
const V = [n - 3, n - 2, n - 1];
const category = binToHex(sources[0].token.category);
const client = verifierProgram();
const program = { R: client.R, pieces: client.pieces };
check(binToHex(client.lock) === binToHex(sources[V[2]].lockingBytecode), 'the page\'s verifier, the same for every pool, is this withdrawal\'s');
const generated = buildProgram();
check(binToHex(generated.R) === binToHex(client.R) && binToHex(generated.code) === client.pieces.map(binToHex).join(''), 'and the generator, in forge mode, builds that same code');

// ---- where an input stops ----
const roles = [0, 1, 2].map((role) => {
  const instructions = decodeAuthenticationInstructions(generated.funcCodes[`role${role}`]);
  const offsets: number[] = [];
  let at = 0;
  for (const instruction of instructions) {
    offsets.push(at);
    at += encodeAuthenticationInstruction(instruction).length;
  }
  const marks = generated.marks.filter((mark: any) => mark.role === role).sort((a: any, b: any) => a.roff - b.roff);
  return { opcodes: instructions.map((instruction) => instruction.opcode), offsets, marks };
});
const truthy = (item: Uint8Array) => item.some((byte, i) => byte !== 0 && !(byte === 0x80 && i === item.length - 1));
/**
 * How an input ends: `accept`; `last`, when every guard held and the last comparison is false;
 * the section of the role program whose guard refused it, `r<role>:<section>`; or `refused`.
 * A refusal inside a shared function is placed where its role program called it.
 */
function verdict(state: any): string {
  if (state.error === undefined) return state.stack.length === 1 ? (truthy(state.stack[0]) ? 'accept' : 'last') : 'refused';
  const frames = [state, ...state.controlStack.filter((frame: unknown) => typeof frame === 'object').reverse()];
  for (const frame of frames) {
    const role = roles.findIndex(({ opcodes }) => opcodes.length === frame.instructions.length
      && frame.instructions.every((instruction: any, k: number) => instruction.opcode === opcodes[k]));
    if (role < 0) continue;
    const offset = roles[role].offsets[Math.max(0, frame.ip - 1)];
    return roles[role].marks.filter((mark: any) => mark.roff <= offset).at(-1)?.name ?? `r${role}:start`;
  }
  return 'refused';
}
const vms = [createVirtualMachineBch2026(true), createVirtualMachineBch2026(false)];
/** Each input's verdict, the same in standard and consensus mode, and whether the whole transaction verifies. */
function judge(transaction: any) {
  const per = transaction.inputs.map((_: unknown, inputIndex: number) => {
    const [standard, consensus] = vms.map((vm) => {
      const found = verdict(vm.evaluate({ inputIndex, sourceOutputs: sources, transaction }));
      return V.includes(inputIndex) || found === 'accept' ? found : 'refused';
    });
    return standard === consensus ? standard : `${standard} (consensus: ${consensus})`;
  });
  return { per, verifies: vms.map((vm) => vm.verify({ transaction, sourceOutputs: sources }) === true) };
}
/** The pool's own inputs accept, unless `pool` says otherwise, and the verifier's end as `verifier` says. */
const expected = (verifier: string[], pool = 'accept') => [pool, ...Array(n - 4).fill('accept'), ...verifier];
const LAST = ['accept', 'accept', 'last'];
function expect(label: string, transaction: any, wanted: string[]) {
  const { per, verifies } = judge(transaction);
  const accepted = wanted.every((w) => w === 'accept');
  check(per.every((found: string, i: number) => found === wanted[i]) && verifies.every((v) => v === accepted), label);
  console.log(`           ${per.map((found: string, i: number) => `${i}:${found}`).join('  ')}`);
}

// ---- building blocks ----
const items = (bytecode: Uint8Array): Uint8Array[] => decodeAuthenticationInstructions(bytecode).map((instruction: any) => (
  'data' in instruction ? instruction.data : instruction.opcode === 0 ? new Uint8Array() : Uint8Array.of(instruction.opcode - 0x50)));
const encode = (pushes: Uint8Array[]) => flattenBinArray(pushes.map((push) => encodeDataPush(push)));
const wordAt = (bytes: Uint8Array, at: number) => { let v = 0n; for (let i = 31; i >= 0; i -= 1) v = (v << 8n) | BigInt(bytes[at + i]); return v; };
const le32 = (value: bigint) => { const out = Buffer.alloc(32); for (let i = 0, v = value; i < 32; i += 1, v >>= 8n) out[i] = Number(v & 0xffn); return out; };
const setWord = (bytes: Uint8Array, at: number, value: bigint) => { const out = Buffer.from(bytes); le32(value).copy(out, at); return out; };
/** Bytes a signed decode reads as v - m, so v mod m: what an unsigned decode must refuse. */
const signAlias = (v: bigint, m: bigint) => (m - v) | (1n << 255n);
const clone = (transaction: any) => ({
  ...transaction, inputs: transaction.inputs.map((input: any) => ({ ...input })), outputs: transaction.outputs.map((output: any) => ({ ...output })),
});
const withVerifier = (unlockings: Uint8Array[], edit: (transaction: any) => void = () => {}) => {
  const transaction = clone(base);
  V.forEach((input, role) => { transaction.inputs[input].unlockingBytecode = Uint8Array.from(unlockings[role]); });
  edit(transaction);
  return transaction;
};

const statement = items(base.inputs[V[2]].unlockingBytecode)[1];
const W = (i: number) => wordAt(statement, 32 * i).toString();
const honest = {
  proof: { a: { x: W(0), y: W(1) }, b: { x: { c0: W(2), c1: W(3) }, y: { c0: W(4), c1: W(5) } }, c: { x: W(6), y: W(7) } },
  publicInputs: [W(8), W(9), W(10)],
};
const asG1 = (point: any) => { const a = point.toAffine(); return { x: a.x.toString(), y: a.y.toString() }; };
const asG2 = (a: any) => ({ x: { c0: a.x.c0.toString(), c1: a.x.c1.toString() }, y: { c0: a.y.c0.toString(), c1: a.y.c1.toString() } });

/** A statement or proof, carried to the VM by the forge-mode prover with everything else rebuilt. */
function forge(label: string, fx: any, wanted: string[], { edit, exact = false }: { edit?: (transaction: any) => void; exact?: boolean } = {}) {
  const t = transactionFor(fx, program, { forge: true });
  // Every chunk identity holds exactly, so only the Groth16 equation can be false.
  const chunks = t.core.exact.slice(0, 33).every(Boolean);
  check(chunks && t.core.exact[33] === exact, `${label}: the 33 chunk identities hold, and the Groth16 equation ${exact ? 'holds' : 'does not'}`);
  expect(`${label}: ${wanted.every((w) => w === 'accept') ? 'accepted' : 'refused where it must be'}`, withVerifier(t.unlockings, edit), wanted);
}

// ---- controls ----
expect('the withdrawal as the SDK built it', base, expected(['accept', 'accept', 'accept']));
expect('its proof rebuilt by the prover the page runs', withVerifier(transactionFor(honest, program).unlockings), expected(['accept', 'accept', 'accept']));
forge('its proof through the forge path', honest, expected(['accept', 'accept', 'accept']), { exact: true });

// ---- theft: the payout to someone else ----
{
  const poolItems = items(base.inputs[0].unlockingBytecode);
  const at = poolItems.findIndex((item, i) => item.length === 25 && poolItems[i - 1]?.length === 4);
  const payeeOf = (lock: Uint8Array, salt: Uint8Array) => wordAt(Uint8Array.from([...sha256.hash(Uint8Array.from([...lock, ...salt])).slice(0, 31), 0]), 0);
  const payout = base.outputs.findIndex((output: any) => binToHex(output.lockingBytecode) === binToHex(poolItems[at]));
  check(at > 0 && payout >= 0 && payeeOf(poolItems[at], poolItems[at - 1]).toString() === honest.publicInputs[2], 'the statement\'s payee is the hash of the pool\'s recipient and salt');
  const attacker = Uint8Array.from([0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(0xa7), 0x88, 0xac]);
  // The client's own search for a salt whose proof fits the verifier.
  let salt = new Uint8Array(4);
  for (let counter = 0; ; counter += 1) {
    salt = Uint8Array.of(counter & 0xff, (counter >> 8) & 0xff, 0, 0);
    if (P.quotientWords([honest.publicInputs[0], honest.publicInputs[1], payeeOf(attacker, salt)]) <= 141) break;
  }
  forge('THEFT: the payee, the pool\'s recipient and salt, and the payout, all the attacker\'s',
    { ...honest, publicInputs: [honest.publicInputs[0], honest.publicInputs[1], payeeOf(attacker, salt).toString()] },
    expected(LAST),
    {
      edit: (transaction) => {
        const pushes = items(transaction.inputs[0].unlockingBytecode);
        pushes[at] = attacker;
        pushes[at - 1] = salt;
        transaction.inputs[0].unlockingBytecode = encode(pushes);
        transaction.outputs[payout] = { ...transaction.outputs[payout], lockingBytecode: attacker };
      },
    });
}

// ---- another statement, or another proof of this one ----
// The pool also refuses these two by its own rules: its nullifier path and its roots are not rebuilt.
forge('DOUBLE SPEND: the nullifier hash + 1', { ...honest, publicInputs: [honest.publicInputs[0], ((BigInt(honest.publicInputs[1]) + 1n) % r).toString(), honest.publicInputs[2]] }, expected(LAST, 'refused'));
forge('the root := 0', { ...honest, publicInputs: ['0', honest.publicInputs[1], honest.publicInputs[2]] }, expected(LAST, 'refused'));
forge('the proof\'s A := 2A', { ...honest, proof: { ...honest.proof, a: asG1(g1(honest.proof.a).double()) } }, expected(LAST));
forge('the proof\'s C := -C', { ...honest, proof: { ...honest.proof, c: asG1(g1(honest.proof.c).negate()) } }, expected(LAST));
forge('the proof\'s B := 2B', { ...honest, proof: { ...honest.proof, b: asG2(g2(honest.proof.b).double().toAffine()) } }, expected(LAST));

// ---- B on the twist but outside G2: the endpoint guard ----
{
  type Point = { x: any; y: any } | null;
  const add = (a: Point, b: Point): Point => {
    if (!a) return b;
    if (!b) return a;
    let slope;
    if (F2.eql(a.x, b.x)) {
      if (!F2.eql(a.y, b.y) || F2.is0(a.y)) return null;
      slope = F2.div(F2.mul(F2.create({ c0: 3n, c1: 0n }), F2.sqr(a.x)), F2.add(a.y, a.y));
    } else slope = F2.div(F2.sub(b.y, a.y), F2.sub(b.x, a.x));
    const x = F2.sub(F2.sub(F2.sqr(slope), a.x), b.x);
    return { x, y: F2.sub(F2.mul(slope, F2.sub(a.x, x)), a.y) };
  };
  const mul = (point: Point, k: bigint): Point => { let out: Point = null; let doubled = point; for (; k; k >>= 1n) { if (k & 1n) out = add(out, doubled); doubled = add(doubled, doubled); } return out; };
  const onTwist = (point: Point) => !!point && F2.eql(F2.sqr(point.y), F2.add(F2.mul(F2.sqr(point.x), point.x), B_TWIST));
  let twist: Point = null;
  for (let k = 1n; !twist; k += 1n) {
    const x = F2.create({ c0: k, c1: 1n });
    try {
      const y = F2.sqrt(F2.add(F2.mul(F2.sqr(x), x), B_TWIST));
      if (y && F2.eql(F2.sqr(y), F2.add(F2.mul(F2.sqr(x), x), B_TWIST))) twist = { x, y };
    } catch { /* not a square */ }
  }
  const cofactor = 2n * p - r;
  const b = g2(honest.proof.b).toAffine();
  const honestB: Point = { x: b.x, y: b.y };
  const ofCofactor = mul(twist, r);
  const small = mul(twist, r * (cofactor / 10069n));
  check(cofactor % 10069n === 0n && mul(small, 10069n) === null, 'the twist\'s cofactor has a point of order 10069');
  const cases: Array<[string, Point]> = [
    ['a random twist point', twist], ['a point of the cofactor group', ofCofactor], ['the honest B plus a cofactor point', add(honestB, ofCofactor)],
    ['a point of order 10069', small], ['the honest B plus a point of order 10069', add(honestB, small)],
  ];
  for (const [label, point] of cases) {
    check(onTwist(point) && mul(point, r) !== null, `${label} is on the twist and outside G2`);
    forge(`B OUTSIDE G2: ${label}`, { ...honest, proof: { ...honest.proof, b: asG2(point) } }, expected(['accept', 'accept', 'r2:t:endpoint']));
  }
}

// ---- witnesses changed and recommitted, from the honest proof ----
const T = transactionFor(honest, program);
const core = T.core;
/** The honest witness with these items changed, and the digests, ρ, z, handovers and quotient recomputed. */
function recommitted({ STMT, S, WQ, states }: { STMT?: Uint8Array; S?: Uint8Array[]; WQ?: Uint8Array; states?: bigint[][] }) {
  const c: any = { ...core, states: states ?? core.states, STMT: STMT ?? core.STMT, S: S ?? core.S, WQ: WQ ?? core.WQ };
  c.D = Buffer.concat([P.sha(c.S[0]), P.sha(c.S[1]), P.sha(c.STMT, c.S[2])]);
  c.h0 = P.sha(P.TAG, c.D);
  c.rhoRaw = P.sha(c.h0, Buffer.from('rho'));
  c.rho = P.toFp(c.rhoRaw);
  if (!WQ) {
    // The quotient the honest prover would send for the new ρ, so that the guard under test is what refuses.
    const mod = (x: bigint) => ((x % p) + p) % p;
    const terms = Array(core.Qs.reduce((most: number, q: bigint[]) => Math.max(most, q.length), 0) + 1).fill(0n);
    core.Qs.forEach((q: bigint[], k: number) => {
      let weight = 1n;
      for (let i = 0; i < P.K_IDS - 1 - k; i += 1) weight = mod(weight * c.rho);
      q.forEach((x, i) => { if (x) terms[i] = mod(terms[i] + weight * x); });
    });
    const odd = terms.filter((_, i) => i % 2 === 1);
    while (odd.length > 1 && odd.at(-1) === 0n) odd.pop();
    c.WQ = Buffer.concat(odd.slice().reverse().map(le32));
  }
  const z = P.zOf(c, P.zTail(T.fills[2], c.WQ));
  let state = P.startState(c, z);
  const H: Uint8Array[] = [];
  for (let i = 0; i < 2; i += 1) { state = P.runRange(c, z, P.CUTS[i], P.CUTS[i + 1], state); H.push(P.encodeHand(state)); }
  const pushes = T.pushes.map((list: Uint8Array[]) => list.map((item) => Buffer.from(item)));
  [pushes[0][0], pushes[1][0], pushes[2][2]] = c.S;
  [pushes[2][0], pushes[2][1], pushes[2][6], pushes[1][1], pushes[2][3]] = [c.D, c.STMT, c.WQ, H[0], H[1]];
  return withVerifier(pushes.map((list: Uint8Array[]) => Uint8Array.from(encodeUnlocking(list))));
}
expect('the recommitting path with nothing changed', recommitted({}), expected(['accept', 'accept', 'accept']));

// A false state anywhere reaches the last comparison through the running sum and the handovers.
for (const [role, k] of [[0, 0], [0, 11], [1, 3], [2, 2]] as const) {
  const records: number[] = P.ROLES[role].records;
  const at = records.slice(0, k + 1).reduce((sum, size) => sum + size, 0) - 192;
  const S = core.S.map((stream: Uint8Array, i: number) => (i === role ? setWord(stream, at, (wordAt(stream, at) + 1n) % p) : stream));
  const chunk = P.ROLES[role].chunks[k];
  const states = core.states.map((words: bigint[], j: number) => (j === chunk ? [(words[0] + 1n) % p, ...words.slice(1)] : words));
  expect(`FALSE STATE: role ${role}, state ${k}, word 0 + 1, with the handovers following it`, recommitted({ S, states }), expected(LAST));
}

// ---- encodings: one value, one spelling ----
// The pool reads the statement's three words, so it refuses their aliases too. A refusal by a
// decoding guard is all that keeps an alias of a nullifier hash from being a second spend.
const L0 = P.STMT_LAYOUT;
const everyRole = ['r0:statement', 'r1:statement', 'r2:statement'];
const inStatement = (label: string, at: number, value: bigint, poolReads: boolean) => expect(
  `ALIAS: ${label}`, recommitted({ STMT: setWord(core.STMT, at, value) }), expected(everyRole, poolReads ? 'refused' : 'accept'));
{
  const word = (at: number) => wordAt(core.STMT, at);
  inStatement('the root + r', L0.n0, word(L0.n0) + r, true);
  inStatement('the nullifier hash + r', L0.n1, word(L0.n1) + r, true);
  inStatement('the nullifier hash + 2r', L0.n1, word(L0.n1) + 2n * r, true);
  inStatement('the nullifier hash, sign-bit alias', L0.n1, signAlias(word(L0.n1), r), true);
  inStatement('the nullifier hash with bit 255 set', L0.n1, word(L0.n1) | (1n << 255n), true);
  inStatement('the payee, sign-bit alias', L0.n2, signAlias(word(L0.n2), r), true);
  inStatement('A.x + p', 0, word(0) + p, false);
  inStatement('B.x.c1, sign-bit alias', 96, signAlias(word(96), p), false);
  inStatement('C.y + p', 224, word(224) + p, false);
  inStatement('the residue root\'s word 5 + p', L0.sc + 160, word(L0.sc + 160) + p, false);
  let at = L0.N1;
  while (core.STMT[at] !== 0) at += 1;
  const nibble = Buffer.from(core.STMT);
  nibble[at] = 0x80;
  expect('ALIAS: a nibble of 0x80 where the honest one is 0', recommitted({ STMT: nibble }), expected(everyRole));
}
for (const [role, which, change] of [[0, 't', 'p'], [1, 't', 'sign'], [2, 't', 'p'], [0, 'state', 'sign'], [1, 'state', 'p'], [2, 'state', 'sign']] as const) {
  // The first inverse norm opens a role's stream; the first state closes its first record.
  const at = which === 't' ? 0 : P.ROLES[role].records[0] - 192;
  const v = wordAt(core.S[role], at);
  const S = core.S.map((stream: Uint8Array, i: number) => (i === role ? setWord(stream, at, change === 'p' ? v + p : signAlias(v, p)) : stream));
  const verifier = ['accept', 'accept', 'accept'];
  verifier[role] = `r${role}:loop`;
  expect(`ALIAS: role ${role}'s first ${which === 't' ? 'inverse norm' : 'state word'}, ${change === 'p' ? '+ p' : 'sign-bit alias'}`, recommitted({ S }), expected(verifier));
}
{
  const Q = core.WQ;
  const last = Q.length / 32 - 1;
  expect('ALIAS: the quotient\'s word 0 + p', recommitted({ WQ: setWord(Q, 0, wordAt(Q, 0) + p) }), expected(['accept', 'accept', 'r2:quotient']));
  expect('ALIAS: the quotient\'s last word, sign-bit alias', recommitted({ WQ: setWord(Q, 32 * last, signAlias(wordAt(Q, 32 * last), p)) }), expected(['accept', 'accept', 'r2:quotient']));
  expect('ALIAS: the quotient with a leading zero word', recommitted({ WQ: Buffer.concat([Buffer.alloc(32), Q]) }), expected(['accept', 'accept', 'r2:layout']));
  expect('ALIAS: the quotient with a leading word of 2^255, a signed zero', recommitted({ WQ: Buffer.concat([setWord(Buffer.alloc(32), 0, 1n << 255n), Q]) }), expected(['accept', 'accept', 'r2:quotient']));
}

// ---- a re-randomised proof: accepted ----
// (sA, B/s, C) proves the same statement, so it pays the same recipient, and anyone can make it
// without the note. It changes the withdrawal's txid, which is why the page finds a withdrawal by
// its nullifier hash and never by its txid (L2).
{
  const s = 123456789n;
  let inverse = 1n;
  for (let e = r - 2n, base2 = s; e > 0n; e >>= 1n, base2 = (base2 * base2) % r) if (e & 1n) inverse = (inverse * base2) % r;
  const fx = { ...honest, proof: { ...honest.proof, a: asG1(g1(honest.proof.a).multiply(s)), b: asG2(g2(honest.proof.b).multiply(inverse).toAffine()) } };
  const unlockings = transactionFor(fx, program).unlockings;
  check(binToHex(unlockings[2]) !== binToHex(base.inputs[V[2]].unlockingBytecode), 'RE-RANDOMISED: the proof is another one');
  expect('RE-RANDOMISED: accepted, paying the same recipient', withVerifier(unlockings), expected(['accept', 'accept', 'accept']));
}

// ---- the prover the page runs carries no false statement ----
{
  const shipped = join(VERIFIER, 'bn-native-sound');
  const { transactionFor: shippedTransactionFor } = await import(join(shipped, 'transaction.mjs'));
  let refused = '';
  try { shippedTransactionFor({ ...honest, publicInputs: ['0', honest.publicInputs[1], honest.publicInputs[2]] }, program); } catch (error) { refused = String((error as Error).message); }
  check(/Groth16 equation fails/.test(refused), 'the shipped prover refuses a false statement before any VM sees it');
}

// ---- one verifier for every pool ----
{
  const code = hexToBin(artifact.codePieces.map((piece) => piece.hex).join(''));
  const named = (bytes: Uint8Array) => binToHex(code).includes(binToHex(bytes));
  check(!named(hexToBin(category)) && !named(hexToBin(category).reverse()), 'the code does not name the withdrawal\'s pool, in either byte order');
  check(binToHex(client.lock) === artifact.lockingHex, 'the artifact names the one lock every pool pins');
  // R's sweep branch runs only for a coin alone in its transaction, as the redeem's first bytes say.
  check(binToHex(client.R).startsWith('c3519c63') && binToHex(client.R).endsWith('68'), 'the redeem opens with the lone-coin sweep branch and closes it');
}

console.log(failures === 0 ? 'PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
