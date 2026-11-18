// What a wallet does for `bch_signTransaction`: P2PKH signing with SIGHASH_ALL|FORKID.
import { hash256, secp256k1 } from '../../web/src/libauth';
import { encodeDataPush } from '@bitauth/libauth/build/lib/vm/instruction-sets/common/push.js';
import { encodeSigningSerializationBch, SigningSerializationFlag } from '@bitauth/libauth/build/lib/vm/instruction-sets/common/signing-serialization.js';
import {
  encodeTokenPrefix, encodeTransactionInputSequenceNumbersForSigning, encodeTransactionOutput,
  encodeTransactionOutpoints, encodeTransactionOutputsForSigning,
} from '@bitauth/libauth/build/lib/message/transaction-encoding.js';
import { valueSatoshisToBin } from '@bitauth/libauth/build/lib/format/number.js';

const SIGHASH = SigningSerializationFlag.allOutputs | SigningSerializationFlag.forkId;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

function sighashPreimage(transaction: any, sourceOutputs: any[], inputIndex: number, coveredBytecode: Uint8Array): Uint8Array {
  const input = transaction.inputs[inputIndex];
  return encodeSigningSerializationBch({
    transactionOutpoints: encodeTransactionOutpoints(transaction.inputs),
    transactionOutputs: encodeTransactionOutputsForSigning(transaction.outputs),
    transactionSequenceNumbers: encodeTransactionInputSequenceNumbersForSigning(transaction.inputs),
    transactionUtxos: encodeTransactionOutputsForSigning(sourceOutputs),
    correspondingOutput: inputIndex < transaction.outputs.length
      ? encodeTransactionOutput(transaction.outputs[inputIndex]) : undefined,
    coveredBytecode,
    locktime: transaction.locktime,
    outpointIndex: input.outpointIndex,
    outpointTransactionHash: input.outpointTransactionHash,
    outputTokenPrefix: encodeTokenPrefix(sourceOutputs[inputIndex].token),
    outputValue: valueSatoshisToBin(sourceOutputs[inputIndex].valueSatoshis),
    sequenceNumber: input.sequenceNumber,
    signingSerializationType: Uint8Array.of(SIGHASH),
    version: transaction.version,
  });
}

export function signP2pkh(transaction: any, sources: any[], inputIndex: number, privateKey: Uint8Array): Uint8Array {
  const source = sources[inputIndex];
  const digest = hash256(sighashPreimage(transaction, sources, inputIndex, source.lockingBytecode));
  const signature = secp256k1.signMessageHashSchnorr(privateKey, digest);
  if (typeof signature === 'string') throw new Error(signature);
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return concat(encodeDataPush(Uint8Array.from([...signature, SIGHASH])), encodeDataPush(publicKey));
}
