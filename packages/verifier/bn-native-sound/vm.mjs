// libauth bch-2026 runners: the 3-input transaction (every input spends P2SH32(R)), consensus and standard mode.
// The transaction shape mirrors zk-verifier-bench's intra-tx runner (outpoint n of a zero txid, one OP_RETURN output).
import {createVirtualMachineBch2026} from '@bitauth/libauth/build/lib/vm/instruction-sets/bch/2026/bch-2026-vm.js';
import {encodeDataPush} from '@bitauth/libauth/build/lib/vm/instruction-sets/common/push.js';
import {hash256} from '@bitauth/libauth/build/lib/crypto/combinations.js';
import {alloc} from '../bytes.mjs';
export const VMS = {consensus: createVirtualMachineBch2026(false), standard: createVirtualMachineBch2026(true)};
// Whether this libauth charges a body that OP_DEFINE stores as pushed bytes, as BCHN does (CHIP-2025-05 Functions,
// clarification 4; bitauth/libauth#166). This repo's pnpm patch makes 3.1.0-next.8 charge it; the npm release and
// bch-next's fork do not. A 100-byte longer body costs 100 more to push, and 100 more again when its definition is
// charged. transaction.mjs sizes for BCHN, so it adds the defined bodies itself only when this is false.
export const VM_CHARGES_DEFINE = (() => {
  const cost = (n) => {
    const lockingBytecode = Uint8Array.from([...encodeDataPush(alloc(n, 0xaa)), 0x51, 0x89, 0x51]); // <body> 1 OP_DEFINE 1
    const st = VMS.consensus.evaluate({inputIndex: 0, sourceOutputs: [{lockingBytecode, valueSatoshis: 1000n}],
      transaction: {version: 2, locktime: 0, outputs: [{lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n}],
        inputs: [{outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: new Uint8Array()}]}});
    if (st.error !== undefined) throw new Error(`OP_DEFINE probe: ${st.error}`);
    return st.metrics.operationCost;
  };
  const extra = cost(101) - cost(1);
  if (extra !== 100 && extra !== 200) throw new Error(`OP_DEFINE probe: a 100-byte longer body cost ${extra} more`);
  return extra === 200;
})();
export const p2sh32 = (redeem) => Uint8Array.from([0xaa, 0x20, ...hash256(redeem), 0x87]);
export const encodeUnlocking = (pushes) => Uint8Array.from(pushes.flatMap((b) => [...encodeDataPush(Uint8Array.from(b))]));
// Track 11: the outputs of the runner's transaction (default: one OP_RETURN output, as before); real-keys/covenant.mjs
// sets an OP_RETURN carrying the public values.
let OUTPUTS = [{lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 1000n}];
export const setOutputs = (o) => { OUTPUTS = o; };
export const budgetOf = (unlocking) => (41 + unlocking.length) * 800;
// The inputs in front of the verifier's three: by default one plain coin, where a pool's master stands in a withdrawal,
// so the filler sizing and the runners evaluate the roles as a pool transaction runs them. The verifier reads none of it.
export const reverseBin = (b) => Uint8Array.from([...b].reverse());
let PREFIX = [{lockingBytecode: Uint8Array.of(0x51), valueSatoshis: 1000n}];
let RECREATED = (output) => output;
// lets a test change the outputs that recreate the verifier's coins
export const setRecreated = (edit) => { RECREATED = edit; };
export const setPrefix = (sources) => { PREFIX = sources; };
export const programOf = (lockings, unlockings, inputIndex) => ({
  inputIndex: PREFIX.length + inputIndex,
  sourceOutputs: [...PREFIX, ...lockings.map((l) => ({lockingBytecode: Uint8Array.from(l), valueSatoshis: 1000n}))],
  transaction: {version: 2, locktime: 0,
    inputs: [...PREFIX.map((_, n) => ({outpointIndex: n, outpointTransactionHash: Uint8Array.of(...new Array(31).fill(0), 1), sequenceNumber: 0, unlockingBytecode: new Uint8Array()})),
      ...unlockings.map((u, n) => ({outpointIndex: n, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: Uint8Array.from(u)}))],
    outputs: [...OUTPUTS, ...lockings.map((l, i) => RECREATED({lockingBytecode: Uint8Array.from(l), valueSatoshis: 1000n}, i))]},
});
// evaluate every input; accepted = the VM's verify() result for that input (consensus or standard rules)
export function spendAll(lockings, unlockings, mode = 'consensus') {
  const vm = VMS[mode];
  return unlockings.map((u, i) => {
    const prog = programOf(lockings, unlockings, i); const st = vm.evaluate(prog);
    const ok = st.error === undefined && st.stack.length === 1 && st.stack[0].length === 1 && st.stack[0][0] === 1;
    return {accepted: ok, error: st.error ?? (ok ? null : 'final stack ' + st.stack.length), opCost: st.metrics.operationCost, budget: budgetOf(u), length: u.length};
  });
}
export const allAccepted = (rs) => rs.every((x) => x.accepted);
