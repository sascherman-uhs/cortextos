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
import { RevertControl, type RevertControlProps } from './routing-revert-control';
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
  /** The shared Revert control's wiring, minus what the receipt itself knows. */
  revert: Omit<RevertControlProps, 'operationId' | 'revertible' | 'blockedReason'>;
  onDismiss: () => void;
}

export function RoutingReceiptPanel({ receipt, receiptError, revert, onDismiss }: RoutingReceiptPanelProps) {
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

      {/* The same control the operation history renders: open, edit the reason,
          confirm. A one-click revert with a canned reason records a decision
          nobody made, which is why the two surfaces no longer differ. */}
      <RevertControl
        {...revert}
        operationId={receipt.operation_id}
        revertible={display.canRevert}
        blockedReason={
          display.canRevert
            ? null
            : 'Nothing to revert — this operation has not changed the registry.'
        }
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {receiptError && (
        <p className="mt-1 text-destructive" role="alert">
          {receiptError}
        </p>
      )}
    </div>
  );
}
