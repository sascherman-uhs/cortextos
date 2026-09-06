// === OS-03 — Today's top line ===
// New file; never overwritten by upstream merges.

import { IconAlertTriangle, IconCircleCheck, IconClockExclamation } from '@tabler/icons-react';
import { Card, CardContent } from '@/components/ui/card';
import { DegradedBanner } from '@/components/queue/degraded-banner';
import type { TodayHeader as HeaderModel } from '@/lib/os03/today-view';

const STATUS_STYLE: Record<HeaderModel['overallStatus'], string> = {
  clear: 'border-success/40 bg-success/5',
  attention: 'border-primary/40 bg-primary/5',
  degraded: 'border-destructive bg-destructive/10',
};

export function TodayHeader({ header }: { header: HeaderModel }) {
  const Icon =
    header.overallStatus === 'degraded'
      ? IconAlertTriangle
      : header.overallStatus === 'attention'
        ? IconClockExclamation
        : IconCircleCheck;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
          <p className="text-sm text-muted-foreground" data-testid="today-datetime">
            {header.businessDate} · {header.businessTime} {header.timezoneLabel}
          </p>
        </div>
        <p
          className="text-xs text-muted-foreground max-w-sm sm:text-right"
          data-testid="today-freshness"
        >
          {header.freshness.label}
        </p>
      </div>

      {/* Status is stated in words as well as colour — colour is never the only
          signal (plan §3). */}
      <Card className={STATUS_STYLE[header.overallStatus]} data-testid="today-status">
        <CardContent className="flex items-start gap-3 py-3">
          <Icon size={20} className="shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">{header.statusLabel}</p>
            {header.freshness.state !== 'fresh' && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {header.freshness.state === 'missing'
                  ? 'No snapshot for this business date.'
                  : 'This snapshot is older than four hours.'}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <DegradedBanner sources={header.degradedSources} />
    </div>
  );
}
