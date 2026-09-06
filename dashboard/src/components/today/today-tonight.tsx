// === OS-03 — Today / Tonight: committed outcomes and proposed night work ===
// New file; never overwritten by upstream merges.

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { TodayTonightSection } from '@/lib/os03/today-view';

export function TodayTonight({ section }: { section: TodayTonightSection }) {
  return (
    <Card data-testid="today-tonight">
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Today and tonight
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!section.available ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <IconAlertTriangle size={18} className="text-destructive shrink-0 mt-0.5" aria-hidden />
            <span>{section.unavailableReason}</span>
          </div>
        ) : (
          section.groups.map((group) => (
            <div key={group.key} className="space-y-1.5" data-testid={`commitments-${group.key}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {group.title} ({group.count ?? 'unknown'})
                </p>
                <p className="text-xs text-muted-foreground">
                  {group.capacity ? `Capacity: ${group.capacity}` : 'Capacity not recorded'}
                </p>
              </div>
              {group.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{group.emptyLabel}</p>
              ) : (
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item.id} className="rounded-md border px-3 py-2 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">{item.outcome}</span>
                        {/* Proposed night work stays visibly proposed until its
                            authority requirements are satisfied (plan §3). */}
                        <Badge
                          variant={item.authority === 'proposed' ? 'outline' : 'secondary'}
                          className="text-[10px]"
                        >
                          {item.authority === 'proposed' ? 'Proposed' : 'Committed'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">Owner: </span>
                        {item.owner ?? <span className="italic">not recorded</span>}
                        {' · '}
                        <span className="font-medium text-foreground/70">Window: </span>
                        {item.window ?? <span className="italic">not recorded</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">Depends on: </span>
                        {item.dependencies.length > 0 ? (
                          item.dependencies.join(', ')
                        ) : (
                          <span className="italic">nothing recorded</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/70">Why it matters: </span>
                        {item.whyItMatters ?? <span className="italic">not recorded</span>}
                      </p>
                      {item.authorityNote && (
                        <p className="text-xs text-muted-foreground italic">{item.authorityNote}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
