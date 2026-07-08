// === JARVIS MOD #38 — reply dedupe (2026-07-07) ===
// The fast lane now returns its reply synchronously in the POST /api/messages/send
// response AND still appends it to outbound-messages.jsonl (so Telegram history,
// backfill, and the SSE tail stay consistent). That means every fast reply
// arrives at the client TWICE: once in the POST response (already spoken) and
// once via SSE/backfill. This pure helper is the single decision point both
// consumers (SSE onmessage + history backfill) use, so the rule can't drift
// between them — and so it can be unit-tested without a DOM.

/**
 * Decide whether an outbound line should be surfaced (shown + spoken).
 *
 * Mutates `seen` (marks the id) exactly like the callers previously did inline —
 * including for skipped lines, so a fast-reply id is never re-considered later.
 *
 * Rules, in order:
 *  1. no id / already seen        → skip (previously surfaced or unidentifiable)
 *  2. delivered by the fast lane  → skip (already spoken from the POST response)
 *  3. no turn sent this session   → skip (pre-existing history, seed mode)
 *  4. empty text                  → skip
 *  5. otherwise                   → surface
 */
export function shouldSurfaceReply(params: {
  id: string | undefined;
  text: string | undefined;
  seen: Set<string>;
  fastReplyIds: Set<string>;
  sentTurns: number;
}): boolean {
  const { id, text, seen, fastReplyIds, sentTurns } = params;
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (fastReplyIds.has(id)) return false;
  if (sentTurns <= 0) return false;
  if (!text) return false;
  return true;
}
// === END JARVIS MOD #38 ===
