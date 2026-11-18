# BN254 Groth16 on current BCH (bch-2026), sound by construction: SI-MX3, one transaction with 3 inputs

A full Groth16 verifier for the fixed BN254 VK of the densless fixtures (`../densless-recovered/public-fixtures.json`,
public inputs `n0, n1`) that runs on **current BCH** (libauth `BCH_2026`): one standard transaction with three
P2SH32 inputs, each unlocking at most 10,000 B, each with the per-input op-cost budget `(41 + unlocking length) × 800`.
Bench entry id: `bch-groth16-bn254-sound-native` (status `reviewed`, independent review 2026-10-26).

## This branch: three runtime inputs, composed with a pool

Branch `pool-composed` changes the reviewed build in two ways. The independent review covered the two-input build only.
An AI audit of this branch on 2026-11-13 found no soundness break (`service/verifier/AUDIT-2026-11-13.md` in bch-next).

1. **Three runtime public inputs** `n0, n1, n2`: Tornado's root, nullifier hash and recipient. `STMT` is 739 B (it adds
   `n2` and a third nibble string `N2`), there is a third set of GT-GLS tables, and the binding covers all three.
   A statement can need up to `NQ_MAX` = 168 quotient words, so the degree bound is 347 and the soundness error per
   query `ε ≤ 1.134·(34 + 347)/p ≈ 2^−244.8`.
2. **Composition with a pool.** The verifier is the last three inputs of any transaction: role = input index −
   (input count − 3). It does not count the inputs. Each verifier coin must be recreated in place by the matching one of
   the last three outputs, with the same locking, the same value and no token. The code names no pool, so every pool
   shares one lock, and the verifier checks no input but its own three: the pool reads the statement from role 2's
   `STMT` and judges it against its own state. A coin that has stood unmoved for 1,440 blocks (`SWEEP_AGE`) can be
   swept by anyone, but only as its transaction's only input (R's sweep branch), so no composed transaction ever runs
   that branch. Input 2 holds at most 150 quotient words (`MAX_QUOTIENT_WORDS`), and `quotientWords` tells a client
   which statements fit.

The pools' build of Tornado's key is 8,175 B of code (pieces 4,200 + 3,975) and an 80 B redeem. Its artifact lives in
bch-next, `service/verifier/verifier-artifact-3in.json`, which bch-next's `build.ts` writes and checks.

`build.json` here is not that build. It is the last committed build: the reviewed two-input build of the bench key
(code 7,310 B, sha256 `75c780ae…78d7`). `build.mjs`, `export.mjs` and `redteam.mjs` need fixtures minted with a known
trapdoor, so a three-input build is made with `test-key.mjs`'s key. That key is for tests only, so its build is not
committed, and `redteam.mjs` refuses to run until `build.mjs` has rewritten `build.json` for the key in use. The
Results, Verification and Liveness sections below record the two-input build unless they say otherwise.

**Op cost accounting.** BCHN charges an `OP_DEFINE`d body as pushed bytes. Stock libauth 3.1.0-next.8 charges nothing
for it (bitauth/libauth#166). `patches/@bitauth__libauth@3.1.0-next.8.patch` adds the charge, and `pnpm install` applies
it; a `node_modules` taken from elsewhere may hold stock libauth. `vm.mjs` measures which one it loaded
(`VM_CHARGES_DEFINE`). `transaction.mjs` adds the defined bodies' bytes (`definedBytes`: 16,239 B per input in the
pools' build) only when libauth leaves them out, so the fillers are sized to BCHN's count, and come out the same, on
either. The op costs a run prints are libauth's: BCHN's with the patch, 16,239 B per input less without it.

The mathematics is the reviewed single-input SI-GLS verifier (`../sound-si-gls/README.md`): one batched torus
identity at ±z, GT-GLS folding of `e(vk_x, γ)`, a torus residue root, 33 committed monic states. This build changes
two things (design SI-MX3, `research/sound-bn254-native/`, with eight items merged from MSI-GLS-5,
`research/bn-native-msi-d2/`; the judged design is `work/bn-native-sound-DESIGN.md` in verifier.cash):

1. **The B walk is affine.** Every doubling and addition reads one 32-byte inverse-norm witness `t`, fixed by
   the exact equation `t·N(den) ≡ 1`. The lines are the affine lines `(1, −λ, λx − y)`, which are Fp2 multiples of
   SI-GLS's projective lines.
2. **The program runs as 3 roles, one per input.** Each role covers a range of the 65 Miller events, cut at
   chunk boundaries (events [0,24), [24,48), [48,65)). The roles chain their state through byte-exact canonical
   handovers.

**Every value that the accept decision depends on is computed on-chain, is a baked VK constant, is hash-committed
before any challenge it meets, or is fixed by an exact field or integer equation.** No prover-supplied evaluation is
used anywhere.

## Results of the two-input build (fixture 0; `node build.mjs`; bench `tools/bench-one.mts`)

| | |
|---|---|
| **score** (scripts + tx overhead) | **27,624** = 27,475 (3 × 35 locking + 27,370 unlocking) + 149 |
| unlocking per input | 9,316 / 9,262 / 8,792 (fillers 96 / 41 / 67 zero bytes, prover-sized) |
| op cost, standard | 7,050,949 / 7,010,150 / 6,656,840 = 20.72M (margins 5.81% / 5.81% / 5.80% of 7,485,600 / 7,442,400 / 7,066,400) |
| op cost, consensus | 7,016,645 / 6,975,846 / 6,623,944 (margins 6.26% / 6.27% / 6.26%) |
| code | 7,310 B: one blob, hosted as pieces of 3,767 B (input 0) and 3,543 B (input 1) |
| redeem `R` | 65 B, identical in all three inputs (locking `aa20 d9ba…a11a 87`) |
| worst-case op per input (cap rule) | 7.07M standard (every nibble 15, bench `worstCaseProof`), 11.95% below the 10,000-byte cap budget 8,032,800 |
| tx | ≈ 27.6 kB (standard ≤ 100,000); every locking 35 B, every unlocking ≤ 10,000 B |

These op costs were recorded with libauth 3.1.0-next.8 patched to charge an `OP_DEFINE`d body as pushed bytes, as BCHN
does (`patches/@bitauth__libauth@3.1.0-next.8.patch`, bitauth/libauth#166). This checkout's `node_modules` is stock, so
a fresh run prints stock libauth's figures, which are lower by the defined bodies' bytes; the filler sizing adds them
back (see above). The shipped vectors were sized before that patch (fillers 96 / 41 / 67 for a 6.00% standard margin),
so they measure about 5.8% standard and 6.26% consensus with the charge.
The score and vectors are unchanged and every input is still accepted in both modes. A fresh `node build.mjs`
re-sizes the fillers to 115 / 60 / 84 (score 27,680); `build.json` records that fresh sizing. The sweep figures under
Verification predate the patch; the bench worst-case vector measures 7,072,572 / 7,028,528 / 6,807,899 standard
(7,037,244 / 6,993,200 / 6,773,979 consensus), still within the cap rule.

For comparison (bench, same VK): crown8-rawchain 77,193 B (8 inputs, unreviewed), intratx-residue 86,950 B
(11 inputs, unreviewed). The design estimate was ≈ 28.0 kB (27–29 kB).

Gates: valid accepted; 24/24 invalid vectors rejected; 4/4 proofs runtime-general; cross-stage staple: 2/2 seams
bound; public inputs bound (9/9 mutated claims rejected); layout gate: 3 pads, none malleable; worst-case proof
(the forced op-cost worst case: every GT-GLS nibble 15, n_q 132) accepted; BCH-compatible (consensus) and standard; P2SH32 packaging; maintainer red-team file: all runs rejected (see
Verification).

Op cost profile (fixture 0, standard, `node profile.mjs`):
- **Input 0** (input 1 is the same within 1%), 7.04M in total:
  - event loop 6.15M:
    - affine doublings 2.58M (24 × 108k);
    - δ steps 1.57M (32 × 49k);
    - affine additions 0.80M (8 × 100k);
    - loop body 0.62M (GT-GLS, digits, flags);
    - chunk boundaries 0.33M;
  - setup 0.47M (powers of z, the four GT-GLS tables, loop environment);
  - redeem and code loading 0.11M;
  - remote reads 0.09M;
  - statement decoding and checks 0.09M.
- **Input 2**, 6.64M in total:
  - event loop 4.27M;
  - quotient 0.75M (114 words);
  - terminal 0.53M;
  - setup 0.47M;
  - binding 0.32M.

## Protocol

Notation: as in SI-GLS:
- Fp12 = Fp[X]/M(X), M = X¹² − 18X⁶ + 82;
- Φ, η and γ1 as there;
- λ = 6x+2+p−p²+p³ = m·r;
- d_0..d_64 is the NAF of 6x+2 (65 events, 21 additions);
- chunks of 2 events (the last has 1), with states S_1..S_33 after events 2, 4, …, 64, 65;
- N(a0 + a1u) = a0² + a1² is the Fp2 norm. Because p ≡ 3 (mod 4), N(a) = 0 ⟺ a = 0.

### Roles

| role = input | events | chunks | states | B steps (`t` witnesses) | δ slopes |
|---|---|---|---|---|---|
| 0 | [0, 24) | 0–11 | S_1..S_12 | 32 | 32 |
| 1 | [24, 48) | 12–23 | S_13..S_24 | 32 | 32 |
| 2 | [48, 65) + terminal + binding + quotient | 24–32 | S_25..S_33 | 22 + 2 terminal | 22 + 2 Frobenius |

### Witness items (all words 32-byte little-endian, decoded unsigned: `BIN2NUM(w ‖ 0x00)`, except the δ slopes, see `DS_i`)

- `STMT` (739 B; the two-input build's was 642 B, SI-GLS `WS[0, 642)`):
  - `x_A, y_A, x_B.c0, x_B.c1, y_B.c0, y_B.c1, x_C, y_C, n0` (offset 256), `n1` (offset 288), `n2` (offset 320);
  - the GT-GLS nibble strings `N_0, N_1, N_2` (65 B each, at offsets 352, 417 and 482);
  - the residue root `s^c` (6 words, at offset 547).
- `S_i`, role i's stream (3,328 / 3,328 / 2,496 B). It is one record per chunk: the inverse norm `t` of each B step of
  the chunk's events, then the chunk's state (6 words). Role 2 then appends `t_ψ` and `t_{−ψ²}`.
  - Doubling at T = (x, y): `t = 1/(2N(y))`.
  - Addition of Q: `t = 1/N(x − x_Q)`.
- `DG` (96 B) = `d0 ‖ d1 ‖ d2`, where `d0 = SHA256(S_0)`, `d1 = SHA256(S_1)`, `d2 = SHA256(STMT ‖ S_2)`. Each `d_i` covers
  the committed items hosted in input i.
- `HAND_i` (i = 1, 2; 224 B): the 7 words `x_T.c0, x_T.c1, y_T.c0, y_T.c1, F+, F−, R` after event `cut_i − 1`, in
  canonical residues.
- `WQ`: the odd quotient coefficients, highest first (`32·n_q` B, 1 ≤ n_q ≤ `NQ_MAX` = 168, leading word ≠ 0). This is
  SI-GLS's rule with this build's `NQ_MAX` (132 in the two-input build). Input 2 has room for at most 150 words.
- `FILL_i`: 0 ≤ L_i zero bytes. It buys op budget. No computation reads it, except that `FILL_2` is inside the z-tail
  hash. Its content is pinned (all zero), its length only by `≤ 10,000` (and the raw-size pin uses the actual length).
  So a third party can grow `FILL_0` or `FILL_1` (zero bytes, within the cap) and the transaction still verifies with
  a different txid (no soundness impact; see Open risks, owner decisions). `FILL_2`'s length changes `z`, so it cannot
  be changed without recomputing the handovers and `WQ`.
- `DS_i` (2,048 / 2,048 / 1,536 B): role i's slice of the 88 baked δ slopes. It is a VK constant, authenticated by
  `SHA256(DS_i) == K_DS[i]`. Its words are read with a signed `BIN2NUM`, with no `0x00` appended. That reads the same
  values: the hash pins every word, and all 176 are below p with the top bit clear.
- `C_0, C_1`: the two pieces of the code blob.

### Unlocking layouts (every push minimal, R last)

```
input 0: [S_0 3,328] [DS_0 2,048] [C_0 4,200]                                  [FILL_0] [R]
input 1: [S_1 3,328] [HAND_1 224] [DS_1 2,048] [C_1 3,975]                     [FILL_1] [R]
input 2: [DG 96] [STMT 739] [S_2 2,496] [HAND_2 224] [DS_2 1,536]       [FILL_2] [WQ] [R]
```

Inputs 0, 1 and 2 here are the verifier's three, the last three of the transaction. The code pieces are those of the
pools' build of Tornado's key (3,767 and 3,543 B in the two-input build). Every range another input reads (`C_0`,
`C_1`, `HAND_1`, `DG`, `STMT`, `HAND_2`) lies before every variable-length push. The z-tail `ZT` is the raw bytes of
input 2 from offset 5,104 (the `FILL_2` push header; 5,007 in the two-input build) up to the start of the redeem push,
i.e. `push(FILL_2) ‖ push(WQ)`.

### Transcript

- `h0 = SHA256(TAG ‖ DG)`;
- `ρ_raw = SHA256(h0 ‖ "rho")`;
- `z_raw = SHA256(h0 ‖ ρ_raw ‖ ZT)`;
- `ρ, z = BIN2NUM(· ‖ 0x00) mod p`, and `z ≠ 0` is required.

`TAG = "BNMX3/1" ‖ VK digest`, where the VK digest is the SHA256 of the 32-byte LE coordinates of α, β, γ, δ and IC0..IC3 (IC0..IC2 in the two-input build).

### The redeem R (80 B, the same in every input; 65 B in the two-input build, which read inputs 0 and 1)

```
OP_TXINPUTCOUNT <1> OP_NUMEQUAL OP_IF <1440> OP_CHECKSEQUENCEVERIFY OP_0NOTEQUAL OP_ELSE
OP_TXINPUTCOUNT <3> OP_SUB OP_INPUTBYTECODE <5385> OP_SPLIT OP_NIP <4200> OP_SPLIT OP_DROP
OP_TXINPUTCOUNT <2> OP_SUB OP_INPUTBYTECODE <5611> OP_SPLIT OP_NIP <3975> OP_SPLIT OP_DROP OP_CAT
OP_DUP OP_SHA256 <K_code> OP_EQUALVERIFY <1> OP_DEFINE <1> OP_INVOKE OP_ENDIF
```

**The sweep branch.** A coin that is its transaction's only input takes the first branch: its unlocking is the redeem
alone, `OP_CHECKSEQUENCEVERIFY` requires the input's relative lock to be at least 1,440 blocks (`SWEEP_AGE`, a version 2
transaction), and `OP_0NOTEQUAL` turns the 1,440 it leaves into the 1 that is the one stack item, as the code
leaves. Nothing else is required, so anyone can take the value of
a coin nobody has used for that long. Any other input count takes the second branch, which is the verifier, so a coin
the verifier composition spends has always run the code. The three unused instructions cost 300 of op cost there.

Function 1, the code blob:
- defines the shared functions (ids 2–21) and the three role programs (ids 22–24);
- then sets role = `OP_INPUTINDEX − (OP_TXINPUTCOUNT − 3)`, requires it in [0, 3), and runs `<22> OP_ADD OP_INVOKE`.

So each of the last three inputs runs only its own role, and an earlier input with this locking is refused.
Dispatching by function id instead of IF/ELSE matters on bch-2026: every instruction of an unexecuted branch still
costs 100.

### Role programs

**Common steps (every role).**
1. **Own layout.**
   - `DEPTH` equals the item count, and every fixed item has its exact size.
   - `FILL_i` is all zero: it is compared with `NUM2BIN(0, SIZE)`, never with a BIN2NUM test (a run with 0x80
     bytes is in the red team), and `SIZE ≤ 10,000`.
   - The own raw unlocking size `SIZE(OP_INPUTBYTECODE(OP_INPUTINDEX))` equals the fixed part plus the minimal push
     lengths of the variable pushes.
   - Role 2 only, on `WQ`: `SIZE ≡ 0 (mod 32)`, `32 ≤ SIZE ≤ 5,376` (32·`NQ_MAX`), and the leading word is nonzero
     (unsigned).
   - Role i: `DS_i` has its size and `SHA256(DS_i) == K_DS[i]`.
2. **Graph.** The last three inputs of the transaction, whatever its input count, spend this input's locking bytecode:
   `OP_UTXOBYTECODE(count − 3 + j) == OP_UTXOBYTECODE(OP_INPUTINDEX)` for j = 0, 1, 2. This coin is recreated by the
   matching one of the last three outputs, with the same locking, the same value and no token. No other input is
   read. The two-input build required `OP_TXINPUTCOUNT == 3` instead.
3. **Remote reads.**
   - Role 0 reads `HAND_1` from role 1's input, and `DG`, `STMT` and `ZT` from role 2's.
   - Role 1 reads `DG`, `STMT`, `HAND_2` and `ZT` from role 2's input.
   - Role 2 reads only its own bytecode (for `ZT`).
   - Before every remote range, the push header bytes in front of it are checked against their expected
     encoding.
4. **Transcript.**
   - Role i computes `d_i` from its own stack items and requires `DG[32i, 32i+32) == d_i`.
   - It then derives `h0`, `ρ` and `z` itself (`z ≠ 0`). No challenge is ever handed over.
5. **Statement (every role).** Every coordinate word and `s^c` word is decoded unsigned and checked `< p`;
   `n_k < r`; every nibble is ≤ 0x0f (a 195-byte mask over `N_0, N_1, N_2`; 130 bytes in the two-input build).
   - Role 0 also checks `y_A² = x_A³ + 3`, `y_C² = x_C³ + 3`, and `y_B² = x_B³ + b'` (twist).
6. **Setup** (a shared function), as in SI-GLS:
   - z², …, z⁶ and (ηz)¹, …, (ηz)⁵;
   - `S_c(±z)`;
   - the GT-GLS tables `TP_k/TM_k` (16 entries each);
   - the loop environment (`y_P = −y_A`, `x_A·z`, `x_C·z`, …).
7. **Start state.**
   - Role 0: `T = B`, `F± = S_c(∓z)`, `R = 0`.
   - Roles 1, 2: `(T, F±, R)` from the own `HAND_i`, each word decoded `< p`.
   - Every role: the baked δ recursion state `(x_j, c_{j−1}, λ_{j−1})` at `j = J_AT[cut_i]`.
8. **Event loop** (a shared function), driven by the role's baked schedule. Per event it uses a digit string `SCH`
   and an explicit boundary flag string `BND`; both are asserted at load time against the single-input schedule.
   Each event:
   1. **Doubling.** Read `t` (`< p`). Set `λ = 3x²·conj(y)·t` and **require `t·2N(y) ≡ 1`**. Then
      `T ← (λ² − 2x, c − λx')` with `c = λx − y`. The line is `(1, −λ, c)`, and `F± ← F±²·(y_P ± o)` with
      `o = z³Φ(c)(z) − x_A z Φ(λ)(z)`.
   2. **δ step.** The baked slope comes from the δ pile; this is the reviewed SI-GLS kernel, verbatim.
   3. **Addition, if `d_e ≠ 0`.** `Q = d_e·B`.
      - Read `t`. Set `λ = (y − y_Q)·conj(x − x_Q)·t` and **require `t·N(x − x_Q) ≡ 1`**.
      - `T ← (λ² − x − x_Q, c − λx')`, with the line as above.
      - `F± ·= L(±z)·S_c(∓z)` (or `S_c(±z)` for `d_e = −1`).
      - A δ step.
   4. **GT-GLS.** `F± ·= TP/TM_0[N_0[e]]·TP/TM_1[N_1[e]]`.
   5. **At a boundary.** Read the state `S'` (6 words, `< p`; the record must then be empty). Then
      `R ← Rρ + F+·S'(−z) − F−·S'(z)` and `F± ← S'(±z)`, and take the next record.
9. **Clean stack**, leaving exactly `TRUE`.

**Roles 0 and 1, after the loop.**
- Require that every δ slope and every stream byte has been consumed.
- Encode `(x_T, y_T, F+, F−, R)` canonically, as `w = (v + p) mod p` with the top byte of `NUM2BIN(w, 33)` required to
  be 0x00, then its 32-byte LE.
- Require byte equality with `HAND_{i+1}`, read from input i+1.

**Role 2, after the loop.**
1. `T += ψ(B)` and `T += −ψ²(B) = (ω·x_B, y_B)`, each with its witnessed `t`, its line and the exact equation. Then
   the two δ Frobenius lines.
2. Require that every δ slope and witness byte has been consumed.
3. **Endpoint:** `T == −ψ³(B) = (ω·x_ψ, y_ψ)`, exactly (affine, every difference reduced and required to be 0).
4. `F± ·= Rconst(±z)·S_c(±ηz)`.
5. `c_j = Φ(γ1^j)(z)`, and `R ← Rρ + F+·W(−z) − F−·W(z)` with `W(x) = Frob(S_c)(x)·Frob(S_c)(ηx)`.
6. **Binding:** `acc_k = Σ_e 2^{64−e}·TB[N_k[e]]` over the integers, from the full nibble strings. Require
   `(acc_k − 2^64Σπ_i − n_k) mod r == 0`.
7. **Quotient:** Horner over `WQ`, 4 words per step, every word `< p`. Accept iff `(R − z·q(z²)·M(z)) mod p == 0`.

## Spec rules (the builder's checklist, design §4)

| rule | implementation |
|---|---|
| cuts at chunk boundaries; explicit per-range schedules | `CUTS = [0, 24, 48, 65]`, each asserted to be a chunk bound. Per-role `SCH` (digits) and `BND` (boundary flags) are baked and asserted against `DIGITS` and `isBoundary` (`protocol.mjs`, at load). The role-split value-level run equals one uninterrupted run (R, F±) on fixtures 0 and 4, and the 33 states equal the reviewed SI-GLS prover's states (`build.mjs`). |
| code identity | R hashes exactly the item it defines: `C_0 ‖ C_1`, at fixed ranges, `OP_DUP OP_SHA256 <K_code> OP_EQUALVERIFY <1> OP_DEFINE`, and nothing is re-pushed in between. Function ids are asserted distinct (`build.mjs`). Nested `OP_DEFINE` inside function 1 runs on libauth `BCH_2026` (3.1.0-next.8). |
| framing | Every role pins its own layout (`DEPTH`, every size, raw unlocking size) and checks the push header at every remote offset. `ZT` runs from a fixed offset to `len − |push(R)|`. Minimal pushes and push-only unlockings are consensus rules. |
| decoding | Every word is decoded unsigned (`BIN2NUM(w ‖ 0x00)`) and required `< p`; `n_k < r` and the nibble mask hold in every role (local decoding). `t < p`. The handover is canonical and compared byte-exactly. |
| filler | All zero (byte-exact), ≤ 10,000, and read by nothing except the `ZT` hash (`FILL_2`). The lengths of `FILL_0` and `FILL_1` are not committed (txid malleability only; owner decision). |
| challenges | `z ≠ 0`; every input derives ρ and z itself. |
| graph | The last three inputs, whatever the input count, spend `P2SH32(R)`, and each is recreated in place by the matching one of the last three outputs (same locking, same value, no token). The other inputs and outputs are the pool's to rule: the pool pays its recipient. R's sweep branch runs only for a coin that is its transaction's only input. (The two-input build required `TXINPUTCOUNT == 3` and left outputs unconstrained.) |
| margins | Fillers are prover-sized to a ≥ 6% standard-mode margin per input under BCHN accounting: libauth's op cost plus the defined bodies' bytes (a design buffer, not a validity condition). Where the 10,000-byte cap comes first, the margin is what the cap leaves. The two-input build's shipped fixture 0 was sized before the OP_DEFINE charge and measures 5.81/5.81/5.80% standard, 6.26/6.27/6.26% consensus with it. Cap rule: the forced worst case per input is ≤ 0.94 × 8,032,800 (see Liveness). |
| reduced values before guards | Every equality or ≠0 guard tests a value reduced mod p (or mod r): the inverse-norm equations, curve checks, endpoint, binding, final identity. `z` is tested in [0, p). |
| nonzero line factors | The X^0 coefficient of every B line polynomial is `y_P = −y_A`, and of every δ line `y_C`. Both are ≠ 0: A and C are on `y² = x³ + 3`, which has no 2-torsion point (G1 has odd prime order), so no curve point has y = 0. Each line factor is therefore a nonzero polynomial of degree < 12, hence nonzero mod M. Every other factor is monic. |

## Soundness argument (constructive: an owner for every value)

**Claim.** Suppose a transaction spending outputs locked `P2SH32(R)` is valid. Then `(A, B, C, n0, n1, n2)` in `STMT`
satisfies Groth16 for the baked VK, except with probability `≤ q_H·2^−244.8` plus a SHA256 collision term (`n0, n1` and
`2^−245` in the two-input build).

1. **Pinning, without a hash cycle.**
   - A spent output forces `R`. `R` runs only a code blob with digest `K_code`.
   - That code requires the last three inputs to spend the same locking. So each of them runs the same authenticated
     code, and its role is its position among the three. (The two-input build required exactly 3 inputs.)
   - The transaction is valid iff all three role programs accept. This pins the order and every sibling's locking and
     code. Inputs before the three are the application's; the verifier checks none of them. R's sweep branch needs
     the coin to be its transaction's only input, so it never runs among the three.
   - `R` contains `K_code`, and the code contains no digest of `R` (sibling identity is checked by locking equality).
2. **One transcript.**
   - Every role reads `DG`, `STMT` and `ZT` from the same consensus bytes, at offsets made exact by:
     - the owner's own layout pin;
     - the header checks in every reader;
     - push-only, minimal-push unlockings.
   - Each `d_i` is checked by the owner of its preimage. So `h0` determines `(S_0, S_1, STMT, S_2)` up to a SHA256
     collision; all of these are fixed width.
   - `ρ` depends only on `h0`. `WQ` (length-ruled, with a canonical leading word) enters only `z`, after ρ. So every
     polynomial `D_k` is fixed before ρ, and `Q` before z, as in SI-GLS.
   - Each role derives the same `(h0, ρ, z)`.
3. **Value owners.**

| value | owner |
|---|---|
| code, field constants (`R_{k,i}`, `Rconst`, `γ1`, `η`, `b'`, `p`, `r`, `TAG`), δ start states, schedules | VK constants in the code: `P2SH32(R) → R ∋ K_code`. Each one is regenerated from the VK and asserted against noble when `../sound-si-gls/math.mjs` loads. |
| δ slopes `DS_i` | VK constants, `SHA256(DS_i) == K_DS[i]` (in the code) |
| A, B, C, n0, n1, n2, N_k, s^c | hash-committed (`d2`, then `h0`) before ρ. Canonical decoding in every role; curve, twist and nibble checks in role 0 (the nibble mask in every role). |
| the 33 states | hash-committed (`d_i`) before ρ; `< p` when read |
| `WQ` | hash-committed through `ZT` before z; `< p`; length rule and nonzero leading word |
| inverse norms `t` | the exact equation `t·N(den) ≡ 1` with `t < p`. The solution is unique and forces `den ≠ 0` (anisotropic norm). They are also committed (harmless). |
| the B trajectory, λ, lines, ±z evaluations, tables, F±, R, acc_k | computed on-chain |
| `HAND_i` | byte equality with the canonical encoding of the values that role i−1 computed (top byte checked: never a negative value), and decoded `< p` by role i |
| `FILL_i` | outside every computation; all zero; only in `ZT` (each `FILL_2` length is one more z query, counted in `q_H`); `FILL_0`/`FILL_1` lengths are free (txid only) |

4. **Handover induction.**
   - Role i's computation is deterministic from the constants, the committed data, the challenges and `HAND_i`.
   - Role i requires `HAND_{i+1}` to equal its own results.
   - So role i+1 starts from exactly the single-run state after event `cut_{i+1} − 1`, in canonical residues.
   - Splicing in an input from a second proof changes some `d_i` or a handover and fails. The bench staple gate and
     the red team test every seam.
5. **The B walk.**
   - Every accepted step is the exact affine group law. A doubling requires `N(y) ≠ 0`, i.e. `y ≠ 0`. An addition
     requires `x ≠ x_Q`. Then `λ = num/den` exactly.
   - An exceptional step (doubling a 2-torsion point, adding ±T) cannot satisfy its equation. This replaces
     SI-GLS's "Z = 0 is absorbing" argument.
   - The endpoint `T == −ψ³(B)` gives `λ(ψ)(B) = O`. With `gcd(N(λ(ψ)), 2p − r) = 1` (asserted in SI-GLS
     `math.mjs`), `B ∈ G2`.
   - Honest completeness: no step of the fixed NAF schedule (65 doublings, 21 additions, 2 terminal additions) is
     exceptional for `B ∈ G2` (`research/sound-bn254-native/prototypes/facts.mjs`).
6. **Reduction to SI-GLS.**
   - Each affine B line is SI-GLS's projective line divided by an Fp2 scalar. Fp2 ⊂ Fp6, so it is in the same class
     in G = Fp12*/Fp6*.
   - The line slots `(y_P·Φ(ℓ0) + x_P X Φ(ℓ1) + X³Φ(ℓ3))` have the same degrees (≤ 9). So the per-event degrees are
     SI-GLS's. The third runtime input adds a third table factor per event, so `NQ_MAX` is 168 and the degree bound
     347 (132 and 275 in the two-input build).
   - The states are the same classes; `build.mjs` asserts that they equal SI-GLS's on fixtures 0 and 4.
   - Each `D_k` uses the on-chain line polynomials and is chained into `R` in the same Horner order with the same ρ
     weights, so the conjunction of the 3 roles is SI-GLS's batched check, term for term.
   - The rest follows verbatim:
     - `D ≡ 0 mod M` gives `[P_k] = [S_{k+1}]`;
     - `[f'] = [c]^λ` gives `FE(f') = 1`;
     - the mod-r binding of the hashed, range-checked nibbles gives the Groth16 product `e(vk_x, γ)`.
   - Every line factor is nonzero mod M: its constant coefficient is `y_P = −y_A` (B lines) or `y_C` (δ lines),
     nonzero because the curve checks put A and C on `y² = x³ + 3`, which has no point with y = 0; with degree < 12
     the factor is nonzero mod M. (The affine `ℓ0 = 1` alone does not imply this.)

**Soundness error** per random-oracle query: `ε ≤ 1.134·(34 + 347)/p ≈ 2^−244.8` for this build (degree ≤ 347;
`1.134·(33 + 275)/p ≈ 2^−245.15` in the two-input build, as in SI-GLS), plus a SHA256 collision term for the extra
digest layer. `z`'s preimage contains `push(FILL_2)`, whose length the prover chooses, so each filler length (up to
≈ 10,000 per fixed `(h0, WQ)`) is a separate z query and is counted in `q_H`. Fixing `WQ` at one length with no
filler (the owner-decision alternative) removes this degree of freedom.

### Code-as-witness checklist (design merge item 7)

- The item that is hashed is the item that is defined. R concatenates the two fixed ranges, then does
  `OP_DUP OP_SHA256 … OP_EQUALVERIFY <1> OP_DEFINE`.
- The pieces sit before every variable-length push of their host. The hosts' own layout pins and R's fixed ranges
  coincide. A flipped code byte in either piece is rejected in every input (red team).
- Function ids: 2–21 for the shared functions, 22–24 for the role programs, 1 for the body. They are asserted
  distinct, and no id is redefined (`OP_DEFINE` of an existing id fails in the VM).
- Dispatch: role = `OP_INPUTINDEX − (OP_TXINPUTCOUNT − 3)`, required in [0, 3), then `+ 22`. An input before the last
  three has no role and is refused.

## Liveness

- **The fixture is sized with margin.** The honest prover sizes each filler so that the input's standard-mode op cost,
  with the defined bodies' bytes added as BCHN counts them, is at most 94% of its budget (`transaction.mjs`,
  `sizeFills`). The unlocking is capped at 10,000 B.
- **The three-input build at the cap** (bch-next, Tornado's key, 2026-11-13; stock libauth plus the body charge). Over
  300 random statements of at most 141 quotient words, input 0 at 10,000 B keeps at least 5.88% of its budget, input
  1 at least 6.45% and input 2 at least 7.27%. About 1 statement in 25 reaches the cap on input 0 before 6%, and keeps
  what the cap leaves. Input 2 holds at most 150 quotient words.
- **Cap rule.** Each input's op cost is almost statement-independent (fixed schedule, table-based GT-GLS); only role
  2's quotient length varies (n_q 60–132). So the binding condition is the cap: at 10,000 B the budget is
  8,032,800. The build passes only if every input of every swept case stays ≤ 0.94 × 8,032,800 = 7,550,832 in both
  modes.
- **Sweep** (`sweep.mjs`, both modes, every case accepted and the cap rule met): see `sweep.json` and Verification.
  - The fixtures.
  - Special inputs.
  - The forced GT-GLS witnesses:
    - every nibble 15 (n_q 132);
    - every nibble 0 (n_q 60);
    - every nibble 1;
    - the review's worst case (nibble 4, and 0 at the addition-first events 20, 26, 34, 50, 54).
  - The 8 lowest-n_q statements of a 20k search.
  - A lattice-shifted valid witness.
  - 400 random proofs.

## Deviations from the design text (and why)

- **No constants blob, and no `K_consts`.** The field constants are inline pushes in the code. The code is split
  into two pieces, hosted in inputs 0 and 1, and concatenated by R (+8 B of R). This removes the remote constants
  reads and their parsing (about 80k op per role), and the bytes are the same.
- **`DG` and `STMT` live in input 2, and `d2 = SHA256(STMT ‖ S_2)`.** Each `d_i` still covers exactly what input i
  hosts. Role 2 needs no remote read; role 1 needs one; role 0 needs two.
- **`DS_i` is hosted in input i itself.** It is an own item, hash-checked, with no remote read.
- **Dispatch by function id, and the loop's add-step and boundary bodies as functions.** On bch-2026 an unexecuted
  branch costs 100 per skipped instruction. Together these cut about 0.9M op.
- **The binding is computed once in role 2,** from the full nibble strings, instead of being accumulated in the loop
  and handed over.

## Compiler and tooling

- `asm.mjs`: the SI-GLS symbolic assembler, copied and extended. The kernels are a DAG local-search scheduler on the
  exact op model. The changes against the reviewed copy:
  1. Bound functions are matched on a window: the top items, down to the deepest item that the body touches. This
     lets the three roles, which keep different items lower on the stack, share one loop.
  2. Function ids above 16 are allowed.
  3. Kernels can read items below a pile of known size.
  4. `roll` splices by symbolic index (fixed: physical depth ≠ index below a pile).
  5. `arrange` no longer keeps a prefix that is not adjacent (fixed).
  6. An optional lazy-reduction pass. It is off: the static cost model is not accurate enough for it.
- `kernels.mjs`: the affine inverse-norm kernels (`kADblN`, `kAAddN`), plus `kDStep`, `kEval` and `kTable` verbatim
  from SI-GLS.
- `protocol.mjs`: roles, schedules, δ slices and start states (asserted), the transcript, the affine prover (exact
  divisibility of every identity is asserted), and a value-level mirror (handovers, final identity).
- `script.mjs`: the shared functions, the three role programs, the body, R and the layout.
- `transaction.mjs`: unlockings and prover-sized fillers. `vm.mjs`: the bch-2026 runners for the 3-input tx.
- `build.mjs`: a deterministic double build plus every assert listed above, and a smoke spend.
  `export.mjs`: the bench vectors. `redteam.mjs`: the rejection suite, locating the guard that fires. `sweep.mjs`:
  liveness. `profile.mjs`: op cost by section and function.

## Reproduce

```sh
# in this directory, with the repository's dependencies (@noble/curves 2.2.0, @bitauth/libauth 3.1.0-next.8)
node build.mjs                                             # code 7,310 B sha256 75c780ae…78d7; R 65 B; writes build.json
node export.mjs vectors.json                               # bench vectors (fixtures 0-3, worst case = every nibble 15, 24 invalid runs)
node redteam.mjs vectors.json redteam.json redteam-report.json   # every run rejected; bench red-team file
SWEEP_N=400 node sweep.mjs sweep.json                      # liveness, both modes, cap rule (SWEEP_SHARD=k/n to split)
node profile.mjs                                           # op cost by section / function (FIX=, MODE=)
```

`export.mjs` and `sweep.mjs` mint proofs through `../sound-si-gls/mint.mjs`, which reads the pairing-vector trapdoor
from a zk-verifier-bench checkout: by default the sibling `../../../../zk-verifier-bench` (relative to this directory's
parent), otherwise set `VERIFIER_DIR=<path to zk-verifier-bench>`. Without it they fail with ENOENT on
`src/checkpoints/pairing-vectors.json`.

The figures in the comments above are the two-input build's, which the committed `build.json` holds. For this branch,
run these with `test-key.mjs`'s three-input key, as that file says; do not commit the `build.json` they write. The
pools' build of Tornado's key is checked by bch-next's `npm run verifier:check`.

In zk-verifier-bench:
- copy `vectors.json` to `src/bch/groth16-bn254-sound-native-vectors.json`;
- copy `redteam.json` to `src/bch/redteam/bch-groth16-bn254-sound-native.json`;
- then run `npx tsx tools/bench-one.mts bch-groth16-bn254-sound-native`, the exact-id gate driver.

## Verification

- **Red team** (`redteam.mjs`, rejection tests only). Every run is rejected in consensus and standard mode, and
  `redteam-report.json` names the input and the guard that fires.
  - **How the runs are built.** Committed items are tampered *with `DG`, the challenges and the handovers
    recomputed*, so that the specific guard has to reject, not just a hash check.
  - **What they cover:**
    - public-input claims with an otherwise honest witness (rejected at the binding);
    - `n + r` and top-bit encodings;
    - off-curve, off-twist, identity and negated points, and `+p` aliases;
    - nibble range, negative zero and bit flips;
    - lattice-shifted digits with stale identities;
    - residue-root tampering;
    - states, their aliases and swaps;
    - inverse norms (`t + p`, `t = 0`, a wrong `t`; doubling, addition and both terminal additions);
    - quotient words, aliases, length, the 133-word cap, a leading zero and another proof's quotient;
    - handover words (+1, +p alias, bit flip, shifted, another proof's);
    - whole-input staples from a second valid proof;
    - layout (extra, missing or swapped pushes; a nonzero or 0x80 filler; an oversize unlocking; redeem, code and
      δ-slice bytes; non-minimal pushes that shift remote offsets; a non-push opcode; swapped inputs);
    - B on the twist but outside G2, with its inverse norms, `DG`, the challenges and the handovers recomputed
      (inputs 0 and 1 accept; the run asserts that role 2's endpoint guard `T == −ψ³(B)` is what rejects);
    - graph (2 or 4 inputs, a foreign P2SH32 input; run locally only), including a foreign P2SH32 input at each index
      j that carries input j's honest pushes: the run asserts that the sibling-locking check `UTXOBYTECODE(j) == own`
      (GRAPH instruction 8 / 12 / 16) fires in both siblings, and the input-count check for a 4th input;
    - the sweep: R alone as input 0 or input 2 of a composed run, and, as transactions of their own, a lone coin
      1,439 blocks old, in a version 1 transaction, with its relative lock disabled or measured in time, and two coins
      swept together. A lone coin 1,440 blocks old is the one shape the sweep branch accepts.
  - **Positive controls:** fixture 0, and a valid lattice-shifted GT-GLS witness.
  - **Three-input build, test key** (`test-key.mjs`): 163 runs, none accepted; the 3 token cases refused; the
    5 sweep shapes refused and the lone coin 1,440 blocks old swept.
- **Liveness** (`sweep.json`, 424 cases, 4 shards):
  - every case is accepted in both modes; n_q ranges over 60–132;
  - the minimum per-input margin with prover-sized fillers is 6.00 / 6.00 / 6.00% standard and 6.45 / 6.46 / 6.46%
    consensus;
  - the cap rule holds everywhere. The worst op per input is 7,058,054 / 7,014,010 / 6,793,381 standard, all at
    "every nibble 15". That leaves 12.13 / 12.68 / 15.43% below the 10,000-byte cap budget (the rule needs ≥ 6%).
- **Determinism:** `build.mjs` builds twice and compares the bytes. Code sha256 `75c780ae…78d7`, vectors sha256
  `2fa0a45a…1014`, red-team file sha256 `86084f1a…3dcc`.
- **Bench gates:** see Results.

## Open risks

- **The three-input change is AI-audited, not human-reviewed.** The 2026-10-26 review covered the two-input build. An
  AI audit of this branch on 2026-11-13 found no soundness break (`service/verifier/AUDIT-2026-11-13.md` in bch-next).
  The affine kernels, the 3-input glue, and the assembler extensions are new code.
  Formula correctness is tested, not machine-proved:
  - exact divisibility of every honest identity in the prover;
  - noble cross-checks of all constants and of the δ recursion;
  - every swept proof accepted;
  - the red team.

  There is no formal equivalence proof of the generated bytecode.
- **Owner decisions** (as listed in the design):
  - **Prover-sized zero filler.** If it is rejected, fix `WQ` at 132 words. That is about +576 B at fixture 0;
    injectivity holds by the fixed width, and the degree argument holds with leading zeros. Note: the lengths of
    `FILL_0` and `FILL_1` are committed nowhere, so a third party can grow them (zero bytes, ≤ 10,000 B per input) and
    the transaction still verifies under a new txid. No soundness impact (and an unsigned spend with unconstrained
    outputs is re-creatable anyway); if txid stability matters to an application, bind the filler lengths (e.g.
    `|FILL_0|, |FILL_1|` in a committed item) or adopt the fixed-width alternative.
  - **Code read from the first two verifier inputs' unlocking bytes** and authenticated by `R ∋ K_code`. This pattern is new to
    the bench and needs the owner's OK to count as verifier code.
  - **Public inputs bind through the GT-GLS fold and the mod-r check,** as already accepted for SI-GLS.
- **Margins are thin by design.** The two-input build's shipped fixture is at 5.81% standard (6.26% consensus) with the
  OP_DEFINE charge, and its worst case at the 10,000-byte cap leaves 11.95%. The three-input build sizes to 6% with the
  charge, and its input 0 at the cap keeps at least 5.88% (Liveness). Any later change that adds op cost must re-run
  `sweep.mjs`.
- **Outputs.** The verifier requires only that each of its coins comes back in the matching one of the last three
  outputs. Every other output is the application's to rule: the pool pays the recipient its proof names, or anyone
  holding a valid proof could redirect the spend.
- **Inputs.** The verifier is the last three inputs of any transaction and checks no other input. So a verifier coin can
  be spent beside anything, not only beside a withdrawal, still with a valid proof of some statement, and every pool
  shares the same coins. An application must read the statement from role 2's `STMT` and judge it, as the pool does: a
  recent root of its own tree, an unspent nullifier, the recipient. Anyone can make a coin of this lock, and sweep one
  unmoved for 1,440 blocks as its transaction's only input. A third party can also add an input before the three, or
  an output before the recreated coins paid from the fee, without changing what a withdrawal does: the txid is not
  stable before confirmation.
- **Trust boundary of the GT-GLS factor constants.** The `R_{k,i}` (24 pushes) and `Rconst` (6 pushes) equal
  `math.mjs`'s values. The independent review confirmed that `math.mjs`'s `mIC` is noble's Miller value `m(IC_k, γ)`
  and that `R_{k,0}` lies in its class, but did not recompute them all from noble. Their end-to-end correctness is shown
  by the final identity on the 5 fixtures, the extra proofs and every swept proof, and by the binding rejections. A
  future review could recompute `Rconst` (the class of `m(α,β)·m(IC0,γ)·corr`) from noble.
