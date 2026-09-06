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
import { getAgentDir, getFrameworkRoot } from '@/lib/config';

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

// === JARVIS MOD #46: org-wide voice core =====================================
// orgs/<org>/VOICE.md carries the shared voice mechanics (banned openers,
// blade structure, cruelty floor, client brake, tonal checkpoint) for the
// whole fleet; each agent's IDENTITY.md Vibe supplies the register + one-liner
// calibration set. Static text only — same cache rules as the agent files.
// Keyed in the mtime map as 'ORG:VOICE.md' so it participates in invalidation.
const ORG_VOICE_KEY = 'ORG:VOICE.md';

function orgVoicePath(org: string): string {
  return path.join(getFrameworkRoot(), 'orgs', org, 'VOICE.md');
}
// === END MOD #46 =============================================================

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
    // === JARVIS MOD #46: org VOICE.md participates in cache invalidation ===
    if (fresh) {
      let m = -1;
      try { m = fs.statSync(orgVoicePath(org)).mtimeMs; } catch { /* stays -1 */ }
      if (cached.mtimes[ORG_VOICE_KEY] !== m) fresh = false;
    }
    // === END MOD #46 ===
    if (fresh) return cached.text;
  }

  const parts: string[] = [];
  const mtimes: Record<string, number> = {};
  // === JARVIS MOD #46: shared org voice core loads FIRST (agent files may
  // override register specifics; precedence text lives inside VOICE.md) ===
  {
    const r = readIfExists(orgVoicePath(org));
    mtimes[ORG_VOICE_KEY] = r ? r.mtimeMs : -1;
    if (r) parts.push(`<!-- org VOICE.md -->\n${r.text.trim()}`);
  }
  // === END MOD #46 ===
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
    // === JARVIS MOD #66 — the specific rule, because the general one failed ===
    // "Don't guess" did not stop this lane inventing "five staged, two active"
    // against a real 21: a count question reads as conversation, not as a
    // lookup. So the rule is now about numbers specifically, and it is
    // checkable — either the figure is in the turn's snapshot or it is not.
    'NUMBERS RULE — absolute. You may state a quantity about the business ONLY if that ' +
    'exact figure appears in the AUTHORITATIVE LIVE COUNTS list in this prompt. ' +
    'For every other quantity — how many stagings, projects, contracts, leads, agents, ' +
    'listings, emails, dollars, or anything countable — reply <<ESCALATE>> alone. ' +
    'This holds even when you feel certain, even if the number appeared earlier in this ' +
    'conversation, and even if the user is only asking for a rough or approximate figure. ' +
    'A confident wrong number is the single worst thing you can say: it contradicts the ' +
    'dashboard in front of Scott and it is acted on. "Let me pull that" is always ' +
    'acceptable; an invented count never is.\n\n' +
    // === JARVIS MOD #67 — the rule above only fired when Scott ASKED ===
    // The 25-turn soak found 6 of the first 10 turns inventing figures nobody
    // requested — offered as texture. A decorative number does not feel like a
    // data claim, so the rule has to name that case and show it. Examples are
    // the actual soak failures: models copy examples far better than they
    // generalize prohibitions.
    'THIS ALSO APPLIES TO NUMBERS NOBODY ASKED FOR. The rule is about every specific ' +
    'figure, date, count, duration, temperature, percentage, or status you STATE — ' +
    'including ones you volunteer unprompted as conversational colour. Decoration is ' +
    'not exempt. If it sounds like a fact about the business, it is one.\n\n' +
    'These are real things this lane has said, and every one was invented: ' +
    '"Two showings lined up for Sable Ridge today." "Calendar\'s clear until 2." ' +
    '"Days on market creeping toward 45." "Five days now." "115 degrees, crews work ' +
    '5 AM to noon." "That\'s 70% utilization." "Last check was Friday — they said end ' +
    'of week." None of it was true. Scott cannot tell invented from real when you say ' +
    'it in that voice — that is exactly what makes it damaging.\n\n' +
    'The voice examples in your identity are the most dangerous source of this. Their ' +
    'numbers, days, and times — 41 days, three showings, 2 PM, Tuesday, ten minutes — ' +
    'are STYLE SAMPLES. Sound like those lines; never reuse their contents. If a figure ' +
    'from a voice example appears in your reply, you have made an error.\n\n' +
    // === MOD #67b — found by re-running the soak against the rule above ===
    // Two failure modes survived the first pass, and they compound: the lane
    // invents the STATUS of pending things, and then treats its own invention
    // as established fact once it is sitting in the conversation window.
    'STATUS IS DATA TOO. How overdue something is, when you last heard from ' +
    'someone, whether a contract came back, what a vendor said, how many ' +
    'invoices are outstanding — you do not have any of it on this lane. Never ' +
    'answer with "three days overdue", "last I had was Friday", "one invoice is ' +
    'outstanding", or "they said end of week". You are not remembering those; ' +
    'you are inventing them. Say you do not have it and offer to pull it.\n\n' +
    'YOUR OWN EARLIER REPLIES ARE NOT A SOURCE. A figure you produced a few ' +
    'turns ago is not evidence — if you invented it then, repeating it now ' +
    'launders a guess into a fact, and it hardens every time. Only three things ' +
    'ground a figure: the AUTHORITATIVE LIVE COUNTS above, a tool or agent ' +
    'result, and what Scott himself told you. Nothing else counts, including ' +
    'anything you said.\n\n' +
    'THE BLADE STILL APPLIES — it just needs a real number. Number first, verdict ' +
    'second is right whenever you HAVE the number: "21 active stagings. One warehouse ' +
    'is doing the work of two." With no real number, do not reach for one. Lead with ' +
    'what you actually know, name the limit, or ask — "I don\'t have the days-on-market ' +
    'figure in front of me. Want me to pull it?" is fully in voice. Dry and honest ' +
    'outranks dry and invented; a blade swung at a made-up number cuts Scott, not the ' +
    'problem.\n\n' +
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
export function assembleVolatileBlock(now: Date = new Date(), snapshot = ''): string {
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
    // === JARVIS MOD #66: live counts lead the uncached block. Volatile by
    // definition, so they must never migrate into the cached identity block. ===
    (snapshot ? `${snapshot}\n\n` : '') +
    `Current time: ${pt} (Pacific). Operating mode: ${mode}.\n` +
    'This is a VOICE conversation — replies are spoken aloud via TTS. ' +
    '40 words MAX, 2 sentences MAX. Natural spoken register. ' +
    'Zero markdown, no emojis, no bullet lists, no URLs. ' +
    'Answer first. If it cannot be spoken in 6 seconds, it is too long — cut it.\n' +
    // === JARVIS MOD #64 — tonal checkpoint belongs in the UNCACHED block ===
    // Block 1 (cached) carries the personality: VOICE.md + the agent's
    // calibration one-liners. The per-turn CHECK on that personality is
    // volatile by design — it must be re-read at the tail of every request,
    // not amortized into a cached prefix the model skims. VOICE_CUE.md still
    // rides the last user message (fast-reply.applyVoiceCue); this is the
    // second, positional half of the same enforcement.
    'TONAL CHECKPOINT before you answer: (1) LENGTH — over 2 sentences or 40 words? Cut. ' +
    '(2) OPENER — starts with "Great question", "Let me", "Based on", "Happy to help", ' +
    '"Of course", "Absolutely", "Certainly", "I understand"? Rewrite. ' +
    '(3) VOICE — could a default chatbot have written this line? Then sharpen or cut; ' +
    'bland-and-correct is still bland. Numbers in your calibration lines are STYLE, never data.'
    // === END MOD #64 ===
  );
}

/**
 * Full two-block system array for the /v1/messages call.
 */
export function assembleSystem(
  agent: string,
  org: string,
  now?: Date,
  // MOD #66: rendered live counts. Optional so every existing caller and test
  // keeps working; empty means the model has no numbers and must escalate.
  snapshot = '',
): SystemBlock[] {
  return [
    {
      type: 'text',
      text: assembleStableIdentity(agent, org),
      cache_control: { type: 'ephemeral' },
    },
    { type: 'text', text: assembleVolatileBlock(now, snapshot) },
  ];
}

/** Test hook: clear the mtime cache. */
export function _clearIdentityCache(): void {
  identityCache.clear();
}
