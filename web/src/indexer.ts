// The first paint: an indexer's archive of each pool, read without the trustless engine.
// Kept apart from engine.ts so the pool tiles do not wait for the contracts and libauth;
// the engine loads in the background for deposits, proofs and anything the indexer lacks.

import { depositFeeOf, exponentOf, finishFeeOf, withdrawFeeOf, type PoolKind } from './pools';

export interface IndexerPool {
  id: string;
  kind: PoolKind;
  name: string;
  symbol: string;
  decimals: number;
  denomination: string;
  category: string;
  asset?: string;
}

export interface IndexerConfig {
  indexerUrl?: string;
  pools: readonly IndexerPool[];
}

/** A pool of these contracts pays a power of ten; anything else is not one of them. */
const isPoolOfThisCode = (pool: IndexerPool): boolean => {
  try {
    exponentOf(BigInt(pool.denomination));
    return true;
  } catch {
    return false;
  }
};

/**
 * A pool's row as the indexer has it. Pools named in `unchecked` are not asked for: they are
 * this browser's own, and are read from the chain instead. One pool the indexer cannot serve
 * leaves the others in the paint.
 */
export async function loadIndexedRows(config: IndexerConfig, unchecked: readonly string[] = []) {
  if (!config.indexerUrl) throw new Error('No indexer is configured for this network.');
  const base = config.indexerUrl.replace(/\/+$/, '');
  const skipped = new Set(unchecked);
  let loaded = 0;
  let failed = 0;
  const rows = await Promise.all(config.pools.filter(isPoolOfThisCode).map(async (raw) => {
    const row = {
      id: raw.id, kind: raw.kind, name: raw.name, symbol: raw.symbol, decimals: raw.decimals,
      // A note names its pool by category.
      denomination: raw.denomination, category: raw.category,
      ...(raw.asset === undefined ? {} : { asset: raw.asset }),
      depositValue: String((raw.kind === 'bch' ? BigInt(raw.denomination) : 0n)
        + withdrawFeeOf(raw.kind) + finishFeeOf(raw.kind)),
      depositFee: String(depositFeeOf(raw.kind)),
      hashing: false,
      source: 'indexer',
    };
    if (skipped.has(raw.id)) {
      failed += 1;
      return { ...row, notes: null, spent: null, unread: true };
    }
    try {
      // An indexer keeps each pool's archive under its category, whatever id a deployment gave it.
      const response = await fetch(`${base}/archive/${encodeURIComponent(raw.category.toLowerCase())}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Indexer: HTTP ${response.status}`);
      const body = await response.json() as { deposits?: unknown[]; withdrawals?: unknown[] };
      const deposits = Array.isArray(body.deposits) ? body.deposits.length : 0;
      const spent = Array.isArray(body.withdrawals) ? body.withdrawals.length : 0;
      loaded += 1;
      return { ...row, notes: Math.max(0, deposits - spent), spent };
    } catch {
      failed += 1;
      return { ...row, notes: null, spent: null, unread: true };
    }
  }));
  if (loaded === 0 && failed > 0) throw new Error('The indexer did not have any pool data.');
  return { pools: rows };
}
