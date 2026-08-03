// === JARVIS MOD #95 — /api/uhs/celebrations (2026-08-03) ===
// New file in the api/uhs/ local-mod isolation zone. Two lanes:
//
//   GET  — runs the detector on a 60s floor and returns the recent celebration
//          feed (server-assigned ids) so a reconnecting client can replay what
//          it missed.
//   POST — the deliberate lane. Session-authed, so Scott or an agent (a
//          Telegram flow, say) can fire a celebration on purpose.
//
// House rule, enforced here rather than trusted to callers: a PRODUCTION
// celebration must be backed by a real record. POST therefore takes a
// projectId, reads it back from uhsEstimate, and derives label + amount from
// the row — a client cannot post an address and a dollar figure and have the
// UI assert them. The only way to get free-form text on screen is `test:true`,
// which stamps the event so the UI renders a TEST badge.
//
// All pure logic (tiers, diffing, pruning, replay) lives in
// @/lib/uhs/celebration and is unit-tested; this file does auth, fetch, fs and
// serialization only.
import { auth } from '@/lib/auth';
import { getAgentStateDir } from '@/lib/config';
import {
  appendManual,
  CELEBRATION_COLUMNS,
  detect,
  emptyState,
  parseAmount,
  parseState,
  tierFor,
  wonStatusFilter,
  type CelebrationEvent,
  type CelebrationState,
  type ProjectRow,
} from '@/lib/uhs/celebration';
import { isOpenContract } from '@/lib/uhs/staging-status';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** State lives with the other agent runtime state, NOT in the repo. */
const STATE_DIR = () => getAgentStateDir('dashboard');
const STATE_FILE = () => path.join(STATE_DIR(), 'celebrations.json');

/** Detector poll floor. Several open tabs must not multiply the Supabase reads. */
const POLL_MIN_MS = 60_000;

let lastRunAt = 0;
/**
 * Serialize every state mutation. Two tabs hitting GET in the same tick would
 * otherwise both read the pre-detect state and the second write would clobber
 * the first — re-firing an already-fired celebration on the next poll.
 */
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readState(): Promise<CelebrationState> {
  try {
    return parseState(JSON.parse(await fs.readFile(STATE_FILE(), 'utf-8')));
  } catch {
    // Missing or corrupt. parseState(undefined) returns an UNSEEDED state, so
    // the next detect() seeds a fresh baseline and fires nothing — losing the
    // file costs us one missed celebration, never a burst of false ones.
    return emptyState();
  }
}

async function writeState(state: CelebrationState): Promise<void> {
  await fs.mkdir(STATE_DIR(), { recursive: true });
  const tmp = `${STATE_FILE()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tmp, STATE_FILE());
}

interface FetchResult {
  rows: ProjectRow[] | null;
  reason?: string;
}

/** Read the open-contract set from uhsEstimate. Null rows = do not diff. */
async function fetchOpenProjects(): Promise<FetchResult> {
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) return { rows: null, reason: 'uhsEstimate credentials not configured' };

  const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
  endpoint.searchParams.set('select', CELEBRATION_COLUMNS);
  endpoint.searchParams.set('status', wonStatusFilter());

  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { rows: null, reason: `uhsEstimate returned ${res.status}` };
    const rows = (await res.json()) as ProjectRow[];
    if (!Array.isArray(rows)) return { rows: null, reason: 'unexpected uhsEstimate payload' };
    return { rows };
  } catch (err) {
    return { rows: null, reason: err instanceof Error ? err.message : 'uhsEstimate unreachable' };
  }
}

async function fetchProject(projectId: string): Promise<ProjectRow | null> {
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) return null;
  const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
  endpoint.searchParams.set('select', CELEBRATION_COLUMNS);
  endpoint.searchParams.set('id', `eq.${projectId}`);
  endpoint.searchParams.set('limit', '1');
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as ProjectRow[];
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

interface FeedResponse {
  events: CelebrationEvent[];
  /** Null until the detector has taken its baseline reading. */
  seededAt: string | null;
  /** Present when the detector could not read the source this cycle. */
  detectorUnavailable?: string;
}

export async function GET() {
  const session = await auth();
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await withLock<FeedResponse>(async () => {
    const state = await readState();

    if (Date.now() - lastRunAt < POLL_MIN_MS) {
      return { events: state.events, seededAt: state.seededAt };
    }

    const { rows, reason } = await fetchOpenProjects();
    if (!rows) {
      // Do NOT advance the cursor on a failed read. Diffing against an empty
      // result would record "nothing is open", and the next successful poll
      // would then read every live contract as a brand-new win.
      lastRunAt = Date.now();
      return { events: state.events, seededAt: state.seededAt, detectorUnavailable: reason };
    }

    const result = detect(state, rows);
    lastRunAt = Date.now();
    if (result.fired.length || result.seeded || result.state.events.length !== state.events.length) {
      await writeState(result.state);
    }
    return { events: result.state.events, seededAt: result.state.seededAt };
  });

  return Response.json(body);
}

interface CelebrateBody {
  projectId?: string;
  label?: string;
  amount?: number | null;
  test?: boolean;
}

/**
 * Fire a celebration deliberately.
 *
 *   { "projectId": "<uuid>" }                       → production event, label
 *                                                     and amount read back from
 *                                                     the record
 *   { "test": true, "label": "…", "amount": 12000 } → TEST event, badged in the
 *                                                     UI, free-form text allowed
 *
 * A production event without a resolvable open project is refused rather than
 * rendered — a celebration asserts that a contract was won, and this endpoint
 * will not let anything assert that on its own say-so.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: CelebrateBody;
  try {
    body = (await request.json()) as CelebrateBody;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const isTest = body.test === true;
  let label: string;
  let amount: number | null;
  let projectId: string | null = body.projectId?.trim() || null;

  if (!isTest) {
    if (!projectId) {
      return Response.json(
        { error: 'projectId is required for a production celebration (or pass test:true)' },
        { status: 400 },
      );
    }
    const project = await fetchProject(projectId);
    if (!project) {
      return Response.json({ error: `No uhsEstimate project ${projectId}` }, { status: 404 });
    }
    if (!isOpenContract({ status: project.status })) {
      return Response.json(
        { error: `Project ${projectId} is ${project.status ?? 'unknown'}, not an open contract` },
        { status: 409 },
      );
    }
    label = (project.property_address ?? '').trim() || 'New contract';
    amount = parseAmount(project.staging_price);
  } else {
    label = (body.label ?? '').trim() || 'Test contract';
    amount = typeof body.amount === 'number' ? parseAmount(body.amount) : null;
    projectId = projectId ?? null;
  }

  const event = await withLock(async () => {
    const state = await readState();
    const { state: next, event } = appendManual(state, {
      kind: 'contract_won',
      projectId,
      label,
      amount,
      tier: tierFor(amount),
      ...(isTest ? { test: true } : {}),
    });
    await writeState(next);
    return event;
  });

  return Response.json({ ok: true, event });
}
// === END JARVIS MOD #95 ===
