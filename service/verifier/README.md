# The Groth16 verifier

This directory builds a BCH-native Groth16 verifier for the BN254 verifying key of
tornado-core's public circuit and trusted setup, binding `root`, `nullifierHash`, and
`recipient` on chain.

## Result

| | |
| --- | --- |
| Code | 8,175 B (4,200 + 3,975), 80 B redeem |
| Inputs | 3 P2SH32 inputs, with unlockings of 9,975 / 9,927 / 9,743 B (29,645 B); 29,899 B by verifier.cash's score, which adds the three lockings and the transaction's overhead |
| Op cost | ~22.4M total as BCHN counts it; 7.53M / 7.49M / 7.36M against 8.01M / 7.97M / 7.83M budgets, 6.0% to spare in each |
| Modes | accepted in BCH consensus **and** standard relay |
| Proof | real production-key Tornado proof, generated with the release proving key |

The verifier is the reviewed `bch-groth16-bn254-sound-native` construction from
[verifier.cash](https://www.verifier.cash) / `mr-zwets/groth16_cashscript`, extended from
two to three runtime public inputs and composed with a pool on branch `pool-composed`, then
shared by every pool on branch `shared-verifier`. Tornado's circuit, trusted setup, verifying
key, and note format are unchanged. It is vendored in `packages/verifier`, whose README and
`SOURCE.json` say from which commit.

## Files

| File | Purpose |
| --- | --- |
| `extract-vk.ts` | Parses `alpha`, `beta`, `gamma`, `delta`, `IC[0..6]` from `tornado-core/contracts/Verifier.sol`; with no tornado-core checkout, `--check` holds the keys to their pinned hashes. |
| `tornado-bn254-folded.json` | Full key plus the 2-input folded variant (kept for reference). |
| `tornado-bn254-3in.json` | The 3-input key: `IC[0..3]`. |
| `build.ts` | Rebuilds the program and writes `verifier-artifact-3in.json`, or with `--check` compares it. |
| `run-real-proof.ts` | Accepts the real proof and checks its limits. Its tampered statements and proof fail the Groth16 equation or a point check before they reach the VM; `tamper.ts` and `forge.ts` show the script itself refusing such changes. |
| `tamper.ts` | One bit of every kind of witness, every composition rule and every shape of the sweep, on a real proof. |
| `forge.ts` | False statements, proofs and witnesses with every commitment rebuilt, on a real withdrawal: each refused at its guard, the last comparison included. |
| `forge-mode.patch` | Lets a temporary copy of the prover carry a false statement to the VM. Only `forge.ts` applies it. |
| `proofs/withdrawal-bch.json` | A real SDK-built withdrawal and the outputs it spends, for `forge.ts`. `record-withdrawal.ts` writes it. |
| `record-withdrawal.ts` | Makes a pool through its factory on the mock and records a withdrawal from it, with a real proof. |
| `AUDIT-2026-11-13.md` | The independent AI audit of this verifier's earlier template, `37c8b9ec…`. `contracts/AUDIT-2026-11-17.md` read what the template here changes from it. |
| `CHECKS-2026-11-14.md` | What that audit could not check, on the same template: BCHN, the bytecode against the math, the trusted setup. |
| `proofs/proof-recipient.json` | Real proof with `recipient = 0x1111…` (the 3-input test vector). |
| `proofs/proof-zero.json` | Real proof with all payout fields zero. |
| `make-fixture.ts` | Converts a websnark/Tornado proof JSON into the benchmark fixture shape. |

The artifact is the one program every pool uses. Its code names no pool, so every pool spends
coins of one lock: the P2SH32 of the 80 B redeem, which holds the code's sha256.
`contracts/Sidecars.scash` pins that lock in the pools' code; `scripts/sidecar-locks.ts` writes
it, and `npm run check` holds it to this artifact. `web/src/verifier.ts` derives the lock and
refuses an artifact whose `lockingHex` differs, and `scripts/verify-deployment.ts` prints it with
the number of coins at it.

## Reproducing

The generator is `packages/verifier`. It imports `@noble/curves` and `@noble/hashes` 2.2.0, and
this project's `@bitauth/libauth`:

```bash
npm run verifier:check                     # the artifact matches the source
npx tsx service/verifier/extract-vk.ts     # the key, from tornado-core's Verifier.sol (TORNADO_CORE, or beside)
npm run verifier:build                     # write the artifact
npx tsx service/verifier/run-real-proof.ts # a per-input table; fails on any limit or accepted tamper
npx tsx service/verifier/forge.ts          # forged withdrawals, each refused at its guard
npm run test:verifier-sizing               # the op costs as BCHN counts them, and as libauth does
```

The op costs above are BCHN's count. libauth 3.1.0-next.8, and the fork of it this project installs
(`mainnet-pat/libauth#1cf4b43`), charge nothing for a body that `OP_DEFINE` stores, and BCHN charges it as pushed
bytes: 16,239 B per input, the code and every function it defines. `definedBytes` in
`packages/verifier/bn-native-sound/transaction.mjs` gives that from this artifact; the earlier template, which the
2026-11-14 checks bracketed on BCHN, had 16,313 B. The prover measures which libauth it has and adds the bytes only
on one that does not charge them, so the fillers come out the same on both. `test:verifier-sizing` sizes and spends
the production proof on this project's libauth and on a temporary copy patched to charge the bodies, the change
groth16_cashscript's pnpm install makes: the unlockings are the same bytes, and the copy reports BCHN's count.
`run-real-proof.ts`, `tamper.ts` and `forge.ts` run on this project's libauth, so the op costs they see are 16,239
lower per input; `run-real-proof.ts` says which count it prints.

## What the build asserts

While loading the generator, every VK-derived constant is recomputed and checked against
`@noble/curves`: G2 subgroup membership, the 88 δ slopes, the GLS factor tables, and the
Frobenius lines. Checked on Tornado's key: all three G2 points are torsion-free, all IC
points satisfy the G1 equation, and the δ chain matches.

## Limits

- The proof binds `recipient`, so a mempool observer cannot redirect the payout.
- A person reviewed the 2-input original. The 3-input change and the composition with a pool
  were audited on 2026-11-13 by an independent AI auditor, a Claude agent on the Fable model.
  It found no soundness break: `AUDIT-2026-11-13.md`. Its findings were Low and
  Informational, and each is fixed or written down. It read the template of then: 8,212 B of
  code, sha256 `37c8b9ec…`, holding a 37-byte brand that tied a verifier to one pool, and a 69 B
  redeem. The template here is 8,175 B, sha256 `7b513096…`, with no brand and an 80 B redeem
  that adds the lone-input sweep. A second AI audit, also on the Fable model, read it on
  2026-11-17 against that one (`contracts/AUDIT-2026-11-17.md`): the brand's removal, the sweep
  and the lengths that follow are its only changes, the sweep needs its coin to be the only
  input, and no root, nullifier hash or payee can be aliased. It did not re-derive the pairing
  arithmetic, which is byte for byte the earlier template's. No person has audited either, and
  a human audit is still advised before mainnet funds.
- What the 2026-11-13 audit could not check was checked on 2026-11-14 (`CHECKS-2026-11-14.md`),
  on the same earlier template:
  - BCHN v29 gives libauth's verdict on all 179 transactions tried, and counts the op cost
    the prover assumes;
  - every guard and function in the bytecode matches the spec's formulas;
  - the key is the output of Tornado's ceremony, whose 1,114 contributions all verify.
  
  That the ceremony's phase-1 file came from Perpetual Powers of Tau, as Tornado's team said,
  can no longer be checked.
- Anyone who relays a withdrawal can change its txid without changing what it does: a filler
  of another length, or a re-randomised proof. So nothing may key on a withdrawal's txid.
- Input 0 can reach the 10,000-byte cap before its 6% margin, for about 1 statement in 25,
  and then keeps at least 5.88% of its budget as BCHN counts it. That was measured on the
  earlier template, on 2026-11-13, and not yet on this one.

## Composition with a pool

The verifier runs as the last three inputs of a transaction, beside a pool's master at input 0,
and recreates its coins in the last three outputs. Its code names no pool, so `build.ts` writes
the one program every pool uses, and the pools pin its lock (`contracts/Sidecars.scash`). Its
redeem's sweep branch lets anyone take a coin unmoved for 1,440 blocks, but only as its
transaction's only input. `tamper.ts` runs a real proof through every kind of witness change and every
composition rule. `forge.ts` rebuilds every commitment around a false statement, proof or
witness, so that each case reaches the guard it tests, the last comparison included. See
PRODUCTION.md for what that does not cover.

The verifier's own red-team suite needs a test key with a known trapdoor, and stays upstream:
`test-key.mjs`, in `chunked/bn254/bn-native-sound` of `groth16_cashscript`, makes a 3-input one,
and says how to run `build.mjs`, `export.mjs` and `redteam.mjs` there with it.
