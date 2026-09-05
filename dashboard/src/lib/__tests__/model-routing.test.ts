/**
 * Adapter tests — OS-02b-ui.
 *
 * Covers the read-only file fallback (backend "c"): registry normalization and
 * the display-only precedence walk (pin → role → org default), plus the rule
 * that mutations are refused when only the file is readable.
 */

import { describe, it, expect } from 'vitest';
import { normalizeSummary, resolveFromRegistry, isRoutingError, ROUTING_UNAVAILABLE } from '@/lib/model-routing';

const raw = {
  schema_version: 1,
  revision: 12,
  activation: { org_default: 'shadow', consumers: { 'trillion-coder': 'enforced' } },
  org_default_tier: 'standard',
  entries: {
    haiku: { model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', runtime_adapter: 'claude-code', capability_tags: ['coding'], context_window: 200000, billing_mode: 'subscription_quota', cost_class: 1, auth_source: 'claude-cli-login', status: 'active' },
    sonnet: { model_id: 'claude-sonnet-4-6', provider: 'anthropic', runtime_adapter: 'claude-code', capability_tags: ['coding'], context_window: 200000, billing_mode: 'subscription_quota', cost_class: 3, auth_source: 'claude-cli-login', status: 'active' },
  },
  tiers: { economy: ['haiku'], standard: ['sonnet'] },
  roles: { builder: { tier: 'economy', required_capabilities: ['coding'], min_context: 1000, data_scope: 'repos' } },
  agents: {
    'trillion-coder': { role: 'builder', pin: null },
    vera: { role: 'builder', pin: { entry_id: 'sonnet', kind: 'explicit', expires_at: '2099-01-01T00:00:00Z' } },
    stale: { role: 'builder', pin: { entry_id: 'sonnet', kind: 'explicit', expires_at: '2020-01-01T00:00:00Z' } },
    broken: { role: 'nonexistent-role', pin: null },
  },
};

describe('normalizeSummary', () => {
  it('flattens entries into a list keyed by entry_id and fills defaults', () => {
    const s = normalizeSummary(raw);
    expect(s.revision).toBe(12);
    expect(s.entries.map((e) => e.entry_id).sort()).toEqual(['haiku', 'sonnet']);
    expect(s.entries.find((e) => e.entry_id === 'haiku')?.cost_class).toBe(1);
    expect(s.activation.org_default).toBe('shadow');
  });

  it('produces a usable empty summary from junk', () => {
    const s = normalizeSummary(null);
    expect(s.entries).toEqual([]);
    expect(s.org_default_tier).toBe('standard');
    expect(s.activation.org_default).toBe('shadow');
  });
});

describe('resolveFromRegistry (display-only precedence)', () => {
  const s = normalizeSummary(raw);

  it('follows the role tier when there is no pin', () => {
    const r = resolveFromRegistry(s, 'trillion-coder');
    expect(r.requested.source).toBe('role');
    expect(r.requested.tier).toBe('economy');
    expect(r.selected?.model_id).toBe('claude-haiku-4-5-20251001');
    expect(r.activation).toBe('enforced'); // per-consumer override
    expect(r.eval_state).toBe('unevaluated');
  });

  it('prefers a live pin over the role', () => {
    const r = resolveFromRegistry(s, 'vera');
    expect(r.requested.source).toBe('pin');
    expect(r.selected?.entry_id).toBe('sonnet');
  });

  it('ignores an expired pin and falls back to the role', () => {
    const r = resolveFromRegistry(s, 'stale');
    expect(r.requested.source).toBe('role');
    expect(r.selected?.entry_id).toBe('haiku');
  });

  it('flags an unknown role and an unbound agent', () => {
    expect(resolveFromRegistry(s, 'broken').validation.errors[0].code).toBe('unknown_role');
    const unbound = resolveFromRegistry(s, 'not-an-agent');
    expect(unbound.requested.source).toBe('org_default');
    expect(unbound.validation.errors[0].code).toBe('agent_unbound');
  });

  it('always warns that a file-derived resolution is display-only', () => {
    expect(resolveFromRegistry(s, 'vera').validation.warnings[0]).toMatch(/display-only/);
  });
});

describe('routing errors', () => {
  it('recognises the unavailable sentinel', () => {
    expect(isRoutingError(ROUTING_UNAVAILABLE)).toBe(true);
    expect(ROUTING_UNAVAILABLE.error).toBe('routing service unavailable');
    expect(isRoutingError({ revision: 1 })).toBe(false);
  });
});
