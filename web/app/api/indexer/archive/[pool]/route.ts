import { NextResponse } from 'next/server';
import { isDevnet } from '../../../../../lib/deployment';
import { serviceUrl } from '../../../../../lib/proxy';

export const dynamic = 'force-dynamic';

/** The devnet service's pool archive, served same-origin for the indexer-first paint. */
export async function GET(_request: Request, { params }: { params: Promise<{ pool: string }> }) {
  if (!isDevnet('devnet')) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { pool } = await params;
  try {
    const response = await fetch(serviceUrl(`/archive/${encodeURIComponent(pool)}`), { cache: 'no-store' });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'indexer unavailable' }, { status: 502 });
  }
}
