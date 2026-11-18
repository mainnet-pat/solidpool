# Production

**Status: ready for an independent review and the real wallet test. Not ready for mainnet
funds.** The design is complete, and it runs end to end on a local chain, on an unmodified BCHN
in regtest and in a real browser on the production build. Chipnet has no factories yet: the
pools once listed in `deployments/chipnet.json` predate the current contracts, and a chipnet
deployment is `npm run deploy -- chipnet` (see Deploy). Mainnet is blocked by the
review below, which no amount of testing here replaces.

## Chain servers

**Run your own Bitcoin Cash node and Fulcrum, and tell the page's users to run their own too.**
Make it the first server of each network the page offers (`MAINNET_TRUSTLESS_FULCRUM_URL`,
`CHIPNET_TRUSTLESS_FULCRUM_URL`), which reads the chain and decides which pools exist, and the
indexer's. The second (`_TRUSTLESS_BROADCAST_URL`) takes
withdrawals, and comes from another operator, so that no one server sees both a wallet and its
withdrawal (see "Run or name two Fulcrum servers" below). On mainnet and chipnet, production
takes only `wss://` servers.

- **This release reads from one server, and trusts it.** The page takes that server's word on
  which pools the factories made. A server that lies can list a pool made outside them and
  drain what is deposited into it. With your own server that trust stays with you, whom the
  page's users already trust with its code; a public server hands it to a stranger.
- **Every server learns its visitors.** It sees each visitor's IP address and what the page
  reads for them: their coins, the pools they use, their deposits and withdrawals.
- **Cluster mode comes straight after this release.** The reads that decide which pools to
  trust will go to several servers at once, through rpckit's cluster transport
  (`@rpckit/cluster`, an m-of-n quorum), and an answer will count only when enough of them
  agree, so a lie will need several operators. In exchange, every server in the cluster will
  learn each visitor's IP address at once. Choose cluster servers you would trust with that,
  and keep telling users to run their own node and Fulcrum: nothing else keeps both the pool
  list honest and their address private.

## What was verified

| Check | Result |
|---|---|
| Both pools on unmodified BCHN v29 with public relay policy, through a real Fulcrum, with real production-key proofs | passes |
| Both pools on public chipnet (`deployments/chipnet.json`), a note deposited, hashed and paid in each through the app's own client | passed, on contracts older than these; deploy them again for this build |
| Both pools in a real browser on the production build, proof in the page | passes |
| `deploy-factories.ts`, `deploy.ts` and `verify-deployment.ts`, run as a deployer runs them, on a real node | deploy both factories and two pools through them and pass all four as soon as they are seen, the pools still in the mempool; refuse pools before factories, factories twice and a bad plan. Run again with the same plan, `deploy.ts` skips the pools the file has: the next row |
| The same scripts stopped part way and run again, on BCHN regtest (2026-11-17) | `deploy-factories.ts` makes only the factory still missing, at the next free identity slot; `deploy.ts` skips the pools the file has and records one the factory made already; each refuses a server of another chain, a malformed key without printing it, and a plan whose id or amount the file has for another pool |
| `npm run deploy -- regtest --server … --key-file …`, run as an operator runs it, on BCHN regtest (2026-11-18) | with the key a WIF in a file only its owner reads, it finishes a run that stopped after the BCH factory's genesis went out: it adopts that factory, makes the token one, and passes `verify-deployment.ts --write-web` at once, both geneses still in the mempool. It makes no pool: the file lists none, and neither factory has a `PoolCreated`. Run again, it does nothing and spends 0 sat. Before anything connects it refuses an unknown network, regtest without `--server`, a WIF or 64 hex digits on its command line without repeating them, and mainnet without `CONFIRM_MAINNET=1` (`test/deploy-scripts.ts`) |
| A pool created from a wallet the page holds no key for, such as Cashonize or WalletConnect (`deployer.test.ts`) | the wallet signs the naming coin, the creation and the shared-coin top-up, each by name, on SolidCash 0.51.1; 0.51.0 refused every such creation before broadcasting it |
| The factories: a second pool of an amount, or of an asset and amount | refused by the client before anything spends (mock and real node), and by the factory's own code when sent anyway, whatever path the caller claims for a token slot (mock) |
| A factory's creation changed one way at a time (`deployer-genesis.test.ts`): a plain coin for the deployer coin, the factory's state recording a second amount, no `PoolCreated` or a second one, an event naming another pool, no pool master or a second one, the state record or satoshi coin paid elsewhere, a satoshi coin of 600 sat or a second one, the author's coin replaced | each refused by the chain; the honest coin of 1,201 sat taken |
| A factory's creation with one more NFT of the factory's own category (`deployer-outputs.test.ts`), on both factories: a `PoolCreated` naming another pool at a bare `OP_1` lock, at the event's address, at the builder's or at `OP_1 OP_NOP`; one with no commitment at `OP_1` or at the builder's; an SCID anchor's shape; a second minting NFT or a mutable one. And the audit's pool made with no factory, carrying such a `PoolCreated` | each refused by the factory itself. Before it refused them, SolidCash's census let the chain take a `PoolCreated` at `OP_1`, both with no commitment and the anchor's shape. The pool made with no factory has nothing to carry: the creation that would mint its `PoolCreated` is refused |
| A commitment of 1 or 128 bytes on a creation's factory master, or on the new pool's master (`deployer-outputs.test.ts`), on both factories | refused: the factory's master by its own `create`, the pool's by `Deploy<C>`. Every master's commitment stays empty, which the pools' and factories' own code holds on chain |
| A squat: a creation the chain takes and the genesis check refuses, which would leave its amount without a listed pool for good. 12 shapes on the BCH factory and 20 on the token factory: extra tokens of the new category, the master paid away or changed, the state record changed, a token on the satoshi coin, the token coin changed, missing or doubled | the chain refuses all but a token coin opened with more than one unit, which the check takes too, since the pool asks only for at least one |
| A factory's own genesis: a hidden second master, a state record that says a pool was made, a second identity anchor or another NFT of its category | found by `verify-deployment.ts` and the indexer |
| The indexer on a real node, given only factory categories: the factories' pools, a stranger's NFT of its own category at an event address reading as a `PoolCreated`, a category that is no factory | lists the three pools the factories made and nothing else; takes no candidate from the NFT; reads nothing through the category |
| The hashing and verifier coins every pool shares, swept: as a lone input 1,440 blocks old, and a block early, beside another input, in a version 1 transaction, with the relative lock off, or as a verifier input of a withdrawal | taken alone and on time; every other shape refused, the age by BCHN itself |
| Attacks on the contracts: stolen proof, proof over a made-up tree, replay, stale root, forged hash, fake worker, drained coins, non-canonical commitment | all refused |
| The verifier's own red-team suite on the shared 3-input build (groth16_cashscript `2aa8ddd`), with a 3-input test key | 163 runs, 0 accepted, and its sweep checks pass |
| Recipient attacks in that suite: changed, aliased, swapped, from another proof | 13 of 13 refused |
| Every kind of witness byte, every composition rule and every shape of the sweep, with a real production-key proof (`service/verifier/tamper.ts`) | 44 of 44 refused: 31 witness bits, 6 composition rules, 7 sweeps |
| An independent AI audit of the verifier on 2026-11-13, by a Claude agent on the Fable model (`service/verifier/AUDIT-2026-11-13.md`): the key against Tornado's, every baked constant, the equation for any input, the composition, encodings and limits. It read the template of then, sha256 `37c8b9ec…`, before every pool shared it; of the one that ships, `7b513096…`, only the next row's audit read the changes | no soundness break; its findings fixed or written down |
| An AI audit of the compiled contracts and the shipped verifier template at `9ceafd7`, on 2026-11-17, by a Claude agent on the Fable model (`contracts/AUDIT-2026-11-17.md`): the pools, `MimcHash`, the factories' `create` and `Deploy<C>`, read in the compiled code and tried in the VM, and what the template changes from `37c8b9ec…`. Not the pairing arithmetic, which is byte for byte the same, the op-cost margins or BCHN | no way to take funds, forge a withdrawal, spend a note twice or stop a pool for good; one way to forge a factory's `PoolCreated` records, which `create` refuses since `7da7067`, a change no audit has read; its Low and Info findings written down in `AUDIT.md` |
| Forged withdrawals on the production key with every commitment rebuilt (`service/verifier/forge.ts`): another payee, nullifier hash or root, a changed proof point, a false state in each role, B outside G2, 21 encoding aliases | each refused at its own guard; a re-randomised proof is accepted, as Groth16 allows |
| The verifier on BCHN v29 itself, beside a real pool on regtest: every tamper, forge and real-proof case (`service/verifier/CHECKS-2026-11-14.md`, on the template `37c8b9ec…`) | all 179 judged as libauth judges them, at relay policy, in consensus and in mined blocks; the op cost is what the prover assumes, and the lowest margin is 5.881% |
| The verifier's bytecode against the math: the exact condition of every guard, and the outputs of every function (the same checks, on `37c8b9ec…`) | all match the spec: 219 symbolic proofs, a randomized proof of the loop step, and 167,325 single-function tests |
| The key against Tornado's ceremony and Ethereum: the circuit recompiled, all 1,114 contributions verified, and the verifier Tornado's ETH pools call | the same key; where phase 1 came from can no longer be checked |
| The verifier's fillers sized and spent on a libauth patched to charge `OP_DEFINE` bodies as BCHN does (`test:verifier-sizing`) | the same unlockings as on this project's libauth, accepted at BCHN's op cost |
| SolidCash 0.51.0's release review: 70 rules the pools' and deployers' sources and docs state, against the code 0.51.0 compiles. It read the contracts on the morning of 2026-11-16, before `b16443b` made the factories unique and the hashing and verifier coins shared, so it does not cover the contracts that ship | 67 enforced; one narrower than its wording (T9, in `AUDIT.md`); two rest on the verifier |
| Griefing: a token on a pool coin, a grown master | refused |
| The token coin: a keyless step taking its satoshis, an NFT hung on it, a coin paid in at or under its dust floor, one holding an NFT, an NFT no script can see | refused, passed over or carried, the first and third on a real node too |
| A pool's money spread over coins: a deposit into a coin paid in that holds less than the pool owes, a coin holding a token put in the satoshi coin's place | refused |
| A miner's reward paid to a pool's locks | skipped, on a real node |
| A dishonest genesis: a hidden master or state record, a forged event, a fungible supply, a made-up state, a missing, extra or wrong satoshi or token coin, any of them opened too small | found by `verify-deployment.ts` |
| A factory's creation: the state record or satoshi coin paid elsewhere, a satoshi coin of 600 sat, a second one, a `PoolCreated` naming another pool | found by `verify-deployment.ts`, and refused by the chain too |
| History padded past a server's `max_history` (`history-reach.test.ts`, on a Fulcrum stand-in at its lowest limit, 1,000): the deployer-coin lock every pool of a kind shares, the deployer's own address, a factory's event address, a pool's event addresses, and a stranger paying a pool's locks before its creation | every genesis, the factory's pools and the pool's notes still read, by txid; where only a cut history could answer, the server's limit is reported as such, never as an invalid pool or an empty list |
| A forged `PoolCreated`: minted at a bare OP_1 lock in a creation and paid to the event address, or paid there in the genesis of a pool born with no factory (bytecode audit, 2026-11-17, run in the VM) | not listed by `factoryPools` or the indexer, the pool refused by `genesisProblems`, and the token factory's tree rebuilt as the factory holds it |
| The page's engine behind lying servers: a dropped broadcast, a denied one, a hidden or held deposit, a withdrawal listed but not in the state shown, two servers that disagree | says only what it knows, and never signs a note twice |
| The page's engine on races: a note paid elsewhere, a proof that fell behind, a pool that moved, a refusal in any words | correct outcome, or a rebuild |
| A withdrawal relayed with another txid, alone or ahead of the page's own | paid, under the txid that landed |
| A stranger's unconfirmed coin at the verifier's or the hashing coins' lock, sorting first | passed over for the pool's own |
| A payout to a lock the pool owns: its master, state record, containers, event addresses, hashing coins or verifier | refused before anything is proved |
| Which server hears what, with two | the second and its archive hear nothing of a deposit, and the wallet's server only one read of the pool's public state during a withdrawal |
| A `finish` that cannot go through | withdrawals still pay, and a deposit says nothing was sent |
| A griefing deposit, a junk coin, a forged or replayed record | refused or skipped, and the pool keeps working |
| The browser: a deposit waits for a saved note, a withdrawal refuses the connected wallet, another network and a plain address for tokens, and an injected handler does not run | passes |
| A plan: an id a note cannot carry, a payout under the dust floor, a malformed asset, two pools with one id | refused before anything spends |
| Tree edges: crossing level 10, the last leaf, a full tree | pass |
| Solvency: each pool coin holds exactly its notes | exact |
| The tree against the circuit: MiMC against circomlibjs, and a real proof of a contract-built root | pass |
| The longest proof the client makes | fits a token pool's prepaid fee with room to spare |
| The build: contract and verifier artifacts rebuilt from source, the keys against `Verifier.sol` | identical, and `npm test` refuses them otherwise |

## What blocks mainnet

1. **An independent human review of the contracts and the verifier.** `AUDIT.md` is the
   brief for it. A person reviewed the verifier's 2-input original. On 2026-11-13 an
   independent AI audit, by a Claude agent on the Fable model, covered the third public input
   and the composition with a pool, and found no soundness break
   (`service/verifier/AUDIT-2026-11-13.md`). It is not a human audit. What it could not
   check was done on 2026-11-14 (`service/verifier/CHECKS-2026-11-14.md`): the verifier on
   BCHN itself, its bytecode against the math, and the key against Tornado's ceremony. Both
   read the verifier's template before every pool shared it (8,212 B, sha256 `37c8b9ec…`). The
   template that ships (8,175 B, sha256 `7b513096…`) drops the brand that tied a verifier to one
   pool and adds the lone-input sweep. A second AI audit on the Fable model, on 2026-11-17
   (`contracts/AUDIT-2026-11-17.md`), read those changes against `37c8b9ec…`, though not the
   pairing arithmetic, which is byte for byte the same, and read the contracts as compiled at
   `9ceafd7`. It found no way to take funds, and one way to forge a factory's list of pools,
   which each factory's `create` refuses since `7da7067`. A second AI audit, also on 2026-11-17,
   read that change, the empty-master rule after it and the whole creation path
   (`contracts/AUDIT-2026-11-17-factories.md`).
   SolidCash 0.51.0's release review read the contracts before `b16443b` gave the factories
   their uniqueness and made the hashing and verifier coins shared, so it does not cover them.
   A human audit of the verifier is still advised before mainnet funds, and nobody outside the
   project has reviewed the contracts. Passing our own red-team suite is
   evidence for that review, not a replacement for it: a suite only finds what it tries.
   Adversarial reads of the finished work, after every suite here had passed, still found
   two ways to stop the app for everyone, a way for a deployer to steal, and several ways to
   lose or link a note in the page. A later read found a token pool could be stopped for about
   1,100 sat. They are fixed and in `contracts/test/griefing.ts` and `test/app-flows.ts`, and they
   are why this item stays first.
2. **A real wallet.** WalletConnect signing is tested through SolidCash's external-signer
   path with a simulated wallet, including one that declines, one that changes an output and
   one that signs with the wrong key. It has not met a real wallet app, and until a review
   read the code, every real wallet would have failed: the simulated one never ran the code
   that reads a session's address. That is fixed, and tested on the formats Cashonize and
   Paytaca send, but only a real wallet on chipnet settles it.
3. **Name clearance.** The name is SolidPool, set in `web/src/brand.ts`. Searches found no
   crypto project of that name, but a lawyer should check trademarks and domains, and whether
   the pool should share a name with SolidCash, SolidSwap and SolidPeer.
4. **Legal advice.** Regulators treat this category of software seriously, and the developers
   of similar software have been prosecuted. Take advice before launching, and have the
   Terms in the app reviewed: a developer drafted them, and they state facts about fees and
   control that must stay true.
5. **The pool factories.** Every pool is made through one now, and the factories' on-chain
   uniqueness and the creation's soundness rest on SolidCash 0.51's `Deploy<C>` and the
   compiled `new`, 0.51.1 here. Before 0.51.0, `Deploy<C>` let anyone spend a deployer coin without its
   author's coin, took a creation that paid the state record or satoshi coin elsewhere, opened
   the satoshi coin at 600 sat or opened a second one. 0.51.0 refuses those creations, and the
   tests here change a creation every way listed above, but, as its changelog says, it has had no
   outside audit. Its census of a contract's own outputs also passes over an immutable NFT of
   the contract's category at a bare `OP_1` lock, which let a creation mint a `PoolCreated`
   naming any pool, so each factory now refuses every output of its category but its master,
   its state record and its event; SolidCash is to close the census itself. Nor does it keep a
   master's commitment in a function that touches state, so `create` requires its master's to
   be empty, as every master's is.
   `verify-deployment.ts` and the indexer still check every creation, and each factory's
   genesis, off chain.

## The real wallet test

On chipnet, with each wallet people will use. Cashonize and Paytaca are the two the code was
written against. A failure at any step blocks mainnet.

1. Pair by QR code, and check the address shown is the wallet's own.
2. Deposit into a BCH pool. The wallet must show the amount and the prompt, and sign without
   broadcasting: the page sends it, so the transaction appears once.
3. Refuse a deposit in the wallet. The page must say nothing was sent, with the note kept.
4. Deposit into a token pool from a coin under 1,500 satoshis.
5. Withdraw each note to a new address, the token note to a token-aware one.
6. Change address in the wallet, and check the page follows.
7. End the session from the wallet, and check the page notices.

## Before a deployment

- **Choose denominations.** A pool's denomination is a power of ten, which its contract
  takes as an exponent and its constructor bounds: 0.01 to 100 BCH, or 1 to 10^12 units of
  a token. A note costs about 220,000 sat, so 0.1 BCH and up make sense.
- **Mind the fee margins.** The fees are constants in the contracts, sized for a 1 sat/B relay
  floor. A finish pays about 1.02 sat/B, a BCH withdrawal about 1.04, and the longest token
  withdrawal the client makes about 1.03. Past those a step no longer relays by itself, but
  the pools take a coin added only to pay the difference. The client adds one as the last
  input of a finish, or just before a withdrawal's verifier coins, with its change back, and
  `contracts/test/pool.ts` and `token-pool.ts` have the VM judge both. The app reads the floor
  from its Fulcrum server and takes its word up to 5 sat/B, so a hostile server cannot name any
  fee it likes. When a withdrawal falls short, it stops before sending anything and offers to
  pay the difference from the connected wallet, whose coin then shows in the withdrawal. When
  the note's own hashing is still waiting and falls short, that step is offered on its own, to
  be paid from the wallet that made the deposit: whoever pays it is tied to that deposit, so a
  withdrawal's fee wallet never pays it. Nothing is paid unasked, a wallet that refuses is not
  asked again, and the page pays no more than about what it showed. `test/app-flows.ts` runs
  this at 2 sat/B. A deposit's fee is SolidCash's to set, and SolidCash 0.51.1 builds at
  1 sat/B whatever the node asks, so past that floor the app refuses deposits until SolidCash
  takes a floor. A compiler change that grows a contract narrows these margins and must be
  measured again: `npm test` fails if a fee no longer covers its step.
- **Run it in Docker, behind nginx, over TLS.** The app speaks plain HTTP. Run the app and the
  indexer from their images with `docker-compose.yml`, one profile per chain: `web/Dockerfile` for
  the app, Next's standalone server, and `Dockerfile` for the indexer. Each runs as `node` on a
  read-only file system with no capabilities, no package manager and none of the development
  packages, from a base image pinned by digest. The compose file publishes no port to the host or
  the internet: nginx on their `solidpool` network is the only way in, with TLS and an
  `X-Forwarded-For` the indexer counts its clients by. Both listen on every interface of their
  containers for nginx to reach. The app's `next build` runs with no network in its image build,
  so it fetches nothing; it checks the settings' form from build arguments, and the server checks
  everything again as it starts, the servers and factories included. The app sends HSTS, but on a plain connection anyone
  on the path can change the page, and a note typed into a changed page is gone.
- **Run or name two Fulcrum servers, from different operators,** for each network you offer.
  Its `_TRUSTLESS_FULCRUM_URL` serves wallets and its `_TRUSTLESS_BROADCAST_URL` takes
  withdrawals, with `include_tokens` and a
  WebSocket port, both `wss://`: a page reads mainnet and chipnet over TLS only, from the
  servers configured here and from any a person names in Settings, so nobody on the path can
  rewrite an answer. Each runs Fulcrum 1.10 or later, which answers
  `blockchain.scripthash.get_first_use` for the genesis checks (Fulcrum added it in 1.9.6): a
  production build and server stop
  without them, at one that runs anything older or follows another chain, and at one they cannot
  ask, since what was not checked is not used; a person can name
  others in Settings, held to the same. A network is offered only with both its servers and both
  its factories named, each checked the same way, and a production server falls back on no
  public one.
  A server cannot move money out of a pool, but one that lies about the chain
  can show a pool made outside a factory as one of the factory's, and what is deposited there
  can be taken (see the README's "Trust"), and one server alone can show a page a pool of its
  choosing and learn from the proof whether a note is in it. With two, a proof is only made once
  both agree on the roots, and a
  withdrawal goes through the second from its first read to its broadcast, so neither sees
  both a wallet and its withdrawal. The app runs on public servers' default limits, and a server
  of your own keeps the same ones; what a padded lock can still hide, and the remedy, are below
  ("Anyone can pad a lock's history"). Run
  `verify-deployment.ts` against a server of your own.
- **Keep no access logs.** Fulcrum, the indexer and the prover routes each see an address
  arrive at a moment that can be matched to a chain event, which is what this app exists to
  prevent: a page that a person set to the Fast indexer reads it when it opens and again right
  after each deposit, and after each withdrawal too when one server takes both sides. Pages read
  Trustless by default and never ask the indexer. The indexer writes no access log; keep
  its proxy's off too. Serve the prover's files from a CDN with `NEXT_PUBLIC_CIRCUIT_URL` and
  `NEXT_PUBLIC_PROVING_KEY_URL`: the first fetch marks a browser's first withdrawal, and they
  are 34 MB a time.
- **Publish the source of what you serve.** The page as served is conveyed under the GPL-3.0
  (README's "Licence"): its foot links "Source" to `SOURCE_URL` and "Licences" to
  `/licenses/NOTICE.txt`, which every build writes with the licence texts beside it. The operator
  of a deployment keeps that true:
  - Point `SOURCE_URL` at the commit or tag the deployed build was made from, in a public
    repository, and keep it available for as long as that build is served. A build of another
    commit needs its own.
  - Keep the GPL-3.0 packages' sources available at the versions the lockfiles pin, which
    THIRD_PARTY_NOTICES.md lists under "Corresponding Source". They live on others' servers, the
    tornadocash repositories on GitHub and the npm registry, so mirror them, for example beside
    the source `SOURCE_URL` names.
  - Remake the inventory after any dependency change, before that build is served, and commit
    what it writes: `npm run notices` (`scripts/notices/`). It builds `web/` and the indexer's
    bundle as the images do, reads what each ships, and writes `LICENSES/third-party.txt` and the
    generated blocks of THIRD_PARTY_NOTICES.md. It takes one to two minutes. It builds into
    `web/.next` and removes that build afterwards, since it used placeholder settings, so it will
    not start while `web/.next` exists: stop any dev server and remove the folder first, or run it
    in a worktree of its own. It needs the network only the
    first time, for the licence texts it keeps in `scripts/notices/.cache/`. It stops where a
    prebuilt file it reads has changed (`scripts/notices/config.json`), until that file's contents
    are reviewed there. Both files it writes name the hash of the lockfiles and `config.json` they
    were made from, and `npm run notices:check`, the first step of `npm test`, fails while that
    is not the hash of the ones the repository holds: it reads no network and builds nothing.
- **Publish the output of `verify-deployment.ts`.** A pool is only as honest as its creation,
  and a factory as its genesis, which spends the deployer's own coin, so no contract sees it. A second master hidden there
  could later pay out real proofs of a tree of its own. The script reads the genesis and
  refuses anything but the master, the state record, SolidCash's BCMR identity and the pool's
  own coins, opened at the size each needs for good. It takes a genesis as soon as the server
  shows it, in the mempool or in a block, as the app's server and the indexer do: the user
  decided on 2026-11-18 that nothing waits for blocks to bury one. Until they do, a factory's
  deployer could still spend the same coin in another genesis, with a second master, under the
  same category, and a run a few blocks later shows that nobody did.

## Deploy

```bash
# chipnet first, and leave it running. One command deploys a network: its two pool factories, a
# float of the hashing and verifier coins every pool shares, the check of both against the source,
# and, at the end, the settings that name them. It asks for the deployer's key, a WIF, once its
# server has passed its checks, and shows nothing as it is typed. For a run with no terminal, name a
# file only you can read instead: --key-file ~/chipnet.wif (or DEPLOYER_KEY_FILE), after chmod 600.
# The key is never taken from the command line or the environment, where the shell's history, the
# list of processes and every process the shell starts would keep it, so anything of a key's form
# on the command line is refused, and so is DEPLOYER_KEY. Without --server it reads the network's
# first public Fulcrum server, the one the page's Settings start on; name a server of your own. It
# makes no pool: pools are made from the page's Create pool. Run again, it does only what a run
# that stopped left, and once everything is done it spends nothing.
npm run deploy -- chipnet --server wss://... --key-file ~/chipnet.wif

# Its two steps, which also run alone. The factories and the float: this writes
# deployments/chipnet.json with each factory's category and PoolCreated address as it is made, and
# refuses a file that names both already: a factory's category never changes. It writes each
# factory's category, the txid of the coin its genesis spends, before the genesis goes out, so a run
# that stopped anywhere can be run again: it adopts a factory whose genesis went out, makes one
# whose genesis did not from the same coin, and makes only what is still missing.
POOL_NETWORK=chipnet FULCRUM_URL=wss://... npx tsx scripts/deploy-factories.ts
# The check, as soon as the server shows the geneses: nothing waits for blocks. --write-web copies
# the file to web/deployments/chipnet.json, which the page bundles, only once every check passes.
# The page trusts the factories it names, and lists its pools only once it reads that they made them.
FULCRUM_URL=wss://... npx tsx scripts/verify-deployment.ts deployments/chipnet.json --write-web

# Pools from a plan, for rehearsals and tests; pools are made from the page's Create pool. Each
# factory refuses a second pool of an amount, or of an asset and amount, on chain. Run again after
# a stop with the same plan, it skips the pools the file has and records one the factory has made.
POOL_NETWORK=chipnet FULCRUM_URL=wss://... npx tsx scripts/deploy.ts deployments/chipnet.plan.json

# The indexer follows the factories: their categories are its only pool configuration. It reads a
# Fulcrum server of your own (.env.example) and publishes no port: nginx serves it.
CHIPNET_BCH_FACTORY=<category> CHIPNET_TOKEN_FACTORY=<category> CHIPNET_INDEXER_FULCRUM_URL=wss://... \
  docker compose --profile chipnet up -d --build

# The app, from its image, beside the indexer: the chipnet profile builds and starts both. Its
# settings are in the same .env (.env.example lists them as CHIPNET_TRUSTLESS_FULCRUM_URL and so on,
# and mainnet's as MAINNET_): each app is given both networks' settings, offers each one they set
# up, and opens on its profile's own. The build checks their form, and the server checks them again
# as it starts, asking every server it is given what it runs and which chain it follows, and
# reading each network's factories' geneses.
docker compose --profile chipnet up -d --build

# Or, outside a container, with the app's settings (web/.env.example) in the environment or in
# web/.env.production: build once, then start; a start never builds. This offers chipnet alone;
# mainnet's four MAINNET_ settings beside these offer mainnet too.
POOL_NETWORK=chipnet CHIPNET_TRUSTLESS_FULCRUM_URL=wss://one... CHIPNET_TRUSTLESS_BROADCAST_URL=wss://two... \
  CHIPNET_BCH_FACTORY=<category> CHIPNET_TOKEN_FACTORY=<category> WALLETCONNECT_PROJECT_ID=<id> \
  SITE_URL=https://pools.example CHIPNET_INDEXER_URL=https://indexer.pools.example \
  SOURCE_URL=https://github.com/<owner>/<repository>/tree/<commit> npm run build:prod
npm run start:prod
```

**On Vercel**, set the project's Root Directory to `web`. The page imports packages that the
repository root's `package.json` declares (SolidCash, libauth, websnark, WalletConnect, qrcode), so
`web/vercel.json` installs the root's dependencies and then `web/`'s, as `web/Dockerfile` does, with
no install scripts. The app's settings are the project's environment variables, under the names
`web/.env.example` gives them; the build checks them and asks the servers, as `npm run build:prod`
does, and each server instance checks them again as it starts. Point `SOURCE_URL` at the commit
Vercel builds.

The deploy command asks for 100,000 sat in plain coins at the deployer's address before it makes
a factory, and no token. On a network with none of the shared coins yet it spends about 40,300:
12,946 sat for the two geneses and 27,329 for the float of 20 hashing and 6 verifier coins with
its fee, measured on the mock with the SDK's own transactions. Chipnet had none of them on
2026-11-18. Run again once everything is done, it spends nothing. A plan for `deploy.ts` is
`{ "pools": [{ "id", "kind", "name", "symbol", "decimals", "denomination", "asset"? }] }`, and it
is checked whole before anything spends. An id is lowercase letters and digits, because notes an
older page wrote carry it and archives are read by it. For a token pool the key needs a coin of
the asset: the script makes the one-unit coin a token pool opens with, holding at least 1,200
sat, which stays in it for good. Every script that spends, the deploy command too, needs
`CONFIRM_MAINNET=1` on mainnet. Every script, `verify-deployment.ts` too, reads mainnet and chipnet over `wss://`, or over
`ws://` only from this machine or its private network, and refuses a server that does not follow its
network: by the genesis, and by a block past the network's last split, since chipnet shares
testnet4's genesis and BTC, BSV and eCash share mainnet's. One that spends also refuses a node
whose relay floor is above the 1 sat/B these transactions pay, and never prints the key, which
it takes from its prompt, from `--key-file` or from `DEPLOYER_KEY_FILE`, and never from the
command line or the environment.
`.env` files are ignored by git. After a quiet spell with no withdrawal anywhere, the verifier
coins can be swept: `scripts/top-up-sidecars.ts` adds them again.

| Setting | Purpose |
|---|---|
| `POOL_NETWORK` | Required: the network a fresh page opens on, `mainnet` or `chipnet`, written exactly so, and one the deployment offers. A person can choose another offered network in Settings. `local` is the devnet, which a production server runs only with `DEVNET_ENABLED=1`. |
| `MAINNET_TRUSTLESS_FULCRUM_URL`, `MAINNET_TRUSTLESS_BROADCAST_URL`, and the same with `CHIPNET_` | Required for each network the deployment offers: its two Fulcrum servers, `wss://`, from different operators: the first for reads and deposits, the second for withdrawals. Each serves its own network only. |
| `MAINNET_BCH_FACTORY`, `MAINNET_TOKEN_FACTORY`, and the same with `CHIPNET_` | Required for each network the deployment offers: the categories of its two factories, which the page indexes its pools from. `web/deployments/<network>.json` must agree once it names them. |
| `MAINNET_INDEXER_URL`, `CHIPNET_INDEXER_URL` | Optional: a network's indexer, for a fast first paint. The server reads its pool list and every browser its archive, so it is a public `https://` URL. |
| `TRUSTLESS_FULCRUM_URL`, `TRUSTLESS_BROADCAST_URL`, `BCH_FACTORY`, `TOKEN_FACTORY`, `INDEXER_URL` | The same five settings of `POOL_NETWORK`'s network, under the names a deployment used when it named only that one, and the indexer's names for its factories. Where a setting is set under both names, the two must name the same server, factory or indexer, or production stops. |
| `WALLETCONNECT_PROJECT_ID` | Required: the deployment's own WalletConnect Cloud project, with its domain allowed there. `next dev` and the devnet use a shared public one. |
| `SITE_URL` | Required: the public `https://` origin the deployment is served at, which link previews point to. |
| `SOURCE_URL` | Required: a public `https://` address serving the exact source of this build, such as its commit or tag in a public repository. The build bakes it into the page, whose "Source" link and `/licenses/NOTICE.txt` name it, and a server started with another stops. Build and start with the same value. |
| `BCMR_SERVICE_URL`, `WALLETCONNECT_RELAY_URL` | Optional: the token metadata service (`https://`, Paytaca's by default) and another WalletConnect relay (`wss://`). |
| `NEXT_PUBLIC_CIRCUIT_URL`, `NEXT_PUBLIC_PROVING_KEY_URL` | A CDN for the prover's files, which are pinned by hash. |
| `DEVNET_ENABLED` | `1` offers the devnet in a production build: a test deployment with `POOL_NETWORK=local` only. A mainnet or chipnet server refuses it, and so does `start:prod`. The devnet's factories are its service's (`DEPLOYMENT_FILE`), and a page reads its chain from the service (`SERVICE_URL`, or `DEVNET_FULCRUM_URL` where browsers reach it at another address); none of the settings above applies to it. |
| `MAINNET_FULCRUM_URL`, `MAINNET_BROADCAST_URL`, `CHIPNET_FULCRUM_URL`, `CHIPNET_BROADCAST_URL` | No longer read: they named the other network's servers before each network had settings of its own. A production build or server that still sets one stops and names its replacement, `MAINNET_TRUSTLESS_FULCRUM_URL` and so on. |
| `APP_HOST`, `APP_PORT` | Where `start:prod` serves the app: every interface, port 8787, unless set. The image listens on every interface, port 8787. |
| `SOLIDPOOL_OFFLINE_BUILD` | `1` lets a build made with no network leave the servers to the start, which always asks them. The build still checks every setting's form. |
| `NEXT_TELEMETRY_DISABLED` | Next's anonymous telemetry stays off: the project's scripts set this to `1`, and so does `web/next.config.ts` for a bare `next build` or `next dev`. `web/next.config.ts` also turns off Next's upgrade checks (`experimental.agentUpgrade`), which ask the npm registry whatever this says, and the `.npmrc` files npm's own version check. |
| `ARCHIVE_URL`, `BROADCAST_ARCHIVE_URL` | Not read by this build: a page reads history from its Fulcrum servers, and its first paint from its network's indexer (`_INDEXER_URL`). |

A production server offers each of mainnet and chipnet that its settings set anything for, and
only those, so one deployment can offer both. A network it offers is whole: its two servers and its
two factories, or the build and the server stop and name what it lacks. A network with nothing set
is not offered, and `POOL_NETWORK` must name one that is. Only `next dev` and a devnet test
deployment fall back on public servers and the bundled deployment files, where nothing names others.

A production build checks these before it compiles, and a production server again before it
serves anything (`web/lib/settings-check.ts`). Each stops at a missing or malformed one, with its
name and what it needs (`web/lib/deployment.ts`, `productionProblems`), and at a configured server
that runs anything older than Fulcrum 1.10, follows another chain, or cannot be asked: one that is
down, misnamed, or out of reach of a runtime with no WebSocket, which is why both need Node 22 or
later. Each call to a server has 8 seconds of its own. A server then reads the genesis of each
factory it trusts, each offered network's two, through that network's first server, and holds it
to what `verify-deployment.ts` holds it to; `verify-deployment.ts` refuses a factory setting of the
deployment's network, `<NETWORK>_BCH_FACTORY` or `_TOKEN_FACTORY`, or the bare `BCH_FACTORY` or
`TOKEN_FACTORY` where `POOL_NETWORK` names that network, that names another factory than the deployment. A forgotten setting fails
closed instead of building or opening a page on a network, server, factory or WalletConnect
project nobody chose.
`next dev` and the devnet's own builds (`dev.ts --built`, `test:app`) use defaults.

A build made where no server can be reached, such as an image built with no network, sets
`SOLIDPOOL_OFFLINE_BUILD=1`: it still checks every setting's form, leaves the servers to the
start, and says so in a banner. The server built from it asks them as it starts, whatever that
variable says; nothing in its environment can tell it they were checked already.

The browser account and the faucet exist only on the local chain: a key in a web page is
for coins worth nothing. On every real network, chipnet too, a user needs a real wallet.

## Running it

- **Production runs the app and, optionally, the indexer.** A trustless page needs its two
  Fulcrum servers and the page, whose HTML carries its settings: it asks no path of the app
  under `/api`. A page that reads the indexer also asks `/api/config`, for the pools the app's
  server checked; the indexer only paints a page fast before it has read the chain. The app's
  image and `npm run start:prod` run nothing else: no service,
  devnet or faucet. The build fails while a required setting above is missing, and the server
  checks them all again as it starts. The devnet
  is offered only by a test deployment of `POOL_NETWORK=local` with `DEVNET_ENABLED=1`.
- **The app's server reads the chain.** `/api/config` serves a pool only once it has read,
  through its network's first server, that the network's factory made it, the deployment's
  own pools too (the README's "Which pools a page lists"). It keeps what it read and reads again
  each minute; while it cannot read, it serves only pools it checked before, and after a restart
  with the server down, none.
- **History grows.** The page reads a pool's history from its Fulcrum server, not from an
  archive. `ARCHIVE_URL` and `BROADCAST_ARCHIVE_URL` do nothing: `/api/config` has passed
  neither to the page since `6d71b70`. The archive of a network's indexer (`_INDEXER_URL`) only
  gives the **Fast indexer** view its first counts. A Trustless page load reads every withdrawal, at about
  39 kB each, and a deposit or withdrawal also reads every deposit, at about 89 kB each, and a
  server sends both as hex, at twice that. A first deposit into a pool of 1,000 notes reads
  about 89 MB, 178 MB as hex. A browser keeps each transaction it has read in IndexedDB, per
  network and server, so later reads fetch only new transactions. A new browser, a private
  window or another server starts over. A page's first read also hashes every note once,
  about 0.6 ms each on a laptop: 3 s at 5,000 notes and a minute at 100,000, with the page
  still responding. Later reads hash only what is new.
- **A deposit that loses a race has to start over.** A wallet's signature names the pool's
  coins, so a deposit that lands during a wallet prompt spoils it, and a note is never signed
  twice. The page says it may have gone through, and the person starts over with a new note.
  On a busy pool that will be common.
- **One deposit hashes at a time.** The next depositor's browser finishes the one before it
  and then goes. These are chained transactions, so none of this waits for a block.
- **Shared coins.** Every pool spends the same hashing and verifier coins, 1,000 sat each: ten
  hashing coins in a deposit and in a `finish`, three verifier coins in a withdrawal, each
  recreated as it was. The deploy command (`deploy-factories.ts`) and
  `scripts/top-up-sidecars.ts` top the two locks up to 20 and 6 coins, a pool creation up to 10
  and 3, and a deposit adds the hashing coins it needs from the depositor's wallet. A coin that stands unmoved for 1,440 blocks, about ten
  days, is anyone's to sweep as its transaction's only input. A verifier coin's sweep is 167 B,
  so whoever sweeps one keeps about 830 sat at 1 sat/B. A hashing coin's is about 8,100 B, which
  its 1,000 sat cannot pay at 1 sat/B. After a quiet spell with no withdrawal anywhere,
  withdrawals wait for a pool creation or the top-up script to add verifier coins, and the page
  says only to try again shortly. Run the script after such a spell.

## What stays open

- **Anyone can stop wallet deposits for as long as they pay to.** One move of the satoshi coin
  every 10 seconds, 510 B each and about 0.044 BCH a day, spoils each wallet's signature before
  it arrives; a move of the state record is 649 B. `contracts/test/griefing.ts` measures both. Funds and withdrawals are untouched.
  This launch accepts that. Closing it later means dropping the merge and read-only paths under
  `pragma satoshicontainer single`, or
  having the wallet pay into a coin of the note's own, which a keyless step then moves into
  the pool. The second also ends lost races, and with them most of the need to start over.
- **Anyone can move the shared coins and a factory's state record too,** the 2026-11-17
  bytecode audit found. Three verifier coins can be spent on their own with any valid proof
  over a made-up root, and recreated as they were, for about 30 kB of fee. A hashing coin can be
  spent beside any input with a true hash, for about 8 kB of fee a coin. Both were run in the
  VM. A factory's state record can be respent in place through its lock's flag-0 path, which
  keeps its commitment, lock, category and value; that was found by reading, not run. A move
  changes the coins' outpoints, so it spoils a deposit, withdrawal or creation in flight that
  spends them. The verifier and hashing moves cannot block for good, since anyone can pay fresh
  coins to either lock. The record move, like a pool's, can spoil creations for as long as
  someone pays.
- **Anyone can pad a lock's history,** at about 800 sat an entry. A client without an archive
  pays one fetch for each entry of an event's history, and a page shows `–` for counts it could
  not read in 5 seconds. About 1 BCH passes Fulcrum's default `max_history` of 125,000. Fulcrum
  counts the whole confirmed history before it looks at any height (`Storage::getHistory` in its
  `src/Storage.cpp`), so no paging gets past that, and past it the server answers as if the lock
  had no history. Nothing here reads that as no history:
  - a pool's genesis is found from its `PoolCreated` event's own transaction, from the first
    transaction at its coins' locks (`get_first_use`, which no limit stops), or from the
    factory's own chain read by txid, and a factory's from its identity's and state record's
    first transactions or the end of its chain. Only then is the lock a genesis spends from
    read, which for a pool is the deployer-coin lock every pool of its kind shares;
  - `factoryPools` and the indexer read a factory's events from its own chain, back by txid from
    the transaction that holds its master now, and the indexer reads each factory again at every
    block, since a server stops notifying an address past its limit;
  - a page whose event history comes back cut reads the pool's own transactions instead, back
    from its master, every one of them;
  - where only a history can answer, a cut one is refused as the server's limit (`HistoryLimit`),
    and the page asks for another server.

  What still stops a reader is coins paid to a lock whose coins it lists, at about the same
  price: past the limit Fulcrum lists only the lock's coins in its mempool, or none. Those locks
  are a pool's or a factory's master, state record and containers, and the verifier and hashing
  locks every pool shares. The shared ones are the cheapest target: one padding there stops
  every pool's withdrawals, or deposits, on that server. A list with no master, state record or
  pool coin (a plain coin at the satoshi lock, a coin of the asset at the token lock) while its
  lock has a first transaction, and an empty list at the verifier or hashing lock while the
  server's balance for it is not zero, are refused as the server's limit (`HistoryLimit`), so the
  page asks for another server rather than reporting a missing pool or too few coins. On servers
  that all keep Fulcrum's default limit, such a lock stays unreadable: junk paid to the verifier and
  hashing locks can be swept by anyone after 1,440 blocks, at a profit, but junk paid to a pool's
  master lock can never be spent, so that pool stays unreadable there for good. No funds move, and
  nothing can take them. The remedy is a server with a higher `max_history` (up to 25,000,000, set
  only in its config file), which anyone can stand up when it is needed. A server older
  than Fulcrum 1.9.6 has no `get_first_use`, so a history it cut cannot be told from an empty one;
  the app asks for 1.10 or later.
- **A note has no checksum.** A mistyped one reads as a note that is not in the pool. A note
  names its network, and a page on another refuses it before reading anything, but a note an
  older page wrote names none, so from another network it reads as valid until the pool is read.
- **The clipboard keeps a copied note** until something replaces it.
- **One server alone is trusted for privacy.** See above. A page could anchor the pool in
  block headers instead of a second server, but a pool's newest state is usually unconfirmed.
- **Other direct SolidCash contracts.** `pragma satoshicontainer single` refuses a token on the
  satoshi coin. A direct contract without the pragma does not, because closing that changes
  every such contract's container addresses.
- **The verifier runs close to its limits.** Each of its three inputs uses about 94% of its op
  budget as BCHN counts it. BCHN charges the bodies the code defines, which libauth does not,
  so the prover adds them when it sizes an input. An input can be the full 10,000 bytes: for
  about 1 statement in 25, input 0 reaches that size first and keeps at least 5.88% of its
  budget. That was measured on the template before the verifier was shared, and not yet on the
  one that ships. Measure again after any change to it.
- **Anyone can change a pool transaction's txid in flight.** MimcHash drops a fourth push it
  never reads, the satoshi coin takes its `OP_IF` flag in more than one encoding, and the
  verifier takes a zero pad of another length or a re-randomised proof. The 2026-11-17
  bytecode audit found three more in the VM: the state record takes flag 4 where the SDK sends
  1, a return index of −2 is taken where the SDK sends −1, and `withdraw` takes a 65th
  nullifier sibling. What the transaction does stays the same, and the client keys on no txid:
  a withdrawal mined under another one still shows as paid. Whoever relays a changed withdrawal
  first can also take what its fee holds above the relay floor, about 1,500 sat of a BCH
  withdrawal and 1,400 of a token one. A token withdrawal gives up about 540 sat more: the pool
  pins the recipient coin's lock, asset and amount but not its satoshis, so a rebuilt one can
  open that coin at the 663-sat dust floor (the same audit, in the VM).
- **Anyone can pay a coin to the verifier's or the hashing coins' lock,** and an unconfirmed one
  vanishes, with what was built on it, if its maker double-spends it. The client takes first the
  coins its pool's own transactions made, confirmed or not, then confirmed coins in an order of
  its own pool's, and a stranger's unconfirmed coin, another pool's included, only when the
  others are too few. A coin paid to either lock with a token on it can be spent too, and its
  token is burned (the 2026-11-17 bytecode audit, in the VM). A pool is not affected: a deposit
  refuses a transaction holding such a coin, and the client passes over coins with tokens.
- **A commitment can be deposited twice,** and the pool takes both (the 2026-11-17 bytecode
  audit, in the VM). The note withdraws once, and the second deposit stays in the pool for good:
  the pool keeps no list of commitments. The client makes a new note for every deposit, so
  only a hand-built deposit can repeat one.

## What would lower the cost

Hashing is 80% of a note's cost. In order of effort:

- **Batches.** Hashing four notes together costs 21 hashes, not 80, about a quarter of the
  cost, but a note then waits for three others, or pays to close the batch early.
- **A deposit circuit.** A second Groth16 proof of the tree update would cost about 30 kB in
  place of 175 kB. It needs a new trusted setup ceremony, which this design avoids.
