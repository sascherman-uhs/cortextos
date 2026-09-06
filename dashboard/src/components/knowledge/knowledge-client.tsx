'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Citation {
  sourceId: string;
  canonicalSource: string;
  filename: string;
  collection: string;
  layer: string;
  authority: string;
  score: number;
  chunkIndex: number | null;
  duplicateCollections: string[];
  sourceModifiedAt: string | null;
  retrievedAt: string;
  missing: boolean;
}

interface SearchHit {
  content: string;
  citation: Citation;
}

interface SearchResponse {
  results: SearchHit[];
  total: number;
  contract?: {
    policyVersion: string;
    caller: { surface: string; role: string; org: string; agent: string | null };
    scope: string;
    layersConsulted: string[];
    collectionsSearched: string[];
    collectionsDenied: Array<{ name: string; reason: string }>;
    restrictedWithheld: number;
    retiredGuidance: Array<{ sourceId: string; retired: { id: string; successor: string; note: string } }>;
    conflicts: Array<{ claim: string; sources: string[] }>;
    degraded: string[];
    uncertainty: string | null;
  };
}

interface HealthResponse {
  org: string;
  policyVersion: string;
  store: { configured: boolean; reason: string | null };
  collections: {
    present: string[];
    searchable: Array<{ name: string; authority: string; kind: string }>;
    denied: Array<{ name: string; reason: string }>;
  };
  ingestion: {
    ledgerUpdatedAt: string;
    total: number;
    byState: { discovered: number; indexed: number; retrieval_verified: number; failed: number };
    verifiedCoveragePct: number | null;
    unverified: Array<{ sourceId: string; collection: string; indexedAt: string | null }>;
    failures: Array<{
      sourceId: string; collection: string; attempts: number; lastAttemptAt: string | null;
      errorClass: string; message: string; autoRetryable: boolean;
    }>;
    retryQueueDepth: number;
  };
  freshness: {
    warnHours: number;
    failHours: number;
    lagging: Array<{ sourceId: string; lagHours: number; severity: string }>;
  };
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length <= 3 ? p : `…/${parts.slice(-3).join('/')}`;
}

export function KnowledgeClient({ org }: { org: string }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'shared' | 'private'>('all');
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch(`/api/kb/health?org=${encodeURIComponent(org)}`);
      if (!res.ok) {
        setHealthError(`source health unavailable (${res.status})`);
        return;
      }
      setHealth(await res.json());
      setHealthError(null);
    } catch (e) {
      setHealthError(String(e));
    }
  }, [org]);

  useEffect(() => { void loadHealth(); }, [loadHealth]);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/kb/search?q=${encodeURIComponent(query)}&org=${encodeURIComponent(org)}&scope=${scope}&limit=10`,
      );
      setSearch(await res.json());
    } finally {
      setSearching(false);
    }
  }, [query, org, scope]);

  const c = search?.contract;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Ask the canonical sources</CardTitle>
          <CardDescription>
            Registry, then authoritative records, then approved documents, then semantic
            retrieval. Every answer carries a citation. The agent CLI and this page resolve the
            same collections from the same policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              placeholder="e.g. Where do client lookups come from now?"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
            />
            <select
              aria-label="Scope"
              className="rounded-md bg-background px-2 text-sm ring-1 ring-foreground/10"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'all' | 'shared' | 'private')}
            >
              <option value="all">all I may see</option>
              <option value="shared">org only</option>
              <option value="private">persona only</option>
            </select>
            <Button onClick={() => void runSearch()} disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </div>

          {c && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">policy v{c.policyVersion}</Badge>
              <Badge variant="outline">role: {c.caller.role}</Badge>
              <Badge variant="outline">layers: {c.layersConsulted.join(' → ')}</Badge>
              <Badge variant="outline">
                searched: {c.collectionsSearched.join(', ') || 'none'}
              </Badge>
              {c.restrictedWithheld > 0 && (
                <Badge variant="destructive">
                  {c.restrictedWithheld} withheld (restricted scope)
                </Badge>
              )}
            </div>
          )}

          {c?.uncertainty && (
            <div className="rounded-md bg-amber-500/10 p-3 text-sm ring-1 ring-amber-500/30">
              <strong>Uncertain: </strong>{c.uncertainty}
            </div>
          )}

          {c?.retiredGuidance?.length ? (
            <div className="rounded-md bg-destructive/10 p-3 text-sm ring-1 ring-destructive/30">
              <strong>Retired guidance retrieved. </strong>
              {c.retiredGuidance.map((r) => (
                <div key={r.sourceId}>
                  {r.retired.id} → use {r.retired.successor}. {r.retired.note}
                </div>
              ))}
            </div>
          ) : null}

          {c?.conflicts?.length ? (
            <div className="rounded-md bg-amber-500/10 p-3 text-sm ring-1 ring-amber-500/30">
              <strong>Sources disagree. </strong>
              {c.conflicts.map((cf) => (
                <div key={cf.claim}>{cf.claim}: {cf.sources.length} sources in conflict</div>
              ))}
            </div>
          ) : null}

          <div className="space-y-3">
            {search?.results?.map((hit) => (
              <div key={hit.citation.sourceId} className="rounded-md p-3 ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge>{hit.citation.layer}</Badge>
                  <span>{hit.citation.authority}</span>
                  <span>·</span>
                  <span>{hit.citation.collection}</span>
                  <span>·</span>
                  <span>score {hit.citation.score.toFixed(3)}</span>
                  {hit.citation.sourceModifiedAt && (
                    <>
                      <span>·</span>
                      <span>source modified {hit.citation.sourceModifiedAt.slice(0, 10)}</span>
                    </>
                  )}
                  {hit.citation.missing && <Badge variant="destructive">source missing</Badge>}
                  {hit.citation.duplicateCollections.length > 0 && (
                    <Badge variant="outline">
                      also in {hit.citation.duplicateCollections.join(', ')}
                    </Badge>
                  )}
                </div>
                <div className="mt-1 font-mono text-xs">{shortPath(hit.citation.canonicalSource)}</div>
                <p className="mt-2 whitespace-pre-wrap text-sm">{hit.content.slice(0, 800)}</p>
              </div>
            ))}
            {search && search.results.length === 0 && !c?.uncertainty && (
              <p className="text-sm text-muted-foreground">No results.</p>
            )}
          </div>

          {c && c.collectionsDenied.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary>{c.collectionsDenied.length} collection(s) not searched</summary>
              <ul className="mt-1 space-y-1">
                {c.collectionsDenied.map((d) => (
                  <li key={d.name}><code>{d.name}</code> — {d.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source health</CardTitle>
          <CardDescription>
            Coverage is measured in retrieval-verified documents, not in documents the store
            claims it indexed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {healthError && <p className="text-sm text-destructive">{healthError}</p>}
          {health && (
            <Tabs defaultValue="coverage">
              <TabsList>
                <TabsTrigger value="coverage">Coverage</TabsTrigger>
                <TabsTrigger value="failures">
                  Failures ({health.ingestion.byState.failed})
                </TabsTrigger>
                <TabsTrigger value="unverified">
                  Unproven ({health.ingestion.byState.indexed})
                </TabsTrigger>
                <TabsTrigger value="lag">
                  Lag ({health.freshness.lagging.length})
                </TabsTrigger>
                <TabsTrigger value="scope">Scope</TabsTrigger>
              </TabsList>

              <TabsContent value="coverage" className="space-y-2 pt-3 text-sm">
                {!health.store.configured && (
                  <p className="text-destructive">Store unavailable: {health.store.reason}</p>
                )}
                <p>
                  Retrieval-verified: <strong>{health.ingestion.byState.retrieval_verified}</strong>
                  {' of '}{health.ingestion.total}
                  {health.ingestion.verifiedCoveragePct !== null
                    && ` (${health.ingestion.verifiedCoveragePct}%)`}
                </p>
                <p className="text-muted-foreground">
                  Indexed but unproven {health.ingestion.byState.indexed} ·
                  {' '}discovered {health.ingestion.byState.discovered} ·
                  {' '}failed {health.ingestion.byState.failed} ·
                  {' '}retry queue {health.ingestion.retryQueueDepth}
                </p>
                <p className="text-xs text-muted-foreground">
                  Ledger updated {health.ingestion.ledgerUpdatedAt} · policy v{health.policyVersion}
                </p>
              </TabsContent>

              <TabsContent value="failures" className="pt-3">
                {health.ingestion.failures.length === 0
                  ? <p className="text-sm text-muted-foreground">No failed inputs.</p>
                  : (
                    <ul className="space-y-2 text-sm">
                      {health.ingestion.failures.map((f) => (
                        <li key={f.sourceId} className="rounded-md p-2 ring-1 ring-foreground/10">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="destructive">{f.errorClass}</Badge>
                            {f.autoRetryable
                              ? <Badge variant="outline">auto-retry</Badge>
                              : <Badge variant="outline">needs a decision</Badge>}
                            <span className="text-xs text-muted-foreground">
                              {f.attempts} attempt(s), last {f.lastAttemptAt}
                            </span>
                          </div>
                          <div className="font-mono text-xs">{shortPath(f.sourceId)}</div>
                          <div className="text-xs text-muted-foreground">{f.message}</div>
                        </li>
                      ))}
                    </ul>
                  )}
              </TabsContent>

              <TabsContent value="unverified" className="pt-3">
                <p className="mb-2 text-sm text-muted-foreground">
                  Indexed but never queried back. Treat as missing coverage until verified.
                </p>
                <ul className="space-y-1 font-mono text-xs">
                  {health.ingestion.unverified.map((u) => (
                    <li key={u.sourceId}>{shortPath(u.sourceId)} — {u.collection}</li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="lag" className="pt-3">
                <p className="mb-2 text-sm text-muted-foreground">
                  Source changed after it was indexed. Warn at {health.freshness.warnHours}h,
                  fail at {health.freshness.failHours}h.
                </p>
                <ul className="space-y-1 text-xs">
                  {health.freshness.lagging.map((l) => (
                    <li key={l.sourceId}>
                      <Badge variant={l.severity === 'fail' ? 'destructive' : 'outline'}>
                        {l.lagHours}h
                      </Badge>{' '}
                      <span className="font-mono">{shortPath(l.sourceId)}</span>
                    </li>
                  ))}
                </ul>
              </TabsContent>

              <TabsContent value="scope" className="space-y-2 pt-3 text-sm">
                <p>
                  Present in the store: {health.collections.present.join(', ') || 'none'}
                </p>
                <p>
                  Searchable by you:{' '}
                  {health.collections.searchable.map((s) => `${s.name} (${s.kind})`).join(', ') || 'none'}
                </p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {health.collections.denied.map((d) => (
                    <li key={d.name}><code>{d.name}</code> — {d.reason}</li>
                  ))}
                </ul>
              </TabsContent>
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
