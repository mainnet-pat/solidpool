export interface VerifierProgram {
  R: Uint8Array;
  pieces: Uint8Array[];
}

export interface TransactionOptions {
  margin?: number;
  fills?: number[];
  fills0?: number[];
  maxIter?: number;
  forge?: boolean;
}

export interface VerifierTransaction {
  unlockings: Uint8Array[];
  fills: number[];
  locking: Uint8Array;
  pushes: Uint8Array[][];
  z: Uint8Array;
  H: Uint8Array[];
}

export function buildFrom(build: {
  redeemHex: string;
  codePiecesHex: string[];
  layout?: unknown;
}): VerifierProgram;

export function lockingOf(program: VerifierProgram): Uint8Array;
export function transactionFor(fixture: unknown, program: VerifierProgram, options?: TransactionOptions): VerifierTransaction;
export function unlockingsFor(core: unknown, program: VerifierProgram, fills: number[]): VerifierTransaction;
export function sizeFills(core: unknown, program: VerifierProgram, options?: TransactionOptions): { fills: number[]; runs: any[] };
/** The bytes of every body an input defines with OP_DEFINE; BCHN charges them as pushed bytes. */
export function definedBytes(program: VerifierProgram): number;
/** Whether the libauth this runtime resolved charges OP_DEFINE bodies itself, as BCHN does. */
export const VM_CHARGES_DEFINE: boolean;
/** The sources of the inputs in front of the verifier's three, which it reads none of: one plain coin by default. */
export function setPrefix(sources: unknown[]): void;
export function spendAll(lockings: Uint8Array[], unlockings: Uint8Array[], mode?: string): any[];
export function encodeUnlocking(pushes: Uint8Array[]): Uint8Array;
export function p2sh32(redeem: Uint8Array): Uint8Array;
export function reverseBin(bytes: Uint8Array): Uint8Array;
export function setOutputs(outputs: unknown[]): void;
export function setRecreated(edit: (output: unknown) => unknown): void;
export function quotientWords(statement: bigint[]): number;
export const MAX_QUOTIENT_WORDS: number;
export const STMT_LAYOUT: Record<string, number>;
export const CUTS: number[];
/** Blocks a verifier coin must stay unmoved before anyone may sweep it, as its transaction's only input. */
export const SWEEP_AGE: number;
export const MARGIN: number;
export const UNLOCK_CAP: number;
export const VMS: unknown;
