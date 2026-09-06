import {
  byState,
  cycleSummary,
  NEGATIVE_STATES,
  outcomeTally,
  reachedNobody,
  STATE_LABEL,
  verifiedIndependently,
  type Improvement,
  type ImprovementEvent,
  type KaizenCycle,
} from '@/lib/uhs/improvements';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// ---------------------------------------------------------------------------
// The Improvements view: problem -> experiment -> reviewed -> built/tested ->
// released -> measured outcome, INCLUDING what was rejected or reverted.
//
// New files under components/improvements/, using the existing card/badge tokens rather
// than a new visual language.
//
// The design decision worth stating: reverted and rejected work is rendered with the
// same weight as retained work, not tucked into a collapsed "archive". A reader
// scanning this page should be able to tell within a few seconds whether the loop is
// actually rejecting anything, because a loop that never rejects is not reviewing.
// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function MeasurementLine({ item }: { item: Improvement }) {
  const m = item.measurement;
  if (!m) {
    return (
      <p className="text-sm text-muted-foreground">
        Not measured yet — no outcome is being claimed.
      </p>
    );
  }
  const independent = verifiedIndependently(item);
  return (
    <div className="space-y-1">
      <p className="text-sm">
        <span className="font-medium">{m.metric}</span>: {String(m.before)} →{' '}
        {String(m.after)}
        {m.verdict ? <> · {m.verdict}</> : null}
      </p>
      <p className="text-xs text-muted-foreground">
        {independent ? (
          <>Verified by {m.verified_by}, who did not author it.</>
        ) : (
          <>
            Not independently verified — {item.author} authored this and no separate
            verifier is recorded. Treat the number as unconfirmed.
          </>
        )}
      </p>
    </div>
  );
}

function Timeline({ events }: { events: ImprovementEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ol className="mt-3 space-y-1 border-l pl-3 text-xs text-muted-foreground">
      {events.map((e) => (
        <li key={e.id}>
          <span className="font-medium text-foreground">{STATE_LABEL[
            e.to_state as keyof typeof STATE_LABEL
          ] ?? e.to_state}</span>
          {' · '}
          {e.actor}
          {e.reason ? ` · ${e.reason}` : ''}
          {' · '}
          <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time>
        </li>
      ))}
    </ol>
  );
}

function ImprovementCard({
  item,
  events,
}: {
  item: Improvement;
  events: ImprovementEvent[];
}) {
  const negative = NEGATIVE_STATES.includes(item.state);
  return (
    <Card className={negative ? 'border-dashed' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{item.title}</CardTitle>
          <Badge variant={negative ? 'outline' : 'secondary'}>
            {STATE_LABEL[item.state] ?? item.state}
          </Badge>
          {item.risk_class !== 'internal' ? (
            <Badge variant="outline">{item.risk_class.replace('_', ' ')}</Badge>
          ) : null}
          {item.role ? <Badge variant="outline">{item.role}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{item.problem}</p>
        <dl className="space-y-1">
          <Field label="Hypothesis">{item.hypothesis}</Field>
          <Field label="Baseline">
            {item.baseline
              ? `${String(item.baseline.metric ?? '—')} = ${String(item.baseline.value ?? '—')}`
              : null}
          </Field>
          <Field label="Target metric">{item.target_metric}</Field>
          <Field label="Author / reviewer">
            {item.author}
            {item.reviewer ? ` / ${item.reviewer}` : ' / not yet reviewed'}
          </Field>
          <Field label="Rollback">{item.rollback_method}</Field>
          <Field label="Stop condition">{item.stop_condition}</Field>
        </dl>
        <MeasurementLine item={item} />
        <Timeline events={events} />
      </CardContent>
    </Card>
  );
}

export function CycleStrip({ cycles }: { cycles: KaizenCycle[] }) {
  if (cycles.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Kaizen cycle records yet. The dispatcher writes its record before its first
        send, so an absent record means no cycle has run — not that a cycle ran quietly.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {cycles.map((c) => {
        const dead = reachedNobody(c);
        return (
          <li
            key={c.cycle_id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            <span className="font-medium">{c.cycle_id}</span>
            <span className="text-muted-foreground">{cycleSummary(c)}</span>
            {dead ? (
              <Badge variant="destructive">reached nobody</Badge>
            ) : (
              <Badge variant="outline">{c.status}</Badge>
            )}
            {c.excluded?.length ? (
              <span className="text-xs text-muted-foreground">
                {c.excluded.length} excluded with reasons
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ImprovementPipeline({
  improvements,
  events,
}: {
  improvements: Improvement[];
  events: Record<number, ImprovementEvent[]>;
}) {
  const tally = outcomeTally(improvements);
  const columns = byState(improvements).filter((c) => c.items.length > 0);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        {tally.retained} retained · {tally.reverted} reverted · {tally.rejected} rejected
        · {tally.inFlight} in flight.{' '}
        {tally.reverted + tally.rejected === 0 && improvements.length > 0
          ? 'Nothing has been rejected or reverted yet, which is worth a second look — a review that never says no is not a review.'
          : null}
      </p>

      {columns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No improvements recorded. Reporting no safe or useful change is a valid
          outcome; manufacturing one to fill the page is not.
        </p>
      ) : (
        columns.map((col) => (
          <section key={col.state} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {col.label} ({col.items.length})
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {col.items.map((item) => (
                <ImprovementCard
                  key={item.id}
                  item={item}
                  events={events[item.id] ?? []}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
