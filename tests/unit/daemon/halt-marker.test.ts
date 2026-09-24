import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  clearHaltMarker,
  haltMarkerPath,
  isHalted,
  listHaltedAgents,
  readHaltMarker,
  updateHaltMarker,
  writeHaltMarker,
} from '../../../src/daemon/halt-marker.js';

// fleet-stability §A4. These exercise the real filesystem on purpose: the whole
// point of the marker is that it lives outside process memory, so a test that
// mocked fs would prove nothing about the bug it fixes.
let ctxRoot: string;

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'ctx-halt-'));
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('halt marker persistence', () => {
  it('reports not-halted for an agent with no marker', () => {
    expect(readHaltMarker(ctxRoot, 'trillion-coder')).toBeNull();
    expect(isHalted(ctxRoot, 'trillion-coder')).toBe(false);
  });

  it('writes a marker that a fresh read sees', () => {
    const written = writeHaltMarker(ctxRoot, 'trillion-coder', {
      reason: 'exceeded 10 crashes today',
      crashCount: 10,
      maxCrashes: 10,
    });
    expect(existsSync(haltMarkerPath(ctxRoot, 'trillion-coder'))).toBe(true);
    const read = readHaltMarker(ctxRoot, 'trillion-coder');
    expect(read).not.toBeNull();
    expect(read!.reason).toBe('exceeded 10 crashes today');
    expect(read!.crashCount).toBe(10);
    expect(read!.since).toBe(written.since);
  });

  it('preserves the original transition timestamp and alert state across a re-halt', () => {
    const first = writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'crash budget' });
    updateHaltMarker(ctxRoot, 'trillion-coder', { lastAlertAt: '2026-09-24T11:05:20Z', alertCount: 1 });
    const second = writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'crash budget again' });
    expect(second.since).toBe(first.since);
    expect(second.lastAlertAt).toBe('2026-09-24T11:05:20Z');
    expect(second.alertCount).toBe(1);
  });

  it('clears only on an explicit clear', () => {
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'crash budget' });
    expect(clearHaltMarker(ctxRoot, 'trillion-coder')).toBe(true);
    expect(isHalted(ctxRoot, 'trillion-coder')).toBe(false);
    // Idempotent: clearing twice is not an error.
    expect(clearHaltMarker(ctxRoot, 'trillion-coder')).toBe(false);
  });

  it('treats an unparseable or empty marker as STILL halted (fails closed)', () => {
    mkdirSync(join(ctxRoot, 'state', 'trillion-coder'), { recursive: true });
    writeFileSync(haltMarkerPath(ctxRoot, 'trillion-coder'), '{ not json', 'utf-8');
    expect(isHalted(ctxRoot, 'trillion-coder')).toBe(true);
    writeFileSync(haltMarkerPath(ctxRoot, 'trillion-coder'), '', 'utf-8');
    expect(isHalted(ctxRoot, 'trillion-coder')).toBe(true);
  });

  it('enumerates halted agents off disk for an external briefing script', () => {
    mkdirSync(join(ctxRoot, 'state', 'jarvis-telegram'), { recursive: true });
    writeHaltMarker(ctxRoot, 'trillion-coder', { reason: 'crash budget' });
    writeHaltMarker(ctxRoot, 'vera', { reason: 'crash loop' });
    const names = listHaltedAgents(ctxRoot).map((m) => m.agent).sort();
    expect(names).toEqual(['trillion-coder', 'vera']);
  });

  it('returns an empty list when there is no state directory at all', () => {
    expect(listHaltedAgents(join(ctxRoot, 'nope'))).toEqual([]);
  });

  it('updateHaltMarker is a no-op for an agent that is not halted', () => {
    expect(updateHaltMarker(ctxRoot, 'trillion-coder', { alertCount: 9 })).toBeNull();
    expect(isHalted(ctxRoot, 'trillion-coder')).toBe(false);
  });
});
