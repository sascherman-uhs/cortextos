// === OS-03 — the card detail drawer ===
// New file; never overwritten by upstream merges.
//
// Plan §3 detail drawer: brief, acceptance criteria, dependencies, source,
// execution attempts, event timeline, approval history, changed artifacts,
// test results, next action. Every one of those is a labelled row; the ones
// the record does not carry say so instead of vanishing, because a missing
// acceptance criterion is a fact about the task, not an absence of UI.

'use client';

import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { IconX } from '@tabler/icons-react';
import type { BoardCard } from '@/lib/os03/work-board';
import { COLUMN_LABEL } from '@/lib/os03/work-board';

export interface DrawerDetail {
  brief: string | null;
  acceptanceCriteria: string[];
  dependencies: string[];
  source: string | null;
  eventTimeline: { at: string | null; text: string }[];
  approvalHistory: { at: string | null; actor: string; decision: string }[];
  changedArtifacts: { label: string; href: string | null }[];
  testResults: string | null;
  nextAction: string | null;
}

export function emptyDetail(): DrawerDetail {
  return {
    brief: null,
    acceptanceCriteria: [],
    dependencies: [],
    source: null,
    eventTimeline: [],
    approvalHistory: [],
    changedArtifacts: [],
    testResults: null,
    nextAction: null,
  };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t py-2 first:border-t-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm">{children}</div>
    </div>
  );
}

const NOT_RECORDED = <span className="text-sm italic text-muted-foreground">not recorded</span>;

export function TaskDrawer({
  card,
  detail,
  loading,
  error,
  onClose,
}: {
  card: BoardCard | null;
  detail: DrawerDetail | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the drawer when it opens, and Escape closes it. Focus is
  // restored by the board, which remembers which card was focused.
  useEffect(() => {
    if (card) closeRef.current?.focus();
  }, [card]);

  useEffect(() => {
    if (!card) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, onClose]);

  if (!card) return null;
  const d = detail ?? emptyDetail();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Details for ${card.title}`}
      data-testid="task-drawer"
      className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l bg-background p-4 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-snug">{card.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">{COLUMN_LABEL[card.state]}</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">{card.nativeStatus}</Badge>
            <Badge variant="outline" className="text-[10px]">{card.priority}</Badge>
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close details"
          data-testid="drawer-close"
          className="rounded-md p-1 hover:bg-muted"
        >
          <IconX size={18} />
        </button>
      </div>

      {loading && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="drawer-loading">
          Loading the full record…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive" data-testid="drawer-error">
          {error}
        </p>
      )}

      <div className="mt-3">
        <Row label="Brief">{d.brief ?? card.outcome ?? NOT_RECORDED}</Row>
        <Row label="Acceptance criteria">
          {d.acceptanceCriteria.length > 0 ? (
            <ul className="list-disc pl-4">
              {d.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}
            </ul>
          ) : (
            <span className="text-sm italic text-muted-foreground">
              none recorded — this task cannot enter Ready until it has some
            </span>
          )}
        </Row>
        <Row label="Dependencies">
          {d.dependencies.length > 0 ? d.dependencies.join(', ') : NOT_RECORDED}
        </Row>
        <Row label="Source">{d.source ?? `${card.source} · ${card.id}`}</Row>
        <Row label="Execution attempts">
          {card.attempts.length === 0 ? (
            NOT_RECORDED
          ) : (
            <ul className="space-y-1" data-testid="drawer-attempts">
              {card.attempts.map((a) => (
                <li key={a.id} className="text-sm">
                  <Badge variant="outline" className="mr-1.5 text-[10px]">{a.status}</Badge>
                  {a.at ?? 'time not recorded'}
                  {a.detail ? ` — ${a.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Event timeline">
          {d.eventTimeline.length > 0 ? (
            <ul className="space-y-1">
              {d.eventTimeline.map((e, i) => (
                <li key={i} className="text-sm text-muted-foreground">
                  {e.at ?? 'time not recorded'} — {e.text}
                </li>
              ))}
            </ul>
          ) : NOT_RECORDED}
        </Row>
        <Row label="Approval history">
          {d.approvalHistory.length > 0 ? (
            <ul className="space-y-1">
              {d.approvalHistory.map((a, i) => (
                <li key={i} className="text-sm">
                  {a.decision} by {a.actor} {a.at ? `at ${a.at}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm italic text-muted-foreground">
              no approval has been requested or granted for this task
            </span>
          )}
        </Row>
        <Row label="Changed artifacts">
          {d.changedArtifacts.length > 0 ? (
            <ul className="space-y-1">
              {d.changedArtifacts.map((a) => (
                <li key={a.label} className="text-sm">
                  {a.href ? <a href={a.href} className="underline underline-offset-2">{a.label}</a> : a.label}
                </li>
              ))}
            </ul>
          ) : NOT_RECORDED}
        </Row>
        <Row label="Test results">{d.testResults ?? NOT_RECORDED}</Row>
        <Row label="Evidence">{card.evidenceLabel}</Row>
        <Row label="Next action">{d.nextAction ?? NOT_RECORDED}</Row>
      </div>
    </div>
  );
}
