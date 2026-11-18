// The Groth16 verifier every pool uses. Its code names no pool, so all pools share one redeem
// and one lock, which the pools pin in their code (contracts/Sidecars.scash): a pool reads the
// statement the last verifier input proved and judges it against its own state. Anyone can make
// a coin of the lock, and anyone can sweep one unmoved for SWEEP_AGE blocks, as its
// transaction's only input.
import artifact from '../../service/verifier/verifier-artifact-3in.json';
import { binToHex, hash256, hexToBin } from './libauth';

// The verifier runtime works out its constants and starts a VM as it loads, about a second
// of work, so it loads at the first proof a page sizes rather than with the engine.
let runtime: Promise<typeof import('@solidpool/verifier')> | null = null;
const loadRuntime = () => {
  runtime ??= import('@solidpool/verifier');
  // A failed download is tried again by the next caller.
  runtime.catch(() => { runtime = null; });
  return runtime;
};

export interface VerifierProgram {
  /** The bytes a pool's contract compares to the spent coin, the same for every pool. */
  lock: Uint8Array;
  R: Uint8Array;
  pieces: Uint8Array[];
}

/** Blocks a verifier coin must stand unmoved before anyone may sweep it, alone in its transaction. */
export const VERIFIER_SWEEP_AGE: number = artifact.sweepAge;

let shared: VerifierProgram | undefined;

/** The verifier's redeem, lock and code pieces: one program for every pool. */
export function verifierProgram(): VerifierProgram {
  if (shared) return shared;
  const code = hexToBin(artifact.codePieces.map((piece) => piece.hex).join(''));
  const R = hexToBin(artifact.redeemHex);
  const lock = Uint8Array.from([0xaa, 0x20, ...hash256(R), 0x87]);
  if (binToHex(lock) !== artifact.lockingHex) throw new Error('The verifier artifact names another lock than its redeem gives.');
  const firstPiece = artifact.codePieces[0].bytes;
  shared = { lock, R, pieces: [code.subarray(0, firstPiece), code.subarray(firstPiece)] };
  return shared;
}

/** The unlocking that sweeps a lone verifier coin: the redeem alone, pushed. */
export function verifierSweepUnlocking(): Uint8Array {
  const { R } = verifierProgram();
  if (R.length < 76) return Uint8Array.from([R.length, ...R]);
  return Uint8Array.from([0x4c, R.length, ...R]);
}

/**
 * The longest proof this client makes. The verifier takes up to 150 words, but a token pool's
 * prepaid fee does not cover the longest of those in a grown pool, and a person could only
 * retry the same statement. A salt costs nothing to change, so this leaves room to spare.
 */
const MOST_QUOTIENT_WORDS = 141;

/** Whether a statement's proof fits the verifier's inputs and a pool's prepaid fee. About 1 in 30 does not. */
export async function statementFits(): Promise<(statement: bigint[]) => boolean> {
  const { MAX_QUOTIENT_WORDS, quotientWords } = await loadRuntime();
  return (statement) => quotientWords(statement) <= Math.min(MAX_QUOTIENT_WORDS, MOST_QUOTIENT_WORDS);
}

/** The three verifier inputs' unlocking bytecode for a proof, sized to their op budgets. */
export async function verifierUnlockings(fixture: unknown, program: VerifierProgram): Promise<Uint8Array[]> {
  const { transactionFor } = await loadRuntime();
  return transactionFor(fixture, { R: program.R, pieces: program.pieces }).unlockings;
}
