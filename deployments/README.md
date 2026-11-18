# Deployments

A deployment names a network, its two pool factories and the pools made through them. The
scripts read `deployments/<network>.json`; the app bundles the same files from
`web/deployments/` (mainnet and chipnet). It trusts the factories a file names, and serves the
file's pools, like any other, only once it has read on chain that those factories made them (the
root README's "Which pools a page lists"). The two are kept in step by
`verify-deployment.ts --write-web`, which copies the file across only once every check passes.

The page may switch between Mainnet and Chipnet at runtime, and Devnet too under `next dev` or
with `DEVNET_ENABLED=1`; `POOL_NETWORK` sets the network a fresh browser opens on. `local.json`
is the Devnet, written by the service for its own chain with factories of its own, and is not
checked in.

A deployment is made by one command, which asks for the deployer's key once:

```bash
npm run deploy -- chipnet [--server <url>] [--key-file <path>]
```

It makes the two factories and a float of the hashing and verifier coins every pool shares, checks
them against the source, writes both copies of the file, and prints the settings that name the
deployment (PRODUCTION.md's "Deploy"). It makes no pool: pools are made from the page's Create
pool, through the factories. Run again after a stop, it does only what is left, and once
everything is done it spends nothing. Its steps are two scripts, which also run alone:

1. `scripts/deploy-factories.ts` deploys the BCH and token factories and writes the file:
   `factories`, their categories, and `events`, the addresses their `PoolCreated` events are paid
   to, with an empty `pools`. It writes the file after each factory, and run again after a stop it
   makes only the one still missing. It refuses a file that names both already, and a page copy
   that names a factory this file lacks: a factory's category never changes, and the indexer and
   the page name it. The command runs the same code, takes a file that names both factories as
   done, and then tops up only a float that has run short.
2. `scripts/verify-deployment.ts` checks a deployment against the source, through a server it
   first holds to the deployment's network: each factory's genesis and event address, and each
   pool's id, denomination and creation through the factory it names, with its `PoolCreated`. It
   takes a genesis as soon as the server shows it, in the mempool or in a block. It then says
   whether the page's copy is in step, and with `--write-web` writes it once everything passes.

`scripts/deploy.ts <plan>` makes pools from a plan, for rehearsals, tests, or anyone who wants
pools without the page. It makes each pool of the plan through its kind's factory and adds it to
`pools`, with the factory as its `creator`, writing the file after each. Run again with the same
plan, it skips a pool the file has, and records rather than makes one the factory has made
already, by a run that stopped or through the page: each factory refuses a second pool of an
amount, or of an asset and amount, on chain. It refuses, before anything spends, a plan whose id
the file has for another amount, or whose amount the file has under another id. A pool made from
the page is in no file: the page and the indexer read it from its factory's `PoolCreated`.

The deployment scripts write a file beside itself and rename it over the old one, so a run that
stops leaves the last whole file; `--write-web` writes the page's copy in place. `regtest.json`
is a rehearsal's, on a local node, and is not checked in.

A deployment names the SolidCash it ran on in `solidcash`: the version of the `@solidcash`
packages, which `package.json` pins from npm and every artifact names. `npm run contracts:check`
prints the same.

The pools once listed for chipnet predate the factories and the current contracts, so the
chipnet file is empty until `npm run deploy -- chipnet` runs there.
