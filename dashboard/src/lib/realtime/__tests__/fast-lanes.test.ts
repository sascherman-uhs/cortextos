// === JARVIS MOD #52 — unit lock for the fast-lane matching + phrasing ===
// Network reads are covered by the live curl smoke (see LOCAL_MODS #52); these
// lock the parts that decide WHICH contract gets spoken and HOW, because a
// confidently wrong notice date is the failure mode that actually costs money.
import { describe, expect, it } from 'vitest';
import {
  NOTICE_DAYS_BEFORE_END,
  listingAgent,
  noticeDate,
  scoreContract,
  spokenDate,
  spokenList,
  spokenTitle,
  UHS_CALENDAR_ID,
  type ContractRow,
} from '../fast-lanes';

const sableRidge: ContractRow = {
  id: '1',
  property_address: '2572 Sable Ridge Ct, Las Vegas, NV 89135',
  normalized_address: '2572 sable ridge ct',
  status: 'STAGED',
  stage_date: '2026-07-13',
  contract_end_date: '2026-08-30',
  project_contacts: [
    { contact_name: 'Marie Daly', contact_type: 'LISTING_AGENT' },
    { contact_name: 'Robert Kent', contact_type: 'OWNER' },
  ],
};

const bayHill: ContractRow = {
  id: '2',
  property_address: '2016 Bay Hill Dr, Las Vegas, NV 89134',
  normalized_address: '2016 bay hill dr',
  status: 'CONTRACTED',
  stage_date: '2026-07-20',
  contract_end_date: '2026-09-15',
  project_contacts: [{ contact_name: 'Nancy Horns', contact_type: 'LISTING_AGENT' }],
};

describe('listingAgent — agent is not the owner (AGENTS.md rule 8)', () => {
  it('returns the listing agent, never the owner', () => {
    expect(listingAgent(sableRidge)).toBe('Marie Daly');
  });
  it('returns null rather than falling back to whoever is first', () => {
    expect(listingAgent({ project_contacts: [{ contact_name: 'Someone', contact_type: 'OWNER' }] })).toBeNull();
    expect(listingAgent({})).toBeNull();
  });
});

describe('noticeDate — 10 paid days before paid-through (contract §7.2)', () => {
  it('subtracts exactly the contract notice period', () => {
    expect(noticeDate('2026-08-30')).toBe('2026-08-20');
    expect(NOTICE_DAYS_BEFORE_END).toBe(10);
  });
  it('crosses a month boundary correctly', () => {
    expect(noticeDate('2026-09-05')).toBe('2026-08-26');
  });
  it('crosses a year boundary correctly', () => {
    expect(noticeDate('2027-01-05')).toBe('2026-12-26');
  });
});

describe('scoreContract — fuzzy match by address or agent', () => {
  const rows = [sableRidge, bayHill];
  const best = (q: string) =>
    rows.map((r) => ({ r, s: scoreContract(r, q) })).sort((a, b) => b.s - a.s)[0];

  it('matches on a house number', () => {
    expect(best('2572').r.id).toBe('1');
    expect(best('2016').r.id).toBe('2');
  });
  it('matches on a street name', () => {
    expect(best('sable ridge').r.id).toBe('1');
    expect(best('bay hill').r.id).toBe('2');
  });
  it('matches on the listing agent name', () => {
    expect(best('daly').r.id).toBe('1');
    expect(best('nancy horns').r.id).toBe('2');
  });
  it('matches on the owner name too (the caller may only know the owner)', () => {
    expect(best('robert kent').r.id).toBe('1');
  });
  it('scores zero on a term matching nothing', () => {
    expect(scoreContract(sableRidge, 'flamingo')).toBe(0);
  });
  it('house number outweighs a shared street word', () => {
    // Both would tie on "ridge" alone; the number must break it decisively.
    expect(scoreContract(sableRidge, '2572 ridge')).toBeGreaterThan(
      scoreContract(bayHill, '2572 ridge'),
    );
  });
});

describe('spokenDate — a stored date is spoken as that date', () => {
  // Regression: bare YYYY-MM-DD parsed as UTC midnight lands the previous
  // evening in Pacific, so every contract date was spoken one day early
  // (caught live 2026-08-03 against the real projects table).
  it('does not shift a bare date backwards', () => {
    expect(spokenDate('2026-07-21')).toBe('July 21');
    expect(spokenDate('2026-08-30')).toBe('August 30');
    expect(spokenDate('2026-01-01')).toBe('January 1');
  });
  it('is stable across the whole month', () => {
    for (let day = 1; day <= 28; day++) {
      const iso = `2026-03-${String(day).padStart(2, '0')}`;
      expect(spokenDate(iso)).toBe(`March ${day}`);
    }
  });
});

describe('spokenTitle — calendar titles are written to be read, not spoken', () => {
  it('drops emoji status markers', () => {
    expect(spokenTitle('✅ Blog Published — Week 31')).toBe('Blog Published — Week 31');
    expect(spokenTitle('📧 Newsletter Prep: Issue #15')).toBe('Newsletter Prep: Issue #15');
  });
  it('turns pipe delimiters into pauses', () => {
    expect(spokenTitle('CS (III/—) - Boca Raton Dr 7748 | Kim Pedersen')).toBe(
      'CS (III/—) - Boca Raton Dr 7748, Kim Pedersen',
    );
  });
  it('never returns an empty string', () => {
    expect(spokenTitle('   ')).toBe('Untitled');
    expect(spokenTitle('🎉')).toBe('Untitled');
  });
});

describe('UHS_CALENDAR_ID — never silently the personal calendar', () => {
  it('is the UHS group calendar, not "primary"', () => {
    expect(UHS_CALENDAR_ID).not.toBe('primary');
    expect(UHS_CALENDAR_ID).toContain('@group.calendar.google.com');
  });
});

describe('spokenList — reads as speech, not as an array', () => {
  it('formats one, two, and three items', () => {
    expect(spokenList(['a'])).toBe('a');
    expect(spokenList(['a', 'b'])).toBe('a and b');
    expect(spokenList(['a', 'b', 'c'])).toBe('a, b, and c');
  });
  it('is empty for nothing', () => {
    expect(spokenList([])).toBe('');
  });
});

// === JARVIS MOD #65/#66 — the prompt must actually route counts to the tool ===
// The prompt is a shared hot file that several agents rewrite; a rewrite from an
// older base silently dropped active_stagings from the prose once already, which
// would put the Realtime lane straight back to free-answering counts.
describe('the Realtime prompt routes counts through a tool', () => {
  it('registers active_stagings as a callable tool', async () => {
    const { JARVIS_REALTIME_TOOLS } = await import('../jarvis-prompt');
    expect(JARVIS_REALTIME_TOOLS.map((t) => t.name)).toContain('active_stagings');
  });
  it('names active_stagings in the prose, not just the registry', async () => {
    const { JARVIS_SYSTEM_PROMPT } = await import('../jarvis-prompt');
    expect(JARVIS_SYSTEM_PROMPT).toContain('active_stagings');
  });
  it('forbids speaking a count from memory', async () => {
    const { JARVIS_SYSTEM_PROMPT } = await import('../jarvis-prompt');
    expect(JARVIS_SYSTEM_PROMPT).toContain('COUNTS RULE');
  });
});
