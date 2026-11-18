// Deploy the two pool factories on a real network and start deployments/<network>.json.
//
//   POOL_NETWORK=chipnet FULCRUM_URL=wss://... tsx scripts/deploy-factories.ts
//
// The first step of the deploy command (npm run deploy, scripts/deploy-network.ts), on its own; both
// run scripts/lib/factories.ts. Each factory is an ordinary genesis: the plain coin at vout 0 it
// spends names its category. Every pool of the network is then made through one of them (the app's
// Create pool, or scripts/deploy.ts from a plan), and each refuses a second pool of an amount, or of
// an asset and amount, on chain. The factories also keep the shared hashing and verifier coins
// topped up, at their first pool. This also pays an initial float of those coins.
//
// A factory's category and event address never change, and the indexer and the page name
// them, so a deployment is not repeated by accident: the file must not name both factories yet,
// nor may the page's copy name one this file lacks. A factory's category is the txid of the coin
// its genesis spends, so the coin is chosen first and its txid written to the file, under
// `pending`, before the genesis goes out. A run that stops anywhere can be run again: it adopts a
// pending factory whose genesis went out, spends the same coin for one whose genesis did not, and
// makes only what is still missing.
// Then `tsx scripts/verify-deployment.ts <file>` checks them, as soon as the server shows them.
// Mainnet refuses to run without CONFIRM_MAINNET=1.
import { factoriesStart, makeFactories, topUpFloat } from './lib/factories';
import { connectDeployer, plainHeld } from './lib/network';

const deployer = await connectDeployer();
const start = factoriesStart(deployer.network);
if (start.made) throw new Error(`${start.out} already names factories: a deployment is not repeated by accident.`);
const before = await plainHeld(deployer.signer);
const deployment = await makeFactories(deployer, start);
try {
  const sent = await topUpFloat(deployer);
  console.log(sent ? `hashing and verifier coins topped up in ${sent}` : 'hashing and verifier coins were not short');
} catch (error) {
  console.error(`The factories are made and written, but the shared coins were not topped up: ${(error as Error).message}`);
  console.error('Run scripts/top-up-sidecars.ts for them.');
  process.exit(1);
}
console.log('PoolCreated events: bch', deployment.events.bch, 'token', deployment.events.token);
console.log(`spent ${before - await plainHeld(deployer.signer)} sat`);
// The server's socket would keep this process alive.
process.exit(0);
