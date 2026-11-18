// Constants of the contracts, shared by the browser engine and the service. Keep this
// file free of Node imports: it is bundled for the browser. Which pools exist is a
// deployment's business, in deployments/.

export type PoolKind = 'bch' | 'token';

/** What each contract spends from its satoshi container: WITHDRAW_FEE and FINISH_FEE. */
export const withdrawFeeOf = (kind: PoolKind): bigint => (kind === 'bch' ? 41_000n : 43_500n);
export const finishFeeOf = (kind: PoolKind): bigint => (kind === 'bch' ? 90_000n : 91_000n);
/** About what a deposit's own transaction costs at 1 sat/B. The wallet pays it, and it is not the pool's. */
export const depositFeeOf = (kind: PoolKind): bigint => (kind === 'bch' ? 89_000n : 90_500n);
/** Satoshis each hashing or verifier coin holds. Every pool shares them, and anyone may add one. */
export const COIN_SATOSHIS = 1_000n;
/** Opens a satoshi or token container at deployment, and stays in it. */
export const SEED_SATOSHIS = 1_200n;
export const SEED_TOKENS = 1n;

export const LEVELS = 20;
export const NULLIFIER_LEVELS = 64;

/**
 * A pool's denomination is 10^exponent base units. The exponent is the pool's contract
 * argument, and its constructor bounds it with LEAST_EXPONENT and MOST_EXPONENT, which these
 * numbers mirror.
 * A few fixed amounts gather the notes into a few pools. BCH runs from 0.01 to 100 BCH. A token
 * pool's coin holds every live note, and 10^12 is the largest power of ten at which a full tree
 * of 2^LEVELS notes stays under the CashToken limit of 2^63 - 1 units.
 */
export const DENOMINATION_EXPONENTS: Record<PoolKind, { least: number; most: number }> = {
  bch: { least: 6, most: 10 },
  token: { least: 0, most: 12 },
};

/** Every denomination a pool of this kind may have, smallest first. */
export const poolDenominations = (kind: PoolKind): bigint[] => {
  const { least, most } = DENOMINATION_EXPONENTS[kind];
  return Array.from({ length: most - least + 1 }, (_, i) => 10n ** BigInt(least + i));
};

export const isPoolDenomination = (kind: PoolKind, denomination: bigint): boolean => (
  poolDenominations(kind).includes(denomination));

/** The exponent a pool's contract takes for a denomination: 10^exponent == denomination. */
export function exponentOf(denomination: bigint): bigint {
  let exponent = 0n;
  let unit = 1n;
  while (unit < denomination) {
    unit *= 10n;
    exponent += 1n;
  }
  if (unit !== denomination) throw new Error(`${denomination} is not a power of ten`);
  return exponent;
}

/** The rule a denomination breaks, in words. */
export const denominationRule = (kind: PoolKind): string => {
  const { least, most } = DENOMINATION_EXPONENTS[kind];
  return kind === 'bch'
    ? `a denomination must be a power of ten from 10^${least} to 10^${most} sat (0.01 to 100 BCH)`
    : `a denomination must be a power of ten from 10^${least} to 10^${most} units`;
};
