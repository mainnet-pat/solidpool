import { NextResponse, type NextRequest } from 'next/server';

// The page talks to the Fulcrum server its user chose, so connections stay open to any
// origin. Everything it runs comes from here, and a note in a compromised page is a lost
// note, so an inline script runs only with this request's nonce: a missed escape cannot
// become a script. 'unsafe-eval' is the circuit's: old snarkjs builds its witness
// calculator from strings, from a file pinned by hash.
const policy = (nonce: string) => [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`,
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // A token's BCMR icon comes from the host its issuer named, or an IPFS gateway.
  "img-src 'self' data: https:",
  'connect-src * ws: wss:',
  // WalletConnect attests this page to a wallet from here, and each request waits for it.
  'frame-src https://verify.walletconnect.com https://verify.walletconnect.org',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function proxy(request: NextRequest) {
  const contentSecurityPolicy = policy(btoa(crypto.randomUUID()));
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', contentSecurityPolicy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', contentSecurityPolicy);
  return response;
}

// The page. Next reads the nonce from this header and puts it on its own scripts.
export const config = { matcher: ['/((?!api|_next|engine|wallet|favicon).*)'] };
