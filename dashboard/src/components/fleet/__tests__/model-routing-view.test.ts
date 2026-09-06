/**
 * Fleet display-state tests — OS-02b-ui.
 *
 * The load-bearing rule: a pending receipt is never displayed as applied, and
 * revert is only offered once a change actually reached the registry.
 */

import { describe, it, expect } from 'vitest';
import {
  RECEIPT_STATE_ORDER,
  billingModeLabel,
  costClassLabel,
  describeActivation,
  describeCostChange,
  describeDesiredVsRunning,
  describeOperationChange,
  describeRevertControl,
  describeRevertability,
  summarizeOperations,
  describeEffectiveSource,
  describeReceipt,
  describeReceiptOutcome,
  describeReceiptState,
  evalStateLabel,
  humanizeRoutingError,
  isLegacyPin,
  previewAgentPin,
  previewRoleSwitch,
  remediationItems,
} from '../model-routing-view';
import type { Receipt, ReceiptState, RegistrySummary, Resolution } from '@/lib/model-routing';

const summary: RegistrySummary = {
  schema_version: 1,
  revision: 4,
  activation: { org_default: 'shadow', consumers: { 'trillion-coder': 'enforced' } },
  org_default_tier: 'standard',
  entries: [
    { entry_id: 'haiku', model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', runtime_adapter: 'claude-code', capability_tags: [], context_window: 200000, billing_mode: 'subscription_quota', cost_class: 1, auth_source: 'claude-cli-login', status: 'active' },
    { entry_id: 'sonnet', model_id: 'claude-sonnet-4-6', provider: 'anthropic', runtime_adapter: 'claude-code', capability_tags: [], context_window: 200000, billing_mode: 'subscription_quota', cost_class: 3, auth_source: 'claude-cli-login', status: 'active' },
    { entry_id: 'opus', model_id: 'claude-opus-5', provider: 'anthropic', runtime_adapter: 'anthropic-api', capability_tags: [], context_window: 200000, billing_mode: 'api_metered', cost_class: 5, auth_source: 'env:ANTHROPIC_API_KEY', status: 'active' },
    { entry_id: 'retired', model_id: 'old', provider: 'anthropic', runtime_adapter: 'claude-code', capability_tags: [], context_window: 1, billing_mode: 'api_metered', cost_class: 9, auth_source: null, status: 'unavailable' },
  ],
  tiers: { economy: ['haiku'], standard: ['sonnet'], premium: ['opus'], empty: [] },
  roles: {
    dispatcher: { tier: 'standard', required_capabilities: [], min_context: 1, data_scope: 'org' },
    builder: { tier: 'economy', required_capabilities: [], min_context: 1, data_scope: 'repos' },
  },
  agents: {
    'jarvis-orchestrator': { role: 'dispatcher', pin: null },
    'jarvis-heartbeat': { role: 'dispatcher', pin: null },
    'trillion-coder': {
      role: 'builder',
      pin: { entry_id: 'sonnet', kind: 'proposed-invalid', reason: 'anthropic id on a codex runtime' },
    },
    vera: {
      role: 'dispatcher',
      pin: { entry_id: 'opus', kind: 'legacy-migration', expires_at: '2026-10-05T00:00:00Z' },
    },
  },
};

function resolution(over: Partial<Resolution> = {}): Resolution {
  return {
    registry_revision: 4,
    activation: 'shadow',
    requested: { source: 'role', tier: 'standard' },
    candidates: ['sonnet'],
    selected: { entry_id: 'sonnet', model_id: 'claude-sonnet-4-6', provider: 'anthropic', runtime_adapter: 'claude-code', billing_mode: 'subscription_quota', cost_class: 3 },
    validation: { ok: true, errors: [], warnings: [] },
    ...over,
  };
}

describe('receipt state machine', () => {
  const pendingStates: ReceiptState[] = ['requested', 'validated', 'desired_written', 'draining'];

  it.each(pendingStates)('%s is pending and never applied', (state) => {
    const d = describeReceiptState(state);
    expect(d.pending).toBe(true);
    expect(d.applied).toBe(false);
    expect(d.label.toLowerCase()).not.toBe('applied');
  });

  it('applied is the only terminal success', () => {
    const d = describeReceiptState('applied');
    expect(d.applied).toBe(true);
    expect(d.pending).toBe(false);
    expect(d.tone).toBe('success');
    expect(d.stepIndex).toBe(RECEIPT_STATE_ORDER.length - 1);
  });

  it.each(['blocked', 'failed'] as ReceiptState[])('%s is a terminal failure, not pending', (state) => {
    const d = describeReceiptState(state);
    expect(d.terminalFailure).toBe(true);
    expect(d.pending).toBe(false);
    expect(d.applied).toBe(false);
  });

  it('offers revert only after the registry was written', () => {
    expect(describeReceiptState('requested').canRevert).toBe(false);
    expect(describeReceiptState('validated').canRevert).toBe(false);
    expect(describeReceiptState('desired_written').canRevert).toBe(true);
    expect(describeReceiptState('draining').canRevert).toBe(true);
    expect(describeReceiptState('applied').canRevert).toBe(true);
    expect(describeReceiptState('failed').canRevert).toBe(false);
  });

  it('describeReceipt tolerates a missing receipt', () => {
    expect(describeReceipt(null)).toBeNull();
    expect(describeReceipt({ state: 'blocked' } as never)?.tone).toBe('warning');
  });
});

describe('desired vs running', () => {
  it('is unconfirmed with no observation, falling back to the legacy model', () => {
    const d = describeDesiredVsRunning(resolution({ legacy_effective: { model_id: 'claude-haiku-4-5-20251001' } }));
    expect(d.desired).toBe('claude-sonnet-4-6');
    expect(d.running).toBe('claude-haiku-4-5-20251001');
    expect(d.confidence).toBe('unconfirmed');
    expect(d.drift).toBe(false);
  });

  it('is verified when the observed model matches the resolved one', () => {
    const d = describeDesiredVsRunning(
      resolution({ observed: { model_id: 'claude-sonnet-4-6', source: 'claude-transcript', confidence: 'verified' } }),
    );
    expect(d.confidence).toBe('verified');
    expect(d.tone).toBe('success');
  });

  it('reports mismatch when the observed model differs, even if the source claimed verified', () => {
    const d = describeDesiredVsRunning(
      resolution({ observed: { model_id: 'claude-opus-5', source: 'claude-transcript', confidence: 'verified' } }),
    );
    expect(d.confidence).toBe('mismatch');
    expect(d.drift).toBe(true);
    expect(d.tone).toBe('error');
  });

  it('degrades safely with no resolution at all', () => {
    const d = describeDesiredVsRunning(null);
    expect(d.desired).toBe('—');
    expect(d.running).toBe('unknown');
    expect(d.confidence).toBe('unconfirmed');
  });
});

describe('source, activation, cost labels', () => {
  it('names each precedence source', () => {
    expect(describeEffectiveSource(resolution()).label).toBe('Role tier');
    expect(describeEffectiveSource(resolution({ requested: { source: 'pin', entry_id: 'opus' } })).label).toBe('Pinned');
    expect(describeEffectiveSource(resolution({ requested: { source: 'org_default', tier: 'standard' } })).label).toBe('Org default');
    expect(describeEffectiveSource(null).label).toBe('Unresolved');
  });

  it('defaults activation to shadow and explains it', () => {
    expect(describeActivation(null).mode).toBe('shadow');
    expect(describeActivation(resolution({ activation: 'enforced' })).label).toBe('Enforced');
  });

  it('formats cost and billing', () => {
    expect(costClassLabel(3)).toBe('cost class 3');
    expect(costClassLabel(null)).toBe('cost —');
    expect(billingModeLabel('subscription_quota')).toBe('subscription quota');
    expect(billingModeLabel(undefined)).toBe('billing —');
  });

  it('describes a cost-class increase and a billing-mode change', () => {
    const s = describeCostChange({ cost_class: 1, billing_mode: 'subscription_quota' }, { cost_class: 5, billing_mode: 'api_metered' });
    expect(s).toContain('increases');
    expect(s).toContain('1 → 5');
    expect(s).toContain('subscription quota → api metered');
  });

  it('says unchanged when nothing moves', () => {
    const s = describeCostChange({ cost_class: 3, billing_mode: 'api_metered' }, { cost_class: 3, billing_mode: 'api_metered' });
    expect(s).toContain('Cost class unchanged');
    expect(s).toContain('Billing mode unchanged');
  });

  it('uses the unevaluated placeholder until OS-08 lands', () => {
    expect(evalStateLabel(null)).toBe('unevaluated');
    expect(evalStateLabel(resolution({ eval_state: 'passing' }))).toBe('passing');
  });
});

describe('switch preview', () => {
  it('lists every agent bound to the role and warns about restarts', () => {
    const p = previewRoleSwitch(summary, 'dispatcher', 'premium', { cost_class: 3, billing_mode: 'subscription_quota' });
    expect(p.affectedAgents).toEqual(['jarvis-heartbeat', 'jarvis-orchestrator', 'vera']);
    expect(p.targetEntryId).toBe('opus');
    expect(p.restartWarning).toContain('jarvis-heartbeat, jarvis-orchestrator');
    expect(p.restartWarning).toContain('1 pinned agent (vera)');
    expect(p.costSentence).toContain('increases');
    expect(p.blocked).toBeNull();
  });

  it('blocks a tier with no candidates', () => {
    expect(previewRoleSwitch(summary, 'dispatcher', 'empty').blocked).toMatch(/no candidate entries/);
  });

  it('blocks when the registry could not be read', () => {
    expect(previewRoleSwitch(null, 'dispatcher', 'standard').blocked).toBe('routing service unavailable');
  });

  it('previews a single-agent pin and rejects a non-active entry', () => {
    const ok = previewAgentPin(summary, 'vera', 'opus', { cost_class: 3, billing_mode: 'subscription_quota' });
    expect(ok.affectedAgents).toEqual(['vera']);
    expect(ok.blocked).toBeNull();
    expect(previewAgentPin(summary, 'vera', 'retired').blocked).toMatch(/unavailable/);
    expect(previewAgentPin(summary, 'vera', 'nope').blocked).toMatch(/not in the registry/);
  });

  it('identifies legacy pins that the human can clear', () => {
    expect(isLegacyPin(summary, 'vera')).toBe(true);
    expect(isLegacyPin(summary, 'trillion-coder')).toBe(true);
    expect(isLegacyPin(summary, 'jarvis-orchestrator')).toBe(false);
    expect(isLegacyPin(null, 'vera')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — the badge follows `observed` / `expected_model_id`
// ---------------------------------------------------------------------------

describe('desired vs running with observation fields', () => {
  it('compares the observation against expected_model_id when the CLI emits it', () => {
    const d = describeDesiredVsRunning(
      resolution({
        expected_model_id: 'claude-opus-5',
        observed: { model_id: 'claude-opus-5', source: 'transcript', confidence: 'verified', binding: 'sess-7' },
      }),
    );
    expect(d.confidence).toBe('verified');
    expect(d.hint).toContain('binding: sess-7');
  });

  it('reports mismatch against expected_model_id even when selected still agrees with the observation', () => {
    const d = describeDesiredVsRunning(
      resolution({
        expected_model_id: 'claude-opus-5',
        observed: { model_id: 'claude-sonnet-4-6', source: 'transcript', confidence: 'verified' },
      }),
    );
    expect(d.confidence).toBe('mismatch');
    expect(d.hint).toContain('claude-opus-5');
  });

  it('says so plainly when there is no observation to go on', () => {
    expect(describeDesiredVsRunning(resolution()).hint).toContain('No observation available');
    expect(describeDesiredVsRunning(resolution({ observed: null })).confidence).toBe('unconfirmed');
    // An observation with no model id is not evidence of anything.
    expect(
      describeDesiredVsRunning(resolution({ observed: { model_id: null, source: 'transcript' } })).confidence,
    ).toBe('unconfirmed');
  });

  it('trusts observed.confidence when the models agree and no expectation is stated', () => {
    const d = describeDesiredVsRunning(
      resolution({ selected: null, observed: { model_id: 'kimi-k2', source: 'pty', confidence: 'unconfirmed' } }),
    );
    expect(d.confidence).toBe('unconfirmed');
    expect(d.desired).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Defect 4 — the narration follows the receipt, never the other way round
// ---------------------------------------------------------------------------

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    operation_id: 'op-1',
    kind: 'switch',
    actor: 'dashboard',
    reason: 'ZZTEST',
    affected_consumers: [],
    state: 'applied',
    created_at: '2026-09-05T18:00:00Z',
    ...over,
  };
}

describe('receipt outcome narration', () => {
  it('says no restart was needed when nothing was affected', () => {
    expect(describeReceiptOutcome(receipt())?.headline).toBe('Applied — no restart needed.');
  });

  it('honours restart_required:false even with affected consumers', () => {
    const o = describeReceiptOutcome(receipt({ affected_consumers: ['vera'], restart_required: false }));
    expect(o?.headline).toBe('Applied — no restart needed.');
    expect(o?.restartsPerformed).toBe(false);
  });

  it('lists the actual restart results rather than asserting success', () => {
    const o = describeReceiptOutcome(
      receipt({
        affected_consumers: ['vera', 'tron'],
        restart_required: true,
        restart_results: [
          { agent: 'vera', ok: true },
          { agent: 'tron', ok: false, message: 'pm2 refused' },
        ],
      }),
    );
    expect(o?.headline).toContain('Restarted 1 of 2 agents');
    expect(o?.restartsPerformed).toBe(true);
    expect(o?.results).toHaveLength(2);
  });

  it('never claims a restart when the receipt only says one is required', () => {
    const o = describeReceiptOutcome(
      receipt({ state: 'desired_written', affected_consumers: ['vera'], restart_required: true }),
    );
    expect(o?.headline).toMatch(/still need a restart/);
    expect(o?.headline).not.toMatch(/Restarted/);
  });

  it('stays honest on an older CLI that reports neither flag nor results', () => {
    const o = describeReceiptOutcome(receipt({ state: 'desired_written', affected_consumers: ['vera'] }));
    expect(o?.headline).toMatch(/does not report any restarts/);
    expect(o?.restartsPerformed).toBe(false);
  });

  it('surfaces pins the operation cleared', () => {
    expect(describeReceiptOutcome(receipt({ cleared_pins: ['vera'] }))?.clearedPins).toEqual(['vera']);
  });

  it('does not describe the applied state as a completed restart', () => {
    expect(describeReceiptState('applied').description).not.toMatch(/agents restarted/i);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 (display half) — remediation items, not shell exit codes
// ---------------------------------------------------------------------------

describe('remediation items and error wording', () => {
  it('carries the validation message text', () => {
    const items = remediationItems(
      resolution({
        validation: {
          ok: false,
          errors: [{ code: 'pin_not_dispatchable', message: 'Pin kimi-k2 is not dispatchable — awaiting human remediation' }],
          warnings: ['display-only'],
        },
      }),
    );
    expect(items[0]).toMatchObject({ code: 'pin_not_dispatchable', severity: 'error' });
    expect(items[0].message).toContain('awaiting human remediation');
    expect(items[1].severity).toBe('warning');
  });

  it('replaces a raw CLI exit string with something actionable', () => {
    expect(humanizeRoutingError('cortextos model exited 2')).toMatch(/no usable output/);
    expect(humanizeRoutingError('Pinned entry is unknown')).toBe('Pinned entry is unknown');
    expect(humanizeRoutingError(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defect 5 — the dialog can preview and clear legacy pins
// ---------------------------------------------------------------------------

describe('legacy pins in the switch preview', () => {
  it('names the pins a role switch would clear', () => {
    const p = previewRoleSwitch(summary, 'dispatcher', 'premium');
    expect(p.legacyPinnedAgents).toEqual(['vera']);
    expect(p.clearablePins).toEqual([{ agent: 'vera', entry_id: 'opus', kind: 'legacy-migration' }]);
  });

  it('reports no clearable pins for a role that has none', () => {
    expect(previewRoleSwitch(summary, 'builder', 'economy').clearablePins.map((c) => c.agent)).toEqual([
      'trillion-coder',
    ]);
    expect(previewRoleSwitch(null, 'dispatcher', 'premium').clearablePins).toEqual([]);
  });

  it('predicts the restarts that clearing the pins actually causes', () => {
    // The defect: with "Also clear N legacy pin(s)" checked the preview still
    // said "No agents will be restarted by this change", and then the agent
    // restarted. Clearing a pin is what makes that agent follow the role tier.
    const withoutClear = previewRoleSwitch(summary, 'builder', 'economy', undefined, { clearPins: false });
    expect(withoutClear.restartWarning).toContain('No agents will be restarted');
    expect(withoutClear.restartedByPinClear).toEqual([]);

    const withClear = previewRoleSwitch(summary, 'builder', 'economy', undefined, { clearPins: true });
    expect(withClear.restartWarning).toContain('trillion-coder');
    expect(withClear.restartWarning).not.toContain('No agents will be restarted');
    expect(withClear.restartWarning).toMatch(/1 legacy pin \(trillion-coder\) will be cleared/);
    expect(withClear.restartedByPinClear).toEqual(['trillion-coder']);
    // Nothing keeps a pin any more, so nothing is described as unaffected.
    expect(withClear.restartWarning).not.toContain('keep their pin');
  });

  it('keeps unrelated pinned agents out of the restart list when pins are cleared', () => {
    // dispatcher: two unpinned agents plus vera's legacy pin.
    const withClear = previewRoleSwitch(summary, 'dispatcher', 'premium', undefined, { clearPins: true });
    expect(withClear.restartWarning).toContain('jarvis-heartbeat, jarvis-orchestrator, vera');
    expect(withClear.restartedByPinClear).toEqual(['vera']);
    expect(withClear.restartWarning).not.toContain('keep their pin');
  });

  it('defaults to not clearing, matching a dialog opened with the box unchecked', () => {
    const p = previewRoleSwitch(summary, 'dispatcher', 'premium');
    expect(p.restartWarning).toContain('1 pinned agent (vera)');
    expect(p.restartedByPinClear).toEqual([]);
  });

  it('flags a single-agent pin preview when that agent carries a legacy pin', () => {
    expect(previewAgentPin(summary, 'vera', 'haiku').legacyPinnedAgents).toEqual(['vera']);
    expect(previewAgentPin(summary, 'jarvis-heartbeat', 'haiku').legacyPinnedAgents).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// Defect K — a durable operation history that survives a reload
// ---------------------------------------------------------------------------

/** The journal exactly as the core writes it: one file per state of one
 *  operation, newest file first out of listEvents(). */
function switchEvents(id = 'op_1', at = '2026-09-05T10:00') {
  return [
    {
      operation_id: id, state: 'applied', kind: 'switch', actor: 'scott',
      reason: 'move dispatcher to premium', at: `${at}:04Z`, registry_revision: 5,
      detail: {
        restart_results: [
          { agent: 'jarvis-orchestrator', ok: true },
          { agent: 'jarvis-heartbeat', ok: false, detail: 'restart timed out' },
        ],
      },
    },
    {
      operation_id: id, state: 'desired_written', kind: 'switch', actor: 'scott',
      reason: 'move dispatcher to premium', at: `${at}:02Z`, registry_revision: 5,
      detail: {
        from: { role: 'dispatcher', tier: 'standard', cleared_pins: [] },
        to: { role: 'dispatcher', tier: 'premium', cleared_pins: [] },
      },
    },
    {
      operation_id: id, state: 'validated', kind: 'switch', actor: 'scott',
      reason: 'move dispatcher to premium', at: `${at}:01Z`, registry_revision: 4,
      detail: { affected_consumers: ['jarvis-orchestrator', 'jarvis-heartbeat'] },
    },
    {
      operation_id: id, state: 'requested', kind: 'switch', actor: 'scott',
      reason: 'move dispatcher to premium', at: `${at}:00Z`, registry_revision: 4,
      detail: { op: { kind: 'switch', role: 'dispatcher', tier: 'premium' } },
    },
  ];
}

describe('operation history', () => {
  it('rebuilds a finished operation from the journal, with its id and Revert', () => {
    // The defect: after a reload the operator saw zero receipts, zero operation
    // ids and no way back except `cortextos model revert` in a terminal. The
    // events were already on the wire and were being thrown away.
    const { operations, total } = summarizeOperations(switchEvents());
    expect(total).toBe(1);

    const [op] = operations;
    expect(op.operationId).toBe('op_1');
    expect(op.kind).toBe('switch');
    expect(op.actor).toBe('scott');
    expect(op.reason).toBe('move dispatcher to premium');
    expect(op.at).toBe('2026-09-05T10:00:04Z');
    expect(op.state).toBe('applied');
    expect(op.registryRevision).toBe(5);
    expect(op.change).toBe('role dispatcher: tier standard → premium');
    expect(op.affectedAgents).toEqual(['jarvis-orchestrator', 'jarvis-heartbeat']);
    expect(op.restarts).toEqual([
      { agent: 'jarvis-orchestrator', ok: true },
      { agent: 'jarvis-heartbeat', ok: false, message: 'restart timed out' },
    ]);
    expect(op.revertible).toBe(true);
    expect(op.revertBlockedReason).toBeNull();
  });

  it('groups many events into operations, newest first', () => {
    const events = [
      ...switchEvents('op_2', '2026-09-05T12:00'),
      ...switchEvents('op_1', '2026-09-05T10:00'),
    ];
    const { operations, total } = summarizeOperations(events);
    expect(total).toBe(2);
    expect(operations.map((o) => o.operationId)).toEqual(['op_2', 'op_1']);
  });

  it('reports the final state, not whichever event came first in the list', () => {
    const events = [...switchEvents()].reverse();
    expect(summarizeOperations(events).operations[0].state).toBe('applied');
  });

  it('caps what it renders and says how much it is not showing', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      switchEvents(`op_${i}`, `2026-09-05T${String(10 + i).padStart(2, '0')}:00`),
    ).flat();
    const { operations, total } = summarizeOperations(events, 8);
    expect(total).toBe(12);
    expect(operations).toHaveLength(8);
    // The newest eight, not an arbitrary eight.
    expect(operations[0].operationId).toBe('op_11');
  });

  it('offers no Revert on an operation that never changed the registry', () => {
    const failed = [
      {
        operation_id: 'op_x', state: 'failed', kind: 'switch', actor: 'scott',
        reason: 'bad tier', at: '2026-09-05T10:00:01Z', registry_revision: 4,
        detail: { error: 'Tier "empty" is empty' },
      },
    ];
    const [op] = summarizeOperations(failed).operations;
    expect(op.revertible).toBe(false);
    expect(op.revertBlockedReason).toMatch(/stopped before the registry changed/);
  });

  it('marks an operation that a later revert already undid', () => {
    const events = [
      {
        operation_id: 'op_2', state: 'applied', kind: 'revert', actor: 'scott',
        reason: 'put it back', at: '2026-09-05T11:00:02Z', registry_revision: 6,
        detail: { restart_results: [] },
      },
      {
        operation_id: 'op_2', state: 'desired_written', kind: 'revert', actor: 'scott',
        reason: 'put it back', at: '2026-09-05T11:00:01Z', registry_revision: 6,
        detail: {
          from: { role: 'dispatcher', tier: 'premium' },
          to: { role: 'dispatcher', tier: 'standard' },
        },
      },
      {
        operation_id: 'op_2', state: 'requested', kind: 'revert', actor: 'scott',
        reason: 'put it back', at: '2026-09-05T11:00:00Z', registry_revision: 5,
        detail: { op: { kind: 'revert', operation_id: 'op_1' } },
      },
      ...switchEvents('op_1'),
    ];
    const { operations } = summarizeOperations(events);
    const original = operations.find((o) => o.operationId === 'op_1')!;
    const revert = operations.find((o) => o.operationId === 'op_2')!;

    // Offering Revert on an already-reverted operation would re-apply the
    // change under a label that says the opposite.
    expect(original.revertible).toBe(false);
    expect(original.revertBlockedReason).toBe('Already reverted by op_2.');
    expect(original.revertedBy).toBe('op_2');
    expect(revert.revertOf).toBe('op_1');
  });

  it('survives a journal with junk, missing fields and unknown states', () => {
    const { operations, total } = summarizeOperations([
      null,
      'not an event',
      { state: 'applied' }, // no operation_id — cannot be addressed, so dropped
      { operation_id: 'op_9', state: 'weird', at: '2026-09-05T09:00:00Z' },
    ]);
    expect(total).toBe(1);
    expect(operations[0].operationId).toBe('op_9');
    expect(operations[0].state).toBe('requested');
    expect(operations[0].actor).toBe('unknown');
    expect(operations[0].change).toBeNull();
  });

  it('handles an empty or absent journal without inventing history', () => {
    expect(summarizeOperations([])).toEqual({ operations: [], total: 0 });
    expect(summarizeOperations(null)).toEqual({ operations: [], total: 0 });
    expect(summarizeOperations(undefined)).toEqual({ operations: [], total: 0 });
  });

  it('describes pin, unpin and activation changes in the operator\'s words', () => {
    expect(describeOperationChange(
      { target_agent: 'vera', pin: null },
      { target_agent: 'vera', pin: { entry_id: 'opus' } },
    )).toBe('vera: pin no pin → opus');
    expect(describeOperationChange(
      { target_agent: 'vera', pin: { entry_id: 'opus' } },
      { target_agent: 'vera', pin: null },
    )).toBe('vera: pin opus → no pin');
    expect(describeOperationChange({ org_default: 'shadow' }, { org_default: 'enforced' }))
      .toBe('org activation shadow → enforced');
    expect(describeOperationChange({ consumer: 'vera', mode: 'shadow' }, { consumer: 'vera', mode: 'enforced' }))
      .toBe('vera: activation shadow → enforced');
    expect(describeOperationChange(null, null)).toBeNull();
  });

  it('counts the pins a switch cleared, because that is what moved those agents', () => {
    expect(describeOperationChange(
      { role: 'builder', tier: 'economy', cleared_pins: [{ agent: 'trillion-coder', pin: { entry_id: 'sonnet' } }] },
      { role: 'builder', tier: 'standard', cleared_pins: ['trillion-coder'] },
    )).toBe('role builder: tier economy → standard (cleared 1 pin)');
  });

  it('refuses to offer Revert on a pin recorded before target_agent existed', () => {
    // The core throws for exactly this shape; the UI must not offer a button
    // that is guaranteed to fail.
    const out = describeRevertability('applied', { entry_id: 'opus' }, true);
    expect(out.revertible).toBe(false);
    expect(out.reason).toMatch(/predates target_agent/);
  });
});

// ---------------------------------------------------------------------------
// Defect L — the post-operation refresh is not the operation
// ---------------------------------------------------------------------------

describe('the Revert control during the post-operation refresh', () => {
  const base = { canRevert: true, submitting: false, refreshing: false, mutable: true, reason: 'undo it' };

  it('is live as soon as the receipt is final, even while the panel refreshes', () => {
    // The defect: `submitting` stayed true across the ~3s refresh, so Revert
    // sat disabled with nothing explaining why and a verifier called it broken.
    const out = describeRevertControl({ ...base, refreshing: true });
    expect(out.disabled).toBe(false);
    expect(out.note).toMatch(/already finished/);
  });

  it('says nothing when there is nothing to say', () => {
    expect(describeRevertControl(base)).toEqual({ disabled: false, note: null });
  });

  it('still refuses while another routing operation is actually in flight', () => {
    const out = describeRevertControl({ ...base, submitting: true });
    expect(out.disabled).toBe(true);
    expect(out.note).toMatch(/still running/);
  });

  it('refuses without a reason, and on a read-only backend', () => {
    expect(describeRevertControl({ ...base, reason: '   ' }).disabled).toBe(true);
    expect(describeRevertControl({ ...base, mutable: false })).toEqual({
      disabled: true, note: 'This routing backend is read-only.',
    });
  });

  it('refuses on a receipt that never reached the registry', () => {
    expect(describeRevertControl({ ...base, canRevert: false }).disabled).toBe(true);
  });
});
