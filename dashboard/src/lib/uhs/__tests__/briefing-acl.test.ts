/**
 * dashboard/src/lib/uhs/__tests__/briefing-acl.test.ts — OS-04b
 *
 * Who may view whose briefing, and which facets survive the filter.
 *
 * The load-bearing test is the sentinel one: a string present ONLY in Angelic's inbox
 * facet must not survive filtering for Raquel or Scott, in any serialisation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  viewerPersons,
  canViewPerson,
  defaultPersonFor,
  isPerson,
  KNOWN_PERSONS,
} from '@/lib/uhs/briefing-acl';
import {
  filterSnapshotForPerson,
  permittedFacets,
  orderedFacets,
  BODY_FACET_ID,
  REQUIRED_SECTIONS,
  type BriefingFacet,
  type BriefingSnapshot,
} from '@/lib/uhs/briefing';

const SENTINEL = 'ZZTEST-ANGELIC-ONLY';
const SCOTT_ONLY = 'ZZTEST-SCOTT-FINANCE-ONLY';

afterEach(() => {
  delete process.env.BRIEFING_VIEWERS;
});

function facet(id: string, visibleTo: string[], content: Record<string, unknown> = {}): BriefingFacet {
  return {
    id,
    title: id,
    scope: visibleTo.length === 3 ? 'shared' : visibleTo[0],
    visible_to: visibleTo,
    format: 'structured',
    status: 'ok',
    content,
  };
}

function snapshot(): BriefingSnapshot {
  const sections = {} as BriefingSnapshot['sections'];
  for (const id of REQUIRED_SECTIONS) {
    sections[id] = { title: id, items: [{ header: 'APPROVALS', lines: [SCOTT_ONLY] }], text: SCOTT_ONLY, count: 1, status: 'ok', note: null };
  }
  return {
    business_date: '2026-09-05',
    version: 1,
    state: 'published_ui',
    content_hash: 'abc',
    degraded: false,
    degraded_reasons: [],
    missed_deadline: false,
    window_start: null,
    window_end: null,
    snapshot_cutoff: '2026-09-05T11:30:00Z',
    policy_version: 1,
    published_ui_at: '2026-09-05T11:31:00Z',
    persons: ['scott', 'raquel', 'angelic'],
    facets: {
      [BODY_FACET_ID]: facet(BODY_FACET_ID, ['scott']),
      raquel_todo: facet('raquel_todo', ['raquel', 'scott'], { html: '<li>edit photos</li>' }),
      blog_pipeline: facet('blog_pipeline', ['scott', 'raquel', 'angelic'], { upcoming: [] }),
      angelic_inbox: facet('angelic_inbox', ['angelic'], {
        items: [{ from: 'A Client', subject: SENTINEL }],
      }),
      unstamped: { id: 'unstamped', title: 'Unstamped', scope: 'shared', format: 'structured', status: 'ok', content: { secret: 'ZZTEST-NO-STAMP' } } as unknown as BriefingFacet,
    },
    body_included: true,
    withheld_facet_count: 0,
    sections,
    body_text: `BRIEFING\n- ${SCOTT_ONLY}`,
    counts: { completed: 3 },
    labels: {},
  };
}

// ------------------------------------------------------------ viewer -> person ---

describe('viewerPersons', () => {
  it('gives Scott all three persons', () => {
    expect(viewerPersons('scott@utopiahomestaging.com')).toEqual(['scott', 'raquel', 'angelic']);
  });

  it('is case-insensitive on the username', () => {
    expect(viewerPersons('Scott@Utopiahomestaging.com')).toContain('scott');
  });

  it('fails closed for an unknown account rather than defaulting to a view', () => {
    expect(viewerPersons('somebody-else')).toEqual([]);
    expect(viewerPersons(null)).toEqual([]);
    expect(defaultPersonFor('somebody-else')).toBeNull();
  });

  it('honours a narrowing override from BRIEFING_VIEWERS', () => {
    process.env.BRIEFING_VIEWERS = JSON.stringify({ 'scott@utopiahomestaging.com': ['scott'] });
    expect(viewerPersons('scott@utopiahomestaging.com')).toEqual(['scott']);
    expect(canViewPerson('scott@utopiahomestaging.com', 'angelic')).toBe(false);
  });

  it('ignores unknown person names in an override', () => {
    process.env.BRIEFING_VIEWERS = JSON.stringify({ tester: ['raquel', 'nobody'] });
    expect(viewerPersons('tester')).toEqual(['raquel']);
  });

  it('falls back to the defaults when the override is malformed, never widening', () => {
    process.env.BRIEFING_VIEWERS = 'not json';
    expect(viewerPersons('raquel')).toEqual(['raquel']);
  });

  it('recognises exactly the three known persons', () => {
    expect(KNOWN_PERSONS.every(isPerson)).toBe(true);
    expect(isPerson('vera')).toBe(false);
  });
});

// ---------------------------------------------------------------- facet ACL ---

describe('facet filtering', () => {
  it('withholds a facet with no visible_to stamp', () => {
    const warnings: string[] = [];
    const out = permittedFacets(snapshot().facets, 'scott', warnings);
    expect(out).not.toHaveProperty('unstamped');
    expect(warnings.join(' ')).toContain('no visible_to stamp');
  });

  it("never leaks Angelic's inbox to Raquel or Scott", () => {
    for (const person of ['raquel', 'scott']) {
      const view = filterSnapshotForPerson(snapshot(), person);
      expect(JSON.stringify(view)).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(filterSnapshotForPerson(snapshot(), 'angelic'))).toContain(SENTINEL);
  });

  it("never leaks Scott's body to a persona, not even trimmed", () => {
    for (const person of ['raquel', 'angelic']) {
      const view = filterSnapshotForPerson(snapshot(), person);
      expect(view.body_included).toBe(false);
      expect(view.body_text).toBe('');
      expect(view.counts).toEqual({});
      expect(JSON.stringify(view)).not.toContain(SCOTT_ONLY);
    }
  });

  it('keeps the body for Scott', () => {
    const view = filterSnapshotForPerson(snapshot(), 'scott');
    expect(view.body_included).toBe(true);
    expect(view.body_text).toContain(SCOTT_ONLY);
  });

  it('counts what it withheld', () => {
    const view = filterSnapshotForPerson(snapshot(), 'angelic');
    // scott body, raquel todo and the unstamped facet are all withheld.
    expect(view.withheld_facet_count).toBe(3);
  });

  it('does not mutate the snapshot it filtered', () => {
    const original = snapshot();
    filterSnapshotForPerson(original, 'raquel');
    expect(original.body_included).toBe(true);
    expect(Object.keys(original.facets)).toContain('angelic_inbox');
  });

  it('orders facets the way the persona briefings present them', () => {
    const ids = orderedFacets(filterSnapshotForPerson(snapshot(), 'raquel').facets).map(([id]) => id);
    expect(ids).toEqual(['raquel_todo', 'blog_pipeline']);
  });
});
