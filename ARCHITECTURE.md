# Architecture

```text
                    ┌─────────────────────────────────┐
                    │             browser             │
                    │  ledger UI · engine · prover    │
                    │  PoolClient · SolidCash SDK     │
                    └───────┬───────────────┬─────────┘
                 Electrum   │               │ optional, checked
                            ▼               ▼
                    ┌──────────────┐  ┌───────────────┐
                    │ Fulcrum/node │  │ indexer or    │
                    │ your choice  │  │ service       │
                    └──────┬───────┘  └───────────────┘
                           ▼
    ┌────────────────────────────────────────────────────────────┐
    │ BCH 2026 VM                                                │
    │ BchPool / TokenPool · MimcHash coins · verifier coins      │
    └────────────────────────────────────────────────────────────┘
```

## The transactions

Input 0 is always the pool's master. Every input and output below is built by SolidCash.

**Deposit**, signed by the wallet. Ten inputs each prove one hash of the note's first 10
levels, and each is recreated at its own index. A wallet's first coin sits level with the
event, its token coin with the output that returns that coin's satoshis, and any more
coins go after the hashing coins, level with the change. The pool is then locked to new
deposits until `finish` has run:

```text
in   master · state record · satoshi coin · [token coin] · wallet coin · [wallet token coin] · MimcHash × 10 · more wallet coins
out  master · state record · satoshi coin · [token coin] · Deposit event · [token coin's return] · MimcHash × 10 · change
```

**Finish**, unsigned and prepaid, so anyone can run it and the wallet never sees it. It hashes
the other 10 levels, publishes the root and lets the next deposit in:

```text
in   master · state record · satoshi coin · MimcHash × 10
out  master · state record · satoshi coin · MimcHash × 10
```

**Withdraw**, unsigned and prepaid. The last 3 inputs are the verifier and the last 3
outputs recreate its coins:

```text
in   master · state record · satoshi coin · [token coin] · verifier × 3
out  master · state record · satoshi coin · [token coin] · recipient · Withdraw event · verifier × 3
```

## Contract state

Six fields in one NFT commitment of about 100 bytes:

| Field | Meaning |
|---|---|
| `recentRoots` | sha256 of the last 8 roots, oldest first. The roots are witness data. |
| `treeState` | Between deposits, sha256 of the frontier. While hashing, sha256(sha256(frontier) ‖ node). |
| `nullifierState` | The root of a 64-level sparse tree of spent nullifiers. |
| `nextIndex` | The next leaf. |
| `stage` | 0, or 1 while a note is waiting for `finish`. |
| `live` | The notes paid for and not yet withdrawn, which is what a deposit reads to see what the pool owes. |

The frontier is the tree's 20 left-hand nodes, 640 bytes, also witness data, so a deposit
reads the pool's history first, and a page keeps what it has read.

## Why three contracts

The circuit proves a MiMC tree, so the chain must keep a MiMC root. If it did not, anyone
could prove a note in a tree of their own and empty the pool. MiMC has no opcode and costs
5.36M of op budget per hash, and an input buys at most 8M, so each hash runs in a `MimcHash`
coin of its own. Twenty hashes do not fit one standard transaction, so a note takes two:
the deposit hashes the first 10 levels and `finish` the rest. The pool checks what each coin
hashed, its left and right values and the frontier. `MimcHash` checks the hash itself.

The Groth16 verifier is 8,175 B of generated BCH Script, in three inputs. It knows nothing
about pools. It proves one statement, `[root, nullifierHash, recipient]`, and `withdraw`
reads those three values from fixed offsets of its last input. The verifier pins every push
in that range, so the offsets cannot move.

Every pool shares both kinds of coin: neither code names a pool, so each pool's code pins the
same two locks (`contracts/Sidecars.scash`), and anyone can pay a coin to either. Spent beside
any other input, a coin recreates itself with the same locking and value, so no such
transaction can take its value: a `MimcHash` coin at its own index, with a true hash, and a
verifier coin in the last three outputs, with a valid proof.
The pool checks the lock of every coin it reads and reads what each proved, so nothing else can
stand there. Since those coins serve any pool, each pool function asks for the pool's master at
input 0 itself. A coin unmoved for 1,440 blocks can be swept by anyone, but only as its
transaction's only input, so no sweep stands in a pool transaction. A deposit adds hashing coins
from the depositor's wallet when too few are free; verifier coins come from pool creations and
`scripts/top-up-sidecars.ts`, since a withdrawer who paid one in would tie their wallet to it.

## Making a pool

A pool is made through a factory, `BchPoolDeployer` or `TokenPoolDeployer`, whose `new` spends a
one-shot deployer coin (SolidCash's `Deploy<C>`) that pins the pool's code, constructor
arguments, records and value; `scripts/deploy.ts`, the page's Create pool and the devnet all do
it this way. A factory refuses a second pool of an amount, or of an asset and amount, on chain:
the BCH factory keeps one bit per exponent, the token factory the root of a 128-level sparse
tree of its pools. Nothing on chain sees a genesis afterwards, so it is read off chain before a
pool is trusted, and a factory's own genesis once: `verify-deployment.ts` reads them, and so does
the indexer before it serves a pool. The page reads neither: it takes a pool once `factoryPools`
finds the factory's own creation of it, whose genesis `Deploy<C>` pins (`web/src/listing.ts`).
The README's "Pool factories" has the rules.

## The client

`web/src/pool-client.ts` is one pool through SolidCash, and the tests run it too.
`PoolClient.view` rebuilds the tree and the nullifier set from a history and refuses them
unless they reproduce `recentRoots` and `nullifierState`. So a history can come from anyone.

- **History.** `ChainHistory` reads event NFTs from Fulcrum, and a spent one stays in its
  address's history. Not everything at an event's address is an event, and the chain keeps
  the rest for good, so it takes a record only from a transaction that recreates the master,
  in an event's exact form, and skips the others. `ArchiveHistory` can read an archive
  instead, which is faster, and falls back to the chain, but the page names none:
  `/api/config` has passed no archive since `6d71b70`.
- **Notes.** A note is shown and saved before anything is sent. A wallet can then refuse,
  and the note is simply unused. A note names its network, its pool's kind and category, a token
  pool's asset and its amount (`web/src/note-text.ts`), so a page that does not list its pool
  reads the pool from the chain, and a withdrawal needs no list, indexer or stored state. Older
  notes name a deployment's id or a category, which the page finds in its list or among the pools
  its factories made.
- **Which pools.** The page lists a pool, deposits into it and withdraws from it only once its
  network's factory of that kind is seen to have made it, as listed or as a note names it
  (`web/src/listing.ts`). Trustless finds every such pool through the factories' events,
  `/api/config` serves a pool, its deployment's own too, only after the same read, a deposit makes
  that read again first through the wallet's server, and a withdrawal through its own. Each read
  goes through one server, which this release trusts for what the chain holds: one that lies can
  show a pool made outside the factories as theirs. Cluster mode, straight after this release,
  asks several (the README's "Run your own node and Fulcrum").
- **Signing.** A deposit goes through `Signer.external`, which asks the wallet over
  `bch_signTransaction`. Hashing and withdrawing need no key.
- **Races.** The master is one coin, so two people can reach for it at once. A withdrawal or
  a `finish` rebuilds on what won, whatever a server called the refusal, since a note can
  only pay once. A proof survives that because it names a recent root, and one older than the
  last 8 is made again.
- **Outcomes.** A server saying it took a transaction proves little, so the page reports what
  the pool shows: a deposit once its note is in the pool, and a withdrawal once its transaction
  is in the Withdraw history and its nullifier is spent. All of that comes through one server,
  which could keep a transaction to itself and show a pool that holds it, so the page never
  clears a note. What it cannot tell, it says it cannot tell.
- **One signature per note.** A note deposited twice pays once, and a signed transaction can
  land at any time, whatever any server says. So once one has left the page, that note is
  never signed again. If its outcome is unknown the person keeps the note, and depositing again
  means a new one, which is safe whatever happened: if both land, both pay.
- **Two servers.** With a second one, a withdrawal goes through it alone, from its first read
  to its broadcast, and the wallet's server keeps deposits, hashing and page loads. Before a
  proof is made, the two have to agree on the pool's roots.
- **Abandoned deposits.** If a tab closes after the deposit, the next visitor's browser
  finishes the hashing. It costs them nothing, as the deposit prepaid it.

## What an outsider can do

Unsigned steps let anyone build a pool transaction, so the contracts assume a hostile
builder. The rules that keep the client working, and what is left:

- **Coins stay plain.** A satoshi coin, a hashing coin and a verifier coin all refuse a new
  token, and the master keeps its commitment. A coin the client stopped reading would stop
  the pool for everyone, and a token cannot be dropped from a container once it is there.
- **A token coin stays as it is.** A coin is recreated with the satoshis it holds, and the dust
  floor rises with its amount: 681 sat at 2 units, 693 past 65,535, and 705 past 2^32. A coin
  anyone could shrink could stop every call, and an NFT hung on one can stop it paying. So under
  `pragma tokencontainer single` the token coin's covenant refuses to lose a satoshi, or to gain or
  change an NFT, in any transaction. The exception is an immutable NFT with an empty commitment
  beside a fungible amount, which no script can see. It can reach the coin in a deposit, and
  the client carries it.
- **One coin holds all the pool owes.** Anyone can pay a coin to a pool's lock, and a transaction
  can pick it, so money could otherwise spread over coins none of which pays a note, and a
  withdrawal has no wallet to bring a second coin. So `deposit` lands only on a coin that then
  holds everything owed: the seed, each live note's value and fee, and the `finish` to come.
  `live` counts the notes. Nothing else needs the rule, since `finish` and `withdraw` take no
  more from any coin than they lower what is owed. A token pool's coin must also be free of
  NFTs a script can see and hold enough satoshis to be recreated at any amount.
- **Coins paid in are ignored.** The client spends hashing and verifier coins of at least their
  usual value with no token, the ones its pool's own transactions made first, and skips the
  rest. At the satoshi lock it takes the largest plain coin, and at the token lock
  the largest with no NFT a script can see that can be recreated at any amount. By the rule
  above that one holds all the pool owes, so a stranger's coin that takes over is a donation. A
  miner's reward paid to a lock is skipped until it can be spent. A call refuses a coin with a
  token in the satoshi coin's place, since the money would sit where no client reads it.
- **A coin can be moved.** SolidCash's merge and read-only paths let anyone spend the satoshi
  coin or the state record back to itself, for 510 B and 649 B (`contracts/test/griefing.ts`
  measures both). A wallet's signature names the
  coins it spends, so a move during a wallet prompt spoils that deposit, and enough of them
  stop wallet deposits for as long as someone pays. `PRODUCTION.md` has the numbers. The
  2026-11-17 bytecode audit found three more: the shared verifier coins, for about 30 kB of fee
  a move, and hashing coins, for about 8 kB a coin, which anyone can replace by paying fresh
  coins to their locks; and a factory's state record, which can spoil creations in flight for
  as long as someone pays. `AUDIT.md` lists them.
- **A history can be padded.** Anyone can pay plain coins to an event's address. They are
  skipped, but each costs a client without an archive a fetch. Past a server's `max_history`
  Fulcrum answers as if the address had no history, so a cut history is refused as the server's
  limit (`HistoryLimit`), and the page reads the pool's own transactions instead, back by txid
  from the master (`web/src/lineage.ts`): each call spends the master the one before it made.
  Genesis checks and the factories' lists are read the same way.
- **A depositor can force a new proof.** Eight deposits during a proof retire its root, for
  about 1.8M sat a round. The client proves again, and nothing is lost.
- **Two notes can share a nullifier slot.** A slot is the low 64 bits of a hash, so the second
  of two colliding notes could never be withdrawn. Nobody can aim at a note this way, since a
  nullifier hash is public only once it is spent, and by chance it is about 3 in 100 million
  across a full tree. A wider key would cost every withdrawal more.

## The service

`service/server.ts` is optional, and production runs without it. On a real network it keeps the
archive (`GET /archive/:pool`), read from `FULCRUM_URL`. It listens on every interface, as it would
in a container behind nginx with no port published; `SERVICE_HOST` names another address. With
`POOL_NETWORK=local` it also runs a chain of its own, which a page on the host of its container
reaches through a mapped port: SolidCash's production-profile mock with an Electrum view, which replays
its transactions from `service/state.json` on start, a faucet, and a deployment written to
`deployments/local.json`. A saved chain whose pools this build cannot find, after a contract
or SolidCash change, is set aside with an `.old` suffix and a new one deployed. It holds no
pool rules: what it accepts is what the VM accepts.

`indexer/` serves a real network's pools: it takes the factories' categories, checks each
factory's genesis, finds the pools from the factories' `PoolCreated` events, read along each
factory's own chain and counted only where its `create` writes them, checks each creation, and
serves the counts and history the page's **Fast indexer** reads, a source a person chooses in
Settings: the page reads Trustless by default.

## Limits

| | Measured | Limit |
|---|---|---|
| Largest transaction | about 89,700 B, a token deposit | 100,000 B standard |
| Largest input | 9,975 B for the production proof; 10,000 B for about 1 statement in 25 | 10,000 B |
| Verifier op cost | 7.53M of 8.01M as BCHN counts it | 6% margin, by filler |
| `MimcHash` op cost | 5.36M of 6.46M as BCHN counts it | 17% margin |
| Prepaid fee | about 1.02 sat/B for a finish, 1.03 for the longest token withdrawal | 1 sat/B relay floor; a coin added can pay more |
| Tree | 1,048,576 notes | |
| Proof lifetime | 7 later deposits | then prove again |

## Deviations from tornado-core

- The statement is `[root, nullifierHash, recipient]`. `relayer`, `fee` and `refund` are
  fixed to 0: the fee is prepaid, and there is no relayer.
- `recipient` is the first 31 bytes of the sha256 of the locking bytecode and a 4-byte salt,
  so any address type fits in a field element. The salt is there because about 1 statement
  in 570 needs a quotient too large for the verifier's input, and the longest that do fit
  can outgrow a token pool's fee. The client changes it until the statement is at most 141
  words, about 1 try in 30, and a proof is bound to it, so it gives a thief nothing.
- The tree keeps 8 recent roots, not 30, and one deposit is hashed at a time.
