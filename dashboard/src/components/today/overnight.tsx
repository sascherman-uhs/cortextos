// === OS-03 — Overnight: what finished, what failed, what changed ===
// New file; never overwritten by upstream merges.
//
// Every claim carries its class. "Tested locally" and "deployed" are different
// facts and this component never lets them render the same way.

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  OUTCOME_CLASS_LABEL,
  OUTCOME_CLASS_MEANING,
  type OvernightItem,
  type OvernightSection,
} from '@/lib/os03/today-view';

function ClassBadge({ item }: { item: OvernightItem }) {
  const variant = item.outcomeClass === 'unverified' ? 'outline' : 'secondary';
  return (
    <Badge variant={variant} className="text-[10px]" title={OUTCOME_CLASS_MEANING[item.outcomeClass]}>
      {OUTCOME_CLASS_LABEL[item.outcomeClass]}
    </Badge>
  );
}

export function Overnight({ section }: { section: OvernightSection }) {
  return (
    <Card data-testid="overnight">
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Overnight
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!section.available ? (
          <div
            className="flex items-start gap-2 text-sm text-muted-foreground"
            data-testid="overnight-unavailable"
          >
            <IconAlertTriangle size={18} className="text-destructive shrink-0 mt-0.5" aria-hidden />
            <span>{section.unavailableReason}</span>
          </div>
        ) : (
          section.groups.map((group) => (
            <div key={group.key} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {group.title}
                {group.count !== null ? ` (${group.count})` : ' (count unavailable)'}
              </p>
              {group.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{group.emptyLabel}</p>
              ) : (
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-md border px-3 py-2 space-y-1"
                      data-testid={`overnight-${group.key}-item`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm">{item.title}</span>
                        <ClassBadge item={item} />
                      </div>
                      {item.detail && (
                        <p className="text-xs text-muted-foreground">{item.detail}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {item.owner && <span>Owner: {item.owner}</span>}
                        {item.evidenceHref ? (
                          <Link
                            href={item.evidenceHref}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {item.evidenceText ? `Evidence: ${item.evidenceText}` : 'Open the evidence'}
                          </Link>
                        ) : (
                          <span className="italic">no evidence link recorded</span>
                        )}
                      </div>
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
