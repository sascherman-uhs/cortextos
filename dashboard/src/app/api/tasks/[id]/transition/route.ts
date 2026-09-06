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
import {
  isAllowedMove,
  loadTransitionContract,
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

  if (!isAllowedMove(from, to)) {
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

  const outcome = await transitionTask({
    taskId: id,
    to,
    actor: 'dashboard',
    expectedVersion:
      typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 2000) : undefined,
    org: task.org || '',
  });

  if (!outcome.ok) {
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
