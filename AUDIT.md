# Audit brief

For whoever reviews this before it holds real money. `ARCHITECTURE.md` explains the design
and `PRODUCTION.md` what has been checked. This says what to look at, what we believe, and
how to test it.

## What is at stake

Fixed-amount pools on Bitcoin Cash. A deposit adds a commitment to a Merkle tree. A
withdrawal proves with Groth16 that the withdrawer holds an unspent note in that tree,
without saying which. Nobody administers a pool and nothing can recover funds, so a bug is
permanent. A pool is as safe as its contracts, its verifier and its genesis.

## Scope, most valuable first

1. **The Groth16 verifier in BCH Script.** Generated, 8,175 B, across three inputs:
   `packages/verifier/bn-native-sound/script.mjs`, vendored from `groth16_cashscript`.
   A person reviewed its 2-input original. The third public input and the composition with a
   pool were audited on 2026-11-13 by an independent AI auditor, a Claude agent on the Fable
   model, which found no soundness break: `service/verifier/AUDIT-2026-11-13.md`. No person
   has reviewed them yet. What that audit could not check was checked on 2026-11-14
   (`service/verifier/CHECKS-2026-11-14.md`):
   - BCHN agrees with libauth on every verdict, and its op cost is libauth's plus the bodies
     `OP_DEFINE` stores, as the prover assumes;
   - the bytecode was checked against the math, function by function;
   - the key was traced to Tornado's ceremony, except for where its phase 1 came from.

   Both read the template of then: 8,212 B, sha256 `37c8b9ec…`, a 69-byte redeem, with a
   37-byte brand that tied each verifier to one pool. The verifier is now shared by every pool
   (groth16_cashscript `2aa8ddd`): the brand is gone, and the redeem gained a branch that lets
   anyone sweep a coin unmoved for 1,440 blocks when it is its transaction's only input. That
   is the template that ships: 8,175 B, sha256 `7b513096…`, an 80-byte redeem
   (`service/verifier/verifier-artifact-3in.json`). A second AI audit, on 2026-11-17 and also
   on the Fable model, read it against the template of then: the brand's removal, the sweep
   wrapper and the lengths that follow are its only changes, the sweep needs its coin to be the
   only input, and no root, nullifier hash or payee can be aliased
   (`contracts/AUDIT-2026-11-17.md`). It did not re-derive the pairing arithmetic, which is
   byte for byte that of `37c8b9ec…`. No person has read it.
   `service/verifier/tamper.ts` and `forge.ts` run on it, and the lone-input rule is tested in
   the VM and on BCHN (`test/real-node.ts`), but the branch, and a pool's reliance on the lock
   alone where the brand was, are first for a reviewer.
2. **The contracts.** `contracts/BchPool.scash`, `TokenPool.scash`, `MimcHash.scash`, the two
   pool factories, `Sidecars.scash`, and what the compiler makes of them in
   `contracts/artifacts/`. Every pool is made through a factory, which refuses a second pool of
   an amount, or of an asset and amount, on chain, and every pool shares one hashing contract and
   one verifier, whose locks it pins: check that no creation can take an amount without a working
   pool, and that no coin a pool reads can be one that did not run that code, the lone-input
   sweep of both included. Read the
   compiled code too: the rules a pool relies on most are the ones SolidCash generates, listed
   below. SolidCash 0.51.0's release review, an independent AI review by a Claude agent on the
   Fable model, checked 70 rules the pools' and deployers' sources and docs state against
   the code 0.51.0 compiles: 67 are enforced, one is narrower than its wording (T9, below),
   and two rest on the verifier. Its report is `docs/wip/release-0.51.0/CONFORMANCE-0.51.0.md`
   in the SolidCash repository. It does not cover the contracts that ship. It read this
   project's sources on the morning of 2026-11-16, and `b16443b` replaced them at 17:48 UTC
   that day. In the code it read:
   - a pool took the hashing and verifier locks as arguments;
   - `MimcHash` took its pool's category and spent only beside that pool's master (its rule
     M1, `MimcHash.scash` lines 14-15);
   - only `deposit` asked for the master at input 0 itself;
   - a factory made any number of pools of an amount.

   The 2026-11-17 bytecode audit (`contracts/AUDIT-2026-11-17.md`), an AI review on the Fable
   model, read what replaced them in the code compiled at `9ceafd7`: the factories' `made` mask
   and 128-level tree, the shared `MimcHash` and its sweep, the locks `Sidecars.scash` pins, and
   `finish` and `withdraw` asking for input 0. It found no way to take funds, forge a
   withdrawal, spend a note twice or stop a pool for good, and one way to forge a factory's list
   of pools, closed since (below). The factories' `create` changed after it, to refuse those
   records (`7da7067`), and again to require an empty commitment on its master (`ae1e4b8`). A
   second AI audit on the Fable model read both changes, the whole creation path and the readers'
   binding, and found nothing on chain that takes funds or makes a second pool
   (`contracts/AUDIT-2026-11-17-factories.md`). No person has reviewed any of it.

   `contracts/BN254.scash` is not one of the contracts: no coin runs it, and only
   `scripts/measure.ts` uses it, as a cost probe. Its constant `P` is the BN254 scalar field r,
   not the base field.
3. **SolidCash's direct convention**, for the parts these pools depend on: the container and
   state covenants in `packages/utils/src/state.ts`, `pragma satoshicontainer single` and
   `pragma tokencontainer single`, the event census in `GenerateTargetTraversal.ts`, and for a
   pool made through a deployer, the one-shot deployer coin `Deploy<C>`.
4. **The client's trust boundary.** `web/src/pool-client.ts`, `history.ts`, `engine.ts`, and
   which pools a page takes: `listing.ts`, `listed-pools.ts` and a note's `note-text.ts`.
5. **The page.** `web/components/ui.ts`, `web/proxy.ts`. A note is a bearer secret, and the
   page is what holds it.

## What must hold

Each of these is a claim to break.

- Only the holder of a note in the tree can withdraw it, and only once, and only to the
  recipient the proof names.
- A pool's satoshi and token coins hold exactly its unspent notes.
- One coin always holds all the pool owes, whatever is paid to its locks and whichever coins a
  transaction picks, so every note can be paid from one coin.
- A token coin never loses a satoshi or gains an NFT a script can see, and no coin paid to a
  pool's lock can stop a call or leave a note unpaid.
- Nobody can stop a pool for good. No coin the client reads can gain a token, no record at an
  event address is taken for an event, and no `PoolCreated` counts outside the place a factory's
  `create` writes it. What griefing can still do is below.
- A withdrawal says nothing about which deposit it spends. A deposit never funds its own
  withdrawal: all money sits in one coin.
- After an honest genesis, the master and the state record stay one of each.
- After a factory's honest genesis, every NFT of its category is its master, its state record,
  its BCMR identity, its SCID anchor or a `PoolCreated` that its `create` emitted for the pool
  born in the same transaction.
- Every master's commitment is empty, for good: all state lives in state records. SolidCash
  keeps a master's commitment only in a function that touches no state, so the contracts' own
  code holds it on chain: `Deploy<C>` lets a pool's master be born only without one, every pool
  function keeps its master's commitment as it was, and each factory's `create` requires its own
  master's to be empty. A factory's master starts without one, which `factoryGenesisProblems`
  checks.
- A page lists a pool, deposits into it and withdraws from it only if its network's own factory
  of that kind made it, with the amount and asset listed or named in the note, whatever an
  indexer, the app's server or a note's text says. It reads that through its Fulcrum server,
  which it trusts for what the chain holds.
- A note alone withdraws: a page or script with no list of pools, no indexer and nothing
  stored pays it through a chain server, and a note an older page wrote still pays.
- Apart from which pools exist (above), a server can cost a page a retry, or, alone, its
  privacy. It cannot make a page sign one note twice: a signed transaction can land at any time,
  so once one has left the page, that note is never signed again, whatever any server says.
  Depositing again means a new note.
- With two servers, the second hears nothing of a deposit, and the wallet's server nothing of
  a withdrawal but one read of the pool's public state. An archive serves one server's side
  alone. Both see an IP address, so together they can still compare notes.
- A page's report rests on its servers. A hostile one can say a deposit landed when it did not,
  which costs nothing because the person holds the note and the wallet still holds the money.
  It can also say a withdrawal paid when it kept the transaction. A page says `paid` only once
  the pool it is shown has the nullifier spent, which a server can only manage by holding the
  transaction in a mempool of its own, so a page never clears a note, and that too costs
  nothing while the person keeps it.

## What we know is not true

- This release reads the chain from one server and takes its word on which pools the factories
  made: one that lies about the chain can show a pool made outside them as theirs, and take what
  is deposited into it. Cluster mode, straight after this release, will need several servers to
  agree (`PRODUCTION.md`, "Chain servers"). One server alone is also trusted for privacy.
- Anyone can stop wallet deposits for as long as they pay to. SolidCash's merge path and its
  read-only path let anyone move the satoshi coin and the state record back to themselves, for
  510 B and 649 B on SolidCash 0.51.0, as `contracts/test/griefing.ts` measures. A wallet's
  signature names those coins, so a move during a wallet prompt spoils that deposit. One
  satoshi-coin move every 10 seconds is about 0.044 BCH a day.
  Funds and withdrawals are untouched.
- Anyone can move other coins the same way, the 2026-11-17 bytecode audit
  (`contracts/AUDIT-2026-11-17.md`) found:
  - three verifier coins, spent on their own with any valid proof over a made-up root and
    recreated as they were, for about 30 kB of fee a move (in the VM);
  - a hashing coin, spent beside any input with a true hash, for about 8 kB of fee a coin (in
    the VM);
  - a factory's state record, respent in place through its lock's flag-0 path, which keeps its
    commitment, lock, category and value (by reading the bytecode, not run).

  A move changes the coins' outpoints, so it spoils a deposit, a withdrawal or a creation in
  flight that spends them. The verifier and hashing moves cannot block for good, since anyone
  can pay fresh coins to either lock. The record move, like a pool's, can spoil creations for as
  long as someone pays for it.
- Anyone can pad a lock's history. A plain coin paid to a lock costs about 800 sat, and each one
  at an event's address costs a client without an archive a transaction fetch. About 1 BCH
  passes Fulcrum's default `max_history` of 125,000 entries. Fulcrum counts the whole confirmed
  history before it applies any height range, and past it answers with an empty list and a
  warning in its log, not an error (`Storage::getHistory` in `src/Storage.cpp`). The readers do
  not take that for no history: genesis checks, factory lists and a pool's events are read by
  txid along the factory's or the pool's own chain, or from `get_first_use`, which no limit
  stops (`Storage::getFirstUse`), and a history that lacks its first transaction is refused as
  the server's limit (`HistoryLimit` in `web/src/fulcrum.ts`). `contracts/test/history-reach.test.ts`
  pads each lock they read past a limit of 1,000. What still blinds a server at the same price
  is coins paid to a lock the client lists, since `listunspent` has the same limit
  (`Storage::listUnspent`) and past it lists only the lock's mempool coins, and every call reads
  those lists: a pool's or a factory's master, state record and containers, and the verifier
  and hashing locks every pool shares, where one padding stops every pool on that server. The
  client refuses a list without the master, the state record or the pool's own coin while the
  lock has a first transaction, and an empty list at the verifier or hashing lock while the
  server's balance for it is not zero, as the server's limit (`mustShow` and `refuseHiddenCoins`
  in `web/src/provider.ts`), not as a missing pool or too few coins. A server older than Fulcrum
  1.9.6 has no `get_first_use`; the app asks for 1.10 or later.
- Eight deposits during a proof retire its root. It costs about 1.8M sat a round, and the
  client proves again.
- A nullifier slot is 64 bits, so two notes can collide and the second can then never be
  withdrawn. A nullifier hash is public only once spent, so nobody can aim at a note, and by
  chance it is about 3 in 100 million across a full tree.
- The verifier's red-team suite runs under a test key with a published trapdoor, so it can
  mint proofs for any statement. It tests the verifier, not the production key.
- The trusted setup is Tornado Cash's published one, for its withdraw circuit. The pools do
  not depend on any party's new ceremony, and they inherit that one's assumptions:
  - at least one of the ceremony's 1,114 contributions destroyed its secret;
  - at least one of the first 30 Perpetual Powers of Tau contributions destroyed its secret;
  - the phase-1 file the ceremony used came from the 30th, as Tornado's team said. That can
    no longer be checked, because the files are offline. Whoever made that file, if it came
    from anywhere else, can prove anything.
- The pool factories depend on SolidCash 0.51, 0.51.1 here. Before 0.51.0, anyone could spend a deployer
  coin without its author's coin, and the chain took a creation that paid the new pool's
  state record or satoshi coin elsewhere, opened the satoshi coin at 600 sat or opened a
  second one. 0.51.0's `Deploy<C>` refuses each of those on chain, and `scripts/lib/genesis.ts`
  finds all but the missing author's coin off chain as well. The factories' binding to a real
  creation (a plain coin for the deployer coin, a second amount recorded, a missing or second
  `PoolCreated`, a missing or second master) is tested on a BCH factory's creation; the token
  factory runs the same `new`, and its own tests cover its tree and its duplicates. 0.51.1
  changes only the SDK: a wallet the page holds no key for now signs the prep and then the
  creation, where 0.51.0 refused every such creation before broadcasting it. Its compiler is
  0.51.0's, so the bytecode is the same. The release review above read these contracts before
  `b16443b` changed them, though, so it does not cover them as they ship.
- SolidCash 0.51.1's census of a contract's own outputs passes over an immutable NFT of its
  category at a bare `OP_1` lock, the lock of a return record, and over one with no commitment
  or shaped as an SCID anchor. The bytecode audit of 2026-11-17 found, in the VM, that a
  factory's creation could therefore mint an NFT at `OP_1` holding a `PoolCreated` that names any
  pool, for anyone to pay to the event address later, and that a pool made through `Deploy<C>`
  with no factory could carry one in its genesis. Two things now stop it, and neither leans on
  the other:
  - Each factory's `create` refuses every output of its category but the master at its own
    index, the state record after it and the event after that, whatever the lock, so no
    creation can mint one (`contracts/test/deployer-outputs.test.ts`). The refusal is in the
    mint: a genesis made with no factory runs none of the factory's code, so it can carry such
    an NFT only if one exists.
  - The readers count a `PoolCreated` only two outputs after the factory's own master, where
    `create` writes it (`createdAt` in `web/src/factory.ts`), and `genesisProblems` also asks
    for the pool's master right after it, because a factory of another version, and anything
    already on chain, may hold such NFTs. `history-reach.test.ts` reads both shapes, and the
    token factory's tree, which a forged record in a taken slot used to stop `registryTree`
    rebuilding.

  SolidCash is to close its census itself.
- A factory makes one pool of an amount, so a creation the chain takes and `genesisProblems`
  refuses would squat that amount for good. `deployer-genesis.test.ts` holds the two to agreeing
  over 32 shapes on both factories, and the check was relaxed once for it: it takes a token coin
  opened with more than one unit, as the chain and the pool do. A shape the chain takes that the
  check refuses, or one the check takes that a pool cannot run with, is a finding.
- The hashing and verifier coins are shared by every pool, and their sweep needs the coin to
  be its transaction's only input. A pool reads each coin it spends by its pinned lock, so the
  soundness of a deposit and a withdrawal rests on that rule of `MimcHash` and of the verifier's
  redeem: no spend of either lock beside another input skips its computation.
- A token pool tells a deposit coin from its token coin by the coin's lock length alone: 25
  bytes, a P2PKH's (T9 in the release review), where the contract's comment says a P2PKH. The
  compiled `deposit` tests `OP_UTXOBYTECODE OP_SIZE OP_NIP 25 OP_NUMEQUAL` and nothing else
  about the lock. The review added that another 25-byte lock is non-standard, so that only a
  miner could make such a coin. That stopped being true on 2026-05-15: the upgrade's P2S rules
  made any lock of up to 201 bytes standard. The argument that remains:
  - a coin at any 25-byte lock is held to a deposit coin's rules: a positive amount of
    `asset`, no NFT a script can see, and under 1,500 sat;
  - the pool's token coin is a 35-byte P2SH32, so it is never taken for a deposit coin;
  - asset inputs at every other lock must add up to exactly what `this.tokens[asset]` reads,
    so none but the pool's own token coins can be among them;
  - the token coin still gains exactly one denomination and the satoshi coin exactly the
    fees, whatever lock the depositor's coin has.

  We found no way to take or lock funds through it, but the gap is worth a reviewer's try.
- The verifier runs close to its limits. Each of its three inputs uses about 94% of its op
  budget as BCHN counts it, and an input can be the full 10,000 bytes allowed. For about 1
  statement in 25, input 0 reaches that size first and keeps at least 5.88% of its budget.
  BCHN v29 counts exactly what the prover assumes: the lowest margin measured on it was 5.881%.
  Both figures were measured on the earlier template, on 2026-11-13 and 2026-11-14. On the one
  that ships, `test:verifier-sizing` spends the production proof at BCHN's op cost on a
  patched libauth, and BCHN v29 takes the withdrawals `test/real-node.ts` sends.
- Anyone can change a pool transaction's txid before it confirms, though not what it does.
  MimcHash drops a fourth push it never reads, the satoshi coin takes its `OP_IF` flag in
  more than one encoding, and the verifier takes a zero pad of another length or a
  re-randomised proof. The 2026-11-17 bytecode audit found three more in the VM: the state
  record takes flag 4 where the SDK sends 1, a return index of −2 is taken where the SDK sends
  −1, and `withdraw` takes a 65th nullifier sibling. The client never keys on a txid. A
  deposit is confirmed by its note in the pool. A withdrawal is paid once the pool's Withdraw
  history holds its nullifier hash, in a transaction that pays the recipient one
  denomination, and the pool's state has the nullifier spent. One mined under another txid
  shows as paid, under the txid that landed.
- A withdrawal carries no signature, so whoever relays it can rebuild it, and keep what its fee
  holds above the relay floor (`PRODUCTION.md` gives the amounts). The proof fixes the
  recipient and the pool the denomination. In a token withdrawal the rebuilder can also take
  some of the recipient coin's satoshis: the pool pins that coin's lock, asset and amount, not
  its satoshis, so a rebuilt withdrawal can open it at the 663-sat dust floor and keep about
  540 sat more (the 2026-11-17 bytecode audit, in the VM).
- Anyone can pay a coin to the verifier's lock or the hashing coins' lock, and an unconfirmed
  one vanishes, with what was built on it, if its maker double-spends it. The client spends
  first the coins its pool's own transactions made, confirmed or not, then confirmed coins in an
  order of its own pool's, and a stranger's unconfirmed coin, another pool's included, only when
  the others are too few (`coinsAt` in `web/src/pool-client.ts`). A coin paid to either lock
  with a token on it can be spent too, and its token is burned (the 2026-11-17 bytecode audit,
  in the VM). That does not reach a pool: a deposit refuses a transaction holding such a coin,
  and the client passes over coins with tokens.
- A commitment can be deposited twice, and the pool takes both (the 2026-11-17 bytecode audit,
  in the VM). The note withdraws once, and the second deposit stays in the pool for good: the
  pool keeps no list of commitments. The client makes a new note for every deposit.
- Every result in `PRODUCTION.md` came from this project's own tools and reviews. Two
  adversarial reads found serious bugs after every suite had passed, so expect more.

## How to run it

```bash
npm run check                                                 # the artifacts match the source
npm test                                                      # that, and the suites, with real proofs
scripts/regtest.sh up && npx tsx test/real-node.ts; scripts/regtest.sh down
                                                              # BCHN and Fulcrum, relay policy on
npm run test:app                                              # a new chain, the production build, the page
npm start & APP_URL=http://127.0.0.1:8787/ npm run test:ui    # the page in a real browser, on your chain
```

The verifier's red-team suite is in `service/verifier/README.md`. `contracts/test/griefing.ts` is the
pattern for a new attack: the SDK's own transaction with one thing changed, judged by the VM.

The compiler and SDK are SolidCash 0.51.1 from npm, whose version `npm run check` prints, and
the verifier is vendored in `packages/verifier`, whose README names its commit, and the circuit
and proving key are in `web/public/prover`, so the build needs no other checkout. With a
`tornado-core` checkout, `npm run check` also extracts the verifying key from its
`Verifier.sol` again; without one it holds the keys to their pinned hashes.
