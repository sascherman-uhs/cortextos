# OS-03 — Today home and accessible work board

Package manifest. It lives at the repository root rather than in the JARVIS
manifest directory (`scripts/agent-os/manifests/`) because OS-03 owns no files
in the uhsJARVIS repository, and not under `docs/` because that directory is
gitignored in this repository.

Branch: `agent-os/OS-03`. Base: `18852a6`.

## Files this package owns

New — created by OS-03, safe to delete wholesale on rollback:

| Path | What it is |
|---|---|
| `dashboard/src/lib/os03/today-view.ts` | Pure model for the Today home: header, Needs Scott, Overnight, Today/Tonight, Business exceptions |
| `dashboard/src/lib/os03/work-board.ts` | Pure model for the board: cards, columns, waiting groups, move legality |
| `dashboard/src/lib/os03/board-keyboard.ts` | Keyboard reducer; the drag handlers call the same rules |
| `dashboard/src/lib/os03/layout.ts` | Width-to-layout decisions (390px phone, 1366px laptop) |
| `dashboard/src/components/today/*.tsx` | Today's four sections plus its top line |
| `dashboard/src/components/board/*.tsx` | Board, card and detail drawer |
| `dashboard/src/app/(dashboard)/page.tsx` | Today, the default home |
| `dashboard/src/app/(dashboard)/board/` | Board route, with its loading and error boundaries |
| `dashboard/src/app/api/tasks/[id]/transition/route.ts` | Canonical-state transition endpoint |
| `dashboard/src/lib/os03/__tests__/` | Model, keyboard and layout tests, plus the `next/link` test stub |
| `dashboard/src/components/{today,board}/__tests__/` | Rendered-markup tests for every state |
| `dashboard/src/app/api/tasks/[id]/transition/__tests__/` | Route tests |

Moved:

| Path | Note |
|---|---|
| `dashboard/src/app/(dashboard)/overview/page.tsx` | Was `(dashboard)/page.tsx`. Content unchanged apart from an OS-03 comment block. |

Modified — small, additive edits to files OS-03 does not own:

| Path | Change |
|---|---|
| `dashboard/src/components/layout/sidebar.tsx` | Added Today and Board nav entries; pointed Overview at `/overview` |
| `dashboard/src/components/layout/bottom-nav.tsx` | Today and Board become the phone's first tabs; Overview, Approvals and Analytics move into the More list |
| `vitest.config.ts` | Added `react`, `react-dom` and `next/link` aliases and `*.test.tsx` to the include list, so components can be rendered to static markup without adding a test dependency |

## What OS-03 deliberately did NOT touch

- `dashboard/src/lib/task-transition.ts` and `dashboard/src/lib/data/transition-contract.ts` (OS-02 owns the transition service and the contract mapping).
- `dashboard/src/app/api/tasks/[id]/route.ts` (its PATCH validates the native status vocabulary that other callers depend on; the board got its own canonical endpoint instead of a widened validator).
- `dashboard/src/lib/data/tasks.ts`, `task-projection.ts`, `action-items.ts`, `source-health.ts` (OS-01 owns the projection and the envelopes).
- The Fleet routing components and the briefing components and page (other packages own them).
- The Queue page and its lanes, which OS-03 reads from and reuses.

## Rollback

1. `git checkout 18852a6 -- vitest.config.ts dashboard/src/components/layout/sidebar.tsx dashboard/src/components/layout/bottom-nav.tsx`
2. `git mv dashboard/src/app/\(dashboard\)/overview/page.tsx dashboard/src/app/\(dashboard\)/page.tsx` and drop the OS-03 comment block at the top.
3. `rm -rf` every path in the "New" table above.

Effect of a rollback: `/` returns to Overview exactly as it was, `/board` and
`/api/tasks/[id]/transition` 404, and the sidebar loses two entries. Nothing
else changes, because OS-03 wrote no data, added no schema, and changed no
existing selector, contract or writer. No task was created or mutated by this
package; the board's only write path is the transition endpoint, which delegates
to the OS-02 service.
