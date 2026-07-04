// === JARVIS MOD #20 — Cosmos voice loop: SSE stream-token minting (2026-07-03) ===
// Isolation zone: api/uhs/ is the established local-mod home so upstream routes
// stay untouched. The Cosmos voice panel opens an EventSource against the
// existing GET /api/messages/stream/[agent]?token=<jwt> route, whose auth is a
// bare jwtVerify(token, AUTH_SECRET) with NO audience/issuer/subject
// constraints. So this route: (1) gates on the NextAuth session (same shape as
// api/events/stream/route.ts), then (2) mints a short-lived HS256 JWT signed
// with AUTH_SECRET that satisfies that verify. EventSource can't send headers,
// hence the token-in-query handoff.
import { auth } from '@/lib/auth';
import { SignJWT } from 'jose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/uhs/stream-token — returns { token } valid for 5 minutes.
export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!authSecret) {
    console.error('[api/uhs/stream-token] AUTH_SECRET not set — cannot mint token');
    return Response.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  try {
    const secret = new TextEncoder().encode(authSecret);
    // Claims: the stream route only checks the signature + standard temporal
    // claims (exp/nbf) that jwtVerify enforces automatically. sub/iat are added
    // for hygiene and observability, not because the verifier requires them.
    const token = await new SignJWT({ scope: 'cosmos-stream' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(session.user?.id ?? session.user?.name ?? 'cosmos'))
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);

    return Response.json({ token }, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/uhs/stream-token] Failed to mint token:', message);
    return Response.json({ error: 'Failed to mint token' }, { status: 500 });
  }
}
// === END JARVIS MOD #20 ===
