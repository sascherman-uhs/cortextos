// === OS-03 — "Needs Scott": the decision list Today opens with ===
// New file; never overwritten by upstream merges.
//
// Each row carries the question, the business impact, the recommendation, the
// deadline, the source item and a link to the thing being decided on. Where a
// record does not state one of those, the row says so rather than leaving a
// confident blank.

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import {
  OWNER_FILTERS,
  type DecisionItem,
  type NeedsScottSection,
  type OwnerFilterKey,
} from '@/lib/os03/today-view';

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground/70">{label}: </span>
      {value ?? <span className="italic">not recorded</span>}
    </p>
  );
}

function DecisionRow({ item }: { item: DecisionItem }) {
  return (
    <li className="rounded-md border p-3 space-y-1.5" data-testid="decision-row">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium leading-snug">{item.question}</p>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {item.owner}
        </Badge>
      </div>
      <Field label="Business impact" value={item.businessImpact} />
      <Field label="Recommendation" value={item.recommendation} />
      <Field label="Deadline" value={item.deadline} />
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <span className="text-xs text-muted-foreground">Source: {item.sourceItem}</span>
        <Link
          href={item.href}
          className="text-xs underline underline-offset-2 hover:text-foreground"
        >
          Open the record
        </Link>
      </div>
    </li>
  );
}

export function NeedsScott({
  section,
  basePath = '/',
  extraQuery = '',
}: {
  section: NeedsScottSection;
  /** Path the owner filter links to. The filter is a URL parameter so the
   *  server re-renders the section rather than the browser hiding rows. */
  basePath?: string;
  /** Already-encoded extra query string to preserve (e.g. "org=uhs"). */
  extraQuery?: string;
}) {
  const ownerHref = (owner: OwnerFilterKey) =>
    `${basePath}?owner=${owner}${extraQuery ? `&${extraQuery}` : ''}`;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? section.items : section.visible;

  return (
    <Card data-testid="needs-scott">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Needs Scott
          </CardTitle>
          <p className="text-xs text-muted-foreground" data-testid="needs-scott-estimate">
            {section.total === null ? (
              'Count unavailable — a source could not be read'
            ) : (
              <>
                {section.total} decision{section.total === 1 ? '' : 's'} ·{' '}
                about {section.estimatedMinutes} min to review ({section.estimateBasis})
              </>
            )}
          </p>
        </div>
        <nav aria-label="Whose responsibility" className="flex flex-wrap gap-1.5">
          {OWNER_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={ownerHref(f.key)}
              title={f.description}
              aria-current={section.ownerFilter === f.key ? 'true' : undefined}
              data-testid={`needs-owner-${f.key}`}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${
                section.ownerFilter === f.key
                  ? 'bg-muted font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
            {section.degraded ? (
              <IconAlertTriangle size={18} className="text-destructive" aria-hidden />
            ) : (
              <IconCircleCheck size={18} className="text-success" aria-hidden />
            )}
            <span>{section.emptyLabel}</span>
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {shown.map((item) => (
                <DecisionRow key={item.id} item={item} />
              ))}
            </ul>
            {section.hiddenCount > 0 && !expanded && (
              <button
                type="button"
                data-testid="needs-scott-more"
                onClick={() => setExpanded(true)}
                className="mt-2 text-xs underline underline-offset-2"
              >
                Show the other {section.hiddenCount}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
