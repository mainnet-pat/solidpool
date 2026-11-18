// The settings a page opens with (web/src/page-settings.ts), as this server makes them for the page's
// HTML (app/layout.tsx) and for /api/config alike: one reading, so what a page reads from its HTML is
// what /api/config tells it, but for the pools /api/config checked.
import {
  availableNetworks, configFor, defaultNetwork, type NetworkChoice, type NetworkId,
} from './deployment';
import type { PageSettings, SettingsError } from '../src/page-settings';

/** One network's public settings, as configFor makes them. */
export type NetworkSettings = NonNullable<ReturnType<typeof configFor>>;

/** The settings a page opens with, as this server makes them. */
export interface ServedSettings extends PageSettings<NetworkSettings> {
  defaultNetwork: NetworkId;
  networks: Array<NetworkChoice & { fulcrumUrl?: string; broadcastUrl?: string }>;
}

/**
 * The host a request was made to, as the browser named it. The devnet's servers are named at it,
 * so a page opened at another host (a LAN address, a forwarded port) reaches them there.
 */
export function requestHost(headers: { get(name: string): string | null }, fallback?: string): string | undefined {
  return headers.get('x-forwarded-host') ?? headers.get('host') ?? fallback;
}

/** One network's settings, or why they cannot be served. */
function settingsOf(id: NetworkId, host: string | undefined): NetworkSettings | SettingsError {
  try {
    return configFor(id, host) ?? { error: `This app has no ${id} deployment to serve.`, networkId: id };
  } catch (error) {
    // The environment and the deployment name different factories, and neither is taken.
    return { error: (error as Error).message, networkId: id };
  }
}

/**
 * Each network a page may choose, with its own servers, so that Settings offers a network's own
 * before the page has moved to it, never a guess made on the network it is on; the settings of each
 * one offered; and the network a page opens on by default, the deployment's while it is offered,
 * else the first offered, whose settings are here too.
 */
export function pageSettings(host?: string): ServedSettings {
  const settings: ServedSettings['settings'] = {};
  const networks = availableNetworks().map((choice) => {
    if (!choice.available) return choice;
    const own = settingsOf(choice.id, host);
    settings[choice.id] = own;
    return 'error' in own ? choice : { ...choice, fulcrumUrl: own.fulcrumUrl, broadcastUrl: own.broadcastUrl };
  });
  const preferred = defaultNetwork();
  const usable = networks.find((network) => network.id === preferred && network.available)?.id
    ?? networks.find((network) => network.available)?.id
    ?? 'chipnet';
  settings[usable] ??= settingsOf(usable, host);
  return { defaultNetwork: usable, networks, settings };
}

/**
 * The settings as the JSON a script element holds. `<`, `>` and `&` are written as escapes, so no
 * value can end the element or start markup, and so are U+2028 and U+2029, which a script would
 * read as line ends. JSON.parse reads every escape back as the character it stands for.
 */
export function settingsJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
