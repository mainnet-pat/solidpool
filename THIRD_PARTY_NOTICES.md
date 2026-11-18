# Third-party notices

SolidPool's own files are under the ISC licence ([LICENSE](LICENSE)). The page, as served, includes
code under the GNU General Public License, version 3 (GPL-3.0), and is conveyed under that licence:
whoever receives it may copy, change and convey it on the GPL-3.0's terms
([LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt)). The other third-party code it carries keeps its own
licence, each listed below. The licence texts are in [LICENSES/](LICENSES):

- [third-party.txt](LICENSES/third-party.txt): every component's copyright notice and licence text,
  as the component publishes it;
- [GPL-3.0.txt](LICENSES/GPL-3.0.txt) and [Apache-2.0.txt](LICENSES/Apache-2.0.txt): the long texts
  that entries there refer to.

The fonts' notices and licence are [web/app/fonts/OFL.txt](web/app/fonts/OFL.txt).

## How the notices ship

- **The page.** Every production build and dev server writes `web/public/licenses/`
  (`web/lib/licences.ts`), which the page serves at `/licenses/`: `LICENSE.txt`, this file, the
  texts in `LICENSES/`, `OFL.txt`, and `NOTICE.txt`, the page's legal notices under section 5(d) of
  the GPL-3.0. "Licences" at the foot of the page opens `NOTICE.txt`, and "Source" opens the
  source the build was made from, which the build bakes into the page: neither link needs a
  request to show.
- **The app image** holds `web/public/licenses/` with the rest of `web/public`.
- **The indexer image** holds `LICENSE`, this file and `LICENSES/` beside `indexer.mjs`. It carries
  no GPL-3.0 code.

## Corresponding Source

The Corresponding Source of the page as served is:

- **SolidPool's source for the build**, at the page's Source link: `SOURCE_URL`, which every
  production build and server requires, names the exact commit or tag the build was made from.
  The build bakes it into the page and into `NOTICE.txt`, and a server started with another stops.
  That source holds the lockfiles, `package-lock.json` and `web/package-lock.json`, which pin every
  package by version and integrity hash, and the build's configuration, `web/next.config.ts` and
  `web/Dockerfile`.
- **The GPL-3.0 packages**, at the versions the lockfiles pin:

<!-- notices:corresponding-source:start: made by `npm run notices` (scripts/notices/); change the tool, not this block -->

| Package | Version | Source |
| --- | --- | --- |
| circomlibjs | 0.1.7 | [circomlibjs-0.1.7.tgz](https://registry.npmjs.org/circomlibjs/-/circomlibjs-0.1.7.tgz): `src/` |
| ffjavascript | 0.2.63 | [ffjavascript-0.2.63.tgz](https://registry.npmjs.org/ffjavascript/-/ffjavascript-0.2.63.tgz): `main.js`, `src/` and the rollup configuration that build `build/browser.esm.js`, with wasmcurves and wasmbuilder |
| websnark | 0.0.4 | [tornadocash/websnark at 4c0af6a](https://github.com/tornadocash/websnark/tree/4c0af6a8b65aabea3c09f377f63c44e7a58afa6d): `main.js`, `src/` and `tools/` build `build/websnark.js`, which holds the snarkjs files it uses as readable source |
| snarkjs | four files of a release older than the installed one, inside websnark | [tornadocash/snarkjs at 869181c](https://github.com/tornadocash/snarkjs/tree/869181cfaf7526fe8972073d31655493a04326d5): inside websnark's `build/websnark.js`, as readable source; the lockfile's snarkjs is this commit |
| wasmbuilder | 0.0.16, inside ffjavascript | [wasmbuilder-0.0.16.tgz](https://registry.npmjs.org/wasmbuilder/-/wasmbuilder-0.0.16.tgz) |
| wasmcurves | 0.2.2, inside ffjavascript | [wasmcurves-0.2.2.tgz](https://registry.npmjs.org/wasmcurves/-/wasmcurves-0.2.2.tgz) |

<!-- notices:corresponding-source:end -->

- **The prover files**, `web/public/prover/withdraw.json` and `withdraw_proving_key.bin`, are
  tornado-core's [v2.1 release](https://github.com/tornadocash/tornado-core/releases/tag/v2.1)
  assets. The circuit is circom 0.0.35's compilation of `circuits/withdraw.circom` and
  `circuits/merkleTree.circom` at that tag, with circomlib's templates from
  [tornadocash/circomlib at c372f14](https://github.com/tornadocash/circomlib/tree/c372f14d324d57339c88451834bf2824e73bbdbc).
  The proving key is the output of Tornado's 2020 trusted-setup ceremony for that circuit, in the
  layout websnark's `tools/buildpkey.js` writes.

[PRODUCTION.md](PRODUCTION.md) says what an operator keeps available, and for how long.

## What ships where

| | What it holds | Third-party content |
| --- | --- | --- |
| **The page**, served to every browser | `web/.next/static`, its JavaScript chunks and stylesheet, and `web/public` | the packages below marked P, the fonts, the prover files, the images |
| **The app image** (`web/Dockerfile`) | `node:22-bookworm-slim`, Next's standalone server and the page | the page's packages again, bundled into the server chunks; Next's precompiled server dependencies; the packages the server trace copies |
| **The indexer image** (`Dockerfile`) | `node:22-bookworm-slim`, `indexer.mjs` and the whole `@bitauth/libauth` package | SolidCash with antlr4 and semver, mem-cash, noble, fflate and libauth |
| **The repository** | the committed files | the prover files, the fonts, `packages/verifier`, the images |

The tables below mark where each component ships: **P** the page, **A** the app image, **I** the
indexer image. Every part of the page is in the app image too. The base image's Debian packages
and its Node.js are listed under The base image.

## The GPL-3.0 code

The page runs code of six projects under the GPL-3.0. Their source files say "version 3 of the
License, or (at your option) any later version"; circomlibjs's say nothing.

| Component | In the page |
| --- | --- |
| websnark | `build/websnark.js`, loaded when a proof is made (`web/src/prover.ts`), in a chunk of its own |
| snarkjs | four files inside websnark's build: `bigint`, `calculateWitness`, `circuit`, `stringifybigint` |
| circomlibjs | `src/pedersen_hash.js` and `src/babyjub.js`, which `web/src/note.ts` imports |
| ffjavascript | `build/browser.esm.js`, which circomlibjs imports |
| wasmcurves, wasmbuilder | inside ffjavascript's browser build |

Their versions and copyright holders are in the inventory below.

- circomlibjs and ffjavascript share a chunk with SolidPool's engine and SolidCash.
- websnark's build is a browserify bundle. Besides the snarkjs files it holds the WebAssembly prover
  websnark generates from its own code, big-integer (Unlicense) and browserify's copies of assert,
  util, inherits, buffer, base64-js, ieee754, object-assign and process.
- Which snarkjs and big-integer releases went into `build/websnark.js` is not recorded. Three of
  the four snarkjs files differ from the lockfile's snarkjs. All four are in the bundle as readable
  source.
- The app image carries all six again: its server chunks bundle the page's modules.
- circomlibjs's licence is its `package.json` field: neither the package nor its repository has a
  licence text. Some of its sources name "Copyright (c) 2018 Jordi Baylina"; the two the page loads
  name no one.
- The prover files are GPL-3.0 too. tornado-core's LICENSE file is the GPL-3.0, though its
  `package.json` says ISC; circomlib's files are GPL-3.0, version 3 or later. tornado-core's
  Solidity files say MIT, and SolidPool ships none of them.

## WalletConnect

`@walletconnect/core`, `sign-client`, `types` and `utils` are pinned to 2.21.8, under the
Apache-2.0; from 2.21.9 on they are under Reown's WalletConnect Community License Agreement, which
is not open source. The page loads them, from chunks of their own, when a person pairs a wallet,
and the app image's server chunks carry them too. The other `@walletconnect/*` packages are MIT.

## The verifier

`packages/verifier` is vendored from mr-zwets/groth16_cashscript, branch `shared-verifier`
(`packages/verifier/SOURCE.json`), under the ISC licence its `package.json` declares; that
repository has no LICENSE file. It ships in the page and both images, and the verifier coins on
chain run its output. Its `vk-3in.json` is Tornado's verifying key.

## Inventory

Versions are the lockfiles'. A component inside another's prebuilt file has that file's version,
as far as it can be told. LICENSES/third-party.txt has each one's full notice.

<!-- notices:inventory:start: made by `npm run notices` (scripts/notices/); change the tool, not this block -->

The page carries 106 third-party components, the app image 183 and the indexer image 28, by
name and version, counting code that other packages embed. **P** marks the page, **A** the app
image, **I** the indexer image; a version "in" a package is a copy that package's own files carry.

`Inventory inputs: 158905ee506a127f142b8774531eceeb06e3b2901c36e34abc51757b22939ab8 package-lock.json=530fd51c715df6d7 web/package-lock.json=df4e28fa91c579a5 scripts/notices/config.json=8f1d581781ec6dcf`

### GPL-3.0

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| circomlibjs | 0.1.7 | P A | 2018 Jordi Baylina |
| ffjavascript | 0.2.63 | P A | 2020 0Kims Association |
| snarkjs | four files of a release older than the installed one (in websnark) | P A | 2018 0kims association |
| wasmbuilder | 0.0.16, 0.0.16 (in ffjavascript) | P A | 2019 0KIMS association |
| wasmcurves | 0.2.2, 0.2.2 (in ffjavascript) | P A | 2020 0Kims Association |
| websnark | 0.0.4 | P A | 2018 0kims association; 2019 0KIMS association |

### Apache-2.0

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| b4a | 1.9.0 | P A | none published |
| fast-jwt (vendored by next) | — | A | 2020-2021 nearForm |
| idb-keyval | 6.3.0 | P A | 2016, Jake Archibald |
| @opentelemetry/api (vendored by next) | — | A | none published |
| @swc/helpers | 0.5.23 | P A | 2024 SWC contributors |
| @vercel/detect-agent (vendored by next) | — | A | 2017 Vercel, Inc |
| @walletconnect/core | 2.21.8 | P A | 2021 WalletConnect, Inc |
| @walletconnect/sign-client | 2.21.8 | P A | 2021 WalletConnect, Inc |
| @walletconnect/types | 2.21.8 | P A | 2021 WalletConnect, Inc |
| @walletconnect/utils | 2.21.8 | P A | 2021 WalletConnect, Inc |
| web-worker | 1.2.0, 1.2.0 (in ffjavascript) | P A | 2020 Google LLC |

### BSD-2-Clause

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| arrayref (Rust crate) | 0.3.4 (in @bitauth/libauth) | P A I | 2015 David Roundy |

### BSD-3-Clause

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| antlr4 | 4.13.2 | A I | 2012-2022 The ANTLR Project |
| @hapi/accept (vendored by next) | — | A | 2014-2020, Sideway Inc, and project contributors; 2015-2016, Mark Bradshaw; 2014, Walmart |
| ieee754 | 1.1.x (in websnark) | P A | 2008 Fair Oaks Labs, Inc |
| source-map (vendored by next) | — | A | 2009-2011, Mozilla Foundation and contributors |

### (Apache-2.0 AND MIT)

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| multiformats | 9.9.0, 9.9.0 (in @walletconnect/relay-auth), 9.9.0 (in @walletconnect/core) | P A | 2020 Protocol Labs |

### ISC

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| blake2b | 2.1.4 | P A | 2017, Emil Bay github@tixz.dk |
| inherits | 2.0.4, 2.0.x (in websnark) | P A | Isaac Z. Schlueter |
| @msgpack/msgpack | 3.1.2 | P A | 2019 The MessagePack Community |
| nanoassert | 2.0.0 | P A | 2017, Emil Bay |
| semver | 7.8.6 | P A I | Isaac Z. Schlueter and Contributors |
| semver (vendored by next) | — | A | Isaac Z. Schlueter and Contributors |
| write-file-atomic (vendored by next) | — | A | 2015, Rebecca Turner |

### MIT

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| assert | 1.x (in websnark) | P A | Joyent, Inc. and other Node contributors; 2009 Thomas Robinson |
| async-retry (vendored by next) | — | A | 2017 ZEIT, Inc |
| async-sema (vendored by next) | — | A | 2017, 2018 Zeit, Inc; 2013 Petka Antonov (For the Deque library) |
| atomic-sleep | 1.0.0 | A | 2020 David Mark Clements |
| base-x | 5.0.1 | P A | 2018 base-x contributors; 2014-2018 The Bitcoin Core developers |
| base64-js | 1.x (in websnark) | P A | 2014 Jameson Little |
| @bitauth/libauth | 3.1.0-next.8 | P A I | Jason Dreyzehner |
| blake-hash | 2.0.0 | P A | none published |
| blake2b-wasm | 2.4.0 | P A | 2017 Mathias Buus |
| blakejs | 1.2.1 | P A | 2022 Blakejs contributors |
| bs58 | 6.0.0 | P A | 2018 cryptocoinjs |
| buffer | 5.x (in websnark) | P A | Feross Aboukhadijeh, and other contributors |
| buffer (vendored by next) | — | P A | Feross Aboukhadijeh, and other contributors |
| bufferutil | 4.1.0 | A | 2011 Einar Otto Stangvik; 2013 Arnout Kazemier and contributors; 2016 Luigi Pinca and contributors |
| busboy (vendored by next) | — | A | Brian White |
| bytes (vendored by next) | — | A | 2012-2014 TJ Holowaychuk; 2015 Jed Watson |
| ci-info (vendored by next) | — | A | 2016-2018 Thomas Watson Steen |
| client-only | 0.0.1 | A | none published |
| commander (vendored by next) | — | A | 2011 TJ Holowaychuk |
| comment-json (vendored by next) | — | A | 2013 kaelzhang, contributors |
| compression (vendored by next) | — | A | 2014 Jonathan Ong; 2014-2015 Douglas Christopher Wilson |
| conf (vendored by next) | — | A | Sindre Sorhus (sindresorhus.com) |
| content-disposition (vendored by next) | — | A | 2014-2017 Douglas Christopher Wilson |
| cookie (vendored by next) | — | A | 2012-2014 Roman Shtylman; 2015 Douglas Christopher Wilson |
| core-js | 3.38.1 (in next) | P A | 2014-2024 Denis Pushkarev |
| cross-spawn (vendored by next) | — | A | 2018 Made With MOXY Lda |
| debug (vendored by next) | — | A | 2014 TJ Holowaychuk |
| destr | 2.0.5 | P A | Pooya Parsa |
| detect-browser | 5.3.0 | P A | 2019 Damon Oehlman |
| dijkstrajs | 1.0.3 | P A | 2008 |
| edge-runtime (vendored by next) | — | A | 2024 Vercel, Inc |
| @edge-runtime/cookies (vendored by next) | 6.0.0 | A | none published |
| @edge-runtime/ponyfill (vendored by next) | 4.0.0 | A | none published |
| @edge-runtime/primitives (vendored by next) | 6.0.0 | A | none published |
| es-toolkit | 1.39.3 (in @walletconnect/core) | P A | 2024 Viva Republica, Inc |
| events | 3.3.0 | P A | Joyent, Inc. and other Node contributors |
| fast-redact | 3.5.0 | A | 2019-2020 David Mark Clements |
| fflate | 0.8.3 | P A I | 2026 Arjun Barrett |
| find-up (vendored by next) | — | A | Sindre Sorhus (sindresorhus.com) |
| fresh (vendored by next) | — | A | 2012 TJ Holowaychuk; 2016-2017 Douglas Christopher Wilson |
| generic-array (Rust crate) | 0.9.0 (in @bitauth/libauth) | P A I | 2015 Bartłomiej Kamiński |
| hash.js (vendored by next) | — | A | Fedor Indutny, 2014 |
| httpxy (vendored by next) | — | A | Pooya Parsa; 2010-2016 Charlie Robbins, Jarrett Cruger & the Contributors |
| image-size (vendored by next) | — | A | 2013-Present Aditya Yadav, http://netroy.in |
| ipaddr.js (vendored by next) | — | A | 2011-2017 whitequark |
| is-animated (vendored by next) | — | A | 2016 Józef Sokołowski |
| is-docker (vendored by next) | — | A | Sindre Sorhus (sindresorhus.com) |
| is-wsl (vendored by next) | — | A | Sindre Sorhus (sindresorhus.com) |
| libsecp256k1 (bitauth/libauth-secp256k1) | — | P A I | 2013 Pieter Wuille |
| @mem-cash/core | 0.0.11 | P A I | 2026 mem-cash contributors |
| @mem-cash/electrum | 0.0.11 | P A I | 2026 mem-cash contributors |
| @mem-cash/storage | 0.0.11 | P A I | 2026 mem-cash contributors |
| @mem-cash/types | 0.0.11 | P A I | 2026 mem-cash contributors |
| @mem-cash/validation | 0.0.11 | P A I | 2026 mem-cash contributors |
| @mswjs/interceptors (vendored by next) | — | A | 2018–present Artem Zakharchenko |
| nanoid (vendored by next) | — | A | 2017 Andrey Sitnik |
| @napi-rs/triples (vendored by next) | — | A | 2020 LongYinan |
| next | 16.4.6 | P A | 2025 Vercel, Inc |
| @next/env | 16.4.6 | A | none published |
| @noble/ciphers | 1.3.0 (in @walletconnect/utils) | P A | 2022 Paul Miller; 2016 Thomas Pornin |
| @noble/curves | 1.9.1, 1.9.7, 2.2.0, 1.8.0 (in @walletconnect/relay-auth), 1.9.2 (in @walletconnect/utils) | P A I | 2022 Paul Miller |
| @noble/hashes | 1.8.0, 2.2.0, 1.7.0 (in @walletconnect/relay-auth), 1.8.0 (in @walletconnect/utils) | P A I | 2022 Paul Miller |
| node-gyp-build | 4.8.4 | A | 2017 Mathias Buus |
| object-assign | 4.x (in websnark) | P A | Sindre Sorhus (sindresorhus.com) |
| on-exit-leak-free | 0.2.0 | A | 2021 Matteo Collina |
| p-limit (vendored by next) | — | A | Sindre Sorhus |
| p-queue (vendored by next) | — | A | Sindre Sorhus |
| path-browserify (vendored by next) | — | A | 2013 James Halliday |
| path-to-regexp (vendored by next) | — | A | 2014 Blake Embrey (hello@blakeembrey.com) |
| picomatch (vendored by next) | — | A | 2017-present, Jon Schlinkert |
| pino | 7.11.0 | P A | 2016-2019 Matteo Collina, David Mark Clements and the Pino contributors |
| pino-std-serializers | 4.0.0 | A | Mateo Collina, David Mark Clements, James Sumners |
| pngjs | 5.0.0 | A | pngjs2 original work Copyright (c) 2015 Luke Page & Original Contributors; pngjs derived work Copyright (c) 2012 Kuba Niegowski |
| process | 0.11.x (in websnark) | P A | 2013 Roman Shtylman |
| process (vendored by next) | — | P A | 2013 Roman Shtylman |
| process-warning | 1.0.0 | A | Fastify |
| qrcode | 1.5.4 | P A | 2012 Ryan Day |
| quick-format-unescaped | 4.0.4 | P A | 2016-2019 David Mark Clements |
| react | 19.3.1 | A | Meta Platforms, Inc. and affiliates |
| react (vendored by next) | — | P A | Meta Platforms, Inc. and affiliates |
| react-dom | 19.3.1 | A | Meta Platforms, Inc. and affiliates |
| react-dom (vendored by next) | — | P A | Meta Platforms, Inc. and affiliates |
| react-is (vendored by next) | 19.3.0-canary-278794d7-20261002 | A | Meta Platforms, Inc. and affiliates |
| react-server-dom-turbopack (vendored by next) | — | P A | Meta Platforms, Inc. and affiliates |
| readable-stream | 3.6.2 | P A | Node.js contributors; Joyent, Inc. and other Node contributors |
| real-require | 0.1.0 | A | 2021 pino; 2021 Paolo Insogna and the real-require contributors |
| regenerator-runtime (vendored by next) | 0.13.4 | A | 2014-present, Facebook, Inc |
| safe-buffer | 5.1.2 | P A | Feross Aboukhadijeh |
| safe-stable-stringify | 2.5.0 | A | Ruben Bridgewater |
| scheduler (vendored by next) | — | P A | Meta Platforms, Inc. and affiliates |
| @scure/base | 1.2.6 | P A | 2022 Paul Miller |
| send (vendored by next) | — | A | 2012 TJ Holowaychuk; 2014-2022 Douglas Christopher Wilson |
| @solidcash/solidc | 0.51.1 | P A I | 2019 Rosco Kalis |
| @solidcash/solidcash | 0.51.1 | P A I | 2019 Rosco Kalis |
| @solidcash/utils | 0.51.1 | P A I | 2019 Rosco Kalis |
| sonic-boom | 2.8.0 | A | 2017 Matteo Collina |
| stacktrace-parser (vendored by next) | — | A | 2014-2019 Georg Tavonius |
| string_decoder | 1.1.1 | P A | Node.js contributors; Joyent, Inc. and other Node contributors |
| strip-ansi (vendored by next) | — | A | Sindre Sorhus (sindresorhus.com) |
| styled-jsx | 5.1.6 | A | 2016-present Vercel, Inc |
| superstruct (vendored by next) | — | A | &copy; 2017, [Ian Storm Taylor](https://ianstormtaylor.com) |
| text-table (vendored by next) | — | A | none published |
| thread-stream | 0.15.2 | A | 2021 Matteo Collina |
| ua-parser-js (vendored by next) | — | A | 2012-2021 Faisal Salman |
| uint8arrays | 3.1.1, 3.1.1 (in @walletconnect/relay-auth), 3.1.1 (in @walletconnect/core) | P A | none published |
| unstorage | 1.17.6, 1.17.6 (in @walletconnect/keyvaluestorage) | P A | Pooya Parsa |
| utf-8-validate | 5.0.10 | A | 2011 Einar Otto Stangvik |
| util | 0.10.x (in websnark) | P A | Joyent, Inc. and other Node contributors |
| util-deprecate | 1.0.2 | P A | 2014 Nathan Rajlich |
| viem | 2.31.0 | P A | 2023-present weth, LLC |
| @walletconnect/environment | 1.0.1 | P A | 2022 WalletConnect, Inc |
| @walletconnect/events | 1.0.1 | P A | 2022 WalletConnect, Inc |
| @walletconnect/heartbeat | 1.2.2 | P A | 2022 WalletConnect, Inc |
| @walletconnect/jsonrpc-provider | 1.0.14 | P A | 2022 WalletConnect, Inc |
| @walletconnect/jsonrpc-types | 1.0.4 | P A | 2022 WalletConnect, Inc |
| @walletconnect/jsonrpc-utils | 1.0.8 | P A | 2022 WalletConnect, Inc |
| @walletconnect/jsonrpc-ws-connection | 1.0.16 | P A | 2022 WalletConnect, Inc |
| @walletconnect/keyvaluestorage | 1.1.1 | P A | 2022 WalletConnect |
| @walletconnect/logger | 2.1.2 | P A | 2022 WalletConnect, Inc |
| @walletconnect/relay-api | 1.0.11 | P A | 2022 WalletConnect, Inc |
| @walletconnect/relay-auth | 1.1.0 | P A | 2022 WalletConnect, Inc |
| @walletconnect/safe-json | 1.0.2 | P A | 2022 WalletConnect, Inc |
| @walletconnect/time | 1.0.2 | P A | 2022 WalletConnect, Inc |
| @walletconnect/window-getters | 1.0.1 | P A | 2022 WalletConnect, Inc |
| @walletconnect/window-metadata | 1.0.1 | P A | 2022 WalletConnect, Inc |
| watchpack (vendored by next) | — | A | JS Foundation and other contributors |
| why-is-node-running | 3.2.1 | A | 2016 Mathias Buus |
| ws | 7.5.14 | P A | 2011 Einar Otto Stangvik |
| ws (vendored by next) | — | A | 2011 Einar Otto Stangvik |
| zod (vendored by next) | — | A | 2025 Colin McDonnell |
| zod-validation-error (vendored by next) | — | A | 2022 Causaly, Inc |

### MIT (part of next)

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| image-detector (vendored by next) | — | A | none published |
| next-server (vendored by next) | — | A | none published |

### MIT OR Apache-2.0

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| block-buffer (Rust crate) | 0.3.3 (in @bitauth/libauth) | P A I | 2017 Artyom Pavlov |
| byte-tools (Rust crate) | 0.2.0 (in @bitauth/libauth) | P A I | 2006-2009 Graydon Hoare; 2009-2013 Mozilla Foundation |
| digest (Rust crate) | 0.7.2 (in @bitauth/libauth) | P A I | 2017 Artyom Pavlov |
| fake-simd (Rust crate) | 0.1.2 (in @bitauth/libauth) | P A I | 2006-2009 Graydon Hoare; 2009-2013 Mozilla Foundation |
| ripemd160 (Rust crate) | 0.7.0 (in @bitauth/libauth) | P A I | 2006-2009 Graydon Hoare; 2009-2013 Mozilla Foundation; 2016 Artyom Pavlov |
| sha-1 (Rust crate) | 0.7.0 (in @bitauth/libauth) | P A I | 2006-2009 Graydon Hoare; 2009-2013 Mozilla Foundation; 2016 Artyom Pavlov |
| sha2 (Rust crate) | 0.7.1 (in @bitauth/libauth) | P A I | 2006-2009 Graydon Hoare; 2009-2013 Mozilla Foundation; 2016 Artyom Pavlov |
| typenum (Rust crate) | 1.10.0 (in @bitauth/libauth) | P A I | 2014 Paho Lurie-Gregg |
| wasm-bindgen (Rust crate) | 0.2.11 (in @bitauth/libauth) | P A I | 2014 Alex Crichton |

### 0BSD

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| tslib | 1.14.1 | P A | Microsoft Corporation |

### BlueOak-1.0.0

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| tar (vendored by next) | — | A | none published |

### CC0-1.0

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| string-hash (vendored by next) | — | A | none published |

### Unlicense

| Component | Version | Where | Copyright |
| --- | --- | --- | --- |
| big-integer | older than the installed one (in websnark) | P A | none published |

### Licence texts the packages leave out

| Component | Licence | In third-party.txt |
| --- | --- | --- |
| antlr4 4.13.2 | BSD-3-Clause | its repository's: https://raw.githubusercontent.com/antlr/antlr4/4.13.2/LICENSE.txt |
| blake-hash 2.0.0 | MIT | none published |
| circomlibjs 0.1.7 | GPL-3.0 | none published |
| client-only 0.0.1 | MIT | none published |
| @edge-runtime/cookies (vendored by next) 6.0.0 | MIT | none published |
| @edge-runtime/ponyfill (vendored by next) 4.0.0 | MIT | none published |
| @edge-runtime/primitives (vendored by next) 6.0.0 | MIT | none published |
| @mem-cash/core 0.0.11 | MIT | its repository's: https://raw.githubusercontent.com/mainnet-pat/mem-cash/master/LICENSE |
| @mem-cash/electrum 0.0.11 | MIT | its repository's: https://raw.githubusercontent.com/mainnet-pat/mem-cash/master/LICENSE |
| @mem-cash/storage 0.0.11 | MIT | its repository's: https://raw.githubusercontent.com/mainnet-pat/mem-cash/master/LICENSE |
| @mem-cash/types 0.0.11 | MIT | its repository's: https://raw.githubusercontent.com/mainnet-pat/mem-cash/master/LICENSE |
| @mem-cash/validation 0.0.11 | MIT | its repository's: https://raw.githubusercontent.com/mainnet-pat/mem-cash/master/LICENSE |
| @next/env 16.4.6 | MIT | none published |
| string-hash (vendored by next)  | CC0-1.0 | none published |
| uint8arrays 3.1.1 | MIT | its repository's: https://raw.githubusercontent.com/achingbrain/uint8arrays/main/LICENSE-MIT |

<!-- notices:inventory:end -->

The built files keep none of the notices themselves: the page's minified chunks keep no licence
comments, Next's standalone trace keeps one licence file, node-gyp-build's, and
`@bitauth/libauth` embeds WebAssembly built from libsecp256k1 and from Rust crates without their
licences. The notices ship as How the notices ship says.

## Fonts

| Font | Version | Copyright | Licence |
| --- | --- | --- | --- |
| Fraunces | 1.000 | 2020 The Fraunces Project Authors | OFL-1.1 |
| Inter | 4.001 | 2016 The Inter Project Authors | OFL-1.1 |
| JetBrains Mono | 2.211 | 2020 The JetBrains Mono Project Authors | OFL-1.1 |

They are the latin subsets Google Fonts serves, in the repository and served byte for byte (P A).
None names a Reserved Font Name. Each file's name table holds its copyright line and the
licence's address, not its text; `web/app/fonts/OFL.txt` holds the text.

## The base image

`node:22-bookworm-slim`, pinned by digest, in both images: Debian 12 packages under their own
licences, among them the GPL-2.0, GPL-3.0 and LGPL, and Node.js 22, under the MIT licence with its
bundled libraries under theirs. The Dockerfiles remove npm, corepack and yarn. Not inspected here;
an SBOM of a built image would list it.

## Images

- `web/public/bch.svg` is the Bitcoin Cash symbol. Where it came from is not recorded.
- `web/app/icon.svg`, `apple-icon.png`, `opengraph-image.png` and `twitter-image.png`, and
  `web/public/icon-512.png` and `solidpool-announcement.png`, are SolidPool's own, by the history.

## Remaking it

`npm run notices` (`scripts/notices/`) makes `LICENSES/third-party.txt` and the two blocks above
that it marks: it builds the page and the indexer as the images do, reads what each ships, and
takes each component's licence text from its package, or, where a package ships none, from the
source `scripts/notices/config.json` names. Run it after any dependency change, as PRODUCTION.md
says. The blocks and `LICENSES/third-party.txt` name the hash of the lockfiles and `config.json`
they were made from; `npm run notices:check`, part of `npm test`, fails when those have changed
since.
