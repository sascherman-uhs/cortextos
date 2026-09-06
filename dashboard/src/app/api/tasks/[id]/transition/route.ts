// === OS-03 — the canonical-state transition endpoint the work board posts to ===
//
// New file; never overwritten by upstream merges.
//
// Why a new route rather than reusing PATCH /api/tasks/[id]: that handler
// validates against the NATIVE status vocabulary (pending/in_progress/blocked/
// completed) and rejects everything else. The board speaks canonical lanes.
// Rather than widen a validator other callers depend on, this route accepts a
// canonical state, refuses the ones a board move may never grant, and hands
// the rest to the SAME OS-02 transition service — the one door to both stores.
//
// What this route will never do, whatever the client sends:
//   * mark work Done. Done requires the recorded acceptance checks and an
//     independent verifier; a drag is a request to move work, never a grant of
//     verification.
//   * move an obligation to failed_terminal. Obligations are not dead-lettered.
//   * approve, publish, send, or authorise anything external. A lane is not an
//     authority.
// === END header ===

import { NextRequest } from 'next/server';
import { getTaskById } from '@/lib/data/tasks';
import { transitionTask } from '@/lib/task-transition';
import { auth } from '@/lib/auth';
import {
  loadTransitionContract,
  resolveInteractivePath,
  sourceForTaskId,
  toCanonical,
  type CanonicalState,
} from '@/lib/data/transition-contract';

export const dynamic = 'force-dynamic';

const CANONICAL: CanonicalState[] = [
  'backlog', 'ready', 'doing', 'verify', 'waiting', 'done', 'cancelled', 'failed_terminal',
];

/** States a board move may never produce, with the reason shown to the person. */
const BOARD_FORBIDDEN: Partial<Record<CanonicalState, string>> = {
  done:
    'A board move cannot mark work Done. Done requires the recorded acceptance checks and an independent verifier — move the card to Verify and let verification record the result.',
  failed_terminal:
    'A board move cannot abandon work. failed_terminal requires a reason and a disposition, and is forbidden outright for obligations.',
};

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** A person's name reduced to something safe to record as an actor. Returns
 *  undefined when there is nothing usable, so the caller can refuse. */
function sanitizeActor(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : undefined;
}

const MAX_CRITERIA = 20;
const MAX_TEXT = 500;

/** The inline "fill in what is missing" form. Only the contract's required
 *  fields, capped — this is not a general task editor on a different door. */
function parseFields(raw: unknown): {
  outcome?: string;
  acceptanceCriteria?: string[];
  humanAccountableId?: string;
  agentRoleId?: string;
} | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const f = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT) : undefined);
  const criteria = Array.isArray(f.acceptanceCriteria)
    ? f.acceptanceCriteria
        .map((c) => (typeof c === 'string' ? c.trim().slice(0, MAX_TEXT) : ''))
        .filter((c) => c.length > 0)
        .slice(0, MAX_CRITERIA)
    : undefined;
  const out = {
    outcome: text(f.outcome),
    acceptanceCriteria: criteria?.length ? criteria : undefined,
    humanAccountableId: text(f.humanAccountableId),
    agentRoleId: text(f.agentRoleId),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

/** The waiver. The actor is the signed-in person, never the request body: a
 *  client cannot sign someone else's name to a decision. */
function parseGrandfather(raw: unknown, actor: string): { actor: string; reason: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  // A blank reason is NOT dropped back to an ordinary move: the person asked to
  // waive, and the contract owes them the specific refusal that says a waiver
  // has to record why.
  const reason = (raw as Record<string, unknown>).reason;
  return { actor, reason: typeof reason === 'string' ? reason.trim().slice(0, MAX_TEXT) : '' };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidId(id)) {
    return Response.json({ error: 'invalid_task_id', reason: 'That task id is not a valid id.' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json', reason: 'The request body was not JSON.' }, { status: 400 });
  }

  const to = String(body.to ?? '') as CanonicalState;
  if (!CANONICAL.includes(to)) {
    return Response.json(
      {
        error: 'unknown_state',
        reason: `"${body.to}" is not a state on this board. Valid states: ${CANONICAL.join(', ')}.`,
      },
      { status: 400 },
    );
  }

  if (BOARD_FORBIDDEN[to]) {
    return Response.json({ error: 'forbidden_move', reason: BOARD_FORBIDDEN[to] }, { status: 403 });
  }

  const task = getTaskById(id);
  if (!task) {
    return Response.json(
      { error: 'task_not_found', reason: 'That task is not in the cache. It may have been removed.' },
      { status: 404 },
    );
  }

  const source = sourceForTaskId(id);
  const from = toCanonical(source, task.status);

  if (from === to) {
    return Response.json(
      { error: 'no_op', reason: 'That card is already in this lane.' },
      { status: 400 },
    );
  }

  // A gesture may legitimately decompose into more than one leg — Start on a
  // backlog card means "through Ready", the way Complete means "through
  // Verify". Only a request with no route at all is refused here.
  if (!resolveInteractivePath(from, to)) {
    const legal = loadTransitionContract().allowed_transitions[from] ?? [];
    return Response.json(
      {
        error: 'illegal_transition',
        reason:
          legal.length === 0
            ? `${from} is a terminal state — nothing moves out of it.`
            : `${from} → ${to} is not a permitted transition. From ${from} a card may go to: ${legal.join(', ')}.`,
        from,
        allowed: legal,
      },
      { status: 409 },
    );
  }

  // Who is doing this. A waiver has to name a person, and 'dashboard' names a
  // program. Never taken from the request body.
  const session = await auth().catch(() => null);
  const actor = sanitizeActor(session?.user?.name) ?? 'dashboard';

  const fields = parseFields(body.fields);
  const grandfather = parseGrandfather(body.grandfather, actor);
  if (grandfather && actor === 'dashboard') {
    return Response.json(
      {
        error: 'grandfather_needs_a_person',
        reason:
          'Advancing a task without its acceptance criteria is recorded against the person who decided it. '
          + 'Sign in first so the waiver can name you.',
      },
      { status: 403 },
    );
  }

  const outcome = await transitionTask({
    taskId: id,
    to,
    actor,
    expectedVersion:
      typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 2000) : undefined,
    org: task.org || '',
    fromNativeStatus: task.status,
    fields,
    grandfather,
  });

  if (!outcome.ok) {
    if (outcome.status === 422) {
      // The rules said no, and the response says what is missing so the board
      // can offer the form that fixes it rather than a dead end.
      return Response.json(
        {
          error: outcome.error,
          reason: outcome.message,
          detail: outcome.detail,
          violation: outcome.violation,
          legalTransitions: outcome.legalTransitions,
          missing: outcome.missing,
          legacy: outcome.legacy,
          waivable: outcome.waivable,
          remedies: outcome.remedies,
        },
        { status: 422 },
      );
    }
    if (outcome.status === 409) {
      return Response.json(
        {
          error: 'version_conflict',
          message:
            'This task changed while you were looking at it. The board has been put back to the state the server holds.',
          reason:
            'Someone or something else changed this task while the board was open, so the move was refused rather than overwriting their change.',
          current: outcome.current,
          currentVersion: outcome.currentVersion,
        },
        { status: 409 },
      );
    }
    return Response.json(
      { error: outcome.error, reason: outcome.detail ?? 'The owning store refused this move.' },
      { status: outcome.status },
    );
  }

  return Response.json({
    ok: true,
    from,
    canonicalState: outcome.canonicalState,
    nativeStatus: outcome.nativeStatus,
    version: outcome.version,
  });
}
