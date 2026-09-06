// === OS-03 / fix5 — the form a refused legacy move offers instead of a wall ===
// New file; never overwritten by upstream merges.
//
// 1,863 tasks were backfilled into the work contract from stores that predate
// it. None carries acceptance criteria, because nothing ever asked for them.
// Enforcing Ready's required fields on those records — correct on its own terms
// — meant a person could open the board, click Start on real work, and be told
// only that "backlog -> doing is not in the contract".
//
// This is the other half of that refusal. It states plainly what the record is
// missing, offers to take it now, and keeps the waiver as a clearly secondary
// option that has to be explained. Both paths are audited by the server; the
// difference between them is whether the task comes out of it better than it
// went in.
//
// What it deliberately does NOT do: pre-fill acceptance criteria with something
// plausible. Invented criteria would pass the Ready gate and then be checked off
// at completion, which is how a proof gate becomes a formality.
// === END header ===

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface LegacyPrompt {
  taskId: string;
  title: string;
  /** The lane the person was trying to reach. */
  to: string;
  toLabel: string;
  /** Contract fields the record does not carry: outcome | owner | acceptance_criteria. */
  missing: string[];
  /** Whether the server said these particular gaps may be waived. */
  waivable: boolean;
  /** The server's own sentence, shown verbatim so the UI cannot soften it. */
  message: string;
  /** Suggested outcome — the task's title, which is what the native store uses
   *  as the default outcome for ordinary work. Never a guessed criterion. */
  suggestedOutcome: string;
}

export interface LegacySubmission {
  fields?: {
    outcome?: string;
    acceptanceCriteria?: string[];
    humanAccountableId?: string;
  };
  grandfather?: { reason: string };
}

const FIELD_LABEL: Record<string, string> = {
  outcome: 'what done looks like',
  owner: 'who is accountable',
  acceptance_criteria: 'how anyone will know it worked',
};

export function LegacyWorkDialog({
  prompt,
  busy,
  onSubmit,
  onCancel,
}: {
  prompt: LegacyPrompt;
  busy: boolean;
  onSubmit: (submission: LegacySubmission) => void;
  onCancel: () => void;
}) {
  const [outcome, setOutcome] = useState(prompt.suggestedOutcome);
  const [criteria, setCriteria] = useState('');
  const [owner, setOwner] = useState('');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'supply' | 'waive'>('supply');
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => { firstFieldRef.current?.focus(); }, []);

  const needs = useMemo(() => new Set(prompt.missing), [prompt.missing]);
  const criteriaLines = criteria.split('\n').map((l) => l.trim()).filter(Boolean);

  const supplyComplete =
    (!needs.has('outcome') || outcome.trim().length > 0) &&
    (!needs.has('acceptance_criteria') || criteriaLines.length > 0) &&
    (!needs.has('owner') || owner.trim().length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="legacy-dialog-title"
      data-testid="legacy-work-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-lg">
        <h2 id="legacy-dialog-title" className="text-base font-semibold">
          This task predates the work contract
        </h2>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="legacy-dialog-message">
          {prompt.message}
        </p>
        <p className="mt-2 text-sm">
          Before <span className="font-medium">{prompt.title}</span> can move to{' '}
          <span className="font-medium">{prompt.toLabel}</span>, it needs{' '}
          {prompt.missing.map((m) => FIELD_LABEL[m] ?? m).join(' and ')}.
        </p>

        <div className="mt-4 flex gap-2 text-sm" role="radiogroup" aria-label="How to advance this task">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'supply'}
            data-testid="legacy-mode-supply"
            onClick={() => setMode('supply')}
            className={`rounded-md border px-3 py-1.5 ${mode === 'supply' ? 'border-primary bg-primary/10' : 'border-border'}`}
          >
            Fill it in now
          </button>
          {prompt.waivable && (
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'waive'}
              data-testid="legacy-mode-waive"
              onClick={() => setMode('waive')}
              className={`rounded-md border px-3 py-1.5 ${mode === 'waive' ? 'border-primary bg-primary/10' : 'border-border'}`}
            >
              Advance without it
            </button>
          )}
        </div>

        {mode === 'supply' ? (
          <div className="mt-4 space-y-3">
            {needs.has('outcome') && (
              <label className="block text-sm">
                <span className="font-medium">What does done look like?</span>
                <input
                  ref={(el) => { if (!firstFieldRef.current) firstFieldRef.current = el; }}
                  data-testid="legacy-outcome"
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
            )}
            {needs.has('acceptance_criteria') && (
              <label className="block text-sm">
                <span className="font-medium">How will anyone know it worked?</span>
                <span className="block text-xs text-muted-foreground">
                  One check per line. These are what has to pass before this task can be called done,
                  so write things someone else could verify.
                </span>
                <textarea
                  ref={(el) => { if (!firstFieldRef.current) firstFieldRef.current = el; }}
                  data-testid="legacy-criteria"
                  rows={4}
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
                />
              </label>
            )}
            {needs.has('owner') && (
              <label className="block text-sm">
                <span className="font-medium">Who is accountable for it?</span>
                <input
                  data-testid="legacy-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="scott"
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground">
              Saved with the move, on the record. From then on this task is judged like any other —
              it stops being legacy work.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="font-medium">Why is this moving without it?</span>
              <input
                data-testid="legacy-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Recorded against your name, with the fields that were missing. The task stays visibly
              marked, and it can still never be completed as verified without an artifact and a
              named verifier.
            </p>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="legacy-cancel"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm"
          >
            Leave it where it is
          </button>
          <button
            type="button"
            data-testid="legacy-submit"
            disabled={busy || (mode === 'supply' ? !supplyComplete : reason.trim().length === 0)}
            onClick={() =>
              onSubmit(
                mode === 'supply'
                  ? {
                      fields: {
                        ...(needs.has('outcome') ? { outcome: outcome.trim() } : {}),
                        ...(needs.has('acceptance_criteria') ? { acceptanceCriteria: criteriaLines } : {}),
                        ...(needs.has('owner') ? { humanAccountableId: owner.trim() } : {}),
                      },
                    }
                  : { grandfather: { reason: reason.trim() } },
              )
            }
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : mode === 'supply' ? `Save and move to ${prompt.toLabel}` : `Advance to ${prompt.toLabel} anyway`}
          </button>
        </div>
      </div>
    </div>
  );
}
