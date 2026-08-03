// JARVIS MOD #57/#58 — realtime personality prompt invariants.
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

describe('realtime system prompt (MOD #57)', () => {
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

describe('per-turn tonal cue (MOD #58)', () => {
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
    expect(JARVIS_TONAL_CUE).toContain('ask_jarvis');
  });

  it('creates a system-role item with a client-assigned id', () => {
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
    expect(create.item.content[0]).toEqual({ type: 'input_text', text: JARVIS_TONAL_CUE });
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
