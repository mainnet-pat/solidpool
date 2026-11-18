# @solidpool/verifier

The BN254 Groth16 verifier the pools run, written in BCH Script: the `bn-native-sound`
construction of [groth16_cashscript](https://github.com/mr-zwets/groth16_cashscript)
(verifier.cash), extended to three runtime public inputs and composed with a pool. It is vendored
here so that the app, the tests and the service's verifier scripts build from this repository
alone.

**Source.** `chunked/bn254` of groth16_cashscript, branch `shared-verifier`. `SOURCE.json`
names the commit and lists the files, which are byte for byte that commit's:

- `bn-native-sound/runtime.mjs` and `runtime.d.ts`, the package's entry. It uses no Node built-in or
  Node-only global, so the browser and Node load the same code.
- The modules the entry and `service/verifier/*.ts` reach: `asm`, `kernels`, `protocol`,
  `script`, `transaction` and `vm` in `bn-native-sound/`, `math` and `protocol` in
  `sound-si-gls/`, `assert.mjs`, `bytes.mjs`, and `vk-3in.json`, the production verifying key. `npm run verifier:check` holds that key to
  `service/verifier/tornado-bn254-3in.json`.
- `bn-native-sound/README.md`, the construction and its soundness argument. The research scripts
  it names (`build.mjs`, `export.mjs`, `profile.mjs`, `redteam.mjs`, `sweep.mjs`,
  `test-key.mjs`, and `../sound-si-gls/mint.mjs`) stay upstream, with their key switch
  `fixtures-env.mjs`, which `sound-si-gls/math.mjs` mentions, and the upstream package's
  `./node` export. This repository's scripts set the key as math.mjs's comment says, through
  `globalThis.__BN_VK_FIXTURES__`.

**Changes from verifier.cash.** verifier.cash is groth16_cashscript's `main`. `SOURCE.json`
names the commit this copy forked from as `upstream`, and each file's status against it:
`kernels.mjs` is unchanged; `runtime.mjs`, `runtime.d.ts`, `assert.mjs`, `bytes.mjs` and
`vk-3in.json` are new; the other eight changed, and `verifier.cash.diff` is their diff from that
commit. `SOURCE.json` lists the eight commits that make the changes as `changes`:

- `64d4e57` binds a third runtime public input, the withdrawal's recipient (`protocol.mjs` and
  `script.mjs`, and `math.mjs` and `protocol.mjs` in `sound-si-gls/`);
- `4475ba8` composes the verifier with a pool in one transaction (`protocol.mjs`, `script.mjs`,
  `vm.mjs`);
- `bcfc3fb` makes the runtime environment-neutral and ships the key as data (the five new files,
  and all eight changed ones);
- `519c7cd` sizes the fillers once on a libauth that already charges `OP_DEFINE` bodies
  (`transaction.mjs`, `vm.mjs`, `runtime.mjs`, `runtime.d.ts`, `README.md`);
- `be700ce` lets the upstream Node tools choose the key again (`sound-si-gls/math.mjs`);
- `2aa8ddd` shares one verifier among all pools: the code names no pool, so its lock is the same
  for every pool, and the redeem gains a sweep branch that lets anyone take a coin unmoved for
  1,440 blocks, as its transaction's only input (`script.mjs`, `protocol.mjs`, `vm.mjs`,
  `runtime.mjs`, `runtime.d.ts`, `transaction.mjs`, `README.md`);
- `57c0d9e` names the shipped key's source by its content rather than a local path
  (`vk-3in.json`);
- `61c5666` merges `57c0d9e`'s branch, `browser-native-verifier`, into `shared-verifier`.

**Licence.** ISC, as groth16_cashscript's `package.json` declares. That repository has no LICENSE
file or copyright line.

**Dependencies.** `@noble/curves` and `@noble/hashes` 2.2.0, as upstream pins them. libauth is a
peer: the verifier runs on this project's copy, the one the app bundles. That copy does not charge
`OP_DEFINE` bodies as BCHN does, and the prover measures that and sizes the same fillers either
way. `test:verifier-sizing` checks it on a temporary copy patched to charge them, which also
spends the production proof at BCHN's op cost.

**Updating.** `node scripts/vendor-verifier.mjs <groth16_cashscript checkout> [verifier.cash
commit]` copies the same set from a clean checkout, records its commit and where it forked from
verifier.cash (by default from the checkout's `origin/main`), rewrites `verifier.cash.diff`, and
reports a dependency that upstream pins differently from `package.json` here. Then bring this
README's account of the changes up to date, and run `npm run verifier:check` and `npm test`.
