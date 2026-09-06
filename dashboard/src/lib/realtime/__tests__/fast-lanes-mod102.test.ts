// === JARVIS MOD #102 — unit lock for the three demo-failure lanes + fixes ===
// Live-data behavior is covered by the probe smoke (see LOCAL_MODS #102); these
// lock the decision logic: which day an event covers, which of several noisy
// CRM rows gets spoken, and when ask_jarvis refuses to dispatch into a wedged
// brain. Each test encodes a failure that actually happened on camera 2026-08-03.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { brainWedgeCheck, eventCoversDay, modalValue, nameMatches, normalizePersonName } from '../fast-lanes';

describe('eventCoversDay — multi-day stagings exist on every day they span', () => {
  // The literal on-camera failure: CS placed July 31 running through Aug 5,
  // asked about Aug 4 → the old start-date match said "blank canvas".
  const bontemps = { summary: 'CS (IV/—) - Bontemps Ct 1616 | Jim Marrs', start: { date: '2026-07-31' }, end: { date: '2026-08-05' } };

  it('covers days in the middle of an all-day span', () => {
    expect(eventCoversDay(bontemps, '2026-08-04')).toBe(true);
    expect(eventCoversDay(bontemps, '2026-07-31')).toBe(true);
  });
  it('all-day end date is exclusive (Calendar API contract)', () => {
    expect(eventCoversDay(bontemps, '2026-08-05')).toBe(false);
  });
  it('does not cover days before the span', () => {
    expect(eventCoversDay(bontemps, '2026-07-30')).toBe(false);
  });
  it('single-day all-day event covers exactly its day', () => {
    const oneDay = { start: { date: '2026-08-04' }, end: { date: '2026-08-05' } };
    expect(eventCoversDay(oneDay, '2026-08-04')).toBe(true);
    expect(eventCoversDay(oneDay, '2026-08-03')).toBe(false);
  });
  it('degenerate same-start-end event still covers its start day', () => {
    expect(eventCoversDay({ start: { date: '2026-08-04' }, end: { date: '2026-08-04' } }, '2026-08-04')).toBe(true);
  });
  it('timed events still match by their Pacific start day only', () => {
    const timed = { start: { dateTime: '2026-08-04T10:00:00-07:00' } };
    expect(eventCoversDay(timed, '2026-08-04')).toBe(true);
    expect(eventCoversDay(timed, '2026-08-05')).toBe(false);
  });
  it('event with no start is never spoken', () => {
    expect(eventCoversDay({}, '2026-08-04')).toBe(false);
  });
});

describe('modalValue — noisy CRM rows converge on the real answer', () => {
  it('picks the most frequent value (the Craig Tann fix)', () => {
    expect(
      modalValue([
        'Robert@huntingtonandellis.com',
        'Robert@huntingtonandellis.com',
        'offers@huntingtonandellis.com',
        'JFann@huntingtonandellis.com',
        'offers@huntingtonandellis.com',
        'offers@huntingtonandellis.com',
      ]),
    ).toBe('offers@huntingtonandellis.com');
  });
  it('is case-insensitive so Robert@ and robert@ count as one', () => {
    expect(modalValue(['A@b.com', 'a@B.com', 'c@d.com'])).toBe('a@b.com');
  });
  it('ignores blanks and nulls entirely', () => {
    expect(modalValue([null, undefined, ' ', 'x@y.com'])).toBe('x@y.com');
    expect(modalValue([null, undefined])).toBeNull();
  });
});

describe('nameMatches — every spoken token must appear', () => {
  it('matches full name across name + aliases text', () => {
    expect(nameMatches('Ryan Marsh ryan marsh The Staging Collective', 'Ryan Marsh')).toBe(true);
  });
  it('does not match when only one token hits (Ryan ≠ Ryan Marsh)', () => {
    expect(nameMatches('Marsha H Goldberg', 'Ryan Marsh')).toBe(false);
  });
  it('single-character noise tokens are ignored', () => {
    expect(nameMatches('Kelly A Marshall', 'Kelly Marshall')).toBe(true);
  });
  it('empty query never matches', () => {
    expect(nameMatches('anyone', '')).toBe(false);
  });
});

describe('normalizePersonName — one person, one grouping key (round-2 critic findings)', () => {
  it('a middle-initial period does not split a person (the Peter Arroyo bug)', () => {
    expect(normalizePersonName('Peter J. Arroyo')).toBe(normalizePersonName('Peter J Arroyo'));
    expect(normalizePersonName('Jill M. Alegre')).toBe(normalizePersonName('Jill M Alegre'));
  });
  it('case and whitespace variants collapse', () => {
    expect(normalizePersonName('  CRAIG   TANN ')).toBe('craig tann');
  });
  it('apostrophes collapse (straight and curly)', () => {
    expect(normalizePersonName("O'Brien")).toBe(normalizePersonName('O’Brien'));
  });
  it('distinct people stay distinct', () => {
    expect(normalizePersonName('David Jones')).not.toBe(normalizePersonName('Wyking Jones'));
  });
});

describe('brainWedgeCheck — refuse to dispatch into a dead PTY', () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeLogs(outboundAgeMs: number, inboundAgeMs: number): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wedge-'));
    const dir = path.join(tmp, 'jarvis-telegram');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'outbound-messages.jsonl');
    const inn = path.join(dir, 'inbound-messages.jsonl');
    fs.writeFileSync(out, '{}\n');
    fs.writeFileSync(inn, '{}\n');
    const now = Date.now();
    fs.utimesSync(out, new Date(now - outboundAgeMs), new Date(now - outboundAgeMs));
    fs.utimesSync(inn, new Date(now - inboundAgeMs), new Date(now - inboundAgeMs));
    return tmp;
  }

  it('flags the demo scenario: silent 10 hours with fresh questions queued', () => {
    const root = makeLogs(10 * 60 * 60 * 1000, 60 * 1000);
    const res = brainWedgeCheck('jarvis-telegram', root);
    expect(res.wedged).toBe(true);
    expect(res.sinceMinutes).toBeGreaterThanOrEqual(599);
  });
  it('a healthy brain that answered recently is not wedged', () => {
    const root = makeLogs(2 * 60 * 1000, 60 * 1000);
    expect(brainWedgeCheck('jarvis-telegram', root).wedged).toBe(false);
  });
  it('a quiet night (no new inbound either) is idle, not wedged', () => {
    const root = makeLogs(10 * 60 * 60 * 1000, 10 * 60 * 60 * 1000);
    expect(brainWedgeCheck('jarvis-telegram', root).wedged).toBe(false);
  });
  it('missing logs fail open — dispatch rather than block on absent files', () => {
    expect(brainWedgeCheck('jarvis-telegram', '/nonexistent-root').wedged).toBe(false);
  });
});
