// === Fix6 / D11 — the moves a task detail sheet may offer ===
//
// The sheet used to carry its own hardcoded table of buttons keyed on native
// status. It drifted from the contract, and for failed work every button it
// offered was illegal: Retry asked for `pending` and Cancel asked for
// `cancelled`, while the contract permits exactly one move out of
// failed_terminal — to waiting. Measured: PATCH with {"status":"pending"}
// returned 422 with legalTransitions ["waiting"], record unchanged. The one
// legal move was offered nowhere, so failed work could not be acted on at all.
//
// The buttons are now derived from the contract, so a change to the state
// graph changes the UI instead of drifting away from it.

import {
  legalTransitionsFrom,
  resolveInteractivePath,
  toCanonical,
  toNative,
  type CanonicalState,
  type TaskSource,
  type TransitionContract,
} from '@/lib/data/transition-contract';

/**
 * The native words PATCH /api/tasks/[id] accepts. A canonical state outside
 * this set cannot be expressed on that endpoint at all, so the sheet must not
 * offer it — a button that 400s is worse than no button.
 */
export const PATCHABLE_NATIVE = ['pending', 'in_progress', 'blocked', 'completed'] as const;

export interface OfferedAction {
  /** Canonical state this asks for. */
  to: CanonicalState;
  /** Native word posted to PATCH. */
  status: string;
  label: string;
  /** What the record will be afterwards, in plain words. */
  meaning: string;
  variant: 'default' | 'outline' | 'destructive' | 'secondary';
}

/** Every canonical state, for scanning interactive paths. */
const ALL: CanonicalState[] = [
  'backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal',
];

/**
 * What to call the move, given where it starts. The same target means
 * different things from different places: doing is "Start" out of the backlog
 * and "Resume" out of waiting.
 */
function describe(from: CanonicalState, to: CanonicalState): Omit<OfferedAction, 'to' | 'status'> {
  switch (to) {
    case 'doing':
      return from === 'waiting'
        ? { label: 'Resume', meaning: 'Picks the work back up. It moves to In Progress.', variant: 'default' }
        : { label: 'Start', meaning: 'Starts the work. It moves to In Progress.', variant: 'default' };
    case 'waiting':
      return from === 'failed_terminal'
        ? {
            label: 'Send back for recovery',
            meaning:
              'The only move a failed task has. It goes to Waiting, where it can be picked up, '
              + 'reassigned or closed — it does not restart on its own.',
            variant: 'default',
          }
        : { label: 'Block', meaning: 'Parks the work as Waiting on something.', variant: 'destructive' };
    case 'done':
      return { label: 'Complete', meaning: 'Records this as finished, with you as the verifier.', variant: 'secondary' };
    case 'backlog':
      return { label: 'Back to Backlog', meaning: 'Returns it to the backlog, unstarted.', variant: 'outline' };
    case 'ready':
      return { label: 'Mark Ready', meaning: 'Says the work is ready to be picked up.', variant: 'outline' };
    case 'verify':
      return { label: 'Send to Verify', meaning: 'Hands it to verification.', variant: 'outline' };
    case 'cancelled':
      return { label: 'Cancel', meaning: 'Closes it as cancelled.', variant: 'outline' };
    case 'failed_terminal':
      return { label: 'Abandon', meaning: 'Records the work as abandoned.', variant: 'destructive' };
  }
}

/**
 * The moves to offer from `from`, for a task in `source`.
 *
 * Includes the multi-leg gestures the contract declares (Start out of the
 * backlog runs through Ready), and excludes any target the endpoint cannot
 * express: one whose native word PATCH does not accept, or whose native word
 * projects back onto a DIFFERENT canonical state. The second check matters —
 * cortexos maps both `waiting` and `failed_terminal` onto the native word
 * `blocked`, so an Abandon button would silently perform a Block.
 */
export function offeredActions(
  source: TaskSource,
  from: CanonicalState,
  contract?: TransitionContract,
): OfferedAction[] {
  const direct = legalTransitionsFrom(from, contract);
  const reachable = new Set<CanonicalState>(direct);
  for (const target of ALL) {
    if (target === from) continue;
    if (resolveInteractivePath(from, target, contract)) reachable.add(target);
  }

  const actions: OfferedAction[] = [];
  for (const to of ALL) {
    if (!reachable.has(to)) continue;
    const native = toNative(source, to, contract);
    if (!native) continue;
    if (!(PATCHABLE_NATIVE as readonly string[]).includes(native)) continue;
    if (toCanonical(source, native, contract) !== to) continue;
    actions.push({ to, status: native, ...describe(from, to) });
  }
  return actions;
}
