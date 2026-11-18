// The settings a page opens with: each network it may choose, each offered network's public settings,
// and the network it opens on when it has chosen none. The app's server writes them into the page's
// HTML on every request (web/lib/page-config.ts), where a Trustless page reads them, so it asks this
// app's /api for nothing; /api/config serves the same reading, with the pools that server checked, to
// a page that reads the indexer. None of it is secret.

/** The element that holds them: a script of JSON, which never runs. */
export const PAGE_SETTINGS_ID = 'pageSettings';

/** A network a page may choose, with its own servers once it is offered. */
export interface NetworkOption {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  local?: boolean;
  fulcrumUrl?: string;
  broadcastUrl?: string;
}

/** Why a network's settings cannot be served, as /api/config says it. */
export interface SettingsError {
  error: string;
  networkId: string;
}

export interface PageSettings<Settings = any> {
  /** The network a page opens on when it has chosen none, or chose one not offered. */
  defaultNetwork: string;
  networks: NetworkOption[];
  /** Each offered network's settings, and the default network's, or why they cannot be served. */
  settings: Record<string, Settings | SettingsError>;
}

/** The network a page opens on: the one it chose while that one is offered, else the default. */
export function networkFor<Id extends string>(
  page: { defaultNetwork: Id; networks: ReadonlyArray<{ id: Id; available: boolean }> },
  chosen: string | null | undefined,
): Id {
  return page.networks.find((network) => network.id === chosen && network.available)?.id ?? page.defaultNetwork;
}

/** The settings this page was served with, or undefined where it holds none it can read. */
export function readPageSettings(): PageSettings | undefined {
  try {
    const page = JSON.parse(document.getElementById(PAGE_SETTINGS_ID)?.textContent ?? '');
    return typeof page?.defaultNetwork === 'string' && Array.isArray(page.networks)
      && typeof page.settings === 'object' && page.settings !== null ? page : undefined;
  } catch {
    return undefined;
  }
}
