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
  interactive_paths?: Record<string, Record<string, CanonicalState[]>>;
  legacy_grandfather?: {
    waivable_violations: string[];
    never_waivable: string[];
    fields: string[];
    done_requires_evidence_without_criteria?: boolean;
  };
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

/** Legal next states from `from`. Used to tell a person what they CAN do when a
 *  move is refused, instead of only naming what they cannot. */
export function legalTransitionsFrom(
  from: CanonicalState,
  contract = loadTransitionContract(),
): CanonicalState[] {
  return contract.allowed_transitions[from] ?? [];
}

/**
 * The legs one interactive gesture decomposes into.
 *
 * A person clicking Start on a backlog card is asking for one thing, but the
 * contract's only route out of backlog runs through `ready` — the same way
 * finishing work runs through `verify`. Returning the chain lets the boundary
 * execute and audit each leg on its own terms rather than either refusing the
 * gesture or inventing a shortcut edge that does not exist in the state graph.
 * Returns null when there is no route at all.
 *
 * Every declared chain is re-verified against `allowed_transitions` rather than
 * trusted, so a typo in the fixture cannot mint an edge.
 */
export function resolveInteractivePath(
  from: CanonicalState,
  to: CanonicalState,
  contract = loadTransitionContract(),
): CanonicalState[] | null {
  if (from === to) return [];
  if ((contract.allowed_transitions[from] ?? []).includes(to)) return [to];
  const chain = contract.interactive_paths?.[from]?.[to];
  if (!chain || chain.length === 0) return null;
  let cursor: string = from;
  for (const hop of chain) {
    if (!(contract.allowed_transitions[cursor] ?? []).includes(hop)) return null;
    cursor = hop;
  }
  return cursor === to ? [...chain] : null;
}

/** Contract fields a record does not carry. `owner` is one entry: an agent role
 *  OR a human decider satisfies it. */
export function missingContractFields(item: {
  outcome?: unknown;
  agent_role_id?: unknown;
  human_accountable_id?: unknown;
  acceptance_criteria?: unknown;
}): string[] {
  const missing: string[] = [];
  if (!item.outcome) missing.push('outcome');
  if (!item.agent_role_id && !item.human_accountable_id) missing.push('owner');
  const criteria = Array.isArray(item.acceptance_criteria) ? item.acceptance_criteria : [];
  if (criteria.length === 0) missing.push('acceptance_criteria');
  return missing;
}

/** Created UNDER the contract? The stamp is written by contract-aware create
 *  paths; its absence is the structural marker of legacy work. Never a date. */
export function isContractNative(item: { contract_version?: unknown }): boolean {
  return typeof item.contract_version === 'number' && item.contract_version >= 1;
}

/** The record the Ready gate is judged against, in the shape both stores can
 *  produce from their own columns. */
export interface ReadyItem {
  outcome?: unknown;
  agent_role_id?: unknown;
  human_accountable_id?: unknown;
  acceptance_criteria?: unknown;
  contract_version?: unknown;
}

export interface ReadyCheck {
  ok: boolean;
  error?: string;
  detail?: string;
  missing?: string[];
  legacy?: boolean;
  waivable?: boolean;
  grandfathered?: boolean;
  waived?: string[];
}

/**
 * The Ready gate, for the store whose boundary is this process.
 *
 * Native CortexOS tasks are validated by the core bus, which owns them. Supabase
 * tasks have no validator on the far side — the `task_transition` RPC is a
 * compare-and-set, not a rule engine — so for that store this module IS the
 * boundary, and the gate has to live here. It is driven by the same fixture the
 * core validator reads, and `transition-contract.test.ts` replays the fixture's
 * own `ready` cases through it, so the two cannot quietly disagree.
 */
export function checkReady(
  item: ReadyItem,
  context: {
    unsatisfiedDependencies?: string[];
    grandfather?: { actor?: string; reason?: string };
  } = {},
  contract = loadTransitionContract(),
): ReadyCheck {
  const unmet = context.unsatisfiedDependencies ?? [];
  if (unmet.length) {
    return { ok: false, error: 'unsatisfied_dependencies', detail: unmet.join(', ') };
  }

  const missing = missingContractFields(item);
  if (missing.length === 0) return { ok: true };

  const violation =
    missing.includes('outcome') ? 'missing_outcome'
    : missing.includes('owner') ? 'missing_owner'
    : 'missing_acceptance_criteria';
  const detail =
    violation === 'missing_outcome' ? 'Ready requires a stated outcome'
    : violation === 'missing_owner'
      ? 'Ready requires agent_role_id (dispatchable work) or human_accountable_id (a decision)'
      : 'Ready requires acceptance criteria';

  const legacy = !isContractNative(item);
  const waivable =
    legacy &&
    missing.every((f) =>
      (contract.legacy_grandfather?.waivable_violations ?? []).includes(
        f === 'owner' ? 'missing_owner' : `missing_${f}`,
      ),
    );

  const gf = context.grandfather;
  if (gf) {
    if (!gf.actor) {
      return {
        ok: false, error: 'missing_grandfather_actor', missing, legacy, waivable,
        detail: 'Advancing legacy work without its required fields has to be attributed to a person',
      };
    }
    if (!gf.reason) {
      return {
        ok: false, error: 'missing_grandfather_reason', missing, legacy, waivable,
        detail: 'Advancing legacy work without its required fields has to record why',
      };
    }
    if (!legacy) {
      return {
        ok: false, error: violation, missing, legacy: false, waivable: false,
        detail: `${detail}. This task was created under the work contract, so its required fields cannot be waived.`,
      };
    }
    if (!waivable) return { ok: false, error: violation, detail, missing, legacy, waivable: false };
    return { ok: true, grandfathered: true, waived: [...missing] };
  }

  return { ok: false, error: violation, detail, missing, legacy, waivable };
}
