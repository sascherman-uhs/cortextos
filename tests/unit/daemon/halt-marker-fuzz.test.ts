import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isHalted, readHaltMarker, listHaltedAgents } from '../../../src/daemon/halt-marker.js';

function root() { return mkdtempSync(join(tmpdir(), 'haltfuzz-')); }
function plant(r: string, agent: string, body: string | null, asDir = false) {
  mkdirSync(join(r, 'state', agent), { recursive: true });
  const p = join(r, 'state', agent, '.halted');
  if (asDir) { mkdirSync(p, { recursive: true }); return p; }
  if (body !== null) writeFileSync(p, body, 'utf-8');
  return p;
}

const hostile: Array<[string, string]> = [
  ['empty file', ''],
  ['whitespace only', '   \n\t '],
  ['truncated json', '{"agent":"a","since":"2026-09-24T00:00:00Z"'],
  ['json null', 'null'],
  ['json array', '[]'],
  ['json number', '42'],
  ['json string', '"halted"'],
  ['json true', 'true'],
  ['no fields', '{}'],
  ['wrong types', '{"agent":42,"since":{"x":1},"crashCount":"twelve","maxCrashes":null,"lastAlertAt":[],"alertCount":"many"}'],
  ['not json at all', 'HALTED because codex died'],
  ['nul bytes', '\u0000\u0000\u0000'],
  ['huge', '{"reason":"' + 'x'.repeat(200000) + '"}'],
];

describe('halt marker fails CLOSED on every hostile input', () => {
  for (const [label, body] of hostile) {
    it(`reads as HALTED: ${label}`, () => {
      const r = root();
      plant(r, 'trillion-coder', body);
      expect(isHalted(r, 'trillion-coder')).toBe(true);
      const m = readHaltMarker(r, 'trillion-coder');
      expect(m).not.toBeNull();
      expect(typeof m!.since).toBe('string');
      expect(listHaltedAgents(r).map(x => x.agent)).toContain('trillion-coder');
    });
  }

  it('reads as HALTED when the marker path is a DIRECTORY', () => {
    const r = root();
    plant(r, 'trillion-coder', null, true);
    expect(isHalted(r, 'trillion-coder')).toBe(true);
  });

  it('reads as HALTED when the marker is unreadable (mode 000)', () => {
    const r = root();
    const p = plant(r, 'trillion-coder', '{"reason":"nope"}');
    chmodSync(p, 0o000);
    expect(isHalted(r, 'trillion-coder')).toBe(true);
  });

  it('a marker for an agent no longer in config still enumerates', () => {
    const r = root();
    plant(r, 'ghost-agent', '{"agent":"ghost-agent","since":"2026-09-01T00:00:00Z","reason":"gone"}');
    expect(listHaltedAgents(r).map(x => x.agent)).toEqual(['ghost-agent']);
  });

  it('an unreadable state dir does not crash the enumerator', () => {
    const r = root();
    expect(listHaltedAgents(r)).toEqual([]);
  });
});
