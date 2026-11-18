import { NextResponse } from 'next/server';
import { keptFor } from '../../../lib/kept';
import { pageSettings, requestHost } from '../../../lib/page-config';
import { serviceChainUrl } from '../../../lib/proxy';
import { indexerPools, poolsToServe } from '../../../src/listed-pools';
import { networkFor } from '../../../src/page-settings';

export const dynamic = 'force-dynamic';

// The indexer's pool list, read once every 15 seconds however many pages ask: each request once read
// it itself, so a burst of requests here was the same burst at the indexer.
const indexerList = keptFor(15_000, indexerPools);

// One network's settings, as the page's HTML holds them (lib/page-config.ts), with the pools this
// server checked, the indexer's among them. A page that reads the indexer asks here when it opens and
// when a person chooses another network; a Trustless page reads its HTML and asks nothing. The choice
// itself stays in the browser, and the default comes from the deployment.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const page = pageSettings(requestHost(request.headers, url.host));
  const id = networkFor(page, url.searchParams.get('network'));
  const own = page.settings[id];
  if ('error' in own) return NextResponse.json({ ...own, networks: page.networks }, { status: 503 });
  // A pool is served only once the deployment's own factory is seen to have made it, the
  // deployment's own pools too, on every network, the devnet's local chain included. The page may
  // reach the devnet's service at the host it opened this app at, but this server reads it where
  // this server reaches it: no request names a server whose word this server serves.
  const read = id === 'devnet' ? { ...own, fulcrumUrl: serviceChainUrl() } : own;
  const pools = await poolsToServe(read, own.indexerUrl ? await indexerList(own.indexerUrl) : []);
  return NextResponse.json({ ...own, pools, networks: page.networks });
}
