// The deterministic devnet account. A local chain is worth nothing, so a fixed account is a
// feature: restarting the service, the page and the browser keeps the same funded account,
// and a test can name it without reading localStorage. The phrase and path match the first
// address of a Cashonize (and bch-wallet-lib) wallet, so the same seed imports there.
// Never use this phrase on a real chain.
import {
  binToHex, deriveHdPath, deriveHdPrivateNodeFromSeed, deriveSeedFromBip39Mnemonic,
  encodeCashAddress, hash160, secp256k1,
} from './libauth';

export const DEVNET_ACCOUNT_MNEMONIC =
  'cave cave cave cave cave cave cave cave cave cave cave cave';
/** BIP44's Bitcoin Cash path, which both this app and Cashonize use for a wallet's first address. */
export const DEVNET_ACCOUNT_PATH = "m/44'/145'/0'/0/0";

const privateKeyOf = (mnemonic: string): Uint8Array => {
  const seed = deriveSeedFromBip39Mnemonic(mnemonic);
  const root = deriveHdPrivateNodeFromSeed(seed, { throwErrors: true });
  if (typeof root === 'string') throw new Error(root);
  const child = deriveHdPath(root, DEVNET_ACCOUNT_PATH);
  if (typeof child === 'string') throw new Error(child);
  return child.privateKey;
};

const DEVNET_PRIVATE_KEY = privateKeyOf(DEVNET_ACCOUNT_MNEMONIC);
export const DEVNET_ACCOUNT_KEY_HEX = binToHex(DEVNET_PRIVATE_KEY);

/** The account's phrase, path, key and bchtest address. */
export function devnetAccount(prefix = 'bchtest'): {
  mnemonic: string;
  path: string;
  keyHex: string;
  privateKey: Uint8Array;
  address: string;
} {
  const pub = secp256k1.derivePublicKeyCompressed(DEVNET_PRIVATE_KEY);
  if (typeof pub === 'string') throw new Error(pub);
  const address = encodeCashAddress({ prefix: prefix as any, type: 'p2pkh', payload: hash160(pub) }).address;
  return {
    mnemonic: DEVNET_ACCOUNT_MNEMONIC,
    path: DEVNET_ACCOUNT_PATH,
    keyHex: DEVNET_ACCOUNT_KEY_HEX,
    privateKey: DEVNET_PRIVATE_KEY,
    address,
  };
}
