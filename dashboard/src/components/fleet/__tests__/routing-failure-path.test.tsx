/**
 * fix9 / item 2 — the routing panel's failure path, actually rendered.
 *
 * The panel sets a receipt and both error states on a non-ok response, but
 * nobody had ever watched it fail: the restart bug that used to trigger the
 * path is fixed, so a failure cannot be forced against a live registry, and
 * "the code sets the states" was the only evidence an operator would see
 * anything. These tests inject the failure at the adapter boundary — the parsed
 * HTTP response — and then render what the operator gets.
 *
 * Nothing here weakens the fix: `describeRoutingResponse` is the code the
 * component runs, and `RoutingReceiptPanel` is the markup the page renders.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeRoutingResponse } from '../model-routing-view';
import { RoutingReceiptPanel } from '../routing-receipt-panel';
import type { Receipt } from '@/lib/model-routing';

const failedReceipt = {
  operation_id: 'op-9f31',
  state: 'failed',
  error: 'pm2 restart jarvis-inventory exited 1',
  affected_consumers: ['jarvis-inventory'],
  restart_results: [{ agent: 'jarvis-inventory', ok: false, detail: 'process did not come back' }],
} as unknown as Receipt;

const blockedReceipt = {
  operation_id: 'op-4a02',
  state: 'blocked',
  error: 'entry gpt-5-codex is deprecated and cannot be pinned',
  affected_consumers: ['trillion-coder'],
} as unknown as Receipt;

function render(receipt: Receipt | null, receiptError: string | null) {
  return renderToStaticMarkup(
    <RoutingReceiptPanel
      receipt={receipt}
      receiptError={receiptError}
      revertReason=""
      onRevertReasonChange={() => {}}
      revertControl={{ disabled: true, note: null }}
      onRevert={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe('a non-ok response carrying a failed receipt', () => {
  const outcome = describeRoutingResponse({
    ok: false,
    status: 500,
    body: { receipt: failedReceipt, error: 'pm2 restart jarvis-inventory exited 1' },
  });

  it('keeps the receipt instead of discarding it with the error', () => {
    expect(outcome.receipt).toBe(failedReceipt);
  });

  it('reports failure on both surfaces and claims no success', () => {
    expect(outcome.success).toBe(false);
    expect(outcome.dialogError).toBe('pm2 restart jarvis-inventory exited 1');
    expect(outcome.receiptError).toBe('pm2 restart jarvis-inventory exited 1');
  });

  it('does not re-read the registry — a failed write changed nothing', () => {
    expect(outcome.shouldRefresh).toBe(false);
  });

  it('renders the failure where the operator is looking', () => {
    const html = render(outcome.receipt, outcome.receiptError);
    // The receipt survives.
    expect(html).toContain('op-9f31');
    expect(html).toContain('Failed');
    // The error is on screen, not only in state.
    expect(html).toContain('pm2 restart jarvis-inventory exited 1');
    expect(html).toContain('role="alert"');
    // The restart that did not happen is named as a failure.
    expect(html).toContain('restart failed');
    expect(html).toContain('Restarted 0 of 1 agent');
    // Nothing claims success.
    expect(html).not.toContain('Applied');
    expect(html).not.toContain('no restart needed');
    // And no Revert offer for a change that never reached the registry.
    expect(html).not.toContain('Reason for reverting');
  });
});

describe('a 2xx response carrying a blocked receipt', () => {
  const outcome = describeRoutingResponse({
    ok: true,
    status: 200,
    body: { receipt: blockedReceipt, success: false },
  });

  it('is not treated as success even though the request succeeded', () => {
    expect(outcome.success).toBe(false);
    expect(outcome.dialogError).toBe('entry gpt-5-codex is deprecated and cannot be pinned');
  });

  it('shows the block on the receipt panel and offers no revert', () => {
    const html = render(outcome.receipt, outcome.receiptError);
    expect(html).toContain('Blocked');
    expect(html).toContain('entry gpt-5-codex is deprecated and cannot be pinned');
    expect(html).toContain('Needs a human decision');
    expect(html).not.toContain('Reason for reverting');
    expect(html).not.toContain('Applied');
  });
});

describe('a request that never reached the service', () => {
  const outcome = describeRoutingResponse({
    ok: false,
    status: 0,
    body: null,
    transportError: 'cortextos model set exited 127: routing CLI not found',
  });

  it('drops the previous receipt rather than leaving it standing', () => {
    expect(outcome.receipt).toBeNull();
    expect(outcome.success).toBe(false);
  });

  it('turns the shell failure into something an operator can act on', () => {
    expect(outcome.dialogError).toContain('`cortextos` is installed and on PATH');
    expect(outcome.receiptError).toBe(outcome.dialogError);
  });

  it('renders nothing that could be mistaken for a completed operation', () => {
    expect(render(outcome.receipt, outcome.receiptError)).toBe('');
  });
});

describe('a successful response', () => {
  it('is the only case that reports success', () => {
    const outcome = describeRoutingResponse({
      ok: true,
      status: 200,
      body: { receipt: { operation_id: 'op-1', state: 'applied' } as unknown as Receipt, success: true },
    });
    expect(outcome.success).toBe(true);
    expect(outcome.dialogError).toBeNull();
    expect(outcome.receiptError).toBeNull();
    expect(outcome.shouldRefresh).toBe(true);
  });
});
