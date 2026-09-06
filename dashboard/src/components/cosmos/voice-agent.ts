// === JARVIS MOD #107 ROUND 3 — the voice lane's agent, and its test override
// (2026-08-09) ===
// NEW FILE.
//
// WHY THIS EXISTS: the Cosmos voice panel hard-coded `jarvis-telegram` in three
// places (history backfill, the SSE stream URL, and the HTTP send fallback).
// That made the E2E suite structurally incapable of running without touching
// Scott's REAL ops log — every path the tests drive reads and writes
// <CTX_ROOT>/logs/jarvis-telegram/*.
//
// Round 2's specs tried to compensate with cleanup: append a synthetic line,
// then truncate the file back. That worked (verified: it left zero residue) but
// it is the wrong shape — it is a promise to tidy up rather than an inability to
// make a mess, and its restore silently gave up whenever the file had changed
// underneath it. Worse, reading the real log made the tests depend on real
// history: a genuine reply containing "Eighteen active stagings" was replayed by
// backfill and broke R6 deterministically.
//
// So the agent is now a parameter with a dev-only override. Point the suite at a
// throwaway agent and every read and write it performs lands in
// <CTX_ROOT>/logs/<throwaway>/ — the real log is not merely left alone, it is
// unreachable.
//
// SAFETY, deliberately layered:
//   1. The override is refused entirely in a production build.
//   2. The name is charset-validated ([a-z0-9_-]), matching what the stream and
//      history routes already enforce, so it cannot escape the logs directory.
//   3. /api/messages/send validates the agent against the CONFIGURED agent list
//      and returns 404 "Agent not found" for anything else (send/route.ts:147-149;
//      the 400s there are for a missing or malformed name, which is a different
//      check) — so a test agent physically cannot deliver a message to the real
//      bus or to Telegram, even by mistake. That rejection is a FEATURE here,
//      not a limitation.

/** The real agent behind the Cosmos voice panel. */
export const DEFAULT_VOICE_AGENT = 'jarvis-telegram';

/** Charset the stream + history routes accept. Anything else is refused. */
const AGENT_RE = /^[a-z0-9_-]+$/;

/** localStorage key, for a Playwright run that prefers not to carry a query param. */
const OVERRIDE_KEY = 'cosmos-voice-agent-override';

/**
 * Which agent this voice surface is bound to.
 *
 * Reads `?ctxAgent=` (or the localStorage key) ONLY outside production builds.
 * Returns the real agent everywhere else, including on any malformed value —
 * failing closed to the real agent is safe for users; failing open to an
 * arbitrary string would not be.
 */
export function resolveVoiceAgent(): string {
  if (typeof window === 'undefined') return DEFAULT_VOICE_AGENT;
  if (process.env.NODE_ENV === 'production') return DEFAULT_VOICE_AGENT;
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('ctxAgent');
    if (fromQuery && AGENT_RE.test(fromQuery)) return fromQuery;
    const fromStorage = window.localStorage.getItem(OVERRIDE_KEY);
    if (fromStorage && AGENT_RE.test(fromStorage)) return fromStorage;
  } catch {
    /* no location / storage — fall through to the real agent */
  }
  return DEFAULT_VOICE_AGENT;
}
// === END JARVIS MOD #107 ROUND 3 ===
