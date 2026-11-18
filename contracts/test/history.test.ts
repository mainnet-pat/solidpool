import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveHistory } from '../../web/src/history';

// The optional archive is a speed-up a page may choose; the pool view checks whatever it
// returns. These read its wire shape and its refusal of a server that says no.
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const respond = (body: unknown, status = 200) => {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

describe('the archive history', () => {
  it('reads deposits and withdrawals in the pool client\'s form', async () => {
    respond({
      deposits: [{ leafIndex: 0, commitment: '7' }, { leafIndex: 1, commitment: '9' }],
      withdrawals: ['ab'.repeat(32)],
    });
    const history = new ArchiveHistory('http://archive.example/', 'pool-one');
    expect(await history.deposits()).toEqual([
      { leafIndex: 0, commitment: 7n },
      { leafIndex: 1, commitment: 9n },
    ]);
    expect(Array.from((await history.withdrawals())[0])).toEqual(new Array(32).fill(0xab));
  });

  it('refuses a server that answers with an error, so the chain is read instead', async () => {
    respond({ error: 'no such pool' }, 404);
    const history = new ArchiveHistory('http://archive.example', 'pool-one');
    await expect(history.deposits()).rejects.toThrow(/HTTP 404/);
  });
});
