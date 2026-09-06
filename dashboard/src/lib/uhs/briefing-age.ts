// Pure snapshot-age arithmetic, deliberately free of any Node import.
//
// This lives apart from ./briefing so client components can compute a
// snapshot's age without dragging `fs`/`path` into the browser bundle. A
// value import of ./briefing from any 'use client' module makes the whole
// app fail to compile — see the 2026-09-05 outage where every route,
// including /login, returned 500.
import type { BriefingSnapshot } from './briefing';

export function snapshotAgeMinutes(
  snapshot: BriefingSnapshot,
  now: Date = new Date(),
): number | null {
  const ts = snapshot.snapshot_cutoff ?? snapshot.published_ui_at;
  if (!ts) return null;
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.round((now.getTime() - then) / 60000));
}
