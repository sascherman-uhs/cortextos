// === OS-03 — work board model (Backlog → Ready → Doing → Verify → Done + Waiting) ===
//
// New file; never overwritten by upstream merges.
//
// Everything on this page that decides something lives here, as a pure
// function over rows, so it can be tested without a browser. The React
// components are deliberately thin: they arrange what this module returns.
//
// Three rules this module refuses to break:
//
//   1. A column is never populated by guessing. Slice 1's stores have no
//      native status that projects onto `ready` or `verify`, so those columns
//      render with a stated reason for being empty rather than an implied
//      "nothing is ready" — see COLUMN_UNPOPULATED_REASON.
//   2. A failed attempt stays attached to its parent task and stays visible.
//      Nothing is dropped from the board because its state is inconvenient.
//   3. A move is a REQUEST for a validated transition. This module can say a
//      move is contract-illegal (cheap shape check); it can never say a move
//      is authorised. Only the owning store decides that.
// === END header ===

import {
  resolveInteractivePath,
  loadTransitionContract,
  sourceForTaskId,
  toCanonical,
  type CanonicalState,
  type TaskSource,
} from '@/lib/data/transition-contract';
import type { ProjectedTask } from '@/lib/data/tasks';
import { personDisplay, type WaitingSubtype } from '@/lib/data/task-projection';

/** Board columns, in the order plan §3 states them. Waiting is a lane beside
 *  the board, not a seventh column — it holds work that is not moving. */
export const BOARD_COLUMNS: CanonicalState[] = [
  'backlog',
  'ready',
  'doing',
  'verify',
  'done',
];

export const COLUMN_LABEL: Record<CanonicalState, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  doing: 'Doing',
  verify: 'Verify',
  waiting: 'Waiting',
  done: 'Done',
  cancelled: 'Cancelled',
  failed_terminal: 'Failed (terminal)',
};

/** Plain-language state name, so colour is never the only signal. */
export const COLUMN_MEANING: Record<CanonicalState, string> = {
  backlog: 'Captured, not yet ready to start',
  ready: 'Owner, outcome and acceptance criteria recorded; dependencies satisfied',
  doing: 'A run is active',
  verify: 'Work claims to be finished and is awaiting independent verification',
  waiting: 'Not moving — see the reason on each card',
  done: 'Verified complete',
  cancelled: 'Deliberately stopped, with a reason and an actor',
  failed_terminal: 'Abandoned non-obligation work, kept visible in history',
};

export const WAITING_SUBTYPES: WaitingSubtype[] = [
  'human',
  'retry',
  'dependency',
  'external',
  'unclassified',
];

export const WAITING_SUBTYPE_LABEL: Record<WaitingSubtype, string> = {
  human: 'Human decision',
  retry: 'Automatic recovery',
  dependency: 'Dependency',
  external: 'External party',
  unclassified: 'Unclassified',
};

/**
 * Why a column can be empty for a reason other than "no work here".
 * `null` means the column is genuinely populated by the current sources.
 */
export function columnUnpopulatedReason(
  column: CanonicalState,
  sources: TaskSource[] = ['cortexos_tasks', 'jarvis_tasks'],
): string | null {
  const contract = loadTransitionContract();
  const reachable = sources.some((s) =>
    Object.values(contract.native_to_canonical[s] ?? {}).includes(column),
  );
  if (reachable) return null;
  return `No source status projects onto ${COLUMN_LABEL[column]} yet, so this column stays empty until a task is moved here explicitly. It is not a claim that nothing is ${COLUMN_LABEL[column].toLowerCase()}.`;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A recorded attempt at the work. Failed attempts stay attached to the card. */
export interface BoardAttempt {
  id: string;
  status: 'started' | 'succeeded' | 'failed' | 'abandoned';
  at: string | null;
  detail: string | null;
}

export type EvidenceState = 'recorded' | 'not_recorded' | 'not_applicable';

export interface BoardCard {
  id: string;
  source: TaskSource;
  title: string;
  /** The outcome this work serves, when the record states one. Never invented. */
  outcome: string | null;
  project: string | null;
  org: string;
  priority: string;
  /** Native store status, always shown. A lane label is a projection; this is
   *  the word the owning store actually holds. */
  nativeStatus: string;
  state: CanonicalState;
  lane: CanonicalState;
  waitingSubtype: WaitingSubtype | null;
  /** Accountable agent (a machine) and accountable human, kept separate. */
  accountableAgent: string | null;
  accountableHuman: string | null;
  /** True when the human was inferred from a legacy alias rather than stated. */
  humanFromLegacyAlias: boolean;
  /** Due / next-action time. `null` when the record carries none — the board
   *  says "no due time recorded" rather than inventing one. */
  dueAt: string | null;
  /** Why this card is not moving, in the store's own words where it has any. */
  blockerReason: string | null;
  lastUpdateAt: string | null;
  evidence: EvidenceState;
  evidenceLabel: string;
  attempts: BoardAttempt[];
  unassignedRecovery: boolean;
  /** OS-02 optimistic-concurrency token, carried onto the card so the one move
   *  path can echo it back as `expectedVersion`. `null` means the row reached
   *  the board without one — the move must then fail closed and ask the person
   *  to refresh, never post a blind write. */
  version: number | null;
}

/** Contract's word for a completion recorded before evidence was required. */
export function legacyCompletionLabel(): string {
  return loadTransitionContract().legacy_completion_label;
}

function firstLine(text: string | undefined | null): string | null {
  if (!text) return null;
  const line = String(text).split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim() : null;
}

/** Project one cached task row onto a board card. */
export function toBoardCard(task: ProjectedTask): BoardCard {
  const source = sourceForTaskId(task.id);
  const nativeStatus = task.projection.status;
  const state = toCanonical(source, nativeStatus);
  const p = task.projection;

  // Evidence: a completion with nothing recorded is labelled with the
  // contract's own legacy wording, never presented as verified.
  let evidence: EvidenceState = 'not_applicable';
  let evidenceLabel = 'Evidence is not required in this state';
  if (state === 'done') {
    const hasEvidence = Boolean(task.notes?.trim()) || (task.outputs?.length ?? 0) > 0;
    evidence = hasEvidence ? 'recorded' : 'not_recorded';
    evidenceLabel = hasEvidence
      ? 'Evidence recorded on the record'
      : legacyCompletionLabel();
  } else if (state === 'waiting' || state === 'failed_terminal') {
    const has = Boolean(task.notes?.trim());
    evidence = has ? 'recorded' : 'not_recorded';
    evidenceLabel = has ? 'Failure detail recorded' : 'No failure detail recorded';
  }

  const attempts: BoardAttempt[] = [];
  if (nativeStatus === 'failed') {
    attempts.push({
      id: `${task.id}:failed`,
      status: 'failed',
      at: task.updated_at ?? null,
      detail: firstLine(task.notes) ?? 'No failure detail recorded',
    });
  }
  if (state === 'doing') {
    attempts.push({
      id: `${task.id}:started`,
      status: 'started',
      at: task.updated_at ?? task.created_at ?? null,
      detail: null,
    });
  }
  if (state === 'done') {
    attempts.push({
      id: `${task.id}:succeeded`,
      status: 'succeeded',
      at: task.completed_at ?? null,
      detail: firstLine(task.notes),
    });
  }

  return {
    id: task.id,
    source,
    title: task.title,
    outcome: firstLine(task.description),
    project: task.project ?? null,
    org: task.org,
    priority: task.priority,
    nativeStatus,
    state,
    lane: state,
    waitingSubtype: state === 'waiting' ? (p.waiting_subtype ?? 'unclassified') : null,
    accountableAgent: p.owner_kind === 'agent' ? (task.assignee ?? null) : null,
    accountableHuman: personDisplay(p.person),
    humanFromLegacyAlias: p.legacy_alias,
    dueAt: null,
    blockerReason:
      state === 'waiting'
        ? (firstLine(task.notes) ??
           `${WAITING_SUBTYPE_LABEL[p.waiting_subtype ?? 'unclassified']} — no reason recorded`)
        : null,
    lastUpdateAt: task.updated_at ?? task.created_at ?? null,
    evidence,
    evidenceLabel,
    attempts,
    unassignedRecovery: p.unassigned_recovery,
    version: typeof task.version === 'number' && Number.isFinite(task.version) ? task.version : null,
  };
}

// ---------------------------------------------------------------------------
// Board assembly
// ---------------------------------------------------------------------------

export interface BoardColumnModel {
  state: CanonicalState;
  label: string;
  meaning: string;
  cards: BoardCard[];
  count: number;
  /** Non-null when the column cannot be populated by the current sources. */
  unpopulatedReason: string | null;
}

export interface BoardWaitingGroup {
  subtype: WaitingSubtype;
  label: string;
  cards: BoardCard[];
  count: number;
}

export interface BoardFilters {
  waitingSubtype?: WaitingSubtype | null;
  person?: string | null;
  project?: string | null;
  search?: string | null;
}

export interface BoardModel {
  columns: BoardColumnModel[];
  waiting: { total: number; groups: BoardWaitingGroup[]; cards: BoardCard[] };
  cancelled: BoardCard[];
  failedTerminal: BoardCard[];
  /** Every lane count in one map, for the mobile lane switcher. */
  laneCounts: Record<CanonicalState, number>;
  totalCards: number;
  /** True when a source behind the board is degraded; empty lanes then mean
   *  "unknown", and must not read as "nothing here". */
  degraded: boolean;
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 5, urgent: 4, high: 3, normal: 2, low: 1,
};

export function sortCards(cards: BoardCard[]): BoardCard[] {
  return [...cards].sort((a, b) => {
    const rank = (PRIORITY_RANK[b.priority] ?? 2) - (PRIORITY_RANK[a.priority] ?? 2);
    if (rank !== 0) return rank;
    const at = a.lastUpdateAt ? Date.parse(a.lastUpdateAt) : 0;
    const bt = b.lastUpdateAt ? Date.parse(b.lastUpdateAt) : 0;
    return bt - at;
  });
}

function matches(card: BoardCard, f: BoardFilters): boolean {
  if (f.person && card.accountableHuman !== f.person) return false;
  if (f.project && card.project !== f.project) return false;
  if (f.search) {
    const q = f.search.trim().toLowerCase();
    if (q && !card.title.toLowerCase().includes(q) && !card.id.toLowerCase().includes(q)) {
      return false;
    }
  }
  return true;
}

export function buildBoard(
  tasks: ProjectedTask[],
  opts: { filters?: BoardFilters; degraded?: boolean } = {},
): BoardModel {
  const filters = opts.filters ?? {};
  const cards = tasks.map(toBoardCard).filter((c) => matches(c, filters));

  const columns: BoardColumnModel[] = BOARD_COLUMNS.map((state) => {
    const columnCards = sortCards(cards.filter((c) => c.state === state));
    return {
      state,
      label: COLUMN_LABEL[state],
      meaning: COLUMN_MEANING[state],
      cards: columnCards,
      count: columnCards.length,
      unpopulatedReason: columnCards.length === 0 ? columnUnpopulatedReason(state) : null,
    };
  });

  const allWaiting = sortCards(cards.filter((c) => c.state === 'waiting'));
  const waitingCards = filters.waitingSubtype
    ? allWaiting.filter((c) => (c.waitingSubtype ?? 'unclassified') === filters.waitingSubtype)
    : allWaiting;

  const groups: BoardWaitingGroup[] = WAITING_SUBTYPES.map((subtype) => {
    const rows = allWaiting.filter((c) => (c.waitingSubtype ?? 'unclassified') === subtype);
    return { subtype, label: WAITING_SUBTYPE_LABEL[subtype], cards: rows, count: rows.length };
  });

  const cancelled = sortCards(cards.filter((c) => c.state === 'cancelled'));
  const failedTerminal = sortCards(cards.filter((c) => c.state === 'failed_terminal'));

  const laneCounts = {} as Record<CanonicalState, number>;
  for (const c of columns) laneCounts[c.state] = c.count;
  laneCounts.waiting = allWaiting.length;
  laneCounts.cancelled = cancelled.length;
  laneCounts.failed_terminal = failedTerminal.length;

  return {
    columns,
    waiting: { total: allWaiting.length, groups, cards: waitingCards },
    cancelled,
    failedTerminal,
    laneCounts,
    totalCards: cards.length,
    degraded: Boolean(opts.degraded),
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

export interface MoveCheck {
  allowed: boolean;
  /** Always populated when `allowed` is false, and always shown to the person
   *  who attempted the move. A refusal without a reason is indistinguishable
   *  from a bug. */
  reason: string | null;
  /** Requirements the owning store will still check, listed so a move that is
   *  shape-legal is not mistaken for a move that will succeed. */
  serverWillCheck: string[];
}

/** Moves the board must never offer, whatever the contract's shape rules say. */
const BOARD_FORBIDDEN: Partial<Record<CanonicalState, string>> = {
  done:
    'A card cannot be dragged to Done. Done requires the recorded acceptance checks and an independent verifier — a drag is a request to move work, never a grant of verification.',
};

export function checkMove(
  card: Pick<BoardCard, 'state' | 'source'>,
  to: CanonicalState,
): MoveCheck {
  const contract = loadTransitionContract();

  if (BOARD_FORBIDDEN[to]) {
    return { allowed: false, reason: BOARD_FORBIDDEN[to]!, serverWillCheck: [] };
  }
  if (card.state === to) {
    return { allowed: false, reason: 'That card is already in this lane.', serverWillCheck: [] };
  }
  // A move may legitimately decompose into more than one leg: Start on a
  // backlog card means "through Ready", the way Complete means "through
  // Verify". Only a gesture with no route at all is refused before sending.
  const legs = resolveInteractivePath(card.state, to, contract);
  if (!legs) {
    const legal = contract.allowed_transitions[card.state] ?? [];
    return {
      allowed: false,
      reason:
        legal.length === 0
          ? `${COLUMN_LABEL[card.state]} is a terminal state — nothing moves out of it.`
          : `${COLUMN_LABEL[card.state]} → ${COLUMN_LABEL[to]} is not a permitted transition. From here a card may go to: ${legal.map((s) => COLUMN_LABEL[s]).join(', ')}.`,
      serverWillCheck: [],
    };
  }

  // Every leg's requirements are the person's to know about, not just the last
  // one's: a Start that has to pass through Ready is gated on Ready's fields.
  const serverWillCheck: string[] = [];
  for (const leg of legs) {
  const req = contract.requirements[leg] as Record<string, unknown> | undefined;
  if (req) {
    if (Array.isArray(req.fields)) {
      serverWillCheck.push(`Required fields: ${(req.fields as string[]).join(', ')}`);
    }
    if (Array.isArray(req.evidence_keys_any)) {
      serverWillCheck.push(
        `At least one evidence key: ${(req.evidence_keys_any as string[]).join(', ')}`,
      );
    }
    if (req.dependencies_satisfied) serverWillCheck.push('Dependencies satisfied');
    if (req.verifier_required) serverWillCheck.push('Independent verifier');
    if (Array.isArray(req.forbidden_for_types)) {
      serverWillCheck.push(
        `Forbidden for work of type: ${(req.forbidden_for_types as string[]).join(', ')}`,
      );
    }
  }
  }
  return { allowed: true, reason: null, serverWillCheck: [...new Set(serverWillCheck)] };
}

/** Lanes a card may be dropped into, for keyboard and drag affordances. */
export function moveTargets(card: Pick<BoardCard, 'state' | 'source'>): CanonicalState[] {
  const all: CanonicalState[] = [
    'backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal',
  ];
  return all.filter((t) => checkMove(card, t).allowed);
}
