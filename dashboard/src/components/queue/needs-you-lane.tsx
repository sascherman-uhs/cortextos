'use client';

/**
 * Needs You lane — the "one glance, one place" card. Its count/list MUST
 * reflect every real blocker, including skill runs with a non-retryable
 * blocker (the ones SkillRunsCard badges "needs you" further down the
 * Recurring lane) — otherwise this card can say "all clear" while real,
 * badged blockers sit unmentioned below it. Reuses the exact same
 * /api/uhs/skill-runs endpoint and retryable-blocker rule SkillRunsCard
 * already uses, rather than forking a second definition of "blocked".
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  IconUser,
  IconShield,
  IconAlertTriangle,
  IconHeartOff,
  IconCircleCheck,
  IconClock,
  IconHandStop,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ActionItem } from '@/lib/data/action-items';
import type { SkillRun } from '@/components/uhs/skill-runs-card';

const KIND_ICON: Record<ActionItem['kind'], React.ReactNode> = {
  human_task: <IconUser size={16} className="text-primary shrink-0" />,
  approval: <IconShield size={16} className="text-primary shrink-0" />,
  blocked_task: <IconAlertTriangle size={16} className="text-warning shrink-0" />,
  stale_agent: <IconHeartOff size={16} className="text-destructive shrink-0" />,
  skill_run: <IconHandStop size={16} className="text-destructive shrink-0" />,
};

const KIND_LABEL: Record<ActionItem['kind'], string> = {
  human_task: 'Assigned to you',
  approval: 'Pending approval',
  blocked_task: 'Blocked',
  stale_agent: 'Stale agent',
  skill_run: 'Skill run blocked',
};

// A skill run counts as "needs you" using the same rule SkillRunsCard badges
// with — at least one blocker that isn't marked auto-retryable.
function skillRunsToActionItems(runs: SkillRun[]): ActionItem[] {
  const items: ActionItem[] = [];
  for (const run of runs) {
    const needsYou = (run.blockers ?? []).filter((b) => !b.retryable);
    if (needsYou.length === 0) continue;
    const first = needsYou[0];
    items.push({
      kind: 'skill_run',
      id: String(run.id),
      title: `${run.skill} / ${run.subject}`,
      subtitle: first.item + (first.reason ? ` — ${first.reason}` : ''),
      href: '/queue#recurring',
      createdAt: run.updated_at ?? run.started_at ?? undefined,
    });
  }
  return items;
}

interface NeedsYouLaneProps {
  humanTasks: ActionItem[];
  approvals: ActionItem[];
  blockedTasks: ActionItem[];
  staleAgents: ActionItem[];
}

function Row({ item }: { item: ActionItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-muted transition-colors group"
    >
      {KIND_ICON[item.kind]}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm truncate">{item.title}</span>
          {item.stale && (
            <Badge variant="destructive" className="h-4.5 px-1.5 text-[10px] gap-1">
              <IconClock size={10} />
              &gt;24h
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {KIND_LABEL[item.kind]}
          {item.subtitle ? ` · ${item.subtitle}` : ''}
        </div>
      </div>
    </Link>
  );
}

export function NeedsYouLane({ humanTasks, approvals, blockedTasks, staleAgents }: NeedsYouLaneProps) {
  const [skillRunItems, setSkillRunItems] = useState<ActionItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/uhs/skill-runs', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((data: SkillRun[]) => {
        if (!cancelled) setSkillRunItems(skillRunsToActionItems(Array.isArray(data) ? data : []));
      })
      .catch(() => {
        // Non-fatal — SkillRunsCard below will surface the same fetch failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const items = [...humanTasks, ...approvals, ...blockedTasks, ...staleAgents, ...skillRunItems];
  // Stale agents and blocked work (tasks + skill runs) surface above fresh human tasks.
  const sorted = [...items].sort((a, b) => {
    const weight = (i: ActionItem) =>
      i.kind === 'stale_agent' ? 0 : i.kind === 'blocked_task' || i.kind === 'skill_run' ? 1 : i.stale ? 2 : 3;
    return weight(a) - weight(b);
  });

  return (
    <Card className="bg-muted/40">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Needs You
        </CardTitle>
        {items.length > 0 && (
          <Badge variant="destructive">{items.length}</Badge>
        )}
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground py-1">
            <IconCircleCheck size={18} className="text-success" />
            <span className="text-sm">All clear - nothing needs your attention</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sorted.map((item) => (
              <Row key={`${item.kind}-${item.id}`} item={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
