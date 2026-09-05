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
  applied: { label: 'Applied', description: 'Affected agents restarted and resolved to the new model.' },
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
  const desired = resolution?.selected?.model_id ?? '—';
  const observedModel = resolution?.observed?.model_id ?? null;
  const legacy = resolution?.legacy_effective?.model_id ?? null;
  const running = observedModel ?? legacy ?? 'unknown';

  let confidence: ObservedConfidence = resolution?.observed?.confidence ?? 'unconfirmed';
  if (!resolution?.observed) confidence = 'unconfirmed';
  if (observedModel && resolution?.selected && observedModel !== resolution.selected.model_id) confidence = 'mismatch';

  const drift = confidence === 'mismatch';
  const confidenceLabel =
    confidence === 'verified' ? 'verified' : confidence === 'mismatch' ? 'mismatch' : 'unconfirmed';
  const hint =
    confidence === 'verified'
      ? 'The running model was read back from the agent session transcript.'
      : confidence === 'mismatch'
        ? 'The agent is running a different model than the registry resolves. Restart it or investigate.'
        : 'No session evidence yet — the running model is inferred, not confirmed.';
  return {
    desired,
    running,
    confidence,
    confidenceLabel,
    tone: confidence === 'verified' ? 'success' : confidence === 'mismatch' ? 'error' : 'warning',
    drift,
    hint,
  };
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
}

/** Which agents a role-tier switch touches, and what it will do to them. */
export function previewRoleSwitch(
  summary: RegistrySummary | null | undefined,
  role: string,
  tier: string,
  currentSelected?: { cost_class?: number; billing_mode?: string } | null,
): SwitchPreview {
  if (!summary) {
    return {
      affectedAgents: [],
      targetEntryId: null,
      costSentence: 'Cost impact unknown — the registry could not be read.',
      restartWarning: '',
      blocked: 'routing service unavailable',
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
  const willRestart = affectedAgents.filter((a) => !pinned.includes(a));

  const restartWarning = willRestart.length
    ? `${willRestart.length} agent${willRestart.length === 1 ? '' : 's'} will be restarted one at a time to pick this up: ${willRestart.join(', ')}.`
    : 'No agents will be restarted by this change.';

  const blocked =
    candidates.length === 0 ? `Tier "${tier}" has no candidate entries — nothing to switch to.` : null;

  return {
    affectedAgents,
    targetEntryId,
    costSentence: describeCostChange(currentSelected ?? null, target),
    restartWarning:
      pinned.length > 0
        ? `${restartWarning} ${pinned.length} pinned agent${pinned.length === 1 ? '' : 's'} (${pinned.join(', ')}) keep their pin and are unaffected.`
        : restartWarning,
    blocked,
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
