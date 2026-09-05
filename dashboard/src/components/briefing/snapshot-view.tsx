/**
 * Morning briefing snapshot view — OS-04.
 *
 * Renders ONE immutable snapshot: the six required sections in their required order,
 * plus the honesty furniture around them. Pure server-renderable component; all data
 * arrives as props from the page, so it cannot go stale on back/forward navigation.
 *
 * Three things this component exists to make impossible:
 *
 *   1. A degraded snapshot rendering as a clean one. If a feed was unavailable when the
 *      snapshot was composed, the banner says so above everything else, and the outcomes
 *      section carries its own "PARTIAL" note. A zero next to a dead source means
 *      "unknown", and the UI says that word.
 *   2. A stale snapshot passing as current. The freshness line states when the data was
 *      actually read, and anything past the deadline is labelled late.
 *   3. Counts you cannot check. Every count links into the Queue filtered at the
 *      snapshot's timestamp, so "6 completed" is one click from the six rows.
 */

import Link from 'next/link';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClock,
  IconDatabaseOff,
  IconExternalLink,
} from '@tabler/icons-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type {
  BriefingResult,
  BriefingSection,
  BriefingSectionItem,
  SectionId,
} from '@/lib/uhs/briefing';
import { REQUIRED_SECTIONS, snapshotAgeMinutes } from '@/lib/uhs/briefing';
import { PersonFacets } from './person-facets';

const SECTION_LABEL: Record<SectionId, string> = {
  decisions_for_scott: 'Decisions for you',
  verified_overnight_outcomes: 'Verified overnight outcomes',
  improvements: 'Improvements',
  exceptions_and_recovery: 'Exceptions and recovery',
  todays_commitments: "Today's commitments",
  tonights_work: "Tonight's work",
};

/** Where a section's count should take you to check it. */
function drilldownHref(id: SectionId, businessDate: string): string {
  const since = encodeURIComponent(businessDate);
  switch (id) {
    case 'verified_overnight_outcomes':
      return `/queue?status=completed&since=${since}`;
    case 'exceptions_and_recovery':
      return `/queue?status=failed&since=${since}`;
    case 'decisions_for_scott':
      return `/approvals?since=${since}`;
    case 'tonights_work':
      return `/queue?status=pending&since=${since}`;
    default:
      return `/queue?since=${since}`;
  }
}

function itemLabel(item: BriefingSectionItem): string {
  if (item.header) return item.header;
  if (item.title) return item.title;
  if (item.source) return `Source unavailable: ${item.source}`;
  return item.kind ?? 'item';
}

function ItemRow({ item }: { item: BriefingSectionItem }) {
  const detail = item.detail ?? item.error ?? item.evidence ?? null;
  return (
    <li className="border-l-2 border-border pl-3 py-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{itemLabel(item)}</span>
        {item.late_wrap_up && (
          <Badge variant="outline" className="text-xs">
            late wrap-up
          </Badge>
        )}
        {item.completion_time_inferred && (
          <Badge variant="outline" className="text-xs">
            failure time inferred
          </Badge>
        )}
        {item.owner && (
          <span className="text-xs text-muted-foreground">owner: {item.owner}</span>
        )}
      </div>
      {detail && <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>}
      {item.next_action && (
        <p className="text-xs mt-0.5">
          <span className="text-muted-foreground">Next: </span>
          {item.next_action}
        </p>
      )}
      {Array.isArray(item.lines) && item.lines.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {item.lines.slice(0, 12).map((line, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              {line}
            </li>
          ))}
          {item.lines.length > 12 && (
            <li className="text-xs text-muted-foreground italic">
              +{item.lines.length - 12} more
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function SectionCard({
  id,
  section,
  businessDate,
}: {
  id: SectionId;
  section: BriefingSection;
  businessDate: string;
}) {
  const degraded = section.status !== 'ok';
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{SECTION_LABEL[id]}</CardTitle>
        <div className="flex items-center gap-2">
          {degraded && (
            <Badge variant="destructive" className="text-xs">
              partial
            </Badge>
          )}
          <Link
            href={drilldownHref(id, businessDate)}
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            {section.count} {section.count === 1 ? 'item' : 'items'}
            <IconExternalLink size={12} />
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {section.note && (
          <p className="text-xs mb-2 text-warning-foreground">{section.note}</p>
        )}
        {section.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {degraded
              ? 'Nothing recorded — but this section is partial, so treat it as unknown rather than empty.'
              : 'Nothing here.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {section.items.map((item, i) => (
              <ItemRow key={i} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function SnapshotView({
  result,
  now = new Date(),
}: {
  result: BriefingResult;
  now?: Date;
}) {
  const { snapshot, origin, warnings, requestedDate } = result;

  if (!snapshot) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IconDatabaseOff size={18} className="text-destructive" />
            No briefing for {requestedDate}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">
            A briefing is missing, not empty. Nothing here should be read as a quiet
            night.
          </p>
          {warnings.length > 0 && (
            <ul className="text-xs text-muted-foreground space-y-1">
              {warnings.map((w, i) => (
                <li key={i}>· {w}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    );
  }

  const age = snapshotAgeMinutes(snapshot, now);
  const isMinimum = snapshot.labels?.minimum_snapshot === 'true';
  const changesSince =
    age !== null && age > 5
      ? `Anything that happened in the last ${age} minutes is not in this snapshot.`
      : null;

  return (
    <div className="space-y-4">
      {/* Freshness + degradation banner, above everything. */}
      <Card
        className={
          snapshot.degraded || isMinimum ? 'border-destructive' : 'border-border'
        }
      >
        <CardContent className="pt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {snapshot.degraded || isMinimum ? (
              <IconAlertTriangle size={16} className="text-destructive shrink-0" />
            ) : (
              <IconCircleCheck size={16} className="text-success shrink-0" />
            )}
            <span className="font-medium">
              {snapshot.business_date} · v{snapshot.version}
            </span>
            <Badge variant="outline" className="text-xs">
              {snapshot.state}
            </Badge>
            {origin === 'local_fallback' && (
              <Badge variant="destructive" className="text-xs">
                local fallback
              </Badge>
            )}
            {snapshot.missed_deadline && (
              <Badge variant="destructive" className="text-xs">
                published after the 05:30 deadline
              </Badge>
            )}
            {isMinimum && (
              <Badge variant="destructive" className="text-xs">
                minimum snapshot — composition failed
              </Badge>
            )}
          </div>

          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <IconClock size={12} />
            {snapshot.snapshot_cutoff
              ? `Data read at ${new Date(snapshot.snapshot_cutoff).toLocaleString()}`
              : 'Data read time not recorded'}
            {age !== null && ` · ${age} min ago`}
          </p>
          {changesSince && (
            <p className="text-xs text-muted-foreground">{changesSince}</p>
          )}

          {snapshot.degraded && (
            <div className="text-sm">
              <p className="font-medium text-destructive">
                Not an all-clear — {snapshot.degraded_reasons.length} source
                {snapshot.degraded_reasons.length === 1 ? '' : 's'} did not answer.
              </p>
              <ul className="text-xs text-muted-foreground mt-1 space-y-0.5">
                {snapshot.degraded_reasons.map((r, i) => (
                  <li key={i}>
                    · {r.source} ({r.status}){r.error ? ` — ${r.error}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>· {w}</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The six required sections are Scott's body, carried on an ACL-tagged facet.
          A persona view does not get a trimmed version of them — it does not get them.
          Rendering nothing here is the correct outcome, not a missing feature. */}
      {snapshot.body_included &&
        REQUIRED_SECTIONS.map((id) => (
          <SectionCard
            key={id}
            id={id}
            section={snapshot.sections[id]}
            businessDate={snapshot.business_date}
          />
        ))}

      <PersonFacets snapshot={snapshot} />
    </div>
  );
}
