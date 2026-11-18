# SolidPool Terms

The page shows these Terms: `TERMS` in `web/components/markup.ts`, at `TERMS_VERSION`
`2026-11-18`. A browser that accepted another version is asked again, so a change to the text
needs a new dated version. `test/terms-doc.ts` checks that this file and the page say the same.

No lawyer has reviewed this text yet. [PRODUCTION.md](../PRODUCTION.md) lists that review among
what blocks mainnet.

## The text

1. **SolidPool is experimental software for private payments on Bitcoin Cash, built with
   SolidCash.** It is provided as is, without warranties of any kind. This website may stop working
   at any time. The pools do not depend on it: they run on chain, and a note can still be withdrawn
   through another copy of this software, or any other that follows the pools' rules.

2. **Where this website may not be used.** This website is not offered in the United States, the
   European Union or the United Kingdom. You may not use it if you are located or resident in the
   United States or its territories, in a member state of the European Union, or in the United
   Kingdom, or if you act for a company or other organisation established in any of them. You also
   may not use it from a country or region under comprehensive sanctions of the United Nations, the
   United States, the European Union or the United Kingdom, or if you are named on any of their
   sanctions lists. Do not hide where you are, with a VPN or otherwise, to use it.

3. No person has audited the contracts or the proof verifier as they are used here, nor the
   SolidCash compiler that builds them. The contracts and the verifier have had AI reviews only,
   which are not a human audit and cannot rule out bugs. A contract cannot be changed or fixed once
   it is deployed, so a bug could cost every deposit in a pool. Do not deposit more than you can
   afford to lose.

4. SolidPool is non-custodial software. The authors never hold your keys or your funds. A deposit
   goes into a pool contract on Bitcoin Cash, and nobody holds a key to it: not the authors, not
   whoever runs this website, and not whoever created the pool. The contracts have no owner, pay no
   fee to the authors, and cannot be upgraded or paused. Nobody can change a pool's rules, reverse a
   transaction or recover a deposit.

5. There is no service fee: nothing is paid to the authors, to this website or to a pool's creator.
   A note costs about 0.0022 BCH (220,000 satoshis) in network fees at today's minimum fee rate,
   whatever its amount, so small pools lose a large share: about 22% of a 0.01 BCH note. The deposit
   pays it all at once: its own fee, and the fees of the two later steps, which are fixed in each
   pool's code.

6. Anyone can create a pool through the pool factories, for BCH or for any CashToken, in any fixed
   amount that has no pool yet. Its creator pays for the coins it opens with, which stay in it for
   good, and gains no control over it. SolidPool does not check who issued a token or what it is
   worth, and token names and icons come from published metadata that the page cannot vouch for.

7. You decide how you use this software, and you are responsible for following the laws that apply
   to you. Do not use it if that is illegal where you are, if you are subject to sanctions, or to
   handle the proceeds of crime. The authors do not direct, review or approve what anyone does with
   it.

8. Your note is the only way to get a deposit back: anyone who has it can withdraw the deposit, and
   if you lose it, nobody can recover it for you. The note is made in your browser by the code this
   website sends, so a website that changed that code could take it. The page never stores your
   note: save it before you deposit, and keep it secret. A note has no checksum, so a mistyped one
   looks like a note that is not in the pool. A copied note stays on your clipboard until something
   replaces it. If the page cannot tell whether a deposit went through, keep the note.

9. Blockchain transactions are irreversible. Verify the network, pool and recipient before you
   confirm. Mainnet spends real BCH. Chipnet, and the Devnet that only test deployments offer, use
   test coins with no value.

10. The page sees the chain only through the chain servers (Fulcrum) it connects to, and this
    release takes one server's word on which pools the pool factories made. A server that lies could
    show you a pool made outside the factories, whose maker can take everything deposited in it. A
    server can also refuse to answer, or hold back what you send. Use a server you trust or, better,
    run your own node and Fulcrum server.

11. Anyone willing to pay can delay deposits and withdrawals, by moving the coins they spend while
    they are being made, and on a busy pool a deposit can lose a race with another. A delayed
    deposit may have to start again with a new note. A pool takes one deposit at a time, so the page
    may also send, by itself and at no cost to you, the prepaid step that finishes someone else's
    deposit. Anyone can also fill a pool's addresses with junk until servers with common settings
    stop answering for it. No funds move, but a withdrawal may then need a server set up with higher
    limits.

12. Withdrawals rely on a circuit and a trusted setup that another project, which SolidPool is not
    affiliated with, made and published, and SolidPool reuses them unchanged. If none of that
    setup's contributors destroyed their secret, or if the file it started from came from somewhere
    else, which can no longer be checked, whoever can rebuild the setup's secret could withdraw from
    any pool without a note.

13. Privacy is not guaranteed. A pool hides which deposit a withdrawal spends only among the notes
    in that pool, so a pool with few notes hides little. You can also link your own deposit and
    withdrawal: by withdrawing soon after you deposit, by withdrawing to an address tied to you, or
    by paying a fee from a wallet tied to the other side. The servers the page uses also see what it
    asks them, as set out below.

14. **What this page keeps, and who sees what.** SolidPool has no accounts, and the page runs no
    analytics or tracking code. It keeps these in this browser only: your settings, whether you
    accepted these terms, pools you created here, the wallet extension you last used, token details,
    and chain data it has read and checked; on a Devnet, also a test account's key. Reset stored
    data, in Settings, removes them. No server records that you accepted these terms. If you pair a
    wallet through WalletConnect, its software keeps data of its own in this browser.

15. Every server the page contacts sees your IP address and when you use it: this website; the chain
    servers you choose, which also see every coin, pool and transaction the page reads for you; the
    fast indexer, which the page reads only if you choose it in Settings; the token-details service
    (Paytaca's by default), the hosts token issuers name, and public IPFS gateways; WalletConnect's
    servers, if you pair a wallet through it; and whoever serves the proving files, who can tell
    when this browser makes its first withdrawal. Apart from this website, these are third parties
    with their own policies, and any of them may keep logs. One server that handled both your
    deposit and your withdrawal could link the two, so the page normally sends withdrawals through a
    second server, though two operators could still compare what they saw. Everything sent to the
    blockchain is public for good.

16. These terms cover your use of this website. They do not limit what the licences of SolidPool's
    software let you do with that software: see Licences at the foot of the page.

17. To the fullest extent the law allows, the authors are not responsible for any loss of funds or
    for any other financial decision you make. By using this app you accept these terms, and you use
    it at your own risk.

## Where each statement comes from

Paths and lines are at `88bbd4a`.

| ¶ | Statement | Source |
|---|---|---|
| 1 | The pools need no website; a note withdraws through any software that follows their rules | `README.md:45-49`, `README.md:409-413`, `scripts/withdraw-note.ts` |
| 2 | Where this website may not be used | The project's decision of 2026-11-18, not a statement of fact |
| 3 | No human audit of the contracts or the verifier as used, AI reviews only | `README.md:11-21`, `PRODUCTION.md:89-114`, `AUDIT.md:16-41` and `63-72`, `contracts/AUDIT-2026-11-17.md`, `contracts/AUDIT-2026-11-17-factories.md` |
| 3 | SolidCash has had no outside audit | `PRODUCTION.md:133-134` |
| 3 | A deployed contract cannot be fixed | `AUDIT.md:11-12` |
| 4 | No owner, no key, no upgrade or pause | `contracts/BchPool.scash:21-23`, `contracts/BchPoolDeployer.scash:35-38`, `contracts/TokenPoolDeployer.scash:46-49`; the ABIs in `contracts/artifacts/solidcash/`: a pool has `deposit`, `finish`, `withdraw` and its one-shot constructor, a factory `create` |
| 5 | No service fee | `README.md:80-81`, `web/components/ui.ts:528` |
| 5 | About 0.0022 BCH a note, 22% of 0.01 BCH | `README.md:77-83` |
| 5 | Later fees fixed in each pool's code | `contracts/BchPool.scash:48-49` and `149`, `contracts/TokenPool.scash:54-55` and `171`, `PRODUCTION.md:162` |
| 6 | Permissionless creation, one pool per amount, no control for the creator, opening coins kept | `README.md:127-133`, `188-190` and `194-198`, `contracts/BchPool.scash:52-53`, `PRODUCTION.md:273-275` |
| 6 | Token metadata is not vouched for | `web/src/bcmr.ts:1-19` |
| 8 | The note is made by the code the site sends, and a changed page can take it | `web/proxy.ts:3-5`, `PRODUCTION.md:188-189`, `README.md:407` |
| 8 | Notes are never stored | `web/components/markup.ts:272`, `web/components/ui.ts:1870-1882` |
| 8 | No checksum; the clipboard keeps a note | `PRODUCTION.md:419-422` |
| 8 | Keep the note when an outcome is unknown | `ARCHITECTURE.md:145-148`, `web/src/engine.ts:708-714` |
| 9 | The networks | `web/lib/deployment.ts:128-141`, `web/components/markup.ts:241`, `PRODUCTION.md:287`, `297` and `321-322` |
| 10 | One server decides which pools exist; a lying one can show a pool whose maker takes its deposits | `README.md:25-41` and `396-408`, `PRODUCTION.md:19-31`, `AUDIT.md:134-137`, `ARCHITECTURE.md:140-144` |
| 11 | Paid delays of deposits and withdrawals | `PRODUCTION.md:367-383`, `AUDIT.md:138-156` |
| 11 | Lost races | `PRODUCTION.md:348-353` |
| 11 | The page finishes another person's deposit by itself | `web/components/ui.ts:711-724`, `web/src/engine.ts:661-663`, `ARCHITECTURE.md:152-153` |
| 11 | History padding, and a server with higher limits as the remedy | `PRODUCTION.md:384-418` |
| 12 | The inherited trusted setup and its assumptions | `AUDIT.md:183-189`, `PRODUCTION.md:60`, `README.md:7-9` and `416`, `PORT.md:1-5` |
| 13 | A pool hides a note only among its own notes | `contracts/BchPool.scash:54-55`, `web/components/ui.ts:76-77` |
| 13 | A person can link their own two sides | `web/components/markup.ts:86-87`, `web/components/ui.ts:1643-1647` |
| 14 | What the browser keeps | `web/components/ui.ts:20-27`, `306-316`, `1165-1188` and `1917-1923`, `web/src/bcmr.ts:6`, `web/src/cache.ts:1-4`, `web/src/wallet.ts:10-21`, `web/lib/deployment.ts:211-214` |
| 14 | No analytics or tracking code | none in `web/`; `web/proxy.ts:8-10` runs only the site's own scripts; `web/src/wallet.ts:63` turns WalletConnect's telemetry off; `README.md:382-384` (Next's telemetry off) |
| 14 | WalletConnect keeps its own data | `@walletconnect/keyvaluestorage`, an IndexedDB store; Settings' reset ends the session (`web/src/wallet.ts:105`) but does not delete the store |
| 15 | Servers see the IP address and what is read | `README.md:29-31` and `36-41`, `PRODUCTION.md:23-24` and `211-217`, `AUDIT.md:122-124` |
| 15 | The fast indexer is read only when chosen; Trustless is the default | `web/components/ui.ts:533-541` |
| 15 | Token-details service, issuers' hosts, IPFS gateways | `web/lib/deployment.ts:201`, `web/src/bcmr.ts:5-17` and `43-45`, `web/proxy.ts:13-14` |
| 15 | WalletConnect's servers | `web/lib/deployment.ts:208-209`, `web/proxy.ts:15-17` |
| 15 | The proving files mark a first withdrawal | `web/lib/deployment.ts:202-205`, `PRODUCTION.md:215-217` |
| 15 | A second server for withdrawals | `web/components/ui.ts:165-176`, `web/components/markup.ts:266-267`, `PRODUCTION.md:288` |
| 16 | The software's licences | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `LICENSES/` |

## What changed from the 2026-11-06 text

- "a demonstration of what SolidCash contracts can do" became experimental software: the README
  and the page's title present SolidPool as private payments on Bitcoin Cash.
- "It has not been audited yet" became what exists: AI reviews only, no human audit of the
  contracts or the verifier as used, none of SolidCash.
- "only its note can withdraw it" was dropped. It is the design's aim, but a lying chain server
  (¶10) and a compromised setup (¶12) each break it, and so could a bug (¶3).
- Added: where this website may not be used (¶2), costs (¶5),
  pool creation and tokens (¶6), how the note is made and kept (¶8), the networks (¶9), the
  chain server (¶10), delays and padding (¶11), the trusted setup (¶12), a privacy statement
  (¶14, ¶15), and that these terms do not limit the software's licences (¶16).
- Paragraphs 7 and 17 are the 2026-11-06 text unchanged.

## Keeping it true

- The fees in ¶5 are constants in the contracts: check them again whenever a contract changes.
- ¶10 and ¶15 describe this release, which trusts one chain server. Cluster mode, planned
  straight after it (`README.md:36-41`), sends the same reads to several servers at once, so both
  change when it ships.
- ¶3 must name any human audit that has happened by launch. `README.md:11` says not to put real
  money in until `PRODUCTION.md` says so: one of the two changes at launch.
