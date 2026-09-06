/**
 * Adapter tests — OS-02b-ui.
 *
 * Covers the read-only file fallback (backend "c"): registry normalization and
 * the display-only precedence walk (pin → role → org default), plus the rule
 * that mutations are refused when only the file is readable.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSummary,
  resolveFromRegistry,
  isRoutingError,
  interpretCliOutput,
  isReceipt,
  normalizeAttempts,
  ROUTING_UNAVAILABLE,
} from '@/lib/model-routing';

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

// ---------------------------------------------------------------------------
// Defect 1 — a JSON document on stdout is the answer, whatever the exit code
// ---------------------------------------------------------------------------

describe('interpretCliOutput', () => {
  const failedResolution = JSON.stringify({
    registry_revision: 9,
    validation: {
      ok: false,
      errors: [{ code: 'pin_not_dispatchable', message: 'Pin kimi-k2 is not dispatchable — awaiting human remediation' }],
      warnings: [],
    },
  });

  it('keeps the resolution when the CLI exits non-zero on a failed validation', () => {
    const out = interpretCliOutput(failedResolution, '', 2) as { validation: { errors: { code: string }[] } };
    expect(isRoutingError(out)).toBe(false);
    expect(out.validation.errors[0].code).toBe('pin_not_dispatchable');
  });

  it('never turns an exit code into the displayed value', () => {
    const out = interpretCliOutput(failedResolution, 'some stderr noise', 2);
    expect(JSON.stringify(out)).not.toMatch(/exited 2/);
  });

  it('keeps a receipt that carries its own error field', () => {
    const out = interpretCliOutput(
      JSON.stringify({ operation_id: 'op-9', state: 'blocked', error: 'tier has no candidates' }),
      '',
      1,
    );
    expect(isReceipt(out)).toBe(true);
    expect((out as { state: string }).state).toBe('blocked');
  });

  it('still treats a bare { error } envelope as a routing error', () => {
    expect(isRoutingError(interpretCliOutput('{"error":"registry locked"}', '', 1))).toBe(true);
  });

  it('falls back to stderr only when there is no JSON at all', () => {
    const out = interpretCliOutput('not json', 'command not found', 127) as { error: string };
    expect(out.error).toBe('command not found');
    const bare = interpretCliOutput('', '', 3) as { error: string };
    expect(bare.error).toMatch(/exit 3/);
  });
});

describe('normalizeAttempts', () => {
  it('maps loose CLI shapes onto the display record', () => {
    const rows = normalizeAttempts({
      attempts: [
        {
          attempt_id: 'att-1',
          at: '2026-09-05T10:00:00Z',
          agent: 'vera',
          requested_model_id: 'claude-sonnet-4-6',
          resolved_model_id: 'claude-sonnet-4-6',
          observed: { model_id: 'claude-haiku-4-5-20251001', confidence: 'mismatch', binding: 'sess-1' },
        },
        { id: 'att-2' },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempt_id: 'att-1',
      requested: 'claude-sonnet-4-6',
      observed: 'claude-haiku-4-5-20251001',
      confidence: 'mismatch',
      binding: 'sess-1',
    });
    expect(rows[1]).toMatchObject({ attempt_id: 'att-2', confidence: 'unknown', requested: null });
  });

  it('survives junk and a bare array', () => {
    expect(normalizeAttempts(null)).toEqual([]);
    expect(normalizeAttempts([{ id: 'x' }])).toHaveLength(1);
  });
});
