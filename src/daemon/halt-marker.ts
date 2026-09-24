/**
 * Durable agent halt markers (fleet-stability §A4).
 *
 * `AgentProcess.crashCount` and `AgentProcess.status` are INSTANCE fields, and
 * `new AgentProcess()` runs on every `startAgent()` call — not merely at daemon
 * boot. So a halted agent was respawned by daemon boot, a cron, an IPC
 * start-agent, or a plain `cortextos restart <agent>`, each time crashing once
 * and halting again. trillion-coder on 2026-09-24:
 *
 *   [11:05:20Z] HALTED: exit_code=0 crash_count=10 max_crashes=10
 *   [11:07:21Z] HALTED: exit_code=0 crash_count=11 max_crashes=10
 *   [11:15:01Z] HALTED: exit_code=0 crash_count=12 max_crashes=10
 *
 * A flapping, Telegram-spamming halt — with the crash count climbing past its
 * own cap. The fix is a file-persisted marker that `start()` refuses to spawn
 * past, INDEPENDENT of instance state by construction (which is why the fix is
 * not "make crashCount durable"), and which only an explicit operator action
 * clears: `cortextos unhalt <agent>`. Never cleared by daemon boot or a cron.
 *
 * The marker doubles as the visibility hook: it lives at a stable, globbable
 * path (`<ctxRoot>/state/<agent>/.halted`) so an external briefing or dashboard
 * script can enumerate halted agents without talking to the daemon, and it
 * carries the alert bookkeeping that makes halt alerts one-per-transition plus
 * a recurring reminder instead of one ping per crash.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export const HALT_MARKER_FILENAME = '.halted';

export interface HaltMarker {
  /** Agent name — duplicated into the file so a glob result is self-describing. */
  agent: string;
  /** ISO timestamp of the halt TRANSITION. Preserved across re-halts. */
  since: string;
  /** Human-readable cause, e.g. "exceeded 10 crashes today". */
  reason: string;
  crashCount?: number;
  maxCrashes?: number;
  /** ISO timestamp of the most recent Telegram alert/reminder about this halt. */
  lastAlertAt?: string;
  /** How many alerts (transition + reminders) have been sent for this halt. */
  alertCount?: number;
}

export function haltMarkerPath(ctxRoot: string, agent: string): string {
  return join(ctxRoot, 'state', agent, HALT_MARKER_FILENAME);
}

export function readHaltMarker(ctxRoot: string, agent: string): HaltMarker | null {
  const path = haltMarkerPath(ctxRoot, agent);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) {
      // A present-but-empty marker still means halted. Losing the halt to a
      // truncated write would be the silent-respawn bug all over again.
      return { agent, since: new Date(0).toISOString(), reason: 'halted (marker unreadable)' };
    }
    const parsed = JSON.parse(raw) as Partial<HaltMarker>;
    return {
      agent: parsed.agent || agent,
      since: parsed.since || new Date(0).toISOString(),
      reason: parsed.reason || 'halted',
      crashCount: parsed.crashCount,
      maxCrashes: parsed.maxCrashes,
      lastAlertAt: parsed.lastAlertAt,
      alertCount: parsed.alertCount,
    };
  } catch {
    // Unparseable marker = still halted. Fail closed.
    return { agent, since: new Date(0).toISOString(), reason: 'halted (marker unreadable)' };
  }
}

export function isHalted(ctxRoot: string, agent: string): boolean {
  return readHaltMarker(ctxRoot, agent) !== null;
}

/**
 * Write (or refresh) the halt marker. An existing marker's `since` and alert
 * bookkeeping are PRESERVED, so a re-halt is not a new transition and does not
 * re-trigger the transition alert.
 */
export function writeHaltMarker(
  ctxRoot: string,
  agent: string,
  fields: { reason: string; crashCount?: number; maxCrashes?: number },
): HaltMarker {
  const existing = readHaltMarker(ctxRoot, agent);
  const marker: HaltMarker = {
    agent,
    since: existing?.since && existing.since !== new Date(0).toISOString()
      ? existing.since
      : new Date().toISOString(),
    reason: fields.reason,
    crashCount: fields.crashCount,
    maxCrashes: fields.maxCrashes,
    lastAlertAt: existing?.lastAlertAt,
    alertCount: existing?.alertCount,
  };
  persist(ctxRoot, agent, marker);
  return marker;
}

/** Merge fields into an existing marker. No-op when the agent is not halted. */
export function updateHaltMarker(
  ctxRoot: string,
  agent: string,
  patch: Partial<HaltMarker>,
): HaltMarker | null {
  const existing = readHaltMarker(ctxRoot, agent);
  if (!existing) return null;
  const merged = { ...existing, ...patch, agent, since: patch.since || existing.since };
  persist(ctxRoot, agent, merged);
  return merged;
}

/** Remove the marker. Returns true when a marker was actually present. */
export function clearHaltMarker(ctxRoot: string, agent: string): boolean {
  const path = haltMarkerPath(ctxRoot, agent);
  try {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every halted agent in this instance, read straight off disk. Safe to call
 * without a running daemon — this is the hook external briefing/dashboard
 * scripts should use.
 */
export function listHaltedAgents(ctxRoot: string): HaltMarker[] {
  const stateDir = join(ctxRoot, 'state');
  const out: HaltMarker[] = [];
  let entries: string[];
  try {
    entries = readdirSync(stateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const agent of entries) {
    const marker = readHaltMarker(ctxRoot, agent);
    if (marker) out.push(marker);
  }
  return out;
}

function persist(ctxRoot: string, agent: string, marker: HaltMarker): void {
  try {
    mkdirSync(join(ctxRoot, 'state', agent), { recursive: true });
    writeFileSync(
      haltMarkerPath(ctxRoot, agent),
      `${JSON.stringify(marker, null, 2)}\n`,
      'utf-8',
    );
  } catch {
    /* swallow — a marker-write failure must never break crash handling */
  }
}
