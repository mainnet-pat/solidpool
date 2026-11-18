// The app as it ships, in a real browser: a new local chain in a temporary directory, the
// service and the production Next build (Turbopack) on ports of their own, then test/ui.ts
// against them: deposit, prove and withdraw in each kind of pool, and a pool made through a
// deployer, then test/ui-network.ts: a network switch. test:prover-compat and
// test:verifier-universal bundle with esbuild; this is the test of the bundle the app serves.
//   tsx test/app.ts          next build, then next start
//   tsx test/app.ts --dev    next dev
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const scratch = mkdtempSync(join(tmpdir(), 'pools-app-'));
const servicePort = process.env.TEST_SERVICE_PORT ?? '18788';
const appPort = process.env.TEST_APP_PORT ?? '18787';
const appUrl = `http://127.0.0.1:${appPort}/`;
const env = {
  ...process.env,
  POOL_NETWORK: 'local',
  SERVICE_STATE: join(scratch, 'state.json'),
  DEPLOYMENT_FILE: join(scratch, 'local.json'),
  SERVICE_PORT: servicePort,
  SERVICE_URL: `http://127.0.0.1:${servicePort}`,
  APP_PORT: appPort,
  NEXT_TELEMETRY_DISABLED: '1',
};

// scripts/dev.ts runs the service and Next; its own process group, so one signal stops all of it.
const app = spawn(TSX, [join(ROOT, 'scripts', 'dev.ts'), ...(process.argv.includes('--dev') ? [] : ['--built'])], {
  cwd: ROOT, env, stdio: 'inherit', detached: true,
});
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  try { process.kill(-app.pid!, 'SIGTERM'); } catch { /* already gone */ }
  rmSync(scratch, { recursive: true, force: true });
};
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

let exited = false;
app.on('exit', () => { exited = true; });
const deadline = Date.now() + 10 * 60_000;
for (;;) {
  const up = await fetch(appUrl).then((response) => response.ok).catch(() => false);
  if (up) break;
  if (exited) throw new Error('the app stopped before it answered');
  if (Date.now() > deadline) throw new Error(`the app did not answer at ${appUrl} within 10 minutes`);
  await new Promise((done) => { setTimeout(done, 1000); });
}

// The browser tests read the service's chain and faucet themselves, so they get the same service.
const browserTest = (file: string) => spawnSync(TSX, [join(ROOT, 'test', file)], {
  cwd: ROOT, env: { ...process.env, APP_URL: appUrl, SERVICE_URL: env.SERVICE_URL }, stdio: 'inherit',
});
const flows = browserTest('ui.ts');
const result = flows.status === 0 ? browserTest('ui-network.ts') : flows;
stop();
process.exit(result.status ?? 1);
