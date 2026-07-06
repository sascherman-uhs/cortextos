import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCTXRoot, getAllAgents } from '@/lib/config';
import { tryFastReply } from '@/lib/fastpath/fast-reply';
import { buildWindow } from '@/lib/fastpath/conversation-window';

export const dynamic = 'force-dynamic';

/**
 * POST /api/messages/send - Send a message to an agent
 *
 * Writes the message to the agent's inbox directory in the same format
 * as bus/send-message.sh. The agent's fast-checker daemon picks it up
 * on its next inbox check cycle (every 1 second).
 *
 * JARVIS MOD #34 (Cosmos fast path): [Cosmos]-tagged messages first try a
 * direct low-latency /v1/messages conversational reply (~1-2s) instead of the
 * full Claude Code PTY turn (median 10.3s measured 2026-07-06). On a fast
 * reply, the answer is appended straight to outbound-messages.jsonl (the same
 * file `cortextos bus send-mobile-reply` writes, which the SSE stream tails)
 * and the agent inbox is skipped. Turns needing tools/data — or any fast-path
 * error/timeout/missing-key — fall through to the normal inbox path unchanged.
 *
 * Body: { agent: string, text: string, type?: string }
 * Returns: { success: boolean, messageId: string, fastpath?: boolean }
 */

const COSMOS_PREFIX = '[Cosmos]';

function logInbound(ctxRoot: string, agent: string, entry: Record<string, unknown>): void {
  const logDir = path.join(ctxRoot, 'logs', agent);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, 'inbound-messages.jsonl'),
    JSON.stringify(entry) + '\n'
  );
}

function appendOutbound(ctxRoot: string, agent: string, text: string): string {
  // Same schema + timestamp format as `cortextos bus send-mobile-reply`
  const logDir = path.join(ctxRoot, 'logs', agent);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const messageId = `mobile-reply-${Date.now()}`;
  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent,
    text,
    message_id: messageId,
    type: 'text',
  });
  fs.appendFileSync(path.join(logDir, 'outbound-messages.jsonl'), entry + '\n');
  return messageId;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { agent, text, type } = body as {
    agent?: string;
    text?: string;
    type?: string;
  };

  if (!agent || typeof agent !== 'string') {
    return Response.json({ error: 'agent is required' }, { status: 400 });
  }
  if (!/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  if (!text || typeof text !== 'string') {
    return Response.json({ error: 'text is required' }, { status: 400 });
  }

  // Verify the agent actually exists in the registry (defense against
  // path traversal / arbitrary inbox creation even with a valid-looking name).
  const knownAgents = getAllAgents();
  const agentEntry = knownAgents.find((a) => a.name === agent);
  if (!agentEntry) {
    return Response.json({ error: 'Agent not found' }, { status: 404 });
  }

  const ctxRoot = getCTXRoot();

  // Sender identity: use the dashboard admin username so chat bar messages
  // land in the same channel as Telegram messages for the same user.
  const epochMs = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const from = (process.env.ADMIN_USERNAME ?? 'user').toLowerCase();
  const messageId = `${epochMs}-${from}-${rand}`;

  // === JARVIS MOD #34: Cosmos fast path =====================================
  const isCosmos = text.startsWith(COSMOS_PREFIX);
  let inboxText = text;
  if (isCosmos) {
    // Log the inbound turn FIRST so the fast-path conversation window sees it.
    try {
      logInbound(ctxRoot, agent, {
        id: messageId,
        timestamp: new Date().toISOString(),
        agent,
        direction: 'inbound',
        type: type || 'text',
        text,
        from_name: from,
        source: 'dashboard',
      });
    } catch { /* logging failure must not block the message */ }

    const userText = text.slice(COSMOS_PREFIX.length).trim();
    const result = await tryFastReply(agent, agentEntry.org, userText);

    if (result.kind === 'reply') {
      try {
        appendOutbound(ctxRoot, agent, result.text);
        return Response.json(
          { success: true, messageId, fastpath: true, latencyMs: result.latencyMs },
          { status: 200 }
        );
      } catch (err: unknown) {
        // Could not deliver the fast reply — fall through to the agent so the
        // user still gets an answer (slower, never silent).
        console.error('[api/messages/send] fastpath outbound append failed:', err);
      }
    }
    if (result.kind === 'escalate') {
      // Give the agent the recent fast-path exchange as context (plan B4).
      let recap = '';
      try {
        const recent = buildWindow(agent, 6).slice(0, -1); // exclude the current turn
        if (recent.length) {
          recap =
            '\nRecent voice exchange (some replies were answered by the fast path, not you):\n' +
            recent.map((t) => `${t.role === 'user' ? 'Scott' : 'Reply'}: ${t.content}`).join('\n');
        }
      } catch { /* recap is best-effort */ }
      inboxText = `${text}\n\n[fastpath: escalated — this turn needs tools/data/action; answer via your normal channel routing]${recap}`;
    }
    // 'unavailable' (no key) / 'error' / failed append → normal path, untouched text.
  }
  // === END MOD #34 ===========================================================

  // Priority 2 = normal (matches bus/send-message.sh mapping)
  const filename = `2-${epochMs}-from-${from}-${rand}.json`;

  const inboxDir = path.join(ctxRoot, 'inbox', agent);
  const tmpPath = path.join(inboxDir, `.tmp.${filename}`);
  const finalPath = path.join(inboxDir, filename);

  try {
    // Ensure inbox directory exists
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    // Build message JSON (same schema as bus/send-message.sh)
    const message = {
      id: messageId,
      from: from,
      to: agent,
      priority: 'normal',
      timestamp: new Date().toISOString(),
      text: inboxText,
      reply_to: null,
    };

    // Atomic write: temp file then rename (same pattern as send-message.sh)
    fs.writeFileSync(tmpPath, JSON.stringify(message) + '\n');
    fs.renameSync(tmpPath, finalPath);

    // Wake the target agent's fast-checker instantly via SIGUSR1
    const pidFile = path.join(ctxRoot, 'state', agent, '.fast-checker.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          process.kill(pid, 'SIGUSR1');
        }
      } catch {
        // Fast-checker may not be running
      }
    }

    // Log the inbound message for history (Cosmos turns were logged above,
    // before the fast-path attempt — don't double-log them).
    if (!isCosmos) {
      logInbound(ctxRoot, agent, {
        id: messageId,
        timestamp: new Date().toISOString(),
        agent,
        direction: 'inbound',
        type: type || 'text',
        text,
        from_name: from,
        source: 'dashboard',
      });
    }

    return Response.json({ success: true, messageId }, { status: 200 });
  } catch (err: unknown) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/messages/send] Error:', message);
    return Response.json(
      { error: 'Failed to send message', details: message },
      { status: 500 }
    );
  }
}
