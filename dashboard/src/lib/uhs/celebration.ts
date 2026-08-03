// === JARVIS MOD #94 — revenue celebration: event model + tiers (2026-08-03) ===
// New file. Pure logic for Trillion rubric item 14 ("emotional moments —
// revenue celebration scaled to amount, replay-on-reconnect"), which scored
// 0/10 because nothing existed. TODO.md line 39 has wanted a "deal-won
// supernova" for a while; this is it.
//
// EVENT SOURCE (probed live 2026-08-03, not guessed):
//   uhsEstimate Supabase `projects` — 391 rows. Status distribution at probe
//   time: COMPLETE 319, DESTAGED 41, STAGED 16, CANCELLED 4, NOTICE_GIVEN 4,
//   CONTRACTED 3, INQUIRY 2, MISC 1, SOLD 1. Every open row carries a real
//   `staging_price` (3375 … 19855) and a `property_address`, so amount + label
//   both come from the record — nothing is invented.
//
// WHY A SNAPSHOT DIFF AND NOT A TIMESTAMP CURSOR:
//   `updated_at` is live but it is NOT a win signal. The same probe showed two
//   rows re-stamped 11 seconds apart (13:44:28 / 13:44:39) by a sync job, and
//   a NOTICE_GIVEN row — the opposite of a win — carrying the newest timestamp
//   in the whole table. A "rows updated since T" cursor would therefore fire
//   celebrations for routine sync churn and for terminations. The trigger is a
//   TRANSITION: a project that was not in the open-contract set on the previous
//   poll and is now. That is a genuine business event (contract signed) and it
//   cannot be produced by touching a row.
//
// "Open contract" is deliberately NOT redefined here — it is imported from
// staging-status.ts, the one definition every surface already shares.

import { isOpenContract, OPEN_CONTRACT_STATUSES } from './staging-status';

// --- Tiers -----------------------------------------------------------------
// Scaled to the amount, against real UHS pricing (memory: minimum $2500 vacant
// / $5000 occupied). So <$3k is a small job, $3k–$8k is the bread-and-butter
// band, and >$8k is genuinely a big one — the probe's 19855 and 10000 rows are
// exactly the deals that deserve the supernova.
export type CelebrationTier = 'shimmer' | 'burst' | 'supernova';

export const TIER_BURST_MIN = 3000;
export const TIER_SUPERNOVA_MIN = 8000;

/**
 * Amount → tier.
 *
 * A null amount is NOT treated as zero (house rule: unknown is not zero). A
 * signed contract whose price has not been entered yet still deserves a
 * celebration; it gets the smallest one and the UI prints "amount pending"
 * rather than "$0", because $0 would be a false claim about a real deal.
 */
export function tierFor(amount: number | null | undefined): CelebrationTier {
  if (amount == null || !Number.isFinite(amount)) return 'shimmer';
  if (amount > TIER_SUPERNOVA_MIN) return 'supernova';
  if (amount >= TIER_BURST_MIN) return 'burst';
  return 'shimmer';
}

/** Whole dollars, no cents — these are contract prices, never fractional. */
export function formatAmount(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return 'amount pending';
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

// --- Event model -----------------------------------------------------------

export interface CelebrationEvent {
  /** Server-assigned, stable, never reused. Client replay dedupes on `seq`. */
  id: string;
  /** Monotonic across restarts (persisted in the state file). */
  seq: number;
  /** ISO timestamp the server observed the transition. */
  at: string;
  kind: 'contract_won';
  /** The uhsEstimate project this came from. Null only for a test event. */
  projectId: string | null;
  /** Property address, straight off the record. */
  label: string;
  /** staging_price, or null when the record has none yet. */
  amount: number | null;
  tier: CelebrationTier;
  /** How it was produced. 'manual' = someone fired the POST deliberately. */
  source: 'detector' | 'manual';
  /** True for a non-production event. The UI renders a TEST badge. */
  test?: boolean;
}

/** The subset of `projects` the detector reads. */
export interface ProjectRow {
  id: string;
  property_address?: string | null;
  status?: string | null;
  staging_price?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** PostgREST select list for the detector read. */
export const CELEBRATION_COLUMNS =
  'id,property_address,status,staging_price,created_at,updated_at';

/** PostgREST filter for the won set. */
export function wonStatusFilter(): string {
  return `in.(${OPEN_CONTRACT_STATUSES.join(',')})`;
}

/** staging_price arrives as a number or a numeric string depending on the column type. */
export function parseAmount(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// --- Detector state --------------------------------------------------------

export interface CelebrationState {
  version: 1;
  /** Set on the very first poll. Its presence is what says "already seeded". */
  seededAt: string | null;
  /** Next event sequence number. Persisted so ids never repeat after a restart. */
  seq: number;
  /** Project ids currently in the open-contract set (the previous snapshot). */
  won: string[];
  /** Every project id ever celebrated — the hard no-double-fire guarantee. */
  celebrated: string[];
  /** Recent events served to clients. Pruned to RETENTION_DAYS. */
  events: CelebrationEvent[];
}

export const RETENTION_DAYS = 7;
/** Ceiling on the celebrated list so it cannot grow without bound. ~4 wins/mo. */
export const CELEBRATED_CAP = 2000;

export function emptyState(): CelebrationState {
  return { version: 1, seededAt: null, seq: 1, won: [], celebrated: [], events: [] };
}

/** Tolerant read of whatever is on disk — a corrupt file must not crash the route. */
export function parseState(raw: unknown): CelebrationState {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Partial<CelebrationState>;
  return {
    version: 1,
    seededAt: typeof o.seededAt === 'string' ? o.seededAt : null,
    seq: typeof o.seq === 'number' && o.seq >= 1 ? Math.floor(o.seq) : 1,
    won: Array.isArray(o.won) ? o.won.filter((x): x is string => typeof x === 'string') : [],
    celebrated: Array.isArray(o.celebrated)
      ? o.celebrated.filter((x): x is string => typeof x === 'string')
      : [],
    events: Array.isArray(o.events) ? (o.events.filter(isEventish) as CelebrationEvent[]) : [],
  };
}

function isEventish(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as Partial<CelebrationEvent>;
  return typeof o.id === 'string' && typeof o.seq === 'number' && typeof o.at === 'string';
}

export interface DetectResult {
  state: CelebrationState;
  /** Events created by THIS poll (empty on a seeding run, and usually empty). */
  fired: CelebrationEvent[];
  /** True when this poll seeded the baseline instead of detecting. */
  seeded: boolean;
}

/**
 * Diff the live open-contract set against the previous snapshot.
 *
 * FIRST RUN SEEDS, IT DOES NOT FIRE. Without this, the first poll after a
 * deploy would see 23 open contracts it has never recorded and throw 23
 * celebrations for deals signed months ago. Seeding records the baseline and
 * emits nothing — the first real celebration is the next genuine transition.
 *
 * A project that leaves the set (DESTAGED) and somehow re-enters does not
 * re-fire, because `celebrated` is checked independently of `won`. Repeat
 * business is a NEW project row (memory: contract↔project is strictly 1:1), so
 * it gets its own id and its own celebration.
 */
export function detect(
  prev: CelebrationState,
  rows: ProjectRow[],
  now: Date = new Date(),
): DetectResult {
  const open = rows.filter((r) => r.id && isOpenContract({ status: r.status }));
  const currentIds = open.map((r) => r.id);

  if (!prev.seededAt) {
    return {
      state: {
        ...prev,
        seededAt: now.toISOString(),
        won: currentIds,
        celebrated: capList([...prev.celebrated, ...currentIds], CELEBRATED_CAP),
        events: [],
      },
      fired: [],
      seeded: true,
    };
  }

  const prevWon = new Set(prev.won);
  const everCelebrated = new Set(prev.celebrated);
  const fired: CelebrationEvent[] = [];
  let seq = prev.seq;

  for (const row of open) {
    if (prevWon.has(row.id) || everCelebrated.has(row.id)) continue;
    const amount = parseAmount(row.staging_price);
    fired.push({
      id: `cel-${seq}`,
      seq,
      at: now.toISOString(),
      kind: 'contract_won',
      projectId: row.id,
      label: (row.property_address ?? '').trim() || 'New contract',
      amount,
      tier: tierFor(amount),
      source: 'detector',
    });
    seq += 1;
  }

  return {
    state: {
      ...prev,
      seq,
      won: currentIds,
      celebrated: capList([...prev.celebrated, ...fired.map((e) => e.projectId!)], CELEBRATED_CAP),
      events: pruneEvents([...prev.events, ...fired], now),
    },
    fired,
    seeded: false,
  };
}

/** Append a deliberately-fired event (POST lane) with the same id sequence. */
export function appendManual(
  prev: CelebrationState,
  event: Omit<CelebrationEvent, 'id' | 'seq' | 'at' | 'source'> & { at?: string },
  now: Date = new Date(),
): { state: CelebrationState; event: CelebrationEvent } {
  const full: CelebrationEvent = {
    ...event,
    id: `cel-${prev.seq}`,
    seq: prev.seq,
    at: event.at ?? now.toISOString(),
    source: 'manual',
  };
  return {
    state: {
      ...prev,
      seq: prev.seq + 1,
      events: pruneEvents([...prev.events, full], now),
      // A manual event does NOT touch `celebrated`: that list is the detector's
      // no-double-fire ledger, and marking a project celebrated by hand would
      // silently suppress the real transition when it arrives.
    },
    event: full,
  };
}

/** Drop anything older than the retention window. */
export function pruneEvents(events: CelebrationEvent[], now: Date = new Date()): CelebrationEvent[] {
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  return events
    .filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) ? t >= cutoff : false;
    })
    .sort((a, b) => a.seq - b.seq);
}

function capList(ids: string[], cap: number): string[] {
  const unique = Array.from(new Set(ids));
  return unique.length <= cap ? unique : unique.slice(unique.length - cap);
}

// --- Replay ----------------------------------------------------------------

export const MAX_REPLAY = 3;

export interface ReplayPlan {
  /** Events to actually play, oldest first. */
  play: CelebrationEvent[];
  /** How many unseen events were dropped by the cap (surfaced in the card). */
  skipped: number;
  /** The seq the client should store afterwards — covers skipped ones too. */
  nextSeen: number;
}

/**
 * Pick which unseen events to replay when a client reconnects.
 *
 * The point of replay is that a sale landing while nobody is watching is never
 * silently missed. The point of the cap is that coming back from a week away
 * does not trigger a four-minute fireworks queue: the newest MAX_REPLAY play,
 * and the count of the rest is stated rather than dropped in silence.
 *
 * `nextSeen` advances past the skipped events deliberately — replaying them on
 * the NEXT reconnect would be showing the same news twice.
 */
export function planReplay(
  events: CelebrationEvent[],
  lastSeenSeq: number,
  max: number = MAX_REPLAY,
): ReplayPlan {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const highest = ordered.length ? ordered[ordered.length - 1].seq : lastSeenSeq;

  // The server's sequence restarts at 1 if its state file is ever lost. A
  // client holding lastSeen=20 would then filter out every real celebration
  // forever — a silent, permanent swallow, which is the exact failure this
  // feature exists to prevent. A feed whose newest event is BELOW our marker
  // can only mean the sequence was reset, so the marker is discarded.
  const rewound = ordered.length > 0 && highest < lastSeenSeq;
  const floor = rewound ? 0 : lastSeenSeq;
  const unseen = ordered.filter((e) => e.seq > floor);
  const nextSeen = rewound ? highest : Math.max(lastSeenSeq, highest);
  if (unseen.length <= max) {
    return { play: unseen, skipped: 0, nextSeen };
  }
  return { play: unseen.slice(unseen.length - max), skipped: unseen.length - max, nextSeen };
}
// === END JARVIS MOD #94 ===
