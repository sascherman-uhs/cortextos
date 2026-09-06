/**
 * Degraded-data banner.
 *
 * The Queue's job is to tell Scott the truth about his work. A source it cannot
 * read must therefore be louder than the lanes below it, because every one of
 * those lanes is rendering a partial picture while this is on screen. Nothing
 * on the page may show an "all clear" empty state while this banner is visible.
 */

import { IconAlertTriangle } from '@tabler/icons-react';
import { Card, CardContent } from '@/components/ui/card';
import type { DegradedSource } from '@/lib/data/action-items';

function ageLabel(lastGoodAt: string | null): string {
  if (!lastGoodAt) return 'never read successfully';
  const ms = Date.now() - new Date(lastGoodAt).getTime();
  if (!Number.isFinite(ms)) return `last good at ${lastGoodAt}`;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `showing data from ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `showing data from ${hours}h ago`;
  return `showing data from ${Math.floor(hours / 24)}d ago`;
}

const STATUS_WORD: Record<string, string> = {
  unavailable: 'could not be read',
  stale: 'is out of date',
  partial: 'was read incompletely',
};

export function DegradedBanner({ sources }: { sources: DegradedSource[] }) {
  if (sources.length === 0) return null;

  return (
    <Card
      role="alert"
      data-testid="degraded-banner"
      className="border-destructive bg-destructive/10"
    >
      <CardContent className="flex items-start gap-3 py-3">
        <IconAlertTriangle size={20} className="text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-destructive">
            {sources.length === 1
              ? 'One data source is degraded — this page is incomplete.'
              : `${sources.length} data sources are degraded — this page is incomplete.`}{' '}
            Counts and empty lanes below cannot be trusted.
          </p>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {sources.map((s) => (
              <li key={s.source} className="truncate">
                <span className="font-mono">{s.source}</span>{' '}
                {STATUS_WORD[s.status] ?? s.status} — {ageLabel(s.lastGoodAt)}
                {s.error ? ` · ${s.error}` : ''}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
