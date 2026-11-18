# Porting tornado-core to Bitcoin Cash with SolidCash

> SolidPool is an independent project, not affiliated with Tornado Cash, its developers,
> or the TORN token. This note records what was reused from the public tornado-core
> repository and why.

This note answers one question: **how much of Tornado Cash's design can be rebuilt
natively on BCH, and what does the missing piece cost?**

Short answer:

- The pool state machine — fixed denominations, commitments, incremental Merkle tree and
  nullifiers — ports directly, and this repository runs it on chain. The relayer and its fee
  are dropped: the deposit prepays every fee.
- The privacy guarantee does not port directly, because it comes from a Groth16 verifier
  over BN254. BCH has no pairing opcode, but it has something that turned out to matter
  more: the May 2026 VM's loops, functions, and arbitrary-precision `OP_MUL`, plus a
  public benchmark that used them.
- A reviewed BCH-native Groth16 verifier already exists:
  **27,624 bytes across 3 inputs in one standard transaction, 20.6M op, 3.5 ms/tx**.
  It fits relay policy today.
- We rebuilt it for **Tornado's actual verifying key**, extended it to the three runtime
  inputs a pool needs, `root`, `nullifierHash` and `recipient`, and composed it with the pool.
  The result is **8,175 bytes of code and an 80-byte redeem, in three standard-relay inputs of
  9,975 / 9,927 / 9,743 B** for the production proof, one verifier every pool shares. A real proof generated with Tornado's
  production proving key is accepted on chain, and a tampered recipient, root, nullifier, or
  proof is rejected.
- Everything else — circuit, trusted setup, verifying key — is reused unchanged. The pool
  state now lives on chain too, which leaves an independent audit.

## 1. What tornado-core actually does

| Piece | File | Behaviour |
| --- | --- | --- |
| Pool | `contracts/Tornado.sol` | Holds deposits, stores commitments, rejects reused commitments, tracks spent nullifiers. |
| Tree | `contracts/MerkleTreeWithHistory.sol` | 20-level incremental MiMC Merkle tree; keeps the last 30 roots. |
| ETH instance | `contracts/ETHTornado.sol` | One denomination per contract; pays recipient and relayer on withdraw. |
| ERC-20 instance | `contracts/ERC20Tornado.sol` | Same pool denominated in a token; `refund` pays gas back in ETH. |
| Verifier | `contracts/Verifier.sol` | Groth16 over BN254, 6 public inputs: `root`, `nullifierHash`, `recipient`, `relayer`, `fee`, `refund`. |
| Circuit | `circuits/withdraw.circom` | Proves `Pedersen(nullifier‖secret)` is a leaf under `root` and that `Pedersen(nullifier) == nullifierHash`. |

A note is `(nullifier, secret)`. The deposit publishes only
`commitment = Pedersen(nullifier‖secret)`. The withdrawal proves membership without
revealing which leaf, and reveals `nullifierHash` once so the contract can stop a second
withdrawal.

The privacy property is entirely carried by the proof: the contract learns that *some*
leaf matches, and nothing else. Remove the proof and the design degenerates into a
transparent commitment list.

## 2. What maps to BCH

This is the first prototype's mapping, kept as the starting point; §4 and
[ARCHITECTURE.md](ARCHITECTURE.md) have what was built. The prototype kept a SHA-256 tree and a
sequencer, where the pools keep a MiMC tree on chain.

| tornado-core | SolidCash / BCH | Notes |
| --- | --- | --- |
| `deposit(commitment)` + `msg.value == denomination` | `deposit(bytes32)` + satoshi container delta | The prototype checks `outState.balance == balance + denomination`; the caller adds the deposit output. |
| `nullifierHashes` mapping | `bytes32 nullifierState` | 64-level SHA-256 sparse Merkle root; the slot path is witness data. |
| `commitments` mapping (duplicate guard) | service/indexer | Removed from the contract. Duplicate-deposit detection is a policy; the nullifier SMT still prevents double withdrawal. |
| `MerkleTreeWithHistory` | `bytes32 root` | 20-level incremental tree; the append path is witness data and the empty root is set in the constructor. SHA-256 instead of MiMC. Root history needs a known-root set or ring buffer. |
| `MiMCSponge` / Pedersen | `sha256` | One opcode. Inside a zk circuit the hash stays MiMC/Pedersen because the circuit is reused. |
| `_recipient.call{value: ...}` | `this.transfer(P2PKH, amount)` | The covenant enforces the output. |
| `_relayer.call{value: _fee}` | `this.transfer(P2PKH(relayer), fee)` | Conditional second transfer. |
| `ReentrancyGuard` | not needed | UTXO spends cannot re-enter in one transaction; state continuity is enforced by the covenant. |
| `event Deposit/Withdrawal` | `event` + event NFTs | |
| ERC-20 instance | CashToken pool | One pool per token category and denomination; the pool coin carries the token amount plus BCH for the miner fee. The local chain mints the native supply; a mainnet issuer creates the category. |
| `isSpent` / `isSpentArray` | mapping reads | The array version becomes a loop or an SDK-side batch read. |
| `Verifier.sol` | **missing** | See §3. |

Two structural differences matter more than they look:

1. **State is a UTXO, not a storage slot.** All tree state lives in one master UTXO, so
   deposits and withdrawals serialize. Tornado's EVM contract also serializes on nonce,
   but here the cost is a full transaction per state step. SolidCash has `split`/`merge`
   and threads to shard this; a production pool should run one pool per denomination and
   shard the tree when deposit volume justifies it.
2. **Nullifiers are one root, not a growing set.** A mapping of spent nullifiers would
   add one entry NFT per withdrawal. The pools use a 64-level SHA-256 sparse Merkle tree: the master state holds only `nullifierState`, and the withdrawal
   supplies the siblings. The contract checks the slot is empty, inserts the nullifier,
   and advances the root. On-chain state is O(1); validation is O(depth) hashing.

## 3. The verifier already exists

The first version of this note projected a Groth16 verifier from raw field arithmetic
and concluded it needed 8–12 inputs and was above the relay limit. That projection was
pessimistic: a public competition has already built and reviewed the real thing.

### The benchmark

[verifier.cash](https://www.verifier.cash) ranks Groth16 verifiers for the BCH 2026 VM.
The harness is [mr-zwets/zk-verifier-bench](https://github.com/mr-zwets/zk-verifier-bench);
the verifier sources and generators are
[mr-zwets/groth16_cashscript](https://github.com/mr-zwets/groth16_cashscript). The score is
total on-chain bytes; entries are gated on accepting valid proofs and rejecting tampered
ones, then graded against consensus and relay limits.

The current best deployable BN254 entry (`bch-groth16-bn254-sound-native`):

| Metric | Value |
| --- | --- |
| Total on-chain bytes | **27,624** (27,475 script + 149 tx overhead) |
| Shape | **3 P2SH32 inputs in one standard transaction** |
| Op cost | 20.6M total in consensus mode (20.7M standard), 7.0M in the heaviest input: 6% under that input's own budget, 12% under the 8.03M a 10,000-byte input buys |
| Limits | fits consensus and **standard relay**; 3.5 ms/tx on BCHN 29.1.0 regtest |
| Review | independently reviewed 2026-10-26; 24/24 invalid vectors rejected, 143/143 red-team runs rejected |
| Construction | SI-GLS: batched torus identity, GLS folding of `e(vk_x, γ)`, affine δ walk, quotient residue |
| Code | 7,310 B across 2 code pieces; 65 B redeem; 3× 35 B locking |
| Padding | 208 B (0.76%) — bytes spent only to buy op budget |

The 4.6 KB single-input entries are *byte oracles*: they ignore op cost and cannot run on
BCH. The 27.6 KB artifact is the smallest reviewed verifier that actually does.

Why it is so much smaller than the naive projection: it never runs a naive Miller loop.
It batches 65 events into 33 committed states, folds the `vk_x` pair into a torus
identity, replaces the hard part of the final exponentiation with a checked residue, and
walks G2 with baked slopes. Every accept-relevant value is either computed, baked, or
hash-committed before the challenge it meets.

### We built it for Tornado's key

`service/verifier/` in this directory holds the Tornado-specific build:

```bash
cd service/verifier
tsx extract-vk.ts          # parse vk from tornado-core/contracts/Verifier.sol
tsx build.ts               # rebuild the verifier program for that vk
```

Its first result was the two-input build, which `service/verifier/verifier-artifact.json`
keeps. `build.ts` now writes the three-input build below, `verifier-artifact-3in.json`.

| | |
| --- | --- |
| Code | **7,308 B**, sha256 `463c6372…0cf06f` (vs 7,310 B for the benchmark's own vk) |
| Pieces | 3,766 B + 3,542 B |
| Redeem `R` | 65 B |
| P2SH32 locking | `aa20 08f761b0…a367d9 87` |
| Roles | 803 / 720 / 2,373 B |
| Prologue | 7,303 B |

The load path recomputes every VK-derived constant (G2 subgroup, δ slopes, GLS tables,
Frobenius lines) and asserts each against `@noble/curves` before the program is built.
Tornado's verifying key passes all of it. The code differs from the reviewed artifact only in
its constants, so its layout is the same and its size within 2 bytes, and its cost should be
the same too, though this build's was not measured: **one standard transaction, three inputs,
~27.6 KB, ~20.6M op**.

The 6 public inputs reduce to 2 runtime inputs without touching the VK math:
Tornado's order is `[root, nullifierHash, recipient, relayer, fee, refund]`, and the
verifier computes `vk_x = IC0 + n0·IC1 + n1·IC2`. Keeping `root` and `nullifierHash`
and fixing the other four to **0** means `IC0` is unchanged — zero terms vanish.

### We extended it to bind the recipient

The reviewed artifact binds two runtime inputs. A pool needs three: without `recipient`
in the statement, a mempool observer can copy the proof and rebuild the transaction with
the payout going to themselves. The benchmark's own `real-keys` work already showed how
to fold *constant* public inputs; this is the runtime version.

On branch `pool-composed` of `groth16_cashscript` (`64d4e57`):

| File | Change |
| --- | --- |
| `sound-si-gls/math.mjs` | GLS factor tables for `IC1..IC3`; the offset correction covers the third input |
| `sound-si-gls/protocol.mjs` | the quotient's bound, `NQ_MAX`, raised for the third input |
| `bn-native-sound/protocol.mjs` | statement grows to 739 B (`n2` + 65-byte `N2`), third quotient term, third binding accumulator |
| `bn-native-sound/script.mjs` | decode/bind `n2`, third `TP/TM` table set, larger nibble mask, three nibble streams per role |
| `bn-native-sound/build.mjs` | three-input assertions |

Tornado's circuit, trusted setup, verifying key, and note format are untouched. The
statement becomes `[root, nullifierHash, recipient]`; `relayer`, `fee`, and `refund` are
fixed at 0 (there is no gas relayer on BCH; the pool pays the miner fee).

Measured with a real production-key proof:

| Metric | Value |
| --- | --- |
| Code | 8,140 B (4,182 + 3,958), 65 B redeem |
| Transaction | 29,750–29,813 B, three P2SH32 inputs (cap 100,000) |
| Input scripts | 9,957 / 9,907 / 9,669 B (cap 10,000) |
| Op cost | 7.49M / 7.47M / 7.29M vs 7.97M / 7.95M / 7.76M (≈6% margin) |
| Modes | consensus **and** standard relay accepted |
| Rejection | tampered recipient / root / nullifier / proof all rejected |

This is the sound version: the proof binds the payout. Composing it with a pool, as the
last three inputs beside the pool's master, recreating its coins, brought it to 8,212 B of
code and a 69-byte redeem: 9,974 / 9,924 / 9,743 B inputs and 7.53M / 7.49M / 7.36M op as
BCHN counts it for the production proof. Sharing one verifier among all pools then took the
37-byte brand out of the code and put an 11-byte lone-input sweep into the redeem: 8,175 B of
code and an 80-byte redeem. `service/verifier/README.md` has the current figures,
and `packages/verifier` holds the code, with its diff from verifier.cash. The app in `web/`
uses it end to end.

### Why the circuit and setup survive

The verifier is circuit-agnostic: it checks the Groth16 equation for a baked verifying
key. Tornado's key is public in `Verifier.sol`, so the same artifact can be rebuilt for it
with no new ceremony and no circuit change. The only public-input decision is which of the
six stay runtime.

### Generating a proof

The benchmark's fixtures are deterministic equation-execution vectors, not proofs from a
circuit: its README says so explicitly. A Tornado port needs real proofs under Tornado's
key. `tornado-core` can build them (`npm run build:circuit` compiles `withdraw.circom`,
runs the setup, and generates `Verifier.sol`; `scripts/downloadKeys.js` fetches the
production keys). Once one withdrawal proof exists, the benchmark harness can grade the
Tornado build exactly as it grades the leaderboard entries.

### What this changes

- The verifier is **not** a research project. It is a reviewed artifact that already fits
  standard relay policy and runs in 3.5 ms.
- The earlier 8–12 input projection was a naive Miller-loop estimate. The real frontier
  is 3 inputs and 27.6 KB.
- The hard part moved from "can BCH verify a pairing?" to the pool state covenant:
  on-chain nullifier set, root history, and a payout rule that survives a hostile
  mempool. The proof side is done.

## 4. What was built

The first version of this repository ran the proof in verifier coins alone, and kept the
root and the nullifier set in a sequencer. That was enough to show the proof fits on chain,
and it was not safe: nothing on chain knew the root, so a proof over a made-up tree would
have paid. The current design closes that, and it is what [ARCHITECTURE.md](ARCHITECTURE.md)
describes. In short:

| tornado-core | Here |
|---|---|
| `deposit` | `deposit` and then `finish`, which hash the tree on chain between them |
| `MerkleTreeWithHistory` | A MiMC tree: 20 levels, a frontier and 8 recent roots, all as digests in state |
| `nullifierHashes` | A 64-level sparse tree, one root in state |
| `withdraw` | `withdraw`, reading the proof's statement from the verifier's input |
| `Verifier.sol` | The composed BCH verifier, recreated in place beside the pool |
| Relayer fee | None: the deposit prepays, and the fee is the input-output delta |

Reusing the circuit and its setup fixes the tree's hash as MiMC, which is the expensive part
on BCH. See PRODUCTION.md for what would lower that.

## 5. If the full zk port is not the next step

| Design | Trust | Anonymity set | On-chain cost | Effort |
| --- | --- | --- | --- | --- |
| Groth16 port (this note) | trustless | whole pool | 29.6 kB, 3 inputs, 22.4M op | done: 3 runtime inputs, composed with a pool |
| Linkable ring signature (LSAG) | trustless | ring size (8–64) | one ecrecover-grade sidecar per member | medium-high |
| Chaumian ecash mint (Cashu-style) | mint can censor, cannot link | whole mint | one signature per note, off-chain | low |
| CoinJoin / CashShuffle | trustless | peers in the round | ordinary transaction | no contract |

The ring signature is the only trustless on-chain alternative, and its cost scales with
the anonymity set: verifying `n` members needs `n` scalar multiplications, and
SolidCash's `ecrecover` already needs two sidecar inputs per scalar multiplication. A
16-member ring is therefore in the same cost class as the zk verifier, with a much
smaller anonymity set.

A Chaumian mint is the pragmatic product today: blind signatures give real unlinkability
at one signature per note, but the mint can refuse to redeem. It maps to BCH as a
federated covenant holding reserves plus an off-chain issuer, not as a Tornado port.

## 6. What remains

See [PRODUCTION.md](PRODUCTION.md). A person reviewed the underlying 2-input artifact. The
3-input binding and its composition with a pool were audited by an independent AI auditor
(`service/verifier/AUDIT-2026-11-13.md`) and checked on BCHN itself
(`service/verifier/CHECKS-2026-11-14.md`). Both read the template before every pool shared it
(sha256 `37c8b9ec…`). A second AI audit, on 2026-11-17 (`contracts/AUDIT-2026-11-17.md`), read
what the template that ships (`7b513096…`, with its sweep branch) changes from that one, but not
its pairing arithmetic, which is unchanged, and read the contracts as compiled at `9ceafd7`. The
contracts have also had adversarial reads, and SolidCash 0.51.0's release review read them
before `b16443b` made the factories unique and the hashing and verifier coins shared. None of
that is a human audit: do not secure mainnet funds with them before one.
