// The archive: each pool's deposits and spent nullifiers, read from Fulcrum and kept so
// a browser need not download every transaction. It is a cache, not an authority: the
// browser rebuilds the pool from what this returns and refuses it unless it reproduces
// the roots in the pool's state record.
import { Fulcrum, bytesToHex } from '../web/src/fulcrum';
import { ChainHistory } from '../web/src/history';
import { PoolClient, type PoolDefinition } from '../web/src/pool-client';
import { FulcrumProvider } from '../web/src/provider';
import type { PoolKind } from '../web/src/pools';

export interface DeployedPool {
  id: string; kind: PoolKind; name: string; symbol: string; decimals: number;
  denomination: string; category: string; asset?: string;
}

export class Archive {
  private readonly histories = new Map<string, ChainHistory>();
  private readonly reader: Fulcrum;
  private readonly provider: FulcrumProvider;

  constructor(deployment: { network: string; pools: DeployedPool[] }, fulcrumUrl: string) {
    this.reader = new Fulcrum(fulcrumUrl);
    this.provider = new FulcrumProvider(deployment.network, this.reader);
    for (const pool of deployment.pools) this.add(pool);
  }

  /**
   * Add a pool's history; pools discovered after startup join the same archive. A page asks for it
   * by the pool's category, as it asks the indexer, which knows pools by nothing else; a deployment's
   * own id still names it too.
   */
  add(pool: DeployedPool): void {
    const category = pool.category.toLowerCase();
    if (this.histories.has(category)) return;
    const definition: PoolDefinition = {
      id: pool.id, kind: pool.kind, denomination: BigInt(pool.denomination), category: pool.category,
      ...(pool.asset ? { asset: pool.asset } : {}),
    };
    const history = new ChainHistory(this.reader, new PoolClient(definition, this.provider));
    this.histories.set(category, history);
    if (!this.histories.has(pool.id)) this.histories.set(pool.id, history);
  }

  has(poolId: string): boolean {
    return this.histories.has(poolId);
  }

  async read(poolId: string) {
    const history = this.histories.get(poolId);
    if (!history) throw new Error(`unknown pool ${poolId}`);
    const [deposits, withdrawals] = await Promise.all([history.deposits(), history.withdrawals()]);
    return {
      deposits: deposits.map(({ leafIndex, commitment }) => ({ leafIndex, commitment: commitment.toString() })),
      withdrawals: withdrawals.map(bytesToHex),
    };
  }
}
