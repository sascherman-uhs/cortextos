'use client';

/**
 * Fleet model routing panel (contract §7 / plan §3).
 *
 * Per agent: role, tier, effective source, desired vs running model with a
 * confidence badge, billing mode + cost class, activation mode, validation
 * errors inline, and the OS-08 eval-state placeholder. Actions: change model,
 * clear a legacy pin, revert a receipt.
 *
 * A submitted operation is shown through its receipt state machine. A pending
 * receipt is never rendered as applied.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ActivationBadge,
  ConfidenceBadge,
  CostBadges,
  EffectiveSourceBadge,
  EvalStateBadge,
  ValidationErrors,
} from './routing-badges';
import { ChangeModelDialog, type ChangeModelSubmit } from './change-model-dialog';
import {
  describeDesiredVsRunning,
  describeReceipt,
  isLegacyPin,
  RECEIPT_STATE_ORDER,
} from './model-routing-view';
import type { Receipt, RegistrySummary, Resolution } from '@/lib/model-routing';

interface FleetModelRoutingProps {
  /** On-disk agent names (systemName), in display order. */
  agents: string[];
}

interface AgentRouting {
  loading: boolean;
  resolution: Resolution | null;
  error: string | null;
}

interface RoutingIndex {
  summary: RegistrySummary | null;
  mutable: boolean;
  backend: string;
  error: string | null;
  loading: boolean;
}

export function FleetModelRouting({ agents }: FleetModelRoutingProps) {
  const [index, setIndex] = useState<RoutingIndex>({
    summary: null,
    mutable: false,
    backend: 'unknown',
    error: null,
    loading: true,
  });
  const [rows, setRows] = useState<Record<string, AgentRouting>>({});
  const [dialogAgent, setDialogAgent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const loadIndex = useCallback(async () => {
    setIndex((p) => ({ ...p, loading: true }));
    try {
      const res = await fetch('/api/model-routing', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) {
        setIndex({ summary: null, mutable: false, backend: body.backend ?? 'unknown', error: body.error ?? 'routing service unavailable', loading: false });
        return;
      }
      setIndex({ summary: body.registry, mutable: !!body.mutable, backend: body.backend, error: null, loading: false });
    } catch (e) {
      setIndex({ summary: null, mutable: false, backend: 'unknown', error: e instanceof Error ? e.message : 'request failed', loading: false });
    }
  }, []);

  const loadAgent = useCallback(async (name: string) => {
    setRows((p) => ({ ...p, [name]: { loading: true, resolution: p[name]?.resolution ?? null, error: null } }));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}/config`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) {
        setRows((p) => ({ ...p, [name]: { loading: false, resolution: null, error: body.error ?? `HTTP ${res.status}` } }));
        return;
      }
      setRows((p) => ({
        ...p,
        [name]: { loading: false, resolution: body.routing ?? null, error: body.routing_error ?? null },
      }));
    } catch (e) {
      setRows((p) => ({ ...p, [name]: { loading: false, resolution: null, error: e instanceof Error ? e.message : 'request failed' } }));
    }
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // Keyed on the roster contents, not the array identity: the server component
  // hands us a fresh array on every render.
  const rosterKey = agents.join(',');
  useEffect(() => {
    for (const a of rosterKey ? rosterKey.split(',') : []) void loadAgent(a);
  }, [rosterKey, loadAgent]);

  const refreshAll = useCallback(async () => {
    await loadIndex();
    await Promise.all(agents.map((a) => loadAgent(a)));
  }, [agents, loadAgent, loadIndex]);

  const patchRouting = useCallback(
    async (agent: string, payload: Record<string, unknown>) => {
      setSubmitting(true);
      setDialogError(null);
      setReceiptError(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/config`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'model_routing', ...payload }),
        });
        const body = await res.json();
        if (!res.ok) {
          setDialogError(body.error ?? `HTTP ${res.status}`);
          setReceiptError(body.error ?? `HTTP ${res.status}`);
          return false;
        }
        setReceipt(body.receipt ?? null);
        await refreshAll();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'request failed';
        setDialogError(msg);
        setReceiptError(msg);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [refreshAll],
  );

  const onSubmitChange = useCallback(
    async (agent: string, payload: ChangeModelSubmit) => {
      const ok =
        payload.mode === 'role_tier'
          ? await patchRouting(agent, {
              action: 'switch',
              role: payload.role,
              tier: payload.tier,
              reason: payload.reason,
              expected_revision: payload.expected_revision,
            })
          : await patchRouting(agent, {
              action: 'pin',
              agent,
              entry_id: payload.entry_id,
              reason: payload.reason,
            });
      if (ok) setDialogAgent(null);
    },
    [patchRouting],
  );

  const receiptDisplay = describeReceipt(receipt);
  const dialogRow = dialogAgent ? rows[dialogAgent] : undefined;

  return (
    <section className="space-y-3" aria-labelledby="fleet-model-routing-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="fleet-model-routing-heading" className="text-lg font-medium">
            Model routing
          </h2>
          <p className="text-xs text-muted-foreground">
            Backend: {index.backend}
            {index.summary ? ` · registry revision ${index.summary.revision}` : ''}
            {index.mutable ? '' : ' · read-only'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={index.loading}>
          {index.loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {index.error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">
          {index.error} — model switching is unavailable until the routing service is reachable.
        </p>
      )}

      {receiptDisplay && receipt && (
        <div className="rounded-lg border border-border p-3 text-xs" role="status" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={receiptDisplay.applied ? 'default' : receiptDisplay.tone === 'error' ? 'destructive' : 'outline'}>
              {receiptDisplay.label}
            </Badge>
            <span className="text-muted-foreground">
              {receiptDisplay.stepIndex >= 0
                ? `Step ${receiptDisplay.stepIndex + 1} of ${RECEIPT_STATE_ORDER.length}`
                : 'Off the normal path'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{receipt.operation_id}</span>
          </div>
          <p className="mt-1 text-muted-foreground">{receiptDisplay.description}</p>
          {receipt.error && <p className="mt-1 text-destructive">{receipt.error}</p>}
          {receipt.affected_consumers?.length > 0 && (
            <p className="mt-1 text-muted-foreground">Affected: {receipt.affected_consumers.join(', ')}</p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!receiptDisplay.canRevert || submitting || !index.mutable}
              onClick={() =>
                void patchRouting(receipt.affected_consumers?.[0] ?? agents[0], {
                  action: 'revert',
                  operation_id: receipt.operation_id,
                  reason: `Revert of ${receipt.operation_id} from the Fleet page`,
                })
              }
            >
              Revert
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setReceipt(null)}>
              Dismiss
            </Button>
          </div>
          {receiptError && <p className="mt-1 text-destructive">{receiptError}</p>}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Model routing per agent</caption>
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">Agent</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Role / tier</th>
              <th scope="col" className="hidden px-2 py-1.5 font-medium sm:table-cell">Source</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Desired → running</th>
              <th scope="col" className="hidden px-2 py-1.5 font-medium lg:table-cell">Billing</th>
              <th scope="col" className="hidden px-2 py-1.5 font-medium lg:table-cell">Activation</th>
              <th scope="col" className="hidden px-2 py-1.5 font-medium lg:table-cell">Eval</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const row = rows[agent];
              const resolution = row?.resolution ?? null;
              const dvr = describeDesiredVsRunning(resolution);
              const role = index.summary?.agents?.[agent]?.role ?? '—';
              const tier = resolution?.requested?.tier ?? index.summary?.roles?.[role]?.tier ?? '—';
              const legacyPin = isLegacyPin(index.summary, agent);
              return (
                <tr key={agent} className="border-t border-border align-top">
                  <th scope="row" className="px-2 py-1.5 font-medium">{agent}</th>
                  <td className="px-2 py-1.5">
                    {role} / {tier}
                  </td>
                  <td className="hidden px-2 py-1.5 sm:table-cell">
                    <EffectiveSourceBadge resolution={resolution} />
                  </td>
                  <td className="px-2 py-1.5">
                    {row?.loading && !resolution ? (
                      <span className="text-muted-foreground">Loading…</span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-mono">{dvr.desired}</span>
                        <span aria-hidden="true">→</span>
                        <span className="font-mono">{dvr.running}</span>
                        <ConfidenceBadge resolution={resolution} />
                      </span>
                    )}
                    {row?.error && (
                      <p className="mt-1 text-destructive" role="alert">
                        {row.error}
                      </p>
                    )}
                    <ValidationErrors resolution={resolution} />
                  </td>
                  <td className="hidden px-2 py-1.5 lg:table-cell">
                    <CostBadges resolution={resolution} />
                  </td>
                  <td className="hidden px-2 py-1.5 lg:table-cell">
                    <ActivationBadge resolution={resolution} />
                  </td>
                  <td className="hidden px-2 py-1.5 lg:table-cell">
                    <EvalStateBadge resolution={resolution} />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <Button size="xs" variant="outline" onClick={() => { setDialogError(null); setDialogAgent(agent); }}>
                        Change model
                      </Button>
                      {legacyPin && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={submitting || !index.mutable}
                          onClick={() =>
                            void patchRouting(agent, {
                              action: 'unpin',
                              agent,
                              reason: 'Clear legacy migration pin from the Fleet page',
                            })
                          }
                        >
                          Clear legacy pin
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dialogAgent && (
        <ChangeModelDialog
          key={dialogAgent}
          open={!!dialogAgent}
          onOpenChange={(o) => !o && setDialogAgent(null)}
          agent={dialogAgent}
          role={index.summary?.agents?.[dialogAgent]?.role ?? ''}
          resolution={dialogRow?.resolution ?? null}
          summary={index.summary}
          mutable={index.mutable}
          submitting={submitting}
          error={dialogError}
          onSubmit={(payload) => void onSubmitChange(dialogAgent, payload)}
        />
      )}
    </section>
  );
}
