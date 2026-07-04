'use client';

// === JARVIS MOD #17 — Fleet controls (Restart All + auto-refresh) (2026-07-03) ===
// Self-contained toolbar rendered above the agents grid. Kept in the uhs/
// isolation dir so the upstream agents page/components stay minimal. Wraps its
// own ToastProvider (same pattern as agent-routing-board.tsx) so it does not
// depend on a provider being mounted in the shared layout.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast, ToastProvider } from '@/components/ui/toast';
import { IconRefresh, IconLoader2, IconCheck, IconX } from '@tabler/icons-react';
import type { AgentCardData } from '@/components/agents/agent-card';

interface FleetControlsProps {
  agents: AgentCardData[];
}

type PerAgentStatus = 'pending' | 'running' | 'ok' | 'error';

interface RestartResult {
  systemName: string;
  name: string;
  status: PerAgentStatus;
  message?: string;
}

// ---------------------------------------------------------------------------
// Visibility-aware 10s status poll. Calls router.refresh() (re-runs the
// server component, re-reads heartbeats) only while the tab is visible.
// ---------------------------------------------------------------------------
function useVisibleStatusPoll(intervalMs: number) {
  const router = useRouter();
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, intervalMs]);
}

function FleetControlsInner({ agents }: FleetControlsProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RestartResult[]>([]);
  const abortRef = useRef(false);

  useVisibleStatusPoll(10_000);

  const runRestartAll = useCallback(async () => {
    setRunning(true);
    abortRef.current = false;
    // Seed progress list in display order.
    const seed: RestartResult[] = agents.map((a) => ({
      systemName: a.systemName,
      name: a.name,
      status: 'pending',
    }));
    setResults(seed);

    // Sequential — mirror per-agent lifecycle restart; never parallelize so we
    // don't hammer the daemon IPC socket or the fleet all at once.
    for (let i = 0; i < agents.length; i++) {
      if (abortRef.current) break;
      const a = agents[i];
      setResults((prev) =>
        prev.map((r) => (r.systemName === a.systemName ? { ...r, status: 'running' } : r)),
      );
      try {
        const res = await fetch(
          `/api/agents/${encodeURIComponent(a.systemName)}/lifecycle`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restart_continue', org: a.org }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `Failed (${res.status})`);
        }
        setResults((prev) =>
          prev.map((r) =>
            r.systemName === a.systemName ? { ...r, status: 'ok' } : r,
          ),
        );
        toast({ message: `${a.name}: restart dispatched`, variant: 'success' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setResults((prev) =>
          prev.map((r) =>
            r.systemName === a.systemName ? { ...r, status: 'error', message } : r,
          ),
        );
        toast({ message: `${a.name}: ${message}`, variant: 'error' });
      }
    }

    setRunning(false);
    router.refresh();
  }, [agents, router, toast]);

  const okCount = results.filter((r) => r.status === 'ok').length;
  const errCount = results.filter((r) => r.status === 'error').length;
  const doneCount = okCount + errCount;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setResults([]);
            setConfirmOpen(true);
          }}
          disabled={running || agents.length === 0}
          data-testid="restart-all-btn"
        >
          {running ? (
            <IconLoader2 className="h-4 w-4 animate-spin" />
          ) : (
            <IconRefresh className="h-4 w-4" />
          )}
          Restart All
        </Button>
        {running && (
          <span className="text-xs text-muted-foreground" data-testid="restart-all-progress">
            {doneCount} / {agents.length} done
          </span>
        )}
      </div>

      {/* Inline per-agent result list */}
      {results.length > 0 && (
        <div
          className="rounded-md border bg-muted/20 p-2 text-xs"
          data-testid="restart-all-results"
        >
          <div className="mb-1 flex items-center gap-3 font-medium">
            <span>Restart progress</span>
            <span className="text-green-600">{okCount} ok</span>
            {errCount > 0 && <span className="text-destructive">{errCount} failed</span>}
          </div>
          <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
            {results.map((r) => (
              <li key={r.systemName} className="flex items-center gap-1.5">
                {r.status === 'ok' && <IconCheck className="h-3.5 w-3.5 text-green-600" />}
                {r.status === 'error' && <IconX className="h-3.5 w-3.5 text-destructive" />}
                {r.status === 'running' && (
                  <IconLoader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                {r.status === 'pending' && (
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/30" />
                )}
                <span className="truncate font-mono">{r.systemName}</span>
                {r.message && (
                  <span className="truncate text-destructive" title={r.message}>
                    — {r.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart entire fleet?</DialogTitle>
            <DialogDescription>
              This will sequentially issue a <strong>restart (continue)</strong> to all{' '}
              {agents.length} agents, one at a time. Each keeps its session context. Progress
              and per-agent results are shown below the button.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void runRestartAll();
              }}
            >
              <IconRefresh className="h-4 w-4" />
              Restart all {agents.length}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function FleetControls(props: FleetControlsProps) {
  // Own ToastProvider so this component is drop-in without touching the layout.
  return (
    <ToastProvider>
      <FleetControlsInner {...props} />
    </ToastProvider>
  );
}
// === END JARVIS MOD #17 ===
