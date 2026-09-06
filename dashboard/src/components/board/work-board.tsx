// === OS-03 — the work board ===
// New file; never overwritten by upstream merges.
//
// One board, two input methods, ONE path to the server. A drag and a keyboard
// move both call attemptMove(), which posts to the canonical transition
// endpoint. There is no second code path that could permit a move the other
// refuses, and neither can approve external work, bypass verification, or
// resolve an obligation — the board never offers Done as a drop target and the
// server re-checks everything anyway.
//
// Optimistic UI is allowed exactly one behaviour on failure: put the card back
// where it was and say why, out loud, in a live region.

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  BOARD_COLUMNS,
  COLUMN_LABEL,
  COLUMN_MEANING,
  WAITING_SUBTYPE_LABEL,
  WAITING_SUBTYPES,
  buildBoard,
  checkMove,
  type BoardCard,
  type BoardModel,
} from '@/lib/os03/work-board';
import { boardKeyDown, initialFocus, KEYBOARD_HELP, type KeyboardState } from '@/lib/os03/board-keyboard';
import { boardGridClass } from '@/lib/os03/layout';
import { toNative, type CanonicalState } from '@/lib/data/transition-contract';
import type { ProjectedTask } from '@/lib/data/tasks';
import type { WaitingSubtype } from '@/lib/data/task-projection';
import { BoardCardView } from './board-card';
import { TaskDrawer, emptyDetail, type DrawerDetail } from './task-drawer';
import { LegacyWorkDialog, type LegacyPrompt, type LegacySubmission } from './legacy-work-dialog';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving'; taskId: string }
  | { kind: 'saved'; taskId: string; message: string }
  | { kind: 'error'; taskId: string | null; message: string };

export function WorkBoard({
  tasks,
  degraded = false,
  initialTaskId,
}: {
  tasks: ProjectedTask[];
  degraded?: boolean;
  initialTaskId?: string | null;
}) {
  const [rows, setRows] = useState(tasks);
  const [waitingFilter, setWaitingFilter] = useState<WaitingSubtype | null>(null);
  const [search, setSearch] = useState('');
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [announcement, setAnnouncement] = useState('');
  const [openTaskId, setOpenTaskId] = useState<string | null>(initialTaskId ?? null);
  const [detail, setDetail] = useState<DrawerDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [mobileLane, setMobileLane] = useState<CanonicalState>('doing');
  // A refused move that the person can actually fix. Holds what the server said
  // was missing until they either supply it, waive it, or walk away.
  const [legacyPrompt, setLegacyPrompt] = useState<LegacyPrompt | null>(null);

  // Derived state adjusted during render rather than in an effect: a fresh
  // server render replaces the optimistic rows, and switching cards clears the
  // previous card's detail so the drawer never shows one task's record under
  // another task's title.
  const [seed, setSeed] = useState(tasks);
  if (seed !== tasks) {
    setSeed(tasks);
    setRows(tasks);
  }
  const [detailFor, setDetailFor] = useState<string | null>(initialTaskId ?? null);
  if (detailFor !== openTaskId) {
    setDetailFor(openTaskId);
    setDetail(null);
    setDetailError(null);
  }
  const detailLoading = Boolean(openTaskId) && detail === null && detailError === null;

  const board: BoardModel = useMemo(
    () => buildBoard(rows, { filters: { waitingSubtype: waitingFilter, search }, degraded }),
    [rows, waitingFilter, search, degraded],
  );

  const [kb, setKb] = useState<KeyboardState>(() => ({
    focus: initialFocus(buildBoard(tasks, { degraded })),
    grabbedTaskId: null,
  }));

  const boardRef = useRef<HTMLDivElement>(null);
  const cardById = useMemo(() => {
    const m = new Map<string, BoardCard>();
    for (const c of board.columns.flatMap((c) => c.cards)) m.set(c.id, c);
    for (const c of board.waiting.cards) m.set(c.id, c);
    for (const c of [...board.cancelled, ...board.failedTerminal]) m.set(c.id, c);
    return m;
  }, [board]);

  // -------------------------------------------------------------------------
  // The one move path
  // -------------------------------------------------------------------------
  const attemptMove = useCallback(
    async (taskId: string, to: CanonicalState, submission?: LegacySubmission) => {
      const card = cardById.get(taskId);
      if (!card) return;

      const check = checkMove(card, to);
      if (!check.allowed) {
        // A refused move is stated, never silently ignored.
        setSave({ kind: 'error', taskId, message: check.reason ?? 'That move is not permitted.' });
        setAnnouncement(check.reason ?? 'That move is not permitted.');
        return;
      }

      const previous = rows;
      // Optimistic: project the row onto the target lane locally, using the
      // native word the owning store would accept, so the board responds at
      // once without inventing a status the store has never heard of.
      const optimisticNative = toNative(card.source, to);
      if (optimisticNative) {
        setRows((current) =>
          current.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: optimisticNative,
                  projection: { ...t.projection, status: optimisticNative },
                }
              : t,
          ),
        );
      }
      setSave({ kind: 'saving', taskId });
      setAnnouncement(`Moving ${card.title} to ${COLUMN_LABEL[to]}.`);

      try {
        const res = await fetch(`/api/tasks/${taskId}/transition`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, ...(submission ?? {}) }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          setLegacyPrompt(null);
          setSave({ kind: 'saved', taskId, message: `Moved to ${COLUMN_LABEL[to]}.` });
          setAnnouncement(`${card.title} moved to ${COLUMN_LABEL[to]}.`);
          // Take the server's word for the new state, not the optimistic guess.
          setRows((current) =>
            current.map((t) =>
              t.id === taskId
                ? { ...t, status: data.nativeStatus ?? t.status,
                    projection: { ...t.projection, status: data.nativeStatus ?? t.projection.status } }
                : t,
            ),
          );
          return;
        }

        // Roll the optimistic move back. The board must not keep showing a
        // position the server refused.
        setRows(previous);
        const message =
          res.status === 409
            ? (data.message ??
               'This task changed while you were looking at it. The board has been put back and refreshed.')
            : (data.reason ?? data.error ?? 'The server refused this move.');

        // A refusal the person can fix is not a dead end. When the server says
        // which contract fields the record is missing, offer to take them.
        if (res.status === 422 && Array.isArray(data.missing) && data.missing.length > 0) {
          setLegacyPrompt({
            taskId,
            title: card.title,
            to,
            toLabel: COLUMN_LABEL[to],
            missing: data.missing as string[],
            waivable: data.waivable === true,
            message,
            suggestedOutcome: card.title,
          });
          setSave({ kind: 'idle' });
          setAnnouncement(`${message} A form is open to supply what is missing.`);
          return;
        }

        setLegacyPrompt(null);
        setSave({ kind: 'error', taskId, message });
        setAnnouncement(message);
      } catch {
        setRows(previous);
        const message = 'Could not reach the server. This card was not moved.';
        setSave({ kind: 'error', taskId, message });
        setAnnouncement(message);
      }
    },
    [cardById, rows],
  );

  // -------------------------------------------------------------------------
  // Keyboard — the same rules the drag uses
  // -------------------------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const result = boardKeyDown(board, kb, { key: e.key, shiftKey: e.shiftKey });
      if (!result.handled) return;
      e.preventDefault();
      setKb(result.state);
      if (result.announcement) setAnnouncement(result.announcement);

      const intent = result.intent;
      if (!intent) return;
      if (intent.type === 'open_drawer') setOpenTaskId(intent.taskId);
      if (intent.type === 'request_move') void attemptMove(intent.taskId, intent.to);
      if (intent.type === 'refuse_move') {
        setSave({ kind: 'error', taskId: intent.taskId, message: intent.reason });
      }
    },
    [board, kb, attemptMove],
  );

  // Focus restoration: closing the drawer returns focus to the board, on the
  // card the reader came from.
  const closeDrawer = useCallback(() => {
    setOpenTaskId(null);
    setDetail(null);
    setDetailError(null);
    boardRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!openTaskId) return;
    let cancelled = false;
    fetch(`/api/tasks/${openTaskId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`the record could not be read (${res.status})`);
        return res.json();
      })
      .then((task) => {
        if (cancelled) return;
        const d: DrawerDetail = {
          ...emptyDetail(),
          brief: task.description ?? null,
          source: task.source_file ?? null,
          changedArtifacts: (task.outputs ?? []).map((o: { label?: string; value: string }) => ({
            label: o.label ?? o.value,
            href: null,
          })),
          testResults: task.notes ?? null,
        };
        setDetail(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setDetailError(`Could not load the full record: ${err.message}`);
      });
    return () => { cancelled = true; };
  }, [openTaskId]);

  const focusedCard = useMemo(() => {
    const lane = kb.focus.lane;
    const cards =
      lane === 'waiting'
        ? board.waiting.cards
        : (board.columns.find((c) => c.state === lane)?.cards ?? []);
    return cards[kb.focus.index] ?? null;
  }, [board, kb.focus]);

  const renderCards = (cards: BoardCard[]) =>
    cards.map((card) => (
      <div
        key={card.id}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', card.id);
          setAnnouncement(`${card.title} picked up.`);
        }}
      >
        <BoardCardView
          card={card}
          focused={focusedCard?.id === card.id}
          grabbed={kb.grabbedTaskId === card.id}
          onOpen={setOpenTaskId}
        />
      </div>
    ));

  const dropHandlers = (state: CanonicalState) => ({
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (id) void attemptMove(id, state);
    },
  });

  const laneOptions: CanonicalState[] = [...BOARD_COLUMNS, 'waiting'];

  return (
    <div className="space-y-4">
      {legacyPrompt && (
        <LegacyWorkDialog
          prompt={legacyPrompt}
          busy={save.kind === 'saving'}
          onCancel={() => {
            setLegacyPrompt(null);
            setAnnouncement('Left where it was. Nothing was changed.');
            boardRef.current?.focus();
          }}
          onSubmit={(submission) => {
            void attemptMove(legacyPrompt.taskId, legacyPrompt.to as CanonicalState, submission);
          }}
        />
      )}

      {/* Save / error state, always visible and always announced. */}
      <div aria-live="polite" className="sr-only" data-testid="board-live-region">
        {announcement}
      </div>
      {save.kind !== 'idle' && (
        <div
          role={save.kind === 'error' ? 'alert' : 'status'}
          data-testid={`board-save-${save.kind}`}
          className={`rounded-md border px-3 py-2 text-sm ${
            save.kind === 'error'
              ? 'border-destructive bg-destructive/10 text-destructive'
              : 'border-border bg-muted/50 text-muted-foreground'
          }`}
        >
          {save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? save.message : save.message}
          {save.kind !== 'saving' && (
            <button
              type="button"
              className="ml-3 underline underline-offset-2"
              onClick={() => setSave({ kind: 'idle' })}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search titles and ids"
          aria-label="Search the board"
          data-testid="board-search"
          className="h-8 rounded-md border bg-background px-2 text-sm"
        />
        <span className="text-xs text-muted-foreground">Waiting:</span>
        <button
          type="button"
          aria-pressed={waitingFilter === null}
          data-testid="waiting-filter-all"
          onClick={() => setWaitingFilter(null)}
          className={`rounded-md px-2 py-1 text-xs ${waitingFilter === null ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted'}`}
        >
          All ({board.waiting.total})
        </button>
        {WAITING_SUBTYPES.map((s) => {
          const group = board.waiting.groups.find((g) => g.subtype === s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={waitingFilter === s}
              data-testid={`waiting-filter-${s}`}
              onClick={() => setWaitingFilter(s)}
              className={`rounded-md px-2 py-1 text-xs ${waitingFilter === s ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted'}`}
            >
              {WAITING_SUBTYPE_LABEL[s]} ({group?.count ?? 0})
            </button>
          );
        })}
      </div>

      {/* Phone: a readable list with lane counts and a deliberate switcher.
          Six columns are never squeezed onto a phone (plan §3). */}
      <div className="md:hidden" data-testid="board-mobile">
        <label className="text-xs text-muted-foreground" htmlFor="lane-switcher">
          Lane
        </label>
        <select
          id="lane-switcher"
          data-testid="lane-switcher"
          value={mobileLane}
          onChange={(e) => setMobileLane(e.target.value as CanonicalState)}
          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
        >
          {laneOptions.map((lane) => (
            <option key={lane} value={lane}>
              {COLUMN_LABEL[lane]} ({board.laneCounts[lane] ?? 0})
            </option>
          ))}
        </select>
        <div className="mt-2 flex flex-col gap-2">
          {(mobileLane === 'waiting'
            ? board.waiting.cards
            : (board.columns.find((c) => c.state === mobileLane)?.cards ?? [])
          ).map((card) => (
            <BoardCardView key={card.id} card={card} onOpen={setOpenTaskId} />
          ))}
        </div>
      </div>

      {/* Desktop board */}
      <div
        ref={boardRef}
        tabIndex={0}
        role="application"
        aria-label="Work board. Use the arrow keys to move between cards and lanes."
        onKeyDown={onKeyDown}
        data-testid="board-desktop"
        className="hidden md:block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md"
      >
        <p className="mb-2 text-xs text-muted-foreground" data-testid="board-keyboard-help">
          {KEYBOARD_HELP.join(' ')}
        </p>
        <div className={boardGridClass()}>
          {board.columns.map((col) => (
            <section
              key={col.state}
              aria-label={`${col.label}, ${col.count} cards`}
              data-testid={`column-${col.state}`}
              {...dropHandlers(col.state)}
              className="flex flex-col gap-2 rounded-lg bg-muted/20 p-2"
            >
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wide">{col.label}</h2>
                <Badge variant="secondary" className="text-[10px]">{col.count}</Badge>
              </header>
              <p className="text-[11px] text-muted-foreground">{COLUMN_MEANING[col.state]}</p>
              {col.cards.length === 0 ? (
                <p className="py-4 text-xs text-muted-foreground" data-testid={`column-${col.state}-empty`}>
                  {board.degraded
                    ? 'Unknown — a source behind this board could not be read.'
                    : (col.unpopulatedReason ?? 'Nothing in this lane.')}
                </p>
              ) : (
                renderCards(col.cards)
              )}
            </section>
          ))}
        </div>

        {/* Waiting is visible beside the board, never hidden behind a tab. */}
        <section
          aria-label={`Waiting, ${board.waiting.total} cards`}
          data-testid="lane-waiting"
          {...dropHandlers('waiting')}
          className="mt-4 rounded-lg border p-3"
        >
          <header className="flex items-center justify-between">
            <h2 className="text-xs font-medium uppercase tracking-wide">
              Waiting — {COLUMN_MEANING.waiting}
            </h2>
            <Badge variant="destructive" className="text-[10px]">{board.waiting.total}</Badge>
          </header>
          <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {board.waiting.cards.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {board.degraded
                  ? 'Unknown — a source behind this lane could not be read.'
                  : 'Nothing is waiting.'}
              </p>
            ) : (
              renderCards(board.waiting.cards)
            )}
          </div>
        </section>

        {/* Terminal states stay visible: cancellation is a distinct outcome
            with a reason, and abandoned work is history, not a deletion. */}
        {(board.cancelled.length > 0 || board.failedTerminal.length > 0) && (
          <section className="mt-4 rounded-lg border p-3" data-testid="lane-terminal">
            <h2 className="text-xs font-medium uppercase tracking-wide">
              Cancelled ({board.cancelled.length}) and abandoned ({board.failedTerminal.length})
            </h2>
            <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
              {renderCards([...board.cancelled, ...board.failedTerminal])}
            </div>
          </section>
        )}
      </div>

      <TaskDrawer
        card={openTaskId ? (cardById.get(openTaskId) ?? null) : null}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        onClose={closeDrawer}
      />
    </div>
  );
}
