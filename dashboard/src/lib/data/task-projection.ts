// cortextOS Dashboard - shared task identity + status projection (OS-01)
//
// This is the TypeScript half of a two-language contract. The Python half lives
// at uhsJARVIS scripts/task_projection.py, and both load the SAME fixture file
// (tests/fixtures/task-status-contract.json, byte-identical in both repos) so
// the projector that WRITES the cache and the projector that READS it cannot
// disagree about who owns a task or what state it is in.
//
// Slice 1 rule (plan section 5): the owning store's native status is preserved
// verbatim. Lanes and waiting subtypes are a projection on top of it. The
// canonical OS-02 status vocabulary is deliberately NOT written into the old
// enum here.

import { TASK_CONTRACT } from './task-contract.generated';

export type Lane = 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
export type WaitingSubtype = 'human' | 'retry' | 'dependency' | 'external' | 'unclassified';
export type OwnerKind = 'person' | 'agent' | 'ambiguous' | 'unknown' | 'unassigned';
export type PersonKey = 'scott' | 'angelic' | 'raquel';

export interface Projection {
  /** Native source status, preserved (legacy map applied). */
  status: string;
  lane: Lane;
  waiting_subtype: WaitingSubtype | null;
  person: PersonKey | null;
  owner_kind: OwnerKind;
  /** Identity came from a legacy alias or heuristic, not a stated name. */
  legacy_alias: boolean;
  /** Non-terminal row with no routable owner. */
  unassigned_recovery: boolean;
}

interface PersonSpec {
  display: string;
  aliases: string[];
  legacy_aliases: string[];
}

export interface TaskContract {
  contract_version: number;
  people: Record<string, PersonSpec>;
  legacy_title_prefixes: string[];
  legacy_projects: string[];
  legacy_person: string;
  agent_aliases: string[];
  agent_alias_prefixes: string[];
  ambiguous_aliases: string[];
  legacy_status_map: Record<string, string>;
  known_statuses: string[];
  terminal_statuses: string[];
  status_lanes: Record<string, { lane: Lane; waiting_subtype: WaitingSubtype | null }>;
  unknown_status_lane: { lane: Lane; waiting_subtype: WaitingSubtype | null };
  cases?: unknown[];
}

export function loadContract(): TaskContract {
  return TASK_CONTRACT;
}

function norm(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
}

/**
 * Apply the recorded legacy status map. Unknown statuses pass through
 * UNCHANGED — coercing an unrecognised status to 'pending' is the bug this
 * module exists to remove.
 */
export function normaliseStatus(status: unknown, contract = loadContract()): string {
  const s = norm(status);
  if (!s) return 'pending';
  return contract.legacy_status_map[s] ?? s;
}

export interface OwnerResolution {
  person: PersonKey | null;
  owner_kind: OwnerKind;
  legacy_alias: boolean;
}

/**
 * Resolve an assignee string to a person, an agent, or an explicit
 * unknown/ambiguous marker. Never guesses one person's work onto another.
 */
export function resolveOwner(
  assignedTo: unknown,
  title?: unknown,
  project?: unknown,
  contract = loadContract(),
): OwnerResolution {
  const raw = norm(assignedTo);

  if (raw) {
    for (const [key, spec] of Object.entries(contract.people)) {
      if (spec.aliases.some((a) => norm(a) === raw)) {
        return { person: key as PersonKey, owner_kind: 'person', legacy_alias: false };
      }
      if (spec.legacy_aliases.some((a) => norm(a) === raw)) {
        return { person: key as PersonKey, owner_kind: 'person', legacy_alias: true };
      }
    }
    if (contract.ambiguous_aliases.some((a) => norm(a) === raw)) {
      return { person: null, owner_kind: 'ambiguous', legacy_alias: false };
    }
    if (contract.agent_aliases.some((a) => norm(a) === raw)) {
      return { person: null, owner_kind: 'agent', legacy_alias: false };
    }
    if (contract.agent_alias_prefixes.some((p) => raw.startsWith(norm(p)))) {
      return { person: null, owner_kind: 'agent', legacy_alias: false };
    }
    return { person: null, owner_kind: 'unknown', legacy_alias: false };
  }

  // No assignee: fall back to the legacy title/project heuristics the old
  // dashboard "human" filter relied on, flagged as legacy.
  const titleStr = title === null || title === undefined ? '' : String(title);
  if (contract.legacy_title_prefixes.some((p) => titleStr.startsWith(p))) {
    return { person: contract.legacy_person as PersonKey, owner_kind: 'person', legacy_alias: true };
  }
  if (contract.legacy_projects.some((p) => norm(p) === norm(project))) {
    return { person: contract.legacy_person as PersonKey, owner_kind: 'person', legacy_alias: true };
  }

  return { person: null, owner_kind: 'unassigned', legacy_alias: false };
}

export interface ProjectableRow {
  status?: unknown;
  assigned_to?: unknown;
  assignee?: unknown;
  needs_approval?: unknown;
  title?: unknown;
  project?: unknown;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'string') return ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
  return Boolean(v);
}

/** Project one source row onto the work board contract. */
export function projectTask(row: ProjectableRow, contract = loadContract()): Projection {
  const status = normaliseStatus(row.status, contract);
  const assignee = row.assigned_to !== undefined ? row.assigned_to : row.assignee;
  const { person, owner_kind, legacy_alias } = resolveOwner(
    assignee,
    row.title,
    row.project,
    contract,
  );

  const laneSpec = contract.status_lanes[status] ?? contract.unknown_status_lane;
  const lane = laneSpec.lane;
  let subtype = laneSpec.waiting_subtype;

  // A wait a person owns, or one explicitly gated on approval, is a human
  // decision — not something a retry loop will ever clear.
  if (lane === 'waiting' && (truthy(row.needs_approval) || owner_kind === 'person')) {
    subtype = 'human';
  }

  const terminal = contract.terminal_statuses.includes(status);
  const unassigned_recovery =
    !terminal && ['unassigned', 'ambiguous', 'unknown'].includes(owner_kind);

  return { status, lane, waiting_subtype: subtype, person, owner_kind, legacy_alias, unassigned_recovery };
}

/** Human-readable label for a person key, from the contract. */
export function personDisplay(person: PersonKey | null, contract = loadContract()): string | null {
  return person ? (contract.people[person]?.display ?? person) : null;
}
