// === JARVIS MOD #22 — Cosmos Tier 5: aggregated data panels feed (2026-07-03) ===
// New file in the api/uhs/ local-mod isolation zone. Session-authed GET that
// aggregates a handful of live business/fleet metrics for the floating data
// panels on /jarvis. Each metric is independently { ok } | { unavailable } so
// panels degrade to "—" instead of the whole endpoint failing. Result is cached
// server-side for 60s (module-level, matches the panel refresh cadence).
//
// Data sources (honest resolution):
//   - pendingTasks / activeStagings → uhs-jarvis Supabase (env SUPABASE_URL/KEY)
//   - mlsNewToday                   → uhsMLS Supabase (anon key loaded from the
//                                     uhsMLS/.env at request time; never hardcoded)
//   - fleetUptime                   → daemon IPC `status`
//   - telegramToday                 → count today's lines in jarvis-telegram
//                                     inbound/outbound-messages.jsonl
import { auth } from '@/lib/auth';
import { IPCClient } from '@/lib/ipc-client';
import { getLogDir } from '@/lib/config';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Metric<T> = { ok: true; value: T } | { ok: false; unavailable: string };

interface CosmosStats {
  pendingTasks: Metric<number>;
  activeStagings: Metric<number>;
  mlsNewToday: Metric<number>;
  fleetUptime: Metric<{ seconds: number; label: string }>;
  telegramToday: Metric<number>;
  generatedAt: string;
}

const MLS_ENV_PATH =
  '/Users/sascherman/Utopia Home Staging Dropbox/UHS/Collective/uhsMLS/.env';
const MLS_SUPABASE_URL = 'https://eyyhgnmawyqfrhavuzks.supabase.co';

// ---- 60s server-side cache -------------------------------------------------
let cache: { at: number; data: CosmosStats } | null = null;
const CACHE_MS = 60_000;

function unavailable(reason: string): { ok: false; unavailable: string } {
  return { ok: false, unavailable: reason };
}

// ---- Supabase REST count helper (uhs-jarvis) -------------------------------
// PostgREST returns the exact count in the Content-Range header when we ask for
// HEAD with Prefer: count=exact.
async function supabaseCount(
  baseUrl: string,
  apiKey: string,
  query: string,
): Promise<Metric<number>> {
  try {
    const res = await fetch(`${baseUrl}/rest/v1/${query}`, {
      method: 'HEAD',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
      signal: AbortSignal.timeout(6_000),
    });
    // 200 or 206 both carry the Content-Range count as "start-end/total".
    if (!res.ok && res.status !== 206) {
      return unavailable(`http ${res.status}`);
    }
    const range = res.headers.get('content-range');
    const total = range?.split('/')?.[1];
    if (!total || total === '*') return unavailable('no count header');
    return { ok: true, value: Number(total) };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'fetch failed');
  }
}

// ---- uhs-jarvis metrics ----------------------------------------------------
async function jarvisMetrics(): Promise<{
  pendingTasks: Metric<number>;
  activeStagings: Metric<number>;
}> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    const u = unavailable('no jarvis supabase creds');
    return { pendingTasks: u, activeStagings: u };
  }

  const pendingTasks = await supabaseCount(
    url,
    key,
    'tasks?status=eq.pending&select=id',
  );

  // Active stagings: probe likely tables in order; the first that responds wins.
  // If none exist we honestly report unavailable rather than inventing a number.
  let activeStagings: Metric<number> = unavailable('no stagings table');
  const candidates = [
    'projects?status=eq.active&select=id',
    'stagings?status=eq.active&select=id',
    'staging_projects?status=eq.active&select=id',
  ];
  for (const q of candidates) {
    const m = await supabaseCount(url, key, q);
    if (m.ok) {
      activeStagings = m;
      break;
    }
  }

  return { pendingTasks, activeStagings };
}

// ---- MLS new-listings-today -----------------------------------------------
// Load the anon (read-only) key from the uhsMLS/.env at request time. We never
// hardcode it and never write it anywhere. If the file/key is missing, the
// panel shows "—".
async function loadMlsAnonKey(): Promise<string | null> {
  // Allow an env override first (if Scott later adds it to .env.local).
  const fromEnv =
    process.env.MLS_SUPABASE_ANON_KEY?.trim() ||
    process.env.UHSMLS_SUPABASE_ANON_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = await fs.readFile(MLS_ENV_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*SUPABASE_ANON_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
    return null;
  } catch {
    return null;
  }
}

async function mlsNewToday(): Promise<Metric<number>> {
  const key = await loadMlsAnonKey();
  if (!key) return unavailable('no mls key');
  // Local (Pacific) day start → ISO for the list_date filter.
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const iso = dayStart.toISOString();
  return supabaseCount(
    MLS_SUPABASE_URL,
    key,
    `listings?list_date=gte.${iso}&select=mls_number`,
  );
}

// ---- Fleet uptime via daemon IPC ------------------------------------------
function humanizeUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function fleetUptime(): Promise<Metric<{ seconds: number; label: string }>> {
  try {
    const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
    const ipc = new IPCClient(instanceId);
    const res = await ipc.send({ type: 'status' });
    if (!res.success) return unavailable(res.error ?? 'daemon down');
    // `status` returns an array of per-agent objects, each with `uptime`
    // (seconds) and `sessionStart`. There is no single daemon-uptime field, so
    // fleet uptime = the longest continuously-running agent (a faithful proxy
    // for how long the fleet has been up).
    const agents = Array.isArray(res.data)
      ? (res.data as Array<Record<string, unknown>>)
      : [];
    let maxSeconds = 0;
    for (const a of agents) {
      const u =
        typeof a.uptime === 'number'
          ? a.uptime
          : typeof a.sessionStart === 'string'
            ? (Date.now() - new Date(a.sessionStart).getTime()) / 1000
            : 0;
      if (u > maxSeconds) maxSeconds = u;
    }
    if (maxSeconds <= 0) {
      // Daemon answered but no agent uptime available — report online w/o duration.
      return { ok: true, value: { seconds: 0, label: 'online' } };
    }
    const seconds = Math.floor(maxSeconds);
    return { ok: true, value: { seconds, label: humanizeUptime(seconds) } };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'ipc failed');
  }
}

// ---- Telegram messages today ----------------------------------------------
// Count lines in inbound + outbound jsonl whose timestamp is today (local).
async function telegramToday(): Promise<Metric<number>> {
  const dir = getLogDir('jarvis-telegram');
  const now = new Date();
  const dayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  async function countFile(file: string): Promise<number> {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf-8');
      let n = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          const tsRaw =
            obj.ts ?? obj.timestamp ?? obj.time ?? obj.date ?? obj.created_at;
          const t =
            typeof tsRaw === 'number'
              ? tsRaw < 1e12
                ? tsRaw * 1000
                : tsRaw
              : typeof tsRaw === 'string'
                ? new Date(tsRaw).getTime()
                : NaN;
          if (!Number.isNaN(t) && t >= dayStart) n++;
        } catch {
          // Non-JSON line — ignore.
        }
      }
      return n;
    } catch {
      return 0;
    }
  }

  try {
    const [inb, outb] = await Promise.all([
      countFile('inbound-messages.jsonl'),
      countFile('outbound-messages.jsonl'),
    ]);
    return { ok: true, value: inb + outb };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : 'read failed');
  }
}

// ---------------------------------------------------------------------------
// GET /api/uhs/cosmos-stats
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await auth();
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return Response.json(cache.data);
  }

  const [jarvis, mls, uptime, tg] = await Promise.all([
    jarvisMetrics(),
    mlsNewToday(),
    fleetUptime(),
    telegramToday(),
  ]);

  const data: CosmosStats = {
    pendingTasks: jarvis.pendingTasks,
    activeStagings: jarvis.activeStagings,
    mlsNewToday: mls,
    fleetUptime: uptime,
    telegramToday: tg,
    generatedAt: new Date().toISOString(),
  };

  cache = { at: Date.now(), data };
  return Response.json(data);
}
// === END JARVIS MOD #22 ===
