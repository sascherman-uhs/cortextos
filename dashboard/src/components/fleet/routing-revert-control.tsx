'use client';

/**
 * The one Revert control.
 *
 * There used to be two, and they disagreed. The control on the fresh in-session
 * receipt fired immediately on a single click, submitting a canned reason the
 * operator had never read; the control in the operation history opened a form
 * and required a typed reason. fix3 deliberately made revert take an
 * operator-supplied reason, so the receipt control was the one that was wrong —
 * a one-click revert with an auto-filled justification records a decision
 * nobody made.
 *
 * Both surfaces now render this component: click Revert, see the reason
 * prefilled the same way, edit it, confirm. Confirm stays disabled while the
 * reason is empty, so the reason cannot be blanked into the receipt either.
 */

import { Button } from '@/components/ui/button';

export interface RevertControlProps {
  /** Unique per operation — two controls must not share an input id. */
  operationId: string;
  /** True while this control's reason form is open. */
  editing: boolean;
  reason: string;
  /** False when this operation cannot be reverted at all. */
  revertible: boolean;
  /** Why it cannot be reverted, shown instead of a dead button. */
  blockedReason?: string | null;
  /** Gating that is not about the reason: read-only backend, another operation. */
  disabled: boolean;
  /** Status line, e.g. the post-operation refresh. */
  note?: string | null;
  onOpen: () => void;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RevertControl({
  operationId,
  editing,
  reason,
  revertible,
  blockedReason,
  disabled,
  note,
  onOpen,
  onReasonChange,
  onCancel,
  onConfirm,
}: RevertControlProps) {
  if (!revertible) {
    return blockedReason ? <p className="mt-2 text-muted-foreground">{blockedReason}</p> : null;
  }

  if (!editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" disabled={disabled} onClick={onOpen}>
          Revert
        </Button>
        {note && (
          <span className="text-muted-foreground" aria-live="polite">
            {note}
          </span>
        )}
      </div>
    );
  }

  const inputId = `revert-reason-${operationId}`;
  return (
    <div className="mt-2 space-y-1">
      <label htmlFor={inputId} className="block font-medium">
        Reason for reverting <span className="text-destructive">*</span>
      </label>
      <input
        id={inputId}
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        placeholder="Why is this being reverted? Recorded on the revert receipt."
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || reason.trim().length === 0}
          onClick={onConfirm}
        >
          Confirm revert
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {note && (
          <span className="text-muted-foreground" aria-live="polite">
            {note}
          </span>
        )}
      </div>
    </div>
  );
}

/** The prefill both surfaces use, so the two never drift apart again. */
export function defaultRevertReason(operationId: string): string {
  return `Revert of ${operationId} from the Fleet page`;
}
