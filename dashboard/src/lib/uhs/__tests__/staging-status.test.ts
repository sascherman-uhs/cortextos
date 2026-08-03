// === JARVIS MOD #65 — unit lock for the ONE staging definition ===
// These tests encode the 2026-08-03 reconciliation. If someone later "fixes"
// the tile by narrowing the status set again, the mismatch that produced
// 2-vs-16-vs-19 comes back — so the rows that caused it are pinned here by
// name, with the count each surface used to get.
import { describe, expect, it } from 'vitest';
import {
  OPEN_CONTRACT_STATUSES,
  countStagings,
  isActiveStaging,
  isAwaitingInstall,
  isOpenContract,
  openStatusFilter,
  todayPT,
  type StagingRow,
} from '../staging-status';

const TODAY = '2026-08-03';

// The real shape of the projects table on the day of the defect.
const rows: StagingRow[] = [
  ...Array.from({ length: 15 }, () => ({
    status: 'STAGED', stage_date: '2026-07-01', destage_date: null,
  })),
  // A 16th STAGED row that is signed but not yet installed — the old tile
  // counted it as active even though no furniture is in the house.
  { status: 'STAGED', stage_date: '2026-08-20', destage_date: null },
  // Installed but still sitting at CONTRACTED — invisible to the old tile.
  { status: 'CONTRACTED', stage_date: '2026-07-31', destage_date: null },
  { status: 'CONTRACTED', stage_date: '2026-07-21', destage_date: null },
  { status: 'CONTRACTED', stage_date: '2026-08-15', destage_date: null },
  // Notice given, furniture still in the home, still billing — invisible to
  // BOTH the old tile and the old contract lane.
  ...Array.from({ length: 4 }, () => ({
    status: 'NOTICE_GIVEN', stage_date: '2026-07-02', destage_date: null,
  })),
  // History — must never count.
  { status: 'COMPLETE', stage_date: '2026-01-01', destage_date: '2026-03-01' },
  { status: 'DESTAGED', stage_date: '2026-01-01', destage_date: '2026-03-01' },
  { status: 'CANCELLED', stage_date: null, destage_date: null },
  { status: 'SOLD', stage_date: '2026-02-18', destage_date: '2026-03-30' },
  { status: 'INQUIRY', stage_date: null, destage_date: null },
];

describe('the reconciled counts (2026-08-03)', () => {
  const counts = countStagings(rows, TODAY);

  it('active stagings = furniture in a home right now', () => {
    expect(counts.activeStagings).toBe(21);
  });
  it('open contracts = live billing relationship', () => {
    expect(counts.openContracts).toBe(23);
  });
  it('the gap between them is signed-but-not-installed', () => {
    expect(counts.awaitingInstall).toBe(2);
    expect(counts.activeStagings + counts.awaitingInstall).toBe(counts.openContracts);
  });
  it('does NOT reproduce any of the three old, disagreeing numbers', () => {
    for (const wrong of [2, 5, 16, 19]) {
      expect(counts.activeStagings).not.toBe(wrong);
    }
  });
});

describe('isActiveStaging', () => {
  it('counts an installed, un-removed staging', () => {
    expect(isActiveStaging({ status: 'STAGED', stage_date: '2026-07-01' }, TODAY)).toBe(true);
  });
  it('counts NOTICE_GIVEN — notice does not remove the furniture', () => {
    expect(isActiveStaging({ status: 'NOTICE_GIVEN', stage_date: '2026-07-02' }, TODAY)).toBe(true);
  });
  it('counts an installed project still sitting at CONTRACTED', () => {
    expect(isActiveStaging({ status: 'CONTRACTED', stage_date: '2026-07-31' }, TODAY)).toBe(true);
  });
  it('excludes work signed but not yet installed', () => {
    expect(isActiveStaging({ status: 'STAGED', stage_date: '2026-08-20' }, TODAY)).toBe(false);
    expect(isActiveStaging({ status: 'CONTRACTED', stage_date: null }, TODAY)).toBe(false);
  });
  it('excludes a staging already removed', () => {
    expect(
      isActiveStaging({ status: 'STAGED', stage_date: '2026-01-01', destage_date: '2026-07-01' }, TODAY),
    ).toBe(false);
  });
  it('still counts one with a FUTURE scheduled removal', () => {
    // Scheduled ≠ done. Excluding these would undercount live work.
    expect(
      isActiveStaging({ status: 'STAGED', stage_date: '2026-07-01', destage_date: '2026-09-01' }, TODAY),
    ).toBe(true);
  });
  it('excludes every terminal status', () => {
    for (const status of ['COMPLETE', 'DESTAGED', 'CANCELLED', 'SOLD', 'INQUIRY', 'MISC']) {
      expect(isActiveStaging({ status, stage_date: '2026-07-01' }, TODAY)).toBe(false);
    }
  });
});

describe('isOpenContract / isAwaitingInstall', () => {
  it('NOTICE_GIVEN is an OPEN contract — it still bills', () => {
    expect(isOpenContract({ status: 'NOTICE_GIVEN' })).toBe(true);
    expect(OPEN_CONTRACT_STATUSES).toContain('NOTICE_GIVEN');
  });
  it('is case-insensitive on status', () => {
    expect(isOpenContract({ status: 'staged' })).toBe(true);
  });
  it('awaiting-install is open but not active', () => {
    const row = { status: 'CONTRACTED', stage_date: '2026-08-15' };
    expect(isAwaitingInstall(row, TODAY)).toBe(true);
    expect(isActiveStaging(row, TODAY)).toBe(false);
  });
});

describe('openStatusFilter — the PostgREST predicate both surfaces send', () => {
  it('includes every open status', () => {
    const f = openStatusFilter();
    for (const s of OPEN_CONTRACT_STATUSES) expect(f).toContain(s);
    expect(f.startsWith('in.(')).toBe(true);
  });
});

describe('todayPT', () => {
  it('returns a Pacific YYYY-MM-DD', () => {
    expect(todayPT(new Date('2026-08-04T05:00:00Z'))).toBe('2026-08-03'); // 10pm PT prev day
    expect(todayPT(new Date('2026-08-04T18:00:00Z'))).toBe('2026-08-04');
  });
});
