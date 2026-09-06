'use client';

/**
 * The receipt panel for a model-routing operation.
 *
 * Extracted from `fleet-model-routing.tsx` so the FAILURE path can be rendered
 * in a test. The panel's error surfacing had never been observed: the restart
 * bug that used to trigger it is fixed, so a failure can no longer be forced
 * against a live registry, and "the code sets both error states" was the only
 * evidence that an operator would see anything. Rendering this component with a
 * blocked/failed receipt is that evidence.
 *
 * The panel narrates a receipt ONLY from the receipt's own fields, and a
 * non-applied receipt is never described as applied.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  RECEIPT_STATE_ORDER,
  describeReceipt,
  describeReceiptOutcome,
} from './model-routing-view';
import type { Receipt } from '@/lib/model-routing';

export interface RoutingReceiptPanelProps {
  receipt: Receipt | null;
  /** Transport- or service-level error for the same operation, if any. */
  receiptError: string | null;
  revertReason: string;
  onRevertReasonChange: (value: string) => void;
  revertControl: { disabled: boolean; note: string | null };
  onRevert: () => void;
  onDismiss: () => void;
}

export function RoutingReceiptPanel({
  receipt,
  receiptError,
  revertReason,
  onRevertReasonChange,
  revertControl,
  onRevert,
  onDismiss,
}: RoutingReceiptPanelProps) {
  const display = describeReceipt(receipt);
  const outcome = describeReceiptOutcome(receipt);
  if (!display || !receipt) return null;

  return (
    <div className="rounded-lg border border-border p-3 text-xs" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={display.applied ? 'default' : display.tone === 'error' ? 'destructive' : 'outline'}>
          {display.label}
        </Badge>
        <span className="text-muted-foreground">
          {display.stepIndex >= 0
            ? `Step ${display.stepIndex + 1} of ${RECEIPT_STATE_ORDER.length}`
            : 'Off the normal path'}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{receipt.operation_id}</span>
      </div>
      <p className="mt-1 text-muted-foreground">{display.description}</p>
      {receipt.error && (
        <p className="mt-1 text-destructive" role="alert">
          {receipt.error}
        </p>
      )}
      {outcome && <p className="mt-1 text-muted-foreground">{outcome.headline}</p>}
      {outcome && outcome.results.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {outcome.results.map((r) => (
            <li key={r.agent} className={r.ok ? 'text-muted-foreground' : 'text-destructive'}>
              <span className="font-mono">{r.agent}</span>: {r.ok ? 'restarted' : 'restart failed'}
              {r.message ? ` — ${r.message}` : ''}
            </li>
          ))}
        </ul>
      )}
      {outcome && outcome.clearedPins.length > 0 && (
        <p className="mt-1 text-muted-foreground">Cleared pins: {outcome.clearedPins.join(', ')}</p>
      )}
      {receipt.affected_consumers?.length > 0 && (
        <p className="mt-1 text-muted-foreground">Affected: {receipt.affected_consumers.join(', ')}</p>
      )}

      {display.canRevert && (
        <div className="mt-2 space-y-1">
          <label htmlFor="revert-reason" className="block font-medium">
            Reason for reverting <span className="text-destructive">*</span>
          </label>
          <input
            id="revert-reason"
            value={revertReason}
            onChange={(e) => onRevertReasonChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="Why is this being reverted? Recorded on the revert receipt."
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" disabled={revertControl.disabled} onClick={onRevert}>
          Revert
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
        {revertControl.note && (
          <span className="text-muted-foreground" aria-live="polite">
            {revertControl.note}
          </span>
        )}
      </div>
      {receiptError && (
        <p className="mt-1 text-destructive" role="alert">
          {receiptError}
        </p>
      )}
    </div>
  );
}
