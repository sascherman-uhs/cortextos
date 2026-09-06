'use client';

/**
 * "Change model" dialog — role-tier switch or agent pin (contract §7).
 *
 * Shows the affected agents, the cost-class/billing change, the restart
 * warning, and requires a reason before it will submit. The submitted
 * operation's receipt is rendered by the caller; nothing here claims a change
 * was applied.
 */

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { previewAgentPin, previewRoleSwitch } from './model-routing-view';
import type { RegistrySummary, Resolution } from '@/lib/model-routing';

export type ChangeMode = 'role_tier' | 'agent_pin';

export interface ChangeModelSubmit {
  mode: ChangeMode;
  role?: string;
  tier?: string;
  entry_id?: string;
  reason: string;
  expected_revision?: number;
  /** Role-tier switch only: also remove legacy pins on the affected agents. */
  clear_pins?: boolean;
}

interface ChangeModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: string;
  role: string;
  resolution: Resolution | null;
  summary: RegistrySummary | null;
  mutable: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: ChangeModelSubmit) => void;
}

const selectClass =
  'h-8 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export function ChangeModelDialog({
  open,
  onOpenChange,
  agent,
  role,
  resolution,
  summary,
  mutable,
  submitting,
  error,
  onSubmit,
}: ChangeModelDialogProps) {
  const tiers = useMemo(() => Object.keys(summary?.tiers ?? {}), [summary]);
  const entries = useMemo(
    () => (summary?.entries ?? []).filter((e) => e.status === 'active'),
    [summary],
  );

  // The parent mounts this dialog fresh per open (keyed on the agent), so the
  // form starts from the agent's current routing without an effect.
  const [mode, setMode] = useState<ChangeMode>('role_tier');
  const [tier, setTier] = useState(
    () => summary?.roles?.[role]?.tier ?? summary?.org_default_tier ?? Object.keys(summary?.tiers ?? {})[0] ?? '',
  );
  const [entryId, setEntryId] = useState(
    () => resolution?.selected?.entry_id ?? (summary?.entries ?? []).find((e) => e.status === 'active')?.entry_id ?? '',
  );
  const [reason, setReason] = useState('');
  const [clearPins, setClearPins] = useState(false);

  const preview =
    mode === 'role_tier'
      ? previewRoleSwitch(summary, role, tier, resolution?.selected)
      : previewAgentPin(summary, agent, entryId, resolution?.selected);

  // Legacy pins survive a role-tier switch unless explicitly cleared, so the
  // option lives here as well as on the row button.
  const clearable = mode === 'role_tier' ? preview.clearablePins : [];
  const willClearPins = clearPins && clearable.length > 0;

  const canSubmit =
    mutable &&
    !submitting &&
    reason.trim().length > 0 &&
    !preview.blocked &&
    (mode === 'role_tier' ? !!tier && !!role : !!entryId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby="change-model-desc">
        <DialogHeader>
          <DialogTitle>Change model for {agent}</DialogTitle>
          <DialogDescription id="change-model-desc">
            Switch the whole role to a different tier, or pin this one agent to a specific model.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-muted-foreground">What to change</legend>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex flex-1 items-center gap-2 rounded-lg border border-border px-2 py-1.5">
              <input
                type="radio"
                name="change-mode"
                value="role_tier"
                checked={mode === 'role_tier'}
                onChange={() => setMode('role_tier')}
              />
              <span className="text-sm">Role tier ({role || 'unassigned'})</span>
            </label>
            <label className="flex flex-1 items-center gap-2 rounded-lg border border-border px-2 py-1.5">
              <input
                type="radio"
                name="change-mode"
                value="agent_pin"
                checked={mode === 'agent_pin'}
                onChange={() => setMode('agent_pin')}
              />
              <span className="text-sm">Pin this agent</span>
            </label>
          </div>
        </fieldset>

        {mode === 'role_tier' ? (
          <div className="space-y-1">
            <Label htmlFor="change-model-tier">Tier</Label>
            <select
              id="change-model-tier"
              className={selectClass}
              value={tier}
              onChange={(e) => setTier(e.target.value)}
            >
              {tiers.length === 0 && <option value="">No tiers in registry</option>}
              {tiers.map((t) => (
                <option key={t} value={t}>
                  {t} ({(summary?.tiers?.[t] ?? []).length} candidates)
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="change-model-entry">Model entry</Label>
            <select
              id="change-model-entry"
              className={selectClass}
              value={entryId}
              onChange={(e) => setEntryId(e.target.value)}
            >
              {entries.length === 0 && <option value="">No active entries in registry</option>}
              {entries.map((e) => (
                <option key={e.entry_id} value={e.entry_id}>
                  {e.entry_id} — {e.model_id} (cost {e.cost_class})
                </option>
              ))}
            </select>
          </div>
        )}

        {clearable.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={clearPins}
                onChange={(e) => setClearPins(e.target.checked)}
              />
              <span>
                <span className="font-medium">
                  Also clear {clearable.length} legacy pin{clearable.length === 1 ? '' : 's'}
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  {willClearPins
                    ? 'These pins will be removed by this operation:'
                    : 'Left checked off, these agents keep their pin and will NOT move to the new tier:'}
                </span>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {clearable.map((c) => (
                    <li key={c.agent}>
                      {c.agent} → {c.entry_id} ({c.kind})
                    </li>
                  ))}
                </ul>
              </span>
            </label>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="change-model-reason">
            Reason <span className="text-destructive">*</span>
          </Label>
          <textarea
            id="change-model-reason"
            required
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this change? Recorded on the receipt."
            className="w-full rounded-lg border border-border bg-background p-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>

        <div className="rounded-lg bg-muted/50 p-2 text-xs" role="group" aria-label="Change preview">
          <p className="font-medium">
            Affects {preview.affectedAgents.length} agent{preview.affectedAgents.length === 1 ? '' : 's'}
            {preview.affectedAgents.length ? `: ${preview.affectedAgents.join(', ')}` : ''}
          </p>
          <p className="mt-1 text-muted-foreground">Target entry: {preview.targetEntryId ?? '—'}</p>
          <p className="mt-1 text-muted-foreground">{preview.costSentence}</p>
          <p className="mt-1 text-amber-600 dark:text-amber-500">{preview.restartWarning}</p>
          {preview.blocked && <p className="mt-1 text-destructive">{preview.blocked}</p>}
          {!mutable && (
            <p className="mt-1 text-destructive">
              Routing service unavailable — this view is read-only right now.
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                mode,
                role,
                tier,
                entry_id: entryId,
                reason: reason.trim(),
                expected_revision: resolution?.registry_revision,
                clear_pins: willClearPins,
              })
            }
          >
            {submitting ? 'Submitting…' : 'Submit change'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
