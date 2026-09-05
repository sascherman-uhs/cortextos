import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_ORG,
  agentsDir,
  RegistryConflictError,
  RegistryNotFoundError,
  SwitchLockedError,
  acquireSwitchLock,
  activationFor,
  adapterHostsRuntime,
  applyOperation,
  authSourcePresent,
  isFallbackEligible,
  isPinDispatchable,
  isPinExpired,
  listAttempts,
  listEvents,
  loadRegistry,
  migrateBootstrap,
  observeClaudeModel,
  observeCodexModel,
  promptCorrelates,
  probeEntryHealth,
  recordAttempt,
  releaseSwitchLock,
  resolve,
  resolveRegistryPaths,
  saveRegistryCAS,
  spawnDecision,
  updateAttemptObserved,
  validateCandidate,
  type RegistryContext,
} from '../../../src/bus/model-registry.js';
import type { ModelRegistry, ModelRestartResult } from '../../../src/types/index.js';

// ---------------------------------------------------------------------------
// Fixture: a miniature registry that mirrors the shape of the real UHS one,
// including the canonical invalid pair (trillion-coder: Anthropic model id on
// the codex runtime).
// ---------------------------------------------------------------------------

const FROZEN = new Date('2026-09-05T12:00:00.000Z');

function fixtureRegistry(): ModelRegistry {
  return {
    schema_version: 1,
    revision: 1,
    updated_at: '2026-09-05T00:00:00Z',
    updated_by: 'test',
    activation: { org_default: 'shadow', consumers: { 'trillion-coder': 'shadow' } },
    adapters: {
      'claude-code': {
        version: 1,
        selection: 'cli:--model',
        observed_source: 'claude-transcript',
        supports: ['tools'],
        auth_source: null,
      },
      'codex-app-server': {
        version: 1,
        selection: 'app-server:thread/turn model',
        observed_source: 'codex-rollout',
        supports: ['tools'],
        auth_source: null,
      },
      kimi: { version: 1, selection: 'cli:--model', observed_source: null, supports: [], auth_source: null },
      'openai-api': {
        version: 1,
        selection: 'sdk:model',
        observed_source: 'response.model',
        supports: [],
        auth_source: 'env:UNSET_KEY_FOR_TEST',
        hosts_runtimes: [],
      },
    },
    entries: {
      'anthropic-haiku': {
        model_id: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['conversation', 'tool-use', 'structured-output', 'scoped-retrieval'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 1,
        auth_source: null,
        status: 'active',
      },
      'anthropic-sonnet': {
        model_id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['conversation', 'tool-use', 'structured-output', 'scoped-retrieval', 'planning'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 3,
        auth_source: null,
        status: 'active',
      },
      'anthropic-opus': {
        model_id: 'claude-opus-5',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['conversation', 'tool-use', 'structured-output', 'scoped-retrieval', 'planning'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 4,
        auth_source: null,
        status: 'active',
      },
      'anthropic-retired': {
        model_id: 'claude-retired-1',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['conversation', 'tool-use', 'structured-output', 'scoped-retrieval', 'planning'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 1,
        auth_source: null,
        status: 'deprecated',
      },
      'small-context': {
        model_id: 'tiny-1',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['conversation', 'tool-use', 'structured-output', 'scoped-retrieval', 'planning'],
        context_window: 8000,
        billing_mode: 'subscription_quota',
        cost_class: 0,
        auth_source: null,
        status: 'active',
      },
      'codex-builder': {
        model_id: 'gpt-5-codex',
        provider: 'openai',
        runtime_adapter: 'codex-app-server',
        capability_tags: ['coding', 'tool-use', 'sandbox'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 2,
        auth_source: null,
        status: 'active',
      },
      'needs-missing-key': {
        model_id: 'gpt-4o',
        provider: 'openai',
        runtime_adapter: 'openai-api',
        capability_tags: ['structured-output'],
        context_window: 128000,
        billing_mode: 'api_cash',
        cost_class: 3,
        auth_source: 'env:UNSET_KEY_FOR_TEST',
        status: 'active',
        health_probe: { kind: 'env-key' },
      },
    },
    tiers: {
      economy: ['anthropic-haiku', 'codex-builder'],
      standard: ['anthropic-sonnet', 'codex-builder'],
      premium: ['anthropic-opus'],
      empty: [],
      broken: ['anthropic-retired', 'small-context'],
    },
    org_default_tier: 'standard',
    roles: {
      dispatcher: {
        tier: 'standard',
        required_capabilities: ['structured-output', 'planning', 'scoped-retrieval'],
        min_context: 100000,
        data_scope: 'org',
      },
      listing_intel: {
        tier: 'economy',
        required_capabilities: ['structured-output', 'scoped-retrieval'],
        min_context: 50000,
        data_scope: 'org',
      },
      builder: {
        tier: 'economy',
        required_capabilities: ['coding', 'tool-use', 'sandbox'],
        min_context: 100000,
        data_scope: 'repos',
      },
    },
    agents: {
      'jarvis-orchestrator': { role: 'dispatcher', pin: null },
      'jarvis-heartbeat': { role: 'dispatcher', pin: null },
      'jarvis-mls': { role: 'listing_intel', pin: null },
      'trillion-coder': { role: 'builder', pin: null },
    },
    callsites: {
      'jarvis:scripts/email_triage/drafter.py': { role: 'dispatcher' },
    },
  };
}

let root: string;
let ctx: RegistryContext;

function writeAgentConfig(agent: string, config: Record<string, unknown>): void {
  const dir = join(root, 'orgs', DEFAULT_ORG, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function seed(reg: ModelRegistry = fixtureRegistry()): void {
  const orgDir = join(root, 'orgs', DEFAULT_ORG);
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(orgDir, 'model-registry.json'), JSON.stringify(reg, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-model-registry-'));
  ctx = { root, org: DEFAULT_ORG, frameworkRoot: root, ctxRoot: root, now: () => FROZEN };
  seed();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('paths and load', () => {
  it('places the registry, events and lock under orgs/<org>/', () => {
    const paths = resolveRegistryPaths(ctx);
    expect(paths.registryPath).toBe(join(root, 'orgs', 'uhs', 'model-registry.json'));
    expect(paths.eventsDir).toBe(join(root, 'orgs', 'uhs', 'model-events'));
    expect(paths.attemptsDir).toBe(join(root, 'orgs', 'uhs', 'model-events', 'attempts'));
    expect(paths.lockPath).toBe(join(root, 'orgs', 'uhs', '.model-switch.lock'));
  });

  it('throws a recoverable error when the registry is absent', () => {
    rmSync(join(root, 'orgs', 'uhs', 'model-registry.json'));
    expect(() => loadRegistry(ctx)).toThrow(RegistryNotFoundError);
    expect(() => loadRegistry(ctx)).toThrow(/model migrate --bootstrap/);
  });
});

describe('CAS writes', () => {
  it('increments the revision and stamps the actor', () => {
    const reg = loadRegistry(ctx);
    reg.updated_by = 'scott';
    const written = saveRegistryCAS(reg, 1, ctx);
    expect(written.revision).toBe(2);
    expect(written.updated_by).toBe('scott');
    expect(loadRegistry(ctx).revision).toBe(2);
  });

  it('refuses a write whose expected revision is stale', () => {
    const reg = loadRegistry(ctx);
    saveRegistryCAS(reg, 1, ctx); // someone else wrote revision 2
    expect(() => saveRegistryCAS(reg, 1, ctx)).toThrow(RegistryConflictError);
  });
});

describe('validation matrix', () => {
  it('accepts an entry that satisfies its role', () => {
    const reg = loadRegistry(ctx);
    expect(validateCandidate(reg, 'anthropic-sonnet', { role: reg.roles.dispatcher })).toEqual([]);
  });

  it('rejects an unknown entry', () => {
    const reg = loadRegistry(ctx);
    expect(validateCandidate(reg, 'nope')[0].code).toBe('entry_not_found');
  });

  it('rejects a non-active entry', () => {
    const reg = loadRegistry(ctx);
    const codes = validateCandidate(reg, 'anthropic-retired', { role: reg.roles.dispatcher }).map((e) => e.code);
    expect(codes).toContain('entry_not_active');
  });

  it('rejects a model whose adapter cannot host the agent runtime', () => {
    const reg = loadRegistry(ctx);
    const codes = validateCandidate(reg, 'anthropic-sonnet', {
      role: reg.roles.builder,
      agentRuntime: 'codex-app-server',
    }).map((e) => e.code);
    expect(codes).toContain('adapter_runtime_mismatch');
  });

  it('rejects a model missing a required capability', () => {
    const reg = loadRegistry(ctx);
    const codes = validateCandidate(reg, 'anthropic-haiku', { role: reg.roles.dispatcher }).map((e) => e.code);
    expect(codes).toContain('missing_capabilities');
  });

  it('rejects a model whose context window is under the role minimum', () => {
    const reg = loadRegistry(ctx);
    const codes = validateCandidate(reg, 'small-context', { role: reg.roles.dispatcher }).map((e) => e.code);
    expect(codes).toContain('context_window_too_small');
  });

  it('rejects an entry whose auth source is absent', () => {
    delete process.env.UNSET_KEY_FOR_TEST;
    const reg = loadRegistry(ctx);
    const codes = validateCandidate(reg, 'needs-missing-key').map((e) => e.code);
    expect(codes).toContain('auth_missing');
  });

  it('checks auth by NAME only, never by value', () => {
    delete process.env.UNSET_KEY_FOR_TEST;
    expect(authSourcePresent('env:UNSET_KEY_FOR_TEST')).toBe(false);
    process.env.UNSET_KEY_FOR_TEST = 'x';
    expect(authSourcePresent('env:UNSET_KEY_FOR_TEST')).toBe(true);
    delete process.env.UNSET_KEY_FOR_TEST;
    expect(authSourcePresent(null)).toBe(true);
  });

  it('knows which adapters can host which agent runtimes', () => {
    const reg = loadRegistry(ctx);
    expect(adapterHostsRuntime(reg, 'claude-code', 'claude-code')).toBe(true);
    expect(adapterHostsRuntime(reg, 'claude-code', 'kimi')).toBe(false);
    // hosts_runtimes: [] means "cannot back a PTY agent at all"
    expect(adapterHostsRuntime(reg, 'openai-api', 'openai-api')).toBe(false);
  });

  it('is the canonical trillion-coder invalid-pair check', () => {
    const reg = loadRegistry(ctx);
    // trillion-coder pairs a Claude model id with the codex runtime.
    const errors = validateCandidate(reg, 'anthropic-sonnet', {
      role: reg.roles.builder,
      agentRuntime: 'codex-app-server',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['adapter_runtime_mismatch', 'missing_capabilities']),
    );
  });
});

describe('resolve precedence', () => {
  it('falls back to the org default tier when nothing else applies', () => {
    const res = resolve({ agent: 'unknown-agent' }, ctx);
    expect(res.requested.source).toBe('org_default');
    expect(res.requested.tier).toBe('standard');
    expect(res.selected?.entry_id).toBe('anthropic-sonnet');
  });

  it('uses the role assignment for a known agent', () => {
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    expect(res.requested.source).toBe('role');
    expect(res.role).toBe('listing_intel');
    expect(res.selected?.entry_id).toBe('anthropic-haiku');
  });

  it('uses the role assignment for a known call site', () => {
    const res = resolve({ callsite: 'jarvis:scripts/email_triage/drafter.py' }, ctx);
    expect(res.role).toBe('dispatcher');
    expect(res.selected?.entry_id).toBe('anthropic-sonnet');
  });

  it('prefers a valid pin over the role', () => {
    const reg = loadRegistry(ctx);
    reg.agents['jarvis-mls'].pin = {
      entry_id: 'anthropic-opus',
      kind: 'explicit',
      reason: 'test',
      actor: 'scott',
      created_at: FROZEN.toISOString(),
      expires_at: null,
    };
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    expect(res.requested.source).toBe('pin');
    expect(res.selected?.entry_id).toBe('anthropic-opus');
  });

  it('prefers an authorized task override over a pin', () => {
    const reg = loadRegistry(ctx);
    reg.agents['jarvis-mls'].pin = {
      entry_id: 'anthropic-opus',
      kind: 'explicit',
      reason: 'test',
      actor: 'scott',
      created_at: FROZEN.toISOString(),
      expires_at: null,
    };
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve(
      { agent: 'jarvis-mls', override: { entry_id: 'anthropic-haiku', actor: 'scott', reason: 'one-off' } },
      ctx,
    );
    expect(res.requested.source).toBe('override');
    expect(res.selected?.entry_id).toBe('anthropic-haiku');
  });

  it('ignores an expired pin and inherits the role, with a warning', () => {
    const reg = loadRegistry(ctx);
    reg.agents['jarvis-mls'].pin = {
      entry_id: 'anthropic-opus',
      kind: 'legacy-migration',
      reason: 'test',
      actor: 'jarvis',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-01T00:00:00Z',
    };
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    expect(res.requested.source).toBe('role');
    expect(res.validation.warnings.join(' ')).toMatch(/expired/);
  });

  it('never dispatches a proposed-invalid pin', () => {
    const reg = loadRegistry(ctx);
    reg.agents['trillion-coder'].pin = {
      entry_id: 'anthropic-sonnet',
      kind: 'proposed-invalid',
      reason: 'invalid legacy pair',
      actor: 'jarvis',
      created_at: FROZEN.toISOString(),
      expires_at: null,
    };
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve({ agent: 'trillion-coder' }, ctx);
    expect(res.requested.source).not.toBe('pin');
    expect(res.validation.errors.map((e) => e.code)).toContain('pin_not_dispatchable');
  });

  it('filters candidates by the agent runtime declared in config.json', () => {
    writeAgentConfig('trillion-coder', { model: 'claude-sonnet-4-6', runtime: 'codex-app-server' });
    const res = resolve({ agent: 'trillion-coder' }, ctx);
    // The economy tier lists haiku first, but only the codex entry can run here.
    expect(res.candidates).toEqual(['codex-builder']);
    expect(res.selected?.entry_id).toBe('codex-builder');
    expect(res.legacy_effective).toEqual({ model_id: 'claude-sonnet-4-6', runtime: 'codex-app-server' });
  });

  it('reports an empty tier rather than silently choosing something expensive', () => {
    const reg = loadRegistry(ctx);
    reg.roles.dispatcher.tier = 'empty';
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    expect(res.selected).toBeNull();
    expect(res.validation.errors.map((e) => e.code)).toContain('tier_empty');
  });

  it('reports no route when every tier candidate fails validation', () => {
    const reg = loadRegistry(ctx);
    reg.roles.dispatcher.tier = 'broken';
    saveRegistryCAS(reg, 1, ctx);
    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    expect(res.selected).toBeNull();
    expect(res.validation.ok).toBe(false);
  });
});

describe('shadow vs enforced', () => {
  it('shadow reports but never changes what runs', () => {
    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    expect(res.activation).toBe('shadow');
    const decision = spawnDecision(res);
    expect(decision.modelOverride).toBeNull();
    expect(decision.refuse).toBe(false);
  });

  it('shadow keeps the legacy dispatch even when validation fails', () => {
    const reg = loadRegistry(ctx);
    reg.roles.dispatcher.tier = 'empty';
    saveRegistryCAS(reg, 1, ctx);
    const decision = spawnDecision(resolve({ agent: 'jarvis-orchestrator' }, ctx));
    expect(decision.refuse).toBe(false);
    expect(decision.modelOverride).toBeNull();
  });

  it('enforced passes the resolved model explicitly', () => {
    const reg = loadRegistry(ctx);
    reg.activation.consumers['jarvis-orchestrator'] = 'enforced';
    saveRegistryCAS(reg, 1, ctx);
    const decision = spawnDecision(resolve({ agent: 'jarvis-orchestrator' }, ctx));
    expect(decision.modelOverride).toBe('claude-sonnet-4-6');
    expect(decision.refuse).toBe(false);
  });

  it('enforced refuses a spawn with no valid route', () => {
    const reg = loadRegistry(ctx);
    reg.activation.consumers['jarvis-orchestrator'] = 'enforced';
    reg.roles.dispatcher.tier = 'empty';
    saveRegistryCAS(reg, 1, ctx);
    const decision = spawnDecision(resolve({ agent: 'jarvis-orchestrator' }, ctx));
    expect(decision.refuse).toBe(true);
    expect(decision.modelOverride).toBeNull();
  });

  it('resolves activation per consumer with an org default', () => {
    const reg = loadRegistry(ctx);
    reg.activation.org_default = 'enforced';
    reg.activation.consumers['trillion-coder'] = 'shadow';
    expect(activationFor(reg, 'trillion-coder')).toBe('shadow');
    expect(activationFor(reg, 'jarvis-mls')).toBe('enforced');
  });
});

describe('pin helpers', () => {
  const base = { entry_id: 'x', reason: 'r', actor: 'a', created_at: '2026-01-01T00:00:00Z' };
  it('treats a past expiry as expired', () => {
    expect(isPinExpired({ ...base, kind: 'explicit', expires_at: '2026-01-02T00:00:00Z' }, FROZEN)).toBe(true);
    expect(isPinExpired({ ...base, kind: 'explicit', expires_at: '2027-01-02T00:00:00Z' }, FROZEN)).toBe(false);
    expect(isPinExpired({ ...base, kind: 'explicit', expires_at: null }, FROZEN)).toBe(false);
  });
  it('never treats a proposed-invalid pin as dispatchable', () => {
    expect(isPinDispatchable({ ...base, kind: 'proposed-invalid', expires_at: null }, FROZEN)).toBe(false);
    expect(isPinDispatchable({ ...base, kind: 'explicit', expires_at: null }, FROZEN)).toBe(true);
    expect(isPinDispatchable(null, FROZEN)).toBe(false);
  });
});

describe('fallback class filter', () => {
  it('allows only outage/quota/auth/spawn', () => {
    for (const ok of ['spawn', 'auth', 'quota', 'outage']) expect(isFallbackEligible(ok)).toBe(true);
    for (const no of ['quality', 'refusal', 'policy', 'invalid_config', 'missing_tool']) {
      expect(isFallbackEligible(no)).toBe(false);
    }
  });
});

describe('event and attempt journaling', () => {
  it('records an attempt at spawn and updates it when an observation arrives', () => {
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    const { path } = recordAttempt({ consumer: 'jarvis-mls', resolution: res, sessionRef: 'sess-1' }, ctx);
    let rec = JSON.parse(readFileSync(path, 'utf-8'));
    expect(rec.observed.confidence).toBe('unconfirmed');
    expect(rec.model_id).toBe('claude-haiku-4-5-20251001');

    rec = updateAttemptObserved(path, { model_id: 'claude-haiku-4-5-20251001', source: 'claude-transcript' }, ctx);
    expect(rec.observed.confidence).toBe('verified');
  });

  it('marks a contradicting observation as a mismatch', () => {
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    const { path } = recordAttempt({ consumer: 'jarvis-mls', resolution: res }, ctx);
    const rec = updateAttemptObserved(path, { model_id: 'claude-opus-5', source: 'claude-transcript' }, ctx);
    expect(rec!.observed.confidence).toBe('mismatch');
  });

  it('lists attempts newest-first', () => {
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    recordAttempt({ consumer: 'jarvis-mls', resolution: res }, ctx);
    recordAttempt({ consumer: 'jarvis-orchestrator', resolution: res }, ctx);
    expect(listAttempts(ctx).length).toBe(2);
  });

  it('appends one event file per state transition and never rewrites one', async () => {
    const before = existsSync(resolveRegistryPaths(ctx).eventsDir)
      ? readdirSync(resolveRegistryPaths(ctx).eventsDir).length
      : 0;
    await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'cheaper night shift' },
      { ...ctx, skipRestart: true },
    );
    const files = readdirSync(resolveRegistryPaths(ctx).eventsDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(before);
    const states = listEvents(ctx).map((e) => e.state);
    expect(states).toEqual(expect.arrayContaining(['requested', 'validated', 'desired_written', 'applied']));
  });
});

describe('operations', () => {
  it('switches a role tier and journals a receipt', async () => {
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'testing premium' },
      { ...ctx, skipRestart: true },
    );
    expect(receipt.state).toBe('applied');
    expect(receipt.registry_revision_after).toBe(2);
    expect(loadRegistry(ctx).roles.dispatcher.tier).toBe('premium');
    expect(receipt.affected_consumers).toEqual(expect.arrayContaining(['jarvis-orchestrator', 'jarvis-heartbeat']));
  });

  it('opts affected consumers into enforced routing on an explicit switch', async () => {
    await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, skipRestart: true },
    );
    const reg = loadRegistry(ctx);
    expect(reg.activation.consumers['jarvis-orchestrator']).toBe('enforced');
    // Untouched consumers stay on the org default.
    expect(reg.activation.consumers['jarvis-mls']).toBeUndefined();
  });

  it('refuses a switch onto a tier no entry can satisfy', async () => {
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'broken', actor: 'scott', reason: 'x' },
      { ...ctx, skipRestart: true },
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.error).toMatch(/satisfies role/);
    expect(loadRegistry(ctx).roles.dispatcher.tier).toBe('standard');
  });

  it('fails a switch whose expected revision is stale', async () => {
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x', expectedRevision: 99 },
      { ...ctx, skipRestart: true },
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.error).toMatch(/revision conflict/i);
  });

  it('excludes pinned agents from a role switch unless --clear-pins', async () => {
    const reg = loadRegistry(ctx);
    reg.agents['jarvis-heartbeat'].pin = {
      entry_id: 'anthropic-opus',
      kind: 'explicit',
      reason: 'held',
      actor: 'scott',
      created_at: FROZEN.toISOString(),
      expires_at: null,
    };
    saveRegistryCAS(reg, 1, ctx);

    const held = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, skipRestart: true },
    );
    expect(held.affected_consumers).toEqual(['jarvis-orchestrator']);

    const cleared = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'standard', actor: 'scott', reason: 'y', clearPins: true },
      { ...ctx, skipRestart: true },
    );
    expect(cleared.affected_consumers).toEqual(expect.arrayContaining(['jarvis-heartbeat']));
    expect(loadRegistry(ctx).agents['jarvis-heartbeat'].pin).toBeNull();
  });

  it('pins and unpins one agent', async () => {
    const pinned = await applyOperation(
      {
        kind: 'pin',
        agent: 'jarvis-mls',
        entry_id: 'anthropic-sonnet',
        actor: 'scott',
        reason: 'needs planning for a week',
        expiresAt: '2026-10-05T00:00:00Z',
      },
      { ...ctx, skipRestart: true },
    );
    expect(pinned.state).toBe('applied');
    expect(loadRegistry(ctx).agents['jarvis-mls'].pin?.entry_id).toBe('anthropic-sonnet');

    const unpinned = await applyOperation(
      { kind: 'unpin', agent: 'jarvis-mls', actor: 'scott', reason: 'done' },
      { ...ctx, skipRestart: true },
    );
    expect(unpinned.state).toBe('applied');
    expect(loadRegistry(ctx).agents['jarvis-mls'].pin).toBeNull();
  });

  it('refuses a pin whose expiry is already past', async () => {
    const receipt = await applyOperation(
      {
        kind: 'pin',
        agent: 'jarvis-mls',
        entry_id: 'anthropic-sonnet',
        actor: 'scott',
        reason: 'x',
        expiresAt: '2026-01-01T00:00:00Z',
      },
      { ...ctx, skipRestart: true },
    );
    expect(receipt.state).toBe('failed');
    expect(receipt.error).toMatch(/already in the past/);
  });

  it('changes activation for one consumer and for the org', async () => {
    await applyOperation(
      { kind: 'activation', consumer: 'jarvis-mls', mode: 'enforced', actor: 'scott', reason: 'ready' },
      { ...ctx, skipRestart: true },
    );
    expect(loadRegistry(ctx).activation.consumers['jarvis-mls']).toBe('enforced');

    await applyOperation(
      { kind: 'activation', org: true, mode: 'enforced', actor: 'scott', reason: 'three clean days' },
      { ...ctx, skipRestart: true },
    );
    expect(loadRegistry(ctx).activation.org_default).toBe('enforced');
  });

  it('reverts a switch back to the recorded prior tier', async () => {
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, skipRestart: true },
    );
    expect(loadRegistry(ctx).roles.dispatcher.tier).toBe('premium');

    const reverted = await applyOperation(
      { kind: 'revert', operation_id: receipt.operation_id, actor: 'scott', reason: 'undo' },
      { ...ctx, skipRestart: true },
    );
    expect(reverted.state).toBe('applied');
    expect(loadRegistry(ctx).roles.dispatcher.tier).toBe('standard');
    // The revision moves forward — a revert is a new operation, not a rewind.
    expect(loadRegistry(ctx).revision).toBe(3);
  });

  it('restarts affected agents at concurrency one and reads the route back', async () => {
    const inFlight: string[] = [];
    const order: string[] = [];
    const restart = async (agent: string): Promise<ModelRestartResult> => {
      inFlight.push(agent);
      expect(inFlight.length).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(agent);
      inFlight.pop();
      return { agent, ok: true, detail: 'restarted' };
    };
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, restart },
    );
    expect(receipt.state).toBe('applied');
    expect(order.length).toBe(2);
    expect(receipt.restart_results.every((r) => r.observed_after === 'claude-opus-5')).toBe(true);
    // The lock is released once the operation finishes.
    expect(existsSync(resolveRegistryPaths(ctx).lockPath)).toBe(false);
  });

  it('marks the operation blocked when the drain deadline passes', async () => {
    const restart = async (agent: string): Promise<ModelRestartResult> => {
      await new Promise((r) => setTimeout(r, 20));
      return { agent, ok: true, detail: 'restarted' };
    };
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, restart, drainDeadlineMs: 10 },
    );
    expect(receipt.state).toBe('blocked');
    expect(receipt.error).toMatch(/Drain deadline/);
    // The desired route is still written — the switch is not lost.
    expect(loadRegistry(ctx).roles.dispatcher.tier).toBe('premium');
  });

  it('marks the operation blocked when a restart fails', async () => {
    const restart = async (agent: string): Promise<ModelRestartResult> => ({
      agent,
      ok: false,
      detail: 'daemon not running',
    });
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, restart },
    );
    expect(receipt.state).toBe('blocked');
    expect(receipt.error).toMatch(/did not restart/);
  });

  it('refuses to start a second switch while a live lock is held', async () => {
    acquireSwitchLock('op_other', ['jarvis-orchestrator'], ctx);
    const receipt = await applyOperation(
      { kind: 'switch', role: 'dispatcher', tier: 'premium', actor: 'scott', reason: 'x' },
      { ...ctx, restart: async (agent) => ({ agent, ok: true, detail: 'ok' }) },
    );
    expect(receipt.state).toBe('blocked');
    expect(receipt.error).toMatch(/already in progress/);
    releaseSwitchLock('op_other', ctx);
  });

  it('rejects a duplicate lock acquisition outright', () => {
    acquireSwitchLock('op_a', ['x'], ctx);
    expect(() => acquireSwitchLock('op_b', ['y'], ctx)).toThrow(SwitchLockedError);
    releaseSwitchLock('op_a', ctx);
    expect(() => acquireSwitchLock('op_b', ['y'], ctx)).not.toThrow();
    releaseSwitchLock('op_b', ctx);
  });
});

describe('bootstrap migration', () => {
  beforeEach(() => {
    writeAgentConfig('jarvis-mls', { model: 'claude-haiku-4-5-20251001' });
    writeAgentConfig('jarvis-orchestrator', { model: 'claude-sonnet-4-6' });
    writeAgentConfig('trillion-coder', { model: 'claude-sonnet-4-6', runtime: 'codex-app-server' });
    writeAgentConfig('jarvis-heartbeat', { model: 'some-model-nobody-registered' });
  });

  it('imports valid legacy pairs as 30-day legacy-migration pins', () => {
    const result = migrateBootstrap({ ...ctx, createHumanTask: () => 'task_stub' });
    const pinned = result.legacy_pins.map((p) => p.agent);
    expect(pinned).toEqual(expect.arrayContaining(['jarvis-mls', 'jarvis-orchestrator']));
    const reg = loadRegistry(ctx);
    const pin = reg.agents['jarvis-mls'].pin!;
    expect(pin.kind).toBe('legacy-migration');
    expect(pin.entry_id).toBe('anthropic-haiku');
    expect(Date.parse(pin.expires_at!) - FROZEN.getTime()).toBe(30 * 86400_000);
  });

  it('records an invalid legacy pair as a non-dispatchable pin plus a human task', () => {
    const titles: string[] = [];
    const result = migrateBootstrap({
      ...ctx,
      createHumanTask: (title) => {
        titles.push(title);
        return 'task_123';
      },
    });
    const invalid = result.proposed_invalid.find((p) => p.agent === 'trillion-coder');
    expect(invalid).toBeTruthy();
    expect(invalid!.task_id).toBe('task_123');
    expect(titles).toContain('[HUMAN] Model routing: invalid legacy pair for trillion-coder');

    const pin = loadRegistry(ctx).agents['trillion-coder'].pin!;
    expect(pin.kind).toBe('proposed-invalid');
    expect(isPinDispatchable(pin, FROZEN)).toBe(false);
    // …and it must never dispatch.
    const res = resolve({ agent: 'trillion-coder' }, ctx);
    expect(res.requested.source).not.toBe('pin');
  });

  it('reports a literal model that no entry claims, rather than inventing one', () => {
    const result = migrateBootstrap({ ...ctx, createHumanTask: () => null });
    expect(result.unmatched.map((u) => u.agent)).toContain('jarvis-heartbeat');
    expect(loadRegistry(ctx).agents['jarvis-heartbeat'].pin).toBeNull();
  });

  it('never edits an agent config.json', () => {
    const p = join(root, 'orgs', DEFAULT_ORG, 'agents', 'trillion-coder', 'config.json');
    const before = readFileSync(p, 'utf-8');
    migrateBootstrap({ ...ctx, createHumanTask: () => null });
    expect(readFileSync(p, 'utf-8')).toBe(before);
  });

  it('writes nothing on a dry run', () => {
    const result = migrateBootstrap({ ...ctx, dryRun: true, createHumanTask: () => null });
    expect(result.legacy_pins.length).toBeGreaterThan(0);
    expect(loadRegistry(ctx).revision).toBe(1);
    expect(loadRegistry(ctx).agents['jarvis-mls'].pin).toBeNull();
  });
});

describe('observed-model capture', () => {
  it('reads the newest assistant message.model and ignores <synthetic>', () => {
    const projects = join(root, 'claude-projects');
    const cwd = '/Users/test/agent';
    const dir = join(projects, cwd.replace(/[/.\\ ]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-1.jsonl'),
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }),
        JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
      ].join('\n'),
    );
    const observed = observeClaudeModel({ cwd, sessionId: 'sess-1', projectsRoot: projects });
    expect(observed).toEqual({
      model_id: 'claude-haiku-4-5-20251001',
      source: 'claude-transcript',
      binding: 'session-id',
    });
  });

  it('returns null when there is no transcript rather than guessing from config', () => {
    expect(observeClaudeModel({ cwd: '/nope/nothing', projectsRoot: join(root, 'claude-projects') })).toBeNull();
  });

  // --- shared-cwd binding (the production defect) ------------------------
  //
  // jarvis-accounting and jarvis-estimator both run in .../uhsEstimate, and
  // five agents share .../uhsJARVIS. "Newest .jsonl in the slug directory"
  // therefore attributed one agent's model to another.

  const SHARED_CWD = '/Users/test/shared-workspace';

  function seedTranscripts(): { projects: string; dir: string } {
    const projects = join(root, 'claude-projects');
    const dir = join(projects, SHARED_CWD.replace(/[/.\\ ]/g, '-'));
    mkdirSync(dir, { recursive: true });
    // Agent A: started earlier, runs haiku, boot prompt A.
    writeFileSync(
      join(dir, 'sess-a.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: 'You are jarvis-accounting. Reconcile the ledger.' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001' } }),
      ].join('\n'),
    );
    // Agent B: newest file in the same directory, runs sonnet.
    writeFileSync(
      join(dir, 'sess-b.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: 'You are jarvis-estimator. Price the proposal.' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }),
      ].join('\n'),
    );
    const old = new Date('2026-09-05T11:00:00Z');
    const recent = new Date('2026-09-05T12:05:00Z');
    utimesSync(join(dir, 'sess-a.jsonl'), old, old);
    utimesSync(join(dir, 'sess-b.jsonl'), recent, recent);
    return { projects, dir };
  }

  it('binds by session id, not by newest file, when two agents share a cwd', () => {
    const { projects } = seedTranscripts();
    const observed = observeClaudeModel({ cwd: SHARED_CWD, sessionId: 'sess-a', projectsRoot: projects });
    expect(observed?.model_id).toBe('claude-haiku-4-5-20251001');
    expect(observed?.binding).toBe('session-id');
  });

  it('returns null when the bound session has no transcript, instead of falling back to a neighbour', () => {
    const { projects } = seedTranscripts();
    expect(
      observeClaudeModel({ cwd: SHARED_CWD, sessionId: 'sess-nonexistent', projectsRoot: projects }),
    ).toBeNull();
  });

  it('correlates by boot prompt when no session id is available', () => {
    const { projects } = seedTranscripts();
    const observed = observeClaudeModel({
      cwd: SHARED_CWD,
      since: new Date('2026-09-05T10:00:00Z'),
      bootPrompt: 'You are jarvis-accounting. Reconcile the ledger.',
      projectsRoot: projects,
    });
    // The newest file (sess-b) does NOT win — the prompt says whose it is.
    expect(observed?.model_id).toBe('claude-haiku-4-5-20251001');
    expect(observed?.binding).toBe('prompt-correlated');
  });

  it('ignores a transcript last written before the spawn, however recently touched', () => {
    const { projects } = seedTranscripts();
    expect(
      observeClaudeModel({
        cwd: SHARED_CWD,
        since: new Date('2026-09-05T12:00:00Z'), // after sess-a's mtime
        bootPrompt: 'You are jarvis-accounting. Reconcile the ledger.',
        projectsRoot: projects,
      }),
    ).toBeNull();
  });

  it('reports nothing (never a guess) when neither a session id nor a boot prompt is available', () => {
    const { projects } = seedTranscripts();
    expect(
      observeClaudeModel({ cwd: SHARED_CWD, since: new Date('2026-09-05T10:00:00Z'), projectsRoot: projects }),
    ).toBeNull();
  });

  it('does not correlate on a boot prompt too short to identify a session', () => {
    expect(promptCorrelates('You are jarvis-accounting. Reconcile the ledger.', 'hello')).toBe(false);
  });

  it('skips a <synthetic> placeholder in a session-bound transcript', () => {
    const projects = join(root, 'claude-projects');
    const dir = join(projects, SHARED_CWD.replace(/[/.\\ ]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-syn.jsonl'),
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6' } }),
        JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
      ].join('\n'),
    );
    const observed = observeClaudeModel({ cwd: SHARED_CWD, sessionId: 'sess-syn', projectsRoot: projects });
    expect(observed?.model_id).toBe('claude-sonnet-4-6');
  });

  it('reads turn_context.payload.model from a codex rollout bound by thread id', () => {
    const sessions = join(root, 'codex-sessions', '2026', '09', '05');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, 'rollout-2026-09-05T12-00-00-thread_abc.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread_abc' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/x' } }),
      ].join('\n'),
    );
    const observed = observeCodexModel({ threadId: 'thread_abc', sessionsRoot: join(root, 'codex-sessions') });
    expect(observed).toEqual({ model_id: 'gpt-5-codex', source: 'codex-rollout', binding: 'thread-id' });
  });

  it('returns null for a codex thread with no matching rollout', () => {
    mkdirSync(join(root, 'codex-sessions'), { recursive: true });
    expect(observeCodexModel({ threadId: 'thread_missing', sessionsRoot: join(root, 'codex-sessions') })).toBeNull();
  });
});

describe('observation confidence baseline (shadow vs enforced)', () => {
  // In shadow the registry's pick is a PROPOSAL: the legacy config model is
  // what actually runs. Comparing the observation against the proposal made
  // every correctly-behaving shadow agent look like a mismatch.
  it('compares a shadow observation against the legacy model that actually ran', () => {
    writeAgentConfig('jarvis-orchestrator', { model: 'claude-haiku-4-5-20251001' });
    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    expect(res.activation).toBe('shadow');
    expect(res.selected!.model_id).toBe('claude-sonnet-4-6');

    const { path } = recordAttempt({ consumer: 'jarvis-orchestrator', resolution: res }, ctx);
    expect(JSON.parse(readFileSync(path, 'utf-8')).expected_model_id).toBe('claude-haiku-4-5-20251001');

    const rec = updateAttemptObserved(
      path,
      { model_id: 'claude-haiku-4-5-20251001', source: 'claude-transcript', binding: 'session-id' },
      ctx,
    );
    expect(rec!.observed.confidence).toBe('verified');
  });

  it('still flags a shadow observation that contradicts the legacy model', () => {
    writeAgentConfig('jarvis-orchestrator', { model: 'claude-haiku-4-5-20251001' });
    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    const { path } = recordAttempt({ consumer: 'jarvis-orchestrator', resolution: res }, ctx);
    const rec = updateAttemptObserved(
      path,
      { model_id: 'claude-sonnet-4-6', source: 'claude-transcript', binding: 'session-id' },
      ctx,
    );
    expect(rec!.observed.confidence).toBe('mismatch');
  });

  it('compares an enforced observation against the resolved model', () => {
    const reg = loadRegistry(ctx);
    reg.activation.org_default = 'enforced';
    saveRegistryCAS(reg, reg.revision, ctx);
    writeAgentConfig('jarvis-orchestrator', { model: 'claude-haiku-4-5-20251001' });

    const res = resolve({ agent: 'jarvis-orchestrator' }, ctx);
    const { path } = recordAttempt({ consumer: 'jarvis-orchestrator', resolution: res }, ctx);
    expect(JSON.parse(readFileSync(path, 'utf-8')).expected_model_id).toBe('claude-sonnet-4-6');
    const rec = updateAttemptObserved(
      path,
      { model_id: 'claude-haiku-4-5-20251001', source: 'claude-transcript', binding: 'session-id' },
      ctx,
    );
    expect(rec!.observed.confidence).toBe('mismatch');
  });

  it('leaves an unbound observation unconfirmed rather than verified or mismatch', () => {
    const res = resolve({ agent: 'jarvis-mls' }, ctx);
    const { path } = recordAttempt({ consumer: 'jarvis-mls', resolution: res }, ctx);
    const rec = updateAttemptObserved(
      path,
      { model_id: 'claude-haiku-4-5-20251001', source: 'claude-transcript', binding: 'unbound' },
      ctx,
    );
    expect(rec!.observed.confidence).toBe('unconfirmed');
  });
});

describe('root resolution (registry and agent configs must agree)', () => {
  const ENV_KEYS = ['CTX_MODEL_REGISTRY_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_ROOT', 'CTX_ORG'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads agent configs from the same root the registry resolved from (plain shell → ~/cortextos)', () => {
    // A plain shell with no CTX_* env: the registry falls back to ~/cortextos,
    // so the agents directory must be there too — not nowhere.
    expect(resolveRegistryPaths({}).root).toBe(join(homedir(), 'cortextos'));
    expect(agentsDir({})).toBe(join(homedir(), 'cortextos', 'orgs', DEFAULT_ORG, 'agents'));
  });

  it('scans the agent configs under the root the registry came from (CTX_ROOT, no other env)', () => {
    // Reproduces the deploy defect: the registry resolved through a root that
    // the agent-config reader did not consult, so bootstrap scanned zero
    // configs while still bumping a revision.
    process.env.CTX_ROOT = root;
    writeAgentConfig('jarvis-mls', { model: 'claude-haiku-4-5-20251001' });
    writeAgentConfig('jarvis-orchestrator', { model: 'claude-sonnet-4-6' });

    const bare: RegistryContext = { now: () => FROZEN };
    expect(agentsDir(bare)).toBe(join(root, 'orgs', DEFAULT_ORG, 'agents'));

    const result = migrateBootstrap({ ...bare, createHumanTask: () => null });
    expect(result.scanned).toEqual(expect.arrayContaining(['jarvis-mls', 'jarvis-orchestrator']));
    expect(result.legacy_pins.length).toBe(2);
    expect(loadRegistry(bare).revision).toBe(2);
  });

  it('does not bump the registry revision when it scans zero agent configs', () => {
    process.env.CTX_ROOT = root; // registry present, no agents/ directory at all
    const bare: RegistryContext = { now: () => FROZEN };
    const result = migrateBootstrap({ ...bare, createHumanTask: () => null });

    expect(result.scanned).toEqual([]);
    expect(result.agents_dir).toBe(join(root, 'orgs', DEFAULT_ORG, 'agents'));
    expect(result.registry_revision).toBe(1);
    expect(loadRegistry(bare).revision).toBe(1);
    const eventsDir = resolveRegistryPaths(bare).eventsDir;
    expect(existsSync(eventsDir) ? readdirSync(eventsDir).filter((f) => f.endsWith('.json')) : []).toEqual([]);
  });
});

describe('health probes', () => {
  it('reports an entry whose auth source is absent as unhealthy, without billing anything', async () => {
    delete process.env.UNSET_KEY_FOR_TEST;
    const reg = loadRegistry(ctx);
    const result = await probeEntryHealth(reg, 'needs-missing-key', ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/absent/);
  });

  it('reports a healthy entry as ok', async () => {
    const reg = loadRegistry(ctx);
    const result = await probeEntryHealth(reg, 'anthropic-sonnet', ctx);
    expect(result.ok).toBe(true);
  });

  it('reports an unknown entry rather than throwing', async () => {
    const reg = loadRegistry(ctx);
    const result = await probeEntryHealth(reg, 'nope', ctx);
    expect(result.ok).toBe(false);
  });
});
