// === Fix6 — what to say when a task move does not take ===
//
// A refused move used to be indistinguishable from a move that worked: the
// page swallowed the response, and whatever sentence it did produce was
// rendered in a banner BEHIND the still-open detail sheet — inside the
// dialog's aria-hidden region, and off-screen entirely once the page was
// scrolled. The person clicked, saw nothing, and the record had not moved.
//
// Turning the response into a sentence is the part worth testing on its own,
// so it lives here rather than inline in the page.

export interface MoveOutcome {
  ok: boolean;
  /** Present whenever ok is false. Always a sentence, never an error code. */
  message?: string;
}

/** The sentence shown when the record moved underneath the open view. */
export const CONFLICT_FALLBACK =
  'This task changed while you were looking at it. The record has been reloaded — review it and try again.';

/**
 * Turn an HTTP status and a parsed response body into what the person is told.
 * `data` is whatever the endpoint returned; the transition endpoints put the
 * human sentence in `message` (409/422) or `reason` (contract refusals).
 */
export function moveOutcome(status: number, data: unknown): MoveOutcome {
  if (status >= 200 && status < 300) return { ok: true };

  const body = (data ?? {}) as { message?: unknown; reason?: unknown; error?: unknown };
  const sentence = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  if (status === 409) {
    return { ok: false, message: sentence(body.message) ?? sentence(body.reason) ?? CONFLICT_FALLBACK };
  }

  const stated = sentence(body.message) ?? sentence(body.reason);
  if (stated) return { ok: false, message: stated };

  const code = sentence(body.error);
  return {
    ok: false,
    message: code ? `Could not move this task: ${code}` : 'Could not move this task.',
  };
}
