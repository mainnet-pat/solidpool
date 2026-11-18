// The public Fulcrum servers the page's Settings offer on mainnet and chipnet. The first of each is
// the one a browser reads until it chooses another, and the one the deploy command
// (scripts/deploy-network.ts) reads unless it is named a server.

export interface KnownServer { label: string; url: string }

export const KNOWN_SERVERS: Readonly<Record<'mainnet' | 'chipnet', readonly KnownServer[]>> = {
  mainnet: [
    { label: 'electrum.imaginary.cash', url: 'wss://electrum.imaginary.cash:50004' },
    { label: 'bch.imaginary.cash', url: 'wss://bch.imaginary.cash:50004' },
    { label: 'electroncash.dk', url: 'wss://electroncash.dk:50004' },
    { label: 'bch.loping.net', url: 'wss://bch.loping.net:50004' },
    { label: 'blackie.c3-soft.com', url: 'wss://blackie.c3-soft.com:50004' },
  ],
  chipnet: [
    { label: 'chipnet.bch.ninja', url: 'wss://chipnet.bch.ninja:50004' },
    { label: 'chipnet.imaginary.cash', url: 'wss://chipnet.imaginary.cash:50004' },
  ],
};
