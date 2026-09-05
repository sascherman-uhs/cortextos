/**
 * Recovery lane — the Waiting column of the work board.
 *
 * Holds every non-terminal row the shared projector puts in the waiting lane:
 * blocked, failed, and any status this build does not recognise. None of these
 * appeared anywhere on the Queue before: the page fetched only in_progress and
 * pending, so failed and blocked work was invisible on the one screen whose
 * entire purpose is showing what needs recovery.
 *
 * Rows are grouped by the contract's waiting subtype (human / retry /
 * dependency / external / unclassified) so a row that nobody has classified is
 * visibly unclassified rather than quietly filed as something it is not.
 */

import Link from 'next/link';
import { IconAlertTriangle, IconRefresh, IconUserQuestion, IconHelpHexagon } from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { ActionItem } from '@/lib/data/action-items';

const SUBTYPE_ORDER = ['human', 'retry', 'dependency', 'external', 'unclassified'] as const;

const SUBTYPE_HEADING: Record<string, string> = {
  human: 'Waiting on a human decision',
  retry: 'Waiting on automatic recovery',
  dependency: 'Waiting on a dependency',
  external: 'Waiting on an external party',
  unclassified: 'Unclassified recovery',
};

interface RecoveryLaneProps {
  title: string;
  items: ActionItem[];
  emptyLabel: string;
  /** True when a source behind this lane is degraded. An empty lane then means
   *  "unknown", and must never render as "nothing to recover". */
  degraded?: boolean;
  grouped?: boolean;
}

function Row({ item }: { item: ActionItem }) {
  const icon =
    item.kind === 'unassigned_task' ? (
      <IconUserQuestion size={16} className="text-warning shrink-0" />
    ) : item.waitingSubtype === 'retry' ? (
      <IconRefresh size={16} className="text-warning shrink-0" />
    ) : item.waitingSubtype === 'unclassified' ? (
      <IconHelpHexagon size={16} className="text-warning shrink-0" />
    ) : (
      <IconAlertTriangle size={16} className="text-destructive shrink-0" />
    );

  return (
    <Link
      href={item.href}
      data-testid="recovery-row"
      className="flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-muted transition-colors"
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm truncate">{item.title}</span>
          {item.status && (
            // Always show the source's own word for the state. A lane label is
            // a projection; this is what the owning store actually says.
            <Badge variant="outline" className="h-4.5 px-1.5 text-[10px] font-mono">
              {item.status}
            </Badge>
          )}
          {item.legacyAlias && (
            <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">
              legacy alias
            </Badge>
          )}
        </div>
        {item.subtitle && (
          <div className="text-xs text-muted-foreground truncate">{item.subtitle}</div>
        )}
      </div>
      {item.ownerLabel && (
        <span className="text-xs text-muted-foreground shrink-0">{item.ownerLabel}</span>
      )}
    </Link>
  );
}

export function RecoveryLane({
  title,
  items,
  emptyLabel,
  degraded = false,
  grouped = false,
}: RecoveryLaneProps) {
  const groups = grouped
    ? SUBTYPE_ORDER.map((k) => ({
        key: k,
        heading: SUBTYPE_HEADING[k],
        rows: items.filter((i) => (i.waitingSubtype ?? 'unclassified') === k),
      })).filter((g) => g.rows.length > 0)
    : [{ key: 'all', heading: null, rows: items }];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
        {items.length > 0 && <Badge variant="destructive">{items.length}</Badge>}
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-1">
            {degraded
              ? 'Unknown — a source behind this lane could not be read. See the banner above.'
              : emptyLabel}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.key} className="space-y-0.5">
                {g.heading && (
                  <p className="text-xs font-medium text-muted-foreground px-2.5">
                    {g.heading} ({g.rows.length})
                  </p>
                )}
                {g.rows.map((item) => (
                  <Row key={`${item.kind}-${item.id}`} item={item} />
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
