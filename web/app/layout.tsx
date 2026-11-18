import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import localFont from 'next/font/local';
import { APP_DESCRIPTION, APP_NAME } from '../src/brand';
import { PAGE_SETTINGS_ID } from '../src/page-settings';
import { siteUrl } from '../lib/deployment';
import { pageSettings, requestHost, settingsJson } from '../lib/page-config';
import './globals.css';

// The page's scripts carry a nonce per request (proxy.ts), and its settings name the devnet's servers
// at the host each request names, so it cannot be prerendered.
export const dynamic = 'force-dynamic';

// The page's three typefaces, from app/fonts: the latin subsets Google Fonts serves, with the same
// variable weights, and Fraunces's optical size, kept here so neither the page nor a build asks
// Google for them. Other scripts fall back to the system fonts globals.css names after them. All
// three are under the SIL Open Font License 1.1 (fonts/OFL.txt).
const display = localFont({
  src: './fonts/fraunces-latin.woff2', weight: '100 900', style: 'normal',
  variable: '--font-display', display: 'swap', adjustFontFallback: 'Times New Roman',
});
const sans = localFont({
  src: './fonts/inter-latin.woff2', weight: '100 900', style: 'normal',
  variable: '--font-sans', display: 'swap', adjustFontFallback: 'Arial',
});
const mono = localFont({
  src: './fonts/jetbrains-mono-latin.woff2', weight: '100 800', style: 'normal',
  variable: '--font-mono', display: 'swap', adjustFontFallback: 'Arial',
});

// Link previews point at the deployment's public origin, which production requires (SITE_URL);
// `next dev` and the devnet use this machine's.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl() ?? `http://localhost:${process.env.APP_PORT ?? 8787}`),
  applicationName: APP_NAME,
  title: { default: `${APP_NAME} — Private payments on Bitcoin Cash`, template: `%s · ${APP_NAME}` },
  description: APP_DESCRIPTION,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every network's public settings, as JSON that never runs: a Trustless page reads them here and
  // asks this app's /api for nothing. The devnet's servers are named at the host this page was
  // opened at, as /api/config names them.
  const settings = settingsJson(pageSettings(requestHost(await headers())));
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <meta name="theme-color" content="#f2f4ef" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b0f0c" media="(prefers-color-scheme: dark)" />
      </head>
      <body>
        <script type="application/json" id={PAGE_SETTINGS_ID} dangerouslySetInnerHTML={{ __html: settings }} />
        {children}
      </body>
    </html>
  );
}
