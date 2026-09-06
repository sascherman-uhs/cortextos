// === OS-03 — one card on the work board ===
// New file; never overwritten by upstream merges.
//
// Card minimum per plan §3: title/outcome, project, priority, accountable
// agent AND human, due/next-action time, stage, blocker reason, last
// meaningful update, evidence indicator. Where the record holds none of a
// field, the card prints "not recorded" — a blank would read as "fine".

'use client';

import { Badge } from '@/components/ui/badge';
import { TimeAgo } from '@/components/shared';
import { COLUMN_LABEL, WAITING_SUBTYPE_LABEL, type BoardCard as CardModel } from '@/lib/os03/work-board';

const EVIDENCE_STYLE: Record<CardModel['evidence'], string> = {
  recorded: 'border-success/50',
  not_recorded: 'border-warning/60',
  not_applicable: 'border-border',
};

export function BoardCardView({
  card,
  focused,
  grabbed,
  onOpen,
}: {
  card: CardModel;
  focused?: boolean;
  grabbed?: boolean;
  onOpen?: (id: string) => void;
}) {
  const stage = card.state === 'waiting'
    ? `${COLUMN_LABEL.waiting} — ${WAITING_SUBTYPE_LABEL[card.waitingSubtype ?? 'unclassified']}`
    : COLUMN_LABEL[card.state];

  return (
    <article
      data-testid="board-card"
      data-task-id={card.id}
      data-state={card.state}
      data-focused={focused ? 'true' : undefined}
      data-grabbed={grabbed ? 'true' : undefined}
      aria-grabbed={grabbed ? 'true' : undefined}
      aria-label={`${card.title}. ${stage}. Priority ${card.priority}.`}
      tabIndex={focused ? 0 : -1}
      onClick={() => onOpen?.(card.id)}
      className={`cursor-pointer rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/50 ${
        EVIDENCE_STYLE[card.evidence]
      } ${focused ? 'ring-2 ring-primary' : ''} ${grabbed ? 'opacity-70 ring-2 ring-dashed ring-primary' : ''}`}
    >
      <p className="text-sm font-medium leading-snug">{card.title}</p>
      {card.outcome && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{card.outcome}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10px]">{card.priority}</Badge>
        <Badge variant="outline" className="font-mono text-[10px]">{card.nativeStatus}</Badge>
        <Badge variant="secondary" className="text-[10px]">{stage}</Badge>
        {card.unassignedRecovery && (
          <Badge variant="destructive" className="text-[10px]">no owner</Badge>
        )}
      </div>

      <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt className="font-medium text-foreground/70">Project:</dt>
          <dd>{card.project ?? <span className="italic">not recorded</span>}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground/70">Agent:</dt>
          <dd>{card.accountableAgent ?? <span className="italic">none</span>}</dd>
          <dt className="font-medium text-foreground/70">Human:</dt>
          <dd>
            {card.accountableHuman ?? <span className="italic">none</span>}
            {card.humanFromLegacyAlias && ' (legacy alias)'}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground/70">Due:</dt>
          <dd>{card.dueAt ?? <span className="italic">no due time recorded</span>}</dd>
        </div>
        {card.blockerReason && (
          <div className="flex gap-1">
            <dt className="font-medium text-foreground/70">Blocked by:</dt>
            <dd>{card.blockerReason}</dd>
          </div>
        )}
        <div className="flex items-center gap-1">
          <dt className="font-medium text-foreground/70">Last update:</dt>
          <dd>
            {card.lastUpdateAt ? (
              <TimeAgo date={card.lastUpdateAt} className="text-xs" />
            ) : (
              <span className="italic">never</span>
            )}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-foreground/70">Evidence:</dt>
          <dd data-testid="card-evidence">{card.evidenceLabel}</dd>
        </div>
      </dl>
    </article>
  );
}
