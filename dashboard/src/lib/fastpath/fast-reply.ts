// cortextOS Dashboard — Cosmos fast-path reply engine (JARVIS MOD #34, B2/B4/B5)
//
// Direct /v1/messages call for pure-conversational [Cosmos] voice turns.
// ~1–2s instead of the 4–10s (median 10.3s measured 2026-07-06) full
// Claude Code PTY turn. Anything needing tools/data escalates to the real
// agent via the existing inbox (handled by the send route).
//
// Guardrails (plan B5): no tools in the request, conversational only,
// hard timeout so the fast path can never be SLOWER than falling through,
// metrics JSONL with cache_creation/read tokens per call.
//
// Key resolution is REQUEST-TIME (feedback_wire_dormant_integrations_now):
// env ANTHROPIC_API_KEY, else FASTPATH_ANTHROPIC_API_KEY/ANTHROPIC_API_KEY in
// ~/cortextos/orgs/<org>/secrets.env (mtime-cached). No key → 'unavailable'
// and the route falls through to the normal agent path unchanged.

import fs from 'fs';
import path from 'path';
import { getAgentDir, getLogDir, getFrameworkRoot } from '@/lib/config';
import { assembleSystem } from './identity-assembler';
import { buildWindow, type Turn } from './conversation-window';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.FASTPATH_MODEL || 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = parseInt(process.env.FASTPATH_TIMEOUT_MS || '6000', 10);
const MAX_TOKENS = 500;
const ESCALATE_TOKEN = '<<ESCALATE>>';

export type FastReplyResult =
  | { kind: 'reply'; text: string; latencyMs: number }
  | { kind: 'escalate' }
  | { kind: 'unavailable' } // no API key configured — use normal path
  | { kind: 'error'; error: string };

// --- request-time key lookup, mtime-cached ---------------------------------

let keyCache: { key: string | null; mtimeMs: number; path: string } | null = null;

function resolveApiKey(org: string): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const secretsPath = path.join(getFrameworkRoot(), 'orgs', org, 'secrets.env');
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(secretsPath).mtimeMs; } catch { return null; }
  if (keyCache && keyCache.path === secretsPath && keyCache.mtimeMs === mtimeMs) {
    return keyCache.key;
  }
  let key: string | null = null;
  try {
    for (const line of fs.readFileSync(secretsPath, 'utf-8').split('\n')) {
      const m = line.match(/^(?:export\s+)?(?:FASTPATH_)?ANTHROPIC_API_KEY=["']?([^"'\s]+)/);
      if (m) { key = m[1]; break; }
    }
  } catch { /* unreadable → null */ }
  keyCache = { key, mtimeMs, path: secretsPath };
  return key;
}

// --- voice cue (B2): payload-only, never persisted --------------------------

let cueCache: { text: string; mtimeMs: number; agent: string } | null = null;

export function readVoiceCue(agent: string, org: string): string {
  const cuePath = path.join(getAgentDir(agent, org), 'VOICE_CUE.md');
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(cuePath).mtimeMs; } catch { return ''; }
  if (cueCache && cueCache.agent === agent && cueCache.mtimeMs === mtimeMs) {
    return cueCache.text;
  }
  let text = '';
  try { text = fs.readFileSync(cuePath, 'utf-8').trim(); } catch { /* '' */ }
  cueCache = { text, mtimeMs, agent };
  return text;
}

/**
 * Append the voice cue to the LAST user message in the payload only.
 * The stored logs never contain the cue (unit-tested invariant).
 */
export function applyVoiceCue(messages: Turn[], cue: string): Array<{ role: string; content: string }> {
  const out = messages.map((m) => ({ role: m.role, content: m.content }));
  if (cue) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === 'user') {
        out[i] = { ...out[i], content: `${out[i].content}\n\n<voice_cue>\n${cue}\n</voice_cue>` };
        break;
      }
    }
  }
  return out;
}

// --- metrics (B5) ------------------------------------------------------------

function logMetrics(agent: string, entry: Record<string, unknown>): void {
  try {
    const logDir = getLogDir(agent);
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'fastpath-metrics.jsonl'),
      JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch { /* metrics must never break the reply path */ }
}

// --- main entry (B4) ---------------------------------------------------------

/**
 * Attempt a fast conversational reply for a [Cosmos] user turn.
 * `userText` is the message WITHOUT the [Cosmos] prefix.
 * The caller has already appended the turn to inbound-messages.jsonl, so the
 * window read here includes it.
 */
export async function tryFastReply(
  agent: string,
  org: string,
  userText: string,
): Promise<FastReplyResult> {
  const apiKey = resolveApiKey(org);
  if (!apiKey) return { kind: 'unavailable' };

  const started = Date.now();
  try {
    const system = assembleSystem(agent, org);
    let window = buildWindow(agent);
    // Ensure the current turn is the last user message even if the log append
    // hasn't landed yet (defensive — caller appends before calling us).
    const last = window[window.length - 1];
    if (!last || last.role !== 'user' || !last.content.includes(userText)) {
      window = [...window, { role: 'user', content: userText, ts: started }];
    }
    const messages = applyVoiceCue(window, readVoiceCue(agent, org));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages,
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      logMetrics(agent, { event: 'error', status: resp.status, latencyMs, error: errBody.slice(0, 300) });
      return { kind: 'error', error: `HTTP ${resp.status}` };
    }

    const data = await resp.json() as {
      content?: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens?: number; output_tokens?: number;
        cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
      };
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text as string)
      .join('')
      .trim();

    const u = data.usage ?? {};
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    const denom = read + write + (u.input_tokens ?? 0);
    logMetrics(agent, {
      event: text === ESCALATE_TOKEN ? 'escalate' : 'reply',
      model: DEFAULT_MODEL,
      latencyMs,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: write,
      cache_read_input_tokens: read,
      cache_read_ratio: denom ? Math.round((read / denom) * 100) / 100 : 0,
    });

    if (!text || text === ESCALATE_TOKEN || text.includes(ESCALATE_TOKEN)) {
      return { kind: 'escalate' };
    }
    return { kind: 'reply', text, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - started;
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'timeout' : err.message) : String(err);
    logMetrics(agent, { event: 'error', latencyMs, error: msg.slice(0, 300) });
    return { kind: 'error', error: msg };
  }
}
