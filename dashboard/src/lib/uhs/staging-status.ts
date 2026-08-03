// === JARVIS MOD #55 — ONE definition of "active staging" / "open contract" ===
// New file, and the single source of truth for both. It exists because three
// surfaces answered the same question three different ways on 2026-08-03:
//
//   chat card ......... "five staged properties, two active"  (fabricated)
//   Active Stagings ... 16   (cosmos-stats tile: status = STAGED only)
//   contract_stat ..... 19   (MOD #52 lane: four statuses, no NOTICE_GIVEN)
//
// All three were wrong. Scott's standing rule is that surfaced lists must
// agree: a number in one tile and a different number for the same question in
// the next panel is a bug in the predicate, not a rounding difference. So the
// predicates live here once, and every surface imports them. Changing what
// "active" means is now a one-file change that moves every surface together.
//
// The two questions are genuinely different, and conflating them is what
// produced the mismatch:
//
//   ACTIVE STAGING  — is our furniture physically in that house right now?
//                     Installed, not yet removed. This is the operations
//                     number: what the crew is responsible for today.
//   OPEN CONTRACT   — is the billing relationship live?
//                     Includes signed work not yet installed, and includes
//                     homes where notice has been given but removal has not
//                     happened. This is the money/dates number.
//
// The gap between them is real and small (2 awaiting install on 2026-08-03),
// so each surface must say WHICH it means rather than quietly picking one.
// === END header ===

/** Statuses where the contract is live — we are owed money or owe service. */
export const OPEN_CONTRACT_STATUSES = [
  'STAGED',
  'CONTRACTED',
  // Notice given but the furniture is still in the house and still billing
  // through the paid-through date. Omitting this is what made the MOD #52 lane
  // read 19 instead of 23, and it hid exactly the projects whose dates people
  // ask about most.
  'NOTICE_GIVEN',
  'PENDING_SALE',
  'PENDING_COLLECTION',
] as const;

/** Terminal statuses — history, never counted as current work. */
export const CLOSED_STATUSES = ['COMPLETE', 'DESTAGED', 'CANCELLED', 'SOLD', 'INQUIRY', 'MISC'];

export interface StagingRow {
  status?: string | null;
  stage_date?: string | null;
  destage_date?: string | null;
}

/** Today in Pacific as YYYY-MM-DD. UHS runs on Las Vegas time, always. */
export function todayPT(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** The contract is live (regardless of whether install has happened yet). */
export function isOpenContract(row: StagingRow): boolean {
  const s = (row.status ?? '').toUpperCase();
  return (OPEN_CONTRACT_STATUSES as readonly string[]).includes(s);
}

/**
 * Our furniture is in that house right now: the contract is open, install has
 * happened on or before today, and removal has not happened yet.
 *
 * A future `destage_date` is a SCHEDULED removal, not a completed one — the
 * staging is still active until that date arrives, so it must not be excluded.
 */
export function isActiveStaging(row: StagingRow, today: string = todayPT()): boolean {
  if (!isOpenContract(row)) return false;
  if (!row.stage_date || row.stage_date > today) return false; // not installed yet
  if (row.destage_date && row.destage_date <= today) return false; // already removed
  return true;
}

/** Signed but not yet installed — the difference between the two headline numbers. */
export function isAwaitingInstall(row: StagingRow, today: string = todayPT()): boolean {
  return isOpenContract(row) && (!row.stage_date || row.stage_date > today);
}

/** PostgREST filter value for the open-contract status set. */
export function openStatusFilter(): string {
  return `in.(${OPEN_CONTRACT_STATUSES.join(',')})`;
}

export interface StagingCounts {
  activeStagings: number;
  openContracts: number;
  awaitingInstall: number;
}

export function countStagings(rows: StagingRow[], today: string = todayPT()): StagingCounts {
  const open = rows.filter(isOpenContract);
  return {
    activeStagings: open.filter((r) => isActiveStaging(r, today)).length,
    openContracts: open.length,
    awaitingInstall: open.filter((r) => isAwaitingInstall(r, today)).length,
  };
}

/** Columns any caller needs to evaluate the predicates above. */
export const STAGING_STATUS_COLUMNS = 'status,stage_date,destage_date';

/**
 * Fetch the counts from the uhsEstimate `projects` table.
 *
 * Deliberately counts in JS over a narrow three-column read rather than asking
 * PostgREST for a HEAD count: "active" is a predicate over three columns and a
 * date, which a status-equality count cannot express — that shortcut is exactly
 * how the tile ended up reporting STAGED-only.
 */
export async function fetchStagingCounts(): Promise<StagingCounts | null> {
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) return null;

  const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
  endpoint.searchParams.set('select', STAGING_STATUS_COLUMNS);
  endpoint.searchParams.set('status', openStatusFilter());
  endpoint.searchParams.set('limit', '500');

  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as StagingRow[];
    if (!Array.isArray(rows)) return null;
    return countStagings(rows);
  } catch {
    return null;
  }
}
// === END JARVIS MOD #55 ===
