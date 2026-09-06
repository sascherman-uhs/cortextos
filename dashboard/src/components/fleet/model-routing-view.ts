/**
 * dashboard/src/components/fleet/model-routing-view.ts — OS-02b-ui
 *
 * Pure presentation logic for the Fleet model-routing surface. Kept free of JSX
 * so it is unit-testable under the repo's vitest config (`**\/__tests__\/*.test.ts`).
 *
 * The hard rule encoded here: a pending receipt is NEVER displayed as applied.
 */

import type {
  ObservedConfidence,
  Receipt,
  ReceiptState,
  RegistrySummary,
  Resolution,
} from '@/lib/model-routing';

// ---------------------------------------------------------------------------
// Receipt state machine
// ---------------------------------------------------------------------------

export const RECEIPT_STATE_ORDER: ReceiptState[] = [
  'requested',
  'validated',
  'desired_written',
  'draining',
  'applied',
];

export type ReceiptTone = 'pending' | 'success' | 'warning' | 'error';

export interface ReceiptDisplay {
  state: ReceiptState;
  label: string;
  tone: ReceiptTone;
  /** True while the operation is still in flight. */
  pending: boolean;
  /** True only for a terminal, successfully applied operation. */
  applied: boolean;
  /** True when the operation stopped without applying. */
  terminalFailure: boolean;
  /** 0-based index into RECEIPT_STATE_ORDER; -1 for off-track states. */
  stepIndex: number;
  totalSteps: number;
  description: string;
  /** Revert is offered only once a change actually reached the registry. */
  canRevert: boolean;
}

const RECEIPT_LABELS: Record<ReceiptState, { label: string; description: string }> = {
  requested: { label: 'Requested', description: 'Submitted to the routing service. Nothing has changed yet.' },
  validated: { label: 'Validated', description: 'Passed capability, context and auth checks. Not yet written.' },
  desired_written: { label: 'Desired written', description: 'Registry updated. Agents still run the previous model until they restart.' },
  draining: { label: 'Draining', description: 'Restarting affected agents one at a time. Not applied yet.' },
  applied: { label: 'Applied', description: 'The operation completed. What it did to running agents is listed below.' },
  blocked: { label: 'Blocked', description: 'Stopped before applying. Needs a human decision.' },
  failed: { label: 'Failed', description: 'The operation errored. Nothing further will happen automatically.' },
  reverted: { label: 'Reverted', description: 'A later revert operation undid this change.' },
};

export function describeReceiptState(state: ReceiptState): ReceiptDisplay {
  const meta = RECEIPT_LABELS[state] ?? { label: state, description: '' };
  const stepIndex = RECEIPT_STATE_ORDER.indexOf(state);
  const applied = state === 'applied';
  const terminalFailure = state === 'blocked' || state === 'failed';
  const pending = !applied && !terminalFailure && state !== 'reverted';
  const tone: ReceiptTone = applied
    ? 'success'
    : state === 'failed'
      ? 'error'
      : state === 'blocked'
        ? 'warning'
        : state === 'reverted'
          ? 'warning'
          : 'pending';
  return {
    state,
    label: meta.label,
    tone,
    pending,
    applied,
    terminalFailure,
    stepIndex,
    totalSteps: RECEIPT_STATE_ORDER.length,
    description: meta.description,
    canRevert: state === 'desired_written' || state === 'draining' || state === 'applied',
  };
}

export function describeReceipt(receipt: Receipt | null | undefined): ReceiptDisplay | null {
  if (!receipt) return null;
  return describeReceiptState(receipt.state);
}

// ---------------------------------------------------------------------------
// Desired vs running
// ---------------------------------------------------------------------------

export interface DesiredVsRunning {
  desired: string;
  running: string;
  confidence: ObservedConfidence;
  confidenceLabel: string;
  tone: ReceiptTone;
  /** True when the observed model differs from the resolved one. */
  drift: boolean;
  hint: string;
}

export function describeDesiredVsRunning(resolution: Resolution | null | undefined): DesiredVsRunning {
  // `expected_model_id` is the registry's own statement of what should run and
  // wins the comparison when the CLI emits it; `selected.model_id` is the
  // fallback on older builds.
  const expected = resolution?.expected_model_id ?? null;
  const selected = resolution?.selected?.model_id ?? null;
  const desired = selected ?? expected ?? '\u2014';
  const target = expected ?? selected;

  const observedModel = resolution?.observed?.model_id ?? null;
  const legacy = resolution?.legacy_effective?.model_id ?? null;
  const running = observedModel ?? legacy ?? 'unknown';

  let confidence: ObservedConfidence;
  if (!observedModel) {
    confidence = 'unconfirmed';
  } else if (target && observedModel !== target) {
    confidence = 'mismatch';
  } else {
    confidence = resolution?.observed?.confidence ?? 'verified';
  }

  const drift = confidence === 'mismatch';
  const confidenceLabel =
    confidence === 'verified' ? 'verified' : confidence === 'mismatch' ? 'mismatch' : 'unconfirmed';

  const provenance: string[] = [];
  const src = resolution?.observed?.source;
  if (src) provenance.push(`source: ${src}`);
  const binding = resolution?.observed?.binding;
  if (binding) provenance.push(`binding: ${binding}`);
  const at = resolution?.observed?.at;
  if (at) provenance.push(`observed ${at}`);

  const base =
    !resolution?.observed || !observedModel
      ? 'no observation available'
      : confidence === 'mismatch'
        ? `The agent is running ${observedModel}, not the ${target ?? 'resolved'} model the registry expects. Restart it or investigate.`
        : 'The running model was read back from the agent session transcript.';

  return {
    desired,
    running,
    confidence,
    confidenceLabel,
    tone: confidence === 'verified' ? 'success' : confidence === 'mismatch' ? 'error' : 'warning',
    drift,
    hint: provenance.length ? `${base} (${provenance.join(' \u00b7 ')})` : base,
  };
}

// ---------------------------------------------------------------------------
// Receipt narration — never claim a restart that did not happen
// ---------------------------------------------------------------------------

export interface RestartSummary {
  /** One honest sentence about restarts, derived only from receipt fields. */
  headline: string;
  results: { agent: string; ok: boolean; message?: string }[];
  clearedPins: string[];
  /** True only when the receipt reports actual restart results. */
  restartsPerformed: boolean;
}

export function describeReceiptOutcome(receipt: Receipt | null | undefined): RestartSummary | null {
  if (!receipt) return null;
  const results = receipt.restart_results ?? [];
  const affected = receipt.affected_consumers ?? [];
  const clearedPins = receipt.cleared_pins ?? [];
  const applied = receipt.state === 'applied';

  let headline: string;
  if (results.length > 0) {
    const ok = results.filter((r) => r.ok).length;
    headline = `Restarted ${ok} of ${results.length} agent${results.length === 1 ? '' : 's'}: ${results
      .map((r) => `${r.agent} ${r.ok ? 'ok' : 'failed'}`)
      .join(', ')}.`;
  } else if (receipt.restart_required === false || affected.length === 0) {
    headline = applied
      ? 'Applied \u2014 no restart needed.'
      : 'No agent restart is needed for this operation.';
  } else if (receipt.restart_required === true) {
    headline = `${affected.length} agent${affected.length === 1 ? '' : 's'} still need a restart to pick this up: ${affected.join(', ')}.`;
  } else {
    headline = `The receipt does not report any restarts. ${affected.length} affected agent${
      affected.length === 1 ? '' : 's'
    } (${affected.join(', ')}) may still be running the previous model.`;
  }

  return { headline, results, clearedPins, restartsPerformed: results.length > 0 };
}

/** Turn a shell-level failure string into something an operator can act on. */
export function humanizeRoutingError(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/exit(ed)?\s+\d+/i.test(message) && /cortextos|routing CLI/i.test(message)) {
    return 'The routing CLI produced no usable output on this host. Check that `cortextos` is installed and on PATH.';
  }
  return message;
}

/** Validation errors rendered as remediation items rather than raw codes. */
export interface RemediationItem {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export function remediationItems(resolution: Resolution | null | undefined): RemediationItem[] {
  const errors = (resolution?.validation?.errors ?? []).map((e) => ({
    code: e.code,
    message: e.message,
    severity: 'error' as const,
  }));
  const warnings = (resolution?.validation?.warnings ?? []).map((w, i) => ({
    code: `warning_${i}`,
    message: w,
    severity: 'warning' as const,
  }));
  return [...errors, ...warnings];
}

// ---------------------------------------------------------------------------
// Effective source / activation / cost
// ---------------------------------------------------------------------------

export function describeEffectiveSource(resolution: Resolution | null | undefined): {
  label: string;
  detail: string;
} {
  const src = resolution?.requested?.source;
  switch (src) {
    case 'pin':
      return { label: 'Pinned', detail: `Agent pin → ${resolution?.requested.entry_id ?? 'unknown entry'}` };
    case 'role':
      return { label: 'Role tier', detail: `Role tier → ${resolution?.requested.tier ?? 'unknown tier'}` };
    case 'override':
      return { label: 'Task override', detail: 'Set for this task by the caller' };
    case 'org_default':
      return { label: 'Org default', detail: `Org default tier → ${resolution?.requested.tier ?? 'unknown tier'}` };
    default:
      return { label: 'Unresolved', detail: 'No routing resolution available' };
  }
}

export function describeActivation(resolution: Resolution | null | undefined): {
  mode: 'shadow' | 'enforced';
  label: string;
  hint: string;
} {
  const mode = resolution?.activation ?? 'shadow';
  return mode === 'enforced'
    ? { mode, label: 'Enforced', hint: 'The resolved model is passed to the runtime. A failed validation refuses the spawn.' }
    : { mode, label: 'Shadow', hint: 'Resolution is reported only. The agent still runs its legacy configured model.' };
}

export function costClassLabel(costClass: number | undefined | null): string {
  if (costClass === undefined || costClass === null) return 'cost —';
  return `cost class ${costClass}`;
}

export function billingModeLabel(mode: string | undefined | null): string {
  if (!mode) return 'billing —';
  return mode.replace(/_/g, ' ');
}

/** Human sentence for the dialog preview: how the switch changes cost/billing. */
export function describeCostChange(
  from: { cost_class?: number; billing_mode?: string } | null | undefined,
  to: { cost_class?: number; billing_mode?: string } | null | undefined,
): string {
  if (!from || !to) return 'Cost impact unknown until the target entry is chosen.';
  const parts: string[] = [];
  if (from.cost_class !== to.cost_class) {
    const dir = (to.cost_class ?? 0) > (from.cost_class ?? 0) ? 'increases' : 'decreases';
    parts.push(`Cost class ${dir}: ${from.cost_class ?? '—'} → ${to.cost_class ?? '—'}.`);
  } else {
    parts.push(`Cost class unchanged (${from.cost_class ?? '—'}).`);
  }
  if (from.billing_mode !== to.billing_mode) {
    parts.push(`Billing mode changes: ${billingModeLabel(from.billing_mode)} → ${billingModeLabel(to.billing_mode)}.`);
  } else {
    parts.push(`Billing mode unchanged (${billingModeLabel(from.billing_mode)}).`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Dialog preview
// ---------------------------------------------------------------------------

export interface SwitchPreview {
  affectedAgents: string[];
  targetEntryId: string | null;
  costSentence: string;
  restartWarning: string;
  blocked: string | null;
  /** Agents in scope that carry a legacy-migration or invalid pin. */
  legacyPinnedAgents: string[];
  /** What "also clear legacy pins" would remove, for the dialog preview. */
  clearablePins: { agent: string; entry_id: string; kind: string }[];
  /** Agents that will restart specifically because this operation clears their
   *  pin. Empty unless the clear-pins option is actually on. */
  restartedByPinClear?: string[];
}

/**
 * Which agents a role-tier switch touches, and what it will do to them.
 *
 * `clearPins` is the dialog's "also clear N legacy pin(s)" checkbox. It is part
 * of the operation, so it has to be part of the prediction: an agent whose pin
 * this change removes DOES move to the new tier and DOES get restarted. Without
 * it the preview said "No agents will be restarted by this change" and then the
 * agent restarted — the one thing a preview must never do.
 */
export function previewRoleSwitch(
  summary: RegistrySummary | null | undefined,
  role: string,
  tier: string,
  currentSelected?: { cost_class?: number; billing_mode?: string } | null,
  opts: { clearPins?: boolean } = {},
): SwitchPreview {
  if (!summary) {
    return {
      affectedAgents: [],
      targetEntryId: null,
      costSentence: 'Cost impact unknown — the registry could not be read.',
      restartWarning: '',
      blocked: 'routing service unavailable',
      legacyPinnedAgents: [],
      clearablePins: [],
    };
  }
  const affectedAgents = Object.entries(summary.agents)
    .filter(([, b]) => b.role === role)
    .map(([agentName]) => agentName)
    .sort();
  const candidates = summary.tiers[tier] ?? [];
  const targetEntryId = candidates[0] ?? null;
  const target = summary.entries.find((e) => e.entry_id === targetEntryId) ?? null;
  const pinned = affectedAgents.filter((a) => summary.agents[a]?.pin);

  const clearablePins = affectedAgents
    .map((a) => ({ agent: a, pin: summary.agents[a]?.pin }))
    .filter((x): x is { agent: string; pin: NonNullable<typeof x.pin> } => !!x.pin)
    .filter((x) => x.pin.kind === 'legacy-migration' || x.pin.kind === 'proposed-invalid')
    .map((x) => ({ agent: x.agent, entry_id: x.pin.entry_id, kind: x.pin.kind }));

  // Clearing a pin is what makes that agent follow the role tier — and what
  // restarts it. Predict the operation as it will actually be submitted.
  const willClear = opts.clearPins === true && clearablePins.length > 0;
  const cleared = new Set(willClear ? clearablePins.map((c) => c.agent) : []);
  const keepsPin = pinned.filter((a) => !cleared.has(a));
  const willRestart = affectedAgents.filter((a) => !keepsPin.includes(a));

  const restartWarning = willRestart.length
    ? `${willRestart.length} agent${willRestart.length === 1 ? '' : 's'} will be restarted one at a time to pick this up: ${willRestart.join(', ')}.`
    : 'No agents will be restarted by this change.';

  const clearedSentence = willClear
    ? ` ${cleared.size} legacy pin${cleared.size === 1 ? '' : 's'} (${[...cleared].join(', ')}) will be cleared by this change, which is why ${cleared.size === 1 ? 'that agent is' : 'those agents are'} in the restart list.`
    : '';

  const blocked =
    candidates.length === 0 ? `Tier "${tier}" has no candidate entries — nothing to switch to.` : null;

  return {
    affectedAgents,
    targetEntryId,
    costSentence: describeCostChange(currentSelected ?? null, target),
    restartWarning:
      restartWarning +
      clearedSentence +
      (keepsPin.length > 0
        ? ` ${keepsPin.length} pinned agent${keepsPin.length === 1 ? '' : 's'} (${keepsPin.join(', ')}) keep their pin and are unaffected unless you clear it below.`
        : ''),
    blocked,
    legacyPinnedAgents: clearablePins.map((c) => c.agent),
    clearablePins,
    /** Restarted BECAUSE their pin is being cleared. Empty unless clearPins. */
    restartedByPinClear: [...cleared],
  };
}

export function previewAgentPin(
  summary: RegistrySummary | null | undefined,
  agent: string,
  entryId: string,
  currentSelected?: { cost_class?: number; billing_mode?: string } | null,
): SwitchPreview {
  if (!summary) {
    return {
      affectedAgents: [agent],
      targetEntryId: entryId,
      costSentence: 'Cost impact unknown — the registry could not be read.',
      restartWarning: '',
      blocked: 'routing service unavailable',
      legacyPinnedAgents: [],
      clearablePins: [],
    };
  }
  const target = summary.entries.find((e) => e.entry_id === entryId) ?? null;
  const blocked = !target
    ? `Entry "${entryId}" is not in the registry.`
    : target.status !== 'active'
      ? `Entry "${entryId}" is ${target.status} and cannot be pinned.`
      : null;
  return {
    affectedAgents: [agent],
    targetEntryId: entryId,
    costSentence: describeCostChange(currentSelected ?? null, target),
    restartWarning: `${agent} will be restarted to pick this up.`,
    blocked,
    legacyPinnedAgents: isLegacyPin(summary, agent) ? [agent] : [],
    clearablePins: [],
  };
}

/** A pin that exists only because of the legacy config migration (contract §5). */
export function isLegacyPin(summary: RegistrySummary | null | undefined, agent: string): boolean {
  const kind = summary?.agents?.[agent]?.pin?.kind;
  return kind === 'legacy-migration' || kind === 'proposed-invalid';
}

export const EVAL_STATE_PLACEHOLDER = 'unevaluated';

export function evalStateLabel(resolution: Resolution | null | undefined): string {
  return resolution?.eval_state ?? EVAL_STATE_PLACEHOLDER;
}

// ---------------------------------------------------------------------------
// Operation history
// ---------------------------------------------------------------------------

/**
 * The panel used to show operation history only from the in-memory receipt, so
 * a page reload erased every receipt, every operation id and every Revert
 * button. The change became un-undoable from the UI: the only way back was
 * `cortextos model revert --operation <id>` in a terminal, with the id no
 * longer displayed anywhere to find.
 *
 * The events were already on the wire — `/api/model-routing` returns them on
 * the same request that fills this panel — and the component simply dropped
 * them. These functions turn that journal into the history the operator needs.
 *
 * The journal is one file per STATE of an operation (requested, validated,
 * desired_written, draining, applied|blocked|failed), so an operation is a
 * GROUP of events, not one of them.
 */

/** One event record as written by the core's `appendEvent`. Every field is
 *  treated as optional: this is a durable on-disk journal that predates some of
 *  the fields, and an older record must degrade rather than throw. */
export interface RoutingEventRecord {
  operation_id?: unknown;
  state?: unknown;
  kind?: unknown;
  actor?: unknown;
  reason?: unknown;
  at?: unknown;
  registry_revision?: unknown;
  detail?: Record<string, unknown> | null;
}

export interface OperationRestart {
  agent: string;
  ok: boolean;
  message?: string;
}

export interface OperationSummary {
  operationId: string;
  kind: string;
  actor: string;
  reason: string;
  /** When the operation reached its final recorded state. */
  at: string | null;
  state: ReceiptState;
  display: ReceiptDisplay;
  registryRevision: number | null;
  affectedAgents: string[];
  restarts: OperationRestart[];
  /** "tier standard → premium", "pin opus → none", … */
  change: string | null;
  /** True when this operation can be handed to the revert action as-is. */
  revertible: boolean;
  /** Why it cannot be reverted, when it cannot. Shown instead of a dead button. */
  revertBlockedReason: string | null;
  /** The id of a later operation that reverted this one. */
  revertedBy: string | null;
  /** For a revert operation, the id it undid. */
  revertOf: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function pinLabel(pin: unknown): string {
  const p = record(pin);
  const id = p ? str(p.entry_id) : null;
  return id ?? 'no pin';
}

/**
 * A one-line "what changed" from the prior/next snapshots the core records.
 * Returns null when the shapes are not recognised — a wrong summary is worse
 * than none, and the operation id and reason still identify the row.
 */
export function describeOperationChange(from: unknown, to: unknown): string | null {
  const f = record(from);
  const t = record(to);
  if (!f && !t) return null;

  const fromTier = f ? str(f.tier) : null;
  const toTier = t ? str(t.tier) : null;
  if (fromTier || toTier) {
    const role = str(t?.role) ?? str(f?.role);
    const cleared = Array.isArray(f?.cleared_pins) ? (f!.cleared_pins as unknown[]).length : 0;
    const head = `${role ? `role ${role}: ` : ''}tier ${fromTier ?? '—'} → ${toTier ?? '—'}`;
    return cleared > 0 ? `${head} (cleared ${cleared} pin${cleared === 1 ? '' : 's'})` : head;
  }

  const agent = str(t?.target_agent) ?? str(f?.target_agent);
  if (agent) return `${agent}: pin ${pinLabel(f?.pin)} → ${pinLabel(t?.pin)}`;

  const fromOrg = f ? str(f.org_default) : null;
  const toOrg = t ? str(t.org_default) : null;
  if (fromOrg || toOrg) return `org activation ${fromOrg ?? '—'} → ${toOrg ?? '—'}`;

  const consumer = str(t?.consumer) ?? str(f?.consumer);
  if (consumer) return `${consumer}: activation ${str(f?.mode) ?? '—'} → ${str(t?.mode) ?? '—'}`;

  return null;
}

/**
 * Whether a past operation can be reverted, and if not, why.
 *
 * The rules mirror what the core will actually do, so the UI never offers a
 * button that is guaranteed to fail:
 *   - a revert restores the `from` snapshot recorded on the target's
 *     `desired_written` event, so an operation that never reached that state
 *     never changed the registry and has nothing to undo;
 *   - a pin/unpin recorded before `target_agent` existed does not say whose pin
 *     it was, and the core refuses to guess.
 */
export function describeRevertability(
  state: ReceiptState,
  from: unknown,
  reachedWritten: boolean,
): { revertible: boolean; reason: string | null } {
  if (!reachedWritten) {
    return {
      revertible: false,
      reason:
        state === 'failed' || state === 'blocked'
          ? 'Nothing to revert — this operation stopped before the registry changed.'
          : 'Nothing to revert yet — the registry has not been written.',
    };
  }
  const f = record(from);
  if (!f) {
    return { revertible: false, reason: 'No prior state was recorded, so there is nothing to restore.' };
  }
  const recognised =
    (str(f.role) !== null && str(f.tier) !== null) ||
    str(f.target_agent) !== null ||
    str(f.org_default) !== null ||
    (str(f.consumer) !== null && str(f.mode) !== null);
  if (recognised) return { revertible: true, reason: null };
  if (str(f.entry_id) !== null) {
    return {
      revertible: false,
      reason:
        'This pin predates target_agent recording, so the registry cannot tell whose pin it was. ' +
        'Re-pin or unpin that agent explicitly instead.',
    };
  }
  return { revertible: false, reason: 'The recorded prior state is not one this panel can restore safely.' };
}

const STATE_RANK: Record<string, number> = {
  requested: 0,
  validated: 1,
  desired_written: 2,
  draining: 3,
  applied: 4,
  blocked: 5,
  failed: 5,
  reverted: 6,
};

function isReceiptState(v: string): v is ReceiptState {
  return v in STATE_RANK;
}

/**
 * Group a flat event journal into operations, most recent first.
 *
 * `limit` caps what is rendered — the journal is unbounded and dumping it is
 * how a history becomes unreadable. The count of operations found is reported
 * separately so the panel can say what it is not showing.
 */
export function summarizeOperations(
  events: unknown[] | null | undefined,
  limit = 8,
): { operations: OperationSummary[]; total: number } {
  const groups = new Map<string, RoutingEventRecord[]>();
  for (const raw of events ?? []) {
    const ev = record(raw) as RoutingEventRecord | null;
    const id = ev ? str(ev.operation_id) : null;
    if (!ev || !id) continue;
    const list = groups.get(id);
    if (list) list.push(ev);
    else groups.set(id, [ev]);
  }

  const summaries: OperationSummary[] = [];
  const revertedBy = new Map<string, string>();

  for (const [operationId, list] of groups) {
    const ordered = [...list].sort((a, b) => (str(a.at) ?? '').localeCompare(str(b.at) ?? ''));
    const written = ordered.find((e) => str(e.state) === 'desired_written');
    // The final recorded state, by rank rather than by file order — a journal
    // read out of order must not report an applied operation as "requested".
    const final = ordered.reduce((best, e) => {
      const s = str(e.state) ?? '';
      const b = str(best.state) ?? '';
      return (STATE_RANK[s] ?? -1) >= (STATE_RANK[b] ?? -1) ? e : best;
    }, ordered[0]);

    const stateRaw = str(final.state) ?? 'requested';
    const state: ReceiptState = isReceiptState(stateRaw) ? stateRaw : 'requested';

    const writtenDetail = record(written?.detail);
    const from = writtenDetail?.from ?? null;
    const to = writtenDetail?.to ?? null;

    const affected = new Set<string>();
    const restarts: OperationRestart[] = [];
    for (const e of ordered) {
      const d = record(e.detail);
      if (!d) continue;
      if (Array.isArray(d.affected_consumers)) {
        for (const a of d.affected_consumers) { const n = str(a); if (n) affected.add(n); }
      }
      if (Array.isArray(d.agents)) {
        for (const a of d.agents) { const n = str(a); if (n) affected.add(n); }
      }
      if (Array.isArray(d.restart_results)) {
        restarts.length = 0;
        for (const r of d.restart_results as unknown[]) {
          const rr = record(r);
          const agent = rr ? str(rr.agent) : null;
          if (!agent) continue;
          restarts.push({
            agent,
            ok: rr!.ok === true,
            ...(str(rr!.detail) ? { message: str(rr!.detail)! } : {}),
          });
        }
      }
      // A revert names its target in the operation it recorded as requested.
      const opDetail = record(d.op);
      const targetId = opDetail ? str(opDetail.operation_id) : null;
      if (targetId && str(e.kind) === 'revert') revertedBy.set(targetId, operationId);
    }

    const rev = describeRevertability(state, from, !!written);
    const opDetail = record(record(ordered[0]?.detail)?.op);

    summaries.push({
      operationId,
      kind: str(final.kind) ?? 'operation',
      actor: str(final.actor) ?? 'unknown',
      reason: str(final.reason) ?? '',
      at: str(final.at),
      state,
      display: describeReceiptState(state),
      registryRevision:
        typeof final.registry_revision === 'number' ? final.registry_revision : null,
      affectedAgents: [...affected],
      restarts,
      change: describeOperationChange(from, to),
      revertible: rev.revertible,
      revertBlockedReason: rev.reason,
      revertedBy: null,
      revertOf: str(final.kind) === 'revert' && opDetail ? str(opDetail.operation_id) : null,
    });
  }

  // Newest first. An event with no timestamp sorts last rather than jumping the
  // queue on an empty string comparison.
  summaries.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));

  for (const s of summaries) {
    const by = revertedBy.get(s.operationId);
    if (by) {
      s.revertedBy = by;
      // Already undone: offering Revert again would re-apply the change under a
      // label that says the opposite.
      s.revertible = false;
      s.revertBlockedReason = `Already reverted by ${by}.`;
    }
  }

  return { operations: summaries.slice(0, Math.max(0, limit)), total: summaries.length };
}

/**
 * Whether the Revert control is usable right now, and what to say when it is
 * not (defect L).
 *
 * The post-operation refresh is a READ. Treating it as part of the operation
 * left Revert disabled for ~3 seconds after the receipt was already final,
 * with nothing on screen explaining the dead button — a verifier reported it
 * as a failure. An operation in flight still disables it, because two
 * overlapping routing operations is a real hazard; a refresh is not.
 */
export function describeRevertControl(input: {
  canRevert: boolean;
  /** A routing operation is in flight right now. */
  submitting: boolean;
  /** The panel is re-reading the registry after a finished operation. */
  refreshing: boolean;
  mutable: boolean;
  reason: string;
}): { disabled: boolean; note: string | null } {
  const note = input.refreshing ? 'Refreshing the registry… the operation is already finished.' : null;
  if (!input.canRevert) return { disabled: true, note };
  if (!input.mutable) return { disabled: true, note: 'This routing backend is read-only.' };
  if (input.submitting) return { disabled: true, note: 'Another routing operation is still running.' };
  if (input.reason.trim().length === 0) return { disabled: true, note };
  return { disabled: false, note };
}
