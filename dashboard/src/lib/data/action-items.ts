// cortextOS Dashboard - Shared "needs attention" data
//
// Single source of truth for itemized human-tasks / pending-approvals /
// blocked-tasks / stale-agents, consumed by both the Overview page's
// ActionRequired card (counts) and the Queue page's Needs You lane (items).
// Do not fork this logic — see .planning/scratch/2026-09-03-unified-queue-plan-v7-FINAL.md.

import {
  getPersonTasksEnvelope,
  getRecoveryTasksEnvelope,
  getUnassignedRecoveryEnvelope,
  type ProjectedTask,
} from './tasks';
import { getPendingApprovals } from './approvals';
import { getHealthSummary } from './heartbeats';
import { getBlockedSkillRunsEnvelope } from './skill-runs';
import {
  getSourceHealth,
  isDegraded,
  type SourceEnvelope,
  type SourceHealthRow,
} from './source-health';
import { personDisplay, type WaitingSubtype } from './task-projection';
import type { Task, Approval, HealthSummary } from '@/lib/types';
import type { SkillRun } from '@/components/uhs/skill-runs-card';

// Matches core's checkHumanTasks()/checkStaleTasks() stale_human threshold
// (src/bus/task.ts) — 24h since creation. The dashboard's own human-task
// filter (getTasks({agent:'human'})) is broader than core's exact-match
// version (also matches title/project patterns) and previously had no
// staleness signal at all; this ports just the staleness gate as a per-item
// flag, not an inclusion filter, so existing counts on Overview don't shrink.
const STALE_HUMAN_MS = 24 * 60 * 60 * 1000;

export interface ActionItem {
  kind:
    | 'human_task'
    | 'approval'
    | 'blocked_task'
    | 'stale_agent'
    | 'skill_run'
    | 'failed_task'
    | 'unassigned_task';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  stale?: boolean;
  createdAt?: string;
  /** Native source status, preserved. Shown so a row never hides behind a lane name. */
  status?: string;
  /** Waiting subtype from the shared contract: human | retry | dependency | external | unclassified. */
  waitingSubtype?: WaitingSubtype | null;
  /** Identity came from a legacy alias, not a stated name. Surfaced, not hidden. */
  legacyAlias?: boolean;
  ownerLabel?: string | null;
}

/** Roll-up of every source behind this page, for the degraded banner. */
export interface DegradedSource {
  source: string;
  status: string;
  error: string | null;
  lastGoodAt: string | null;
}

export interface ActionItems {
  humanTasks: ActionItem[];
  blockedTasks: ActionItem[];
  /** Non-terminal rows the projector puts in the waiting lane (blocked, failed,
   *  and unrecognised statuses), split out from the human-decision items. */
  recoveryTasks: ActionItem[];
  /** Non-terminal rows with no routable owner. Never silently skipped. */
  unassignedTasks: ActionItem[];
  /** Non-empty when any source behind this page is not fresh. The UI must show
   *  a banner and must NOT render an all-clear while this has entries. */
  degradedSources: DegradedSource[];
  approvals: ActionItem[];
  staleAgents: ActionItem[];
  // Skill runs with at least one non-retryable blocker — same rule
  // SkillRunsCard badges "needs you" with. Computed here (not just fetched
  // client-side by one page) so Overview and Queue can't disagree about
  // whether something needs attention (bug: 2026-09-03 round 2 — Overview
  // showed "Blocked: 0" / "Queue clear" while Queue correctly showed 7).
  blockedSkillRuns: ActionItem[];
  healthSummary: HealthSummary;
}

function isNonRetryable(run: SkillRun): boolean {
  return (run.blockers ?? []).some((b) => !b.retryable);
}

function skillRunItem(run: SkillRun): ActionItem {
  const blockers = (run.blockers ?? []).filter((b) => !b.retryable);
  const first = blockers[0];
  return {
    kind: 'skill_run',
    id: String(run.id),
    title: `${run.skill} / ${run.subject}`,
    subtitle: first ? first.item + (first.reason ? ` — ${first.reason}` : '') : undefined,
    href: '/queue#recurring',
    createdAt: run.updated_at ?? run.started_at ?? undefined,
  };
}

function isStaleHuman(task: Task): boolean {
  const created = new Date(task.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return Date.now() - created > STALE_HUMAN_MS;
}

function humanTaskItem(task: ProjectedTask): ActionItem {
  const p = task.projection;
  return {
    kind: 'human_task',
    id: task.id,
    title: task.title,
    subtitle: task.project ?? task.org,
    href: `/tasks?person=${p.person ?? 'scott'}`,
    stale: isStaleHuman(task),
    createdAt: task.created_at,
    status: p.status,
    waitingSubtype: p.waiting_subtype,
    legacyAlias: p.legacy_alias,
    ownerLabel: personDisplay(p.person),
  };
}

const SUBTYPE_LABEL: Record<WaitingSubtype, string> = {
  human: 'Waiting on a decision',
  retry: 'Waiting on retry',
  dependency: 'Waiting on a dependency',
  external: 'Waiting on an external party',
  unclassified: 'Unclassified recovery',
};

function recoveryItem(task: ProjectedTask): ActionItem {
  const p = task.projection;
  const subtype = p.waiting_subtype ?? 'unclassified';
  return {
    // A failed row reads as a failure, not as a generic block.
    kind: p.status === 'failed' ? 'failed_task' : 'blocked_task',
    id: task.id,
    title: task.title,
    subtitle: `${SUBTYPE_LABEL[subtype]} · ${task.project ?? task.org}`,
    href: `/tasks?status=${encodeURIComponent(p.status)}`,
    createdAt: task.created_at,
    status: p.status,
    waitingSubtype: subtype,
    ownerLabel: personDisplay(p.person) ?? task.assignee ?? null,
  };
}

function unassignedItem(task: ProjectedTask): ActionItem {
  const p = task.projection;
  const why =
    p.owner_kind === 'ambiguous'
      ? `ambiguous owner "${task.assignee}"`
      : p.owner_kind === 'unknown'
        ? `unrecognised owner "${task.assignee}"`
        : 'no owner assigned';
  return {
    kind: 'unassigned_task',
    id: task.id,
    title: task.title,
    subtitle: `${why} · ${task.project ?? task.org}`,
    href: '/tasks?unassigned=1',
    createdAt: task.created_at,
    status: p.status,
    ownerLabel: null,
  };
}

function approvalItem(approval: Approval): ActionItem {
  return {
    kind: 'approval',
    id: approval.id,
    title: approval.title,
    subtitle: approval.category,
    href: '/approvals',
    createdAt: approval.created_at,
  };
}

/**
 * Get itemized "needs attention" data for an org (or all orgs if omitted).
 * Also returns the raw health summary so callers that need it (Overview's
 * SystemHealth/MetricCards) don't have to re-fetch heartbeats separately.
 */
function degradedFrom(
  envelopes: SourceEnvelope<unknown>[],
  healthRows: SourceHealthRow[],
): DegradedSource[] {
  const out: DegradedSource[] = [];
  for (const env of envelopes) {
    if (isDegraded(env)) {
      out.push({
        source: env.source,
        status: env.status,
        error: env.error,
        lastGoodAt: env.last_good_at ?? null,
      });
    }
  }
  // Sources this process does not fetch itself (the JARVIS Python projector's
  // Supabase and CortexOS task syncs) report through the source_health table.
  for (const row of healthRows) {
    if (row.status !== 'fresh') {
      out.push({
        source: row.source,
        status: row.status,
        error: row.error,
        lastGoodAt: row.last_good_at,
      });
    }
  }
  return out;
}

/**
 * Get itemized "needs attention" data for an org (or all orgs if omitted).
 * Also returns the raw health summary so callers that need it (Overview's
 * SystemHealth/MetricCards) don't have to re-fetch heartbeats separately.
 *
 * Every list here is accompanied by degradedSources. A caller that renders an
 * empty state MUST check it: an empty list with a degraded source means "we
 * could not read this", which is the opposite of "nothing needs you".
 */
export async function getActionItems(org?: string): Promise<ActionItems> {
  const [scottEnv, recoveryEnv, unassignedEnv, approvalRows, healthSummary, skillRunEnv] =
    await Promise.all([
      Promise.resolve(getPersonTasksEnvelope('scott', org)),
      Promise.resolve(getRecoveryTasksEnvelope(org)),
      Promise.resolve(getUnassignedRecoveryEnvelope(org)),
      Promise.resolve(getPendingApprovals(org)),
      getHealthSummary(org),
      getBlockedSkillRunsEnvelope(),
    ]);

  // Scott's own queue. The old predicate matched assignee IN ('human','user')
  // only, so every row Supabase assigned to 'scott' was invisible here.
  const humanTasks = scottEnv.data
    .filter((t) => t.projection.status !== 'completed')
    .map(humanTaskItem);

  // Recovery: blocked, failed, and any status this build does not recognise.
  // Rows already listed under Scott's queue are not repeated.
  const scottIds = new Set(humanTasks.map((i) => i.id));
  const recoveryTasks = recoveryEnv.data
    .filter((t) => !scottIds.has(t.id))
    .map(recoveryItem);

  // Kept for existing callers: the human-decision slice of recovery.
  const blockedTasks = recoveryTasks.filter((i) => i.waitingSubtype === 'human');

  const unassignedTasks = unassignedEnv.data
    .filter((t) => !scottIds.has(t.id))
    .map(unassignedItem);

  const approvals = approvalRows.map(approvalItem);
  // Skill runs aren't org-scoped (uhs-jarvis skill_runs is a single shared
  // table), so they show under every org filter — same as they already do
  // via SkillRunsCard elsewhere on both pages.
  const blockedSkillRuns = skillRunEnv.data.filter(isNonRetryable).map(skillRunItem);

  const staleAgents: ActionItem[] = healthSummary.agents
    .filter((a) => a.health !== 'healthy')
    .map((a) => ({
      kind: 'stale_agent',
      id: a.agent,
      title: a.agent,
      subtitle: a.health === 'down' ? 'down' : 'stale',
      href: '/agents',
    }));

  const degradedSources = degradedFrom(
    [scottEnv, recoveryEnv, unassignedEnv, skillRunEnv],
    getSourceHealth(),
  );

  return {
    humanTasks,
    blockedTasks,
    recoveryTasks,
    unassignedTasks,
    approvals,
    staleAgents,
    blockedSkillRuns,
    degradedSources,
    healthSummary,
  };
}
