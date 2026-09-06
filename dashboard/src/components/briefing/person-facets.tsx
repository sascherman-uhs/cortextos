/**
 * Person facets of the briefing snapshot — OS-04b.
 *
 * New file; never overwritten by upstream merges.
 *
 * The facets reaching this component have ALREADY been filtered on the server against
 * the `visible_to` stamp the composer wrote. Nothing here decides access; if a facet is
 * in the props, the viewer is allowed to read it. That separation is deliberate — an ACL
 * that lives partly in a React component is an ACL that will eventually be bypassed by a
 * new caller of the same data.
 *
 * The one rule this component does enforce is honesty about gaps: an `unavailable` facet
 * renders as a named, reasoned absence rather than being skipped, because a skipped
 * section reads as "nothing to report" and that is a different claim entirely.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconAlertTriangle, IconLock } from '@tabler/icons-react';
import { orderedFacets, BODY_FACET_ID, type BriefingFacet, type BriefingSnapshot } from '@/lib/uhs/briefing';

type Row = Record<string, unknown>;

function rows(facet: BriefingFacet, key: string): Row[] {
  const value = (facet.content ?? {})[key];
  return Array.isArray(value) ? (value as Row[]) : [];
}

function str(row: Row, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? '' : String(v);
}

function Table({ head, body }: { head: string[]; body: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="text-left font-medium py-1 pr-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-t border-border/50">
              {r.map((cell, j) => (
                <td key={j} className="py-1 pr-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FacetBody({ facet }: { facet: BriefingFacet }) {
  const content = (facet.content ?? {}) as Row;

  switch (facet.id) {
    case 'raquel_todo': {
      // Raquel's authoritative list, produced by scripts/raquel_todo.py and stored
      // verbatim in the snapshot. It is our own script's output, not third-party input,
      // and Vera's contract forbids restyling or reordering it.
      const html = String(content.html ?? '');
      return (
        <div
          className="briefing-verbatim text-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case 'raquel_quick_wins': {
      const items = rows(facet, 'items');
      if (items.length === 0) {
        return <p className="text-sm text-muted-foreground">Nothing short came off the list today.</p>;
      }
      return (
        <>
          <ul className="text-sm space-y-1">
            {items.map((i, k) => (
              <li key={k}>
                {str(i, 'title')}
                {str(i, 'due') && (
                  <span className="text-muted-foreground text-xs"> · due {str(i, 'due')}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground mt-2">{String(content.derivation ?? '')}</p>
        </>
      );
    }
    case 'blog_pipeline': {
      const upcoming = rows(facet, 'upcoming');
      const published = rows(facet, 'recent_published');
      return (
        <div className="space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Upcoming</p>
            {upcoming.length ? (
              <Table
                head={['Week', 'Post', 'Publish', 'Review due']}
                body={upcoming.map((r) => [
                  str(r, 'week'),
                  str(r, 'title'),
                  str(r, 'publish_date'),
                  str(r, 'review_due'),
                ])}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No upcoming posts.</p>
            )}
          </div>
          {published.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Recently published
              </p>
              <Table
                head={['Week', 'Post', 'Published']}
                body={published.map((r) => [str(r, 'week'), str(r, 'title'), str(r, 'publish_date')])}
              />
            </div>
          )}
        </div>
      );
    }
    case 'staging_schedule':
    case 'todays_focus': {
      const events = rows(facet, 'events');
      if (events.length === 0) {
        return (
          <p className="text-sm text-muted-foreground">
            {String(content.note ?? 'Nothing scheduled.')}
          </p>
        );
      }
      return (
        <Table
          head={['Event', 'When', 'Address']}
          body={events.map((e) => [str(e, 'summary'), str(e, 'start'), str(e, 'location')])}
        />
      );
    }
    case 'angelic_inbox': {
      const items = rows(facet, 'items');
      return (
        <div className="space-y-2">
          {items.length ? (
            <Table
              head={['From', 'Subject', 'Received']}
              body={items.map((i) => [str(i, 'from'), str(i, 'subject'), str(i, 'received_at')])}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No unread mail from a person in the last 24 hours.
            </p>
          )}
          {Number(content.clutter_count ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground">
              +{String(content.clutter_count)} in Other/clutter
            </p>
          )}
        </div>
      );
    }
    case 'angelic_tasks': {
      const items = rows(facet, 'items');
      if (items.length === 0) return <p className="text-sm text-muted-foreground">No pending tasks.</p>;
      return (
        <ul className="text-sm space-y-1">
          {items.map((i, k) => (
            <li key={k}>
              {str(i, 'title')}{' '}
              <Badge variant="outline" className="text-xs">
                {str(i, 'status') || 'pending'}
              </Badge>
            </li>
          ))}
        </ul>
      );
    }
    case 'design_tip':
      return (
        <div className="text-sm">
          <p className="font-medium">{String(content.title ?? '')}</p>
          <p className="text-muted-foreground">{String(content.text ?? '')}</p>
        </div>
      );
    default:
      return (
        <pre className="text-xs overflow-x-auto bg-muted/40 p-2 rounded">
          {JSON.stringify(facet.content, null, 1)}
        </pre>
      );
  }
}

export function PersonFacets({ snapshot }: { snapshot: BriefingSnapshot }) {
  const facets = orderedFacets(snapshot.facets ?? {}).filter(([id]) => id !== BODY_FACET_ID);

  if (facets.length === 0 && !snapshot.body_included) {
    return (
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <IconLock size={18} className="text-destructive" />
            Nothing in this snapshot is yours to see
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            That is an access outcome, not an empty morning. The briefing exists; this
            view of it is empty.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {facets.map(([id, facet]) => (
        <Card key={id} className={facet.status === 'ok' ? undefined : 'border-destructive'}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              {facet.status !== 'ok' && (
                <IconAlertTriangle size={16} className="text-destructive shrink-0" />
              )}
              {facet.title}
              {facet.status !== 'ok' && (
                <Badge variant="destructive" className="text-xs">
                  unavailable
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {facet.status === 'ok' ? (
              <FacetBody facet={facet} />
            ) : (
              <div className="space-y-1">
                <p className="text-sm">
                  {facet.unavailable_message ??
                    'This source did not answer. The content is unknown, not empty.'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Reason: {facet.error ?? 'not recorded'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {snapshot.withheld_facet_count > 0 && (
        <p className="text-xs text-muted-foreground">
          {snapshot.withheld_facet_count} section
          {snapshot.withheld_facet_count === 1 ? '' : 's'} of this briefing belong to
          someone else and were withheld.
        </p>
      )}
    </>
  );
}
