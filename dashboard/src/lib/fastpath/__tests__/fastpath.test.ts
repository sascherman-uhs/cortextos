// JARVIS MOD #34 — Cosmos fast-path unit tests (plan B6)
//
// Invariants:
//  1. Identity assembler Block 1 is byte-stable between calls (same input →
//     identical bytes) and re-reads on mtime change (edit propagation).
//  2. Voice cue is payload-only: appended to the LAST user message of the
//     request payload, never to earlier turns, and absent when no cue exists.
//  3. Conversation window is bounded, [Cosmos]-filtered, role-alternating,
//     and starts with a user turn.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;

vi.mock('@/lib/config', () => ({
  getAgentDir: (name: string) => path.join(tmpRoot, 'agents', name),
  getLogDir: (name: string) => path.join(tmpRoot, 'logs', name),
  getFrameworkRoot: () => path.join(tmpRoot, 'framework'),
  getCTXRoot: () => tmpRoot,
}));

import {
  assembleStableIdentity,
  assembleSystem,
  assembleVolatileBlock,
  _clearIdentityCache,
} from '../identity-assembler';
import { applyVoiceCue, readVoiceCue } from '../fast-reply';
import { buildWindow, type Turn } from '../conversation-window';

const AGENT = 'test-agent';

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fastpath-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'agents', AGENT), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'logs', AGENT), { recursive: true });
  _clearIdentityCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeIdentity(file: string, content: string) {
  fs.writeFileSync(path.join(tmpRoot, 'agents', AGENT, file), content);
}

describe('identity assembler (B1)', () => {
  it('Block 1 is byte-identical across repeated calls', () => {
    writeIdentity('SOUL.md', '# Soul\nBe kind.');
    writeIdentity('IDENTITY.md', '# Identity\nYou are Test.');
    const a = assembleStableIdentity(AGENT, 'uhs');
    const b = assembleStableIdentity(AGENT, 'uhs');
    expect(a).toBe(b);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('contains no volatile content (no current timestamps)', () => {
    writeIdentity('SOUL.md', '# Soul');
    const block1 = assembleStableIdentity(AGENT, 'uhs');
    const year = new Date().getFullYear().toString();
    // Static identity must not embed the current date/time
    expect(block1).not.toMatch(new RegExp(`${year}-\\d{2}-\\d{2}T`));
    // Volatile block, by contrast, must carry the clock
    expect(assembleVolatileBlock(new Date())).toContain('Current time:');
  });

  it('re-reads when an identity file changes (mtime propagation)', () => {
    writeIdentity('SOUL.md', 'v1');
    const a = assembleStableIdentity(AGENT, 'uhs');
    expect(a).toContain('v1');
    // Force a different mtime (fs.utimesSync — mtimeMs granularity guard)
    writeIdentity('SOUL.md', 'v2-changed');
    fs.utimesSync(path.join(tmpRoot, 'agents', AGENT, 'SOUL.md'), new Date(), new Date(Date.now() + 5000));
    const b = assembleStableIdentity(AGENT, 'uhs');
    expect(b).toContain('v2-changed');
    expect(b).not.toBe(a);
  });

  it('assembleSystem marks only Block 1 as ephemeral-cached', () => {
    writeIdentity('SOUL.md', '# Soul');
    const sys = assembleSystem(AGENT, 'uhs');
    expect(sys).toHaveLength(2);
    expect(sys[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sys[1].cache_control).toBeUndefined();
  });
});

describe('voice cue (B2)', () => {
  it('appends cue to the LAST user message only, payload-only', () => {
    const turns: Turn[] = [
      { role: 'user', content: 'hi', ts: 1 },
      { role: 'assistant', content: 'hello', ts: 2 },
      { role: 'user', content: 'how are you', ts: 3 },
    ];
    const out = applyVoiceCue(turns, 'Speak warmly.');
    expect(out[0].content).toBe('hi');
    expect(out[2].content).toContain('how are you');
    expect(out[2].content).toContain('<voice_cue>');
    expect(out[2].content).toContain('Speak warmly.');
    // Source turns untouched (cue never persists into stored history)
    expect(turns[2].content).toBe('how are you');
  });

  it('no cue file → empty cue → payload unchanged', () => {
    expect(readVoiceCue(AGENT, 'uhs')).toBe('');
    const turns: Turn[] = [{ role: 'user', content: 'hi', ts: 1 }];
    const out = applyVoiceCue(turns, '');
    expect(out[0].content).toBe('hi');
  });
});

describe('conversation window (B3)', () => {
  function logLine(file: string, obj: Record<string, unknown>) {
    fs.appendFileSync(path.join(tmpRoot, 'logs', AGENT, file), JSON.stringify(obj) + '\n');
  }

  it('includes only [Cosmos] inbound turns, ordered, starting with user', () => {
    logLine('inbound-messages.jsonl', { text: 'telegram msg', timestamp: '2026-07-06T10:00:00Z' });
    logLine('inbound-messages.jsonl', { text: '[Cosmos] first question', timestamp: '2026-07-06T10:01:00Z' });
    logLine('outbound-messages.jsonl', { text: 'first answer', timestamp: '2026-07-06T10:01:05Z' });
    logLine('inbound-messages.jsonl', { text: '[Cosmos] second question', timestamp: '2026-07-06T10:02:00Z' });

    const w = buildWindow(AGENT);
    expect(w.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(w[0].content).toBe('first question');
    expect(w[1].content).toBe('first answer');
    expect(w.some((t) => t.content.includes('telegram msg'))).toBe(false);
  });

  it('bounds the window and merges consecutive same-role turns', () => {
    for (let i = 0; i < 30; i++) {
      logLine('inbound-messages.jsonl', {
        text: `[Cosmos] q${i}`,
        timestamp: `2026-07-06T10:${String(i).padStart(2, '0')}:00Z`,
      });
    }
    const w = buildWindow(AGENT, 10);
    // All user turns merge into one (alternation rule)
    expect(w).toHaveLength(1);
    expect(w[0].role).toBe('user');
    expect(w[0].content).toContain('q29');
    expect(w[0].content).not.toContain('q19\n'); // only last 10 survive the slice
  });

  it('drops a leading assistant turn', () => {
    logLine('outbound-messages.jsonl', { text: 'orphan reply', timestamp: '2026-07-06T09:00:00Z' });
    logLine('inbound-messages.jsonl', { text: '[Cosmos] hi', timestamp: '2026-07-06T10:00:00Z' });
    const w = buildWindow(AGENT);
    expect(w[0].role).toBe('user');
  });
});
