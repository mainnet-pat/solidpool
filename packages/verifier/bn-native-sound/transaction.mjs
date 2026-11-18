// Unlocking construction for the 3-input transaction, with prover-sized zero fillers.
//   input 0: [S_0] [DS_0] [C_0] [FILL_0] [R]
//   input 1: [S_1] [HAND_1] [DS_1] [C_1] [FILL_1] [R]
//   input 2: [DG] [STMT] [S_2] [HAND_2] [DS_2] [FILL_2] [WQ] [R]
// The fillers only buy op budget: each is all zero, read by nothing except (FILL_2) the z-tail hash. The honest
// prover sizes each filler so that the input's STANDARD op cost, as BCHN counts it, is at most (1 - MARGIN) of its
// budget, capped at the 10,000-byte unlocking limit.
import {decodeAuthenticationInstructions} from '@bitauth/libauth/build/lib/vm/instruction-sets/common/instruction-sets-utils.js';
import {DS, proveCore, handovers, zOf, zTail} from './protocol.mjs';
import {encodeUnlocking, p2sh32, spendAll, VM_CHARGES_DEFINE} from './vm.mjs';
import {alloc, fromHex} from '../bytes.mjs';

export const MARGIN = 0.06;
export const UNLOCK_CAP = 10000;

/** A build.json object as a program, without touching the filesystem. */
export function buildFrom(build) {
  return {
    R: fromHex(build.redeemHex),
    pieces: build.codePiecesHex.map((hex) => fromHex(hex)),
    lay: build.layout,
  };
}
export const lockingOf = (prog) => Uint8Array.from(p2sh32(prog.R));
export function unlockingsFor(core, prog, fills) {
  const z = zOf(core, zTail(fills[2], core.WQ)); const {H} = handovers(core, z);
  const F = fills.map((n) => alloc(n));
  const pushes = [
    [core.S[0], DS[0], prog.pieces[0], F[0], prog.R],
    [core.S[1], H[1], DS[1], prog.pieces[1], F[1], prog.R],
    [core.D, core.STMT, core.S[2], H[2], DS[2], F[2], core.WQ, prog.R],
  ];
  return {pushes, unlockings: pushes.map((ps) => Uint8Array.from(encodeUnlocking(ps))), z, H};
}
// The bytes of every body an input defines with OP_DEFINE: the code, which the redeem defines as function 1, and each
// function and role program that the code's prologue defines as <body> <id> OP_DEFINE. BCHN charges a defined body as
// pushed bytes (metrics.TallyPushOp in its interpreter); stock libauth 3.1.0-next.8 charges nothing for it
// (bitauth/libauth#166), and this repo's patched copy charges it as BCHN does (vm.mjs VM_CHARGES_DEFINE). Every input
// defines the same bodies: 16,313 B in the build for Tornado's key.
const OP_DEFINE = 0x89;
export function definedBytes(prog) {
  const code = Uint8Array.from(prog.pieces.flatMap((piece) => [...piece]));
  const ins = decodeAuthenticationInstructions(code);
  return ins.reduce((sum, x, i) => (x.opcode === OP_DEFINE ? sum + ins[i - 2].data.length : sum), code.length);
}
// prover-sized fillers: iterate until every input meets the margin (standard mode, BCHN accounting) or hits the cap.
// libauth measures the op cost. A libauth that leaves the defined bodies out gets their bytes added; one that charges
// them already is not charged twice. Either way the margin holds on BCHN and the fillers are the same.
export function sizeFills(core, prog, {margin = MARGIN, fills0 = [0, 0, 0], maxIter = 40, forge = false} = {}) {
  const lock = lockingOf(prog); let fills = fills0.slice(); const defined = VM_CHARGES_DEFINE ? 0 : definedBytes(prog);
  for (let it = 0; it < maxIter; it++) {
    const {unlockings} = unlockingsFor(core, prog, fills);
    const runs = spendAll(unlockings.map(() => lock), unlockings, 'standard').map((x) => ({...x, opCostBchn: x.opCost + defined}));
    const next = runs.map((x, i) => { const base = unlockings[i].length - fills[i] - (fills[i] >= 256 ? 3 : fills[i] >= 76 ? 2 : 1) + 1;
      const need = Math.ceil(x.opCostBchn / ((1 - margin) * 800)) - 41; let f = Math.max(0, need - base); // filler bytes so that U >= need
      // the push header grows with the filler: re-add it
      f = Math.max(0, need - (base - 1) - (f >= 256 ? 3 : f >= 76 ? 2 : 1));
      return Math.min(f, Math.max(0, UNLOCK_CAP - base - 2)); });
    const ok = runs.map((x) => x.opCostBchn <= (1 - margin) * x.budget || x.length >= UNLOCK_CAP - 3);
    if (ok.every(Boolean)) {
      // Each run must reach its end. One that stopped early measured only part of its cost, so the sizes would be too
      // small. That happens when a guard refuses it, or when the budget runs out at the cap.
      // A forged statement is refused at its last comparison, after the whole cost.
      const refused = runs.findIndex((x) => !x.accepted);
      if (refused >= 0 && !forge) throw new Error(`filler sizing: input ${refused} is refused (${runs[refused].error})`);
      return {fills, runs};
    }
    // an input that misses the margin grows its filler (at least 1 B, so the iteration always progresses)
    fills = next.map((f, i) => (ok[i] ? fills[i] : Math.max(f, fills[i] + 1)));
  }
  throw new Error('filler sizing did not converge');
}
export function transactionFor(fx, prog, opts = {}) {
  const core = proveCore(fx, opts); const {fills} = opts.fills ? {fills: opts.fills} : sizeFills(core, prog, opts);
  const {unlockings, pushes, z, H} = unlockingsFor(core, prog, fills);
  return {core, fills, unlockings, pushes, z, H, locking: lockingOf(prog)};
}
