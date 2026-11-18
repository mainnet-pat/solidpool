# SolidPool

Private fixed-amount pools on Bitcoin Cash, for BCH and CashTokens. You deposit a fixed
amount and keep a secret note. Later, from anywhere, you redeem the note to any address,
and a zero-knowledge proof shows you hold a note in the pool without saying which one.

SolidPool is an independent project. It is not affiliated with Tornado Cash, its developers,
or the TORN token. It reuses the public withdrawal circuit and trusted setup of
tornado-core; [PORT.md](PORT.md) records that provenance.

**Not audited. Do not put real money in it until [PRODUCTION.md](PRODUCTION.md) says so.**
No person has audited the contracts or the verifier as they ship. There are two independent AI
audits. One, on 2026-11-13, read an earlier verifier template (sha256 `37c8b9ec…`). The other, on
2026-11-17, read the contracts as compiled at `9ceafd7`, and what the template that ships
(`7b513096…`, shared by every pool, with a branch that sweeps an idle coin) changes from the
earlier one ([contracts/AUDIT-2026-11-17.md](contracts/AUDIT-2026-11-17.md)). It found no way
to take funds, and one way to forge a factory's list of pools, which each factory's `create`
has refused since `7da7067`. A second AI audit read that change and the factories' later rule
([contracts/AUDIT-2026-11-17-factories.md](contracts/AUDIT-2026-11-17-factories.md)).
[AUDIT.md](AUDIT.md) says what each
review covered.

## Run your own node and Fulcrum

**Everyone who uses SolidPool, and everyone who hosts it, should run their own Bitcoin Cash
node and their own Fulcrum server, and point the page at it.** On mainnet and chipnet the
page takes only a `wss://` server, so give your Fulcrum a TLS certificate.

The page sees the chain only through a Fulcrum server, and that server:

- learns your IP address, and every coin, pool and transaction the page asks about for you;
- decides what the page sees. This first release reads from one server and takes its word on
  which pools exist. A server that lies can list a pool made outside the factories, and take
  what is deposited into it.

Straight after this first release the page moves to cluster mode. The reads that decide which
pools to trust will go to several servers at once, through rpckit's cluster transport
(`@rpckit/cluster`), and an answer will count only when enough of them return the same thing.
A lie will then need several servers' operators. But every server in the cluster will learn
your IP address at once, where today one does. Cluster mode keeps the pool list honest; it does
not keep you private. Your own node and Fulcrum do both.

## How it works

Everything is enforced on chain, by SolidCash contracts and a Groth16 verifier written in
BCH Script. The verifier is built with [verifier.cash](https://www.verifier.cash), the BCH
Groth16 verifier project; [PORT.md](PORT.md) names the exact entry. There is no sequencer,
no relayer and no owner signature. The browser reads the chain, makes the proof and sends
the transactions, and no service is needed.

| Step | What happens | Size, BCH pool | Size, token pool |
|---|---|---|---|
| Deposit | The amount joins the pool and the note is hashed up the first 10 tree levels, one hash per `MimcHash` input. No other deposit can land until `finish` has run. The wallet signs this one. | 88,106 B | ~89,700 B |
| Finish | The other 10 levels, which publishes the root and lets the next deposit in. Prepaid, unsigned, anyone can run it. The page runs it by itself. | 88,077 B | 89,148 B |
| Withdraw | The proof runs in three verifier inputs beside the pool. The pool reads what it proved and pays. | ~38,300 B | ~39,700 B |

These sizes are measured by `contracts/test/pool.ts` and `contracts/test/token-pool.ts`. A
withdrawal's size depends on its proof. The longest proof the client makes gives about 39,900 B
on a token pool (39,819 to 39,924 B in three runs since every pool shares one verifier), and the
41,100 sat its prepaid fee leaves for the transaction cover it with at least 1,000 sat to spare,
which the token pool's test requires.
`test/real-node.ts` runs the same steps on an unmodified BCHN v29 with public relay policy.

All the money sits in one coin per pool (`pragma satoshicontainer single` and, for a token
pool, `pragma tokencontainer single`), so a withdrawal spends the pool's coin and not
anyone's deposit. That is what keeps the two unlinked.

**The pool checks, on chain:**

- the root the proof used is one of the pool's last 8 roots, so the note is really in the
  tree, and a proof survives up to 7 deposits landing while it is made;
- the nullifier is unspent, so a note pays once;
- the output pays the recipient the proof names, so a copied proof cannot be redirected;
- a commitment is below the field size, so no deposit can stop the pool;
- each coin's token and BCH rules (below).

**The cost of a note** is about 220,000 sat at 1 sat/B, or 0.0022 BCH: 89,000 for the
deposit, 90,000 for `finish` and 41,000 for the withdrawal. A token note costs about
225,000 sat. The deposit pays all of it up
front, so the withdrawal needs no fee input from the recipient and no funding transaction
ties their address to the depositor's. There is no protocol fee. The cost
is fixed per note, not per amount, so small pools are not worth using: a 0.01 BCH note
loses 22%, and a 1 BCH note 0.22%.

Hashing is the big part: one MiMC hash costs 5.36M of op budget, which BCH sells at 800
per byte. It stays because it needs no new trusted setup. PRODUCTION.md lists what would
lower it.

**Token pools.** A CashToken UTXO can hold BCH, tokens and an NFT at once, so a coin worth
little in tokens could carry a lot of BCH. A deposit coin must hold the asset with no NFT and
under 1,500 satoshis, at a 25-byte lock, a P2PKH's length. The contract tells it from the pool's
token coin, a 35-byte P2SH32, by that length alone. Asset coins at any other lock must add up to
exactly what the pool's token coin holds, so no script-locked coin but the pool's own can join a
deposit. Since the May 2026 upgrade any lock of up to 201 bytes is standard, so anyone can make a
deposit coin at a 25-byte lock that is not a P2PKH. It is held to the same rules, and the pool
still receives exactly one denomination and the fees, whatever lock the coin had. Inputs of any
other category are refused. `asset` is the token the pool holds, and `this.category` is the
contract's own master; deployment refuses the two being equal.

**The fee** is the input-output delta: `this.payMinerFee` lets the satoshi container lose
that amount with no output. A withdrawal spends only the pool's coins, so no wallet is
linked to it.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | `BchPool`, `TokenPool`, `MimcHash` and the two pool factories, in SolidCash, and `Sidecars.scash`, the hashing and verifier locks every pool pins. `artifacts/solidcash/` holds the compiled contracts, and `test/` their whole suite. |
| `solidcash.config.ts` | The solidhat project: compiler, artifact and test paths, and the mock network's consensus. |
| `vitest.solidhat.config.ts` | The contract suite's Vitest preset and coverage floor. |
| `web/src/pool-client.ts` | One pool through SolidCash. The tests and the browser run this same code. |
| `web/src/engine.ts` | The browser engine, imported by the app as `@solidpool/engine`. |
| `web/components/`, `web/app/` | The Next.js app. |
| `service/` | The optional backend: an archive, and a local chain for development. |
| `packages/verifier/` | The Groth16 verifier, `@solidpool/verifier`, vendored from `groth16_cashscript`. |
| `service/verifier/` | The Groth16 verifier's build and its tamper suite. |
| `scripts/` | Contract build, deployment, deployment check, local real node. |
| `deployments/` | Which pools exist on which network, for the scripts. |
| `web/deployments/` | The same for the app: mainnet and chipnet are bundled, the devnet comes from the local service. |

The verifier is the `@solidpool/verifier` package in `packages/verifier`, vendored from
`chunked/bn254` of `groth16_cashscript`; its README and `SOURCE.json` name the commit and the
files. The app, the tests and the service's verifier scripts all load that one copy. The SDK and
compiler are SolidCash 0.51.1, from npm. The circuit and proving key are in
`web/public/prover/`, tornado-core's build of them, and `web/src/prover.ts` pins them by hash.

## Pool factories

Every pool is made through one of two factories, `BchPoolDeployer.create(exponent)` and
`TokenPoolDeployer.create(exponent, asset, path)`, which create it through the compiler's
`new`, and each factory makes at most one pool of an amount, or of an asset and amount. It
refuses a second on chain:

- the BCH factory keeps `made`, one bit for each exponent it has made;
- the token factory keeps `registered`, the root of a 128-level sparse Merkle tree whose slot is
  the first 16 bytes of sha256(asset ‖ exponent) and whose leaf is the pool's category. `create`
  proves the slot empty with `path`, its 128 siblings, and writes the root with it filled. The
  slot is 128 bits because anyone can mint a token category, which is a txid they can grind:
  at 80 bits a well-funded attacker could grind a category into the slot of a pool nobody has
  made yet and take it first; at 128 that is out of reach.

A pool's category is the txid of a prep transaction that pays a one-shot deployer coin, which
the factory's `create` spends (`buildDeployerPreps`). The factory's covenant binds the call to
that coin, records exactly one amount, and mints exactly one `PoolCreated` naming the pool
born in the same transaction; `Deploy<C>` pins the pool's genesis: its master at the lock of
the pool's code with no commitment, its empty state record, both at 1,200 sat, one satoshi coin
of at least 1,200 sat with no token and, in a token pool, one coin of the asset with no NFT
capability and no commitment, holding at least 1,200 sat, and no other token of the new
category. An immutable NFT of the asset with no commitment can ride beside the coin's units:
no script sees one, and the pool works with it.
Nothing else of the factory's own category leaves a creation: `create` refuses every output of
it but the master at its own index, the state record after it and the `PoolCreated` after that,
whatever the lock. SolidCash 0.51.1's own count of a contract's outputs passes over an immutable
NFT at a bare `OP_1` lock, the lock of a return record, so before that refusal a creation could
mint one holding a `PoolCreated` that names any pool, for anyone to move to the event address
later. After a factory's genesis only its `create` can mint an NFT of its category, so every one
minted since is a real creation's `PoolCreated`, naming the pool born beside it.
`contracts/test/deployer-outputs.test.ts` adds one NFT of the category to the SDK's creation in
nine ways, on both factories, and each is refused.
Every master's commitment is empty, for good: all state lives in state records. SolidCash keeps
a master's commitment only in a function that touches no state, so the contracts' own code holds
it on chain: `Deploy<C>` lets a pool's master be born only without one, every pool function keeps
its master's commitment as it was, and each factory's `create` requires its own master's to be
empty. A commitment written on a factory's master would otherwise stay there, and the SDK would
carry it into every later creation, up to 128 bytes each. The same test writes 1 and 128 bytes
on each master a creation holds, on both factories, and the chain refuses each.
`contracts/test/deployer-genesis.test.ts` changes the SDK's creation one way at a time, and the
chain refuses each: a plain coin in the deployer coin's place, the factory's state recording a
second amount, no `PoolCreated` or a second one, an event naming another pool, no pool master
or a second one, the state record or satoshi coin paid elsewhere, a satoshi coin of 600 sat or a
second one, and the author's coin replaced.

A creation the chain takes and the check below refuses would squat its amount for good: the
factory makes no second pool of it, and no page or indexer lists the first. So the same test
holds the two to agreeing, on both factories, over what a builder who wanted an amount dead
would add or change: fungible tokens, an immutable NFT or a second mutable NFT of the new
category, the master paid away, a fungible amount or a commitment on the master, a fungible
amount on the state record, the master or the record under 1,200 sat, another state, a token on
the satoshi coin, and in a token pool the token coin under 1,200 sat, holding another token or an
NFT with a capability or a commitment, missing, or a second coin at its lock. The chain refuses
each. It takes a token coin opened with more than one unit, and so does the check: the pool asks
only that its coin hold the seed and what it owes, so the extra is a gift that stays in the coin.
It also takes an immutable NFT of the asset with no commitment on that coin, which anyone holding
one of the asset's NFTs can add, and so does the check: no script sees it, and a deposit, a
finish and a withdrawal run with it on the coin. Only a seed within 2^20 notes of
the CashToken limit of 2^63 - 1 units would leave the pool room for fewer deposits than a full
tree, and only a holder of nearly that many units of the asset could open one. So the first
creation of an amount is a working pool, and it is the pool everyone uses: the factories are
permissionless, hold no funds and give the caller no authority, so `allowUnsafeOperations`
accepts the compiler's lifecycle warning.
`npm run contracts:check` compiles the other four contracts without the flag and fails on any
refusal, warning or change in their code.

A pool takes its amount as an exponent: each note pays 10^`exponent` base units, so every
pool's denomination is a power of ten. The pool's constructor bounds the exponent with
`within`: 6 to 10 for BCH (0.01 to 100 BCH), 0 to 12 for a token. 10^12 is the largest power of
ten at which a full tree of 2^20 notes stays under the CashToken limit of 2^63 - 1 units. A
factory's `new` runs that constructor on chain where the pool is born.

**One hashing contract and one verifier for every pool.** The amount, and a token pool's asset,
are a pool's only arguments: its code pins the locks of the MimcHash coins and the Groth16
verifier's coins it spends beside its master (`contracts/Sidecars.scash`, written by
`scripts/sidecar-locks.ts`, which `npm run check` holds to MimcHash's source and the verifier's
artifact). Neither code names a pool, so a creation has nothing a creator could get wrong, every
pool shares those coins, and anyone can pay a coin to either lock. The pool checks the lock of
every coin it reads, and reads the verifier's statement and the hashes from those coins'
unlocking bytes, so nothing but a coin that ran that code can stand there. Spent beside any
other input, a coin recreates itself in place with its value and no token. Because those
coins serve any pool, `deposit`, `finish` and `withdraw` each require the pool's master at input
0. A client spends the coins its pool's own transactions made first, then confirmed coins in an
order of its own pool's, so two pools rarely reach for the same one.

A hashing or verifier coin that has stood unmoved for 1,440 blocks can be swept by anyone, but
only as its transaction's only input; a pool transaction always has more inputs, so no sweep can
stand in one. A lone input brings no other coin for the fee, so a 1,000-sat hashing coin, whose
unlocking is 7.9 kB of MiMC, is not worth sweeping, while a verifier coin's sweep is 167 B. A
deposit adds the hashing coins it needs from the depositor's own wallet when too few are free.
A withdrawal cannot add verifier coins without tying the withdrawer's wallet to it, so after a
quiet spell with no withdrawal anywhere, pool creations and `scripts/top-up-sidecars.ts` add
them.

Each creation emits `PoolCreated(bytes32 indexed category, uint8 exponent)` (the token factory
adds `bytes32 indexed asset` after the category) as an event NFT of the factory's own category,
at the factory's event address. The page and the indexer below both read those.

**Which pools a page lists.** Anyone can make a pool of the same code outside a factory, through
a plain genesis that keeps a second master back. So the page lists a pool, deposits into it and
withdraws from it only once its network's own factory of that kind is seen to have made it, with
its amount and asset, whoever listed it (`web/src/listing.ts`). That is what `factoryPools`
reads from the factory's `PoolCreated` events, taking one only where the factory's own `create`
minted it, in the creation beside the factory's master and the new pool's: before each factory's
`create` refused every other output of its category, a creation could also mint a stray NFT of
it, for anyone to move to the event address later. `/api/config` serves a pool, the deployment's
own as well as an indexer's, only after reading that from the chain itself; it keeps what it
read, and while the chain cannot be read it serves only pools it saw made before. Trustless
reads it through the page's own server and lists every pool the factories made, so it needs no
indexer, and a deposit reads it again just before it is signed. Nothing waits for blocks to
bury a genesis: `Deploy<C>` pins the genesis of every pool a factory makes, and until a creation
is buried it can only be dropped, or replaced by another through the same deployer coin under
the same covenant, and every deposit built on it goes with it. A factory's own genesis counts
from the mempool on too (the user's decision of 2026-11-18): until it is buried, only its
deployer could replace it, with a second master in the replacement. The factories a page trusts are its
deployment's and, on the network the app runs for, `BCH_FACTORY` and `TOKEN_FACTORY`, the two
the indexer reads, and on either network the same two under its prefix, such as
`CHIPNET_BCH_FACTORY`; where they name different ones, the app serves no pools on that network. A
withdrawal is checked before it is built, through the server it goes out on, and the note's
kind, amount and asset must be the ones the factory made its pool for, so a note's text cannot
claim another pool's terms. The command `scripts/withdraw-note.ts --unlisted-pool` withdraws
from a pool made elsewhere, for someone who chooses that risk.

A row of a deployment or the indexer proves nothing alone:
`genesisProblems` in `scripts/lib/genesis.ts`, which `verify-deployment.ts` and the indexer run,
requires the pool to have been made through the named factory, its creation the transaction
that spends the deployer coin at output 0 of the transaction whose txid is the category, holding
the pool's master and only state record at the locks its code and category give, the empty
pool's state, one plain satoshi coin of at least 1,200 sat, in a token pool one coin of the asset
holding at least one unit and 1,200 sat with no NFT but an immutable one with no commitment, no
other token of the category, that factory's `PoolCreated` naming the pool two outputs after the
factory's own master and right before the pool's. An event anywhere else
proves nothing: the deployer coin lets a pool be born with no factory beside it, and SolidCash
0.51.1's own count of a contract's outputs passes over an NFT at a bare `OP_1` lock, which only
each factory's refusal of any other output of its category keeps a creation from minting.
`factoryPools` and the indexer count a `PoolCreated` only in that place too (`createdAt` in
`web/src/factory.ts`). `factoryGenesisProblems` checks a factory's own genesis once: one master at its
lock, one state record that has made nothing, its BCMR identity at output 0, SolidCash's SCID
anchor, and nothing else of its category. A second minting NFT kept there could mint any row.

## Fast indexer

`indexer/` discovers pools from the factories' `PoolCreated` events over Fulcrum and serves the
archive the page's **Fast indexer** reads. It takes only the two factories' categories: it
checks each factory's genesis, reads each factory's own chain by txid, counts a `PoolCreated`
only two outputs after the factory's master, and checks each pool's creation before it serves
the pool; pool categories, exponents and assets come from those events and the chain, and token
metadata from BCMR. A server whose `max_history` hides part of a history is logged as such,
never read as no pools. See `indexer/README.md`, and run it with `docker compose --profile
mainnet up -d --build` (or `chipnet`). It needs a Fulcrum server of your own, 1.10 or later. It
publishes no port: nginx serves it over TLS, and the app's `MAINNET_INDEXER_URL` or
`CHIPNET_INDEXER_URL` names that public `https://` URL, since browsers read it as well as the
app's server. Any page may read it: it
serves public chain data.

## Run

```bash
npm install
npm --prefix web install
npm start                  # the service, its local chain and pools, and the app on :8787
npm run start:built        # the same, with the app built once and served as it ships (faster)
```

The page reads **Trustless** by default: it shows the catch-up progress while it verifies
each pool against the chain through Fulcrum, then caches the verified rows and transactions
in IndexedDB, so the next refresh paints from that cache before catching up. Settings → How
data loads also offers the **Fast indexer** where the deployment names one, which paints the
pools from the indexer's archive (the devnet's `/api/indexer`) at once and trusts the app's
server for them. Trustless takes
its settings from the page's HTML and asks no path of the app under `/api`; the Fast indexer
asks `/api/config`, for the pools the app's server checked, as well as the indexer's archive.
Advanced settings show the fast indexer and both Fulcrum endpoints. The fast indexer can stay on
the deployment's archive or name a custom one, which is checked against the app's `/archive`
endpoint before the page reads it. Both Fulcrum lists show only the well-known servers for the
selected network, and a custom one is kept only if it runs Fulcrum 1.10 or later and follows the
selected network: its genesis, and a block past the network's last split
(`web/src/network-check.ts`), so a testnet4 server is refused for chipnet and a BTC or eCash one
for mainnet. On mainnet and chipnet every server is
`wss://`, configured or entered, so nobody on the path can rewrite what it says; a server an
older page saved without TLS is dropped. The devnet's chain is this machine's, over plain
`ws://`. Choices are stored in this browser per network. The withdrawal server
defaults to a different known server
(`wss://electroncash.dk:50004` on mainnet, `wss://chipnet.imaginary.cash:50004` on chipnet)
so no single operator sees both sides, and choosing the chain server shows a privacy warning.
The browser reads the Fulcrum endpoint itself, over its WebSocket. The devnet's chain is local,
so its one server is the service on this machine, whose Electrum WebSocket at
`ws://127.0.0.1:8788` the page reads directly, subscriptions included, as it reads a real
network's Fulcrum. A wallet such as Cashonize can name the same address as a custom Chipnet
server. A browser that reaches the service at another address, through a forwarded port say,
needs `DEVNET_FULCRUM_URL` set to it where the app runs.

A BCH browser extension is offered as **Injected wallet · <name>** (Cashonize today,
Paytaca later) when it advertises itself through the BCH counterpart of EIP-6963
(`bitcoincash:requestProvider` / `bitcoincash:announceProvider`); the option is absent when
no extension injects `window.cashonize` or `window.bitcoincash`.

Open <http://127.0.0.1:8787> and connect the browser account. On the Devnet it is a
deterministic account from the seed phrase `cave cave cave cave cave cave cave cave cave
cave cave cave`, at `m/44'/145'/0'/0/0`
(`bchtest:qzt3y6g9qtxak8kyp5evngy9dr62u9ewzy8c0akkcu`), which the service seeds on every start with 1 BCH and 10,000,000 units of each test token
(Test USD, Test Coin and Test Stablecoin, as USDT, USDC and DAI); each token's BCMR metadata is
written to `web/public/bcmr/<asset>.json`, which git ignores, and is served by the app. The same
folder holds the registries the app pins for tokens no index knows, committed: chipnet's tPUSD and
tMUSD, as sushi-port ships them. A pinned registry resolves first and shows no "unverified" tag. The test
tokens have no icons, so pool tiles show their first letter, and BCH the pre-cached
`web/public/bch.svg`. The account dialog's **Get test funds** sends 5,000,000 satoshis and
10,000,000 units of each test token. `npm run seed:local` sends it more funds and prints the
address, phrase, key and tokens. The first withdrawal loads the circuit and the 14 MB
proving key; a proof then takes about 10 seconds.

The header's network button opens Settings, where Mainnet, Chipnet and Devnet can be
chosen. The choice stays in the browser. Chipnet and Mainnet read a public Fulcrum server
directly; the Devnet reads the local service. Mainnet spends real money. A network lists no
pool, and none can be made from the asset view, until its factories are deployed and named
(see [PRODUCTION.md](PRODUCTION.md)), and neither Chipnet nor Mainnet has any yet.

`npm run contracts:build` recompiles the contracts after changing them. A pool's addresses
come from its contracts and from SolidCash, so on start the service checks that every coin of
the saved local chain's pools is where this build looks for it. When one is not (other
contracts, another SolidCash), or the saved chain is in a form an older service wrote, it
starts a new chain and deploys the pools again, keeping the old `service/state.json` and
`deployments/local.json` beside it with an `.old` suffix.

## Tests

```bash
npm run check              # the contract and verifier artifacts match their source
npm run test:contracts     # solidhat compile, then the suite beneath contracts/test
npm run coverage:contracts # the same suite, with the coverage floor enforced
npm test                   # check, the contract suite, wallet signing, app flows, the verifier's
                           # tamper and forge suites, its sizing on both kinds of libauth, the
                           # production settings and server checks, and the indexer's HTTP side
npm run test:app           # a new local chain, the built app, and test:ui against them
npm run test:ui            # a real browser, with the app and service running
npm run test:prover-compat # the browser prover (esbuild bundle) against the production key
npm run test:verifier-universal  # the verifier runtime (esbuild bundle) in a page with no Node globals
scripts/regtest.sh up      # a real BCHN and Fulcrum, then:
npm run test:real-node
scripts/regtest.sh down
```

The browser tests drive this project's Playwright: `npx playwright install chromium` fetches its
browser once on each machine.

The contract suite runs under solidhat's Vitest preset on the mock network with its
production profile: BCH's size limits, the standard relay VM, dust, and no coin the network
does not hold. The compiler is SolidCash 0.51.1, which `package.json` pins and
`npm run contracts:check` names. Its proofs are real ones
under the production key. `test:real-node` sends the same transactions to an unmodified
node, which is the only test of real relay policy.

## Deploy

```bash
npm run deploy -- chipnet  # the factories, the shared coins, the check, and the settings to set
```

`npm run deploy -- <network> [--server <url>] [--key-file <path>]` deploys SolidPool to mainnet
or chipnet, or to regtest for a rehearsal on `scripts/regtest.sh`'s node, which needs `--server`.
In one process it makes the two pool factories and a float of the hashing and verifier coins every
pool shares, checks them against the source with `verify-deployment.ts --write-web`, which writes
the page's copy of the deployment once every check passes, and prints the settings that name the
deployment. Without `--server` it reads the network's first public Fulcrum server, the one the
page's Settings start on. It asks for the deployer's key, a WIF, at a prompt that shows nothing,
or reads it from a file only you can read (`--key-file`, or `DEPLOYER_KEY_FILE`); it never takes
one from the command line or the environment. It makes no pool: pools are made from the page's
Create pool. Run again, it finishes a run that stopped, and once everything is done it spends
nothing. Its parts, `scripts/deploy-factories.ts` and `scripts/verify-deployment.ts`, also run
alone, and `scripts/deploy.ts` makes pools from a plan, for rehearsals and tests
([deployments/README.md](deployments/README.md)). See [PRODUCTION.md](PRODUCTION.md) for the
rest.

In production the app and the indexer run from their images (`web/Dockerfile`, `Dockerfile`),
which `docker-compose.yml` builds and starts, one profile per chain: as `node`, on read-only file
systems, publishing no port to the host or the internet, behind nginx with TLS. Outside a container,
`npm run build:prod` checks the settings in [web/.env.example](web/.env.example) and builds the app
once, and `npm run start:prod` serves that build on port 8787, on every interface, and never
builds. Neither runs a devnet, a faucet or the service. However it is built or
started, a production build and a production server stop at a missing or malformed setting, or a
configured server that runs anything older than Fulcrum 1.10, follows another chain or cannot be
asked, and name it, so a forgotten setting never builds or opens a page on defaults nobody chose. Next's anonymous
telemetry is off wherever the project runs Next: its scripts set `NEXT_TELEMETRY_DISABLED=1`, and
so does `web/next.config.ts`.

The Next app in `web/` is built inside this repository: Next bundles the engine, wallet and
verifier from their package imports (there are no public engine or wallet bundles), and those
resolve through the root `node_modules`, where `npm install` puts SolidCash and links
`packages/verifier`. A build that sees only `web/` cannot reach them, so the app's image builds
from the repository's root. The page reads its Fulcrum
servers and the BCMR service itself, so a trustless deployment needs no indexer of its own; the
service is only for the Devnet. The circuit and proving key are served from `web/public/prover/`.

## Trust

- The contracts and the verifier are the rules. A service, archive or Fulcrum server can
  refuse to help, but cannot take funds from a pool or change who gets paid. What it can do is
  show a pool that is not what it seems, below.
- The browser refuses a history that does not reproduce the state a server shows, so a server
  cannot hide or invent a note in the pool it shows. It can show a pool's state of its own
  choosing, which costs privacy, not funds: see [PRODUCTION.md](PRODUCTION.md).
- Which pools exist is another matter, and it can cost funds. A pool made outside a factory can
  keep a second master that later takes everything deposited, so a page that listed one would
  lose its depositors' money. An indexer, or the app's own server, cannot put such a pool on the
  page: a pool is listed, and takes deposits and withdrawals, only once its network's factory is
  seen to have made it, and the page reads that through its own Fulcrum server before each. That
  server is trusted for what the chain holds. One that lies about the chain could show such a
  pool as the factory's, so deposit through a server you trust, or your own.
- Notes stay in the browser. Lose the note and the deposit is lost. A note is the whole key: it
  names its network, its pool's kind and category, a token pool's asset and the amount
  (`web/src/note-text.ts`), so any page, or `scripts/withdraw-note.ts`, withdraws it through a
  Fulcrum server alone, with no indexer, no list of pools and nothing stored, once its network's
  factory is seen to have made that pool as the note says. Notes written before
  notes named all that name a deployment's id or a pool's category; they still withdraw, through the
  deployment's list and the factories' events.
- The circuit's trusted setup is reused as it is, so the pool inherits its assumptions.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.

## Licence

SolidPool's own files are under the ISC licence ([LICENSE](LICENSE)), and so is each of its own
packages. The page, as served, includes code under the GNU General Public License, version 3, and
is conveyed under that licence: whoever receives it may copy, change and convey it on the
GPL-3.0's terms ([LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt)).

- The GPL-3.0 code is that of six projects. `web/src/prover.ts` loads websnark's browser build,
  from tornadocash's repository, to make the proof, and that build carries part of snarkjs.
  `web/src/note.ts` imports circomlibjs's Pedersen hash and Baby Jubjub code, and ffjavascript with
  them, whose browser build carries wasmcurves and wasmbuilder. The app image's server bundle holds
  the same code.
- "Source" at the foot of the page links to the exact source of the build being served
  (`SOURCE_URL`, which a production build and server require and the build bakes into the page),
  and "Licences" to `/licenses/NOTICE.txt`, the page's legal notices, which every build writes with
  the licence texts beside it ([web/lib/licences.ts](web/lib/licences.ts)).
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists the third-party code and assets the page
  and the two images ship, with their licences and copyright holders, and where the GPL-3.0
  packages' sources are, at the versions the lockfiles pin. [LICENSES/](LICENSES) holds their
  notices and licence texts. The rest of the third-party code is under the MIT, ISC, BSD, Apache
  and like licences.
- The circuit and proving key in `web/public/prover/` are tornado-core's v2.1 release assets, under
  the GPL-3.0 of that repository's LICENSE file, though its `package.json` says ISC. The circuit is
  compiled from tornado-core's circuits and circomlib's templates, which are GPL-3.0 too.
- WalletConnect's `@walletconnect/core`, `sign-client`, `types` and `utils` are pinned to 2.21.8,
  under the Apache-2.0; later releases are under Reown's WalletConnect Community License
  Agreement, which is not open source.
- `packages/verifier` is groth16_cashscript's verifier, under the ISC licence its `package.json`
  declares; that repository has no LICENSE file.
- The page is set in Fraunces, Inter and JetBrains Mono, from `web/app/fonts/`, under the SIL Open
  Font License 1.1 ([web/app/fonts/OFL.txt](web/app/fonts/OFL.txt)).
