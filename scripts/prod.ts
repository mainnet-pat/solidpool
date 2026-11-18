// The production build and start outside a container: no devnet, no faucet and no service. A page
// reads its Fulcrum servers itself, and the indexer runs on its own (indexer/README.md). In a
// container the app runs from its image instead (web/Dockerfile, docker-compose.yml).
//
//   npm run build:prod      check the settings, then build the app once (`next build`)
//   npm run start:prod      check the settings, then serve that build: Next's standalone server,
//                           the one the image runs
//
//   POOL_NETWORK=chipnet TRUSTLESS_FULCRUM_URL=wss://... TRUSTLESS_BROADCAST_URL=wss://... \
//     BCH_FACTORY=<category> TOKEN_FACTORY=<category> WALLETCONNECT_PROJECT_ID=<id> \
//     SITE_URL=https://pools.example SOURCE_URL=https://<repository>/tree/<commit> npm run build:prod
//
// The settings may also sit in web/.env.production, which both read and hand on to Next. This
// refuses at once what the build and the server refuse (web/lib/settings-check.ts); the build and
// the server then ask each configured server what it runs and which chain it follows. A start
// never builds: it serves the build there is, and checks the settings it runs with. The app listens
// on every interface, port 8787, as it does in its container behind nginx with no port published
// (PRODUCTION.md); APP_HOST and APP_PORT name another address. Next's telemetry stays off.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poolNetwork, productionProblems } from '../web/lib/deployment';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const BUILD = process.argv.includes('--build');
const what = BUILD ? 'build:prod' : 'start:prod';
const fail = (...lines: string[]) => {
  console.error(lines.join('\n'));
  process.exit(1);
};

// The same files `next build` and `next start` read, so the checks see what they will.
const { loadEnvConfig } = createRequire(join(WEB, 'package.json'))('@next/env');
loadEnvConfig(WEB, false, { info: () => undefined, error: console.error });

const network = poolNetwork();
if (process.env.DEVNET_ENABLED === '1' || network === 'local' || network === 'devnet') {
  fail(`${what} serves mainnet or chipnet and runs no devnet: unset DEVNET_ENABLED and set POOL_NETWORK to mainnet or chipnet.`,
    '`npm start` runs the devnet.');
}
const problems = productionProblems(process.env);
if (problems.length) fail('Fix these settings first:', ...problems.map((problem) => `  - ${problem}`));

const NEXT = join(WEB, 'node_modules', 'next', 'dist', 'bin', 'next');
const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' };
// Next's standalone server serves .next/static and public from beside itself, which `next build`
// leaves out of .next/standalone: the image copies them in, and a build here links them.
const SERVER = join(WEB, '.next', 'standalone', 'web');
if (BUILD) {
  const built = spawnSync(process.execPath, [NEXT, 'build'], { cwd: WEB, env, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
  for (const [link, target] of [[join(SERVER, '.next', 'static'), '../../../static'], [join(SERVER, 'public'), '../../../public']]) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
  process.exit(0);
}

if (!existsSync(join(SERVER, 'server.js'))) fail('There is no build to serve: run `npm run build:prod` first, with these settings.');
const host = process.env.APP_HOST?.trim() || '0.0.0.0';
const port = process.env.APP_PORT?.trim() || '8787';
const web = spawn(process.execPath, [join(SERVER, 'server.js')], { cwd: SERVER, env: { ...env, PORT: port, HOSTNAME: host }, stdio: 'inherit' });
const stop = (signal: NodeJS.Signals) => { web.kill(signal); };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
web.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
