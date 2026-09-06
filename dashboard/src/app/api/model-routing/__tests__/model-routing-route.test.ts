/**
 * Route tests for GET /api/model-routing — OS-02b-ui.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => '/nonexistent',
  getCTXRoot: () => '/nonexistent',
  getAllAgents: () => [],
  getAgentDir: () => '/nonexistent',
}));

import { __setModelRoutingAdapter, type ModelRoutingAdapter, type RegistrySummary } from '@/lib/model-routing';

const summary: RegistrySummary = {
  schema_version: 1,
  revision: 3,
  activation: { org_default: 'shadow', consumers: {} },
  org_default_tier: 'standard',
  entries: [],
  tiers: { standard: [] },
  roles: {},
  agents: {},
};

function adapter(over: Partial<ModelRoutingAdapter> = {}): ModelRoutingAdapter {
  return {
    kind: 'cli',
    resolveAgent: async () => ({ error: 'unused' }),
    summary: async () => summary,
    events: async () => ({ events: [{ id: 'e1' }], attempts: [{ id: 'a1' }] }),
    apply: async () => ({ error: 'unused' }),
    attempts: async (agent, limit) => ({
      attempts: [
        {
          attempt_id: 'att-1',
          agent,
          at: '2026-09-05T10:00:00Z',
          requested_model_id: 'claude-sonnet-4-6',
          resolved_model_id: 'claude-sonnet-4-6',
          observed: { model_id: 'claude-opus-5', confidence: 'mismatch' },
        },
      ].slice(0, limit ?? 5),
    }),
    ...over,
  };
}

let route: typeof import('../route');

beforeEach(async () => {
  __setModelRoutingAdapter(adapter());
  route = await import('../route');
});
afterEach(() => __setModelRoutingAdapter(null));

function get(url = 'http://localhost/api/model-routing') {
  return route.GET(new NextRequest(url));
}

describe('GET /api/model-routing', () => {
  it('returns the registry summary, events and a mutable flag', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry.revision).toBe(3);
    expect(body.backend).toBe('cli');
    expect(body.mutable).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.attempts).toHaveLength(1);
  });

  it('marks a file-only backend as not mutable', async () => {
    __setModelRoutingAdapter(adapter({ kind: 'file' }));
    const body = await (await get()).json();
    expect(body.mutable).toBe(false);
  });

  it('returns 503 when the registry cannot be read', async () => {
    __setModelRoutingAdapter(adapter({ summary: async () => ({ error: 'routing service unavailable' }) }));
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('routing service unavailable');
  });

  it('still returns the summary when events fail', async () => {
    __setModelRoutingAdapter(adapter({ events: async () => ({ error: 'no events' }) }));
    const body = await (await get()).json();
    expect(body.registry.revision).toBe(3);
    expect(body.events).toEqual([]);
  });

  it('clamps the limit parameter', async () => {
    const seen: number[] = [];
    __setModelRoutingAdapter(
      adapter({
        events: async (limit) => {
          seen.push(limit ?? -1);
          return { events: [], attempts: [] };
        },
      }),
    );
    await get('http://localhost/api/model-routing?limit=9999');
    await get('http://localhost/api/model-routing?limit=abc');
    expect(seen).toEqual([200, 25]);
  });
});

// ---------------------------------------------------------------------------
// Per-agent attempts (Fleet row expander)
// ---------------------------------------------------------------------------

describe('GET /api/model-routing?agent=…', () => {
  it('returns the agent\'s normalized attempts', async () => {
    const res = await get('http://localhost/api/model-routing?agent=vera&limit=5');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent).toBe('vera');
    expect(body.supported).toBe(true);
    expect(body.attempts[0]).toMatchObject({
      attempt_id: 'att-1',
      requested: 'claude-sonnet-4-6',
      observed: 'claude-opus-5',
      confidence: 'mismatch',
    });
  });

  it('reports an adapter that cannot list attempts instead of pretending there are none', async () => {
    __setModelRoutingAdapter(adapter({ attempts: undefined }));
    const body = await (await get('http://localhost/api/model-routing?agent=vera')).json();
    expect(body.supported).toBe(false);
    expect(body.attempts).toEqual([]);
  });

  it('treats an older CLI without the subcommand as unsupported, not as an outage', async () => {
    __setModelRoutingAdapter(
      adapter({ attempts: async () => ({ error: "unknown command 'attempts'" }) }),
    );
    const res = await get('http://localhost/api/model-routing?agent=vera');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supported).toBe(false);
    expect(body.attempts).toEqual([]);
  });

  it('rejects an invalid agent name', async () => {
    const res = await get('http://localhost/api/model-routing?agent=../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('surfaces an attempts backend failure as 503', async () => {
    __setModelRoutingAdapter(adapter({ attempts: async () => ({ error: 'attempts log unreadable' }) }));
    const res = await get('http://localhost/api/model-routing?agent=vera');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('attempts log unreadable');
  });
});
