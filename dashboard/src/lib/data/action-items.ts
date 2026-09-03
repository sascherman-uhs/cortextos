// cortextOS Dashboard - Shared "needs attention" data
//
// Single source of truth for itemized human-tasks / pending-approvals /
// blocked-tasks / stale-agents, consumed by both the Overview page's
// ActionRequired card (counts) and the Queue page's Needs You lane (items).
// Do not fork this logic — see .planning/scratch/2026-09-03-unified-queue-plan-v7-FINAL.md.

import { getTasks } from './tasks';
import { getPendingApprovals } from './approvals';
import { getHealthSummary } from './heartbeats';
import type { Task, Approval, HealthSummary } from '@/lib/types';

// Matches core's checkHumanTasks()/checkStaleTasks() stale_human threshold
// (src/bus/task.ts) — 24h since creation. The dashboard's own human-task
// filter (getTasks({agent:'human'})) is broader than core's exact-match
// version (also matches title/project patterns) and previously had no
// staleness signal at all; this ports just the staleness gate as a per-item
// flag, not an inclusion filter, so existing counts on Overview don't shrink.
const STALE_HUMAN_MS = 24 * 60 * 60 * 1000;

export interface ActionItem {
  kind: 'human_task' | 'approval' | 'blocked_task' | 'stale_agent';
  id: string;
  title: string;
  subtitle?: string;
  href: string;
  stale?: boolean;
  createdAt?: string;
}

export interface ActionItems {
  humanTasks: ActionItem[];
  blockedTasks: ActionItem[];
  approvals: ActionItem[];
  staleAgents: ActionItem[];
  healthSummary: HealthSummary;
}

function isStaleHuman(task: Task): boolean {
  const created = new Date(task.created_at).getTime();
  if (Number.isNaN(created)) return false;
  return Date.now() - created > STALE_HUMAN_MS;
}

function humanTaskItem(task: Task): ActionItem {
  return {
    kind: 'human_task',
    id: task.id,
    title: task.title,
    subtitle: task.project ?? task.org,
    href: '/tasks?agent=human',
    stale: isStaleHuman(task),
    createdAt: task.created_at,
  };
}

function blockedTaskItem(task: Task): ActionItem {
  return {
    kind: 'blocked_task',
    id: task.id,
    title: task.title,
    subtitle: task.project ?? task.org,
    href: '/tasks?status=blocked',
    createdAt: task.created_at,
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
export async function getActionItems(org?: string): Promise<ActionItems> {
  const [humanTaskRows, blockedRows, approvalRows, healthSummary] = await Promise.all([
    Promise.resolve(getTasks({ agent: 'human', org })),
    Promise.resolve(getTasks({ status: 'blocked', org })),
    Promise.resolve(getPendingApprovals(org)),
    getHealthSummary(org),
  ]);

  const humanTasks = humanTaskRows
    .filter((t) => t.status !== 'completed')
    .map(humanTaskItem);

  const blockedTasks = blockedRows.map(blockedTaskItem);
  const approvals = approvalRows.map(approvalItem);

  const staleAgents: ActionItem[] = healthSummary.agents
    .filter((a) => a.health !== 'healthy')
    .map((a) => ({
      kind: 'stale_agent',
      id: a.agent,
      title: a.agent,
      subtitle: a.health === 'down' ? 'down' : 'stale',
      href: '/agents',
    }));

  return { humanTasks, blockedTasks, approvals, staleAgents, healthSummary };
}
