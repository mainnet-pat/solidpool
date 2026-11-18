import { APP_NAME, APP_SLOGAN } from '../src/brand';

// A single capitalised name splits into its two halves for the wordmark, so
// renaming stays a one-line change in brand.ts.
const [, BRAND_LEAD = APP_NAME, BRAND_TAIL = ''] = /^([A-Z][a-z]+)([A-Z].*)$/.exec(APP_NAME) ?? [];

// Anyone who accepted an older version is asked again, so change this with the text.
// docs/TERMS.md holds the same text, with the source of each statement of fact; a test keeps the
// two the same.
export const TERMS_VERSION = '2026-11-18';

export const TERMS = `
    <p class="lede"><strong>${APP_NAME} is experimental software for private payments on Bitcoin
      Cash, built with SolidCash.</strong> It is provided as is, without warranties of any kind. This
      website may stop working at any time. The pools do not depend on it: they run on chain, and a
      note can still be withdrawn through another copy of this software, or any other that follows
      the pools' rules.</p>
    <p class="lede"><strong>Where this website may not be used.</strong> This website is not offered
      in the United States, the European Union or the United Kingdom. You may not use it if you are
      located or resident in the United States or its territories, in a member state of the European
      Union, or in the United Kingdom, or if you act for a company or other organisation established
      in any of them. You also may not use it from a country or region under comprehensive sanctions
      of the United Nations, the United States, the European Union or the United Kingdom, or if you
      are named on any of their sanctions lists. Do not hide where you are, with a VPN or otherwise,
      to use it.</p>
    <p class="lede">No person has audited the contracts or the proof verifier as they are used here,
      nor the SolidCash compiler that builds them. The contracts and the verifier have had AI reviews
      only, which are not a human audit and cannot rule out bugs. A contract cannot be changed or
      fixed once it is deployed, so a bug could cost every deposit in a pool. Do not deposit more
      than you can afford to lose.</p>
    <p class="lede">${APP_NAME} is non-custodial software. The authors never hold your keys or your
      funds. A deposit goes into a pool contract on Bitcoin Cash, and nobody holds a key to it: not
      the authors, not whoever runs this website, and not whoever created the pool. The contracts
      have no owner, pay no fee to the authors, and cannot be upgraded or paused. Nobody can change a
      pool's rules, reverse a transaction or recover a deposit.</p>
    <p class="lede">There is no service fee: nothing is paid to the authors, to this website or to a
      pool's creator. A note costs about 0.0022 BCH (220,000 satoshis) in network fees at today's
      minimum fee rate, whatever its amount, so small pools lose a large share: about 22% of a
      0.01 BCH note. The deposit pays it all at once: its own fee, and the fees of the two later
      steps, which are fixed in each pool's code.</p>
    <p class="lede">Anyone can create a pool through the pool factories, for BCH or for any
      CashToken, in any fixed amount that has no pool yet. Its creator pays for the coins it opens
      with, which stay in it for good, and gains no control over it. ${APP_NAME} does not check who
      issued a token or what it is worth, and token names and icons come from published metadata
      that the page cannot vouch for.</p>
    <p class="lede">You decide how you use this software, and you are responsible for following the
      laws that apply to you. Do not use it if that is illegal where you are, if you are subject to
      sanctions, or to handle the proceeds of crime. The authors do not direct, review or approve
      what anyone does with it.</p>
    <p class="lede">Your note is the only way to get a deposit back: anyone who has it can withdraw
      the deposit, and if you lose it, nobody can recover it for you. The note is made in your browser
      by the code this website sends, so a website that changed that code could take it. The page
      never stores your note: save it before you deposit, and keep it secret. A note has no checksum,
      so a mistyped one looks like a note that is not in the pool. A copied note stays on your
      clipboard until something replaces it. If the page cannot tell whether a deposit went through,
      keep the note.</p>
    <p class="lede">Blockchain transactions are irreversible. Verify the network, pool and recipient
      before you confirm. Mainnet spends real BCH. Chipnet, and the Devnet that only test deployments
      offer, use test coins with no value.</p>
    <p class="lede">The page sees the chain only through the chain servers (Fulcrum) it connects to,
      and this release takes one server's word on which pools the pool factories made. A server that
      lies could show you a pool made outside the factories, whose maker can take everything
      deposited in it. A server can also refuse to answer, or hold back what you send. Use a server
      you trust or, better, run your own node and Fulcrum server.</p>
    <p class="lede">Anyone willing to pay can delay deposits and withdrawals, by moving the coins
      they spend while they are being made, and on a busy pool a deposit can lose a race with another.
      A delayed deposit may have to start again with a new note. A pool takes one deposit at a time,
      so the page may also send, by itself and at no cost to you, the prepaid step that finishes
      someone else's deposit. Anyone can also fill a pool's addresses with junk until servers with
      common settings stop answering for it. No funds move, but a withdrawal may then need a server
      set up with higher limits.</p>
    <p class="lede">Withdrawals rely on a circuit and a trusted setup that another project, which
      ${APP_NAME} is not affiliated with, made and published, and ${APP_NAME} reuses them unchanged.
      If none of that setup's contributors destroyed their secret, or if the file it started from
      came from somewhere else, which can no longer be checked, whoever can rebuild the setup's
      secret could withdraw from any pool without a note.</p>
    <p class="lede">Privacy is not guaranteed. A pool hides which deposit a withdrawal spends only
      among the notes in that pool, so a pool with few notes hides little. You can also link your own
      deposit and withdrawal: by withdrawing soon after you deposit, by withdrawing to an address tied
      to you, or by paying a fee from a wallet tied to the other side. The servers the page uses also
      see what it asks them, as set out below.</p>
    <p class="lede"><strong>What this page keeps, and who sees what.</strong> ${APP_NAME} has no
      accounts, and the page runs no analytics or tracking code. It keeps these in this browser
      only: your settings, whether you accepted these terms, pools you created here, the wallet
      extension you last used, token details, and chain data it has read and checked; on a Devnet,
      also a test account's key. Reset stored data, in Settings, removes them. No server records that
      you accepted these terms. If you pair a wallet through WalletConnect, its software keeps data of
      its own in this browser.</p>
    <p class="lede">Every server the page contacts sees your IP address and when you use it: this
      website; the chain servers you choose, which also see every coin, pool and transaction the page
      reads for you; the fast indexer, which the page reads only if you choose it in Settings;
      the token-details service (Paytaca's by default), the hosts token issuers name, and public IPFS
      gateways; WalletConnect's servers, if you pair a wallet through it; and whoever serves the
      proving files, who can tell when this browser makes its first withdrawal. Apart from this
      website, these are third parties with their own policies, and any of them may keep logs. One
      server that handled both your deposit and your withdrawal could link the two, so the page
      normally sends withdrawals through a second server, though two operators could still compare
      what they saw. Everything sent to the blockchain is public for good.</p>
    <p class="lede">These terms cover your use of this website. They do not limit what the licences
      of ${APP_NAME}'s software let you do with that software: see Licences at the foot of the
      page.</p>
    <p class="lede">To the fullest extent the law allows, the authors are not responsible for any
      loss of funds or for any other financial decision you make. By using this app you accept these
      terms, and you use it at your own risk.</p>
`;

/**
 * The ledger while nothing has been read for the network on screen: tiles of the shape the pools will
 * take, rather than an empty grid. The page's HTML starts with it, before any script runs, and ui.ts
 * shows it again whenever a network is still being read. It carries none of the pool tiles' classes,
 * so nothing that looks for pools finds one in it.
 */
const SKELETON_TILE = `<section class="pool-tile pool-skeleton" aria-hidden="true">
      <span class="sk sk-icon"></span>
      <span class="sk-lines"><span class="sk sk-title"></span><span class="sk sk-symbol"></span><span class="sk sk-meta"></span></span>
    </section>`;
export const POOL_SKELETON = SKELETON_TILE.repeat(3);

// Static markup; keep the IDs in sync with ui.ts. The pool ledger is the home
// page and holds each pool's facts once. Depositing opens inside a pool's row;
// redeeming needs no pool choice, because the note names its pool.
export const MARKUP: string = `
<header class="top">
  <div class="shell top-row">
    <a class="brand" href="/" aria-label="${APP_NAME}">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" fill-rule="evenodd" d="M5.6 0h12.8A5.6 5.6 0 0 1 24 5.6v12.8A5.6 5.6 0 0 1 18.4 24H5.6A5.6 5.6 0 0 1 0 18.4V5.6A5.6 5.6 0 0 1 5.6 0ZM12.42 19.66Q11.53 19.66 10.92 19.43Q10.32 19.19 9.95 18.96Q9.58 18.73 9.41 18.73Q9.26 18.73 9.09 18.88Q8.92 19.03 8.75 19.22Q8.58 19.41 8.41 19.55Q8.24 19.70 8.08 19.70Q7.91 19.70 7.79 19.59Q7.67 19.49 7.63 19.26L6.90 15.21Q6.87 15.04 6.94 14.93Q7.00 14.81 7.15 14.76Q7.31 14.70 7.45 14.77Q7.58 14.83 7.67 15.02Q8.44 16.54 9.19 17.38Q9.94 18.23 10.68 18.57Q11.42 18.91 12.16 18.91Q13.23 18.91 13.86 18.35Q14.48 17.79 14.48 16.76Q14.49 16.11 14.20 15.58Q13.92 15.04 13.16 14.57Q12.41 14.10 11.02 13.65Q9.37 13.09 8.38 12.40Q7.38 11.70 6.94 10.79Q6.50 9.88 6.50 8.71Q6.50 7.42 7.13 6.43Q7.77 5.45 8.91 4.90Q10.06 4.34 11.57 4.34Q12.46 4.34 13.05 4.54Q13.65 4.73 14.02 4.92Q14.40 5.12 14.62 5.12Q14.83 5.12 15.05 4.92Q15.27 4.71 15.49 4.51Q15.72 4.30 15.95 4.30Q16.11 4.30 16.23 4.41Q16.35 4.51 16.42 4.79L17.48 8.80Q17.53 9.00 17.47 9.14Q17.41 9.29 17.25 9.34Q17.09 9.40 16.96 9.33Q16.82 9.26 16.73 9.10Q15.90 7.54 15.09 6.67Q14.28 5.80 13.48 5.45Q12.69 5.09 11.88 5.09Q10.85 5.09 10.22 5.72Q9.59 6.35 9.59 7.40Q9.59 8.06 9.87 8.61Q10.14 9.16 10.87 9.65Q11.59 10.14 12.93 10.62Q14.62 11.23 15.61 11.92Q16.60 12.61 17.03 13.46Q17.46 14.31 17.46 15.40Q17.46 16.58 16.86 17.55Q16.26 18.51 15.14 19.08Q14.01 19.66 12.42 19.66Z" />
      </svg>
      <span><b>${BRAND_LEAD}</b><span class="pool">${BRAND_TAIL}</span></span>
    </a>
    <div class="top-actions">
      <button class="chip" id="networkPill" aria-label="Open settings"></button>
      <button class="btn quiet hidden" id="accountBtn"></button>
      <button class="btn quiet" id="connect">Connect wallet</button>
    </div>
  </div>
</header>

<main class="shell">
  <div class="page-head">
    <div class="page-intro">
      <h1>${APP_SLOGAN.replace('Bitcoin Cash', 'Bitcoin&nbsp;Cash')}</h1>
      <p class="lede">Deposit into a pool, then withdraw to a fresh address. The link between the two stays private.</p>
    </div>
  </div>

  <section class="block" aria-labelledby="poolsTitle">
    <div class="block-head pools-head">
      <h2 id="poolsTitle"><span>Choose a pool</span> <button type="button" class="tag tag-button" id="dataSource" title="Change how this page loads data" aria-haspopup="dialog"></button></h2>
      <span class="pools-tools">
        <span class="sync-inline hidden" id="syncStatus" role="status" aria-live="polite"><span class="sync-dot" aria-hidden="true"></span><span id="syncText" aria-hidden="true">Syncing…</span><span class="sr-only" id="syncWords">Catching up with the chain…</span></span>
        <button class="link" id="refreshBtn">Refresh</button>
      </span>
      <span class="sync-line hidden" id="syncLine" aria-hidden="true"><i id="syncProgress"></i></span>
    </div>
    <p class="hint section-hint">Pick the amount you want to deposit. Each pool pays a fixed amount.</p>
    <div class="pool-tiles" id="pools" aria-busy="true">${POOL_SKELETON}</div>
    <div class="pool-create">
      <button class="btn quiet" id="addPoolBtn">Create a pool</button>
    </div>
  </section>

  <section class="block" aria-labelledby="redeemTitle">
    <h2 id="redeemTitle">Withdraw a deposit</h2>
    <p class="hint section-hint">Paste the private note you saved when you deposited, and choose where to send the money.</p>
    <div class="field">
      <label for="note">Private note</label>
      <textarea id="note" rows="2" spellcheck="false" autocomplete="off" placeholder="Paste the note you saved when you deposited"></textarea>
      <div class="hint" id="noteInfo"></div>
    </div>
    <div class="field">
      <label for="recipient">Send to</label>
      <input id="recipient" spellcheck="false" autocomplete="off" placeholder="A fresh address" />
      <div class="hint">Use an address that has not received this deposit before.</div>
      <div class="hint warn hidden" id="recipientWarn">This is your connected wallet. Receiving here would link the withdrawal to you, so use a different address.</div>
    </div>
    <button class="btn primary" id="withdrawBtn">Withdraw</button>
    <div class="hidden" id="feeOffer">
      <div class="hint warn" id="feeOfferText"></div>
      <button class="btn quiet wide" id="feeOfferBtn">Pay it from the connected wallet and withdraw</button>
    </div>
    <div class="flow hidden" id="feeSteps" role="status" aria-live="polite" aria-atomic="false" aria-label="Paying the network fee">
      <div class="progress"><i></i></div>
      <ol class="flow-steps"></ol>
    </div>
    <div id="withdrawOut"></div>
  </section>

  <section class="block" aria-labelledby="assetsTitle">
    <div class="block-head">
      <h2 id="assetsTitle">
        <button type="button" class="section-toggle" id="walletToggle" aria-expanded="false" aria-controls="assetsList">
          Your wallet <span class="chev" aria-hidden="true">›</span>
        </button>
      </h2>
      <button class="link hidden" id="assetsRefresh">Refresh</button>
    </div>
    <div id="assetsList" class="assets-view hidden">
      <p class="hint">Connect a wallet to see your balance and create a pool for an asset you hold.</p>
    </div>
  </section>

  <section class="steps" aria-label="How it works">
    <div><b><span class="step-n">01</span>Deposit</b><p>Pick a pool and deposit a fixed amount. The app gives you a private note.</p></div>
    <div><b><span class="step-n">02</span>Wait</b><p>Your deposit joins others in the pool. The more people use it, the harder yours is to trace.</p></div>
    <div><b><span class="step-n">03</span>Withdraw</b><p>Paste your note and a fresh address. The app proves the note is yours without showing which deposit it is.</p></div>
  </section>
</main>

<footer class="shell foot">Use at your own risk. <button class="link" id="termsBtn">Terms</button> <a class="link" href="/licenses/NOTICE.txt" target="_blank" rel="noopener">Licences</a>${sourceLink()}</footer>

<div class="statusbar hidden" id="statusBar" title="Click to dismiss" tabindex="0">
  <div class="progress hidden" id="progress"><i></i></div>
  <div class="status" id="status" role="status" aria-live="polite"></div>
</div>

<div class="modal-backdrop hidden" id="poolModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="poolModalTitle">
    <div class="modal-head"><h2 id="poolModalTitle">Deposit</h2>
      <button class="x" data-close="poolModal" aria-label="Close">×</button></div>
    <div class="pool-modal-asset" id="poolModalAsset"></div>
    <p class="hint">Pick an amount. You will save a private note to withdraw it later.</p>
    <div class="pool-denoms" id="poolModalBody"></div>
    <div class="drawer hidden" id="depositDrawer">
      <dl class="sum" id="depositSummary"></dl>
      <button class="btn primary hidden" id="prepareCoinBtn">Prepare a coin for this deposit</button>
      <div class="flow hidden" id="prepareSteps" role="status" aria-live="polite" aria-atomic="false" aria-label="Preparing the coin">
        <div class="progress"><i></i></div>
        <ol class="flow-steps"></ol>
      </div>
      <p class="hint" id="prepareStatus" role="status" aria-live="polite"></p>
      <button class="btn primary" id="depositBtn">Continue to deposit</button>
    </div>
  </section>
</div>

<div class="modal-backdrop hidden" id="noteModal" data-sticky>
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="noteTitle">
    <div class="modal-head"><h2 id="noteTitle">Save your note first</h2></div>
    <p class="lede" id="noteLede"></p>
    <div id="depositOut"></div>
    <div class="row">
      <button class="btn quiet" id="noteCopy">Copy</button>
      <button class="btn quiet" id="noteDownload">Download</button>
    </div>
    <div class="flow hidden" id="noteSteps" role="status" aria-live="polite" aria-atomic="false" aria-label="Depositing">
      <div class="progress"><i></i></div>
      <ol class="flow-steps"></ol>
    </div>
    <p class="hint" id="noteStatus" role="status" aria-live="polite"></p>
    <div class="hidden" id="noteOffer">
      <p class="hint" id="noteOfferText"></p>
      <button class="btn quiet wide" id="noteOfferBtn">Prepare a coin for this deposit</button>
    </div>
    <button class="btn primary" id="noteDone" disabled>I saved it, deposit</button>
    <button class="btn quiet wide" id="noteCancel">Cancel</button>
  </section>
</div>

<div class="modal-backdrop hidden" id="connectModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="connectTitle">
    <div class="modal-head"><h2 id="connectTitle">Connect a wallet</h2>
      <button class="x" data-close="connectModal" aria-label="Close">×</button></div>
    <p class="hint">Connect the wallet that holds the Bitcoin Cash you want to use.</p>
    <div class="injected-options" id="injectedOptions"></div>
    <button class="option" id="connectLocal"><b>This browser</b><span>A wallet kept in this browser</span></button>
    <button class="option" id="connectWC"><b>WalletConnect</b><span>Pair a wallet app such as Cashonize or Paytaca</span></button>
    <p class="hint" id="wcHint"></p>
  </section>
</div>

<div class="modal-backdrop hidden" id="pairingModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="pairingTitle">
    <div class="modal-head"><h2 id="pairingTitle">Scan to pair</h2>
      <button class="x" data-close="pairingModal" aria-label="Close">×</button></div>
    <div class="qr">
      <div class="qr-placeholder" id="pairingQrPlaceholder" role="status" aria-live="polite">
        <span class="qr-spinner" aria-hidden="true"></span>
        <span>Preparing pairing code…</span>
      </div>
      <img id="pairingQr" class="hidden" alt="WalletConnect pairing code" />
    </div>
    <div class="pair-uri-row">
      <p class="pair-uri mono" id="pairingUri" title="Click to copy"></p>
      <button class="icon-btn hidden" id="copyPairingUri" type="button" title="Copy pairing link" aria-label="Copy pairing link">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    </div>
  </section>
</div>

<div class="modal-backdrop hidden" id="accountModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="accountKind">
    <div class="modal-head"><h2 id="accountKind">Account</h2>
      <button class="x" data-close="accountModal" aria-label="Close">×</button></div>
    <div class="address-row">
      <button class="address mono" id="accountAddress" title="Copy address"></button>
      <button class="icon-btn hidden" id="addressSwitch" type="button" title="Switch address type" aria-label="Switch address type">
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11a8 8 0 0 0-13.7-5.7L4 7" />
          <path d="M4 3v4h4" />
          <path d="M4 13a8 8 0 0 0 13.7 5.7L20 17" />
          <path d="M20 21v-4h-4" />
        </svg>
      </button>
    </div>
    <div class="assets" id="accountAssets"></div>
    <button class="btn quiet wide" id="faucetBtn">Get test funds</button>
    <button class="btn quiet wide danger" id="disconnectBtn">Disconnect</button>
  </section>
</div>

<div class="modal-backdrop hidden" id="addPoolModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="addPoolTitle">
    <div class="modal-head"><h2 id="addPoolTitle">Add a pool</h2>
      <button class="x" data-close="addPoolModal" aria-label="Close">×</button></div>
    <div id="addPoolBody"></div>
  </section>
</div>

<div class="modal-backdrop hidden" id="createPoolModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="createPoolTitle">
    <div class="modal-head"><h2 id="createPoolTitle">Create a pool</h2>
      <button class="x" data-close="createPoolModal" aria-label="Close">×</button></div>
    <div id="createPoolBody"></div>
  </section>
</div>

<div class="modal-backdrop hidden" id="termsModal">
  <section class="modal terms" role="dialog" aria-modal="true" aria-labelledby="termsTitle">
    <div class="modal-head"><h2 id="termsTitle">Terms</h2>
      <button class="x" data-close="termsModal" aria-label="Close">×</button></div>
    <div class="terms-body">${TERMS}</div>
  </section>
</div>

<div class="modal-backdrop hidden" id="settingsModal">
  <section class="modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
    <div class="modal-head"><h2 id="settingsTitle">Settings</h2>
      <button class="x" data-close="settingsModal" aria-label="Close">×</button></div>
    <div class="field">
      <span class="label">Network</span>
      <div class="choices" id="networkChoices" role="radiogroup" aria-label="Network"></div>
      <div class="hint" id="networkHint">Mainnet spends real money. Chipnet and the devnet use test coins.</div>
    </div>
    <div class="field">
      <span class="label">How data loads</span>
      <div class="choices" id="sourceChoices" role="radiogroup" aria-label="How data loads"></div>
      <div class="hint">Fast indexer loads a quick preview from this app's archive. Trustless checks every pool against the chain through Fulcrum.</div>
    </div>
    <details class="advanced">
      <summary>Advanced connection settings</summary>
      <div class="field">
        <label for="indexerServer">Fast indexer</label>
        <select id="indexerServer"></select>
        <input class="custom-endpoint hidden" id="indexerEndpoint" placeholder="/api/indexer" autocomplete="off" spellcheck="false" />
        <div class="hint" id="indexerHint">The app's archive for the quick preview. This deployment sets it; it is not a chain server.</div>
      </div>
      <div class="field">
        <label for="fulcrumServer">Fulcrum chain server</label>
        <select id="fulcrumServer"></select>
        <input class="custom-endpoint hidden" id="fulcrumEndpoint" placeholder="wss://fulcrum.example.com:50004" autocomplete="off" spellcheck="false" />
        <div class="hint">Only servers for the selected network are listed. The browser connects to it directly; the devnet's chain is local, so it uses this app's service path.</div>
      </div>
      <div class="field">
        <label for="broadcastServer">Fulcrum withdrawal server</label>
        <select id="broadcastServer"></select>
        <input class="custom-endpoint hidden" id="broadcastEndpoint" placeholder="wss://fulcrum.example.com:50004" autocomplete="off" spellcheck="false" />
        <div class="hint">Withdrawals use this server alone, so no single operator sees both sides. Leave this as it is unless you run your own.</div>
        <div class="hint warn hidden" id="withdrawalWarn">Using the same server for both sides lets its operator see your wallet and your withdrawal. Choose a different server for better privacy.</div>
      </div>
    </details>
    <div class="field">
      <span class="label">Stored data</span>
      <p class="hint">Removes this browser's wallet key, settings, cached chain data and remembered pools. Private notes are never stored here; keep yours.</p>
      <button class="btn quiet danger" id="settingsResetData" type="button">Reset stored data</button>
    </div>
    <div class="row">
      <button class="btn quiet" id="settingsClear">Use defaults</button>
      <button class="btn primary" id="settingsSave">Save</button>
    </div>
    <div class="hint" id="settingsStatus"></div>
  </section>
</div>

<div class="modal-backdrop hidden" id="termsGate" data-sticky>
  <section class="modal terms" role="dialog" aria-modal="true" aria-labelledby="termsGateTitle">
    <div class="modal-head"><h2 id="termsGateTitle">Terms</h2></div>
    <div class="terms-body">${TERMS}</div>
    <label class="check"><input type="checkbox" id="termsAgree" /> I have read and accept these terms, and I am not in the United States, the European Union or the United Kingdom</label>
    <button class="btn primary" id="termsAccept" disabled>Continue</button>
  </section>
</div>
`;

/**
 * "Source" at the foot of the page: the exact source of this build, SOURCE_URL, which next.config.ts
 * bakes in as NEXT_PUBLIC_SOURCE_URL, so the page needs no request to show it. A build that names
 * none, or none over https, shows no link.
 */
function sourceLink(): string {
  const source = process.env.NEXT_PUBLIC_SOURCE_URL ?? '';
  if (!source.startsWith('https://')) return '';
  const href = source.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  return ` <a class="link" href="${href}" target="_blank" rel="noopener">Source</a>`;
}
