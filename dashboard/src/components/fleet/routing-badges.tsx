'use client';

/**
 * Small presentational badges for the Fleet routing table. All wording comes
 * from `model-routing-view.ts` so the display rules stay unit-testable.
 */

import { Badge } from '@/components/ui/badge';
import {
  billingModeLabel,
  costClassLabel,
  describeActivation,
  describeDesiredVsRunning,
  describeEffectiveSource,
  evalStateLabel,
  remediationItems,
  type ReceiptTone,
} from './model-routing-view';
import type { Resolution } from '@/lib/model-routing';

const TONE_VARIANT: Record<ReceiptTone, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  success: 'default',
  warning: 'outline',
  error: 'destructive',
};

/**
 * Answers exactly one question: is the running model the one we EXPECTED to be
 * running? The label says so in words and names its own baseline, because the
 * same badge sat next to a resolved-vs-running arrow and was read as a verdict
 * on that comparison instead.
 */
export function ConfidenceBadge({ resolution }: { resolution: Resolution | null }) {
  const d = describeDesiredVsRunning(resolution);
  return (
    <Badge
      variant={TONE_VARIANT[d.tone]}
      title={d.hint}
      aria-label={`Running model versus expected: ${d.expectationLabel}. ${d.hint}`}
    >
      {d.expectationLabel}
    </Badge>
  );
}

/** The registry route, and whether it is actually being applied. */
export function ResolvedRouteCell({ resolution }: { resolution: Resolution | null }) {
  const d = describeDesiredVsRunning(resolution);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono">{d.resolved}</span>
      {d.resolvedNote && (
        <Badge
          variant="outline"
          title={
            'Shadow mode: this route is computed but not passed to the runtime, so it is not ' +
            'what the agent is running. That is the intended behaviour of shadow, not a fault.'
          }
        >
          {d.resolvedNote}
        </Badge>
      )}
    </span>
  );
}

/** What is actually running, plus the expectation verdict and its baseline. */
export function RunningModelCell({ resolution }: { resolution: Resolution | null }) {
  const d = describeDesiredVsRunning(resolution);
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="font-mono">{d.running}</span>
      <ConfidenceBadge resolution={resolution} />
      <span className="w-full text-muted-foreground">
        expected {d.expected} &middot; from {d.expectedFromLabel}
      </span>
    </span>
  );
}

export function ActivationBadge({ resolution }: { resolution: Resolution | null }) {
  const a = describeActivation(resolution);
  return (
    <Badge variant={a.mode === 'enforced' ? 'default' : 'outline'} title={a.hint}>
      {a.label}
    </Badge>
  );
}

export function EffectiveSourceBadge({ resolution }: { resolution: Resolution | null }) {
  const s = describeEffectiveSource(resolution);
  return (
    <Badge variant="secondary" title={s.detail}>
      {s.label}
    </Badge>
  );
}

export function CostBadges({ resolution }: { resolution: Resolution | null }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant="outline">{billingModeLabel(resolution?.selected?.billing_mode)}</Badge>
      <Badge variant="outline">{costClassLabel(resolution?.selected?.cost_class)}</Badge>
    </span>
  );
}

export function EvalStateBadge({ resolution }: { resolution: Resolution | null }) {
  return (
    <Badge variant="outline" title="Evaluation harness lands with OS-08; nothing has been scored yet.">
      {evalStateLabel(resolution)}
    </Badge>
  );
}

/**
 * Validation output rendered as remediation items: the operator-facing message
 * leads, the machine code is a chip beside it. A failed validation is a thing
 * to fix, not a shell exit status.
 */
export function ValidationErrors({ resolution }: { resolution: Resolution | null }) {
  const items = remediationItems(resolution);
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-xs">
      {items.map((item) => (
        <li
          key={item.code}
          className={
            item.severity === 'error'
              ? 'rounded-lg border border-destructive/40 bg-destructive/5 px-1.5 py-1'
              : 'text-muted-foreground'
          }
        >
          {item.severity === 'error' && (
            <span className="mr-1 font-mono text-[10px] uppercase tracking-wide text-destructive">
              {item.code}
            </span>
          )}
          <span className={item.severity === 'error' ? 'text-destructive' : undefined}>{item.message}</span>
        </li>
      ))}
    </ul>
  );
}
