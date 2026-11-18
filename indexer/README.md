# Fast indexer

A small service that discovers pools from the BCH and token factories' `PoolCreated` events and
serves the archive the app's **Fast indexer** reads. It is given no pool list: the only pool
configuration is the two factories' categories, which `deployments/<network>.json` names under
`factories`. Everything else comes from the events and the chain, and a token's name, symbol and
decimals from BCMR.

```bash
# The settings sit in a .env file beside docker-compose.yml: .env.example lists them.
docker compose --profile mainnet up -d --build
docker compose --profile chipnet up -d --build
```

Each network's indexer needs that network's factory categories (`MAINNET_BCH_FACTORY`,
`MAINNET_TOKEN_FACTORY`, or the `CHIPNET_` pair, which the apps read too; it runs with either
alone, and lists only that kind) and a Fulcrum server of your own (`MAINNET_INDEXER_FULCRUM_URL` or
`CHIPNET_INDEXER_FULCRUM_URL`), running
Fulcrum 1.10 or later. One that has neither category or no server, or whose server runs anything
older or follows another chain, stops and says why in `docker compose logs`, and Docker starts
it again until that is fixed. It runs on Fulcrum's default limits, as public servers do: a lock
padded past its `max_history` is reported as the server's limit, never as a missing pool
(PRODUCTION.md, "Anyone can pad a lock's history").

No port is published to the host or the internet. The indexers join the `solidpool` Docker
network, where nginx reaches them at `http://indexer-mainnet:8080` and
`http://indexer-chipnet:8080`, serves them over TLS and sets `X-Forwarded-For`. The app's
`MAINNET_INDEXER_URL` or `CHIPNET_INDEXER_URL` names nginx's public `https://` URL for that
network's indexer, such as `https://indexer.pools.example`: the
app's server reads `/pools` from it, and every browser reads `/archive/:pool` from it too, so a name
inside the Docker network, or plain `http://`, will not do, and the app refuses it.

The image holds the indexer bundled into one file, with the code it runs inlined, SolidCash's
included, and libauth, which the bundle loads as a package: no other package is installed. It
runs as `node`, with a read-only file system and no capabilities.

## What it does

1. Reads each factory's own chain over Fulcrum's WebSocket, by txid, from the transaction that
   holds its master now back to its genesis (`web/src/lineage.ts`): every `create` moves the
   master and writes its pool's `PoolCreated`. Only a server that shows neither the master nor
   the state record has the event address's history read instead. It reads each factory again
   at every new block and whenever the event address's subscription says something changed,
   each time only what is new. Anyone can pad an address's history, and past Fulcrum's
   `max_history` the server answers it as if it had none and stops notifying it, so the indexer
   does not depend on either: a history the server cut short is logged as its limit, never
   taken for a factory with no pools.
2. Checks each factory's own genesis with `factoryGenesisProblems`, as `verify-deployment.ts`
   does: one master at its lock, one state record that has made nothing, its identity and
   anchor, nothing else of its category, from the mempool on. A second master kept there could mint
   any `PoolCreated`, so nothing a factory names is checked or served until its genesis checks
   out.
3. Decodes each `PoolCreated` where the factory's `create` writes it, two outputs after the
   factory's own master (`createdAt` in `web/src/factory.ts`): the pool category, exponent, and
   token asset for the token factory. Anything else at the event address is not an event, an
   NFT of the factory's own category included: before each factory's `create` refused every other
   output of its category, a creation could mint one with any commitment at a bare OP_1 lock,
   which the factory's census leaves out, for anyone to pay there later.
4. Checks that pool's creation with the same `genesisProblems` test `verify-deployment.ts`
   runs, given the creation it read the event in: made through that factory, the deployer coin,
   master and state record locks, empty state, satoshi (and token) coins, and the factory's
   `PoolCreated` naming the pool between the factory's master and the pool's. Nothing waits for
   blocks: a pool counts from the mempool on. One whose check fails stays pending and is checked
   again.
5. Resolves a token pool's name, symbol and decimals through BCMR (`BCMR_SERVICE_URL`,
   default `https://bcmr.paytaca.com`); without metadata it uses a placeholder.
6. Adds verified pools to the archive and exposes them. Each factory refuses a second pool of an
   amount, or of an asset and amount, on chain, so the pools served are one per amount, or per
   asset and amount.

| Endpoint | Meaning |
|---|---|
| `GET /health` | `{ ok, network, pools }` |
| `GET /pools` | Verified pool definitions for the app |
| `GET /archive/:pool` | That pool's deposits and spent nullifiers |

It is public, so it bounds what a request can cost (`http.ts`):
- It answers `GET`, `HEAD` and `OPTIONS` only, to URLs of at most 512 bytes, and a pool's id is at
  most 64 letters and digits.
- Any page may read it from a browser (`Access-Control-Allow-Origin: *`): it serves public chain
  data.
- An archive is read from Fulcrum once however many ask at the same time, and then kept for
  `ARCHIVE_CACHE_SECONDS`; an unknown pool reads nothing.
- One client may ask for `ARCHIVE_RATE_LIMIT` archives a minute, and for `POOLS_RATE_LIMIT` pool
  lists, which the app's server reads and keeps a few seconds. Behind nginx, or any proxy on its
  private network, the indexer counts the client the proxy names last in `X-Forwarded-For`; behind
  a CDN, set both to 0 and limit there. An IPv6 client is counted by its /64, the block one
  subscriber holds, so moving to another of its addresses does not make it another client.
- A connection gets 10 seconds for its headers and 15 for its request, checked every second, and
  at most 1,000 are open.
- It writes no access log: when a request came could be matched to a deposit or withdrawal.

The app's `/api/config` merges `/pools` into its deployment list, so a pool that appears
after the deployment was written still shows up: each, like the deployment's own, once the app
finds it, through `factoryPools`, among the creations of the deployment's own factory of its
kind, with its amount and asset, read from the chain itself. The app takes no pool on the
indexer's word, and the page checks the same by its own reads before every deposit and
withdrawal.

## Environment

| Variable | Needed | Meaning |
|---|---|---|
| `POOL_NETWORK` | yes | `mainnet` or `chipnet` (`regtest` for a rehearsal on a local node) |
| `FULCRUM_URL` | yes | A Fulcrum server of your own, 1.10 or later, `wss://`, or `ws://` to one on this machine or its private network: a private address, `localhost` or a single-label name such as a compose service. Subscriptions require a WebSocket, and a server that runs anything older or does not follow `POOL_NETWORK`, by its genesis and a block past the network's last split, is refused. |
| `BCH_FACTORY` | one of the two | The BCH factory's category |
| `TOKEN_FACTORY` | one of the two | The token factory's category |
| `INDEXER_HOST` | no | Address to listen on, every interface (`0.0.0.0`) by default |
| `INDEXER_PORT` | no | HTTP port, default 8080 |
| `ARCHIVE_CACHE_SECONDS` | no | How long a pool's archive is kept before it is read again, default 5 |
| `ARCHIVE_RATE_LIMIT` | no | Archive requests a client may make a minute, default 1,200; 0 for none |
| `POOLS_RATE_LIMIT` | no | Pool-list requests a client may make a minute, default 120; 0 for none |
| `BCMR_SERVICE_URL` | no | Token metadata service |

The compose file passes the first two, the factories, `ARCHIVE_RATE_LIMIT` and
`BCMR_SERVICE_URL` from `.env`. `INDEXER_HOST`, `INDEXER_PORT` and `ARCHIVE_CACHE_SECONDS` keep
their defaults there: set in `.env`, they do nothing. They apply when the indexer runs outside
compose (`npm run indexer`).

## Tested

`test/real-node.ts` runs the discovery against BCHN and Fulcrum in regtest, given the categories
of the test's two factories and of a token that is no factory. It lists the three pools the
factories made and nothing else, takes no candidate from an NFT of a stranger's own category
paid to the token factory's event address with a commitment that reads as a `PoolCreated`, and
reads nothing through the category that is no factory. `contracts/test/history-reach.test.ts`
runs it on a Fulcrum stand-in at a `max_history` of 1,000: it lists the pool past an event
address padded beyond that, takes no candidate from a forged `PoolCreated` paid there, and logs
the server's limit when every way to the factory's events is padded. `test/indexer-http.ts`
holds the HTTP side to the rules above over a real socket, with an archive that counts its
reads, all but `OPTIONS`, the timeouts, the connection cap and the absence of an access log.

## Limits

The factories rely on SolidCash 0.51's `Deploy<C>` and compiled `new`, 0.51.1 here; see the root README's
"Pool factories" section. The indexer checks every factory's genesis and every pool's creation,
so it will not list a creation that fails those checks, but it cannot make a factory safe.
