// cortextOS Dashboard — OS-02 transition contract types + state mapping.
//
// The rules themselves live in tests/fixtures/task-transition-contract.json,
// byte-identical in uhsJARVIS. This module carries only the mapping half:
// which canonical state a native status projects onto, and which native word a
// store will accept for a canonical state.
//
// Deliberately NOT here: the validator. Rules are enforced at the boundary that
// owns the store — the core bus for native tasks, the task_transition RPC for
// Supabase tasks. A second copy of the rules living in the browser bundle would
// be a third thing to keep in sync and the first thing to drift.

import { TRANSITION_CONTRACT } from './transition-contract.generated';

export type CanonicalState =
  | 'backlog' | 'ready' | 'doing' | 'verify'
  | 'waiting' | 'done' | 'cancelled' | 'failed_terminal';

export interface TransitionContract {
  contract_version: number;
  canonical_states: CanonicalState[];
  terminal_states: CanonicalState[];
  waiting_subtypes: string[];
  run_statuses: string[];
  allowed_transitions: Record<string, CanonicalState[]>;
  requirements: Record<string, Record<string, unknown>>;
  impact_classes: string[];
  work_types: string[];
  native_to_canonical: Record<string, Record<string, CanonicalState>>;
  canonical_to_native: Record<string, Record<string, string>>;
  legacy_completion_label: string;
  cases?: unknown[];
}

export function loadTransitionContract(): TransitionContract {
  return TRANSITION_CONTRACT;
}

/** Which store a dashboard task id belongs to. The `supa_` prefix is a routing
 *  hint, not proof — the caller still addresses the right store explicitly. */
export type TaskSource = 'cortexos_tasks' | 'jarvis_tasks';

export function sourceForTaskId(id: string): TaskSource {
  return id.startsWith('supa_') ? 'jarvis_tasks' : 'cortexos_tasks';
}

/** Project a native status onto the canonical vocabulary. An unmapped status
 *  becomes `waiting`, never a happy state. */
export function toCanonical(
  source: TaskSource,
  nativeStatus: string | null | undefined,
  contract = loadTransitionContract(),
): CanonicalState {
  const table = contract.native_to_canonical[source] ?? {};
  return table[String(nativeStatus ?? '').trim().toLowerCase()] ?? 'waiting';
}

/** Native status this store accepts for a canonical state. */
export function toNative(
  source: TaskSource,
  canonical: CanonicalState,
  contract = loadTransitionContract(),
): string | undefined {
  return contract.canonical_to_native[source]?.[canonical];
}

/** Whether the contract permits this canonical move at all. The proof
 *  requirements are checked by the store's own boundary; this is the cheap
 *  shape check a UI can make before sending anything. */
export function isAllowedMove(
  from: CanonicalState,
  to: CanonicalState,
  contract = loadTransitionContract(),
): boolean {
  if (from === to) return true;
  return (contract.allowed_transitions[from] ?? []).includes(to);
}
