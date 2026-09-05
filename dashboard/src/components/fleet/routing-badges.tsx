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
  type ReceiptTone,
} from './model-routing-view';
import type { Resolution } from '@/lib/model-routing';

const TONE_VARIANT: Record<ReceiptTone, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  success: 'default',
  warning: 'outline',
  error: 'destructive',
};

export function ConfidenceBadge({ resolution }: { resolution: Resolution | null }) {
  const d = describeDesiredVsRunning(resolution);
  return (
    <Badge variant={TONE_VARIANT[d.tone]} title={d.hint} aria-label={`Running model confidence: ${d.confidenceLabel}`}>
      {d.confidenceLabel}
    </Badge>
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

export function ValidationErrors({ resolution }: { resolution: Resolution | null }) {
  const errors = resolution?.validation?.errors ?? [];
  const warnings = resolution?.validation?.warnings ?? [];
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {errors.map((e) => (
        <li key={e.code} className="text-destructive">
          {e.code}: {e.message}
        </li>
      ))}
      {warnings.map((w) => (
        <li key={w} className="text-muted-foreground">
          {w}
        </li>
      ))}
    </ul>
  );
}
