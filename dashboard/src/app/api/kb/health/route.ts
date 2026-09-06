import { NextRequest } from 'next/server';
import path from 'path';

import { getCTXRoot, getFrameworkRoot } from '@/lib/config';
import { auth } from '@/lib/auth';
import {
  POLICY,
  listCollections,
  resolvePermittedCollections,
  resolveStore,
  type CallerRole,
} from '../../../../../../src/knowledge/contract';
import {
  defaultLedgerPath,
  lagging,
  loadLedger,
  retryInbox,
  unverified,
  isAutoRetryable,
} from '../../../../../../src/knowledge/ingestion';

export const dynamic = 'force-dynamic';

/**
 * GET /api/kb/health?org=<org>
 *
 * Source health for the Knowledge view: which collections exist and which of
 * them this caller may search, what failed to ingest and whether it will retry
 * itself, what is indexed but never proven retrievable, and what is stale
 * because the source moved on after we indexed it.
 *
 * "Indexed" is reported as a claim, not as coverage. Only retrieval-verified
 * documents count as proven.
 */
export async function GET(request: NextRequest) {
  const org = request.nextUrl.searchParams.get('org') ?? '';
  if (org && !/^[a-z0-9_-]+$/i.test(org)) {
    return Response.json({ error: 'Invalid org' }, { status: 400 });
  }

  const session = await auth().catch(() => null);
  const role: CallerRole = session?.user ? 'operator' : 'anonymous';
  if (role === 'anonymous') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const frameworkRoot = getFrameworkRoot();
  const instanceId = path.basename(getCTXRoot());
  const store = resolveStore({ frameworkRoot, instanceId, org });

  const available = store.configured ? listCollections(store) : [];
  const permitted = resolvePermittedCollections(
    { surface: 'dashboard', role, org }, 'all', available,
  );

  const ledger = loadLedger(defaultLedgerPath(instanceId, org));
  const records = Object.values(ledger.records);
  const failed = records.filter((r) => r.state === 'failed');
  const lag = lagging(ledger);

  const byState = {
    discovered: records.filter((r) => r.state === 'discovered').length,
    indexed: records.filter((r) => r.state === 'indexed').length,
    retrieval_verified: records.filter((r) => r.state === 'retrieval_verified').length,
    failed: failed.length,
  };

  return Response.json({
    org,
    policyVersion: POLICY.policy_version,
    store: {
      configured: store.configured,
      reason: store.reason ?? null,
    },
    collections: {
      present: available,
      searchable: permitted.granted,
      denied: permitted.denied,
    },
    ingestion: {
      ledgerUpdatedAt: ledger.updatedAt,
      total: records.length,
      byState,
      /**
       * Coverage is verified/total, NOT indexed/total. The whole point of the
       * third state is that "indexed" was lying.
       */
      verifiedCoveragePct: records.length === 0
        ? null
        : Math.round((byState.retrieval_verified / records.length) * 1000) / 10,
      unverified: unverified(ledger).slice(0, 50).map((r) => ({
        sourceId: r.sourceId, collection: r.collection, indexedAt: r.indexedAt,
      })),
      failures: failed.slice(0, 100).map((r) => ({
        sourceId: r.sourceId,
        collection: r.collection,
        attempts: r.attempts,
        lastAttemptAt: r.lastAttemptAt,
        errorClass: r.error?.class ?? 'unknown',
        message: r.error?.message ?? '',
        autoRetryable: isAutoRetryable(r.error?.class ?? 'unknown'),
      })),
      retryQueueDepth: retryInbox(ledger).length,
    },
    freshness: {
      warnHours: POLICY.freshness.lag_warn_hours,
      failHours: POLICY.freshness.lag_fail_hours,
      lagging: lag.slice(0, 50).map((l) => ({
        sourceId: l.record.sourceId,
        lagHours: Math.round(l.lagHours * 10) / 10,
        severity: l.severity,
      })),
    },
  });
}
