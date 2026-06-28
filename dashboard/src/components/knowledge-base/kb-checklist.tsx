'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  IconLock,
  IconWorld,
  IconChevronRight,
  IconCircleCheck,
  IconCircle,
  IconCircleDot,
  IconLoader2,
  IconRefresh,
  IconFlame,
} from '@tabler/icons-react';
import taxonomy from '@/data/ideal-kb-taxonomy.json';
import priorities from '@/data/ideal-kb-priorities.json';

interface TaxonomyDoc {
  id: string;
  name: string;
  purpose: string;
}
interface TaxonomyCategory {
  id: string;
  category: string;
  part: 'Internal' | 'External';
  docs: TaxonomyDoc[];
}
interface ItemState {
  done: boolean;
  note?: string;
  updatedAt: string;
}
interface DetectedState {
  source: string;
  score: number;
  detectedAt: string;
}

const CATEGORIES = taxonomy.categories as TaxonomyCategory[];
const TOTAL = taxonomy.total as number;

interface Priority {
  impact: number;
  tier: 'High' | 'Medium' | 'Low';
  rank: number;
  why: string;
}
const PRIORITIES = (priorities.scores ?? {}) as Record<string, Priority>;
const DEFAULT_PRIORITY: Priority = { impact: 50, tier: 'Medium', rank: 999, why: '' };
const prio = (docId: string): Priority => PRIORITIES[docId] ?? DEFAULT_PRIORITY;

// Flat lookup of every doc with its category, for the cross-category opportunities list.
const ALL_DOCS = CATEGORIES.flatMap((c) =>
  c.docs.map((d) => ({ ...d, category: c.category, part: c.part })),
);

const TIER_BADGE: Record<Priority['tier'], string> = {
  High: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  Medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  Low: 'bg-muted text-muted-foreground',
};

type DocStatus = 'complete' | 'detected' | 'outstanding';
type FilterMode = 'all' | 'outstanding' | 'detected' | 'complete';

export function KnowledgeBaseChecklist({ org }: { org: string }) {
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [detected, setDetected] = useState<Record<string, DetectedState>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterMode>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [comparing, setComparing] = useState(false);
  const [compareMsg, setCompareMsg] = useState('');

  const load = () => {
    if (!org) {
      setLoading(false);
      return;
    }
    fetch(`/api/kb/checklist?org=${encodeURIComponent(org)}`)
      .then((r) => r.json())
      .then((d) => {
        setItems(d.items || {});
        setDetected(d.detected || {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, [org]);

  const statusOf = (docId: string): DocStatus => {
    if (items[docId]?.done) return 'complete';
    if (detected[docId]) return 'detected';
    return 'outstanding';
  };

  const counts = useMemo(() => {
    let complete = 0;
    let detectedPending = 0;
    for (const cat of CATEGORIES) {
      for (const d of cat.docs) {
        const s = items[d.id]?.done ? 'complete' : detected[d.id] ? 'detected' : 'outstanding';
        if (s === 'complete') complete += 1;
        else if (s === 'detected') detectedPending += 1;
      }
    }
    return { complete, detectedPending, outstanding: TOTAL - complete - detectedPending };
  }, [items, detected]);

  const pct = TOTAL ? Math.round((counts.complete / TOTAL) * 100) : 0;

  // Highest-impact documents not yet confirmed — the prioritized build queue.
  const topOpportunities = useMemo(
    () =>
      ALL_DOCS.filter((d) => !items[d.id]?.done)
        .sort((a, b) => prio(a.id).rank - prio(b.id).rank)
        .slice(0, 10),
    [items],
  );

  const setDone = async (docId: string, done: boolean) => {
    setItems((prev) => ({
      ...prev,
      [docId]: { done, updatedAt: new Date().toISOString(), note: prev[docId]?.note },
    }));
    setSaving((prev) => new Set(prev).add(docId));
    try {
      const res = await fetch('/api/kb/checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org, id: docId, done }),
      });
      const data = await res.json();
      if (data.items) setItems(data.items);
      if (data.detected) setDetected(data.detected);
    } catch {
      load();
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    }
  };

  const runComparison = async () => {
    setComparing(true);
    setCompareMsg('');
    try {
      const res = await fetch('/api/kb/checklist/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setDetected(data.detected || {});
        setCompareMsg(
          `Compared ${data.sourceDocuments} KB documents → ${data.detectedCount} requirements detected.`,
        );
      } else {
        setCompareMsg(data.error || 'Comparison failed.');
      }
    } catch {
      setCompareMsg('Could not reach comparison service.');
    } finally {
      setComparing(false);
    }
  };

  const toggleCollapse = (catId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(catId) ? next.delete(catId) : next.add(catId);
      return next;
    });

  const visibleDoc = (docId: string) => {
    if (filter === 'all') return true;
    return statusOf(docId) === filter;
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-6">
        <IconLoader2 size={15} className="animate-spin" />
        Loading checklist…
      </div>
    );
  }

  const internal = CATEGORIES.filter((c) => c.part === 'Internal');
  const external = CATEGORIES.filter((c) => c.part === 'External');

  const renderCategory = (cat: TaxonomyCategory) => {
    const catComplete = cat.docs.filter((d) => statusOf(d.id) === 'complete').length;
    // Highest-impact (lowest rank) first within each category.
    const visibleDocs = cat.docs
      .filter((d) => visibleDoc(d.id))
      .sort((a, b) => prio(a.id).rank - prio(b.id).rank);
    if (visibleDocs.length === 0) return null;
    const isCollapsed = collapsed.has(cat.id);
    const allDone = catComplete === cat.docs.length;

    return (
      <div key={cat.id} className="rounded-lg border bg-card">
        <button
          onClick={() => toggleCollapse(cat.id)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors rounded-t-lg"
        >
          <IconChevronRight
            size={15}
            className={`text-muted-foreground transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-sm font-medium flex-1">{cat.category}</span>
          <span
            className={`text-xs font-medium tabular-nums rounded-full px-2 py-0.5 ${
              allDone
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {catComplete}/{cat.docs.length}
          </span>
        </button>

        {!isCollapsed && (
          <ul className="divide-y divide-border/60 border-t">
            {visibleDocs.map((doc) => {
              const status = statusOf(doc.id);
              const det = detected[doc.id];
              const isSaving = saving.has(doc.id);
              // Click behavior: confirm/mark-complete from outstanding & detected; un-confirm from complete.
              const onClick = () => setDone(doc.id, status !== 'complete');
              return (
                <li key={doc.id}>
                  <button
                    onClick={onClick}
                    disabled={isSaving}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-muted/30 transition-colors disabled:opacity-60"
                    title={
                      status === 'detected'
                        ? `Detected in ${det?.source} (${det?.score?.toFixed(2)}). Click to confirm.`
                        : status === 'complete'
                          ? 'Confirmed in KB. Click to un-confirm.'
                          : 'Click to mark as added.'
                    }
                  >
                    <span className="mt-0.5 shrink-0">
                      {isSaving ? (
                        <IconLoader2 size={16} className="animate-spin text-muted-foreground" />
                      ) : status === 'complete' ? (
                        <IconCircleCheck size={16} className="text-emerald-500" />
                      ) : status === 'detected' ? (
                        <IconCircleDot size={16} className="text-amber-500" />
                      ) : (
                        <IconCircle size={16} className="text-muted-foreground/40" />
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2">
                        <span
                          className={`text-sm ${status === 'complete' ? 'line-through text-muted-foreground' : 'font-medium'}`}
                        >
                          {doc.name}
                        </span>
                        {status !== 'complete' && (
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TIER_BADGE[prio(doc.id).tier]}`}
                            title={prio(doc.id).why}
                          >
                            {prio(doc.id).tier} · {prio(doc.id).impact}
                          </span>
                        )}
                        {status === 'detected' && (
                          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            Detected · confirm
                          </span>
                        )}
                      </span>
                      {doc.purpose && (
                        <span className="block text-xs text-muted-foreground mt-0.5">{doc.purpose}</span>
                      )}
                      {status === 'detected' && det && (
                        <span className="block text-[11px] text-amber-600/80 dark:text-amber-400/80 mt-0.5 truncate">
                          ↳ likely in <span className="font-mono">{det.source}</span> ({det.score.toFixed(2)})
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 mt-3">
      {/* Progress header */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Ideal Knowledge Base — Build Progress</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              The north-star taxonomy of {TOTAL} documents a complete home-staging business should hold.
              Confirm items as you add them; the nightly comparison flags likely matches for you to confirm.
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-2xl font-semibold tabular-nums">{pct}%</div>
            <div className="text-xs text-muted-foreground tabular-nums">
              {counts.complete} / {TOTAL} confirmed
            </div>
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted mt-3 flex">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          <div
            className="h-full bg-amber-400/70 transition-all"
            style={{ width: `${TOTAL ? (counts.detectedPending / TOTAL) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> {counts.complete} confirmed
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-400" /> {counts.detectedPending} detected
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> {counts.outstanding} outstanding
            </span>
          </div>
          <button
            onClick={runComparison}
            disabled={comparing}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted/60 transition-colors disabled:opacity-50"
          >
            {comparing ? (
              <IconLoader2 size={13} className="animate-spin" />
            ) : (
              <IconRefresh size={13} />
            )}
            {comparing ? 'Comparing…' : 'Run comparison now'}
          </button>
        </div>
        {compareMsg && <p className="text-[11px] text-muted-foreground mt-1.5">{compareMsg}</p>}
      </div>

      {/* Top outstanding opportunities — prioritized build queue */}
      {topOpportunities.length > 0 && (
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-1.5 mb-1">
            <IconFlame size={15} className="text-rose-500" />
            <h3 className="text-sm font-semibold">Top opportunities to build next</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Highest-impact documents not yet in the KB, ranked by likely business result
            (revenue, leads, operational leverage). Click one to mark it added.
          </p>
          <ol className="space-y-1">
            {topOpportunities.map((doc, i) => {
              const p = prio(doc.id);
              const status = statusOf(doc.id);
              const det = detected[doc.id];
              const isSaving = saving.has(doc.id);
              return (
                <li key={doc.id}>
                  <button
                    onClick={() => setDone(doc.id, true)}
                    disabled={isSaving}
                    className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/40 transition-colors disabled:opacity-60"
                    title={`${p.why}${det ? ` · detected in ${det.source}` : ''}`}
                  >
                    <span className="mt-0.5 w-5 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{doc.name}</span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TIER_BADGE[p.tier]}`}
                        >
                          {p.tier} · {p.impact}
                        </span>
                        {status === 'detected' && (
                          <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            Detected · confirm
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">{doc.category}</span>
                      </span>
                      {p.why && (
                        <span className="block text-[11px] text-muted-foreground mt-0.5">{p.why}</span>
                      )}
                    </span>
                    {isSaving && <IconLoader2 size={14} className="animate-spin text-muted-foreground mt-0.5" />}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {([
          ['all', `All (${TOTAL})`],
          ['outstanding', `Outstanding (${counts.outstanding})`],
          ['detected', `Detected (${counts.detectedPending})`],
          ['complete', `Confirmed (${counts.complete})`],
        ] as [FilterMode, string][]).map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => setFilter(mode)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === mode
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Internal */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <IconLock size={13} />
          Part A — Internal ({taxonomy.internalCategories} categories)
        </div>
        {internal.map(renderCategory)}
      </div>

      {/* External */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <IconWorld size={13} />
          Part B — External ({taxonomy.externalCategories} categories)
        </div>
        {external.map(renderCategory)}
      </div>
    </div>
  );
}
