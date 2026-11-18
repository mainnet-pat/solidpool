// Record a real SDK-built withdrawal and the outputs it spends: proofs/withdrawal-bch.json, which
// forge.ts replays. A pool is made through its factory on the mock, a note is deposited, finished
// and withdrawn with a real proof under the production key, as the app does.
//
//   tsx service/verifier/record-withdrawal.ts
//
// Run it again when the pools' or the verifier's code changes: a withdrawal names the locks it spends.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { proveStatement } from '../lib/verifier';
import { lockOf, newSpend, poolOnMock } from '../../contracts/test/lib/setup';

const { provider, signers: [alice, bob], client, view } = await poolOnMock('bch');
const note = newSpend();
await client.deposit(alice, note.commitment, await view());
await client.finish(await view());
const withdrawal = await client.withdraw(note, lockOf(bob.getAddress()), await view(), proveStatement);
const tx = decodeTransaction(hexToBin(withdrawal.hex));
if (typeof tx === 'string') throw new Error(tx);
const sourceOutputs = await Promise.all(tx.inputs.map(async (input) => {
  const parent = decodeTransaction(hexToBin(await provider.getRawTransaction(binToHex(input.outpointTransactionHash))));
  if (typeof parent === 'string') throw new Error(parent);
  const output = parent.outputs[input.outpointIndex];
  return {
    lockingBytecode: binToHex(output.lockingBytecode),
    valueSatoshis: String(output.valueSatoshis),
    ...(output.token ? {
      token: {
        category: binToHex(output.token.category),
        amount: String(output.token.amount),
        ...(output.token.nft ? { nft: { capability: output.token.nft.capability, commitment: binToHex(output.token.nft.commitment) } } : {}),
      },
    } : {}),
  };
}));
const file = join(dirname(fileURLToPath(import.meta.url)), 'proofs', 'withdrawal-bch.json');
writeFileSync(file, `${JSON.stringify({
  provenance: 'A withdrawal from a 0.01 BCH pool made through its factory on the mock, with a real proof under the production key; written by service/verifier/record-withdrawal.ts.',
  transaction: withdrawal.hex,
  sourceOutputs,
}, null, 1)}\n`);
console.log(`wrote ${file}: ${withdrawal.hex.length / 2} B, ${sourceOutputs.length} inputs`);
process.exit(0);
