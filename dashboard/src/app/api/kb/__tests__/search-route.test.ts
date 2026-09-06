/**
 * Tests for the /api/kb/search route as a THIN caller.
 *
 * The point is not that the route can search — it is that the route no longer
 * decides anything. It validates input, establishes an authorization ceiling
 * from the session, and hands the question to the shared contract.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-search-'));
process.env.CTX_ROOT = rootTmp;

// The session is what decides the caller's ceiling, so it is the thing to drive.
const authMock = vi.fn();
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }));

type SearchRoute = typeof import('../search/route');
let route: SearchRoute;

beforeAll(async () => {
  route = await import('../search/route');
});

function req(qs: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/kb/search${qs}`);
}

async function body(res: Response) {
  return await res.json() as {
    results: unknown[];
    total: number;
    contract?: {
      caller: { role: string };
      policyVersion: string;
      layersConsulted: string[];
      uncertainty: string | null;
    };
  };
}

describe('input validation', () => {
  beforeAll(() => authMock.mockResolvedValue({ user: { name: 'scott' } }));

  it('requires a question', async () => {
    expect((await route.GET(req('?org=uhs'))).status).toBe(400);
  });

  it('rejects an unknown scope', async () => {
    expect((await route.GET(req('?q=x&org=uhs&scope=everything'))).status).toBe(400);
  });

  it('rejects an unknown layer', async () => {
    expect((await route.GET(req('?q=x&org=uhs&layers=telepathy'))).status).toBe(400);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await route.GET(req('?q=x&org=uhs&limit=500'))).status).toBe(400);
  });
});

describe('authorization is decided from the session, not the query string', () => {
  it('an unauthenticated caller retrieves nothing and is told why', async () => {
    authMock.mockResolvedValue(null);
    const res = await route.GET(req('?q=staging+prices&org=uhs&scope=all'));
    const data = await body(res);
    expect(data.total).toBe(0);
    expect(data.contract!.caller.role).toBe('anonymous');
    expect(data.contract!.uncertainty).toMatch(/unauthenticated/);
  });

  it('a query-string role may narrow the session ceiling', async () => {
    authMock.mockResolvedValue({ user: { name: 'scott' } });
    const res = await route.GET(req('?q=x&org=uhs&role=service'));
    expect((await body(res)).contract!.caller.role).toBe('service');
  });

  it('a query-string role may NOT widen an unauthenticated caller', async () => {
    authMock.mockResolvedValue(null);
    const res = await route.GET(req('?q=x&org=uhs&role=operator'));
    expect((await body(res)).contract!.caller.role).toBe('anonymous');
  });

  it('an unknown role is ignored rather than honoured', async () => {
    authMock.mockResolvedValue({ user: { name: 'scott' } });
    const res = await route.GET(req('?q=x&org=uhs&role=superuser'));
    expect((await body(res)).contract!.caller.role).toBe('operator');
  });
});

describe('the response carries the contract, not just rows', () => {
  beforeAll(() => authMock.mockResolvedValue({ user: { name: 'scott' } }));

  it('reports the policy version and the layers it consulted', async () => {
    const data = await body(await route.GET(req('?q=warehouse+address&org=uhs')));
    expect(data.contract!.policyVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.contract!.layersConsulted).toEqual(
      ['registry', 'structured', 'documents', 'semantic'],
    );
  });

  it('honours an explicit layer subset', async () => {
    const data = await body(await route.GET(req('?q=owner&org=uhs&layers=structured')));
    expect(data.contract!.layersConsulted).toEqual(['structured']);
  });
});
