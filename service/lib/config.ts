// Paths and ports of the service, from the environment.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
/**
 * The vendored Groth16 verifier, `@solidpool/verifier` (packages/verifier/README.md). The app and the tests import it
 * as a package, and the verifier scripts load its modules from here, so all of them use one tree.
 */
export const VERIFIER = join(ROOT, 'packages', 'verifier');
/**
 * The withdrawal circuit and its proving key, tornado-core's build of them: the files the page serves from
 * web/public/prover, which web/src/prover.ts pins by hash. CIRCUITS_DIR names another directory.
 */
export const CIRCUITS = process.env.CIRCUITS_DIR ?? join(ROOT, 'web', 'public', 'prover');
export const VK = process.env.BN_VK_FIXTURES ?? join(ROOT, 'service', 'verifier', 'tornado-bn254-3in.json');
export const PORT = Number(process.env.SERVICE_PORT ?? 8788);
export const SERVICE_URL = process.env.SERVICE_URL ?? `http://127.0.0.1:${PORT}`;
/** A deployment names the network and its pools. `local` is the service's own chain. */
export const NETWORK = process.env.POOL_NETWORK ?? 'local';
export const DEPLOYMENT = process.env.DEPLOYMENT_FILE ?? join(ROOT, 'deployments', `${NETWORK}.json`);
