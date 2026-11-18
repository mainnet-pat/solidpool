// Narrow libauth entry for the browser bundle. Importing the package root
// pulls the compiler (and its circular VM imports) into esbuild, which then
// fails at runtime; these submodules are the only pieces the app uses.
export { sha256, secp256k1 } from '@bitauth/libauth/build/lib/crypto/default-crypto-instances.js';
export { hash160, hash256 } from '@bitauth/libauth/build/lib/crypto/combinations.js';
export { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth/build/lib/address/cash-address.js';
export {
  cashAddressToLockingBytecode, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
} from '@bitauth/libauth/build/lib/address/locking-bytecode.js';
export {
  decodeTransaction, encodeTokenPrefix, encodeTransaction, encodeTransactionInputSequenceNumbersForSigning, encodeTransactionOutpoints,
  encodeTransactionOutput, encodeTransactionOutputsForSigning,
} from '@bitauth/libauth/build/lib/message/transaction-encoding.js';
export {
  SigningSerializationFlag, encodeSigningSerializationBch,
} from '@bitauth/libauth/build/lib/vm/instruction-sets/common/signing-serialization.js';
export { valueSatoshisToBin } from '@bitauth/libauth/build/lib/format/number.js';
export { createVirtualMachineBch2026 } from '@bitauth/libauth/build/lib/vm/instruction-sets/bch/2026/bch-2026-vm.js';
export { encodeDataPush } from '@bitauth/libauth/build/lib/vm/instruction-sets/common/push.js';
export { binToHex, hexToBin } from '@bitauth/libauth/build/lib/format/hex.js';
export { binToUtf8 } from '@bitauth/libauth/build/lib/format/utf8.js';
export { deriveSeedFromBip39Mnemonic } from '@bitauth/libauth/build/lib/key/bip39.js';
export { deriveHdPath, deriveHdPrivateNodeFromSeed } from '@bitauth/libauth/build/lib/key/hd-key.js';
export {
  decodeAuthenticationInstructions,
} from '@bitauth/libauth/build/lib/vm/instruction-sets/common/instruction-sets-utils.js';
export { stringify } from '@bitauth/libauth/build/lib/format/log.js';
