// cortextOS Dashboard - source health envelope (OS-01)
//
// Plan section 5: every source fetch returns
// {data, source, fetched_at, source_updated_at, stale_after, status, error}.
//
// The rule this enforces: a source that is unavailable must never render as an
// all-clear. Before this, a thrown query returned an empty array and the Queue
// happily said "nothing needs your attention" — indistinguishable from a
// genuinely empty queue. Now the caller gets a status, the last-good rows, and
// a banner.

import { db } from '@/lib/db';

export type SourceStatus = 'fresh' | 'stale' | 'unavailable' | 'partial';

export interface SourceEnvelope<T> {
  data: T;
  source: string;
  fetched_at: string;
  /** Newest updated_at observed in the source, when the source exposes one. */
  source_updated_at: string | null;
  /** Seconds after fetched_at at which this snapshot stops being trustworthy. */
  stale_after: number;
  status: SourceStatus;
  error: string | null;
  /** Last time this source enumerated successfully, when known. */
  last_good_at?: string | null;
}

/** The sync runs every 5 minutes; three missed cycles is no longer "fresh". */
export const DEFAULT_STALE_AFTER_SECONDS = 900;

export function envelope<T>(
  data: T,
  source: string,
  overrides: Partial<Omit<SourceEnvelope<T>, 'data' | 'source'>> = {},
): SourceEnvelope<T> {
  return {
    data,
    source,
    fetched_at: new Date().toISOString(),
    source_updated_at: null,
    stale_after: DEFAULT_STALE_AFTER_SECONDS,
    status: 'fresh',
    error: null,
    last_good_at: null,
    ...overrides,
  };
}

/** Envelope for a source that could not be read. Carries whatever last-good
 *  rows the caller still holds, explicitly marked unavailable. */
export function unavailable<T>(data: T, source: string, error: unknown): SourceEnvelope<T> {
  return envelope(data, source, {
    status: 'unavailable',
    error: error instanceof Error ? error.message : String(error),
  });
}

/** An envelope is degraded when its status is not fresh, or when its snapshot
 *  has aged past stale_after. */
export function isDegraded(env: Pick<SourceEnvelope<unknown>, 'status' | 'fetched_at' | 'stale_after'>): boolean {
  if (env.status !== 'fresh') return true;
  const age = (Date.now() - new Date(env.fetched_at).getTime()) / 1000;
  return Number.isFinite(age) && age > env.stale_after;
}

export interface SourceHealthRow {
  source: string;
  status: SourceStatus;
  fetched_at: string | null;
  source_updated_at: string | null;
  stale_after_seconds: number | null;
  last_good_at: string | null;
  row_count: number | null;
  error: string | null;
}

/**
 * Read the source_health table the Python projector writes. This is how the
 * dashboard learns that a sync it does not run itself came back degraded.
 */
export function getSourceHealth(): SourceHealthRow[] {
  try {
    return db
      .prepare(
        `SELECT source, status, fetched_at, source_updated_at, stale_after_seconds,
                last_good_at, row_count, error
         FROM source_health ORDER BY source`,
      )
      .all() as SourceHealthRow[];
  } catch (err) {
    console.error('[data/source-health] getSourceHealth error:', err);
    // Not knowing the health of the sources is itself a degraded state, and it
    // must not read as "every source is fine".
    return [
      {
        source: 'source_health',
        status: 'unavailable',
        fetched_at: new Date().toISOString(),
        source_updated_at: null,
        stale_after_seconds: DEFAULT_STALE_AFTER_SECONDS,
        last_good_at: null,
        row_count: null,
        error: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

/** Write one source-health row. Mirrors record_source_health() in the Python
 *  sync, including its rule that a non-fresh result never clears last_good_at. */
export function recordSourceHealth(
  source: string,
  status: SourceStatus,
  opts: {
    rowCount?: number | null;
    sourceUpdatedAt?: string | null;
    error?: string | null;
    staleAfterSeconds?: number;
  } = {},
): void {
  const now = new Date().toISOString();
  try {
    const prior = db
      .prepare('SELECT last_good_at, source_updated_at, row_count FROM source_health WHERE source = ?')
      .get(source) as { last_good_at: string | null; source_updated_at: string | null; row_count: number | null } | undefined;

    const lastGood = status === 'fresh' ? now : (prior?.last_good_at ?? null);
    const sourceUpdatedAt =
      status === 'fresh'
        ? (opts.sourceUpdatedAt ?? null)
        : (opts.sourceUpdatedAt ?? prior?.source_updated_at ?? null);
    const rowCount =
      status === 'fresh'
        ? (opts.rowCount ?? null)
        : (opts.rowCount ?? prior?.row_count ?? null);

    db.prepare(
      `INSERT INTO source_health
         (source, status, fetched_at, source_updated_at, stale_after_seconds, last_good_at, row_count, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         status=excluded.status, fetched_at=excluded.fetched_at,
         source_updated_at=excluded.source_updated_at,
         stale_after_seconds=excluded.stale_after_seconds,
         last_good_at=excluded.last_good_at, row_count=excluded.row_count,
         error=excluded.error`,
    ).run(
      source,
      status,
      now,
      sourceUpdatedAt,
      opts.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS,
      lastGood,
      rowCount,
      opts.error ?? null,
    );
  } catch (err) {
    console.error('[data/source-health] recordSourceHealth error:', err);
  }
}
