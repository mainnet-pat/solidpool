# SolidPool factory audit, 2026-11-17

An AI review, not a human audit. A Claude agent on the Fable model read both pool factories'
compiled bytecode and the creation path at `9a1487c`, after the guard of `7da7067` and the
readers' binding of `0d557ba`. It checked shapes in libauth's 2026 VM and on SolidCash's mock
network, and changed nothing. A follow-up read the empty-master-commitment rule (`ae1e4b8`) on
its branch. Both reports follow as written. Their scripts lived in scratch directories and were
not kept; the shapes they found are now tests.

What came of the first report's findings:

1. The genesis check refused a working token pool whose token coin also carries an immutable NFT
   with no commitment. Fixed in `scripts/lib/genesis.ts` (`72096bd`); the shapes are in
   `contracts/test/deployer-genesis.test.ts`'s squat list.
2. A creation could write up to 128 bytes on a factory's master. Every master's commitment is
   empty, as SolidCash's model has it, so each factory's `create` now requires it (`ae1e4b8`).
   The follow-up below read that change.
3. The master need not be at input 0. The readers now read the master's own input first
   (`6555d1c`, with the shape in `contracts/test/history-readers.test.ts`). No on-chain rule was
   added.
4. The token factory's list grows without bound. That is by design.

---

# Audit of the two pool factories and the creation path, at 9a1487c

## Verdict

**The factories hold on chain; fix one reader bug, and decide on two missing rules before deploying.** I found no way to mint a stray NFT of a factory's category, give an amount (or an asset and amount) a second pool, move a factory's master outside `create`, or take an amount on chain without a working pool. The guard of 7da7067 is complete in every shape I built, and the bytecode guarantees what the readers of 0d557ba assume.

Three things to settle:

- **A reader bug, fixable at any time.** `genesisProblems` refuses a token pool that the chain made and that works, and the factory then makes no other pool of that asset and amount (finding 1).
- **Two rules the pools carry and the factories lack, addable only before deployment.** `create` neither keeps the master's commitment nor asks for the master at input 0 (findings 2 and 3). Both are low severity. Adding both costs 8 bytes per factory, measured on a compiled copy.
- **Keep the guard loop whatever SolidCash's census fix does.** Compiled without it, SolidCash 0.51.1's own rules still accept a no-commitment NFT and an SCID-shaped NFT of the factory's category at any lock (VM-checked on a copy).

**How it was checked.** I read the bytecode instruction by instruction and ran shapes in libauth's 2026 VM, in standard and consensus mode. That is the project's libauth fork (mainnet-pat/libauth#1cf4b43), which does not charge `OP_DEFINE` bodies; I added them by hand where cost matters. End-to-end checks ran on SolidCash 0.51.1's MockNetworkProvider. I did not run BCHN. The integration gate's own log at this commit (`scratchpad/gate/final-real-node2.log`) shows BCHN 29.0.0 at 1 sat/B taking BCH and token creations through both factories.

**What was audited.**
- `BchPoolDeployer.json`: debug.bytecode 1,832 B, sha256 `bae3beca…eab973`.
- `TokenPoolDeployer.json`: debug.bytecode 2,000 B, sha256 `9ab7747b…9eaa04`.
- `scripts/check-contracts.ts` confirms both are what the installed 0.51.1 compiles from the sources.
- The project's three factory test files pass here (87 tests, run once).

No commits; nothing outside my worktree was touched.

## Findings

### 1. Medium: the genesis check refuses a working token pool the chain made

- **Where:**
  - `TokenPoolDeployer.json`, `childDeployers.TokenPool` (`Deploy<TokenPool>`), `create` (selector `af341413`), bytes 1584–1627 of its 1,864-byte body. The token coin must have the asset's 32-byte category, at least 1 unit, an empty commitment (`OUTPUTTOKENCOMMITMENT 0 EQUALVERIFY`) and at least 1,200 sat.
  - `scripts/lib/genesis.ts:255`: `if (tokenCoin.token?.nft) problems.push('an NFT on the token coin')`.
- **Rule:** AUDIT.md says a shape the chain takes and the check refuses is a finding; README:143 says `Deploy<C>` pins "one coin of the asset with no NFT".
- **Why it fails:** a coin holding fungible units plus an immutable NFT with no commitment reads to every opcode like the units alone. `Deploy<C>` cannot refuse it; the check, reading the decoded transaction, does.
- **Shape:** the SDK's token creation with one more input holding an NFT of the asset's category, and the token coin output carrying `amount 1` plus an immutable NFT with no commitment. The input NFT can be immutable with no commitment, mutable, or the minting one.
- **Who and cost:** the asset's issuer if it kept a minting or mutable NFT, or anyone holding such an NFT. One creation per amount, about 22,600 sat, 13 amounts per asset.
- **VM-checked:** yes, in three variants, standard and consensus. The project's test "an NFT of the asset on the token coin" uses a one-byte commitment, which the chain refuses, so the empty one was never tried.
- **Effect:**
  - `genesisProblems` returns `["an NFT on the token coin"]` (run).
  - The indexer's `Discovery` logs "not ready: an NFT on the token coin" and never serves the pool (run). The default "Fast indexer" view takes its pools from the indexer or the deployment file, so it never shows it (by reading).
  - `verify-deployment.ts` would fail on it (by reading).
  - `factoryPools` and `factoriesMade` list it (run), so a Trustless page lists it and Create pool says the asset and amount already have a pool (by reading; UI not run).
  - The pool works: on the mock I deposited, finished and withdrew with a real proof, and the NFT rode along on the coin.
- **Fix:**
  - In `genesis.ts`, refuse only an NFT that has a capability or a commitment, which the chain refuses too.
  - Add the no-commitment shape to the squat list in `deployer-genesis.test.ts`.
  - Correct README:143, 161 and 233–238.

### 2. Low: a creation can write up to 128 bytes on a factory's master, for good

- **Where:** both factories, `create`.
  - `BchPoolDeployer`: bytes 984–993 pin the master output's lock and category; bytes 1780–1790 pin its value and amount.
  - `TokenPoolDeployer`: functions `9` and `0x86` do the same.
  - Nothing pins the commitment: `INPUTINDEX OUTPUTTOKENCOMMITMENT INPUTINDEX UTXOTOKENCOMMITMENT EQUALVERIFY` (`c0d2c0cf88`) occurs three times in each pool's bytecode and never in a factory's.
- **Rule:** `BchPool.scash:139`: "Every public function keeps the master's commitment. Nothing reads it, and anyone who could change it could grow every later transaction by 128 bytes."
- **Shape:** any creation whose master output carries a commitment.
- **VM-checked:** yes, 1 and 128 bytes, both factories.
- **Effect (mock):** the SDK copies the commitment into every later creation.

  | | Before | After |
  |---|---|---|
  | BCH creation | 9,937 B | 10,066 B |
  | Token creation | 15,832 B | 15,961 B |
  | Token fee rate (fee fixed at 16,357 sat) | 1.0332 sat/B | 1.0248 sat/B |
  | Token margin over 1 sat/B | 525 sat | 396 sat |

  Readers are unaffected. The master's 1,200 sat stays above dust, which is 1,065 sat with 128 bytes on it. The BCH factory has at most five creations ever, so this matters for the token factory.
- **Fix:** add the pools' line to both `create`s: `require(tx.outputs[this.activeInputIndex].nftCommitment == tx.inputs[this.activeInputIndex].nftCommitment, "master")`.

### 3. Low: the master need not be at input 0, and the lineage walk pays for it

- **Where:** both factories, `create`. Every position is relative to `INPUTINDEX`. `INPUTINDEX 0 NUMEQUALVERIFY` (`c0009d`) occurs three times in each pool and never in a factory.
- **Rule:** the same comment in `BchPool.scash`: every function "asks for the master at input 0, so a history reader finds every event in one place".
- **Shape:** n of the builder's inputs and n outputs first, then the factory's block. The record's master index and `Deploy<C>`'s `authorIndex` and `genesisOutputBase` move by n.
- **VM-checked:** yes. The standard VM takes up to 94 such pairs on the BCH factory and 48 on the token factory.
- **Effect:** `createdAt` and `genesisProblems` still find the creation. `lineage()` in `web/src/lineage.ts` reads the parent of every input until it meets the master: 52 transaction reads for 50 inputs, against 2 for the SDK's creation. The token factory takes any number of creations, so each hostile one costs every fresh reader up to 49 sequential fetches.
- **Fix:** on chain, `require(this.activeInputIndex == 0, "master")`. Or in the reader: the master's output index is its input index, so read only that input's parent.

**Both fixes, measured on a compiled copy of the sources:**

| | Shipped | With both rules |
|---|---|---|
| Factory code | 1,832 / 2,000 B | +8 B each |
| BCH creation | 9,936 B | 9,945 B |
| Token creation | 15,832 B | 15,840 B |
| Token factory input, op budget used | 86.88% | 86.79% |

The SDK's creations go through unchanged, both shapes above are refused, and the guard still refuses.

### 4. Low, by design: the token factory's list grows without bound

- **What:** creation is permissionless and each pool is permanent.
- **Cost to add one:** about 22,600 sat: 263 sat prep fee, 16,357 sat creation fee, and 6,000 sat left in its coins.
- **Cost to everyone else:** each pool adds 15,832 B that every Trustless listing and every token creation must read, plus a row on the page. 1,000 junk pools cost about 0.23 BCH.
- **On chain:** nothing bounds it short of a design change. Finding 3 multiplies the reads by up to 49.
- **Reader-side options:** take the leaf list from an indexer and check it against the root, which `createThroughFactory` already does for any list; and do not auto-list unknown assets.

### 5. Informational

- **A creation's txid can be changed without a key.** VM-accepted with the author's signature untouched: the state record's flag 4 for 1, or flag 3; `Deploy<C>`'s `budgetPad` up to a 10,000-byte input; `genesisSidecarBase` of any value. `TokenPoolDeployer.scash:63` says the exact path length means "nobody can pad the unlocking and change the transaction's id"; that holds for the factory's input only. Nothing of the creator's chains on that txid.
- **`__construct` can never run, not even once.** It needs input 0 to spend the category's own outpoint, which the genesis spent. The token factory's first root is whatever the genesis wrote, and only `factoryGenesisProblems` checks it. With an invented second spend of that outpoint, the VM lets `__construct` write the empty root over a root holding pools, so that guard is all that protects the tree; consensus makes it sound.
- **The BCH factory reads `made` from the record's first push and ignores trailing bytes** (VM: `00 ff` accepted). Only a dishonest genesis can produce that, and the genesis check catches it.
- **The SDK's token creation pays 1.033 sat/B.** The author coin is sized before the creation is built.
- **Anyone can move or burn a factory's SCID anchor,** since its seed `create:<deployer address>:<nonce>` is public. Anyone can respend a real `PoolCreated` after 144 blocks. Both VM-checked; on the mock the SDK and readers were unaffected with the anchor at the record lock, master lock or event lock, or burned.
- **A creation that fails after its prep went out strands the 3,200 or 3,500 sat deployer coin.** `Deploy<C>`'s `sweep` lets anyone take it after 1,440 blocks into a single output with no token, so a sweep cannot mint the category.

## The five questions

1. **Is the guard complete? Yes.**
   - Location: bytes 742–793 of `BchPoolDeployer` and 982–1033 of `TokenPoolDeployer`, identical code.
   - Comparison: the first 32 bytes of each output's category against the first 32 of the spent master's. The capability byte is cut off both sides, so immutable, mutable, minting and fungible-only outputs all match. Outputs with no token are skipped before the split.
   - Window: `WITHIN(k, i, i+3)` on the active input's index, where the master's output is pinned.
   - Per factory, 394 extra-output shapes were all refused at the guard's own `VERIFY`:
     - 9 locks × 3 capabilities × 6 commitments;
     - fungible-only, and an NFT with a fungible amount;
     - the extra among 50 and 200 outputs;
     - the master at index 1 with the extra before or after.
   - 17 shapes changing an exempt slot were refused elsewhere. Controls were accepted, including categories differing from the factory's in one byte.
2. **Does the bytecode guarantee the readers' binding? Yes.**
   - Output i+2 is pinned to the event: lock, immutable, amount 0, exact commitment, at most 1,200 sat.
   - Output i+3 is pinned to the minting NFT of input i+2's outpoint txid. `Deploy<C>` requires exactly one such NFT, at the pool's lock, so its base is i+3.
   - Only `create` moves a master: the BCH factory has no dispatch, and the token factory dispatches by 4-byte identifier with `__construct` dead. Every alternative unlocking I tried was refused, including padded selectors such as `05000000`.
3. **Can a creation squat, or make a second pool?** Not on chain. Against the project's own check, finding 1.
   - Second pools refused in the VM: a set mask bit, stale and current tree paths, wrong new roots.
   - Refused as stand-in state records: the SCID anchor and a `PoolCreated`.
   - Refused encodings: non-minimal exponents, in both modes.
   - On the mock, all five BCH amounts and all 13 token amounts were created, read and passed the genesis check.
4. **Does any shape go over a limit?** None the app builds or a third party can force. Signatures are `0x61`, so nobody can add inputs or outputs. See Limits.
5. **Do the docs match?** Mostly. See Docs.

## What holds, and how I checked it

- **The three exempt outputs are pinned.** Read; VM, including values ±1 sat and each event field.
- **The factory binds `Deploy<C>` through its unlocking's first bytes.** These are the selector, the factory's category, deploy value 0, the asset, and the exponent, plus the coin's lock. Mismatches of each, and the sweep selector, are refused (VM).
- **`Deploy<C>.create` pins the genesis** (read in full; `Deploy<BchPool>` also traced step by step):
  - its own outpoint index 0, and the author's coin at index 1;
  - sha256 of the pool code;
  - master and record at 1,200 sat, with the empty state;
  - one satoshi coin with no token; one token coin;
  - exactly two outputs of the new category.
- **The record lock has four paths, and none drops or changes the record without `create`.** Flag 0 respends it in place; that was "not run" in the earlier audit and is now accepted on the mock at 549 B.
- **Minting NFTs cannot multiply; mutable ones are conserved; the BCMR identity cannot leave its lock or spawn NFTs** (read, including SolidCash's `authhead.ts`).
- **The hash chain is intact:** factory bytecode → `Deploy<C>` lock → pool code hash → the pool artifact (computed).
- **Stray coins do not stop the SDK's creation.** Plain and token coins, and another category's minting and mutable NFTs, at the factory's master, record and satoshi-container locks (mock).

## Limits (libauth, standard mode)

| Input | Unlocking | Op budget used | With defined bodies charged |
|---|---|---|---|
| BCH factory | 1,873 B | 17.26–17.31% | 17.29–17.33% |
| Token factory | 6,178 B | 86.88% | 86.92% |
| `Deploy<BchPool>` | 6,968 B | 8.12% | 8.15% |
| `Deploy<TokenPool>` | 8,275 B | 7.58% | 7.61% |
| State record | 242 B | 8.25% | 8.28% |

- **The token factory input is the only one near a limit.** It has no pad argument, so its headroom is fixed. Across 15 keys and all 13 exponents it used 86.76–86.89%; the key's bits do not matter. Hashing is 564 of 3,109 iterations.
- **What a builder can add to his own creation before it fails:**

  | | BCH factory | Token factory |
  |---|---|---|
  | Plain outputs | 122 | 62 |
  | Plain inputs | 420 | 217 |
  | Token inputs of another category | 48 | 44 |

## Docs against the bytecode

- **Stale since the guard:** README:215 and 239–241, `web/src/factory.ts:157`, `scripts/lib/genesis.ts:270`, `indexer/discover.ts:17`, `web/src/listing.ts:11` and `history-reach.test.ts:12` say a creation can mint a stray NFT at bare `OP_1`. These factories refuse it. What can still reach the event address is the SCID anchor and a respent real event.
- **README:143 "with no NFT" and README:161 "no page or indexer lists the first":** see finding 1. A Trustless page lists by `factoryPools` alone.
- **`genesis.ts:218`:** "spent only by a genesis its covenant pins" omits `sweep`. The conclusion holds.
- **Both factory sources say "A reader takes an immutable NFT of the category at the event's address as a creation";** readers no longer do.
- **AUDIT.md:68 and 138, PRODUCTION.md:335:** the guard has now been read, and the record respend has been run.
- **In passing:** PRODUCTION.md:96 says no audit read the shipped verifier template; AUDIT.md says the 2026-11-17 audit did.

## Coverage

- **Fully:** `BchPoolDeployer.create`; both guard loops; the record lock; the event lock; the token factory's dispatch and `__construct`; `Deploy<BchPool>` `create` and `sweep`.
- **In part:**
  - The token factory's tree loop and `Deploy<TokenPool>.create`: read in full, then confirmed by behaviour, not traced step by step.
  - The container census: read, and exercised by token-input shapes.
  - Readers: `createdAt`, `factoryPools`, `genesisProblems` and `Discovery` were run on my shapes; `lineage.ts` only on the factory's path.
- **Not at all:** BCHN itself; the pools' and verifier's bytecode; the page's UI; real wallets; `deploy-factories.ts`; a factory genesis other than the SDK's.

Scripts are untracked in the worktree at `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory/_review`. Start with:
- `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory/_review/q1-guard.ts`
- `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory/_review/squat-token-nft.ts`
- `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory/_review/patched-check.ts`

---

# Follow-up: the empty-commitment rule on factory-rules (64a8786)

### Verdict

**The change is correct and minimal, and I found nothing that makes the rule wrong for these contracts.** No findings. All five points check out in the VM and against SolidCash 0.51.1's source.

Checked in the same libauth fork as before (mainnet-pat/libauth#1cf4b43, standard and consensus mode) and on SolidCash 0.51.1's mock. I did not run BCHN. `scripts/check-contracts.ts` passes on the branch, and the three factory test files pass (95 tests, run once). No commits.

### 1. The new check

- **Where:** `INPUTINDEX OUTPUTTOKENCOMMITMENT OP_0 EQUALVERIFY` (`c0 d2 00 88`), once in each factory, immediately before the guard loop and outside any `IF` or loop.
  - `BchPoolDeployer`: bytes 742–745 of debug.bytecode; the guard now starts at 746.
  - `TokenPoolDeployer`: bytes 371–374 of the `create` body (982–985 of debug.bytecode); the guard now starts at 986.
- **What it does:** in a trace of the SDK's creation it pushes the master's index, reads an empty commitment, compares and leaves the stack as it was (depth 5 to 5, and 8 to 8).
- **Refused at that instruction, both factories, both modes:** one zero byte, one byte, 40 bytes and 128 bytes on the master's output, in first and second creations, and with the factory's block one place down.
- **Accepted:** the SDK's creations, 4 fixtures and 20 more covering every amount (5 BCH, 13 token, plus 2 of a second asset).
- **End to end on the mock:** a creation that writes 128 bytes on the master is now refused, and the next SDK creation is unchanged with an empty master.

### 2. Nothing else changed

- **Exact edit:** the audited bytecode with `c0d20088` inserted before the guard loop is the new bytecode, byte for byte, in both factories. The token factory also has the `create` body's push length raised from 783 to 787.
- **Identical to 9a1487c:** the guard loop, `__construct`, both `childDeployers` entries, the ABIs, and the artifacts of BchPool, TokenPool, MimcHash, Sidecars and BN254.
- **Other fields that differ:** source text, debug maps, timestamp, and the BCH factory's fingerprint. The token factory's fingerprint is unchanged because it ignores pushed data.
- **Readers:** `web/src`, `scripts/lib` and the indexer are unchanged since 9a1487c.

| | Before | Now |
|---|---|---|
| `BchPoolDeployer` code | 1,832 B | 1,836 B, sha256 `a5f2566c…851d1cf3` |
| `TokenPoolDeployer` code | 2,000 B | 2,004 B, sha256 `e94bcd4e…8858eda1` |
| BCH creation | 9,936 B | 9,940 B |
| Token creation | 15,832 B | 15,836 B |
| BCH factory input, op budget | 17.26% | 17.25% |
| Token factory input, op budget | 86.88% | 86.83% |

### 3. The shape scripts, re-run on the new artifacts

- **`q1-guard.ts`:** unchanged. Per factory, 411 shapes, none accepted, and all 394 extra-output shapes refused at the guard's own `VERIFY`.
- **`squat-token-nft.ts`:** unchanged. The chain still takes the token coin carrying an NFT with no commitment, and `genesisProblems` still refuses it, since the reader is not touched on this branch.
- **Binding checks (`q2-binding.ts`) and seven other scripts:** I ran each on both worktrees and diffed the verdicts. Only shapes that put a commitment on the factory's master differ: accepted before, refused now.
- **Limits:** unchanged. The token factory still takes at most 48 inputs before the master, and the BCH factory 94.

### 4. `Deploy<C>` and the new pool's master

Confirmed independently. One zero byte, one byte, 40 and 128 bytes on output i + 3 are refused in both modes, on both factories. The factory's own input passes, and the deployer coin's input fails at its `OUTPUTTOKENCOMMITMENT OP_0 EQUALVERIFY`. The same holds with no factory in the transaction at all, where the control is accepted. So no rule was needed in `create` for it.

### 5. What could make the rule wrong

I looked for a SolidCash path, a genesis shape and a reader, and found none.

- **SDK paths (source, 0.51.1):**
  - a genesis writes the master with an empty commitment (`sc-deploy.ts:412`);
  - a creation copies the input's commitment (`sc-deploy-from.ts:2720`);
  - nothing writes a new one.
  - Every factory genesis in the project goes through `deployFactory`.
- **Compiler:** it only ever preserves a master's commitment, and only in functions that touch no state (`GenerateTargetTraversal.ts:12548–12614`). The source comment's claim is accurate. Nothing else in either factory reads or pins the master's commitment.
- **SolidCash's own design:** `docs/design/CONCEPT_VALIDATION.md:166` says the master's commitment is "empty by convention". Its `docs/security/SECURITY-AUDIT.md:367` lists this gap as a known low, with "assert the master commitment stays empty" as one fix.
- **Pools:** `deposit`, `finish` and `withdraw` each carry the keep rule once; `__construct` is dead behind the genesis-outpoint guard. The docs' sentence holds.
- **Readers:** only the two genesis checks read a master's commitment, and both require it empty.
- **Deployments:** no deployment file names a factory, so the changed locks break nothing recorded.

**The one behaviour the rule changes.** A factory born with a commitment on its master used to work, carrying it forever. Now the SDK copies it and its own check refuses every creation (mock run). `factoryGenesisProblems` flags that genesis as "the master holds a commitment" (run), and a creation that writes the master empty is accepted (VM). This fails closed, and only a hand-written genesis can cause it.

### Still open, not part of this change

- **Finding 1 (the genesis check and the invisible NFT)** is as before on this branch.
- **Finding 3 (the master need not be at input 0)** is as before on this branch.
- **BCHN:** the gate's real-node run predates these four bytes, so it should run again on the final tree.

### Coverage

- **Fully:** the byte diff of every artifact; the rule's location, trace and refusals; `Deploy<C>`'s rule with and without a factory; the re-run shape scripts.
- **By reading:** SolidCash's SDK, compiler and docs.
- **Not at all:** BCHN, the page's UI, real wallets.

The worktree is `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory-2`, with my scripts untracked in its `_review` folder. Start with:
- `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory-2/_review/r1-rule.ts`
- `/tmp/claude-0/-Code-tornado/449f8e01-aaf1-4aa7-903e-f80bb69a8522/scratchpad/agents/review-factory-2/_review/diff-exact.cjs`
