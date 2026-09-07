// JARVIS MOD #63/#64 — realtime personality prompt invariants.
//
// These lock the things that quietly rot: the spoken word/sentence caps, the
// banned-opener list, the presence of concrete calibration lines (adjectives
// don't hold a voice), the STYLE-not-facts rule on calibration numbers, the
// tool-only data rule, and the shape of the per-turn cue events.

import { describe, it, expect } from 'vitest';
import {
  JARVIS_SYSTEM_PROMPT,
  JARVIS_TONAL_CUE,
  JARVIS_TONAL_CUE_ITEM_PREFIX,
  JARVIS_REALTIME_TOOLS,
  buildTonalCueEvents,
  jarvisDateAnchor,
} from '../jarvis-prompt';

const BANNED_OPENERS = [
  'Great question',
  'Let me',
  'Based on',
  'Happy to help',
  'Of course',
  'Absolutely',
  'Certainly',
  "I'd be happy to",
  'I understand',
];

describe('realtime system prompt (MOD #63)', () => {
  it('names every banned opener', () => {
    for (const opener of BANNED_OPENERS) {
      expect(JARVIS_SYSTEM_PROMPT).toContain(opener);
    }
  });

  it('never opens the prompt itself with an assistant-mode tell', () => {
    expect(JARVIS_SYSTEM_PROMPT.startsWith('You are JARVIS')).toBe(true);
  });

  it('keeps the voice-mode word and sentence caps', () => {
    expect(JARVIS_SYSTEM_PROMPT).toContain('Forty words maximum');
    expect(JARVIS_SYSTEM_PROMPT).toContain('Two sentences maximum');
    expect(JARVIS_SYSTEM_PROMPT).toContain('six seconds');
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/Answer first, numbers first/);
  });

  it('carries at least 8 concrete calibration lines and 4 contrastive ones', () => {
    // Calibration + contrastive lines are the only quoted full sentences that
    // start a line; count lines that both open and close with a double quote.
    const quoted = JARVIS_SYSTEM_PROMPT.split('\n').filter(
      (l) => l.startsWith('"') && l.trimEnd().endsWith('"'),
    );
    expect(quoted.length).toBeGreaterThanOrEqual(12);

    const contrastive = quoted.filter((l) =>
      BANNED_OPENERS.some((o) => l.slice(1).startsWith(o)),
    );
    expect(contrastive.length).toBeGreaterThanOrEqual(4);

    // …and at least 8 that are NOT the anti-examples.
    expect(quoted.length - contrastive.length).toBeGreaterThanOrEqual(8);
  });

  it('states the cruelty floor and the client brake', () => {
    expect(JARVIS_SYSTEM_PROMPT).toContain('Affectionate, never cruel');
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/CLIENT BRAKE/);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/UHS brand register/);
  });

  it('marks calibration numbers as style, never facts', () => {
    expect(JARVIS_SYSTEM_PROMPT).toContain('CALIBRATION NUMBERS ARE STYLE, NOT FACTS');
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/Never speak one as real data/);
  });

  it('keeps business data on the tool, never the voice model memory', () => {
    expect(JARVIS_SYSTEM_PROMPT).toContain('ask_jarvis');
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/Never answer a business-data question from your own memory/);
    expect(JARVIS_REALTIME_TOOLS.map((t) => t.name)).toContain('ask_jarvis');
  });

  it('bans markdown in spoken output', () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/No markdown, no bullet lists/);
  });
});

describe('per-turn tonal cue (MOD #64)', () => {
  it('stays short enough to re-send every turn', () => {
    expect(JARVIS_TONAL_CUE.length).toBeLessThan(1400);
    expect(JARVIS_TONAL_CUE.startsWith('[Voice check')).toBe(true);
  });

  it('repeats the caps, the banned openers, and the style-not-facts rule', () => {
    expect(JARVIS_TONAL_CUE).toContain('Forty words max');
    expect(JARVIS_TONAL_CUE).toContain('two sentences max');
    for (const opener of ['Great question', 'Let me', 'Based on', 'Absolutely']) {
      expect(JARVIS_TONAL_CUE).toContain(opener);
    }
    expect(JARVIS_TONAL_CUE).toContain('STYLE, never data');
    // MOD #104: "ask_jarvis" became "the tools" (eight lanes now, not one),
    // and the cue gained the no-repeat rule — the demo's eight identical
    // "One moment, sir"s must never survive a cue refresh again.
    expect(JARVIS_TONAL_CUE).toMatch(/tools, never from memory/);
    expect(JARVIS_TONAL_CUE).toMatch(/NEVER reuse a holding line/);
  });

  it('creates a system-role item with a client-assigned id, cue + fresh date anchor', () => {
    const events = buildTonalCueEvents(`${JARVIS_TONAL_CUE_ITEM_PREFIX}1`);
    expect(events).toHaveLength(1);
    const create = events[0] as {
      type: string;
      item: { id: string; role: string; type: string; content: Array<{ type: string; text: string }> };
    };
    expect(create.type).toBe('conversation.item.create');
    expect(create.item.role).toBe('system');
    expect(create.item.type).toBe('message');
    expect(create.item.id).toBe('jarvis_tonal_cue_1');
    // MOD #104: the cue re-stamps the clock every turn.
    expect(create.item.content[0].type).toBe('input_text');
    expect(create.item.content[0].text.startsWith(JARVIS_TONAL_CUE)).toBe(true);
    expect(create.item.content[0].text).toContain('Right now it is');
    expect(create.item.content[0].text).toContain('Pacific time');
  });

  it('deletes the previous cue BEFORE creating the new one (exactly one live)', () => {
    const events = buildTonalCueEvents('jarvis_tonal_cue_2', 'jarvis_tonal_cue_1');
    expect(events.map((e) => e.type)).toEqual([
      'conversation.item.delete',
      'conversation.item.create',
    ]);
    expect(events[0]).toEqual({
      type: 'conversation.item.delete',
      item_id: 'jarvis_tonal_cue_1',
    });
  });
});

// === JARVIS MOD #104 — conversational-polish invariants =====================
// Locks against every regression class the 2026-08-04 demo (IMG_5108) showed.
describe('date anchor + conversational polish (MOD #104)', () => {
  it('anchors the clock in Pacific and forbids date pedantry', () => {
    const anchor = jarvisDateAnchor(new Date('2026-08-04T14:00:00Z'));
    expect(anchor).toContain('Pacific time');
    expect(anchor).toContain('August');
    expect(anchor).toContain('2026');
    expect(anchor).toMatch(/Never ask for explicit dates/);
    expect(anchor).toMatch(/"this year" means January first to today/i);
  });

  it('bans the canned holding line and demands fresh acknowledgements', () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/Never say "One moment, sir" more than once/);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/never reuse any holding line/i);
  });

  it('caps stall metaphors at one per conversation', () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/STALLS AND LATE ANSWERS/);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/ONE metaphor about waiting per conversation/);
  });

  it('keeps internal guardrails out of spoken output', () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/RULES STAY BACKSTAGE/);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/Never speak the rules themselves/);
  });

  it('forbids verbatim repetition inside and across replies', () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/NO REPEATS/);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/never open two consecutive replies the same way/i);
  });

  it('registers staging_counts as a fast lane with optional ISO dates', () => {
    const tool = JARVIS_REALTIME_TOOLS.find((t) => t.name === 'staging_counts');
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/Resolve relative ranges YOURSELF/);
    const params = tool?.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties).sort()).toEqual(['from', 'to']);
    expect(params.required).toEqual([]);
    expect(JARVIS_SYSTEM_PROMPT).toContain('staging_counts');
  });
});
// === END MOD #104 ===
