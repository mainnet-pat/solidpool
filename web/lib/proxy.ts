const SERVICE = (process.env.SERVICE_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');

export const serviceUrl = (path: string): string => `${SERVICE}${path}`;

/**
 * The devnet's chain as a browser reads it: the service's Electrum WebSocket, which also pushes the
 * subscriptions the page waits on. Set DEVNET_FULCRUM_URL when a browser reaches the service at
 * another address than this server does.
 */
export const devnetFulcrumUrl = (requestHost?: string): string => {
  if (process.env.DEVNET_FULCRUM_URL) return process.env.DEVNET_FULCRUM_URL;
  const service = new URL(SERVICE);
  // A page opened at another host (a LAN address, a forwarded port) must reach the
  // service at that host, not at the loopback address this server uses.
  const host = requestHost?.split(':')[0] ?? service.hostname;
  const port = service.port || (service.protocol === 'https:' ? '443' : '80');
  return `${service.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}`;
};

/**
 * The devnet's faucet as a browser reaches it: the service's own POST /faucet, which answers a page
 * of any origin, on the host and port of its chain (devnetFulcrumUrl), over https where that is wss.
 * Undefined where that names no URL.
 */
export const devnetFaucetUrl = (requestHost?: string): string | undefined => {
  try {
    const chain = new URL(devnetFulcrumUrl(requestHost));
    return `${chain.protocol === 'wss:' || chain.protocol === 'https:' ? 'https' : 'http'}://${chain.host}/faucet`;
  } catch {
    return undefined;
  }
};

/**
 * The devnet's chain as this server reads it for its own checks: the service at SERVICE_URL. Unlike
 * devnetFulcrumUrl, nothing in a request chooses it, since what this server reads decides which
 * pools it lists for everyone.
 */
export const serviceChainUrl = (): string => {
  const service = new URL(SERVICE);
  return `${service.protocol === 'https:' ? 'wss' : 'ws'}://${service.host}`;
};
