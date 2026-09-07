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
import {
  activeStagings,
  agentStatus,
  bestClient,
  brainWedgeCheck,
  calendarToday,
  contactLookup,
  contractStat,
  mlsMarket,
  projectStatus,
  stagingCounts,
  vaultSearch,
} from '@/lib/realtime/fast-lanes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const AGENT = 'jarvis-telegram';
// === MOD #102 round 2 — was 45s, exactly the voice model's own budget, so the
// honest timeout message could never be delivered. 35s leaves room to say it. ===
const REPLY_TIMEOUT_MS = 35_000;
const POLL_INTERVAL_MS = 500;

// === MOD #102 round 2 — ask_jarvis serialization. Two concurrent questions
// each tailed the outbound log from their own byte offset and took the FIRST
// new reply — verified live: question BRAVO was answered "ALPHA". Replies
// carry no correlation id we control, so correctness comes from never having
// two waiters on the log at once: dispatches are chained through one promise.
// A queued question waits for the one in flight, which matches how a single
// spoken conversation works anyway. ===
let askJarvisChain: Promise<unknown> = Promise.resolve();
function serializeAskJarvis<T>(fn: () => Promise<T>): Promise<T> {
  const next = askJarvisChain.then(fn, fn);
  askJarvisChain = next.catch(() => undefined);
  return next;
}

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

// === JARVIS MOD #107 ROUND 2 — the double-answer fix (server half) ===========
// This route finds its answer by TAILING outbound-messages.jsonl. That is the
// SAME file api/messages/stream/[agent]/route.ts tails and pushes over SSE. So
// every answer this route returns ALSO arrives independently at the browser a
// moment later, as an ordinary outbound line.
//
// The client has a dedupe set for exactly this (fastReplyIdsRef, MOD #38) — but
// it could never contain these ids, because this route parsed only `text` and
// threw the identity away. Result: the model spoke its paraphrase of the answer,
// and then voice-panel's log-speak effect spoke the RAW Telegram text on top of
// it. Every tool-backed question was answered twice, in two different wordings.
//
// So the reply's identity now travels with the reply. The id MUST be computed
// exactly the way the SSE route computes it (`message_id`, falling back to
// `out-<timestamp>`) or the two sides will disagree and the echo gets through.
// That fallback is not a nicety: older log lines carry no message_id at all.
interface OutboundReply {
  text: string;
  /** Byte-identical to the id the SSE stream will emit for this same line. */
  id: string;
}

/** First agent reply appended after `fromOffset`, or null. */
function readNewReply(fromOffset: number): OutboundReply | null {
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
        const entry = JSON.parse(line) as {
          text?: string;
          message_id?: string;
          timestamp?: string | number;
        };
        if (entry.text?.trim()) {
          return {
            text: entry.text.trim(),
            // Mirrors api/messages/stream/[agent]/route.ts exactly.
            id: entry.message_id || `out-${entry.timestamp}`,
          };
        }
      } catch {
        // partial line still being written — next poll gets it
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// === JARVIS MOD #104 — the slow path now has two endings instead of one.
// A reply within budget returns { answer }. A timeout returns { answer,
// pending: true }: the honest holding text AND a signal the client uses to
// keep a pending-lookup ledger entry alive, so the late reply (tailed off the
// same outbound log by the SSE stream) gets injected into the live Realtime
// conversation and SPOKEN. Before this, the timeout text promised "it will
// appear shortly" into a pipeline where nothing could ever deliver it. ===
interface AskJarvisResult {
  answer: string;
  pending?: boolean;
  // === MOD #107 ROUND 2: the outbound line this answer came from, so the client
  // can suppress the SSE echo of the very same reply. Absent on the timeout
  // path (no reply exists yet) and on fast lanes (they never touch the log). ===
  replyId?: string;
}

async function askJarvis(question: string): Promise<AskJarvisResult> {
  const offsetBeforeSend = outboundSize();

  // MOD #104: the Telegram brain gets the same date anchor the voice model now
  // has — "this year" must mean the same range on both ends of the bridge.
  const todayLine = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

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
    body: JSON.stringify({
      agent: AGENT,
      text: `[Cosmos] ${question} (Context: today is ${todayLine}, Pacific time.)`,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`send-failed-${res.status}`);

  let payload: { fastpath?: boolean; replyText?: string; replyId?: string } = {};
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    // non-JSON success body — fall through to log tailing
  }
  // MOD #107 ROUND 2: the fast lane appends to the SAME outbound log, so its
  // reply echoes over SSE too — carry its id back for the dedupe set.
  if (payload.fastpath && payload.replyText) {
    return { answer: payload.replyText, replyId: payload.replyId };
  }

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const reply = readNewReply(offsetBeforeSend);
    if (reply) return { answer: reply.text, replyId: reply.id };
  }
  // MOD #104: honest timeout, and — new — a true promise. The client's ledger
  // plus the SSE tail now actually deliver the late answer, spoken, so the
  // model may promise delivery. It must NOT promise a time or reuse a stall
  // metaphor: the ledger's escalation covers the genuinely-stuck case.
  return {
    pending: true,
    answer:
      'That lookup is still running past its window. Tell the user, in one dry ' +
      'sentence and without any metaphor, that it is taking longer than it should ' +
      'and you will speak up the moment the answer lands. Then move on.',
  };
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
      // === JARVIS MOD #104 — date-range install counts ===
      case 'staging_counts': {
        const from = typeof args.from === 'string' ? args.from : undefined;
        const to = typeof args.to === 'string' ? args.to : undefined;
        const { output } = await stagingCounts(from, to);
        return Response.json({ output });
      }
      // === END MOD #104 ===
      case 'agent_status': {
        const { output } = await agentStatus();
        return Response.json({ output });
      }
      // === END JARVIS MOD #52 ===
      // === JARVIS MOD #102 — three more fast lanes ===
      case 'mls_market': {
        const { output } = await mlsMarket();
        return Response.json({ output });
      }
      case 'contact_lookup': {
        const q = typeof args.name === 'string' ? args.name.trim() : '';
        const { output } = await contactLookup(q);
        return Response.json({ output });
      }
      case 'best_client': {
        const { output } = await bestClient();
        return Response.json({ output });
      }
      // === END JARVIS MOD #102 ===
      // === JARVIS MOD #106 — the knowledge lanes. vault_search answers "what
      // does the contract say / what's our policy / what did we learn"; it is a
      // SEARCH and never proxies to ask_jarvis (which is a write door). It
      // returns `sources` for the UI to render — the voice never speaks paths.
      case 'vault_search': {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        const { output, sources, degraded } = await vaultSearch(q);
        return Response.json({ output, sources, degraded });
      }
      case 'project_status': {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        const { output } = await projectStatus(q);
        return Response.json({ output });
      }
      // === END JARVIS MOD #106 ===
      case 'ask_jarvis': {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) {
          return Response.json({ output: 'The question argument was empty.' });
        }
        // === JARVIS MOD #102 — refuse to dispatch into a wedged brain. The
        // 2026-08-03 demo queued four questions behind a PTY that had been
        // stuck for ten hours; each got "one moment, sir" and then silence.
        // If the ops brain has been silent for an hour with newer questions
        // pending, say so in one honest sentence instead. ===
        const wedge = brainWedgeCheck(AGENT);
        if (wedge.wedged) {
          const hours = Math.floor(wedge.sinceMinutes / 60);
          const ago = hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${wedge.sinceMinutes} minutes`;
          // Round 2: phrased for BOTH true wedges and long legitimate tasks —
          // from the listener's seat the observable fact is the same (no
          // answers for hours, questions queued), so state the fact and the
          // remedy without asserting which cause it is.
          return Response.json({
            output:
              `The deep-lookup engine has not answered anything in ${ago} and has questions ` +
              'queued behind whatever it is doing. Say that plainly: it is either stuck or deep ' +
              'in a long task, the quick answers still work, and if this persists it needs a restart.',
          });
        }
        // === END JARVIS MOD #102 ===
        const result = await serializeAskJarvis(() => askJarvis(question));
        // MOD #104: `pending` tells the client to keep its ledger entry alive
        // so the late reply gets spoken when the SSE tail delivers it.
        return Response.json({
          output: result.answer,
          pending: result.pending === true,
          // MOD #107 ROUND 2: identity of the outbound line this answer IS, so
          // the client can drop its SSE echo instead of speaking it a second
          // time on top of the model's paraphrase.
          replyId: result.replyId,
        });
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
