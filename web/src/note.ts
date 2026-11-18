// Notes, in the browser. The commitment is Pedersen(nullifier || secret),
// matching withdraw.circom.
// Only circomlibjs's Pedersen hash and BabyJubJub, by file: its package entry also loads the
// MiMC and Poseidon contract generators, which bring ethers v5 into the page. The package
// exports no subpaths, so the files are named by path.
// @ts-ignore -- circomlibjs ships no declarations
import buildPedersenHash from '../../node_modules/circomlibjs/src/pedersen_hash.js';
// @ts-ignore -- circomlibjs ships no declarations
import buildBabyjub from '../../node_modules/circomlibjs/src/babyjub.js';
import { bytesToHex, hexToBytes } from './fulcrum';
import { readNoteText, writeNoteText, type NotePool, type NoteText } from './note-text';
import { Notice } from './notice';

export interface Note {
  nullifier: bigint;
  secret: bigint;
  preimage: Uint8Array;
  commitment: bigint;
  nullifierHash: bigint;
}

const FIELD_BYTES = 31;

const toBig = (value: any): bigint => BigInt(value.toString());

const leBytes = (value: bigint, length = FIELD_BYTES): Uint8Array => {
  const out = new Uint8Array(length);
  let n = value;
  for (let i = 0; i < length; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};

const fromLe = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
};

const pedersenHash = await buildPedersenHash();
const babyJub = await buildBabyjub();

const pedersen = (data: Uint8Array): bigint => {
  const point = babyJub.unpackPoint(pedersenHash.hash(data));
  return toBig(babyJub.F.toObject(point[0]));
};

export function createNote(): Note {
  const random = crypto.getRandomValues(new Uint8Array(FIELD_BYTES * 2));
  const nullifier = fromLe(random.subarray(0, FIELD_BYTES));
  const secret = fromLe(random.subarray(FIELD_BYTES));
  const preimage = new Uint8Array(2 * FIELD_BYTES);
  preimage.set(leBytes(nullifier), 0);
  preimage.set(leBytes(secret), FIELD_BYTES);
  return {
    nullifier, secret, preimage,
    commitment: pedersen(preimage),
    nullifierHash: pedersen(leBytes(nullifier)),
  };
}

/** A note's text, read: what it names and the hashes of its secret. note-text.ts has the format. */
export function parseNote(text: string): Note & NoteText {
  const read = readNoteText(text);
  if (!read) throw new Notice('This is not a valid note.');
  const preimage = hexToBytes(read.preimageHex);
  const nullifier = fromLe(preimage.subarray(0, FIELD_BYTES));
  const secret = fromLe(preimage.subarray(FIELD_BYTES));
  return {
    ...read,
    nullifier, secret, preimage,
    commitment: pedersen(preimage),
    nullifierHash: pedersen(leBytes(nullifier)),
  };
}

/** A note's text for a pool on `network`, which names everything a withdrawal needs. */
export const noteString = (note: Note, pool: NotePool, network: string): string => (
  writeNoteText(pool, network, bytesToHex(note.preimage)));
