// === OS-03 — the Today home, as a data model ===
//
// New file; never overwritten by upstream merges.
//
// Today answers four questions in order: what needs Scott's decision, what
// finished overnight with proof, what is committed for today and tonight, and
// which business obligations are exceptions. Everything here is assembled from
// sources that already exist — the OS-01 queue selectors and the OS-04
// briefing snapshot. Nothing on this page is computed from a guess.
//
// The rules that shape every function below:
//
//   * A count is never invented. If a source did not answer, the section says
//     so and shows no number, because a confident zero is worse than an
//     admitted gap.
//   * A completion claim carries its evidence class. "Tested locally", "review
//     ready", "deployed" and "measured" are different facts and the page keeps
//     them different. An outcome with nothing recorded reads as unverified.
//   * Proposed nighttime work stays labelled proposed. Authority is not
//     inferred from a plan.
// === END header ===

import type { ActionItem, ActionItems, DegradedSource } from '@/lib/data/action-items';
import type {
  BriefingResult,
  BriefingSectionItem,
  SectionId,
} from '@/lib/uhs/briefing';
import { snapshotAgeMinutes } from '@/lib/uhs/briefing-age';
import type { SourceHealthRow } from '@/lib/data/source-health';
import type { Task } from '@/lib/types';

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export type OverallStatus = 'clear' | 'attention' | 'degraded';

export interface TodayHeader {
  /** Pacific business date, YYYY-MM-DD. */
  businessDate: string;
  /** Pacific wall-clock time the page was rendered, e.g. "07:12". */
  businessTime: string;
  timezoneLabel: string;
  freshness: {
    origin: BriefingResult['origin'];
    ageMinutes: number | null;
    label: string;
    state: 'fresh' | 'stale' | 'missing';
  };
  overallStatus: OverallStatus;
  statusLabel: string;
  degraded: boolean;
  degradedSources: DegradedSource[];
}

/** Snapshots older than this are stale rather than current. */
export const SNAPSHOT_STALE_MINUTES = 240;

export function pacificParts(now: Date = new Date()): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  return { date, time };
}

export function buildHeader(
  briefing: BriefingResult,
  degradedSources: DegradedSource[],
  needsCount: number | null,
  now: Date = new Date(),
): TodayHeader {
  const { date, time } = pacificParts(now);
  const snapshot = briefing.snapshot;
  const age = snapshot ? snapshotAgeMinutes(snapshot, now) : null;

  let state: TodayHeader['freshness']['state'] = 'missing';
  let label = `No snapshot has been published for ${briefing.requestedDate}. Nothing from yesterday is shown in its place.`;
  if (snapshot) {
    state = age !== null && age > SNAPSHOT_STALE_MINUTES ? 'stale' : 'fresh';
    const ageText = age === null ? 'age unknown' : `${age} min old`;
    const originText =
      briefing.origin === 'local_fallback'
        ? 'local fallback, written while Supabase was unreachable'
        : 'published snapshot';
    label = `Snapshot v${snapshot.version} — ${ageText} (${originText})`;
  }

  const degraded = degradedSources.length > 0 || Boolean(snapshot?.degraded);
  const overallStatus: OverallStatus = degraded
    ? 'degraded'
    : needsCount === null
      ? 'degraded'
      : needsCount > 0
        ? 'attention'
        : 'clear';

  const statusLabel =
    overallStatus === 'degraded'
      ? 'Degraded — part of this page could not be read, so nothing here is a complete picture'
      : overallStatus === 'attention'
        ? `${needsCount} decision${needsCount === 1 ? '' : 's'} waiting on you`
        : 'Nothing is waiting on you right now';

  return {
    businessDate: date,
    businessTime: time,
    timezoneLabel: 'PT',
    freshness: { origin: briefing.origin, ageMinutes: age, label, state },
    overallStatus,
    statusLabel,
    degraded,
    degradedSources,
  };
}

// ---------------------------------------------------------------------------
// 1. Needs Scott
// ---------------------------------------------------------------------------

export type OwnerFilterKey = 'all' | 'scott' | 'angelic' | 'raquel';

export const OWNER_FILTERS: { key: OwnerFilterKey; label: string; description: string }[] = [
  { key: 'all', label: 'Everyone', description: 'Every decision, whoever owns it' },
  { key: 'scott', label: 'Scott', description: "Decisions only Scott can make" },
  { key: 'angelic', label: 'Angelic', description: "Angelic's responsibilities" },
  { key: 'raquel', label: 'Raquel', description: "Raquel's responsibilities" },
];

export interface DecisionItem {
  id: string;
  /** The question being asked. Always a question, never a task name alone. */
  question: string;
  /** Why it matters to the business. `null` when the record does not say. */
  businessImpact: string | null;
  /** What the system recommends. `null` when nothing recommended one. */
  recommendation: string | null;
  /** When the decision stops being useful. `null` when none was recorded. */
  deadline: string | null;
  /** The item this decision came from, named so it can be found. */
  sourceItem: string;
  /** Link to the draft, diff or record being decided on. */
  href: string;
  owner: OwnerFilterKey;
  /** Ordering weight: lower sorts first. */
  rank: number;
  kind: ActionItem['kind'] | 'briefing_decision';
}

/** Minutes to allow per decision when estimating review time. Stated in the
 *  UI so the estimate is legible as an estimate. */
export const MINUTES_PER_DECISION = 2;

export interface NeedsScottSection {
  items: DecisionItem[];
  /** First five; the rest are one click away. */
  visible: DecisionItem[];
  hiddenCount: number;
  /** `null` when a source behind this section could not be read. */
  total: number | null;
  estimatedMinutes: number | null;
  estimateBasis: string;
  degraded: boolean;
  emptyLabel: string;
  ownerFilter: OwnerFilterKey;
}

const DECISION_RANK: Record<string, number> = {
  approval: 0,
  skill_run: 1,
  blocked_task: 2,
  failed_task: 2,
  human_task: 3,
  unassigned_task: 4,
  stale_agent: 5,
  briefing_decision: 0,
};

function ownerOf(item: ActionItem): OwnerFilterKey {
  const label = (item.ownerLabel ?? '').toLowerCase();
  if (label.includes('angelic')) return 'angelic';
  if (label.includes('raquel')) return 'raquel';
  if (label.includes('scott')) return 'scott';
  return 'scott';
}

function questionFor(item: ActionItem): string {
  switch (item.kind) {
    case 'approval':
      return `Approve or decline: ${item.title}?`;
    case 'skill_run':
      return `A skill run is blocked on a decision — how should ${item.title} proceed?`;
    case 'blocked_task':
      return `This work is blocked — what unblocks ${item.title}?`;
    case 'failed_task':
      return `This work failed — retry, reassign or stop ${item.title}?`;
    case 'unassigned_task':
      return `Nobody owns this — who should take ${item.title}?`;
    case 'stale_agent':
      return `${item.title} has stopped reporting — restart it or leave it down?`;
    default:
      return `${item.title} — is this still what you want done?`;
  }
}

/** A briefing decision item carries its own fields; use them verbatim. */
export function decisionFromBriefing(item: BriefingSectionItem, index: number): DecisionItem {
  const title = item.title ?? item.header ?? 'Untitled decision';
  return {
    id: `briefing:${item.task_id ?? index}`,
    question: String(title),
    businessImpact: (item.detail as string) ?? null,
    recommendation: (item.next_action as string) ?? null,
    deadline: (item.deadline as string) ?? null,
    sourceItem: (item.source as string) ?? 'morning briefing snapshot',
    href: item.task_id ? `/board?task=supa_${item.task_id}` : '/briefing',
    owner: (item.owner as OwnerFilterKey) ?? 'scott',
    rank: DECISION_RANK.briefing_decision,
    kind: 'briefing_decision',
  };
}

export function decisionFromActionItem(item: ActionItem): DecisionItem {
  return {
    id: `${item.kind}:${item.id}`,
    question: questionFor(item),
    businessImpact: item.subtitle ?? null,
    recommendation: null,
    deadline: null,
    sourceItem: `${item.kind.replace(/_/g, ' ')} ${item.id}`,
    href: item.href,
    owner: ownerOf(item),
    rank: DECISION_RANK[item.kind] ?? 6,
    kind: item.kind,
  };
}

export function buildNeedsScott(
  actionItems: ActionItems,
  briefing: BriefingResult,
  ownerFilter: OwnerFilterKey = 'all',
): NeedsScottSection {
  const degraded = actionItems.degradedSources.length > 0;

  const briefingItems = (
    briefing.snapshot?.sections?.decisions_for_scott?.items ?? []
  ).map(decisionFromBriefing);

  const queueItems = [
    ...actionItems.approvals,
    ...actionItems.blockedSkillRuns,
    ...actionItems.humanTasks,
    ...actionItems.blockedTasks,
  ].map(decisionFromActionItem);

  // A briefing decision and a queue row can describe the same task. Prefer the
  // briefing's version: it carries the question, the impact and the
  // recommendation, and the queue row carries only the title.
  const seen = new Set(briefingItems.map((d) => d.question.toLowerCase()));
  const merged = [
    ...briefingItems,
    ...queueItems.filter((d) => !seen.has(d.question.toLowerCase())),
  ];

  const filtered =
    ownerFilter === 'all' ? merged : merged.filter((d) => d.owner === ownerFilter);
  const items = [...filtered].sort((a, b) => a.rank - b.rank);

  const total = degraded ? null : items.length;
  return {
    items,
    visible: items.slice(0, 5),
    hiddenCount: Math.max(0, items.length - 5),
    total,
    estimatedMinutes: total === null ? null : total * MINUTES_PER_DECISION,
    estimateBasis: `estimate — ${MINUTES_PER_DECISION} minutes allowed per decision`,
    degraded,
    emptyLabel: degraded
      ? 'Unknown — a source behind this section could not be read. See the banner above.'
      : 'Nothing is waiting on a decision right now.',
    ownerFilter,
  };
}

// ---------------------------------------------------------------------------
// 2. Overnight
// ---------------------------------------------------------------------------

/** The four claim classes plan §3 requires be kept distinct, plus the honest
 *  fifth for an outcome that recorded nothing. */
export type OutcomeClass =
  | 'tested_local'
  | 'review_ready_pr'
  | 'deployed'
  | 'measured'
  | 'unverified';

export const OUTCOME_CLASS_LABEL: Record<OutcomeClass, string> = {
  tested_local: 'Tested locally',
  review_ready_pr: 'Review-ready pull request',
  deployed: 'Deployed',
  measured: 'Measured improvement',
  unverified: 'No evidence recorded',
};

export const OUTCOME_CLASS_MEANING: Record<OutcomeClass, string> = {
  tested_local: 'Changed and tested on this machine. Not reviewed and not released.',
  review_ready_pr: 'A pull request exists and is waiting for review. Not released.',
  deployed: 'Released to the environment named in the evidence.',
  measured: 'Released and its effect was measured against a baseline.',
  unverified:
    'The record claims this finished but carries no artifact, run id or receipt. It is reported as claimed, not as verified.',
};

/**
 * Classify an outcome from what the record actually says. The order matters:
 * a measured result outranks a deployment, which outranks a PR, which
 * outranks a local test. Nothing recorded means unverified — never "deployed
 * because it sounded finished".
 */
export function classifyOutcome(item: BriefingSectionItem): OutcomeClass {
  const evidence = `${item.evidence ?? ''} ${item.detail ?? ''} ${item.kind ?? ''}`.toLowerCase();
  if (!evidence.trim()) return 'unverified';
  if (/\bmeasured\b|\bbaseline\b|\bmetric\b/.test(evidence)) return 'measured';
  if (/\bdeployed\b|\breleased\b|\bproduction\b|\brelease\b/.test(evidence)) return 'deployed';
  if (/\bpr\b|pull request|\breview\b/.test(evidence)) return 'review_ready_pr';
  if (/\btest\b|\btests\b|\blocal\b|\bpassed\b/.test(evidence)) return 'tested_local';
  return 'unverified';
}

export interface OvernightItem {
  id: string;
  title: string;
  detail: string | null;
  outcomeClass: OutcomeClass;
  /** Where the proof is. `null` when the record carries none. */
  evidenceHref: string | null;
  evidenceText: string | null;
  owner: string | null;
}

export interface OvernightGroup {
  key: 'completed' | 'failed' | 'changes';
  title: string;
  items: OvernightItem[];
  /** `null` when the snapshot for this date does not exist. */
  count: number | null;
  emptyLabel: string;
}

export interface OvernightSection {
  groups: OvernightGroup[];
  available: boolean;
  unavailableReason: string | null;
}

function overnightItem(item: BriefingSectionItem, index: number, prefix: string): OvernightItem {
  const evidenceText = (item.evidence as string) ?? null;
  return {
    id: `${prefix}:${item.task_id ?? index}`,
    title: String(item.title ?? item.header ?? 'Untitled outcome'),
    detail: (item.detail as string) ?? (item.error as string) ?? null,
    outcomeClass: classifyOutcome(item),
    evidenceHref: item.task_id ? `/board?task=supa_${item.task_id}` : null,
    evidenceText,
    owner: (item.agent as string) ?? (item.owner as string) ?? null,
  };
}

export function buildOvernight(
  briefing: BriefingResult,
  completedToday: Task[],
): OvernightSection {
  const snapshot = briefing.snapshot;
  if (!snapshot) {
    return {
      groups: [],
      available: false,
      unavailableReason: `No briefing snapshot exists for ${briefing.requestedDate}, so what happened overnight is unknown rather than empty. ${briefing.warnings.join(' ')}`.trim(),
    };
  }

  const section = (id: SectionId) => snapshot.sections[id];

  const completed = (section('verified_overnight_outcomes')?.items ?? []).map((i, n) =>
    overnightItem(i, n, 'done'),
  );
  const failed = (section('exceptions_and_recovery')?.items ?? []).map((i, n) =>
    overnightItem(i, n, 'fail'),
  );
  const changes = (section('improvements')?.items ?? []).map((i, n) =>
    overnightItem(i, n, 'change'),
  );

  // The cache's own completed-today rows are shown when the snapshot recorded
  // no outcomes, labelled unverified, because a completed_at stamp is not
  // proof that anything was verified.
  const fallbackCompleted: OvernightItem[] =
    completed.length === 0
      ? completedToday.slice(0, 10).map((t) => ({
          id: `cache:${t.id}`,
          title: t.title,
          detail: t.project ?? t.org,
          outcomeClass: 'unverified' as OutcomeClass,
          evidenceHref: `/board?task=${t.id}`,
          evidenceText: null,
          owner: t.assignee ?? null,
        }))
      : [];

  return {
    available: true,
    unavailableReason: null,
    groups: [
      {
        key: 'completed',
        title: 'Finished, with the proof recorded',
        items: completed.length > 0 ? completed : fallbackCompleted,
        count: completed.length > 0 ? completed.length : fallbackCompleted.length,
        emptyLabel: 'Nothing was recorded as finished overnight.',
      },
      {
        key: 'failed',
        title: 'Failed, and who is recovering it',
        items: failed,
        count: failed.length,
        emptyLabel: 'Nothing failed overnight.',
      },
      {
        key: 'changes',
        title: 'Changes implemented',
        items: changes,
        count: changes.length,
        emptyLabel: 'No software changes were recorded overnight.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3. Today / Tonight
// ---------------------------------------------------------------------------

export interface CommitmentItem {
  id: string;
  outcome: string;
  owner: string | null;
  window: string | null;
  dependencies: string[];
  /** Why this matters. `null` when the record does not say. */
  whyItMatters: string | null;
  /** Tonight's work is proposed until the authority requirements are met. */
  authority: 'committed' | 'proposed';
  authorityNote: string | null;
}

export interface CommitmentGroup {
  key: 'today' | 'tonight';
  title: string;
  items: CommitmentItem[];
  count: number | null;
  /** Stated capacity, when the snapshot records one. Never estimated here. */
  capacity: string | null;
  emptyLabel: string;
}

export interface TodayTonightSection {
  groups: CommitmentGroup[];
  available: boolean;
  unavailableReason: string | null;
}

function commitment(
  item: BriefingSectionItem,
  index: number,
  key: 'today' | 'tonight',
): CommitmentItem {
  const authorised = item.authorized === true || item.authority === 'committed';
  return {
    id: `${key}:${item.task_id ?? index}`,
    outcome: String(item.title ?? item.header ?? 'Unnamed commitment'),
    owner: (item.agent as string) ?? (item.owner as string) ?? null,
    window: (item.window as string) ?? null,
    dependencies: Array.isArray(item.dependencies) ? (item.dependencies as string[]) : [],
    whyItMatters: (item.detail as string) ?? null,
    authority: key === 'tonight' && !authorised ? 'proposed' : 'committed',
    authorityNote:
      key === 'tonight' && !authorised
        ? 'Proposed. Nothing here runs against an external system until its authority requirements are satisfied.'
        : null,
  };
}

export function buildTodayTonight(briefing: BriefingResult): TodayTonightSection {
  const snapshot = briefing.snapshot;
  if (!snapshot) {
    return {
      groups: [],
      available: false,
      unavailableReason: `No briefing snapshot exists for ${briefing.requestedDate}, so today's and tonight's committed work is unknown.`,
    };
  }

  const todayItems = (snapshot.sections.todays_commitments?.items ?? []).map((i, n) =>
    commitment(i, n, 'today'),
  );
  const tonightItems = (snapshot.sections.tonights_work?.items ?? []).map((i, n) =>
    commitment(i, n, 'tonight'),
  );

  return {
    available: true,
    unavailableReason: null,
    groups: [
      {
        key: 'today',
        title: 'Committed today',
        items: todayItems,
        count: todayItems.length,
        capacity: (snapshot.labels?.today_capacity as string) ?? null,
        emptyLabel: 'Nothing is committed for today in this snapshot.',
      },
      {
        key: 'tonight',
        title: 'Tonight',
        items: tonightItems,
        count: tonightItems.length,
        capacity: (snapshot.labels?.tonight_capacity as string) ?? null,
        emptyLabel: 'No overnight work is proposed in this snapshot.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Business exceptions
// ---------------------------------------------------------------------------

export interface ExceptionItem {
  id: string;
  title: string;
  detail: string | null;
  href: string | null;
  /** What kind of obligation this is, so a notice is not filed as a bug. */
  category: 'obligation' | 'ownership' | 'source_freshness';
  nextAction: string | null;
}

export interface BusinessExceptionsSection {
  items: ExceptionItem[];
  count: number;
  /** Source freshness is part of this section, not a footnote. */
  sourceRows: SourceHealthRow[];
  emptyLabel: string;
  degraded: boolean;
}

export function buildBusinessExceptions(
  briefing: BriefingResult,
  actionItems: ActionItems,
  sourceRows: SourceHealthRow[],
): BusinessExceptionsSection {
  const items: ExceptionItem[] = [];

  for (const [n, item] of (
    briefing.snapshot?.sections?.exceptions_and_recovery?.items ?? []
  ).entries()) {
    items.push({
      id: `exception:${item.task_id ?? n}`,
      title: String(item.title ?? item.header ?? 'Unnamed exception'),
      detail: (item.detail as string) ?? (item.error as string) ?? null,
      href: item.task_id ? `/board?task=supa_${item.task_id}` : '/briefing',
      category: 'obligation',
      nextAction: (item.next_action as string) ?? null,
    });
  }

  for (const t of actionItems.unassignedTasks) {
    items.push({
      id: `unassigned:${t.id}`,
      title: t.title,
      detail: t.subtitle ?? null,
      href: t.href,
      category: 'ownership',
      nextAction: 'Assign an accountable owner.',
    });
  }

  for (const row of sourceRows.filter((r) => r.status !== 'fresh')) {
    items.push({
      id: `source:${row.source}`,
      title: `${row.source} is ${row.status}`,
      detail: row.error ?? `Last read successfully at ${row.last_good_at ?? 'never'}.`,
      href: null,
      category: 'source_freshness',
      nextAction: 'Anything derived from this source on this page is incomplete.',
    });
  }

  const degraded = actionItems.degradedSources.length > 0;
  return {
    items,
    count: items.length,
    sourceRows,
    degraded,
    emptyLabel: degraded
      ? 'Unknown — a source behind this section could not be read.'
      : 'No open business exceptions and every source is fresh.',
  };
}

// ---------------------------------------------------------------------------
// The whole page
// ---------------------------------------------------------------------------

export interface TodayView {
  header: TodayHeader;
  needsScott: NeedsScottSection;
  overnight: OvernightSection;
  todayTonight: TodayTonightSection;
  exceptions: BusinessExceptionsSection;
  warnings: string[];
}

export interface TodayInputs {
  actionItems: ActionItems;
  briefing: BriefingResult;
  completedToday: Task[];
  sourceRows: SourceHealthRow[];
  ownerFilter?: OwnerFilterKey;
  now?: Date;
}

/** Pure assembly. Every test in this package drives this function. */
export function buildTodayView(inputs: TodayInputs): TodayView {
  const ownerFilter = inputs.ownerFilter ?? 'all';
  const needsScott = buildNeedsScott(inputs.actionItems, inputs.briefing, ownerFilter);
  return {
    header: buildHeader(
      inputs.briefing,
      inputs.actionItems.degradedSources,
      needsScott.total,
      inputs.now ?? new Date(),
    ),
    needsScott,
    overnight: buildOvernight(inputs.briefing, inputs.completedToday),
    todayTonight: buildTodayTonight(inputs.briefing),
    exceptions: buildBusinessExceptions(inputs.briefing, inputs.actionItems, inputs.sourceRows),
    warnings: inputs.briefing.warnings,
  };
}
