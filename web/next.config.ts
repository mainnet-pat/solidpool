import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';
import { sourceUrl } from './lib/deployment';
import { writeLicences } from './lib/licences';
import { stopWithoutSettings } from './lib/settings-check';

// Next's anonymous telemetry stays off however Next is run. The project's scripts set this too; here
// it also covers a bare `next build` or `next dev`, which read it after loading this file.
process.env.NEXT_TELEMETRY_DISABLED = '1';

const web = dirname(fileURLToPath(import.meta.url));
// The engine, SolidCash and the verifier (packages/verifier, which takes libauth as a peer) all load
// the project's libauth, and the alias holds the page to that one copy should a package bring its
// own. The verifier measures whether its libauth charges OP_DEFINE bodies, so it sizes the same
// fillers on any.
const libauth = '../node_modules/@bitauth/libauth'; // relative to web/, as Turbopack resolves alias targets

const nextConfig: NextConfig = {
  // The server and the packages it loads, traced into .next/standalone, which web/Dockerfile ships
  // without the rest of node_modules.
  output: 'standalone',
  // The page uses no next/image, so the image optimizer is off, and the sharp binaries Next traces
  // for it stay out of the standalone server: one endpoint less, and no libvips in the image.
  images: { unoptimized: true },
  outputFileTracingExcludes: { '*': ['**/node_modules/sharp/**', '**/node_modules/@img/**'] },
  reactStrictMode: false,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
  devIndicators: false,
  // The app imports packages from the project around web/: the engine and wallet, packages/verifier,
  // and SolidCash from the project's node_modules. Turbopack resolves the one graph that spans
  // them from the project.
  turbopack: {
    root: dirname(web),
    resolveAlias: { '@bitauth/libauth': libauth, '@bitauth/libauth/*': `${libauth}/*` },
  },
  transpilePackages: ['@solidpool/engine', '@solidpool/wallet', '@solidpool/verifier'],
  // Next 16 asks the npm registry about security releases and upgrades: `next dev` at every start,
  // and `next build` when a coding agent runs it, whatever NEXT_TELEMETRY_DISABLED says.
  experimental: { agentUpgrade: false },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

// A production build stops at a missing or malformed setting, or a configured server that will not
// do or cannot be checked, as a production server does (lib/settings-check.ts): Next has read the
// .env files by now. The devnet's own builds (dev.ts --built, test:app) set POOL_NETWORK=local and
// DEVNET_ENABLED=1, which need no others. Every build and dev server then writes the page's notices
// to public/licenses/, naming the source the settings give (lib/licences.ts).
export default async function config(phase: string): Promise<NextConfig> {
  if (phase === PHASE_PRODUCTION_BUILD) await stopWithoutSettings('This production build will not run', 'build');
  if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_DEVELOPMENT_SERVER) writeLicences(web, sourceUrl());
  if (phase === PHASE_DEVELOPMENT_SERVER) refuseRegistry();
  // The exact source of this build, which the page links to at its foot: baked in here, so a page
  // that reads the chain itself needs nothing from this server to show it (lib/deployment.ts).
  return { ...nextConfig, env: { NEXT_PUBLIC_SOURCE_URL: sourceUrl() ?? '' } };
}

/**
 * `next dev` asks registry.npmjs.org which Next is newest whenever a page connects to it, for its
 * overlay, and has no setting to turn that off. This config loads in the dev server's process, so
 * there it refuses requests to the registry; the overlay then shows the version as unknown.
 */
function refuseRegistry(): void {
  const original = globalThis.fetch;
  const hostOf = (input: Parameters<typeof fetch>[0]): string => {
    try { return new URL(input instanceof Request ? input.url : String(input)).hostname; } catch { return ''; }
  };
  globalThis.fetch = (input, init) => (hostOf(input) === 'registry.npmjs.org'
    ? Promise.reject(new Error('this dev server does not ask the npm registry for versions'))
    : original(input, init));
}
