/**
 * `cortextos model role-capability …` — the role-level capability field.
 *
 * The point of the field is that it is NOT `required_capabilities`. That one is
 * matched against a model entry's `capability_tags`, so a role property put
 * there makes the role unresolvable. The test that matters most is therefore
 * `does not participate in model resolution`: a role carrying a capability no
 * model has ever heard of must still resolve to a model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { modelCommand } from '../../../src/cli/model.js';
import type { ModelRegistry, ModelOperationReceipt, ModelResolution } from '../../../src/types/index.js';

let root: string;
let logs: string[];
let errors: string[];

function registry(): ModelRegistry {
  return {
    schema_version: 1,
    revision: 1,
    updated_at: '2026-09-05T00:00:00Z',
    updated_by: 'test',
    activation: { org_default: 'shadow', consumers: {} },
    adapters: {
      'claude-code': {
        version: 1,
        selection: 'cli:--model',
        observed_source: 'claude-transcript',
        supports: ['tools'],
        auth_source: null,
      },
    },
    entries: {
      'anthropic-sonnet': {
        model_id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['structured-output', 'scoped-retrieval', 'tool-use', 'conversation'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 3,
        auth_source: null,
        status: 'active',
      },
    },
    tiers: { standard: ['anthropic-sonnet'] },
    org_default_tier: 'standard',
    roles: {
      revenue_ops: {
        tier: 'standard',
        required_capabilities: ['structured-output', 'scoped-retrieval'],
        role_capabilities: [],
        min_context: 50000,
        data_scope: 'org',
      },
      ingress: {
        tier: 'standard',
        required_capabilities: ['conversation'],
        // Deliberately ABSENT, not []: absent must behave as the empty list.
        min_context: 50000,
        data_scope: 'scott',
      },
    },
    agents: { 'jarvis-revenue': { role: 'revenue_ops', pin: null } },
    callsites: {},
  };
}

const registryPath = (): string => join(root, 'orgs', 'uhs', 'model-registry.json');
const readRegistry = (): ModelRegistry => JSON.parse(readFileSync(registryPath(), 'utf-8')) as ModelRegistry;

async function run(argv: string[]): Promise<void> {
  process.exitCode = undefined;
  await modelCommand.parseAsync(['node', 'cortextos-model', ...argv, '--root', root]);
}

function json<T = Record<string, unknown>>(): T {
  return JSON.parse(logs[logs.length - 1]) as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-role-cap-'));
  mkdirSync(join(root, 'orgs', 'uhs'), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(registry(), null, 2));
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('cortextos model role-capability', () => {
  it('round-trips add → list → remove', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'weekly kaizen', '--json']);
    expect(json<ModelOperationReceipt>().state).toBe('applied');
    expect(readRegistry().roles.revenue_ops.role_capabilities).toEqual(['continuous-improvement']);

    await run(['role-capability', 'list', '--role', 'revenue_ops', '--json']);
    expect(json<{ roles: { role: string; role_capabilities: string[] }[] }>().roles).toEqual([
      { role: 'revenue_ops', role_capabilities: ['continuous-improvement'] },
    ]);

    await run(['role-capability', 'remove', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'opting out', '--json']);
    expect(json<ModelOperationReceipt>().state).toBe('applied');
    expect(readRegistry().roles.revenue_ops.role_capabilities).toEqual([]);
  });

  it('reports restart_required false — a capability changes no route', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'weekly kaizen', '--json']);
    const receipt = json<ModelOperationReceipt>();
    expect(receipt.restart_required).toBe(false);
    expect(receipt.affected_consumers).toEqual([]);
    expect(receipt.restart_results).toEqual([]);
  });

  it('does NOT affect model resolution — a bogus role capability still resolves', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'not-a-model-tag', '--reason', 'proving isolation', '--json']);
    logs = [];
    await run(['resolve', '--agent', 'jarvis-revenue', '--json']);
    const res = json<ModelResolution>();
    expect(res.selected?.model_id).toBe('claude-sonnet-4-6');
    expect(res.validation.ok).toBe(true);
    expect(res.validation.errors).toEqual([]);
  });

  it('does a CAS write and honours --expected-revision', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'r', '--expected-revision', '1', '--json']);
    expect(json<ModelOperationReceipt>().registry_revision_after).toBe(2);

    // A stale revision must be refused, not silently applied.
    await run(['role-capability', 'add', '--role', 'ingress',
      '--capability', 'continuous-improvement', '--reason', 'r', '--expected-revision', '1', '--json']);
    const stale = json<ModelOperationReceipt>();
    expect(stale.state).toBe('failed');
    expect(stale.error).toMatch(/revision conflict/i);
    expect(readRegistry().roles.ingress.role_capabilities ?? []).toEqual([]);
  });

  it('journals an audit event carrying the actor and the reason', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops', '--capability', 'continuous-improvement',
      '--reason', 'enrolling the specialists', '--actor', 'orchestrator', '--json']);
    const receipt = json<ModelOperationReceipt>();
    const dir = join(root, 'orgs', 'uhs', 'model-events');
    expect(existsSync(dir)).toBe(true);
    const events = readdirSync(dir)
      .filter((f) => f.includes(receipt.operation_id) && f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 'role_capability')).toBe(true);
    expect(events.every((e) => e.actor === 'orchestrator')).toBe(true);
    expect(events.every((e) => e.reason === 'enrolling the specialists')).toBe(true);
    expect(events.some((e) => e.state === 'desired_written')).toBe(true);
    expect(events.some((e) => e.state === 'applied')).toBe(true);
  });

  it('is revertible, and the revert restarts nobody', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'enroll', '--json']);
    const opId = json<ModelOperationReceipt>().operation_id;
    await run(['revert', '--operation', opId, '--reason', 'undo', '--json']);
    const receipt = json<ModelOperationReceipt>();
    expect(receipt.state).toBe('applied');
    expect(receipt.affected_consumers).toEqual([]);
    expect(readRegistry().roles.revenue_ops.role_capabilities).toEqual([]);
  });

  it('treats an absent role_capabilities as the empty list', async () => {
    await run(['role-capability', 'list', '--json']);
    const listed = json<{ roles: { role: string; role_capabilities: string[] }[] }>().roles;
    expect(listed.find((r) => r.role === 'ingress')?.role_capabilities).toEqual([]);
  });

  it('refuses a no-op add, an unknown role and a non-slug capability', async () => {
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'first', '--json']);
    await run(['role-capability', 'add', '--role', 'revenue_ops',
      '--capability', 'continuous-improvement', '--reason', 'again', '--json']);
    expect(json<ModelOperationReceipt>().error).toMatch(/already declares/);

    await run(['role-capability', 'add', '--role', 'nope',
      '--capability', 'continuous-improvement', '--reason', 'r', '--json']);
    expect(json<ModelOperationReceipt>().error).toMatch(/No role "nope"/);

    await run(['role-capability', 'add', '--role', 'ingress',
      '--capability', 'Continuous Improvement', '--reason', 'r', '--json']);
    expect(json<ModelOperationReceipt>().error).toMatch(/is not a slug/);

    await run(['role-capability', 'remove', '--role', 'ingress',
      '--capability', 'continuous-improvement', '--reason', 'r', '--json']);
    expect(json<ModelOperationReceipt>().error).toMatch(/does not declare/);
  });

  it('requires a reason', async () => {
    await expect(
      run(['role-capability', 'add', '--role', 'revenue_ops', '--capability', 'continuous-improvement', '--json']),
    ).rejects.toThrow();
  });
});
