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
