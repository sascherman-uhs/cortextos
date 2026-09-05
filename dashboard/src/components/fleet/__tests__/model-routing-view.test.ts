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
  describeEffectiveSource,
  describeReceipt,
  describeReceiptState,
  evalStateLabel,
  isLegacyPin,
  previewAgentPin,
  previewRoleSwitch,
} from '../model-routing-view';
import type { ReceiptState, RegistrySummary, Resolution } from '@/lib/model-routing';

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
