/**
 * `role_capabilities` at the service layer, plus the seed shipped in
 * `orgs/uhs/model-registry.json`.
 *
 * The seed assertion exists because the enrollment outage was a CONFIGURATION
 * gap, not a code gap: the code was correct and no role declared the
 * capability, so a healthy dispatcher enrolled nobody and exited 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  roleCapabilities,
  roleHasCapability,
  rolesWithCapability,
  validateCandidate,
  ROLE_CAPABILITY_PATTERN,
} from '../../../src/bus/model-registry.js';
import type { ModelRegistry, ModelRoleAssignment } from '../../../src/types/index.js';

const SEEDED = join(__dirname, '../../../orgs/uhs/model-registry.json');
const seeded = (): ModelRegistry => JSON.parse(readFileSync(SEEDED, 'utf-8')) as ModelRegistry;

const EXPECTED_ENROLLED = [
  'builder', 'delivery_ops', 'dispatcher', 'finance_ops', 'growth_ops',
  'listing_intel', 'revenue_ops', 'vera', 'verifier', 'vivienne',
].sort();

describe('roleCapabilities', () => {
  it('treats an absent field as the empty list', () => {
    const role = { tier: 'standard', required_capabilities: [], min_context: 0, data_scope: 'org' } as ModelRoleAssignment;
    expect(roleCapabilities(role)).toEqual([]);
    expect(roleCapabilities(null)).toEqual([]);
    expect(roleHasCapability(role, 'continuous-improvement')).toBe(false);
  });

  it('accepts slugs and rejects anything else', () => {
    expect(ROLE_CAPABILITY_PATTERN.test('continuous-improvement')).toBe(true);
    expect(ROLE_CAPABILITY_PATTERN.test('Continuous Improvement')).toBe(false);
    expect(ROLE_CAPABILITY_PATTERN.test('')).toBe(false);
    expect(ROLE_CAPABILITY_PATTERN.test('-leading')).toBe(false);
  });
});

describe('the shipped registry seed', () => {
  it('declares continuous-improvement on every model-worker role', () => {
    expect(rolesWithCapability(seeded(), 'continuous-improvement')).toEqual(EXPECTED_ENROLLED);
  });

  it('leaves ingress out — it is a transport role', () => {
    expect(roleCapabilities(seeded().roles.ingress)).toEqual([]);
  });

  it('never puts a role capability in required_capabilities', () => {
    // The whole reason the field exists: `required_capabilities` is matched
    // against a model entry, so `continuous-improvement` there is unresolvable.
    const reg = seeded();
    for (const [id, role] of Object.entries(reg.roles)) {
      expect(role.required_capabilities, id).not.toContain('continuous-improvement');
    }
  });

  it('keeps every role resolvable — no entry needs a continuous-improvement tag', () => {
    const reg = seeded();
    for (const [id, role] of Object.entries(reg.roles)) {
      const candidates = reg.tiers[role.tier] ?? [];
      const viable = candidates.filter((e) => validateCandidate(reg, e, { role }).length === 0);
      expect(viable.length, `role ${id} has no viable entry in tier ${role.tier}`).toBeGreaterThan(0);
    }
  });

  it('is ignored by candidate validation entirely', () => {
    const reg = seeded();
    const role = reg.roles.revenue_ops;
    const entry = (reg.tiers[role.tier] ?? [])[0];
    const withNonsense: ModelRoleAssignment = { ...role, role_capabilities: ['not-a-model-tag-at-all'] };
    expect(validateCandidate(reg, entry, { role: withNonsense }))
      .toEqual(validateCandidate(reg, entry, { role: { ...role, role_capabilities: [] } }));
  });
});
