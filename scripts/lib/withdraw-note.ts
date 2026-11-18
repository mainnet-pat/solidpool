// Withdraw a note through a chain server alone: scripts/withdraw-note.ts, and the test that holds it
// to the page's rules. The note names its network and its pool (web/src/note-text.ts); the engine
// checks the pool against the network's factories, as the page does, reads it from the chain, and
// the proof is made here, from the circuit and key in web/public/prover/.
import { withdraw, type EngineConfig } from '../../web/src/engine';
import { checkServerAt, serverUrlProblem, type CheckedNetwork } from '../../web/src/network-check';
import { readNoteText, writeNoteText, type NoteText } from '../../web/src/note-text';
import type { PoolKind } from '../../web/src/pools';
import { proveStatement } from '../../service/lib/verifier';

/** What withdrawing from a pool no factory made means, said before it is done. */
export const UNLISTED_POOL_RISK = 'Withdrawing with --unlisted-pool: this pool may not be one this network\'s factories made. '
  + 'Whoever made such a pool may hold a second master and empty it, and may already have, '
  + 'so the withdrawal may find nothing to pay.';

/** What an older note lacks, said when nothing here could find its pool without it. */
export const OLDER_NOTE_TERMS = 'This note was written by an older page. It names neither its pool\'s kind nor a token pool\'s asset, '
  + 'and no pool list or factory here knows its pool. Name them: KIND=bch, or KIND=token and ASSET=<the token\'s category>, '
  + 'and CATEGORY=<the pool\'s category> when the note names its pool by a short id.';

export interface WithdrawNote {
  note: string;
  recipient: string;
  fulcrumUrl: string;
  /** A second server for the withdrawal, so that the first, which may have seen the deposit, sees nothing of it. */
  broadcastUrl?: string;
  /** The network of a note an older page wrote, which names none. */
  network?: string;
  /** The network's pools, for an older note that names one by id, and its factories, which every check reads. */
  deployment: { pools?: EngineConfig['pools']; factories?: EngineConfig['factories'] | null };
  /** Withdraw even from a pool no factory of the network made. */
  unlistedPool?: boolean;
  /**
   * What a note an older page wrote does not name: its pool's kind, a token pool's asset, and the
   * pool's category where the note names it by a deployment's id. With them the note is read in the
   * current form (inCurrentForm), and checked as one, so a pool no list or factory here knows can be
   * found, with `unlistedPool` if no factory made it.
   */
  kind?: PoolKind;
  asset?: string;
  category?: string;
  log?: (line: string) => void;
}

/**
 * Why the servers a withdrawal reads and sends through will not do, as the page asks of a server a
 * person names in Settings: TLS on mainnet and chipnet, so nobody on the path can change what they
 * say, then Fulcrum 1.10 or later following that network's own chain (web/src/network-check.ts).
 * `servers` names each by the setting it came from. Undefined when all will do. `check` stands in for
 * checkServerAt in tests.
 */
export async function serversProblem(
  network: 'mainnet' | 'chipnet', servers: Record<string, string | undefined>,
  check: (url: string, network: CheckedNetwork) => Promise<{ problem?: string; unreachable?: string }> = checkServerAt,
): Promise<string | undefined> {
  for (const [name, url] of Object.entries(servers)) {
    if (!url) continue;
    const problem = serverUrlProblem(network, url) ?? await check(url, network).then(({ problem: answer, unreachable }) => (
      unreachable ? `it did not answer (${unreachable})` : answer));
    if (problem) return `${name} will not do for ${network}: ${problem}.`;
  }
  return undefined;
}

/**
 * An older note in the current form (web/src/note-text.ts), from the terms it does not name: the
 * pool's kind, a token pool's asset, and its category where the note names it by a deployment's id.
 */
export function inCurrentForm(read: NoteText, network: string, terms: { kind?: string; asset?: string; category?: string }): string {
  if (read.kind !== undefined) throw new Error('This note names its pool\'s kind, category and asset itself, so name none of them.');
  if (terms.kind !== 'bch' && terms.kind !== 'token') throw new Error('Name the pool\'s kind: KIND=bch or KIND=token.');
  const named = /^[0-9a-f]{64}$/.test(read.poolId) ? read.poolId : undefined;
  const category = terms.category?.toLowerCase() ?? named;
  if (category === undefined) throw new Error('This note names its pool by an id, so name the pool\'s category too: CATEGORY=<category>.');
  if (named !== undefined && category !== named) throw new Error('That category is not the one this note names.');
  return writeNoteText({ kind: terms.kind, category, asset: terms.asset?.toLowerCase(), denomination: read.amount }, network, read.preimageHex);
}

export async function withdrawNote(request: WithdrawNote) {
  const read = readNoteText(request.note);
  if (!read) throw new Error('That is not a note.');
  const network = read.network ?? request.network;
  if (network !== 'mainnet' && network !== 'chipnet') {
    throw new Error(read.network ? `This note is for ${read.network}, which has no public servers.` : 'This note names no network: name mainnet or chipnet.');
  }
  const terms = [request.kind, request.asset, request.category].some((term) => term !== undefined);
  const note = terms ? inCurrentForm(read, network, request) : request.note;
  if (request.unlistedPool) request.log?.(UNLISTED_POOL_RISK);
  const config: EngineConfig = {
    network,
    networkId: network,
    addressPrefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest',
    fulcrumUrl: request.fulcrumUrl,
    ...(request.broadcastUrl ? { broadcastUrl: request.broadcastUrl } : {}),
    pools: request.deployment.pools ?? [],
    ...(request.deployment.factories ? { factories: request.deployment.factories } : {}),
    prover: { circuitUrl: '', provingKeyUrl: '' },
  };
  try {
    return await withdraw(config, note, request.recipient, request.log, proveStatement, { unlistedPool: request.unlistedPool });
  } catch (error) {
    // An older note names its pool only by an id or a category: where neither the list nor the
    // factories know it, its terms have to be named.
    if (read.kind === undefined && !terms && /does not know/.test(String((error as Error)?.message))) throw new Error(OLDER_NOTE_TERMS);
    throw error;
  }
}
