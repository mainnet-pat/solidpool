// Browser wallet layer: a local account and a BCH WalletConnect (wc2-bch-bcr) session.
// Imported by the app through @solidpool/wallet; the connector mirrors sushi-port's BCH WalletConnect client.
import {
  binToHex, hexToBin, secp256k1, hash160, stringify, encodeCashAddress, cashAddressToLockingBytecode,
} from './libauth';
import QRCode from 'qrcode';
import { APP_DESCRIPTION, APP_NAME } from './brand';
import { DEVNET_ACCOUNT_KEY_HEX } from './devnet-account';

const STORAGE = 'pools-local-key';

export function createLocalAccount(prefix = 'bchtest', useDevnetKey = false) {
  // The devnet account is derived from a fixed seed phrase so the service can seed it, a
  // restart keeps it, and the same phrase imports into a Cashonize wallet.
  let keyHex = useDevnetKey ? DEVNET_ACCOUNT_KEY_HEX : (localStorage.getItem(STORAGE) ?? '');
  if (!keyHex) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    keyHex = binToHex(key);
    localStorage.setItem(STORAGE, keyHex);
  } else if (useDevnetKey) {
    localStorage.setItem(STORAGE, keyHex);
  }
  const privateKey = hexToBin(keyHex);
  const pub = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof pub === 'string') throw new Error(pub);
  const address = encodeCashAddress({ prefix: prefix as any, type: 'p2pkh', payload: hash160(pub) }).address;
  return { kind: 'local', address, walletName: 'This browser', privateKey, disconnect: async () => {} };
}

/** The cash and token-aware forms of a plain P2PKH address, or null for anything else. */
export function addressForms(address: string, prefix = 'bchtest'): { cash: string; token: string } | null {
  try {
    const decoded = cashAddressToLockingBytecode(address) as { bytecode: Uint8Array } | string;
    if (typeof decoded === 'string') return null;
    const bytecode = decoded.bytecode;
    if (bytecode.length !== 25 || bytecode[0] !== 0x76 || bytecode[1] !== 0xa9 || bytecode[2] !== 0x14
      || bytecode[23] !== 0x88 || bytecode[24] !== 0xac) return null;
    const payload = bytecode.subarray(3, 23);
    return {
      cash: encodeCashAddress({ prefix: prefix as any, type: 'p2pkh', payload }).address,
      token: encodeCashAddress({ prefix: prefix as any, type: 'p2pkhWithTokens', payload }).address,
    };
  } catch { return null; }
}

/**
 * A session's address on `chain`. A CAIP-10 account is `bch:bitcoincash:qr…`: the namespace,
 * then the address with its prefix. An account on any other chain is not this one's.
 */
export function accountAddress(accounts: readonly string[], chain: string): string | undefined {
  return accounts.find((account) => account.startsWith(`${chain}:`))?.slice('bch:'.length);
}

export async function connectWalletConnect({ projectId, relayUrl, chain = 'bch:bchtest', onUri, onEnded, onAddress, signClient }: any) {
  const { default: Client } = signClient ? { default: signClient } : await import('@walletconnect/sign-client');
  const appUrl = globalThis.location?.origin ?? 'http://localhost';
  const hangUp = async (topic: string) => {
    const { getSdkError } = await import('@walletconnect/utils');
    await client.disconnect({ topic, reason: getSdkError('USER_DISCONNECTED') }).catch(() => {});
  };
  const client = await Client.init({
    projectId,
    telemetryEnabled: false,
    ...(relayUrl ? { relayUrl } : {}),
    metadata: {
      name: APP_NAME,
      description: APP_DESCRIPTION,
      url: appUrl,
      icons: [`${appUrl}/icon-512.png`],
    },
  });
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      bch: {
        methods: ['bch_getAddresses', 'bch_signTransaction', 'bch_signMessage'],
        chains: [chain],
        events: ['addressesChanged'],
      },
    },
  });
  if (uri && onUri) onUri(uri);
  const session = await approval();
  const address = accountAddress(session.namespaces.bch?.accounts ?? [], chain);
  if (address === undefined) {
    await hangUp(session.topic);
    throw Object.assign(new Error('This wallet offered no account on this network.'), { notice: true });
  }
  client.on('session_event', ({ topic, params }) => {
    if (topic !== session.topic || params.event.name !== 'addressesChanged' || !Array.isArray(params.event.data)) return;
    const [next] = params.event.data.filter((item) => typeof item === 'string').map((item) => (item.startsWith('bch:') ? item.slice('bch:'.length) : item));
    if (next?.startsWith(`${chain.slice('bch:'.length)}:`)) onAddress?.(next);
  });
  const ended = ({ topic }) => { if (topic === session.topic) onEnded?.(); };
  client.on('session_delete', ended);
  client.on('session_expire', ended);
  return {
    kind: 'walletconnect',
    address,
    walletName: session.peer.metadata?.name ?? 'WalletConnect',
    signRequest: (request: unknown): Promise<{ signedTransaction: string }> => client.request({
      chainId: chain,
      topic: session.topic,
      request: { method: 'bch_signTransaction', params: JSON.parse(stringify(request as object)) },
    }),
    disconnect: () => hangUp(session.topic),
  };
}

export async function qrDataUrl(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 512, color: { dark: '#0b0d10', light: '#ffffff' } });
}
