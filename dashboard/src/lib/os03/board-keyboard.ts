// === OS-03 — keyboard model for the work board ===
//
// New file; never overwritten by upstream merges.
//
// Every drag has a keyboard equivalent, and the keyboard path is the one that
// is actually testable, so it is the one that holds the rules. Drag handlers
// call into the SAME reducer; there is no second implementation that could
// permit a move the keyboard refuses.
//
// The reducer is pure: it takes the board, the current focus, and a key, and
// returns the next focus plus at most one intent. It never talks to the
// network — the page performs the intent and reports the outcome back.
// === END header ===

import type { CanonicalState } from '@/lib/data/transition-contract';
import { BOARD_COLUMNS, COLUMN_LABEL, checkMove, type BoardModel, type BoardCard } from './work-board';

/** Lanes the keyboard can traverse: the five columns plus Waiting. */
export const KEYBOARD_LANES: CanonicalState[] = [...BOARD_COLUMNS, 'waiting'];

export interface BoardFocus {
  lane: CanonicalState;
  /** Index within the lane. -1 means the lane header itself is focused. */
  index: number;
}

export type BoardIntent =
  | { type: 'open_drawer'; taskId: string }
  | { type: 'request_move'; taskId: string; from: CanonicalState; to: CanonicalState }
  | { type: 'refuse_move'; taskId: string; to: CanonicalState; reason: string }
  | { type: 'start_grab'; taskId: string }
  | { type: 'cancel_grab' };

export interface KeyboardState {
  focus: BoardFocus;
  /** The card currently "picked up" for a keyboard move, if any. */
  grabbedTaskId: string | null;
}

export interface KeyEvent {
  key: string;
  shiftKey?: boolean;
}

export interface KeyboardResult {
  state: KeyboardState;
  intent: BoardIntent | null;
  /** What a screen reader should be told about what just happened. */
  announcement: string | null;
  /** True when the key was ours and the browser default must be suppressed. */
  handled: boolean;
}

function laneCards(board: BoardModel, lane: CanonicalState): BoardCard[] {
  if (lane === 'waiting') return board.waiting.cards;
  return board.columns.find((c) => c.state === lane)?.cards ?? [];
}

function clampIndex(board: BoardModel, lane: CanonicalState, index: number): number {
  const n = laneCards(board, lane).length;
  if (n === 0) return -1;
  return Math.max(0, Math.min(index, n - 1));
}

export function cardAt(board: BoardModel, focus: BoardFocus): BoardCard | null {
  const cards = laneCards(board, focus.lane);
  return focus.index >= 0 && focus.index < cards.length ? cards[focus.index] : null;
}

export function initialFocus(board: BoardModel): BoardFocus {
  for (const lane of KEYBOARD_LANES) {
    if (laneCards(board, lane).length > 0) return { lane, index: 0 };
  }
  return { lane: 'backlog', index: -1 };
}

function laneStep(lane: CanonicalState, delta: number): CanonicalState {
  const i = KEYBOARD_LANES.indexOf(lane);
  const next = Math.max(0, Math.min(KEYBOARD_LANES.length - 1, i + delta));
  return KEYBOARD_LANES[next];
}

const NOOP = (state: KeyboardState): KeyboardResult => ({
  state, intent: null, announcement: null, handled: false,
});

/**
 * One key press against the board.
 *
 * Arrow up/down move within a lane; arrow left/right move between lanes.
 * Space picks a card up and puts it down (the keyboard equivalent of a drag).
 * While a card is grabbed, left/right REQUEST the move rather than just
 * moving focus. Enter opens the detail drawer. Escape cancels a grab.
 */
export function boardKeyDown(
  board: BoardModel,
  state: KeyboardState,
  ev: KeyEvent,
): KeyboardResult {
  const { focus, grabbedTaskId } = state;
  const current = cardAt(board, focus);

  switch (ev.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (grabbedTaskId) {
        return {
          state,
          intent: null,
          announcement:
            'This card is picked up. Use left and right to choose a lane, space to drop it, or escape to cancel.',
          handled: true,
        };
      }
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      const index = clampIndex(board, focus.lane, Math.max(0, focus.index) + delta);
      const next = { lane: focus.lane, index };
      const card = cardAt(board, next);
      return {
        state: { ...state, focus: next },
        intent: null,
        announcement: card
          ? `${card.title}. ${COLUMN_LABEL[next.lane]}, ${index + 1} of ${laneCards(board, next.lane).length}.`
          : `${COLUMN_LABEL[next.lane]} is empty.`,
        handled: true,
      };
    }

    case 'ArrowLeft':
    case 'ArrowRight': {
      const delta = ev.key === 'ArrowRight' ? 1 : -1;
      const targetLane = laneStep(focus.lane, delta);

      if (grabbedTaskId && current) {
        if (targetLane === focus.lane) {
          return {
            state,
            intent: null,
            announcement: 'No further lane in that direction.',
            handled: true,
          };
        }
        const check = checkMove(current, targetLane);
        if (!check.allowed) {
          return {
            state,
            intent: { type: 'refuse_move', taskId: current.id, to: targetLane, reason: check.reason ?? 'Move refused.' },
            announcement: check.reason,
            handled: true,
          };
        }
        return {
          state: { focus: { lane: targetLane, index: 0 }, grabbedTaskId: null },
          intent: { type: 'request_move', taskId: current.id, from: current.state, to: targetLane },
          announcement: `Requested move of ${current.title} to ${COLUMN_LABEL[targetLane]}. Waiting for the server to confirm.`,
          handled: true,
        };
      }

      const next = { lane: targetLane, index: clampIndex(board, targetLane, 0) };
      const card = cardAt(board, next);
      return {
        state: { ...state, focus: next },
        intent: null,
        announcement: card
          ? `${COLUMN_LABEL[targetLane]}, ${laneCards(board, targetLane).length} cards. ${card.title}.`
          : `${COLUMN_LABEL[targetLane]} is empty.`,
        handled: true,
      };
    }

    case ' ':
    case 'Space':
    case 'Spacebar': {
      if (!current) return { state, intent: null, announcement: null, handled: true };
      if (grabbedTaskId === current.id) {
        return {
          state: { ...state, grabbedTaskId: null },
          intent: { type: 'cancel_grab' },
          announcement: `${current.title} put back down in ${COLUMN_LABEL[current.state]}.`,
          handled: true,
        };
      }
      return {
        state: { ...state, grabbedTaskId: current.id },
        intent: { type: 'start_grab', taskId: current.id },
        announcement: `${current.title} picked up. Use left and right to choose a lane, space to drop, escape to cancel.`,
        handled: true,
      };
    }

    case 'Enter': {
      if (!current) return { state, intent: null, announcement: null, handled: true };
      return {
        state,
        intent: { type: 'open_drawer', taskId: current.id },
        announcement: `Opened details for ${current.title}.`,
        handled: true,
      };
    }

    case 'Escape': {
      if (!grabbedTaskId) return NOOP(state);
      return {
        state: { ...state, grabbedTaskId: null },
        intent: { type: 'cancel_grab' },
        announcement: 'Move cancelled. The card did not change lane.',
        handled: true,
      };
    }

    default:
      return NOOP(state);
  }
}

/** The instructions shown beside the board and read by assistive technology. */
export const KEYBOARD_HELP = [
  'Arrow up and down move between cards in a lane.',
  'Arrow left and right move between lanes.',
  'Space picks a card up; left or right then requests that move; space drops it.',
  'Enter opens the card detail.',
  'Escape cancels a move in progress.',
] as const;
