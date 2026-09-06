/**
 * OS-03 — what Today actually renders, in every state it can be in.
 *
 * Rendered to static markup with react-dom/server: no jsdom, no extra test
 * dependency, and the assertions are about the text a person reads rather
 * than about implementation details.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TodayHeader } from '../today-header';
import { NeedsScott } from '../needs-scott';
import { Overnight } from '../overnight';
import { TodayTonight } from '../today-tonight';
import { BusinessExceptions } from '../business-exceptions';
import {
  buildHeader, buildNeedsScott, buildOvernight, buildTodayTonight, buildBusinessExceptions,
} from '@/lib/os03/today-view';
import { REQUIRED_SECTIONS, type BriefingResult, type BriefingSnapshot } from '@/lib/uhs/briefing';
import type { ActionItem, ActionItems, DegradedSource } from '@/lib/data/action-items';

const DATE = '2026-09-05';

function sections(over: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const id of REQUIRED_SECTIONS) {
    out[id] = { title: id, items: [], text: '', count: 0, status: 'ok', note: null };
  }
  return { ...out, ...over } as BriefingSnapshot['sections'];
}

function snap(over: Partial<BriefingSnapshot> = {}): BriefingSnapshot {
  return {
    business_date: DATE, version: 1, state: 'published_ui', content_hash: null,
    degraded: false, degraded_reasons: [], missed_deadline: false, window_start: null,
    window_end: null, snapshot_cutoff: '2026-09-05T12:00:00Z', policy_version: 1,
    published_ui_at: null, persons: ['scott'], sections: sections(), facets: {},
    body_included: true, withheld_facet_count: 0, body_text: '', counts: {}, labels: {},
    ...over,
  };
}

function briefing(over: Partial<BriefingResult> = {}): BriefingResult {
  return { snapshot: snap(), origin: 'supabase', warnings: [], requestedDate: DATE, ...over };
}

function actions(over: Partial<ActionItems> = {}): ActionItems {
  return {
    humanTasks: [], blockedTasks: [], recoveryTasks: [], unassignedTasks: [],
    degradedSources: [], approvals: [], staleAgents: [], blockedSkillRuns: [],
    healthSummary: { healthy: 0, stale: 0, down: 0, agents: [] } as unknown as ActionItems['healthSummary'],
    ...over,
  };
}

const DEGRADED: DegradedSource[] = [
  { source: 'sqlite://tasks', status: 'unavailable', error: 'database is locked', lastGoodAt: null },
];

// ---------------------------------------------------------------------------

describe('the top line', () => {
  it('prints the Pacific date and time and the snapshot version', () => {
    const html = renderToStaticMarkup(
      <TodayHeader header={buildHeader(briefing(), [], 0, new Date('2026-09-05T15:00:00Z'))} />,
    );
    expect(html).toContain('2026-09-05');
    expect(html).toContain('PT');
    expect(html).toContain('Snapshot v1');
  });

  it('renders the degraded banner loudly, above everything else', () => {
    const html = renderToStaticMarkup(
      <TodayHeader header={buildHeader(briefing(), DEGRADED, null)} />,
    );
    expect(html).toContain('data-testid="degraded-banner"');
    expect(html).toContain('database is locked');
    expect(html).toContain('cannot be trusted');
  });

  it('states the status in words, so colour is never the only signal', () => {
    const html = renderToStaticMarkup(
      <TodayHeader header={buildHeader(briefing(), [], 4)} />,
    );
    expect(html).toContain('4 decisions waiting on you');
  });

  it('says a missing snapshot is missing', () => {
    const html = renderToStaticMarkup(
      <TodayHeader header={buildHeader(briefing({ snapshot: null, origin: 'none' }), [], 0)} />,
    );
    expect(html).toContain('No snapshot for this business date');
  });
});

// ---------------------------------------------------------------------------

describe('Needs Scott', () => {
  const decision: ActionItem = {
    kind: 'approval', id: '7', title: 'Send the Capsule offer to Tina Mello',
    href: '/approvals', subtitle: 'estimate expires Friday',
  };

  it('renders the question, the impact, the recommendation and the deadline', () => {
    const html = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions({ approvals: [decision] }), briefing())} />,
    );
    expect(html).toContain('Approve or decline: Send the Capsule offer to Tina Mello?');
    expect(html).toContain('Business impact');
    expect(html).toContain('estimate expires Friday');
    expect(html).toContain('Recommendation');
    expect(html).toContain('Deadline');
    // What the record does not say is stated as not recorded, not left blank.
    expect(html).toContain('not recorded');
    expect(html).toContain('Open the record');
  });

  it('shows the estimated review time and how it was estimated', () => {
    const html = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions({ approvals: [decision] }), briefing())} />,
    );
    expect(html).toContain('1 decision');
    expect(html).toContain('minutes allowed per decision');
  });

  it('offers named filters for Angelic and Raquel', () => {
    const html = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions(), briefing())} basePath="/" />,
    );
    expect(html).toContain('data-testid="needs-owner-angelic"');
    expect(html).toContain('data-testid="needs-owner-raquel"');
    expect(html).toContain('href="/?owner=angelic"');
  });

  it('says all clear only when nothing is degraded', () => {
    const clear = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions(), briefing())} />,
    );
    expect(clear).toContain('Nothing is waiting on a decision right now.');

    const degraded = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions({ degradedSources: DEGRADED }), briefing())} />,
    );
    expect(degraded).not.toContain('Nothing is waiting');
    expect(degraded).toContain('Unknown');
  });

  it('hides the count entirely rather than printing a confident zero', () => {
    const html = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions({ degradedSources: DEGRADED }), briefing())} />,
    );
    expect(html).toContain('Count unavailable');
  });

  it('shows the first five and offers the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...decision, id: String(i), title: `Item ${i}` }));
    const html = renderToStaticMarkup(
      <NeedsScott section={buildNeedsScott(actions({ approvals: many }), briefing())} />,
    );
    expect(html.match(/data-testid="decision-row"/g)).toHaveLength(5);
    expect(html).toContain('Show the other 3');
  });
});

// ---------------------------------------------------------------------------

describe('Overnight', () => {
  it('says the night is unknown when there is no snapshot', () => {
    const html = renderToStaticMarkup(
      <Overnight section={buildOvernight(briefing({ snapshot: null, origin: 'none' }), [])} />,
    );
    expect(html).toContain('data-testid="overnight-unavailable"');
    expect(html).toContain('unknown rather than empty');
  });

  it('keeps the four claim classes visibly different', () => {
    const b = briefing({
      snapshot: snap({
        sections: sections({
          verified_overnight_outcomes: {
            title: 'v', text: '', count: 2, status: 'ok',
            items: [
              { title: 'Newsletter draft', evidence: 'tests passed locally', agent: 'jarvis-marketing' },
              { title: 'Pricing fix', evidence: 'deployed to production' },
            ],
          },
        }),
      }),
    });
    const html = renderToStaticMarkup(<Overnight section={buildOvernight(b, [])} />);
    expect(html).toContain('Tested locally');
    expect(html).toContain('Deployed');
    expect(html).toContain('Owner: jarvis-marketing');
  });

  it('says when an outcome links to no evidence at all', () => {
    const b = briefing({
      snapshot: snap({
        sections: sections({
          verified_overnight_outcomes: {
            title: 'v', text: '', count: 1, status: 'ok',
            items: [{ title: 'Something finished' }],
          },
        }),
      }),
    });
    const html = renderToStaticMarkup(<Overnight section={buildOvernight(b, [])} />);
    expect(html).toContain('No evidence recorded');
    expect(html).toContain('no evidence link recorded');
  });

  it('renders an empty night as empty, with a sentence, not a blank', () => {
    const html = renderToStaticMarkup(<Overnight section={buildOvernight(briefing(), [])} />);
    expect(html).toContain('Nothing failed overnight.');
    expect(html).toContain('No software changes were recorded overnight.');
  });
});

// ---------------------------------------------------------------------------

describe('Today and tonight', () => {
  it('labels proposed night work proposed', () => {
    const b = briefing({
      snapshot: snap({
        sections: sections({
          tonights_work: {
            title: 't', text: '', count: 1, status: 'ok',
            items: [{ title: 'Draft next week\'s blog', agent: 'jarvis-marketing' }],
          },
        }),
      }),
    });
    const html = renderToStaticMarkup(<TodayTonight section={buildTodayTonight(b)} />);
    expect(html).toContain('Proposed');
    expect(html).toContain('until its authority requirements are satisfied');
  });

  it('says capacity is not recorded rather than showing nothing', () => {
    const html = renderToStaticMarkup(<TodayTonight section={buildTodayTonight(briefing())} />);
    expect(html).toContain('Capacity not recorded');
  });
});

// ---------------------------------------------------------------------------

describe('Business exceptions', () => {
  it('renders a stale source as an exception with its next action', () => {
    const section = buildBusinessExceptions(briefing(), actions(), [
      { source: 'supabase://tasks', status: 'stale', fetched_at: null, source_updated_at: null,
        stale_after_seconds: 900, last_good_at: '2026-09-04T00:00:00Z', row_count: 3, error: null },
    ]);
    const html = renderToStaticMarkup(<BusinessExceptions section={section} />);
    expect(html).toContain('supabase://tasks is stale');
    expect(html).toContain('Source freshness');
    expect(html).toContain('incomplete');
  });

  it('claims all clear only when every source is fresh', () => {
    const html = renderToStaticMarkup(
      <BusinessExceptions section={buildBusinessExceptions(briefing(), actions(), [])} />,
    );
    expect(html).toContain('every source is fresh');
  });
});
