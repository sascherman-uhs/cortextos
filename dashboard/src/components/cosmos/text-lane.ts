// === JARVIS MOD #107 ROUND 2 — TextLane: the Daniel lane's streaming reply
// accumulator, with a barge-in generation (2026-08-09) ===
// NEW FILE. Pure logic — no DOM, no React, no TTS handle. Extracted for exactly
// the reason turn-guard.ts and response-gate.ts were: the rule lived inside the
// RTCDataChannel `onmessage` switch, which vitest (no jsdom here) cannot reach,
// so the bug below was structurally untestable and shipped.
//
// THE BUG THIS EXISTS TO KILL (round-1 defect, found by adversarial verify):
// `response.output_text.delta` and `.done` had NO staleness guard at all. The
// barge-in path called resetTextLane(), which nulled the TTS stream handle — so
// the very next in-flight delta of the CANCELLED response saw a null handle,
// treated that as "no stream open yet", and called beginStreamReply() AGAIN.
// JARVIS resumed speaking the exact answer the user had just talked over. The
// terminal `.done` of the cancelled response was worse: it carried the partial
// text straight into pushAgentReply, and voice-panel's log-speak effect spoke
// the abandoned reply in full.
//
// The root mistake was treating "no handle" as a STATE ("nothing started") when
// it is ambiguous between "nothing started yet" and "started, then killed". A
// generation counter removes the ambiguity: a null handle in a STALE generation
// means DISCARD, and can never mean RESTART.
//
// Two independent staleness signals, deliberately belt-and-braces:
//   1. generation — bumped by every interrupt (barge-in, stop, error, sign-off,
//      session teardown). Covers the window after a cancel where no replacement
//      response exists yet, and events that carry no response id.
//   2. response id — GA text events carry `response_id`. Covers the nastier
//      ordering where the NEW response has already been created (so the
//      generation matches again) while the OLD response's deltas are still
//      draining out of the socket.
import { extractSentences } from '@/lib/fastpath/stream-sentences';

/** MOD #44 parity: a spoken reply is capped at 50 words on every lane. */
export const MAX_SPOKEN_WORDS = 50;

export interface TextLaneDone {
  /** The complete reply text, for the conversation log. */
  text: string;
  /**
   * Trailing fragment that never terminated in punctuation and still needs
   * speaking, or null when there is nothing left (or the word cap is hit).
   */
  tail: string | null;
  /**
   * True when at least one sentence was already handed to TTS for this reply —
   * the caller must then markSpoken(replyId) so the log-speak effect does not
   * say it a second time (mirrors use-voice.ts:575-596).
   */
  streamed: boolean;
}

export class TextLane {
  private gen = 0;
  /** The generation the currently-open response belongs to. -1 = none open. */
  private responseGen = -1;
  private liveId: string | null = null;
  private buf = '';
  private full = '';
  private words = 0;
  private streamed = false;
  /** MOD #107 ROUND 3: text events refused for carrying no response id. */
  private droppedIdless = 0;

  constructor(private readonly maxWords: number = MAX_SPOKEN_WORDS) {}

  /** The live barge-in generation. Test/diagnostic seam. */
  generation(): number {
    return this.gen;
  }

  /** The id of the response currently accepted, or null when none is open. */
  activeResponseId(): string | null {
    return this.liveId;
  }

  /**
   * `response.created` — open a new reply. Any previously-open response is
   * abandoned here rather than merged: two overlapping replies is not a state
   * this lane can be in, and silently concatenating them is how a cancelled
   * answer used to bleed into its replacement.
   */
  begin(responseId: string | null): void {
    this.responseGen = this.gen;
    this.liveId = responseId;
    this.buf = '';
    this.full = '';
    this.words = 0;
    this.streamed = false;
  }

  /**
   * Is an event for `responseId` still live? An event is stale when its
   * generation has been superseded, when no response is open at all, or when it
   * belongs to a different response than the one currently open.
   */
  isLive(responseId?: string | null): boolean {
    if (this.responseGen !== this.gen) return false;
    if (this.liveId === null) return false;
    // === MOD #107 ROUND 3 — require the id, don't merely check it when present.
    // Round 2 accepted an id-LESS event whenever the generation happened to be
    // back in sync, which is precisely the ordering that generation alone cannot
    // separate: a straggler from the cancelled response arriving after the
    // replacement response opened. GA stamps `response_id` on every text event,
    // so an event without one is malformed, not permissive.
    //
    // The failure mode this trades into is visible rather than silent: if OpenAI
    // ever stopped stamping the field, the lane would go quiet — so the drop is
    // counted on __cosmosStats (droppedTextEvents) and surfaces in the on-phone
    // debug line instead of being a mystery.
    if (!responseId) {
      this.droppedIdless += 1;
      return false;
    }
    return responseId === this.liveId;
  }

  /** How many text events were dropped for carrying no response id. */
  idlessDrops(): number {
    return this.droppedIdless;
  }

  /**
   * `response.output_text.delta`.
   * @returns complete sentences ready to speak, in order. ALWAYS empty for a
   *          stale event — the caller must not open a TTS turn for one.
   */
  delta(text: string, responseId?: string | null): string[] {
    if (!text || !this.isLive(responseId)) return [];
    this.full += text;
    this.buf += text;
    const { sentences, rest } = extractSentences(this.buf);
    this.buf = rest;
    const out: string[] = [];
    for (const s of sentences) {
      if (this.words >= this.maxWords) break;
      this.words += s.split(/\s+/).length;
      out.push(s);
      this.streamed = true;
    }
    return out;
  }

  /** The reply text accumulated so far (for the live interim line). */
  fullText(): string {
    return this.full;
  }

  /**
   * `response.output_text.done`.
   * @returns null for a stale event — the caller must NOT push it to the log
   *          and must NOT speak it. That null is the whole fix for the
   *          "cancelled reply gets spoken in full" half of the defect.
   */
  done(finalText: string | undefined, responseId?: string | null): TextLaneDone | null {
    if (!this.isLive(responseId)) return null;
    const text = (finalText ?? this.full).trim();
    const rawTail = this.buf.trim();
    const tail = rawTail && this.words < this.maxWords ? rawTail : null;
    if (tail) this.streamed = true;
    const result: TextLaneDone = { text, tail, streamed: this.streamed };
    this.close();
    return result;
  }

  /**
   * Barge-in, stop control, server error, sign-off, session teardown. Advances
   * the generation so every in-flight event of the abandoned response is
   * discarded — including one that arrives after a replacement response has
   * already been created.
   */
  interrupt(): void {
    this.gen += 1;
    this.close();
  }

  /** Close the current response without advancing the generation. */
  private close(): void {
    this.responseGen = -1;
    this.liveId = null;
    this.buf = '';
    this.full = '';
    this.words = 0;
    this.streamed = false;
  }
}
// === END JARVIS MOD #107 ROUND 2 ===
