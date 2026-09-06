/**
 * fix9 / defect B — the two Revert controls used to disagree.
 *
 * The control on the fresh in-session receipt fired on one click with a canned
 * reason the operator had never read. The control in the operation history
 * opened a form and required a typed reason. fix3 deliberately made revert take
 * an operator-supplied reason, so the receipt control was the wrong one: a
 * one-click revert with an auto-filled justification records a decision nobody
 * made. Both surfaces now render the same component with the same prefill.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RevertControl, defaultRevertReason } from '../routing-revert-control';
import { RoutingReceiptPanel } from '../routing-receipt-panel';
import type { Receipt } from '@/lib/model-routing';

const noop = () => {};

function control(over: Partial<Parameters<typeof RevertControl>[0]> = {}) {
  return renderToStaticMarkup(
    <RevertControl
      operationId="op-77"
      editing={false}
      reason=""
      revertible
      disabled={false}
      onOpen={noop}
      onReasonChange={noop}
      onCancel={noop}
      onConfirm={noop}
      {...over}
    />,
  );
}

const appliedReceipt = {
  operation_id: 'op-77',
  state: 'applied',
  affected_consumers: ['jarvis-mls'],
  restart_required: false,
} as unknown as Receipt;

function receiptPanel(editing: boolean, reason: string) {
  return renderToStaticMarkup(
    <RoutingReceiptPanel
      receipt={appliedReceipt}
      receiptError={null}
      revert={{
        editing,
        reason,
        disabled: false,
        note: null,
        onOpen: noop,
        onReasonChange: noop,
        onCancel: noop,
        onConfirm: noop,
      }}
      onDismiss={noop}
    />,
  );
}

describe('the shared Revert control', () => {
  it('does not submit on the first click — it asks for a reason', () => {
    const closed = control();
    expect(closed).toContain('Revert');
    expect(closed).not.toContain('Confirm revert');
    expect(closed).not.toContain('Reason for reverting');
  });

  it('gates Confirm on a non-empty reason', () => {
    expect(control({ editing: true, reason: '' })).toContain('disabled=""');
    expect(control({ editing: true, reason: '   ' })).toContain('disabled=""');
    expect(control({ editing: true, reason: 'wrong tier' })).not.toContain('disabled=""');
  });

  it('shows the blocked reason instead of a dead button', () => {
    const html = control({ revertible: false, blockedReason: 'Already reverted by op-88.' });
    expect(html).toContain('Already reverted by op-88.');
    expect(html).not.toContain('Revert</button>');
  });

  it('renders nothing at all when there is nothing to revert and nothing to say', () => {
    expect(control({ revertible: false, blockedReason: null })).toBe('');
  });
});

describe('the receipt surface and the history surface behave identically', () => {
  it('the receipt no longer offers a one-click revert', () => {
    const html = receiptPanel(false, '');
    expect(html).toContain('Revert');
    expect(html).not.toContain('Confirm revert');
    // The reason field appears only after Revert is clicked, as in the history.
    expect(html).not.toContain('Reason for reverting');
  });

  it('the receipt asks for the reason with the same form as the history', () => {
    const open = receiptPanel(true, defaultRevertReason('op-77'));
    expect(open).toContain('Reason for reverting');
    expect(open).toContain('Confirm revert');
    expect(open).toContain('Cancel');
    // Same markup as the history control for the same operation and reason.
    expect(open).toContain(
      control({ editing: true, reason: defaultRevertReason('op-77') }),
    );
  });

  it('prefills both surfaces from one place', () => {
    expect(defaultRevertReason('op-77')).toBe('Revert of op-77 from the Fleet page');
    expect(receiptPanel(true, defaultRevertReason('op-77'))).toContain(
      'Revert of op-77 from the Fleet page',
    );
  });
});
