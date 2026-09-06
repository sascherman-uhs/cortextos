// === JARVIS MOD #51 — Realtime tool executor (Phase 1: ask_jarvis bridge) ===
// New file (isolated in the api/uhs/ local-mod zone). Session-authed POST.
// Executes function calls made by the OpenAI Realtime voice model. Phase 1
// ships a single tool, ask_jarvis: the question is routed to the
// jarvis-telegram agent (the one true JARVIS brain — calendar, CRM, MLS,
// skills, memory) and the reply text is returned for the Realtime voice to
// speak. This keeps ONE brain across Cosmos and Telegram; the voice model is
// a speech front-end, not a second source of truth.
//
// Reply transport: /api/messages/send appends agent replies to
// <ctxRoot>/logs/<agent>/outbound-messages.jsonl (same file the SSE stream
// tails). A fastpath send returns the reply synchronously; otherwise we tail
// the outbound log for the first entry newer than our send.
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { SignJWT } from 'jose';
import { auth } from '@/lib/auth';
import { getCTXRoot } from '@/lib/config';
// === JARVIS MOD #52 — direct fast-lane tools (the latency optimization this
// file's header anticipated). Read-only, sub-second, and every one of them
// degrades honestly rather than guessing. See src/lib/realtime/fast-lanes.ts. ===
import { activeStagings, agentStatus, calendarToday, contractStat } from '@/lib/realtime/fast-lanes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AGENT = 'jarvis-telegram';
const REPLY_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;

/** Mint a short-lived signed JWT for server-to-server loopback calls.
 *  The middleware (proxy.ts) verifies Bearer tokens with this same secret. */
async function mintInternalToken(): Promise<string> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET not configured');
  const encoded = new TextEncoder().encode(secret);
  return new SignJWT({ sub: 'jarvis-internal', role: 'internal' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(encoded);
}

function outboundLogPath(): string {
  return path.join(getCTXRoot(), 'logs', AGENT, 'outbound-messages.jsonl');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Byte offset of the outbound log right now (0 if absent). */
function outboundSize(): number {
  try {
    return fs.statSync(outboundLogPath()).size;
  } catch {
    return 0;
  }
}

/** First agent reply appended after `fromOffset`, or null. */
function readNewReply(fromOffset: number): string | null {
  let size: number;
  try {
    size = fs.statSync(outboundLogPath()).size;
  } catch {
    return null;
  }
  if (size <= fromOffset) return null;
  const fd = fs.openSync(outboundLogPath(), 'r');
  try {
    const buf = Buffer.alloc(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { text?: string };
        if (entry.text?.trim()) return entry.text.trim();
      } catch {
        // partial line still being written — next poll gets it
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

async function askJarvis(question: string): Promise<string> {
  const offsetBeforeSend = outboundSize();

  // Loopback to /api/messages/send. The middleware (proxy.ts) requires a
  // session cookie OR a signed Bearer JWT — no cookie exists in a server-side
  // fetch, so we mint a short-lived internal token with AUTH_SECRET.
  const internalToken = await mintInternalToken();
  const res = await fetch('http://127.0.0.1:3000/api/messages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ agent: AGENT, text: `[Cosmos] ${question}`, stream: false }),
  });
  if (!res.ok) throw new Error(`send-failed-${res.status}`);

  let payload: { fastpath?: boolean; replyText?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // non-JSON success body — fall through to log tailing
  }
  if (payload.fastpath && payload.replyText) return payload.replyText;

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const reply = readNewReply(offsetBeforeSend);
    if (reply) return reply;
  }
  return (
    'JARVIS is still working on that and will deliver the answer through the ' +
    'conversation log momentarily. Tell the user the lookup is taking longer ' +
    'than usual and the result will appear shortly.'
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { name?: string; arguments?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = body.name?.trim();
  let args: Record<string, unknown> = {};
  try {
    args = body.arguments ? (JSON.parse(body.arguments) as typeof args) : {};
  } catch {
    return Response.json({ error: 'Invalid arguments JSON' }, { status: 400 });
  }

  try {
    switch (name) {
      // === JARVIS MOD #52 — fast lanes. Each is a direct read that answers in
      // the hundreds-of-milliseconds range instead of the 45s-worst-case
      // ask_jarvis round trip. Read-only: nothing here writes or sends. ===
      case 'calendar_today': {
        const { output } = await calendarToday();
        return Response.json({ output });
      }
      case 'contract_stat': {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        const { output } = await contractStat(q);
        return Response.json({ output });
      }
      case 'active_stagings': {
        const { output } = await activeStagings();
        return Response.json({ output });
      }
      case 'agent_status': {
        const { output } = await agentStatus();
        return Response.json({ output });
      }
      // === END JARVIS MOD #52 ===
      case 'ask_jarvis': {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) {
          return Response.json({ output: 'The question argument was empty.' });
        }
        const answer = await askJarvis(question);
        return Response.json({ output: answer });
      }
      default:
        return Response.json({ output: `Unknown tool: ${name ?? '(none)'}` });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/uhs/realtime/tool] ${name} failed: ${message}`);
    return Response.json({
      output: `The tool call failed (${message}). Apologize briefly and suggest trying again.`,
    });
  }
}
// === END JARVIS MOD #51 ===
