/**
 * `cortextos model …` CLI tests.
 *
 * These drive the built commander tree in-process rather than shelling out, so
 * they run without a build step. Each test gets its own temp registry root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { modelCommand } from '../../../src/cli/model.js';
import type { ModelRegistry } from '../../../src/types/index.js';

let root: string;
let logs: string[];
let errors: string[];
let exitCode: number | undefined;

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
      'anthropic-haiku': {
        model_id: 'claude-haiku-4-5-20251001',
        provider: 'anthropic',
        runtime_adapter: 'claude-code',
        capability_tags: ['structured-output', 'scoped-retrieval', 'tool-use', 'conversation'],
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
        capability_tags: ['structured-output', 'scoped-retrieval', 'tool-use', 'conversation'],
        context_window: 200000,
        billing_mode: 'subscription_quota',
        cost_class: 3,
        auth_source: null,
        status: 'active',
      },
    },
    tiers: { economy: ['anthropic-haiku'], standard: ['anthropic-sonnet'] },
    org_default_tier: 'standard',
    roles: {
      listing_intel: {
        tier: 'economy',
        required_capabilities: ['structured-output', 'scoped-retrieval'],
        min_context: 50000,
        data_scope: 'org',
      },
    },
    agents: { 'jarvis-mls': { role: 'listing_intel', pin: null } },
    callsites: {},
  };
}

/** Run one `model` subcommand, capturing stdout, stderr and the exit code. */
async function run(argv: string[]): Promise<void> {
  process.exitCode = undefined;
  await modelCommand.parseAsync(['node', 'cortextos-model', ...argv, '--root', root]);
  exitCode = process.exitCode;
}

function json<T = Record<string, unknown>>(): T {
  return JSON.parse(logs[logs.length - 1]) as T;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-model-cli-'));
  mkdirSync(join(root, 'orgs', 'uhs'), { recursive: true });
  writeFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), JSON.stringify(registry(), null, 2));
  logs = [];
  errors = [];
  exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  // `die()` calls process.exit — turn it into a throw so tests can assert.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('cortextos model list', () => {
  it('prints the registry as JSON', async () => {
    await run(['list', '--json']);
    const out = json<ModelRegistry>();
    expect(out.revision).toBe(1);
    expect(Object.keys(out.entries)).toContain('anthropic-haiku');
  });

  it('prints a human table with entries, tiers and agents', async () => {
    await run(['list']);
    const text = logs.join('\n');
    expect(text).toMatch(/anthropic-haiku/);
    expect(text).toMatch(/Tiers:/);
    expect(text).toMatch(/jarvis-mls\s+role=listing_intel/);
  });
});

describe('cortextos model resolve', () => {
  it('resolves an agent through its role', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--json']);
    const out = json<{ selected: { model_id: string }; requested: { source: string } }>();
    expect(out.requested.source).toBe('role');
    expect(out.selected.model_id).toBe('claude-haiku-4-5-20251001');
    expect(exitCode).toBeUndefined();
  });

  it('resolves a bare role', async () => {
    await run(['resolve', '--role', 'listing_intel', '--json']);
    expect(json<{ selected: { entry_id: string } }>().selected.entry_id).toBe('anthropic-haiku');
  });

  it('applies an authorized override', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--override-entry', 'anthropic-sonnet', '--json']);
    const out = json<{ requested: { source: string }; selected: { entry_id: string } }>();
    expect(out.requested.source).toBe('override');
    expect(out.selected.entry_id).toBe('anthropic-sonnet');
  });

  // DEFECT 1. A resolution that printed full JSON used to exit 2 whenever
  // validation failed, so every consumer that checks the exit code threw the
  // answer away. The status lives IN the JSON; the exit code is for
  // invocation errors.
  it('exits 0 when validation fails but a resolution was produced', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--override-entry', 'not-a-real-entry', '--json']);
    const res = json<{ selected: unknown; validation: { ok: boolean; errors: { code: string }[] } }>();
    expect(res.selected).toBeNull();
    expect(res.validation.ok).toBe(false);
    expect(res.validation.errors.length).toBeGreaterThan(0);
    expect(exitCode).toBeUndefined();
  });

  it('--strict restores exit 2 on a validation failure', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--override-entry', 'not-a-real-entry', '--strict', '--json']);
    expect(exitCode).toBe(2);
  });

  it('--strict still exits 0 when validation passes', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--strict', '--json']);
    expect(exitCode).toBeUndefined();
  });

  it('still exits 1 when the registry cannot be read at all', async () => {
    rmSync(join(root, 'orgs', 'uhs', 'model-registry.json'), { force: true });
    await expect(run(['resolve', '--agent', 'jarvis-mls', '--json'])).rejects.toThrow('process.exit:1');
  });

  // DEFECT 3. Desired vs running, both in the resolution.
  it('carries expected_model_id and a null observed before anything has run', async () => {
    await run(['resolve', '--agent', 'jarvis-mls', '--json']);
    const res = json<{ expected_model_id: string | null; observed: unknown }>();
    expect(res.expected_model_id).toBe('claude-haiku-4-5-20251001');
    expect(res.observed).toBeNull();
  });

  it('reports the newest attempt as observed instead of a blanket unconfirmed', async () => {
    await run([
      'attempt', '--consumer', 'jarvis-mls',
      '--observed', 'claude-haiku-4-5-20251001', '--observed-source', 'claude-transcript', '--json',
    ]);
    await run(['resolve', '--agent', 'jarvis-mls', '--json']);
    const res = json<{ observed: { model_id: string; confidence: string; attempt_id: string; source: string } }>();
    expect(res.observed.model_id).toBe('claude-haiku-4-5-20251001');
    expect(res.observed.confidence).toBe('verified');
    expect(res.observed.source).toBe('claude-transcript');
    expect(res.observed.attempt_id).toMatch(/^att/);
  });

  it('surfaces a mismatch on the resolution, not just inside the attempt file', async () => {
    await run([
      'attempt', '--consumer', 'jarvis-mls',
      '--observed', 'claude-sonnet-4-6', '--observed-source', 'claude-transcript', '--json',
    ]);
    await run(['resolve', '--agent', 'jarvis-mls', '--json']);
    const res = json<{ expected_model_id: string; observed: { model_id: string; confidence: string } }>();
    expect(res.expected_model_id).toBe('claude-haiku-4-5-20251001');
    expect(res.observed.model_id).toBe('claude-sonnet-4-6');
    expect(res.observed.confidence).toBe('mismatch');
  });

  it('prints desired and running in the human view', async () => {
    await run(['resolve', '--agent', 'jarvis-mls']);
    const text = logs.join('\n');
    expect(text).toMatch(/expected \(desired\)/);
    expect(text).toMatch(/observed \(running\).*no attempt recorded yet/);
  });

  it('requires a target', async () => {
    await expect(run(['resolve', '--json'])).rejects.toThrow('process.exit:1');
  });
});

describe('cortextos model switch / pin / unpin', () => {
  it('switches a role tier and returns a receipt', async () => {
    await run(['switch', '--role', 'listing_intel', '--tier', 'standard', '--reason', 'test', '--no-restart', '--json']);
    const receipt = json<{ state: string; registry_revision_after: number }>();
    expect(receipt.state).toBe('applied');
    expect(receipt.registry_revision_after).toBe(2);
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.roles.listing_intel.tier).toBe('standard');
  });

  it('honours --expected-revision as a CAS guard', async () => {
    await run([
      'switch', '--role', 'listing_intel', '--tier', 'standard',
      '--reason', 'test', '--expected-revision', '99', '--no-restart', '--json',
    ]);
    expect(json<{ state: string; error: string }>().state).toBe('failed');
    expect(json<{ error: string }>().error).toMatch(/revision conflict/i);
    expect(exitCode).toBe(2);
  });

  it('pins and unpins an agent', async () => {
    await run([
      'pin', '--agent', 'jarvis-mls', '--entry', 'anthropic-sonnet',
      '--reason', 'temporary', '--expires-at', '2027-01-01T00:00:00Z', '--no-restart', '--json',
    ]);
    expect(json<{ state: string }>().state).toBe('applied');
    let reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin?.entry_id).toBe('anthropic-sonnet');
    expect(reg.agents['jarvis-mls'].pin?.kind).toBe('explicit');

    await run(['unpin', '--agent', 'jarvis-mls', '--reason', 'done', '--no-restart', '--json']);
    reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin).toBeNull();
  });

  // DEFECT 5. revert used to throw "refusing to guess the target" for any
  // pin/unpin, because the receipt recorded the pin object without saying
  // whose pin it was.
  it('reverts a pin back to no pin', async () => {
    await run([
      'pin', '--agent', 'jarvis-mls', '--entry', 'anthropic-sonnet',
      '--reason', 'temporary', '--no-restart', '--json',
    ]);
    const receipt = json<{ operation_id: string; from: { target_agent: string; pin: unknown } }>();
    expect(receipt.from.target_agent).toBe('jarvis-mls');
    expect(receipt.from.pin).toBeNull();

    await run(['revert', '--operation', receipt.operation_id, '--reason', 'undo', '--no-restart', '--json']);
    expect(json<{ state: string; error: string | null }>().state).toBe('applied');
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin).toBeNull();
  });

  it('reverts an unpin by restoring the exact prior pin', async () => {
    await run([
      'pin', '--agent', 'jarvis-mls', '--entry', 'anthropic-sonnet',
      '--reason', 'temporary', '--no-restart', '--json',
    ]);
    await run(['unpin', '--agent', 'jarvis-mls', '--reason', 'clearing', '--no-restart', '--json']);
    const unpinOp = json<{ operation_id: string }>().operation_id;
    let reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin).toBeNull();

    await run(['revert', '--operation', unpinOp, '--reason', 'put it back', '--no-restart', '--json']);
    expect(json<{ state: string }>().state).toBe('applied');
    reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin?.entry_id).toBe('anthropic-sonnet');
    expect(reg.agents['jarvis-mls'].pin?.reason).toBe('temporary');
  });

  it('stores the revert reason and the operation it reverts on the receipt', async () => {
    await run(['unpin', '--agent', 'jarvis-mls', '--reason', 'x', '--no-restart', '--json']);
    const op = json<{ operation_id: string }>().operation_id;
    await run(['revert', '--operation', op, '--reason', 'rollback for the 9am install', '--no-restart', '--json']);
    const receipt = json<{ reason: string; revert_of: string }>();
    expect(receipt.reason).toBe('rollback for the 9am install');
    expect(receipt.revert_of).toBe(op);
  });

  it('restores pins a --clear-pins switch cleared', async () => {
    await run([
      'pin', '--agent', 'jarvis-mls', '--entry', 'anthropic-sonnet',
      '--reason', 'held', '--no-restart', '--json',
    ]);
    await run([
      'switch', '--role', 'listing_intel', '--tier', 'standard',
      '--reason', 'move everyone', '--clear-pins', '--no-restart', '--json',
    ]);
    const switchOp = json<{ operation_id: string }>().operation_id;
    let reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin).toBeNull();

    await run(['revert', '--operation', switchOp, '--reason', 'undo', '--no-restart', '--json']);
    expect(json<{ state: string }>().state).toBe('applied');
    reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.roles.listing_intel.tier).toBe('economy');
    expect(reg.agents['jarvis-mls'].pin?.entry_id).toBe('anthropic-sonnet');
  });

  // DEFECT 6 (receipt half): an operation nobody has to restart must SAY so.
  it('marks restart_required false when no consumer is affected', async () => {
    await run(['activation', '--consumer', 'not-an-agent', '--mode', 'enforced', '--reason', 'x', '--json']);
    const receipt = json<{ state: string; affected_consumers: string[]; restart_required: boolean }>();
    expect(receipt.state).toBe('applied');
    expect(receipt.affected_consumers).toEqual([]);
    expect(receipt.restart_required).toBe(false);
  });

  it('marks restart_required false when --no-restart was asked for', async () => {
    await run(['switch', '--role', 'listing_intel', '--tier', 'standard', '--reason', 'x', '--no-restart', '--json']);
    const receipt = json<{ affected_consumers: string[]; restart_required: boolean }>();
    expect(receipt.affected_consumers).toEqual(['jarvis-mls']);
    expect(receipt.restart_required).toBe(false);
  });

  it('reverts a switch by operation id', async () => {
    await run(['switch', '--role', 'listing_intel', '--tier', 'standard', '--reason', 'x', '--no-restart', '--json']);
    const opId = json<{ operation_id: string }>().operation_id;
    await run(['revert', '--operation', opId, '--reason', 'undo', '--no-restart', '--json']);
    expect(json<{ state: string }>().state).toBe('applied');
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.roles.listing_intel.tier).toBe('economy');
  });
});

describe('cortextos model attempts (DEFECT 3)', () => {
  it('lists attempts for one agent as JSON', async () => {
    await run(['attempt', '--consumer', 'jarvis-mls', '--observed', 'claude-haiku-4-5-20251001', '--json']);
    await run(['attempts', '--agent', 'jarvis-mls', '--limit', '5', '--json']);
    const rows = json<{ consumer: string; observed: { model_id: string } }[]>();
    expect(rows.length).toBe(1);
    expect(rows[0].consumer).toBe('jarvis-mls');
    expect(rows[0].observed.model_id).toBe('claude-haiku-4-5-20251001');
  });

  it('filters out other consumers', async () => {
    await run(['attempt', '--consumer', 'jarvis-mls', '--json']);
    await run(['attempts', '--agent', 'jarvis-marketing', '--json']);
    expect(json<unknown[]>().length).toBe(0);
  });

  it('says so plainly when nothing has been recorded', async () => {
    await run(['attempts', '--agent', 'jarvis-mls']);
    expect(logs.join('\n')).toContain('no attempts recorded');
  });
});

describe('cortextos model activation', () => {
  it('moves one consumer to enforced', async () => {
    await run(['activation', '--consumer', 'jarvis-mls', '--mode', 'enforced', '--reason', 'ready', '--no-restart', '--json']);
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.activation.consumers['jarvis-mls']).toBe('enforced');
  });

  it('moves the org default', async () => {
    await run(['activation', '--org-wide', '--mode', 'enforced', '--reason', 'clean days', '--no-restart', '--json']);
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.activation.org_default).toBe('enforced');
  });

  it('rejects a mode that is neither shadow nor enforced', async () => {
    await expect(
      run(['activation', '--consumer', 'jarvis-mls', '--mode', 'turbo', '--reason', 'x', '--json']),
    ).rejects.toThrow('process.exit:1');
  });
});

describe('cortextos model attempt and events', () => {
  it('records an attempt with an observed model and lists it back', async () => {
    await run([
      'attempt', '--consumer', 'jarvis-mls', '--session', 'sess-9',
      '--observed', 'claude-haiku-4-5-20251001', '--observed-source', 'claude-transcript', '--json',
    ]);
    const { path } = json<{ path: string }>();
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, 'utf-8'));
    expect(rec.observed.confidence).toBe('verified');
    expect(rec.session_ref).toBe('sess-9');

    await run(['events', '--attempts', '--json']);
    expect(json<unknown[]>().length).toBe(1);
  });

  it('lists operation events newest first', async () => {
    await run(['switch', '--role', 'listing_intel', '--tier', 'standard', '--reason', 'x', '--no-restart', '--json']);
    await run(['events', '--json']);
    const events = json<{ state: string }[]>();
    expect(events.map((e) => e.state)).toEqual(expect.arrayContaining(['requested', 'applied']));
  });
});

describe('cortextos model health', () => {
  it('probes every entry without billing anything', async () => {
    await run(['health', '--json']);
    const results = json<{ entry_id: string; ok: boolean }[]>();
    expect(results.map((r) => r.entry_id)).toEqual(['anthropic-haiku', 'anthropic-sonnet']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('probes a single entry', async () => {
    await run(['health', '--entry', 'anthropic-haiku', '--json']);
    expect(json<unknown[]>().length).toBe(1);
  });
});

describe('cortextos model migrate --bootstrap', () => {
  beforeEach(() => {
    const dir = join(root, 'orgs', 'uhs', 'agents', 'jarvis-mls');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ model: 'claude-haiku-4-5-20251001' }));
  });

  it('imports a legacy model as a pin', async () => {
    await run(['migrate', '--bootstrap', '--json']);
    const result = json<{ legacy_pins: { agent: string }[] }>();
    expect(result.legacy_pins.map((p) => p.agent)).toContain('jarvis-mls');
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.agents['jarvis-mls'].pin?.kind).toBe('legacy-migration');
  });

  it('writes nothing on --dry-run', async () => {
    await run(['migrate', '--bootstrap', '--dry-run', '--json']);
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.revision).toBe(1);
    expect(reg.agents['jarvis-mls'].pin).toBeNull();
  });

  it('refuses a migrate without --bootstrap', async () => {
    await expect(run(['migrate', '--json'])).rejects.toThrow('process.exit:1');
  });

  it('reports the directory it scanned so a wrong root is visible', async () => {
    await run(['migrate', '--bootstrap', '--json']);
    const result = json<{ agents_dir: string; scanned: string[] }>();
    expect(result.agents_dir).toBe(join(root, 'orgs', 'uhs', 'agents'));
    expect(result.scanned).toContain('jarvis-mls');
  });
});

describe('cortextos model migrate --bootstrap with no agent configs', () => {
  it('imports nothing, bumps no revision, and says where it looked', async () => {
    // No agents/ directory under this root at all.
    await run(['migrate', '--bootstrap']);
    const reg = JSON.parse(readFileSync(join(root, 'orgs', 'uhs', 'model-registry.json'), 'utf-8')) as ModelRegistry;
    expect(reg.revision).toBe(1);
    expect(logs.join('\n')).toContain(join(root, 'orgs', 'uhs', 'agents'));
    expect(logs.join('\n')).toContain('registry untouched');
    expect(existsSync(join(root, 'orgs', 'uhs', 'model-events'))).toBe(false);
  });
});
