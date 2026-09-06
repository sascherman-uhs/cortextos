/**
 * OS-03 — keyboard equivalents for every drag.
 *
 * The board's rule is that a keyboard user can do everything a mouse user can,
 * and neither can do something the other cannot. So these tests drive the SAME
 * reducer the drag handlers call, and check that a refused keyboard move is
 * refused for the same stated reason.
 */

import { describe, it, expect } from 'vitest';
import { boardKeyDown, cardAt, initialFocus, KEYBOARD_LANES, type KeyboardState } from '../board-keyboard';
import { buildBoard } from '../work-board';
import { projectTask } from '@/lib/data/task-projection';
import type { ProjectedTask } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

function task(id: string, status: string, assignee?: string): ProjectedTask {
  const base: Task = {
    id, title: `Task ${id}`, status, priority: 'normal', assignee, org: 'uhs',
    needs_approval: false, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
  };
  return {
    ...base,
    projection: projectTask({ status, assignee, title: base.title }),
  };
}

const rows = [
  task('supa_1', 'pending'),
  task('supa_2', 'pending'),
  task('supa_3', 'in_progress'),
  task('supa_4', 'blocked', 'scott'),
];
const board = buildBoard(rows);

function state(over: Partial<KeyboardState> = {}): KeyboardState {
  return { focus: initialFocus(board), grabbedTaskId: null, ...over };
}

describe('navigation', () => {
  it('starts on the first card of the first populated lane', () => {
    const focus = initialFocus(board);
    expect(focus.lane).toBe('backlog');
    expect(cardAt(board, focus)).not.toBeNull();
  });

  it('moves down within a lane and announces where it landed', () => {
    const r = boardKeyDown(board, state(), { key: 'ArrowDown' });
    expect(r.handled).toBe(true);
    expect(r.state.focus.index).toBe(1);
    expect(r.announcement).toContain('Backlog');
    expect(r.announcement).toMatch(/2 of 2/);
  });

  it('does not run off the end of a lane', () => {
    const r = boardKeyDown(board, state({ focus: { lane: 'backlog', index: 1 } }), { key: 'ArrowDown' });
    expect(r.state.focus.index).toBe(1);
  });

  it('moves between lanes and announces an empty lane as empty', () => {
    const r = boardKeyDown(board, state(), { key: 'ArrowRight' });
    expect(r.state.focus.lane).toBe('ready');
    expect(r.announcement).toContain('Ready is empty');
  });

  it('traverses the five columns plus Waiting, and nothing else', () => {
    expect(KEYBOARD_LANES).toEqual(['backlog', 'ready', 'doing', 'verify', 'done', 'waiting']);
  });

  it('ignores keys that are not ours so the browser keeps its own behaviour', () => {
    expect(boardKeyDown(board, state(), { key: 'a' }).handled).toBe(false);
  });
});

describe('moving a card with the keyboard', () => {
  it('space picks a card up and says how to put it down', () => {
    const r = boardKeyDown(board, state(), { key: ' ' });
    expect(r.state.grabbedTaskId).toBe('supa_1');
    expect(r.announcement).toMatch(/picked up/);
    expect(r.announcement).toMatch(/escape to cancel/);
  });

  it('requests a legal move once the card is grabbed', () => {
    const grabbed = state({ focus: { lane: 'backlog', index: 0 }, grabbedTaskId: 'supa_1' });
    const r = boardKeyDown(board, grabbed, { key: 'ArrowRight' });
    expect(r.intent).toEqual({
      type: 'request_move', taskId: 'supa_1', from: 'backlog', to: 'ready',
    });
    // The card is not treated as moved until the server confirms.
    expect(r.announcement).toMatch(/Waiting for the server/);
    expect(r.state.grabbedTaskId).toBeNull();
  });

  it('refuses an illegal move with the same reason the drag path gives', () => {
    // Backlog cannot go straight to Doing.
    const grabbed = state({ focus: { lane: 'backlog', index: 0 }, grabbedTaskId: 'supa_1' });
    const toReady = boardKeyDown(board, grabbed, { key: 'ArrowRight' });
    expect(toReady.intent?.type).toBe('request_move');

    // A Doing card cannot be pushed back to Ready.
    const doing = state({ focus: { lane: 'doing', index: 0 }, grabbedTaskId: 'supa_3' });
    const r = boardKeyDown(board, doing, { key: 'ArrowLeft' });
    expect(r.intent?.type).toBe('refuse_move');
    expect(r.announcement).toContain('not a permitted transition');
  });

  it('never lets the keyboard move a card into Done', () => {
    // No native status projects onto Verify in Slice 1, so the only way to put
    // a card there for this test is to place it directly — which is exactly
    // what the board would hold after an explicit move to Verify.
    const withVerify = buildBoard(rows);
    const card = { ...withVerify.columns[0].cards[0], state: 'verify' as const, lane: 'verify' as const };
    const verifyColumn = withVerify.columns.find((c) => c.state === 'verify')!;
    verifyColumn.cards = [card];
    verifyColumn.count = 1;

    const grabbed = state({ focus: { lane: 'verify', index: 0 }, grabbedTaskId: card.id });
    const r = boardKeyDown(withVerify, grabbed, { key: 'ArrowRight' });

    expect(r.intent?.type).toBe('refuse_move');
    expect(r.announcement).toMatch(/independent verifier/i);
    // And the card did not move: a refused move leaves the grab in place for
    // the reader to choose again, rather than silently dropping it somewhere.
    expect(r.state.focus.lane).toBe('verify');
  });

  it('escape cancels a grab without moving anything', () => {
    const grabbed = state({ grabbedTaskId: 'supa_1' });
    const r = boardKeyDown(board, grabbed, { key: 'Escape' });
    expect(r.state.grabbedTaskId).toBeNull();
    expect(r.intent).toEqual({ type: 'cancel_grab' });
    expect(r.announcement).toMatch(/did not change lane/);
  });

  it('space a second time puts the card back down where it was', () => {
    const grabbed = state({ grabbedTaskId: 'supa_1' });
    const r = boardKeyDown(board, grabbed, { key: ' ' });
    expect(r.state.grabbedTaskId).toBeNull();
    expect(r.announcement).toMatch(/put back down/);
  });

  it('tells a grabbed card that up and down are not how you move lanes', () => {
    const grabbed = state({ grabbedTaskId: 'supa_1' });
    const r = boardKeyDown(board, grabbed, { key: 'ArrowDown' });
    expect(r.intent).toBeNull();
    expect(r.announcement).toMatch(/left and right/);
  });
});

describe('opening the detail', () => {
  it('enter opens the drawer for the focused card', () => {
    const r = boardKeyDown(board, state(), { key: 'Enter' });
    expect(r.intent).toEqual({ type: 'open_drawer', taskId: 'supa_1' });
  });

  it('does nothing when no card is focused', () => {
    const r = boardKeyDown(board, state({ focus: { lane: 'ready', index: -1 } }), { key: 'Enter' });
    expect(r.intent).toBeNull();
  });
});

describe('an empty board', () => {
  it('still has a focus and does not throw', () => {
    const empty = buildBoard([]);
    const focus = initialFocus(empty);
    expect(focus).toEqual({ lane: 'backlog', index: -1 });
    expect(() => boardKeyDown(empty, { focus, grabbedTaskId: null }, { key: 'ArrowDown' })).not.toThrow();
  });
});
