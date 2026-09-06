import { NextRequest } from 'next/server';
import path from 'path';

import { getCTXRoot, getFrameworkRoot } from '@/lib/config';
import { auth } from '@/lib/auth';
import {
  POLICY,
  retrieve,
  type CallerRole,
  type LayerId,
  type RetrievalScope,
} from '../../../../../../src/knowledge/contract';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/search
 *   ?q=<question>&org=<org>&agent=<agent>&scope=shared|private|all
 *   &limit=<n>&threshold=<f>&role=<agent|service>&layers=registry,structured,documents,semantic
 *
 * This route used to decide for itself which ChromaDB collections to search: it
 * ran `mmrag collections` and queried EVERY collection it found whenever
 * scope=all. That reached the `uhs` business collection the CLI could not, and
 * it also handed out `agent-tron`, `agent-kimi` and `agent-trillion-coder` —
 * private persona scope — to any caller who said "all".
 *
 * It no longer decides anything. Collection selection, federation,
 * authorization and dedupe all resolve in `src/knowledge/contract.ts` from
 * `retrieval-policy.json`, the same module the fleet CLI calls. `scope=all`
 * means "all I am permitted to see".
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const org = searchParams.get('org') ?? '';
  const agent = searchParams.get('agent') ?? '';
  const q = searchParams.get('q') ?? '';

  if (org && !/^[a-z0-9_-]+$/i.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }
  if (agent && !/^[a-z0-9_-]+$/.test(agent)) {
    return Response.json({ error: 'Invalid agent' }, { status: 400 });
  }
  if (q.length > 500) {
    return Response.json({ error: 'Query too long' }, { status: 400 });
  }
  if (!q || q.trim().length === 0) {
    return Response.json({ error: 'q parameter required' }, { status: 400 });
  }

  const scope = (searchParams.get('scope') || 'all') as RetrievalScope;
  if (!['shared', 'private', 'all'].includes(scope)) {
    return Response.json({ error: 'scope must be shared, private, or all' }, { status: 400 });
  }

  const limit = parseInt(searchParams.get('limit') || '10', 10);
  if (isNaN(limit) || limit < 1 || limit > 50) {
    return Response.json({ error: 'limit must be 1-50' }, { status: 400 });
  }

  const threshold = parseFloat(searchParams.get('threshold') || '0.5');
  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    return Response.json({ error: 'threshold must be 0.0-1.0' }, { status: 400 });
  }

  const requestedLayers = (searchParams.get('layers') || '')
    .split(',').map((l) => l.trim()).filter(Boolean) as LayerId[];
  const validLayers: LayerId[] = ['registry', 'structured', 'documents', 'semantic'];
  for (const l of requestedLayers) {
    if (!validLayers.includes(l)) {
      return Response.json({ error: `unknown layer '${l}'` }, { status: 400 });
    }
  }

  // ---- authorization, decided here on the server, never by the query string --
  //
  // The session establishes the CEILING. A caller may ask to be treated as a
  // narrower role (an agent-facing surface proxying a persona's question), but
  // never a wider one. Without a session the caller is anonymous and the
  // contract returns nothing rather than guessing.
  const session = await auth().catch(() => null);
  const ceiling: CallerRole = session?.user ? 'operator' : 'anonymous';
  const requestedRole = searchParams.get('role') as CallerRole | null;
  const narrowing: CallerRole[] = ['agent', 'service', 'anonymous'];
  const role: CallerRole =
    requestedRole && narrowing.includes(requestedRole) && ceiling !== 'anonymous'
      ? requestedRole
      : ceiling;

  const frameworkRoot = getFrameworkRoot();
  const instanceId = path.basename(getCTXRoot());

  try {
    const response = retrieve({
      question: q,
      caller: { surface: 'dashboard', role, org, agent: agent || undefined },
      scope,
      topK: limit,
      threshold,
      store: { frameworkRoot, instanceId, org, agent: agent || undefined },
      roots: { jarvisRoot: process.env.UHS_JARVIS_ROOT },
      layers: requestedLayers.length > 0 ? requestedLayers : undefined,
    });

    // Legacy result shape kept so existing dashboard consumers do not break,
    // with the contract's citation fields added alongside.
    const results = response.results.map((hit) => ({
      content: hit.content,
      source_file: hit.citation.canonicalSource,
      agent_name: agent || undefined,
      org: org || '',
      score: hit.citation.score,
      doc_type: hit.citation.layer === 'semantic' ? 'text' : hit.citation.layer,
      filename: hit.citation.filename,
      collection: hit.citation.collection,
      chunk_index: hit.citation.chunkIndex,
      total_chunks: hit.citation.totalChunks,
      content_full_length: null,
      citation: hit.citation,
    }));

    return Response.json({
      results,
      total: response.total,
      query: q,
      collection: response.collectionsSearched.length === 1
        ? response.collectionsSearched[0]
        : (response.collectionsSearched.length === 0 ? `shared-${org}` : 'all'),
      contract: {
        policyVersion: POLICY.policy_version,
        caller: response.caller,
        scope: response.scope,
        layersConsulted: response.layersConsulted,
        collectionsSearched: response.collectionsSearched,
        collectionsDenied: response.collectionsDenied,
        restrictedWithheld: response.restrictedWithheld,
        retiredGuidance: response.retiredGuidance,
        conflicts: response.conflicts,
        degraded: response.degraded,
        uncertainty: response.uncertainty,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[api/kb/search] Error:', message);
    return Response.json({ error: 'Knowledge base query failed' }, { status: 500 });
  }
}
