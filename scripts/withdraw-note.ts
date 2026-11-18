// Withdraw a note with nothing but the note, a recipient and a chain server: no app, no indexer and
// no browser. A note names its network, its pool's kind and category, and its amount
// (web/src/note-text.ts), so the pool is read from the chain; the proof is made here, from the
// circuit and key in web/public/prover/; and the withdrawal goes out as the page sends it.
//
//   read -rs NOTE && export NOTE
//   RECIPIENT=bitcoincash:... FULCRUM_URL=wss://... npx tsx scripts/withdraw-note.ts
//
// As on the page, the note's pool must be one its network's factories made, as the note says, or
// nothing is sent: the factories are web/deployments/<network>.json's, or BCH_FACTORY's and
// TOKEN_FACTORY's where the file names none. --unlisted-pool withdraws from a pool made elsewhere,
// after saying what that risks, for someone who chooses to recover such a note.
//
// BROADCAST_URL names a second server for the withdrawal, so that the first, which may have seen the
// deposit, sees nothing of it. Each is held to what the page asks of a server named in Settings:
// wss://, and Fulcrum 1.10 or later on the note's own network (web/src/network-check.ts), before
// anything is read through it. A note an older page wrote names no network, so NETWORK names it, and
// names its pool by a deployment's id or a category, which are looked up in that file's pools and in
// its factories' events. Where neither knows the pool, as for one no factory made, KIND names its kind
// (bch or token), ASSET a token pool's asset, and CATEGORY the pool's category when the note names it
// by an id: the note is then read in the current form, and checked as one.
import { readFileSync } from 'node:fs';
import { readNoteText } from '../web/src/note-text';
import { serversProblem, withdrawNote } from './lib/withdraw-note';

const note = process.env.NOTE?.trim() ?? '';
const recipient = process.env.RECIPIENT?.trim();
const fulcrumUrl = process.env.FULCRUM_URL;
const read = readNoteText(note);
if (!read || !recipient || !fulcrumUrl) throw new Error('Set NOTE to a note, RECIPIENT to an address and FULCRUM_URL to a server.');
const network = read.network ?? process.env.NETWORK;
if (network !== 'mainnet' && network !== 'chipnet') {
  throw new Error(read.network ? `This note is for ${read.network}, which has no public servers.` : 'This note names no network: set NETWORK to mainnet or chipnet.');
}
// A server of another chain, or one anybody on the path can rewrite, is refused before it is read.
const refused = await serversProblem(network, { FULCRUM_URL: fulcrumUrl, BROADCAST_URL: process.env.BROADCAST_URL });
if (refused) throw new Error(refused);
const file = `web/deployments/${network}.json`;
const deployment = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
/** A factory the file and the environment both name must be the same one, as the app requires. */
const factoryOf = (kind: 'bch' | 'token', variable: string): string | undefined => {
  const filed = deployment.factories?.[kind]?.trim().toLowerCase();
  const named = process.env[variable]?.trim().toLowerCase();
  if (filed && named && filed !== named) throw new Error(`${variable} names another factory than ${file} does.`);
  return named || filed;
};

const result = await withdrawNote({
  note,
  recipient,
  fulcrumUrl,
  ...(process.env.BROADCAST_URL ? { broadcastUrl: process.env.BROADCAST_URL } : {}),
  network,
  deployment: { pools: deployment.pools ?? [], factories: { bch: factoryOf('bch', 'BCH_FACTORY'), token: factoryOf('token', 'TOKEN_FACTORY') } },
  unlistedPool: process.argv.includes('--unlisted-pool'),
  ...(process.env.KIND?.trim() ? { kind: process.env.KIND.trim() as 'bch' | 'token' } : {}),
  ...(process.env.ASSET?.trim() ? { asset: process.env.ASSET.trim() } : {}),
  ...(process.env.CATEGORY?.trim() ? { category: process.env.CATEGORY.trim() } : {}),
  log: (line) => console.log(line),
});

if (result.outcome === 'paid') console.log(`Paid ${recipient} in ${result.txid}.`);
else if (result.outcome === 'sent') console.log(`Sent as ${result.txid}, and the pool does not show it yet. Keep the note until the recipient has the payment.`);
else console.log('This note was spent already, and this cannot confirm where it paid.');
process.exit(0);
