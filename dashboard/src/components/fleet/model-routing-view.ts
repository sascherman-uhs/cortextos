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
