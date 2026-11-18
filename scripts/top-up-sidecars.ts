// Pay hashing and verifier coins until each shared lock holds at least as many as two pool
// transactions spend at once.
//
//   POOL_NETWORK=chipnet FULCRUM_URL=wss://... tsx scripts/top-up-sidecars.ts
//
// Every pool shares these coins, and anyone may add one. A pool transaction recreates the ones it
// spends, but a coin left unmoved for 1,440 blocks is anyone's to sweep, so a quiet spell can leave
// too few. A deposit tops up the hashing coins it needs from the depositor's wallet. A withdrawal
// cannot: a verifier coin the withdrawer paid in would tie their wallet to it. So after a quiet
// spell, an operator runs this, or the next pool creation does. Mainnet refuses to run without
// CONFIRM_MAINNET=1.
import { SIDECARS_WANTED, sidecarShortfall, topUpSidecars } from '../web/src/pool-client';
import { COIN_SATOSHIS } from '../web/src/pools';
import { connectDeployer } from './lib/network';

const { provider, signer } = await connectDeployer();
const wanted = { workers: SIDECARS_WANTED.workers * 2, verifiers: SIDECARS_WANTED.verifiers * 2 };
const short = await sidecarShortfall(provider, wanted);
console.log(`short of ${short.workers} hashing and ${short.verifiers} verifier coins`);
if (short.workers + short.verifiers === 0) {
  console.log('nothing was short');
  process.exit(0);
}
// One plain coin pays them all, with room for the fee at 1 sat/B and the change.
const needed = BigInt(short.workers + short.verifiers) * COIN_SATOSHIS + 2_000n;
const funds = (await signer.getUtxos()).filter((coin: any) => !coin.token).sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
if (!funds || funds.satoshis < needed) {
  throw new Error(`The top-up needs one plain coin of at least ${needed} sat; this key's largest holds ${funds?.satoshis ?? 0n}.`);
}
const sent = await topUpSidecars(provider, { utxo: funds, unlocker: signer.unlockP2PKH(), change: signer.getAddress() }, wanted);
console.log(sent ? `topped up in ${sent.txid}` : 'nothing was short');
process.exit(0);
