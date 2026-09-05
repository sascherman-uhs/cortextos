// === OS-04 — the morning briefing snapshot, read by the dashboard ===
//
// New file; never overwritten by upstream merges.
//
// The briefing is a durable RECORD, not a Telegram message. uhsJARVIS composes one
// immutable snapshot per business date (versioned), publishes it, and only then sends a
// notification pointing at it. This module is the read side.
//
// Two things it refuses to do, both learned the hard way:
//
//   1. It never presents a degraded snapshot as a clean one. If a source was
//      unavailable when the snapshot was composed, the caller gets `degraded` and the
//      list of feeds that did not answer. An empty night and an unknown night are
//      different facts and must not render the same way.
//   2. It never silently substitutes a different date. If today has no snapshot, it says
//      so; it does not quietly show yesterday's and let it read as current.
//
// When Supabase is unreachable, uhsJARVIS writes an atomic local snapshot marked
// degraded. This module reads that file as the fallback, and labels it as such.
// === END header ===

import fs from 'fs';
import path from 'path';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

/** Where uhsJARVIS writes local fallback snapshots (output/<date>/…). */
const JARVIS_ROOT =
  process.env.UHS_JARVIS_ROOT ??
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsJARVIS';

/** The six sections, in the order plan §8 requires. */
export const REQUIRED_SECTIONS = [
  'decisions_for_scott',
  'verified_overnight_outcomes',
  'improvements',
  'exceptions_and_recovery',
  'todays_commitments',
  'tonights_work',
] as const;

export type SectionId = (typeof REQUIRED_SECTIONS)[number];

export interface BriefingSectionItem {
  header?: string;
  lines?: string[];
  kind?: string;
  title?: string;
  task_id?: number;
  agent?: string;
  owner?: string;
  source?: string;
  detail?: string;
  error?: string;
  evidence?: string;
  next_action?: string;
  completed_at?: string | null;
  late_wrap_up?: boolean;
  completion_time_inferred?: boolean;
  [key: string]: unknown;
}

export interface BriefingSection {
  title: string;
  items: BriefingSectionItem[];
  text: string;
  count: number;
  status: 'ok' | 'degraded' | string;
  note?: string | null;
}

export interface SourceWatermark {
  status: 'fresh' | 'stale' | 'unavailable' | 'partial';
  fetched_at: string;
  count: number | null;
  error: string | null;
}

export interface BriefingSnapshot {
  business_date: string;
  version: number;
  state: string;
  content_hash: string | null;
  degraded: boolean;
  degraded_reasons: { source: string; status: string; error?: string | null }[];
  missed_deadline: boolean;
  window_start: string | null;
  window_end: string | null;
  snapshot_cutoff: string | null;
  policy_version: number | null;
  published_ui_at: string | null;
  persons: string[];
  sections: Record<SectionId, BriefingSection>;
  body_text: string;
  counts: Record<string, number>;
  labels: Record<string, string>;
}

export interface BriefingResult {
  snapshot: BriefingSnapshot | null;
  /** Where the snapshot came from. 'none' means there is no snapshot for that date. */
  origin: 'supabase' | 'local_fallback' | 'none';
  /** Non-fatal problems the UI should surface rather than hide. */
  warnings: string[];
  requestedDate: string;
}

// ---------------------------------------------------------------------------
// Row -> snapshot
// ---------------------------------------------------------------------------

function emptySection(id: SectionId): BriefingSection {
  return { title: id, items: [], text: '', count: 0, status: 'ok', note: null };
}

/**
 * Normalise a stored row. A snapshot missing a required section is a real defect, so it
 * is filled in as an explicitly empty section AND reported as a warning — never dropped
 * and never faked as healthy.
 */
export function rowToSnapshot(
  row: Record<string, unknown>,
  warnings: string[],
): BriefingSnapshot {
  const body = (row.body ?? {}) as Record<string, unknown>;
  const rawSections = (body.sections ?? {}) as Record<string, BriefingSection>;
  const sections = {} as Record<SectionId, BriefingSection>;

  for (const id of REQUIRED_SECTIONS) {
    const s = rawSections[id];
    if (!s) {
      warnings.push(`snapshot is missing the "${id}" section`);
      sections[id] = emptySection(id);
      continue;
    }
    if (typeof s.count === 'number' && Array.isArray(s.items) && s.count !== s.items.length) {
      warnings.push(`section "${id}" reports ${s.count} items but carries ${s.items.length}`);
    }
    sections[id] = {
      title: s.title ?? id,
      items: Array.isArray(s.items) ? s.items : [],
      text: s.text ?? '',
      count: typeof s.count === 'number' ? s.count : (s.items?.length ?? 0),
      status: s.status ?? 'ok',
      note: s.note ?? null,
    };
  }

  return {
    business_date: String(row.business_date),
    version: Number(row.version),
    state: String(row.state ?? 'unknown'),
    content_hash: (row.content_hash as string) ?? null,
    degraded: Boolean(row.degraded),
    degraded_reasons: (row.degraded_reasons as BriefingSnapshot['degraded_reasons']) ?? [],
    missed_deadline: Boolean(row.missed_deadline),
    window_start: (row.window_start as string) ?? null,
    window_end: (row.window_end as string) ?? null,
    snapshot_cutoff: (row.snapshot_cutoff as string) ?? null,
    policy_version: (row.policy_version as number) ?? null,
    published_ui_at: (row.published_ui_at as string) ?? null,
    persons: (row.persons as string[]) ?? ['scott'],
    sections,
    body_text: (body.body_text as string) ?? '',
    counts: (body.counts as Record<string, number>) ?? {},
    labels: (body.labels as Record<string, string>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Person filtering
//
// Slice 1 renders Scott's view only; Raquel and Angelic are OS-04b. The data model is
// person-aware from day one so that adding them is a filter change, not a rewrite — and
// so nobody is tempted to ship a second composer in the meantime.
// ---------------------------------------------------------------------------

export function isPersonPermitted(snapshot: BriefingSnapshot, person: string): boolean {
  return snapshot.persons.includes(person);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function fetchFromSupabase(
  businessDate: string,
  warnings: string[],
): Promise<Record<string, unknown> | null> {
  if (!SUPA_URL || !SUPA_KEY) {
    warnings.push('Supabase is not configured for this dashboard');
    return null;
  }
  const url =
    `${SUPA_URL}/rest/v1/briefing_snapshots` +
    `?business_date=eq.${encodeURIComponent(businessDate)}` +
    `&state=in.(published_ui,notification_pending,notification_delivered,notification_failed)` +
    `&order=version.desc&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    warnings.push(`Supabase returned ${res.status} — falling back to the local snapshot`);
    return null;
  }
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

/**
 * Read the local fallback file uhsJARVIS wrote while Supabase was down. Highest version
 * for the date wins.
 */
export function readLocalFallback(
  businessDate: string,
  warnings: string[],
): Record<string, unknown> | null {
  const dir = path.join(JARVIS_ROOT, 'output', businessDate);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `briefing-snapshot-${businessDate}-v`;
  const candidates = names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    .map((n) => ({ name: n, version: Number(n.slice(prefix.length, -'.json'.length)) }))
    .filter((c) => Number.isFinite(c.version))
    .sort((a, b) => b.version - a.version);
  if (candidates.length === 0) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, candidates[0].name), 'utf8');
    warnings.push(
      'Serving a local fallback snapshot — it was written while Supabase was unreachable',
    );
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    warnings.push(`local fallback snapshot is unreadable: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The one read used by both the API route and the page.
 *
 * `businessDate` is a local Pacific business date (YYYY-MM-DD). No date substitution:
 * asking for a date with no snapshot returns origin 'none', not yesterday's briefing.
 */
export async function getBriefingSnapshot(
  businessDate: string,
  person = 'scott',
): Promise<BriefingResult> {
  const warnings: string[] = [];
  let origin: BriefingResult['origin'] = 'none';
  let row: Record<string, unknown> | null = null;

  try {
    row = await fetchFromSupabase(businessDate, warnings);
    if (row) origin = 'supabase';
  } catch (e) {
    warnings.push(`Supabase unreachable: ${(e as Error).message}`);
  }

  if (!row) {
    row = readLocalFallback(businessDate, warnings);
    if (row) origin = 'local_fallback';
  }

  if (!row) {
    return { snapshot: null, origin: 'none', warnings, requestedDate: businessDate };
  }

  const snapshot = rowToSnapshot(row, warnings);
  if (!isPersonPermitted(snapshot, person)) {
    warnings.push(
      `this snapshot carries no facet for "${person}" — person views other than Scott land in OS-04b`,
    );
    return { snapshot: null, origin, warnings, requestedDate: businessDate };
  }
  return { snapshot, origin, warnings, requestedDate: businessDate };
}

/** Today's business date in the policy timezone. */
export function currentBusinessDate(now: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD, which is exactly the business-date shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * How stale is this snapshot? Used for the freshness banner. Returns minutes since the
 * snapshot's cutoff, which is when the data in it was actually read.
 */
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
