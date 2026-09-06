/**
 * OS-03 — the Today home.
 *
 * The failure this page exists to prevent is the one the Queue used to have:
 * a screen that renders "all clear" over a source it could not read. So the
 * tests below are mostly about what Today says when it does NOT know:
 *
 *   * a degraded source suppresses the decision COUNT entirely rather than
 *     printing a confident zero;
 *   * a missing snapshot makes the overnight and commitment sections say the
 *     night is unknown, not empty;
 *   * an outcome with no recorded evidence is classified unverified, never
 *     promoted to deployed because the wording sounded finished.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHeader,
  buildNeedsScott,
  buildOvernight,
  buildTodayTonight,
  buildBusinessExceptions,
  buildTodayView,
  classifyOutcome,
  MINUTES_PER_DECISION,
  OUTCOME_CLASS_LABEL,
  pacificParts,
  SNAPSHOT_STALE_MINUTES,
} from '../today-view';
import { REQUIRED_SECTIONS, type BriefingResult, type BriefingSnapshot } from '@/lib/uhs/briefing';
import type { ActionItem, ActionItems } from '@/lib/data/action-items';
import type { SourceHealthRow } from '@/lib/data/source-health';

const DATE = '2026-09-05';

function sections(over: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const id of REQUIRED_SECTIONS) {
    out[id] = { title: id, items: [], text: '', count: 0, status: 'ok', note: null };
  }
  return { ...out, ...over } as BriefingSnapshot['sections'];
}

function snapshot(over: Partial<BriefingSnapshot> = {}): BriefingSnapshot {
  return {
    business_date: DATE, version: 3, state: 'published_ui', content_hash: 'h',
    degraded: false, degraded_reasons: [], missed_deadline: false,
    window_start: null, window_end: null,
    snapshot_cutoff: '2026-09-05T12:00:00Z', policy_version: 1, published_ui_at: null,
    persons: ['scott'], sections: sections(), facets: {}, body_included: true,
    withheld_facet_count: 0, body_text: '', counts: {}, labels: {},
    ...over,
  };
}

function briefing(over: Partial<BriefingResult> = {}): BriefingResult {
  return { snapshot: snapshot(), origin: 'supabase', warnings: [], requestedDate: DATE, ...over };
}

function item(over: Partial<ActionItem> = {}): ActionItem {
  return { kind: 'human_task', id: '1', title: 'Decide the thing', href: '/x', ...over };
}

function actions(over: Partial<ActionItems> = {}): ActionItems {
  return {
    humanTasks: [], blockedTasks: [], recoveryTasks: [], unassignedTasks: [],
    degradedSources: [], approvals: [], staleAgents: [], blockedSkillRuns: [],
    healthSummary: { healthy: 0, stale: 0, down: 0, agents: [] } as unknown as ActionItems['healthSummary'],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('the top line', () => {
  it('reports the Pacific business date and time, not the server timezone', () => {
    // 2026-09-05T02:30:00Z is still 2026-09-04 in Pacific daylight time.
    const parts = pacificParts(new Date('2026-09-05T02:30:00Z'));
    expect(parts.date).toBe('2026-09-04');
    expect(parts.time).toBe('19:30');
  });

  it('says a snapshot is missing rather than showing yesterday in its place', () => {
    const h = buildHeader(briefing({ snapshot: null, origin: 'none' }), [], 0);
    expect(h.freshness.state).toBe('missing');
    expect(h.freshness.label).toContain('No snapshot has been published');
    expect(h.freshness.label).toMatch(/Nothing from yesterday/);
  });

  it('marks a snapshot older than the stale window as stale', () => {
    const old = new Date(Date.parse('2026-09-05T12:00:00Z') + (SNAPSHOT_STALE_MINUTES + 30) * 60000);
    const h = buildHeader(briefing(), [], 0, old);
    expect(h.freshness.state).toBe('stale');
  });

  it('names a local fallback as a fallback', () => {
    const h = buildHeader(briefing({ origin: 'local_fallback' }), [], 0);
    expect(h.freshness.label).toContain('local fallback');
  });

  it('is degraded, not clear, when a source could not be read', () => {
    const h = buildHeader(briefing(), [
      { source: 'sqlite://tasks', status: 'unavailable', error: 'locked', lastGoodAt: null },
    ], null);
    expect(h.overallStatus).toBe('degraded');
    expect(h.statusLabel).toMatch(/nothing here is a complete picture/);
    expect(h.degraded).toBe(true);
  });

  it('states the count in words when there is something to decide', () => {
    const h = buildHeader(briefing(), [], 3);
    expect(h.overallStatus).toBe('attention');
    expect(h.statusLabel).toBe('3 decisions waiting on you');
  });
});

// ---------------------------------------------------------------------------

describe('Needs Scott', () => {
  it('asks a question, not just a task title', () => {
    const s = buildNeedsScott(
      actions({ approvals: [item({ kind: 'approval', title: 'Send the Capsule offer' })] }),
      briefing(),
    );
    expect(s.items[0].question).toBe('Approve or decline: Send the Capsule offer?');
  });

  it('says "not recorded" instead of inventing an impact or a recommendation', () => {
    const s = buildNeedsScott(actions({ humanTasks: [item()] }), briefing());
    expect(s.items[0].recommendation).toBeNull();
    expect(s.items[0].deadline).toBeNull();
  });

  it('uses the briefing\'s question, impact and recommendation when it has them', () => {
    const b = briefing({
      snapshot: snapshot({
        sections: sections({
          decisions_for_scott: {
            title: 'd', text: '', count: 1, status: 'ok',
            items: [{
              title: 'Renew 2801 Colanthe?', detail: 'Escrow fell through; carrying cost',
              next_action: 'Renew for 30 days', deadline: '2026-09-08', task_id: 42, owner: 'scott',
            }],
          },
        }),
      }),
    });
    const s = buildNeedsScott(actions(), b);
    expect(s.items[0].question).toBe('Renew 2801 Colanthe?');
    expect(s.items[0].businessImpact).toContain('carrying cost');
    expect(s.items[0].recommendation).toBe('Renew for 30 days');
    expect(s.items[0].deadline).toBe('2026-09-08');
    expect(s.items[0].href).toBe('/board?task=supa_42');
  });

  it('shows the first five with the rest one click away', () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: String(i), title: `Task ${i}` }));
    const s = buildNeedsScott(actions({ humanTasks: many }), briefing());
    expect(s.visible).toHaveLength(5);
    expect(s.hiddenCount).toBe(4);
  });

  it('estimates review time from a stated per-decision allowance', () => {
    const s = buildNeedsScott(
      actions({ humanTasks: [item({ id: 'a' }), item({ id: 'b' })] }),
      briefing(),
    );
    expect(s.total).toBe(2);
    expect(s.estimatedMinutes).toBe(2 * MINUTES_PER_DECISION);
    expect(s.estimateBasis).toContain('estimate');
  });

  it('withholds the count entirely when a source is degraded', () => {
    const s = buildNeedsScott(
      actions({
        humanTasks: [item()],
        degradedSources: [{ source: 'sqlite://tasks', status: 'unavailable', error: 'x', lastGoodAt: null }],
      }),
      briefing(),
    );
    expect(s.total).toBeNull();
    expect(s.estimatedMinutes).toBeNull();
    expect(s.emptyLabel).toMatch(/Unknown/);
  });

  it('never claims all clear over a degraded source', () => {
    const s = buildNeedsScott(
      actions({ degradedSources: [{ source: 's', status: 'stale', error: null, lastGoodAt: null }] }),
      briefing(),
    );
    expect(s.items).toHaveLength(0);
    expect(s.emptyLabel).not.toMatch(/Nothing is waiting/);
  });

  it('separates Angelic and Raquel responsibilities through the owner filter', () => {
    const rows = [
      item({ id: '1', title: 'Scott thing', ownerLabel: 'Scott Ascherman' }),
      item({ id: '2', title: 'Angelic thing', ownerLabel: 'Angelic Ferguson' }),
      item({ id: '3', title: 'Raquel thing', ownerLabel: 'Raquel Lopez' }),
    ];
    expect(buildNeedsScott(actions({ humanTasks: rows }), briefing(), 'all').items).toHaveLength(3);
    expect(buildNeedsScott(actions({ humanTasks: rows }), briefing(), 'angelic').items.map((d) => d.question))
      .toEqual(['Angelic thing — is this still what you want done?']);
    expect(buildNeedsScott(actions({ humanTasks: rows }), briefing(), 'raquel').items).toHaveLength(1);
  });

  it('puts approvals and blocked skill runs above ordinary assigned work', () => {
    const s = buildNeedsScott(
      actions({
        humanTasks: [item({ id: 'h', title: 'Ordinary' })],
        approvals: [item({ id: 'a', kind: 'approval', title: 'Urgent approval' })],
      }),
      briefing(),
    );
    expect(s.items[0].kind).toBe('approval');
  });
});

// ---------------------------------------------------------------------------

describe('Overnight', () => {
  it('says the night is unknown, not empty, when there is no snapshot', () => {
    const o = buildOvernight(briefing({ snapshot: null, origin: 'none' }), []);
    expect(o.available).toBe(false);
    expect(o.unavailableReason).toContain('unknown rather than empty');
    expect(o.groups).toHaveLength(0);
  });

  it('keeps completions, failures and changes in separate groups', () => {
    const o = buildOvernight(briefing(), []);
    expect(o.groups.map((g) => g.key)).toEqual(['completed', 'failed', 'changes']);
  });

  it('classifies each claim by the evidence the record actually carries', () => {
    expect(classifyOutcome({ evidence: 'measured against the July baseline' })).toBe('measured');
    expect(classifyOutcome({ evidence: 'deployed to production' })).toBe('deployed');
    expect(classifyOutcome({ evidence: 'PR #114 open for review' })).toBe('review_ready_pr');
    expect(classifyOutcome({ evidence: 'unit tests passed locally' })).toBe('tested_local');
  });

  it('classifies an outcome with no evidence as unverified, never as deployed', () => {
    expect(classifyOutcome({ title: 'Shipped the new pricing page' })).toBe('unverified');
    expect(OUTCOME_CLASS_LABEL.unverified).toBe('No evidence recorded');
  });

  it('a measured result outranks the deployment it mentions', () => {
    expect(classifyOutcome({ evidence: 'deployed and measured a 12% lift' })).toBe('measured');
  });

  it('labels cache completions as unverified when the snapshot recorded none', () => {
    const o = buildOvernight(briefing(), [
      { id: 't1', title: 'Nightly sync', status: 'completed', priority: 'normal', org: 'uhs',
        needs_approval: false, created_at: '2026-09-04T00:00:00Z' },
    ]);
    const completed = o.groups.find((g) => g.key === 'completed')!;
    expect(completed.items[0].outcomeClass).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------

describe('Today and tonight', () => {
  it('labels tonight\'s work proposed until its authority is recorded', () => {
    const b = briefing({
      snapshot: snapshot({
        sections: sections({
          tonights_work: {
            title: 't', text: '', count: 2, status: 'ok',
            items: [
              { title: 'Draft the newsletter' },
              { title: 'Reconcile September', authorized: true },
            ],
          },
        }),
      }),
    });
    const t = buildTodayTonight(b);
    const tonight = t.groups.find((g) => g.key === 'tonight')!;
    expect(tonight.items[0].authority).toBe('proposed');
    expect(tonight.items[0].authorityNote).toMatch(/until its authority requirements are satisfied/);
    expect(tonight.items[1].authority).toBe('committed');
  });

  it('reports capacity only when the snapshot states one', () => {
    const t = buildTodayTonight(briefing());
    expect(t.groups.find((g) => g.key === 'today')!.capacity).toBeNull();
  });

  it('says commitments are unknown when there is no snapshot', () => {
    const t = buildTodayTonight(briefing({ snapshot: null, origin: 'none' }));
    expect(t.available).toBe(false);
    expect(t.unavailableReason).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------

describe('Business exceptions', () => {
  const staleSource: SourceHealthRow = {
    source: 'supabase://tasks', status: 'stale', fetched_at: null, source_updated_at: null,
    stale_after_seconds: 900, last_good_at: '2026-09-04T00:00:00Z', row_count: 12, error: null,
  };

  it('treats source freshness as an exception, not a footnote', () => {
    const e = buildBusinessExceptions(briefing(), actions(), [staleSource]);
    const row = e.items.find((i) => i.category === 'source_freshness')!;
    expect(row.title).toContain('stale');
    expect(row.nextAction).toMatch(/incomplete/);
  });

  it('surfaces work with no accountable owner', () => {
    const e = buildBusinessExceptions(
      briefing(),
      actions({ unassignedTasks: [item({ kind: 'unassigned_task', id: 'u1', title: 'Orphan' })] }),
      [],
    );
    expect(e.items.find((i) => i.category === 'ownership')!.nextAction).toBe('Assign an accountable owner.');
  });

  it('claims nothing is wrong only when every source is fresh', () => {
    expect(buildBusinessExceptions(briefing(), actions(), []).emptyLabel)
      .toMatch(/every source is fresh/);
    expect(buildBusinessExceptions(briefing(), actions(), [staleSource]).items.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the whole page', () => {
  it('assembles all four sections in plan order', () => {
    const view = buildTodayView({
      actionItems: actions(), briefing: briefing(), completedToday: [], sourceRows: [],
    });
    expect(Object.keys(view)).toEqual([
      'header', 'needsScott', 'overnight', 'todayTonight', 'exceptions', 'warnings',
    ]);
  });

  it('carries the briefing\'s own warnings through instead of swallowing them', () => {
    const view = buildTodayView({
      actionItems: actions(),
      briefing: briefing({ warnings: ['section "improvements" reports 3 items but carries 1'] }),
      completedToday: [], sourceRows: [],
    });
    expect(view.warnings).toHaveLength(1);
  });

  it('is degraded end to end when a source is down', () => {
    const view = buildTodayView({
      actionItems: actions({
        degradedSources: [{ source: 'sqlite://tasks', status: 'unavailable', error: 'io', lastGoodAt: null }],
      }),
      briefing: briefing(), completedToday: [], sourceRows: [],
    });
    expect(view.header.overallStatus).toBe('degraded');
    expect(view.needsScott.total).toBeNull();
    expect(view.exceptions.degraded).toBe(true);
  });
});
