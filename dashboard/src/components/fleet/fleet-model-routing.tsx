'use client';

/**
 * Fleet model routing panel (contract §7 / plan §3).
 *
 * Per agent: role, tier, effective source, desired vs running model with a
 * confidence badge, billing mode + cost class, activation mode, validation
 * errors as inline remediation items, the OS-08 eval-state placeholder, and an
 * expander showing the agent's last dispatch attempts. Actions: change model
 * (optionally clearing legacy pins), clear a legacy pin, revert with a reason.
 *
 * Two honesty rules are encoded here:
 *   - the roster comes from the registry's `agents` map, so an agent that is
 *     enabled but unconfigured is named as such instead of rendering a phantom
 *     row whose config request 404s on every load;
 *   - a receipt is only ever narrated from its own fields, and the panel always
 *     shows the MOST RECENT operation — a blocked operation replaces the
 *     previous receipt rather than leaving its Revert button live.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
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
  describeReceiptOutcome,
  describeRevertControl,
  humanizeRoutingError,
  isLegacyPin,
  summarizeOperations,
  RECEIPT_STATE_ORDER,
  type OperationSummary,
} from './model-routing-view';
import type { Receipt, RegistrySummary, Resolution, RoutingAttempt } from '@/lib/model-routing';

interface FleetModelRoutingProps {
  /** Enabled on-disk agent names (systemName), in display order. */
  agents: string[];
}

interface AgentRouting {
  loading: boolean;
  resolution: Resolution | null;
  error: string | null;
}

interface AttemptsState {
  open: boolean;
  loading: boolean;
  items: RoutingAttempt[];
  supported: boolean;
  error: string | null;
}

interface RoutingIndex {
  summary: RegistrySummary | null;
  mutable: boolean;
  backend: string;
  error: string | null;
  loading: boolean;
}

const ATTEMPT_LIMIT = 5;
/** Journal entries pulled per load. An operation writes 3–6 of them, so this is
 *  roughly the last 20 operations. The route caps the parameter at 200. */
const EVENT_LIMIT = 100;
/** Operations rendered before "Show all". A history nobody can read is not a
 *  history — this is a list of receipts, not a dump of the journal. */
const HISTORY_PAGE = 8;

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
  const [attempts, setAttempts] = useState<Record<string, AttemptsState>>({});
  const [dialogAgent, setDialogAgent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [revertReason, setRevertReason] = useState('');
  // Defect L: the post-operation refresh is not the operation. Holding
  // `submitting` true across it left Revert disabled for ~3s with nothing on
  // screen saying why, and a verifier read that as a broken button.
  const [refreshing, setRefreshing] = useState(false);
  // Defect K: the journal the page already fetches, kept instead of discarded.
  const [events, setEvents] = useState<unknown[]>([]);
  // Open by default: the point of the fix is that the way back is VISIBLE after
  // a reload, not one click away behind a collapsed panel.
  const [historyOpen, setHistoryOpen] = useState(true);
  const [showAllHistory, setShowAllHistory] = useState(false);
  /** The past operation whose revert reason is being edited, and its text. */
  const [historyRevert, setHistoryRevert] = useState<{ operationId: string; reason: string } | null>(null);

  const loadIndex = useCallback(async () => {
    setIndex((p) => ({ ...p, loading: true }));
    try {
      const res = await fetch(`/api/model-routing?limit=${EVENT_LIMIT}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) {
        setIndex({
          summary: null,
          mutable: false,
          backend: body.backend ?? 'unknown',
          error: humanizeRoutingError(body.error) ?? 'routing service unavailable',
          loading: false,
        });
        return;
      }
      // The operation journal comes back on this same request. Dropping it is
      // what made every past change un-undoable after a reload.
      setEvents(Array.isArray(body.events) ? body.events : []);
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
        setRows((p) => ({
          ...p,
          [name]: { loading: false, resolution: null, error: humanizeRoutingError(body.error) ?? `HTTP ${res.status}` },
        }));
        return;
      }
      setRows((p) => ({
        ...p,
        [name]: {
          loading: false,
          resolution: body.routing ?? null,
          error: humanizeRoutingError(body.routing_error) ?? null,
        },
      }));
    } catch (e) {
      setRows((p) => ({ ...p, [name]: { loading: false, resolution: null, error: e instanceof Error ? e.message : 'request failed' } }));
    }
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);

  // ---------------------------------------------------------------------------
  // Roster: the registry's `agents` map is the source of truth for rows.
  // Anything enabled on disk but absent from it is unconfigured — it gets a
  // note, not a row, and its config endpoint is never called.
  // ---------------------------------------------------------------------------
  const registryAgents = useMemo(
    () => (index.summary ? Object.keys(index.summary.agents) : []),
    [index.summary],
  );
  const rosterKey = agents.join(',');
  const rowAgents = useMemo(() => {
    if (!index.summary) return [];
    const enabled = rosterKey ? rosterKey.split(',') : [];
    const inRegistry = new Set(registryAgents);
    const ordered = enabled.filter((a) => inRegistry.has(a));
    const extra = registryAgents.filter((a) => !enabled.includes(a)).sort();
    return [...ordered, ...extra];
  }, [index.summary, registryAgents, rosterKey]);

  const unconfiguredAgents = useMemo(() => {
    if (!index.summary) return [];
    const inRegistry = new Set(registryAgents);
    return (rosterKey ? rosterKey.split(',') : []).filter((a) => !inRegistry.has(a));
  }, [index.summary, registryAgents, rosterKey]);

  const rowKey = rowAgents.join(',');
  useEffect(() => {
    for (const a of rowKey ? rowKey.split(',') : []) void loadAgent(a);
  }, [rowKey, loadAgent]);

  const loadAttempts = useCallback(async (name: string) => {
    setAttempts((p) => ({
      ...p,
      [name]: { open: true, loading: true, items: p[name]?.items ?? [], supported: p[name]?.supported ?? true, error: null },
    }));
    try {
      const res = await fetch(`/api/model-routing?agent=${encodeURIComponent(name)}&limit=${ATTEMPT_LIMIT}`, {
        cache: 'no-store',
      });
      const body = await res.json();
      if (!res.ok) {
        setAttempts((p) => ({
          ...p,
          [name]: { open: true, loading: false, items: [], supported: true, error: humanizeRoutingError(body.error) ?? `HTTP ${res.status}` },
        }));
        return;
      }
      setAttempts((p) => ({
        ...p,
        [name]: { open: true, loading: false, items: body.attempts ?? [], supported: body.supported !== false, error: null },
      }));
    } catch (e) {
      setAttempts((p) => ({
        ...p,
        [name]: { open: true, loading: false, items: [], supported: true, error: e instanceof Error ? e.message : 'request failed' },
      }));
    }
  }, []);

  const toggleAttempts = useCallback(
    (name: string) => {
      const current = attempts[name];
      if (current?.open) {
        setAttempts((p) => ({ ...p, [name]: { ...current, open: false } }));
        return;
      }
      void loadAttempts(name);
    },
    [attempts, loadAttempts],
  );

  const refreshAll = useCallback(async () => {
    await loadIndex();
    await Promise.all(rowAgents.map((a) => loadAgent(a)));
  }, [rowAgents, loadAgent, loadIndex]);

  const patchRouting = useCallback(
    async (agent: string, payload: Record<string, unknown>) => {
      setSubmitting(true);
      setDialogError(null);
      setReceiptError(null);
      // The panel always describes the operation that just ran: drop the
      // previous receipt before the new one has an outcome.
      setReceipt(null);
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/config`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'model_routing', ...payload }),
        });
        const body = await res.json();
        // A receipt in the body describes THIS operation even on a failure
        // status (a blocked operation is a receipt, not an exception).
        setReceipt(body.receipt ?? null);
        if (!res.ok) {
          const msg = humanizeRoutingError(body.error) ?? `HTTP ${res.status}`;
          setDialogError(msg);
          setReceiptError(msg);
          return false;
        }
        // The operation is over the moment its receipt is final. The refresh
        // that follows is a read, and it must not keep the receipt's own
        // controls disabled — it is reported separately instead (defect L).
        setSubmitting(false);
        setRefreshing(true);
        try {
          await refreshAll();
        } finally {
          setRefreshing(false);
        }
        if (body.success === false) {
          // Blocked or failed: a real receipt, but not a change the operator
          // asked for. The panel above shows its state and reason.
          setDialogError(body.receipt?.error ?? 'The routing service blocked this operation.');
          return false;
        }
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
              clear_pins: payload.clear_pins === true,
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
  const outcome = describeReceiptOutcome(receipt);
  const dialogRow = dialogAgent ? rows[dialogAgent] : undefined;
  const busy = submitting || refreshing;
  const revertControl = describeRevertControl({
    canRevert: receiptDisplay?.canRevert === true,
    submitting,
    refreshing,
    mutable: index.mutable,
    reason: revertReason,
  });

  // Defect K: the durable history. Derived from the journal the page already
  // fetches, so it survives a reload — which is the whole point.
  const history = useMemo(
    () => summarizeOperations(events, showAllHistory ? Number.MAX_SAFE_INTEGER : HISTORY_PAGE),
    [events, showAllHistory],
  );

  const revertFromHistory = useCallback(
    async (op: OperationSummary, reason: string) => {
      // The same validated path the in-session receipt uses. A revert is an
      // operation: it is validated, it writes a receipt, and it restarts what
      // it moves. Nothing here reaches around the routing service.
      const target = op.affectedAgents[0] ?? rowAgents[0];
      if (!target) return;
      const ok = await patchRouting(target, {
        action: 'revert',
        operation_id: op.operationId,
        reason,
      });
      if (ok) setHistoryRevert(null);
    },
    [patchRouting, rowAgents],
  );

  // Prefill the revert reason from whichever receipt is on screen, and let the
  // operator replace it — a revert is an operator decision that gets recorded.
  useEffect(() => {
    setRevertReason(receipt ? `Revert of ${receipt.operation_id} from the Fleet page` : '');
  }, [receipt]);

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
        <Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={index.loading || refreshing}>
          {index.loading || refreshing ? 'Refreshing…' : 'Refresh'}
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
          {outcome && <p className="mt-1 text-muted-foreground">{outcome.headline}</p>}
          {outcome && outcome.results.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {outcome.results.map((r) => (
                <li key={r.agent} className={r.ok ? 'text-muted-foreground' : 'text-destructive'}>
                  <span className="font-mono">{r.agent}</span>: {r.ok ? 'restarted' : 'restart failed'}
                  {r.message ? ` — ${r.message}` : ''}
                </li>
              ))}
            </ul>
          )}
          {outcome && outcome.clearedPins.length > 0 && (
            <p className="mt-1 text-muted-foreground">Cleared pins: {outcome.clearedPins.join(', ')}</p>
          )}
          {receipt.affected_consumers?.length > 0 && (
            <p className="mt-1 text-muted-foreground">Affected: {receipt.affected_consumers.join(', ')}</p>
          )}

          {receiptDisplay.canRevert && (
            <div className="mt-2 space-y-1">
              <label htmlFor="revert-reason" className="block font-medium">
                Reason for reverting <span className="text-destructive">*</span>
              </label>
              <input
                id="revert-reason"
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                placeholder="Why is this being reverted? Recorded on the revert receipt."
              />
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={revertControl.disabled}
              onClick={() =>
                void patchRouting(receipt.affected_consumers?.[0] ?? rowAgents[0], {
                  action: 'revert',
                  operation_id: receipt.operation_id,
                  reason: revertReason.trim(),
                })
              }
            >
              Revert
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setReceipt(null)}>
              Dismiss
            </Button>
            {revertControl.note && (
              <span className="text-muted-foreground" aria-live="polite">
                {revertControl.note}
              </span>
            )}
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
            {rowAgents.length === 0 && (
              <tr className="border-t border-border">
                <td colSpan={8} className="px-2 py-3 text-muted-foreground">
                  {index.loading
                    ? 'Loading the model registry…'
                    : 'No agents are bound in the model registry.'}
                </td>
              </tr>
            )}
            {rowAgents.map((agent) => {
              const row = rows[agent];
              const resolution = row?.resolution ?? null;
              const dvr = describeDesiredVsRunning(resolution);
              const role = index.summary?.agents?.[agent]?.role ?? '—';
              const tier = resolution?.requested?.tier ?? index.summary?.roles?.[role]?.tier ?? '—';
              const legacyPin = isLegacyPin(index.summary, agent);
              const att = attempts[agent];
              return (
                <Fragment key={agent}>
                  <tr className="border-t border-border align-top">
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
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-expanded={!!att?.open}
                          onClick={() => toggleAttempts(agent)}
                        >
                          {att?.open ? 'Hide attempts' : 'Attempts'}
                        </Button>
                        {legacyPin && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy || !index.mutable}
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
                  {att?.open && (
                    <tr className="border-t border-border/50 bg-muted/30">
                      <td colSpan={8} className="px-2 py-2">
                        <p className="mb-1 font-medium">Last {ATTEMPT_LIMIT} dispatch attempts — {agent}</p>
                        {att.loading && <p className="text-muted-foreground">Loading attempts…</p>}
                        {att.error && (
                          <p className="text-destructive" role="alert">
                            {att.error}
                          </p>
                        )}
                        {!att.loading && !att.error && !att.supported && (
                          <p className="text-muted-foreground">
                            This routing backend does not report dispatch attempts.
                          </p>
                        )}
                        {!att.loading && !att.error && att.supported && att.items.length === 0 && (
                          <p className="text-muted-foreground">No attempts recorded for this agent yet.</p>
                        )}
                        {att.items.length > 0 && (
                          <table className="w-full text-left">
                            <thead className="text-muted-foreground">
                              <tr>
                                <th scope="col" className="py-1 pr-3 font-medium">When</th>
                                <th scope="col" className="py-1 pr-3 font-medium">Requested</th>
                                <th scope="col" className="py-1 pr-3 font-medium">Resolved</th>
                                <th scope="col" className="py-1 pr-3 font-medium">Observed</th>
                                <th scope="col" className="py-1 font-medium">Confidence</th>
                              </tr>
                            </thead>
                            <tbody>
                              {att.items.map((a, i) => (
                                <tr key={a.attempt_id ?? `${agent}-attempt-${i}`} className="border-t border-border/50">
                                  <td className="py-1 pr-3 text-muted-foreground">{a.at ?? '—'}</td>
                                  <td className="py-1 pr-3 font-mono">{a.requested ?? '—'}</td>
                                  <td className="py-1 pr-3 font-mono">{a.resolved ?? '—'}</td>
                                  <td className="py-1 pr-3 font-mono">{a.observed ?? '—'}</td>
                                  <td className="py-1">
                                    <Badge variant={a.confidence === 'verified' ? 'default' : a.confidence === 'mismatch' ? 'destructive' : 'outline'}>
                                      {a.confidence}
                                    </Badge>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Operation history — durable, so a reload does not erase the way back.
          Everything here comes from the routing journal, not from memory. */}
      <section aria-labelledby="routing-history-heading" className="rounded-lg border border-border">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <h3 id="routing-history-heading" className="text-sm font-medium">
            Operation history
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {history.total === 0
                ? 'no routing operations recorded yet'
                : `${history.total} operation${history.total === 1 ? '' : 's'} recorded`}
            </span>
          </h3>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={historyOpen}
            aria-controls="routing-history-body"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {historyOpen ? 'Hide history' : 'Show history'}
          </Button>
        </div>

        {historyOpen && (
          <div id="routing-history-body" className="border-t border-border px-3 py-2">
            {history.operations.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {index.error
                  ? 'The routing journal could not be read while the service is unavailable.'
                  : 'No routing operations have been recorded for this registry yet.'}
              </p>
            )}

            <ol className="space-y-2">
              {history.operations.map((op) => {
                const editing = historyRevert?.operationId === op.operationId;
                const failedRestarts = op.restarts.filter((r) => !r.ok);
                return (
                  <li key={op.operationId} className="rounded-lg border border-border/60 p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          op.display.applied ? 'default' : op.display.terminalFailure ? 'destructive' : 'outline'
                        }
                      >
                        {op.display.label}
                      </Badge>
                      <span className="font-medium">{op.kind}</span>
                      <span className="text-muted-foreground">{formatWhen(op.at)}</span>
                      <span className="text-muted-foreground">by {op.actor}</span>
                      {op.registryRevision !== null && (
                        <span className="text-muted-foreground">rev {op.registryRevision}</span>
                      )}
                      <span className="font-mono text-[11px] text-muted-foreground">{op.operationId}</span>
                    </div>

                    {op.change && <p className="mt-1">{op.change}</p>}
                    {op.reason && <p className="mt-1 text-muted-foreground">Reason: {op.reason}</p>}
                    {op.revertOf && (
                      <p className="mt-1 text-muted-foreground">
                        Reverted <span className="font-mono">{op.revertOf}</span>.
                      </p>
                    )}
                    {op.affectedAgents.length > 0 && (
                      <p className="mt-1 text-muted-foreground">Affected: {op.affectedAgents.join(', ')}</p>
                    )}
                    {op.restarts.length > 0 && (
                      <p className="mt-1 text-muted-foreground">
                        Restarted {op.restarts.filter((r) => r.ok).length} of {op.restarts.length}
                        {failedRestarts.length > 0 && (
                          <span className="text-destructive">
                            {' '}
                            — failed: {failedRestarts.map((r) => r.agent).join(', ')}
                          </span>
                        )}
                      </p>
                    )}

                    {editing ? (
                      <div className="mt-2 space-y-1">
                        <label htmlFor={`revert-reason-${op.operationId}`} className="block font-medium">
                          Reason for reverting <span className="text-destructive">*</span>
                        </label>
                        <input
                          id={`revert-reason-${op.operationId}`}
                          value={historyRevert.reason}
                          onChange={(e) =>
                            setHistoryRevert({ operationId: op.operationId, reason: e.target.value })
                          }
                          className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                          placeholder="Why is this being reverted? Recorded on the revert receipt."
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={submitting || !index.mutable || historyRevert.reason.trim().length === 0}
                            onClick={() => void revertFromHistory(op, historyRevert.reason.trim())}
                          >
                            Confirm revert
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setHistoryRevert(null)}>
                            Cancel
                          </Button>
                          {refreshing && (
                            <span className="text-muted-foreground" aria-live="polite">
                              Refreshing the registry…
                            </span>
                          )}
                        </div>
                      </div>
                    ) : op.revertible ? (
                      <div className="mt-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={submitting || !index.mutable}
                          onClick={() =>
                            setHistoryRevert({
                              operationId: op.operationId,
                              reason: `Revert of ${op.operationId} from the Fleet page`,
                            })
                          }
                        >
                          Revert
                        </Button>
                      </div>
                    ) : (
                      op.revertBlockedReason && (
                        <p className="mt-2 text-muted-foreground">{op.revertBlockedReason}</p>
                      )
                    )}
                  </li>
                );
              })}
            </ol>

            {history.total > history.operations.length && (
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setShowAllHistory(true)}>
                Show all {history.total} operations
              </Button>
            )}
            {!index.mutable && history.operations.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                This backend can only read the registry, so nothing here can be reverted from the dashboard.
              </p>
            )}
          </div>
        )}
      </section>

      {unconfiguredAgents.length > 0 && (
        <p className="rounded-lg border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground">
          <span className="font-medium">Configuration missing:</span>{' '}
          <span className="font-mono">{unconfiguredAgents.join(', ')}</span> — enabled in
          enabled-agents.json but not bound in the model registry, so there is nothing to route
          yet. Configure the agent before changing its model.
        </p>
      )}

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
          submitting={busy}
          error={dialogError}
          onSubmit={(payload) => void onSubmitChange(dialogAgent, payload)}
        />
      )}
    </section>
  );
}
