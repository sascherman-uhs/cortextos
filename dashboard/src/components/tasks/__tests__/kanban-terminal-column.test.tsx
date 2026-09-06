/**
 * Fix6 / defect M1 — failed work must be legible on the default view.
 *
 * Reproduced before the fix: a failed task was visible in List view and on the
 * OS-03 work board, but the legacy /tasks Kanban had exactly four columns —
 * Pending, In Progress, Blocked, Completed — so a task that failed appeared in
 * no column at all on the view the page opens with.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KanbanBoard } from '../kanban-board';
import type { Task } from '@/lib/types';

function task(over: Partial<Task> & { id: string; status: string }): Task {
  return {
    title: `Task ${over.id}`,
    priority: 'normal',
    org: 'uhs',
    needs_approval: false,
    created_at: '2026-09-01T00:00:00Z',
    version: 1,
    ...over,
  };
}

const ROWS: Task[] = [
  task({ id: 'a', status: 'pending', title: 'Renew the Colanthe contract' }),
  task({ id: 'b', status: 'failed', title: 'Stageforce photo upload' }),
  task({ id: 'c', status: 'cancelled', title: 'Abandoned experiment' }),
];

describe('the legacy Kanban', () => {
  const html = renderToStaticMarkup(
    <KanbanBoard tasks={ROWS} completedTodayTasks={[]} onTaskClick={() => {}} />,
  );

  it('shows a failed task rather than dropping it out of every column', () => {
    expect(html).toContain('Stageforce photo upload');
  });

  it('shows cancelled work in the same terminal column', () => {
    expect(html).toContain('Abandoned experiment');
  });

  it('still shows ordinary work', () => {
    expect(html).toContain('Renew the Colanthe contract');
  });

  it('names the terminal column so the two outcomes are not conflated', () => {
    expect(html).toContain('/ cancelled');
  });
});
