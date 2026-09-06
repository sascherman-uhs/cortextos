/**
 * Fix6 / defects H and M1 — a move that did not take must come back as a
 * sentence the caller can put in front of the person who clicked.
 *
 * Reproduced before the fix: on /tasks the detail sheet's Retry button posted
 * a move the work contract refused. The server answered 422 with
 * "This move was refused by the work contract. \"failed terminal\" cannot move
 * to \"backlog\" …" — the page dropped that into a banner at the top of the
 * page, which sat behind the still-open sheet (aria-hidden) and 1859px above
 * the viewport. Nothing at all was shown where the click happened.
 */

import { describe, it, expect } from 'vitest';
import { moveOutcome, CONFLICT_FALLBACK } from '../move-result';

describe('moveOutcome', () => {
  it('reports success without a message', () => {
    expect(moveOutcome(200, { success: true })).toEqual({ ok: true });
  });

  it('passes the work contract refusal through verbatim (422)', () => {
    const message =
      'This move was refused by the work contract. "failed terminal" cannot move to "backlog". '
      + 'Legal moves from "failed terminal": waiting.';
    expect(moveOutcome(422, { error: 'contract_refusal', message })).toEqual({
      ok: false,
      message,
    });
  });

  it('states a version conflict even when the server sent no sentence', () => {
    expect(moveOutcome(409, {})).toEqual({ ok: false, message: CONFLICT_FALLBACK });
  });

  it('prefers the server sentence on a conflict', () => {
    expect(moveOutcome(409, { message: 'Someone else moved this.' }).message).toBe(
      'Someone else moved this.',
    );
  });

  it('falls back to reason when the endpoint names one instead of message', () => {
    expect(moveOutcome(403, { reason: 'A board move cannot mark work Done.' }).message).toBe(
      'A board move cannot mark work Done.',
    );
  });

  it('never returns a bare error code with no sentence', () => {
    expect(moveOutcome(500, { error: 'store_unavailable' }).message).toBe(
      'Could not move this task: store_unavailable',
    );
    expect(moveOutcome(500, {}).message).toBe('Could not move this task.');
    expect(moveOutcome(500, null).message).toBe('Could not move this task.');
  });

  it('treats a blank message as no message rather than showing an empty alert', () => {
    expect(moveOutcome(422, { message: '   ', error: 'contract_refusal' }).message).toBe(
      'Could not move this task: contract_refusal',
    );
  });
});
