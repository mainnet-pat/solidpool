// Start the local devnet: the service, with a chain of its own and its test funds, and the Next
// web app beside it.
//   node scripts/dev.ts           dev server, fast reloads
//   node scripts/dev.ts --built   build once, then serve the built app, as it ships, on the devnet
// Neither is a production start. That is scripts/prod.ts (`npm run start:prod`), which runs no
// devnet, no faucet and no service.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BCH = join(here, '..');
const BUILT = process.argv.includes('--built');
// This script always runs the local service, including when it serves the built app.
process.env.DEVNET_ENABLED ??= '1';
// Next's anonymous telemetry stays off.
process.env.NEXT_TELEMETRY_DISABLED = '1';
const kids = [];
const TSX = join(BCH, 'node_modules', '.bin', 'tsx');
const start = (file, cwd = BCH, args = []) => {
  const p = spawn(TSX, [join(cwd, file), ...args], { cwd, env: process.env, stdio: 'inherit' });
  kids.push(p);
  p.on('exit', (code) => { if (code) { stop(); process.exit(code); } });
};
process.env.POOL_NETWORK ??= 'local';
const stop = () => { for (const p of kids) { try { p.kill('SIGTERM'); } catch {} } };
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });
start('service/server.ts');
const health = `http://127.0.0.1:${process.env.SERVICE_PORT ?? '8788'}/health`;
for (;;) {
  const up = await fetch(health).then((response) => response.ok).catch(() => false);
  if (up) break;
  await new Promise((resolve) => { setTimeout(resolve, 500); });
}
const NEXT = join(BCH, 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
if (BUILT) {
  console.log('building the web app');
  const built = spawnSync(process.execPath, [NEXT, 'build'], {
    cwd: join(BCH, 'web'), env: process.env, stdio: 'inherit',
  });
  if (built.status !== 0) { stop(); process.exit(built.status ?? 1); }
}
const web = spawn(process.execPath, [NEXT, BUILT ? 'start' : 'dev', '-p', process.env.APP_PORT ?? '8787'], {
  cwd: join(BCH, 'web'), env: process.env, stdio: 'inherit',
});
kids.push(web);
web.on('exit', (code) => { if (code) { stop(); process.exit(code); } });
