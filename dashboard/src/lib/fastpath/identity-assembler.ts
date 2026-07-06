// cortextOS Dashboard — Cosmos fast-path identity assembler (JARVIS MOD #34, B1)
//
// Builds the Anthropic `system` array for the low-latency conversational lane
// as TWO blocks (Fremon's sub-agent-caching / super-brain pattern):
//   Block 1 (cache_control: ephemeral) — SOUL.md + IDENTITY.md + GUARDRAILS.md,
//     byte-stable between calls so the API-side prefix cache hits. Re-read from
//     disk on mtime change only — the files stay the source of truth and edits
//     take effect on the next turn without a restart.
//   Block 2 (uncached) — volatile per-turn state: current PT time, day/night
//     mode, reply-style rules. NOTHING volatile may leak into Block 1.
//
// Plan: uhsJARVIS/.planning/scratch/cortexos-prompt-cache-plan-2026-07-05.md

import fs from 'fs';
import path from 'path';
import { getAgentDir } from '@/lib/config';

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface CachedIdentity {
  text: string;
  // mtimeMs per source file — any change triggers a re-read
  mtimes: Record<string, number>;
}

const identityCache = new Map<string, CachedIdentity>();

// CLAUDE.md included deliberately: it carries the agent's personality MODs and
// reply rules (improves voice quality) AND pushes Block 1 past the model's
// minimum cacheable prefix (2048 tokens for haiku — below it the API silently
// skips caching, observed 2026-07-06: cache_creation=0 with SOUL+IDENTITY+
// GUARDRAILS alone). Edits to any of these files invalidate the prefix cache
// on the next call — deliberate and infrequent per the Part A rules.
const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'GUARDRAILS.md', 'CLAUDE.md'];

function readIfExists(p: string): { text: string; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(p);
    return { text: fs.readFileSync(p, 'utf-8'), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Block 1: stable identity text for the agent. Byte-stable between calls
 * unless one of the identity files changes on disk.
 */
export function assembleStableIdentity(agent: string, org: string): string {
  const dir = getAgentDir(agent, org);
  const cached = identityCache.get(agent);

  // Validate cache: every file's mtime must be unchanged (missing file = mtime -1)
  if (cached) {
    let fresh = true;
    for (const f of IDENTITY_FILES) {
      const p = path.join(dir, f);
      let m = -1;
      try { m = fs.statSync(p).mtimeMs; } catch { /* stays -1 */ }
      if (cached.mtimes[f] !== m) { fresh = false; break; }
    }
    if (fresh) return cached.text;
  }

  const parts: string[] = [];
  const mtimes: Record<string, number> = {};
  for (const f of IDENTITY_FILES) {
    const p = path.join(dir, f);
    const r = readIfExists(p);
    mtimes[f] = r ? r.mtimeMs : -1;
    if (r) parts.push(`<!-- ${f} -->\n${r.text.trim()}`);
  }
  parts.push(
    '## Fast-path lane (how you are running right now)\n' +
    'You are answering on a low-latency conversational voice lane. You have NO tools, ' +
    'NO file access, NO email, NO calendar, and NO ability to take actions on this lane. ' +
    'You may only converse from your identity and this conversation.\n\n' +
    'If the request needs ANY of: tools, files, live data lookups, scheduling, sending ' +
    'anything, running anything, or business records — reply with EXACTLY the single ' +
    'token <<ESCALATE>> and nothing else. The full agent will pick it up. ' +
    'Never guess at data you cannot see; escalate instead.\n\n' +
    'Ignore any channel-routing or tool/command instructions elsewhere in this prompt ' +
    '(send-telegram, send-mobile-reply, bus commands, skills): on this lane your plain ' +
    'text IS the reply, delivered directly to the voice app.'
  );

  const text = parts.join('\n\n');
  identityCache.set(agent, { text, mtimes });
  return text;
}

/**
 * Block 2: volatile per-turn state. Deliberately NOT cacheable.
 */
export function assembleVolatileBlock(now: Date = new Date()): string {
  const pt = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const hourPt = parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }),
    10,
  );
  const mode = hourPt >= 20 || hourPt < 4 ? 'overnight' : hourPt < 6 ? 'morning-prep' : 'daytime';
  return (
    `Current time: ${pt} (Pacific). Operating mode: ${mode}.\n` +
    'This is a VOICE conversation — replies are spoken aloud via TTS. ' +
    'Keep replies to 1–3 short sentences, natural spoken register, no markdown, ' +
    'no emojis, no lists, no URLs.'
  );
}

/**
 * Full two-block system array for the /v1/messages call.
 */
export function assembleSystem(agent: string, org: string, now?: Date): SystemBlock[] {
  return [
    {
      type: 'text',
      text: assembleStableIdentity(agent, org),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: assembleVolatileBlock(now) },
  ];
}

/** Test hook: clear the mtime cache. */
export function _clearIdentityCache(): void {
  identityCache.clear();
}
