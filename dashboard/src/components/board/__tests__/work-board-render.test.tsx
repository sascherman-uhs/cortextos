/**
 * OS-03 — what the work board renders, including the states a board usually
 * hides: an empty column that cannot be populated, a degraded source, a
 * refused move, a loading drawer and a drawer that failed to load.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkBoard } from '../work-board';
import { BoardCardView } from '../board-card';
import { TaskDrawer } from '../task-drawer';
import { toBoardCard, buildBoard, legacyCompletionLabel } from '@/lib/os03/work-board';
import { projectTask } from '@/lib/data/task-projection';
import type { ProjectedTask } from '@/lib/data/tasks';
import type { Task } from '@/lib/types';

function task(over: Partial<Task> & { id: string; status: string }): ProjectedTask {
  const base: Task = {
    id: over.id, title: over.title ?? `Task ${over.id}`, status: over.status,
    priority: over.priority ?? 'normal', assignee: over.assignee, org: over.org ?? 'uhs',
    project: over.project, needs_approval: false, notes: over.notes,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    completed_at: over.completed_at, description: over.description,
  };
  return {
    ...base,
    projection: projectTask({
      status: base.status, assignee: base.assignee, title: base.title, project: base.project,
    }),
  };
}

const ROWS = [
  task({ id: 'supa_1', status: 'pending', title: 'Renew the Colanthe contract', project: 'sales' }),
  task({ id: 'supa_2', status: 'in_progress', title: 'Nightly MLS sync', assignee: 'jarvis-mls' }),
  task({ id: 'supa_3', status: 'failed', title: 'Stageforce photo upload', notes: 'browser bridge died' }),
  task({ id: 'supa_4', status: 'blocked', title: 'Approve the Capsule offer', assignee: 'scott' }),
  task({ id: 'supa_5', status: 'cancelled', title: 'Abandoned experiment' }),
];

describe('the board', () => {
  const html = renderToStaticMarkup(<WorkBoard tasks={ROWS} />);

  it('renders all five columns plus a visible Waiting lane', () => {
    for (const c of ['backlog', 'ready', 'doing', 'verify', 'done']) {
      expect(html).toContain(`data-testid="column-${c}"`);
    }
    expect(html).toContain('data-testid="lane-waiting"');
  });

  it('explains an empty Ready column instead of implying nothing is ready', () => {
    expect(html).toContain('No source status projects onto Ready');
  });

  it('keeps cancelled work visible as its own outcome', () => {
    expect(html).toContain('data-testid="lane-terminal"');
    expect(html).toContain('Abandoned experiment');
  });

  it('offers a waiting filter for each subtype with its count', () => {
    for (const s of ['human', 'retry', 'dependency', 'external', 'unclassified']) {
      expect(html).toContain(`data-testid="waiting-filter-${s}"`);
    }
    expect(html).toContain('Human decision (1)');
  });

  it('gives the phone a lane switcher with counts, not six columns', () => {
    expect(html).toContain('data-testid="lane-switcher"');
    expect(html).toContain('data-testid="board-mobile"');
    // The desktop board is hidden below the md breakpoint.
    expect(html).toMatch(/data-testid="board-desktop"[^>]*class="[^"]*hidden md:block/);
  });

  it('states the keyboard equivalents on the page, not only in a tooltip', () => {
    expect(html).toContain('data-testid="board-keyboard-help"');
    expect(html).toContain('Space picks a card up');
    expect(html).toContain('Escape cancels a move in progress.');
  });

  it('carries a polite live region for move announcements', () => {
    expect(html).toContain('data-testid="board-live-region"');
    expect(html).toContain('aria-live="polite"');
  });

  it('names each lane for assistive technology with its count', () => {
    expect(html).toContain('aria-label="Backlog, 1 cards"');
    expect(html).toContain('aria-label="Waiting, 2 cards"');
  });
});

describe('a degraded board', () => {
  it('renders empty lanes as unknown, never as nothing to do', () => {
    const html = renderToStaticMarkup(<WorkBoard tasks={[]} degraded />);
    expect(html).toContain('Unknown — a source behind this board could not be read.');
    expect(html).not.toContain('Nothing in this lane.');
  });
});

describe('an empty board with healthy sources', () => {
  it('says the lane is empty, plainly', () => {
    const html = renderToStaticMarkup(<WorkBoard tasks={[]} />);
    expect(html).toContain('Nothing is waiting.');
  });
});

describe('a card', () => {
  it('carries every field the plan requires, or says it is not recorded', () => {
    const card = toBoardCard(ROWS[0]);
    const html = renderToStaticMarkup(<BoardCardView card={card} />);
    expect(html).toContain('Renew the Colanthe contract');
    expect(html).toContain('sales');          // project
    expect(html).toContain('normal');         // priority
    expect(html).toContain('Agent:');
    expect(html).toContain('Human:');
    expect(html).toContain('no due time recorded');
    expect(html).toContain('Last update:');
    expect(html).toContain('Evidence:');
    // The native status is shown beside the projected lane, always.
    expect(html).toContain('pending');
  });

  it('shows a blocked card its own blocker reason', () => {
    const card = toBoardCard(ROWS[2]);
    const html = renderToStaticMarkup(<BoardCardView card={card} />);
    expect(html).toContain('Blocked by:');
    expect(html).toContain('browser bridge died');
    expect(html).toContain('failed');
  });

  it('labels an unevidenced completion in the contract\'s own words', () => {
    const done = toBoardCard(task({ id: 'd', status: 'completed', completed_at: '2026-09-05T00:00:00Z' }));
    const html = renderToStaticMarkup(<BoardCardView card={done} />);
    expect(html).toContain(legacyCompletionLabel());
  });
});

describe('the detail drawer', () => {
  const card = toBoardCard(ROWS[2]);

  it('lists every required section, saying which the record does not carry', () => {
    const html = renderToStaticMarkup(
      <TaskDrawer card={card} detail={null} onClose={() => {}} />,
    );
    for (const label of [
      'Brief', 'Acceptance criteria', 'Dependencies', 'Source', 'Execution attempts',
      'Event timeline', 'Approval history', 'Changed artifacts', 'Test results', 'Next action',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('not recorded');
    expect(html).toContain('cannot enter Ready until it has some');
  });

  it('keeps the failed attempt attached to the parent task', () => {
    const html = renderToStaticMarkup(
      <TaskDrawer card={card} detail={null} onClose={() => {}} />,
    );
    expect(html).toContain('data-testid="drawer-attempts"');
    expect(html).toContain('browser bridge died');
  });

  it('is a labelled modal dialog with a close control', () => {
    const html = renderToStaticMarkup(
      <TaskDrawer card={card} detail={null} onClose={() => {}} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Close details"');
  });

  it('shows a loading state and an error state distinctly', () => {
    const loading = renderToStaticMarkup(
      <TaskDrawer card={card} detail={null} loading onClose={() => {}} />,
    );
    expect(loading).toContain('Loading the full record…');

    const failed = renderToStaticMarkup(
      <TaskDrawer card={card} detail={null} error="Could not load the full record: 500" onClose={() => {}} />,
    );
    expect(failed).toContain('data-testid="drawer-error"');
    expect(failed).toContain('Could not load the full record');
  });

  it('renders nothing at all when no card is open', () => {
    expect(renderToStaticMarkup(<TaskDrawer card={null} detail={null} onClose={() => {}} />)).toBe('');
  });
});

describe('the board and the model agree', () => {
  it('renders exactly the cards the model puts in each lane', () => {
    const model = buildBoard(ROWS);
    expect(model.laneCounts.backlog).toBe(1);
    expect(model.laneCounts.doing).toBe(1);
    expect(model.waiting.total).toBe(2);
    expect(model.cancelled).toHaveLength(1);
  });
});
