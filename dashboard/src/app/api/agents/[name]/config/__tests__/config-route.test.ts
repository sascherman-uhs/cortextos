/**
 * Route tests for /api/agents/[name]/config — OS-02b-ui.
 *
 *  - GET returns the redacted DTO and NEVER the cron prompt / inline token.
 *  - GET carries the routing Resolution from the swappable adapter.
 *  - PATCH { model } (legacy raw write) → 409 { error: 'use model_routing operation' }.
 *  - PATCH { op: 'model_routing', … } passes through to the adapter and returns the Receipt.
 *  - Adapter errors surface as 503 and still carry no secrets.
 *
 * The sentinel `ZZTEST-SENTINEL-TOKEN-123` is a fake credential planted in the
 * fixture config; any appearance of it in a response body is a test failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SENTINEL = 'ZZTEST-SENTINEL-TOKEN-123';
const AGENT = 'zztest-routing-agent';

let root: string;
let configPath: string;

// --- config lib is stubbed so the route reads our fixture org tree ----------
vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => root,
  getCTXRoot: () => root,
  getAllAgents: () => [],
  getAgentDir: () => join(root, 'orgs', 'uhs', 'agents', AGENT),
}));

import {
  __setModelRoutingAdapter,
  type ModelRoutingAdapter,
  type Receipt,
  type Resolution,
} from '@/lib/model-routing';

const resolution: Resolution = {
  registry_revision: 7,
  activation: 'shadow',
  requested: { source: 'role', tier: 'standard' },
  candidates: ['anthropic-sonnet-4-6'],
  selected: {
    entry_id: 'anthropic-sonnet-4-6',
    model_id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    runtime_adapter: 'claude-code',
    billing_mode: 'subscription_quota',
    cost_class: 3,
  },
  validation: { ok: true, errors: [], warnings: [] },
  legacy_effective: { model_id: 'claude-haiku-4-5-20251001', runtime: 'claude-code' },
  eval_state: 'unevaluated',
};

const receipt: Receipt = {
  operation_id: 'op-123',
  kind: 'switch',
  actor: 'dashboard',
  reason: 'ZZTEST switch',
  affected_consumers: [AGENT],
  state: 'desired_written',
  created_at: '2026-09-05T18:00:00Z',
};

const applySpy = vi.fn();

function fakeAdapter(over: Partial<ModelRoutingAdapter> = {}): ModelRoutingAdapter {
  return {
    kind: 'cli',
    resolveAgent: async () => resolution,
    summary: async () => ({ error: 'not used' }) as never,
    events: async () => ({ events: [], attempts: [] }),
    apply: async (op) => {
      applySpy(op);
      return receipt;
    },
    ...over,
  };
}

let route: typeof import('../route');

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'zztest-cortex-'));
  const dir = join(root, 'orgs', 'uhs', 'agents', AGENT);
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        runtime: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        timezone: 'America/Los_Angeles',
        max_session_seconds: 3600,
        approval_rules: { always_ask: ['deploy'], never_ask: ['read'] },
        env: { TELEGRAM_BOT_TOKEN: SENTINEL },
        crons: [
          {
            name: 'nightly',
            schedule: '0 2 * * *',
            enabled: true,
            prompt: `Post to Telegram using bot token ${SENTINEL} and summarize the day.`,
          },
        ],
      },
      null,
      2,
    ),
  );
  applySpy.mockReset();
  __setModelRoutingAdapter(fakeAdapter());
  // No vi.resetModules() here: the route must share the same model-routing
  // module instance the test injects its fake adapter into.
  route = await import('../route');
});

afterEach(() => {
  __setModelRoutingAdapter(null);
  rmSync(root, { recursive: true, force: true });
});

function get(name = AGENT) {
  return route.GET(new NextRequest(`http://localhost/api/agents/${name}/config`), {
    params: Promise.resolve({ name }),
  });
}

function patch(body: unknown, name = AGENT) {
  return route.PATCH(
    new NextRequest(`http://localhost/api/agents/${name}/config`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ name }) },
  );
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('GET redaction', () => {
  it('never leaks the sentinel token or cron prompt bodies', async () => {
    const res = await get();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('summarize the day');
    const body = JSON.parse(text);
    expect(body.config.env).toBeUndefined();
    expect(body.config.crons).toEqual([
      { name: 'nightly', schedule: '0 2 * * *', enabled: true, has_prompt: true },
    ]);
  });

  it('drops the raw model field from the DTO but keeps operational fields', async () => {
    const body = await (await get()).json();
    expect(body.config.model).toBeUndefined();
    expect(body.config.timezone).toBe('America/Los_Angeles');
    expect(body.config.max_session_seconds).toBe(3600);
    expect(body.config.approval_rules).toEqual({ always_ask: ['deploy'], never_ask: ['read'] });
    expect(body.redacted).toBe(true);
  });

  it('returns the routing resolution from the adapter', async () => {
    const body = await (await get()).json();
    expect(body.routing.selected.model_id).toBe('claude-sonnet-4-6');
    expect(body.routing.legacy_effective.model_id).toBe('claude-haiku-4-5-20251001');
    expect(body.routing_error).toBeNull();
  });

  it('reports a routing outage without failing the config read', async () => {
    __setModelRoutingAdapter(fakeAdapter({ resolveAgent: async () => ({ error: 'routing service unavailable' }) }));
    const body = await (await get()).json();
    expect(body.routing).toBeNull();
    expect(body.routing_error).toBe('routing service unavailable');
  });

  it('rejects an invalid agent name', async () => {
    const res = await get('Bad Name');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Legacy model write
// ---------------------------------------------------------------------------

describe('PATCH legacy model write', () => {
  it('returns 409 and does not touch the config file', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const res = await patch({ model: 'claude-opus-5' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'use model_routing operation' });
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('returns 409 for a raw runtime write too', async () => {
    const res = await patch({ runtime: 'codex-app-server' });
    expect(res.status).toBe(409);
  });

  it('still accepts an allowlisted operational field and answers with the redacted DTO', async () => {
    const res = await patch({ timezone: 'UTC' });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SENTINEL);
    const body = JSON.parse(text);
    expect(body.config.timezone).toBe('UTC');
    expect(body.config.model).toBeUndefined();
    // The raw file keeps its model — the route just refuses to write it.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).model).toBe('claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// Routing operations
// ---------------------------------------------------------------------------

describe('PATCH model_routing', () => {
  it('passes a switch through to the adapter and returns the receipt', async () => {
    const res = await patch({
      op: 'model_routing',
      action: 'switch',
      role: 'dispatcher',
      tier: 'premium',
      reason: 'ZZTEST reason',
      expected_revision: 7,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receipt.operation_id).toBe('op-123');
    expect(body.receipt.state).toBe('desired_written');
    expect(applySpy).toHaveBeenCalledWith({
      action: 'switch',
      role: 'dispatcher',
      tier: 'premium',
      reason: 'ZZTEST reason',
      actor: 'dashboard',
      clear_pins: false,
      expected_revision: 7,
    });
  });

  it('defaults pin/unpin to the agent in the URL', async () => {
    await patch({ op: 'model_routing', action: 'pin', entry_id: 'anthropic-opus-5', reason: 'ZZTEST pin' });
    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'pin', agent: AGENT, entry_id: 'anthropic-opus-5' }),
    );
    await patch({ op: 'model_routing', action: 'unpin', reason: 'ZZTEST unpin' });
    expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'unpin', agent: AGENT }));
  });

  it('requires a reason', async () => {
    const res = await patch({ op: 'model_routing', action: 'switch', role: 'dispatcher', tier: 'premium' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason is required/);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown action and an unknown op', async () => {
    expect((await patch({ op: 'model_routing', action: 'nuke', reason: 'x' })).status).toBe(400);
    expect((await patch({ op: 'something_else' })).status).toBe(400);
  });

  it('returns 503 with no secrets when the routing service is unavailable', async () => {
    __setModelRoutingAdapter(
      fakeAdapter({ apply: async () => ({ error: `routing service unavailable (${SENTINEL})` }) }),
    );
    const res = await patch({ op: 'model_routing', action: 'unpin', reason: 'ZZTEST' });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain('[redacted]');
  });
});
