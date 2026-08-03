// === JARVIS MOD #66 — authoritative live counts for the fast path ===
// New file. The fast path is a no-tools conversational lane, and its system
// prompt already said "Never guess at data you cannot see; escalate instead."
// It free-answered anyway: asked how many active stagings there were, it
// replied "five staged properties, two are active" while the dashboard tile
// said 16 and the database held 21. An instruction not to guess does not stop
// guessing, because a count question does not FEEL like a data lookup to the
// model — it feels like conversation it can already handle.
//
// Two changes together fix that, and both are needed:
//   1. This snapshot puts the real numbers in the prompt, so the common count
//      questions have a correct answer available with no round trip.
//   2. The escalation rule (identity-assembler) is sharpened from a general
//      "don't guess" to a specific, checkable rule about numbers.
//
// The numbers come from the SAME predicate as the dashboard tile and the voice
// tools (@/lib/uhs/staging-status), so the fast path cannot become a fourth
// disagreeing surface.
//
// This is volatile data and must only ever ride the UNCACHED system block —
// putting it in the cached identity block would both poison the prefix cache
// and serve stale counts.
// === END header ===

import { fetchStagingCounts, type StagingCounts } from '@/lib/uhs/staging-status';

/** Short cache: the counts move a few times a day, and a fast-path turn must
 *  never wait on a database round trip it does not need. */
const SNAPSHOT_TTL_MS = 60_000;

let cache: { at: number; counts: StagingCounts | null } | null = null;
let inFlight: Promise<StagingCounts | null> | null = null;

/** Test hook. */
export function _clearSnapshotCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Render the snapshot for the uncached system block.
 *
 * Returns '' when the data is unavailable — deliberately. A snapshot that says
 * "counts unavailable" invites the model to fill the gap conversationally,
 * whereas no snapshot at all leaves only the escalation rule, which routes the
 * question to the full agent. Silence is the safer failure here.
 */
export function renderSnapshot(counts: StagingCounts | null): string {
  if (!counts) return '';
  return (
    'AUTHORITATIVE LIVE COUNTS (as of this turn — these are the real numbers, ' +
    'identical to the dashboard tiles; never contradict them and never round them):\n' +
    `- Active stagings (furniture in the home right now): ${counts.activeStagings}\n` +
    `- Open contracts (billing relationship live): ${counts.openContracts}\n` +
    // Spelled out as a subset, because the model read a bare third number as an
    // additional group and said "two MORE" on top of the 23 (live, 2026-08-03).
    `- Of those ${counts.openContracts} open contracts, ${counts.awaitingInstall} are signed but ` +
    `not yet installed; the other ${counts.activeStagings} are the active stagings above. ` +
    'The three numbers are one set, not three separate groups — never add them together.\n' +
    'If asked for any of these three numbers, answer from this list exactly. ' +
    'For ANY other quantity — revenue, leads, inventory, agents, listings, ' +
    'counts over a date range, or a breakdown of the numbers above — you do NOT ' +
    'have the data and must reply with <<ESCALATE>> alone.'
  );
}

/**
 * Current counts, cached for a minute. Concurrent callers share one fetch.
 * Never throws: on any failure the caller simply gets no snapshot.
 */
export async function getLiveCounts(): Promise<StagingCounts | null> {
  if (cache && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.counts;
  if (inFlight) return inFlight;
  inFlight = fetchStagingCounts()
    .then((counts) => {
      cache = { at: Date.now(), counts };
      return counts;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Convenience: the rendered block, or '' when unavailable. */
export async function getSnapshotBlock(): Promise<string> {
  return renderSnapshot(await getLiveCounts());
}
// === END JARVIS MOD #66 ===
