// === JARVIS MOD #52 — Realtime fast-lane tools ===
// New file. MOD #51 shipped ONE tool, ask_jarvis, which routes every question
// through the jarvis-telegram agent: correct (one brain, one truth) but slow —
// a full Claude Code PTY turn, 45s worst case, and the voice model is left
// saying "one moment, sir" into a long silence.
//
// The three questions Scott asks most often ("what's on the calendar", "when's
// the notice date on X", "are the agents up") are all ONE read away from data
// the dashboard can already reach. This module answers those directly, in the
// hundreds-of-milliseconds range, and everything else still falls through to
// ask_jarvis unchanged.
//
// Rules for anything added here:
//   - READ-ONLY. No writes, no sends, no side effects of any kind.
//   - Returns a compact SPOKEN string: numbers first, no markdown, no URLs.
//   - Degrades honestly. A missing credential returns "data unavailable" with
//     the reason — it never guesses, and never invents a plausible number.
//     (An invented calendar is worse than a slow one.)
// === END header ===

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAllHeartbeats, getHealthStatus } from '@/lib/data/heartbeats';
import { OPEN_CONTRACT_STATUSES, fetchStagingCounts } from '@/lib/uhs/staging-status';

/** Every fast lane returns this: the spoken text plus whether it had real data. */
export interface LaneResult {
  output: string;
  ok: boolean;
}

const unavailable = (what: string, why: string): LaneResult => ({
  ok: false,
  output: `${what} is unavailable right now — ${why}. Say so plainly and offer to try the full lookup.`,
});

// --- shared helpers ---------------------------------------------------------

/** Pacific-time parts for a Date — UHS runs on Las Vegas time, always. */
const PT = 'America/Los_Angeles';

export function ptDateKey(d: Date): string {
  // en-CA gives YYYY-MM-DD, which is what the Calendar API wants.
  return d.toLocaleDateString('en-CA', { timeZone: PT });
}

export function spokenTime(iso: string): string {
  const d = new Date(iso);
  return d
    .toLocaleTimeString('en-US', {
      timeZone: PT,
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(':00', '');
}

/**
 * Speak a date.
 *
 * Contract dates arrive as bare `YYYY-MM-DD`, which `new Date()` parses as
 * UTC midnight — which is the PREVIOUS evening in Pacific, so every date came
 * out one day early (caught live 2026-08-03: a contract stored as July 21 was
 * spoken as "July 20"). A calendar date has no time zone, so it must not be
 * shifted by one: bare dates are anchored at local noon, far from either
 * boundary. Full timestamps still convert to Pacific normally.
 */
export function spokenDate(iso: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  const d = new Date(dateOnly ? `${iso.trim()}T12:00:00` : iso);
  // === MOD #106b — say the YEAR when it isn't this one. A 2021 project spoken
  // as "removed November 13, paid through October 8" sounds like a live
  // contract with contradictory dates; with the years it is plainly history. ===
  const thisYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: PT }).slice(0, 4));
  const year = dateOnly ? Number(iso.trim().slice(0, 4)) : Number(
    d.toLocaleDateString('en-CA', { timeZone: PT }).slice(0, 4),
  );
  return d.toLocaleDateString('en-US', {
    ...(dateOnly ? {} : { timeZone: PT }),
    month: 'long',
    day: 'numeric',
    ...(year === thisYear ? {} : { year: 'numeric' }),
  });
}

/** Join a list the way a person says it: "a, b, and c". */
export function spokenList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// --- agent_status -----------------------------------------------------------
// Pure local filesystem read (heartbeat JSON per agent) — no network, no keys,
// so this lane cannot be "unavailable". Typically single-digit milliseconds.

export async function agentStatus(): Promise<LaneResult> {
  const beats = await getAllHeartbeats();
  if (beats.length === 0) {
    return unavailable('Fleet status', 'no agent heartbeats were found on disk');
  }

  const byHealth = beats.map((hb) => ({ name: hb.agent, health: getHealthStatus(hb), hb }));
  const healthy = byHealth.filter((a) => a.health === 'healthy');
  const stale = byHealth.filter((a) => a.health === 'stale');
  const down = byHealth.filter((a) => a.health === 'down');

  // Numbers first, then only the exceptions — a list of twelve healthy agent
  // names is unlistenable, and "all twelve are up" is the actual answer.
  let out = `${healthy.length} of ${beats.length} agents healthy.`;
  if (stale.length) out += ` Stale: ${spokenList(stale.map((a) => a.name))}.`;
  if (down.length) out += ` Down: ${spokenList(down.map((a) => a.name))}.`;
  if (!stale.length && !down.length) out += ' Whole fleet is up.';

  const working = byHealth.filter((a) => a.hb.current_task?.trim());
  if (working.length) {
    const first = working[0];
    out += ` ${first.name} is working on ${first.hb.current_task?.trim()}.`;
  }
  return { ok: true, output: out };
}

// --- calendar_today ---------------------------------------------------------
// Google Calendar v3 over plain fetch (no new npm package): a stored refresh
// token buys an access token, which reads the events list.
//
// Credentials are resolved AT REQUEST TIME from the files the existing
// google-calendar MCP already maintains — the same pattern fast-reply.ts uses
// for the Anthropic key, and the reason this lane needed no new env plumbing:
//   ~/.claude/google-calendar-oauth.json      → client_id / client_secret
//   ~/.config/google-calendar-mcp/tokens.json → uhs.refresh_token
// Both paths are env-overridable. Nothing is cached to disk and no secret is
// ever logged; only the short-lived access token is held in memory.

interface GCalEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** THE UHS calendar. Deliberately NOT 'primary': primary is Scott's personal
 *  calendar, and reading it would return a confident, wrong schedule rather
 *  than an obvious failure. Env-overridable, but never defaulted away. */
export const UHS_CALENDAR_ID =
  process.env.UHS_CALENDAR_ID?.trim() ||
  '82768c582aeb0d242a0b8a8486cd3df6f45add91543d211d86de55b09ab10985@group.calendar.google.com';

/** Which account key inside tokens.json holds the UHS grant. */
const GOOGLE_ACCOUNT_KEY = process.env.GOOGLE_OAUTH_ACCOUNT?.trim() || 'uhs';

function credentialsPath(): string {
  return (
    process.env.GOOGLE_OAUTH_CREDENTIALS?.trim() ||
    path.join(os.homedir(), '.claude', 'google-calendar-oauth.json')
  );
}

function tokensPath(): string {
  return (
    process.env.GOOGLE_OAUTH_TOKENS?.trim() ||
    path.join(os.homedir(), '.config', 'google-calendar-mcp', 'tokens.json')
  );
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** In-memory only, and re-minted a minute before expiry. Never written down. */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function googleAccessToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const creds = readJson<{
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  }>(credentialsPath());
  const app = creds?.installed ?? creds?.web;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || app?.client_id;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || app?.client_secret;

  const tokens = readJson<Record<string, { refresh_token?: string }>>(tokensPath());
  const refreshToken =
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || tokens?.[GOOGLE_ACCOUNT_KEY]?.refresh_token;

  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
  };
  return data.access_token;
}

/** Titles are written to be READ — emoji status markers, pipe-delimited codes,
 *  trailing detail in parens. Spoken verbatim they turn into noise, so strip to
 *  the part a person would actually say. */
export function spokenTitle(raw: string): string {
  return (
    raw
      // Emoji / pictographs / variation selectors — "✅ Blog Published" must not
      // become "white heavy check mark Blog Published".
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{2700}-\u{27BF}]/gu, ' ')
      .replace(/\s*\|\s*/g, ', ') // "CS - Boca Raton | Kim" → "CS - Boca Raton, Kim"
      // === MOD #106b — the rest of the title is written for a screen, not an
      // ear. Live: "Blog Scheduled — Week-32-Great-Listing-Photos (Posts Tue
      // Aug 11, final edits applied)" and "TS (III/—) - Turtle Head Peak Dr".
      // A slug read aloud is a stutter of hyphens and a room-count code in
      // parentheses is noise, so both go. ===
      .replace(/\(\s*[IVXivx]+\s*\/\s*[^)]*\)/g, ' ') // room-count codes: (III/—)
      .replace(/\((?=[^)]{0,60}\))[^)]*\)/g, ' ') // short parenthetical asides
      .replace(/[–—]/g, ' ') // en/em dashes
      .replace(/\b([A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,})\b/g, (slug) => slug.replace(/-/g, ' '))
      .replace(/\s+-\s+/g, ', ')
      .replace(/\s*,\s*,\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .trim() || 'Untitled'
  );
}

/** === JARVIS MOD #102 — an event belongs to a day it COVERS, not only the day
 *  it starts. All-day stagings routinely span several days (a CS placed July 31
 *  still occupies August 4), and the old start-date-only match dropped them —
 *  caught live 2026-08-03 when the voice said "zero events tomorrow" while two
 *  multi-day CS events covered tomorrow on the real calendar. All-day `end` is
 *  exclusive per the Calendar API. === */
export function eventCoversDay(e: GCalEvent, dayKey: string): boolean {
  if (e.start?.dateTime) return ptDateKey(new Date(e.start.dateTime)) === dayKey;
  const startDay = e.start?.date ?? '';
  if (!startDay) return false;
  const endDay = e.end?.date ?? startDay;
  return startDay <= dayKey && (dayKey < endDay || endDay === startDay);
}

function describeEvents(label: string, events: GCalEvent[]): string {
  if (events.length === 0) return `Nothing on the calendar ${label}.`;

  const timed = events.filter((e) => e.start?.dateTime);
  const allDay = events.filter((e) => !e.start?.dateTime);
  const CAP = 5;

  const chunks: string[] = [];
  if (timed.length) {
    chunks.push(
      spokenList(
        timed
          .slice(0, CAP)
          .map((e) => `${spokenTime(e.start!.dateTime!)}, ${spokenTitle(e.summary ?? '')}`),
      ),
    );
  }
  if (allDay.length) {
    // "all day" said once, not once per event.
    const names = spokenList(allDay.slice(0, CAP).map((e) => spokenTitle(e.summary ?? '')));
    chunks.push(`${timed.length ? 'and a' : 'A'}ll day: ${names}`);
  }
  const shown = Math.min(timed.length, CAP) + Math.min(allDay.length, CAP);
  const more = events.length > shown ? `, plus ${events.length - shown} more` : '';
  const noun = events.length === 1 ? 'event' : 'events';
  return `${events.length} ${noun} ${label}: ${chunks.join('; ')}${more}.`;
}

export async function calendarToday(): Promise<LaneResult> {
  const calendarId = UHS_CALENDAR_ID;
  let token: string | null;
  try {
    token = await googleAccessToken();
  } catch {
    token = null;
  }
  if (!token) {
    return unavailable('The calendar', 'Google authorization is not configured or the refresh token was rejected');
  }

  const now = new Date();
  const startOfToday = new Date(`${ptDateKey(now)}T00:00:00`);
  const endOfTomorrow = new Date(startOfToday.getTime() + 48 * 60 * 60 * 1000);

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  url.searchParams.set('timeMin', startOfToday.toISOString());
  url.searchParams.set('timeMax', endOfTomorrow.toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '25');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    return unavailable('The calendar', `Google returned status ${res.status}`);
  }
  const data = (await res.json()) as { items?: GCalEvent[] };
  const items = data.items ?? [];

  const todayKey = ptDateKey(now);
  const tomorrowKey = ptDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const today = items.filter((e) => eventCoversDay(e, todayKey));
  const tomorrow = items.filter((e) => eventCoversDay(e, tomorrowKey));

  return {
    ok: true,
    output: `${describeEvents('today', today)} ${describeEvents('tomorrow', tomorrow)}`.trim(),
  };
}

// --- active_stagings --------------------------------------------------------
// The count question, answered from the SAME predicate the Active Stagings tile
// uses. Before MOD #65 this question had no tool at all, so the fast path
// free-answered it and invented "five staged, two active" while the tile said
// 16 — the defect that motivated this lane.

export async function activeStagings(): Promise<LaneResult> {
  const counts = await fetchStagingCounts();
  if (!counts) {
    return unavailable('The staging count', 'the uhsEstimate database could not be reached');
  }
  let out = `${counts.activeStagings} active stagings — furniture in the home right now.`;
  // Say the gap rather than let two surfaces disagree by two and look broken.
  if (counts.awaitingInstall > 0) {
    out +=
      ` ${counts.openContracts} open contracts total, including ` +
      `${counts.awaitingInstall} signed but not yet installed.`;
  } else {
    out += ` ${counts.openContracts} open contracts total.`;
  }
  return { ok: true, output: out };
}

// --- staging_counts (MOD #104) ----------------------------------------------
// Date-range install counts. The 2026-08-04 demo (IMG_5108) sent "how many
// stages have we installed this year" down the 35s ask_jarvis path, argued
// about what "this year" meant, and finally spoke a confusing three-way split.
// Same source of truth as the tiles: the uhsEstimate `projects` table. An
// "install in range" is a project whose stage_date falls inside [from, to] and
// whose status is not a dead-end (CANCELLED / INQUIRY / MISC — a cancelled
// contract never got furniture; INQUIRY/MISC never were stagings).
const NEVER_STAGED_STATUSES = new Set(['CANCELLED', 'INQUIRY', 'MISC']);

export async function stagingCounts(fromArg?: string, toArg?: string): Promise<LaneResult> {
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) {
    return unavailable('The install count', 'the uhsEstimate database credentials are not configured');
  }

  const today = ptDateKey(new Date());
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = fromArg && iso.test(fromArg.trim()) ? fromArg.trim() : `${today.slice(0, 4)}-01-01`;
  const to = toArg && iso.test(toArg.trim()) ? toArg.trim() : today;
  if (from > to) {
    return { ok: false, output: `That range runs backwards (${from} to ${to}) — ask which dates they meant.` };
  }

  const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
  endpoint.searchParams.set('select', 'status,stage_date');
  // PostgREST ANDs repeated filters on the same column — append, never set
  // (set would overwrite the gte with the lte).
  endpoint.searchParams.append('stage_date', `gte.${from}`);
  endpoint.searchParams.append('stage_date', `lte.${to}`);
  const STAGING_FETCH_LIMIT = 1000;
  endpoint.searchParams.set('limit', String(STAGING_FETCH_LIMIT));

  let rows: Array<{ status?: string | null; stage_date?: string | null }>;
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) {
      return unavailable('The install count', `the projects table returned status ${res.status}`);
    }
    const body = (await res.json()) as typeof rows;
    if (!Array.isArray(body)) {
      return unavailable('The install count', 'the projects table returned an unexpected shape');
    }
    rows = body;
  } catch {
    return unavailable('The install count', 'the projects table could not be reached');
  }
  // MOD #106 (P2 guard, bestClient pattern): at the limit the count is computed
  // on a truncated set and would be spoken as fact. Refuse instead.
  if (rows.length >= STAGING_FETCH_LIMIT) {
    return unavailable(
      'The install count',
      'that range exceeds the single-read window and the count would be short',
    );
  }

  const staged = rows.filter(
    (r) => !NEVER_STAGED_STATUSES.has((r.status ?? '').toUpperCase()) && r.stage_date,
  );
  const installed = staged.filter((r) => (r.stage_date as string) <= today).length;
  const scheduled = staged.length - installed;

  const range = `${spokenDate(from)} through ${to === today ? 'today' : spokenDate(to)}`;
  let out = `${installed} install${installed === 1 ? '' : 's'} completed ${range}.`;
  if (scheduled > 0) out += ` ${scheduled} more on the books, not yet installed.`;
  return { ok: true, output: out };
}

// --- contract_stat ----------------------------------------------------------
// Open staging contracts by fuzzy agent name or property address, answering the
// three dates the /contract-stat skill answers: staging date, paid-through
// date, notice-to-terminate date.
//
// Direct PostgREST read against the JARVIS Supabase (SUPABASE_URL /
// SUPABASE_KEY, already in the dashboard env). Read-only: GET only, no writes.

export interface ContractContact {
  contact_name?: string | null;
  contact_type?: string | null;
}

export interface ContractRow {
  id?: string;
  property_address?: string | null;
  normalized_address?: string | null;
  status?: string | null;
  stage_date?: string | null;
  contract_end_date?: string | null;
  destage_date?: string | null;
  // === MOD #102 round 2 (critic findings): a NOTICE_GIVEN contract was being
  // spoken as if renewal were still an open question — these three fields are
  // what the lane needs to tell a settled termination from a live term. ===
  notice_given_date?: string | null;
  destage_start_date?: string | null;
  project_contacts?: ContractContact[] | null;
}

/** === JARVIS MOD #65 — status set now comes from the SHARED definition ===
 *  This lane used to carry its own four-status list, which omitted
 *  NOTICE_GIVEN and so hid the four homes whose dates people ask about most,
 *  while the Active Stagings tile used a different list again. Both surfaces
 *  now import from @/lib/uhs/staging-status so they cannot drift. */
export const OPEN_STATUSES = OPEN_CONTRACT_STATUSES;

/** §7.2 of the staging contract: notice is a minimum of 10 paid calendar days
 *  before the paid-through date. Derived, never stored — the skill computes it
 *  the same way, and the two must not be able to disagree. */
export const NOTICE_DAYS_BEFORE_END = 10;

/** Columns the lane reads, including the embedded contacts join. Explicit so a
 *  schema drift fails loudly instead of silently returning nulls. */
export const CONTRACT_SELECT =
  'id,property_address,normalized_address,status,stage_date,contract_end_date,destage_date,' +
  'notice_given_date,destage_start_date,' +
  'project_contacts(contact_name,contact_type)';

/** AGENTS.md rule 8: the listing agent and the property owner are different
 *  people. Only the listing agent is "the agent". */
export function listingAgent(row: ContractRow): string | null {
  const contacts = row.project_contacts ?? [];
  const agent = contacts.find((c) => (c.contact_type ?? '').toUpperCase() === 'LISTING_AGENT');
  return agent?.contact_name?.trim() || null;
}

export function noticeDate(contractEnd: string): string {
  const d = new Date(`${contractEnd}T12:00:00`); // noon avoids any DST edge
  d.setDate(d.getDate() - NOTICE_DAYS_BEFORE_END);
  return d.toISOString().slice(0, 10);
}

/** Rank candidates against the spoken query. Address digits are the strongest
 *  signal — "twenty-five seventy-two Sable Ridge" reliably yields "2572" — so
 *  they outweigh name tokens, which collide constantly across a 14k-agent MLS. */
export function scoreContract(row: ContractRow, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const addr = `${row.property_address ?? ''} ${row.normalized_address ?? ''}`.toLowerCase();
  const people = (row.project_contacts ?? [])
    .map((c) => (c.contact_name ?? '').toLowerCase())
    .join(' ');
  let score = 0;
  if (addr.includes(q)) score += 100;
  if (people.includes(q)) score += 100;

  for (const t of q.split(/\s+/).filter((t) => t.length > 2)) {
    if (addr.includes(t)) score += 12;
    if (people.includes(t)) score += 12;
  }
  for (const num of q.match(/\d{2,6}/g) ?? []) {
    if (addr.includes(num)) score += 40;
  }
  return score;
}

function spokenContract(row: ContractRow): string {
  const who = listingAgent(row);
  const where = row.property_address?.trim() || 'the property';
  const head = `${where}${who ? `, ${who}` : ''}`;
  const todayKey = ptDateKey(new Date());

  // === MOD #102 round 2 — a settled termination is a SETTLED decision. The
  // old guard only looked at destage_date, so all four live NOTICE_GIVEN
  // contracts (destage_date null, destage_start_date set) fell through to the
  // renewal branch and one was spoken as "it auto-renews" — flatly false. ===
  const noticeOnFile =
    (row.status ?? '').toUpperCase() === 'NOTICE_GIVEN' || !!row.notice_given_date;
  if (row.destage_date || noticeOnFile) {
    const removal = row.destage_date ?? row.destage_start_date;
    const given = row.notice_given_date
      ? `notice was given ${spokenDate(row.notice_given_date)}`
      : 'termination notice is on file';
    const out = removal
      ? `${head}: ${given}, removal scheduled around ${spokenDate(removal)}.`
      : `${head}: ${given}; the removal date is not set yet.`;
    return row.contract_end_date ? `${out} Paid through ${spokenDate(row.contract_end_date)}.` : out;
  }

  // Pre-install: the term starts the day after install, so the later dates do
  // not exist yet. Saying "no notice date" would read as a data problem; this
  // is the contract working as written.
  if (!row.contract_end_date) {
    const staged = row.stage_date
      ? `${row.stage_date > todayKey ? 'installs' : 'staged'} ${spokenDate(row.stage_date)}`
      : 'has no install date set';
    return `${head} ${staged}. Paid-through and notice dates are set once it's staged.`;
  }

  const notice = noticeDate(row.contract_end_date);
  const daysToNotice = Math.round(
    (new Date(`${notice}T12:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  const bits: string[] = [];
  // Round 2: a future stage_date was spoken past tense ("staged August 7"
  // about an install four days out).
  if (row.stage_date) {
    bits.push(`${row.stage_date > todayKey ? 'installs' : 'staged'} ${spokenDate(row.stage_date)}`);
  }
  bits.push(`paid through ${spokenDate(row.contract_end_date)}`);
  bits.push(`notice to terminate by ${spokenDate(notice)}`);

  let out = `${head}: ${spokenList(bits)}.`;
  // Round 2: a paid-through date in the PAST is stale data, not a live term —
  // "paid through July 17" spoken on August 3 reads as current and is not.
  if (row.contract_end_date < todayKey) {
    out += ' That paid-through date has passed and the renewal term is not recorded yet — flag it for review.';
  } else if (daysToNotice < 0) {
    out += ' That notice window has already passed, so it auto-renews.';
  } else if (daysToNotice <= 3) {
    out += ` That notice window closes in ${daysToNotice} day${daysToNotice === 1 ? '' : 's'}.`;
  }
  return out;
}

export async function contractStat(query: string): Promise<LaneResult> {
  // Contracts live in the uhsEstimate project, NOT the JARVIS project that
  // SUPABASE_URL points at — reading the wrong one returns a confident 404.
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) {
    return unavailable(
      'Contract lookup',
      'the uhsEstimate Supabase credentials are not configured on the dashboard',
    );
  }
  if (!query.trim()) {
    return { ok: false, output: 'Ask which agent or address they mean.' };
  }

  // === MOD #106 — the fetch is a helper now because a miss on the OPEN set is
  // no longer the end of the story (see the closed-contract pass below). ===
  const CONTRACT_FETCH_LIMIT = 300;
  const getRows = async (params: Record<string, string>): Promise<ContractRow[] | null> => {
    const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
    for (const [k, v] of Object.entries(params)) endpoint.searchParams.set(k, v);
    endpoint.searchParams.set('limit', String(CONTRACT_FETCH_LIMIT));
    try {
      const res = await fetch(endpoint, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(6_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ContractRow[] | { message?: string };
      return Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  };
  const fetchContracts = async (openOnly: boolean): Promise<ContractRow[] | null> =>
    getRows(
      openOnly
        ? { select: CONTRACT_SELECT, status: `in.(${OPEN_STATUSES.join(',')})` }
        : { select: CONTRACT_SELECT },
    );

  const rows = await fetchContracts(true);
  if (!rows) {
    return unavailable('Contract lookup', 'the projects table could not be reached');
  }
  // MOD #106 (P2 guard, bestClient pattern): a truncated read makes "no match"
  // a lie. Say the window was exceeded rather than search half the contracts.
  if (rows.length >= CONTRACT_FETCH_LIMIT) {
    return unavailable(
      'Contract lookup',
      'the open-contract list exceeds the single-read window and a match could be missed',
    );
  }

  const ranked = rows
    .map((r) => ({ r, score: scoreContract(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    // === MOD #106 — "no open contract matches 2572 Sable Ridge" is true and
    // useless: the home IS ours, it was destaged in June, and Scott asked
    // because he wanted THAT. A miss on the open set now falls through to an
    // unscoped pass and reports the settled history instead of a shrug. ===
    // The closed pass filters SERVER-SIDE. An unscoped read of every project
    // ever hits the 300-row window immediately (the history is far larger than
    // the open book), and a truncated read makes "no match" a lie — so the
    // narrowing happens in PostgREST: address ilike on the query's most
    // distinctive tokens, plus an inner-joined contact-name search for the
    // "what happened with Craig Tann's listing" shape.
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 3);
    const like = (t: string) => `*${t}*`;
    const addressFilter = tokens.length
      ? tokens.map((t) => `and(or(property_address.ilike.${like(t)},normalized_address.ilike.${like(t)}))`)
      : [];
    const [byAddress, byContact] = await Promise.all([
      addressFilter.length
        ? getRows({ select: CONTRACT_SELECT, and: `(${addressFilter.join(',')})` })
        : Promise.resolve([]),
      getRows({
        select: `${CONTRACT_SELECT.replace('project_contacts(', 'project_contacts!inner(')}`,
        'project_contacts.contact_name': `ilike.*${query.trim().replace(/\s+/g, '*')}*`,
      }),
    ]);
    const merged = new Map<string, ContractRow>();
    for (const r of [...(byAddress ?? []), ...(byContact ?? [])]) {
      merged.set(r.id ?? `${r.property_address}`, r);
    }
    const closed = [...merged.values()]
      .map((r: ContractRow) => ({ r, score: scoreContract(r, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (closed.length > 0) {
      // === MOD #106b — ASK, don't pick. The open branch has always had an
      // ambiguity clarifier; this one didn't, and "Craig Tann" — a listing
      // agent with SEVENTEEN completed projects — was answered by silently
      // choosing one 2021 record and speaking its dates as if they were the
      // answer. Which property is a question only Scott can settle. ===
      const distinct = new Map<string, ContractRow>();
      for (const { r } of closed) {
        const key = (r.property_address ?? r.id ?? '').toLowerCase().trim();
        if (key && !distinct.has(key)) distinct.set(key, r);
      }
      const tied = closed.filter((x) => x.score >= closed[0].score * 0.9);
      if (distinct.size > 1 && tied.length > 1) {
        const names = [...distinct.values()]
          .slice(0, 3)
          .map((r) => r.property_address?.trim() || listingAgent(r) || 'unknown');
        return {
          ok: true,
          output:
            `${distinct.size} past projects match ${query}: ${spokenList(names)}. ` +
            'None of them is a live contract. Ask which property they mean.',
        };
      }
      const row = closed[0].r;
      const who = listingAgent(row);
      const where = row.property_address?.trim() || 'That property';
      const status = (row.status ?? 'closed').toLowerCase().replace(/[-_]/g, ' ');
      const bits: string[] = [];
      if (row.destage_date) bits.push(`removed ${spokenDate(row.destage_date)}`);
      if (row.contract_end_date) bits.push(`paid through ${spokenDate(row.contract_end_date)}`);
      const tail = bits.length ? ` — ${spokenList(bits)}` : '';
      return {
        ok: true,
        output: `${where}${who ? `, ${who},` : ''} is ${status}${tail}. No live contract on it.`,
      };
    }
    return { ok: true, output: `No contract, open or closed, matches ${query}.` };
  }
  // Ambiguity is a question, not a guess — the skill asks ONE clarifier, and a
  // confidently wrong contract date is the worst possible answer here.
  if (ranked.length > 1 && ranked[1].score >= ranked[0].score * 0.9) {
    const names = ranked
      .slice(0, 3)
      .map((x) => x.r.property_address ?? listingAgent(x.r) ?? 'unknown');
    return {
      ok: true,
      output: `${ranked.length} open contracts match: ${spokenList(names)}. Ask which one they mean.`,
    };
  }
  // Round 2 (critic finding): "Lauren Stark" matched Lauren Paris on the one
  // shared token and was answered as a fact. A hit that does not contain every
  // token of the query is a GUESS — present it as one.
  const top = ranked[0].r;
  const haystack = `${top.property_address ?? ''} ${top.normalized_address ?? ''} ${(
    top.project_contacts ?? []
  )
    .map((c) => c.contact_name ?? '')
    .join(' ')}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const allTokensHit = tokens.length > 0 && tokens.every((t) => haystack.includes(t));
  const answer = spokenContract(top);
  return {
    ok: true,
    output: allTokensHit
      ? answer
      : `No exact match for ${query} — the closest open contract is ${answer} Confirm that's the one they mean.`,
  };
}
// === END JARVIS MOD #52 ===

// === JARVIS MOD #102 — three more fast lanes + honest wedge detection =======
// Born from the 2026-08-03 demo video: "how many listings are active on the
// MLS", "what's Ryan Marsh's email", and "who's our best client" all fell
// through to ask_jarvis while the jarvis-telegram brain had been wedged on a
// computer-use task for ten hours — so the voice said "one moment, sir" into
// the void, four times, on camera. Each of those questions is one or two
// PostgREST reads away from data this dashboard can already reach. Same rules
// as MOD #52: READ-ONLY, spoken output, degrade honestly.

import { getCTXRoot } from '@/lib/config';

// --- shared PostgREST helpers ------------------------------------------------

/** Exact row count without fetching rows: PostgREST puts it in content-range. */
async function pgCount(
  base: string,
  key: string,
  pathAndQuery: string,
  // MOD #106: callers can put a deadline on a count. A secondary clause that
  // arrives after the answer should have been spoken is not worth waiting for.
  timeoutMs = 6_000,
): Promise<number | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${pathAndQuery}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const range = res.headers.get('content-range') ?? '';
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

async function pgRows<T>(base: string, key: string, pathAndQuery: string): Promise<T[] | null> {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as T[] | { message?: string };
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// --- mls_market ---------------------------------------------------------------
// Live GLVAR market counts from the uhsMLS Supabase (the nightly-refreshed
// listings mirror). Status codes are GLVAR's: A-* = active (ER/EA), UCNS/UCS =
// under contract. ~500k rows, but counts ride the status index — sub-second.

function mlsCreds(): { url: string; key: string } | null {
  const url = process.env.UHS_MLS_SUPABASE_URL?.trim();
  const key = process.env.UHS_MLS_SUPABASE_KEY?.trim();
  return url && key ? { url, key } : null;
}

export async function mlsMarket(): Promise<LaneResult> {
  const creds = mlsCreds();
  if (!creds) {
    return unavailable('The MLS market count', 'the uhsMLS Supabase credentials are not configured on the dashboard');
  }
  const weekAgo = ptDateKey(new Date(Date.now() - 7 * 86_400_000));
  // === MOD #106 — the two SECONDARY counts get a 1.2s deadline. Measured 3.1s
  // total before this: the headline number was ready in under a second and then
  // the voice sat silent waiting on two nice-to-have clauses. The honest-
  // degradation clause below already existed and had never once fired — a
  // timeout is exactly the case it was written for. ===
  const SECONDARY_DEADLINE_MS = 1_200;
  const [active, underContract, newThisWeek] = await Promise.all([
    pgCount(creds.url, creds.key, 'listings?select=mls_number&status=like.A-*'),
    pgCount(creds.url, creds.key, 'listings?select=mls_number&status=in.(UCNS,UCS)', SECONDARY_DEADLINE_MS),
    pgCount(
      creds.url,
      creds.key,
      `listings?select=mls_number&status=like.A-*&list_date=gte.${weekAgo}`,
      SECONDARY_DEADLINE_MS,
    ),
  ]);
  if (active === null) {
    return unavailable('The MLS market count', 'the listings table could not be reached');
  }
  let out = `${active.toLocaleString('en-US')} active listings on the Las Vegas MLS right now.`;
  if (underContract !== null) out += ` ${underContract.toLocaleString('en-US')} more under contract.`;
  if (newThisWeek !== null) out += ` ${newThisWeek.toLocaleString('en-US')} came on in the last seven days.`;
  // Critic finding (MOD #102 review): a dropped clause is indistinguishable
  // from "nothing to report". If a secondary count failed, say so — never let
  // a shorter answer impersonate a complete one.
  if (underContract === null || newThisWeek === null) {
    const missing = [
      ...(underContract === null ? ['under-contract'] : []),
      ...(newThisWeek === null ? ['new-this-week'] : []),
    ];
    out += ` The ${missing.join(' and ')} count${missing.length > 1 ? 's' : ''} did not come back — mention that rather than skipping it.`;
  }
  return { ok: true, output: out };
}

// --- contact_lookup -------------------------------------------------------------
// One name → email/phone, searched in trust order (AGENTS.md contact protocol):
//   1. curated business contacts (team, vendors, TSC people — facts that live
//      in memory, not in any database)
//   2. uhsEstimate project_contacts (people on real UHS projects)
//   3. uhsMLS agents (14,963 GLVAR agents)
// Owned records outrank the MLS mirror; the first tier that matches, answers.

interface BizContact {
  name: string;
  role?: string;
  company?: string;
  email?: string | null;
  phone?: string | null;
  aliases?: string[];
}

export function bizContactsPath(): string {
  return (
    process.env.UHS_BUSINESS_CONTACTS?.trim() ||
    path.join(getCTXRoot(), 'config', 'business-contacts.json')
  );
}

/** Every query token must appear in the candidate's searchable text. */
export function nameMatches(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0) return false;
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/** The value a set of noisy CRM rows converges on — most frequent wins, ties
 *  broken by first appearance. Exported for the unit lock. */
export function modalValue(vals: (string | undefined | null)[]): string | null {
  const freq = new Map<string, number>();
  for (const v of vals) {
    const k = v?.trim().toLowerCase();
    if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function spokenPerson(name: string, detail: string[], email?: string | null, phone?: string | null): string {
  const bits: string[] = [];
  if (email) bits.push(`email ${email}`);
  if (phone) bits.push(`phone ${phone}`);
  const who = detail.filter(Boolean).join(', ');
  if (bits.length === 0) return `${name}${who ? `, ${who}` : ''} — no email or phone on file.`;
  return `${name}${who ? `, ${who}` : ''}: ${spokenList(bits)}.`;
}

/** Grouping key for person names: case, whitespace, and punctuation-insensitive
 *  ("Peter J Arroyo" and "Peter J. Arroyo" are one person). Exported for the
 *  unit lock. */
export function normalizePersonName(name: string): string {
  return name.toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
}

export async function contactLookup(query: string): Promise<LaneResult> {
  const q = query.trim();
  if (!q) return { ok: false, output: 'Ask whose contact information they want.' };

  // Tier 1 — curated business contacts (local file, milliseconds).
  // Round 2 (critic finding): this tier had no ambiguity check — a query
  // matching several teammates silently returned the first.
  const biz = readJson<{ contacts?: BizContact[] }>(bizContactsPath());
  const bizHit = (biz?.contacts ?? []).filter((c) =>
    nameMatches(`${c.name} ${(c.aliases ?? []).join(' ')} ${c.company ?? ''}`, q),
  );
  if (bizHit.length > 1) {
    return {
      ok: true,
      output: `${bizHit.length} people match ${q}: ${spokenList(bizHit.map((c) => c.name))}. Ask which one they mean.`,
    };
  }
  if (bizHit.length === 1) {
    const c = bizHit[0];
    return { ok: true, output: spokenPerson(c.name, [c.role ?? '', c.company ?? ''], c.email, c.phone) };
  }

  // Tier 2 — people on UHS projects (uhsEstimate project_contacts).
  // Two hard-won rules live here (both caught by critics on 2026-08-03):
  //  1. Group by PERSON before taking any modal value. "Jones" matched David
  //     Jones and Wyking Jones, and Wyking's email won the mode and got spoken
  //     under David's name — a fabricated contact record.
  //  2. Within one person, rows still disagree (teammates' emails entered
  //     under the agent's name) — the modal value across that person's own
  //     rows is the answer the project history converges on.
  const estUrl = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const estKey = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (estUrl && estKey) {
    const enc = encodeURIComponent(`*${q.split(/\s+/).join('*')}*`);
    const rows = await pgRows<{ contact_name: string; contact_type?: string; email?: string; phone?: string }>(
      estUrl, estKey,
      `project_contacts?select=contact_name,contact_type,email,phone&contact_name=ilike.${enc}&limit=100`,
    );
    const withInfo = (rows ?? []).filter((r) => (r.email || r.phone) && r.contact_name?.trim());
    if (withInfo.length > 0) {
      const byPerson = new Map<string, typeof withInfo>();
      for (const r of withInfo) {
        const k = normalizePersonName(r.contact_name);
        byPerson.set(k, [...(byPerson.get(k) ?? []), r]);
      }
      if (byPerson.size > 1) {
        const names = [...byPerson.values()].map((rs) => rs[0].contact_name.trim()).slice(0, 4);
        return {
          ok: true,
          output: `${byPerson.size} people on UHS projects match ${q}: ${spokenList(names)}. Ask which one they mean.`,
        };
      }
      const person = [...byPerson.values()][0];
      const email = modalValue(person.map((r) => r.email));
      const phone = modalValue(person.map((r) => r.phone));
      const role = (person[0].contact_type ?? '').toLowerCase().replace(/_/g, ' ');
      return {
        ok: true,
        output: spokenPerson(person[0].contact_name.trim(), [role ? `${role} on UHS projects` : ''], email, phone),
      };
    }
  }

  // Tier 3 — the GLVAR agent roster. Round 2: "Smith" used to say "5 agents
  // match" because 5 was the fetch limit — the spoken count is now the real one.
  const mls = mlsCreds();
  if (mls) {
    const tokens = q.split(/\s+/).filter((t) => t.length > 1);
    const and = tokens.map((t) => `agent_name.ilike.*${encodeURIComponent(t)}*`).join(',');
    const rows = await pgRows<{ agent_name: string; email?: string; phone?: string; office_name?: string }>(
      mls.url, mls.key,
      `agents?select=agent_name,email,phone,office_name&and=(${and})&limit=5`,
    );
    if (rows && rows.length === 1) {
      const r = rows[0];
      return { ok: true, output: spokenPerson(r.agent_name, [r.office_name ?? ''], r.email, r.phone) };
    }
    if (rows && rows.length > 1) {
      const total =
        rows.length === 5
          ? await pgCount(mls.url, mls.key, `agents?select=id&and=(${and})`)
          : rows.length;
      const spoken = total ?? rows.length;
      const sample = spokenList(rows.slice(0, 3).map((r) => `${r.agent_name} at ${r.office_name ?? 'unknown office'}`));
      return {
        ok: true,
        output: `${spoken} MLS agents match ${q}, including ${sample}. Ask which one they mean.`,
      };
    }
  }

  return {
    ok: true,
    output: `No contact named ${q} in the team list, project contacts, or the MLS roster. Offer to run the full lookup.`,
  };
}

// --- best_client ----------------------------------------------------------------
// "Who's our best client" = which listing agent brings UHS the most business.
// Aggregated from uhsEstimate projects that actually became work (INQUIRY,
// CANCELLED, and MISC excluded), grouped by LISTING_AGENT. staging_price is the
// contract TERM total (never a monthly rate — see uhsEstimate money-field
// semantics), so summing it is honest revenue attribution.

const NON_CLIENT_STATUSES = new Set(['INQUIRY', 'CANCELLED', 'MISC']);

/** UHS's own people are not clients — Scott appears as LISTING_AGENT on
 *  internal projects and was ranking in the client pool. Normalized names. */
const INTERNAL_NAMES = new Set([
  'scott aschermann',
  'scott ascherman',
  'angelic ferguson',
  'raquel lopez',
]);

export async function bestClient(): Promise<LaneResult> {
  const url = process.env.UHS_ESTIMATE_SUPABASE_URL?.trim();
  const key = process.env.UHS_ESTIMATE_SUPABASE_KEY?.trim();
  if (!url || !key) {
    return unavailable('Client rankings', 'the uhsEstimate Supabase credentials are not configured on the dashboard');
  }
  const rows = await pgRows<{
    status?: string;
    staging_price?: number | null;
    project_contacts?: { contact_name?: string; contact_type?: string }[] | null;
  }>(url, key, 'projects?select=status,staging_price,project_contacts(contact_name,contact_type)&limit=1000');
  if (!rows) {
    return unavailable('Client rankings', 'the projects table could not be reached');
  }
  // Round 2 (critic finding): nothing guarded the fetch limit — at 1000 rows
  // the ranking would silently be computed on a truncated table.
  if (rows.length >= 1000) {
    return unavailable('Client rankings', 'the projects table exceeds the single-read window and the ranking would be incomplete');
  }

  // Round 2 fixes, all from the critic's recount:
  //  - group by NORMALIZED name ("Peter J Arroyo" + "Peter J. Arroyo" were two
  //    rows, so the real #3 client never surfaced);
  //  - credit EVERY listing agent on a co-listed project, not whichever the
  //    embed happened to return first;
  //  - count unpriced projects instead of treating null as $0.
  const byAgent = new Map<string, { display: string; projects: number; revenue: number; unpriced: number }>();
  for (const row of rows) {
    if (NON_CLIENT_STATUSES.has((row.status ?? '').toUpperCase())) continue;
    const agents = new Map<string, string>();
    for (const c of row.project_contacts ?? []) {
      if ((c.contact_type ?? '').toUpperCase() !== 'LISTING_AGENT') continue;
      const raw = c.contact_name?.trim();
      if (!raw) continue;
      const k = normalizePersonName(raw);
      if (!INTERNAL_NAMES.has(k) && !agents.has(k)) agents.set(k, raw);
    }
    const price = row.staging_price === null || row.staging_price === undefined ? null : Number(row.staging_price);
    for (const [k, raw] of agents) {
      const cur = byAgent.get(k) ?? { display: raw, projects: 0, revenue: 0, unpriced: 0 };
      cur.projects += 1;
      if (price === null || Number.isNaN(price)) cur.unpriced += 1;
      else cur.revenue += price;
      byAgent.set(k, cur);
    }
  }
  if (byAgent.size === 0) {
    return unavailable('Client rankings', 'no projects with a listing agent were found');
  }

  const ranked = [...byAgent.values()].sort(
    (a, b) => b.projects - a.projects || b.revenue - a.revenue,
  );
  const top = ranked[0];
  const money = (n: number) =>
    n >= 1000 ? `$${Math.round(n / 1000).toLocaleString('en-US')}K` : `$${Math.round(n)}`;
  const priced = top.projects - top.unpriced;
  const revenueClause =
    top.unpriced > 0
      ? `${money(top.revenue)} across the ${priced} priced contracts`
      : `${money(top.revenue)} in contracts`;
  let out = `Best client all-time: ${top.display} — ${top.projects} stagings, ${revenueClause}.`;
  const rest = ranked.slice(1, 3).map((s) => `${s.display} with ${s.projects}`);
  if (rest.length) out += ` Then ${spokenList(rest)}.`;
  return { ok: true, output: out };
}

// --- brain wedge detection --------------------------------------------------------
// The demo failure mode: ask_jarvis dispatches into a PTY that is mid-task (or
// stuck) and every question queues silently behind it. The signal is cheap and
// local: inbound messages keep arriving but the outbound log hasn't moved.
// Sixty stale minutes with newer questions pending = say so up front instead of
// polling 45 seconds toward a vague "still running".

export const BRAIN_WEDGE_STALE_MS = 60 * 60 * 1000;

export function brainWedgeCheck(
  agent = 'jarvis-telegram',
  logsRoot?: string,
): { wedged: boolean; sinceMinutes: number } {
  try {
    const dir = path.join(logsRoot ?? path.join(getCTXRoot(), 'logs'), agent);
    const out = fs.statSync(path.join(dir, 'outbound-messages.jsonl')).mtimeMs;
    const inn = fs.statSync(path.join(dir, 'inbound-messages.jsonl')).mtimeMs;
    const staleMs = Date.now() - out;
    // Wedged = quiet for an hour WHILE questions newer than the last answer sit unanswered.
    const wedged = staleMs > BRAIN_WEDGE_STALE_MS && inn > out + 120_000;
    return { wedged, sinceMinutes: Math.round(staleMs / 60_000) };
  } catch {
    return { wedged: false, sinceMinutes: 0 };
  }
}
// === END JARVIS MOD #102 ===

// === JARVIS MOD #106 — vault_search + project_status =========================
// The gap the critics found: every question about HOW WE DO SOMETHING — what a
// contract clause says, what a playbook prescribes, what a standing rule is,
// what we learned from an incident — had no lane at all. It went to ask_jarvis
// and took 34.7 seconds (measured: "what does section 7.2 of the staging
// contract say"). That answer is sitting in a markdown file on this machine.
//
// Two legs, in parallel:
//   LEXICAL   ripgrep over the vault and both memory corpora (~40ms measured).
//             Exact terms, filename and heading hits weighted above body hits.
//   SEMANTIC  the warm mmrag sidecar (scripts/mmrag-sidecar.py, 127.0.0.1:8791),
//             hard-deadlined at 2s and POST-FILTERED to sources under the vault
//             or memory dirs — the `uhs` collection is ~93k chunks of which only
//             a few thousand are vault, and unfiltered it happily quotes a
//             year-old TikTok transcript at you with total confidence.
//
// If the sidecar is down the lane still answers from the lexical leg and SAYS
// it was degraded. What it must never do is quietly fall through to ask_jarvis:
// ask_jarvis is a WRITE door (it can queue tasks and send things), and a search
// silently becoming a dispatch is exactly the class of surprise that has no
// upper bound on damage.

import { execFile } from 'child_process';

/** Where uhsJARVIS lives. HARD FAIL if unset: a guessed path would make every
 *  vault answer silently wrong instead of loudly absent. Set in BOTH
 *  ~/cortextos/dashboard/.env.local and ~/.cortextos/default/dashboard.env. */
export function jarvisRoot(): string {
  const root = process.env.JARVIS_ROOT?.trim();
  if (!root) {
    throw new Error('JARVIS_ROOT is not set on the dashboard — the vault path cannot be guessed');
  }
  return root.replace(/\/+$/, '');
}

/** The Claude-agent memory corpus (~750 files) lives outside the repo, under a
 *  slugified copy of the project path. Derived, not hardcoded, so a moved repo
 *  does not silently lose 750 documents. */
export function agentMemoryDir(): string {
  const override = process.env.JARVIS_AGENT_MEMORY_DIR?.trim();
  if (override) return override.replace(/\/+$/, '');
  const slug = jarvisRoot().replace(/[^A-Za-z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
}

/** Everything vault_search is allowed to read from, and the only sources the
 *  semantic leg's results are accepted from. */
export function knowledgeRoots(): string[] {
  const root = jarvisRoot();
  return [path.join(root, 'vault'), path.join(root, 'memory'), agentMemoryDir()].filter((p) =>
    fs.existsSync(p),
  );
}

// === JARVIS MOD #106e — derived clause-grain docs ==========================
// One markdown document per numbered clause of the staging agreement, emitted
// by scripts/derive-contract-clauses.py into ~/.mmrag/derived/ and ingested
// alongside the vault. They live OUTSIDE the vault deliberately: the lexical
// leg never walks them, so they cannot double-answer, and the whole addition is
// removable by source-path prefix. A hit on one is attributed to the REAL
// agreement — the derived path is never a source and is never spoken.
export const DERIVED_ROOT =
  process.env.MMRAG_DERIVED_ROOT?.trim() || path.join(os.homedir(), '.mmrag', 'derived');

interface DerivedEntry { source: string; clause: string }
let derivedManifest: Map<string, DerivedEntry> | null = null;

/** derived file path → { real source, clause number }. Read once, cached. */
export function derivedIndex(): Map<string, DerivedEntry> {
  if (derivedManifest) return derivedManifest;
  const map = new Map<string, DerivedEntry>();
  try {
    for (const dir of fs.readdirSync(DERIVED_ROOT, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const manifest = readJson<{ files?: Record<string, DerivedEntry> }>(
        path.join(DERIVED_ROOT, dir.name, 'MANIFEST.json'),
      );
      for (const [file, entry] of Object.entries(manifest?.files ?? {})) map.set(file, entry);
    }
  } catch {
    /* no derived docs — the lane works exactly as before */
  }
  derivedManifest = map;
  return map;
}

export const MMRAG_SIDECAR_URL =
  process.env.MMRAG_SIDECAR_URL?.trim() || 'http://127.0.0.1:8791';

/** The semantic leg's whole budget.
 *
 *  MOD #106b, and this number went DOWN, not up. Measured: the ChromaDB search
 *  is 50-100ms regardless of candidate count and all the variance is the Gemini
 *  embedding call — 0.24s typical, 2.0-2.5s at the tail. Raising the budget to
 *  catch the tail put p95 at 2,531ms, over the two-second spoken bar, to wait
 *  on a leg that (since the gate rewrite) can no longer introduce a result at
 *  all: it only re-ranks documents the lexical leg already found. Paying two
 *  and a half seconds of silence for a better ordering is a bad trade in a
 *  conversation. 1,200ms keeps the median at ~380ms and the tail bounded. */
export const MMRAG_SIDECAR_TIMEOUT_MS = Number(process.env.MMRAG_SIDECAR_TIMEOUT_MS) || 1_200;

/** Below this similarity a semantic-only hit is a suggestion, not an answer,
 *  and sorts under every lexical hit. */
export const SEMANTIC_TRUST_FLOOR = 0.7;

/** A word appearing in this few documents, and in none of their titles or
 *  headings, is a subject the vault has not written about — not an answer
 *  waiting in a document that happens to mention it once. */
export const RARE_SUBJECT_DOCS = 5;

/** MOD #106c: the similarity at which a semantic-only hit may carry a result on
 *  its own. Every decoy the critics caught scored 0.60-0.74; this sits above
 *  them deliberately, so paraphrased questions are reachable without reopening
 *  the door that produced them. */
export const SEMANTIC_RESCUE_FLOOR = 0.75;

/** MOD #106d — putting similarity on the same scale as lexical points.
 *  On this corpus every chunk scores about 0.5 against any question, so only
 *  the part ABOVE that floor is information. The gain then maps the useful
 *  range (0.55-0.90) onto roughly 0-42 points, which is the range a strong
 *  lexical section scores — so neither leg can silently dominate the other. */
/** How much a standing rule or contract clause outranks an incident note, and
 *  only on policy-shaped questions. Env-tunable so the effect can be isolated. */
export const AUTHORITY_WEIGHT = Number(process.env.VAULT_AUTHORITY_WEIGHT) || 1.5;

export const SEMANTIC_BASE = 0.55;
export const SEMANTIC_GAIN = 160;

// === JARVIS MOD #106f — authority, and when it counts =======================
// The last miss cluster was not about retrieval any more: for "what is our
// position on Zillow" or "where are we allowed to get listing photos", the
// canonical DECISION lost to an incident note that discussed the same topic at
// greater length. A note recording what we decided outranks a note recording
// what happened once — but ONLY when the question asks what our policy,
// position or rule IS. Asked "what went wrong with X", the incident note is the
// right answer and must keep winning, which is why this is conditional.
const POLICY_QUESTION =
  /\b(polic(?:y|ies)|rules?|position|stance|standards?|conventions?|allowed|permitted|banned|prohibited|supposed to|are we able|do we (?:ever|always|still)?\s*(?:use|allow|charge|offer|require|accept)|can we|may we|should we)\b/i;

export function isPolicyQuestion(query: string): boolean {
  return POLICY_QUESTION.test(query);
}

/** Does this document RECORD A DECISION, as opposed to recounting an event?
 *  Memory notes declare their kind in frontmatter; the derived clause docs and
 *  the agreement itself are contractual, which is as authoritative as it gets. */
export function isAuthoritative(file: string, body: string): boolean {
  const head = body.slice(0, 1200);
  if (/^\s*type:\s*(feedback|contract_clause)\s*$/m.test(head)) return true;
  if (/\bcontracts?\//.test(file) && file.endsWith('.md')) return true;
  if (/decision \(locked|locked-in|non-negotiable|no exceptions|binding until/i.test(head)) return true;
  return /\/feedback_[^/]*\.md$/.test(file);
}

/** Whitespace- and case-normalised, for locating a chunk inside its file. */
export function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The score a winning section must clear to be spoken at all. Calibrated
 *  against live queries: real answers land in the 30s and up, incidental
 *  mentions in the low teens. */
export const RELEVANCE_FLOOR = Number(process.env.VAULT_RELEVANCE_FLOOR) || 20;

/** The bar for a section with NO semantic support — word overlap only, or raw
 *  recorded material. Measured: real answers backed by an embedding score 30-90
 *  while unanswerable all-common-word questions top out around 27. */
export const RELEVANCE_FLOOR_UNSUPPORTED =
  Number(process.env.VAULT_RELEVANCE_FLOOR_UNSUPPORTED) || 35;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'our', 'you', 'your', 'what', 'whats', 'does',
  'did', 'has', 'have', 'had', 'how', 'why', 'who', 'when', 'where', 'which', 'that', 'this',
  'with', 'from', 'about', 'into', 'say', 'says', 'said', 'tell', 'get', 'got', 'can', 'will',
  'would', 'should', 'could', 'any', 'all', 'out', 'its', 'run', 'use', 'used', 'need',
  'want', 'know', 'again', 'their', 'there', 'them', 'they', 'his', 'her', 'ours', 'mine',
  // MOD #106b: the floor dropped from four characters to three so that "pet",
  // "jet", "ski" survive as searchable words (they are the whole question), so
  // the three-letter function words now have to be named explicitly.
  'but', 'not', 'yes', 'per', 'off', 'own', 'too', 'via', 'let', 'may', 'one', 'two',
  'her', 'him', 'she', 'were', 'been', 'than', 'then', 'when', 'some', 'such', 'only',
  'also', 'just', 'very', 'much', 'more', 'most', 'over', 'under', 'each', 'other',
]);

/** Spoken numbers, because the voice model is INSTRUCTED to say them as words.
 *  "what does section seven point two say" is the main path, not an edge case,
 *  and the document it must match writes "7.2". Live 2026-08-09: the digit
 *  phrasing found the agreement; the spoken phrasing found a dashboards lesson. */
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
  seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
};

/** MOD #106c: ordinals, because people ask in them. "what happens on the
 *  SEVENTH day past due" found nothing — the contract's row reads
 *  "Past due >7 days". */
const ORDINAL_WORDS: Record<string, string> = {
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10', eleventh: '11', twelfth: '12',
  thirtieth: '30',
};

export function normalizeSpokenNumbers(query: string): string {
  let out = query.toLowerCase();
  out = out.replace(/\b[a-z]+\b/g, (w) => ORDINAL_WORDS[w] ?? w);
  // "seven point two" → "7.2" (a section number, spoken)
  out = out.replace(/\b([a-z]+)\s+point\s+([a-z]+)\b/g, (m, a: string, b: string) =>
    NUMBER_WORDS[a] && NUMBER_WORDS[b] ? `${NUMBER_WORDS[a]}.${NUMBER_WORDS[b]}` : m,
  );
  // "section seven" → "section 7"
  out = out.replace(
    /\b(section|clause|paragraph|article|item|exhibit)\s+([a-z]+)\b/g,
    (m, k: string, w: string) => (NUMBER_WORDS[w] ? `${k} ${NUMBER_WORDS[w]}` : m),
  );
  // Bare number words → digits ("ten day notice" → "10 day notice"). The
  // contract writes "ten (10) calendar days"; the digit form is the one that
  // also matches the tables and the fee schedule.
  out = out.replace(/\b[a-z]+\b/g, (w) => NUMBER_WORDS[w] ?? w);
  return out;
}

/**
 * One searchable term.
 *
 * `mode` exists because substring matching is right for long words and wrong
 * for short ones. "price" must find "pricing" (a substring match on the stem
 * `pric`), but "pet" must NOT find "carpet" or "competitor" — and that false
 * match is what let the lane answer "what's the pet policy" with §3.7 when the
 * contract has no pet clause at all.
 *   fixed → literal substring (stems, long words)
 *   word  → whole word only (three- and four-letter words)
 *   regex → digits, comma-tolerant ("2500" must find "$2,500")
 */
export interface SearchTerm {
  pattern: string;
  mode: 'fixed' | 'word' | 'regex';
  /** MOD #106g — true when the pattern was RELAXED ≥2 chars below its stem to
   *  find any match at all. Relaxation is what lets "statistics" reach the note
   *  that says "stats" — and it is also what turned "maternity" into "mater"
   *  and answered a maternity-leave question from §10.5.3 Materials. A relaxed
   *  match is a guess about vocabulary, so it may SCORE but it may not serve as
   *  structural proof that a section answers the question. */
  relaxed?: boolean;
}

/** Crude but effective stemming: enough that "price" and "pricing" are one
 *  term. Only applied when the stem stays at least four characters, so short
 *  words are never shaved into noise. */
export function termStem(word: string): string | null {
  const rules: Array<[RegExp, number]> = [
    [/ies$/, 3],
    [/ing$/, 3],
    [/ed$/, 2],
    [/es$/, 2],
    [/s$/, 1],
    [/y$/, 1],
    [/e$/, 1],
  ];
  for (const [re, cut] of rules) {
    if (re.test(word)) {
      const stem = word.slice(0, word.length - cut);
      if (stem.length >= 4) return stem;
    }
  }
  return null;
}

/** Search terms from a SPOKEN question. Numbers survive ("7.2" is the whole
 *  question), stopwords do not, and the list is capped so one rambling
 *  sentence cannot fan out into twenty ripgrep processes. */
export function searchTerms(query: string, max = 6): SearchTerm[] {
  let q = normalizeSpokenNumbers(query);
  // MOD #106g — "how much is a consultation" loses its price intent entirely:
  // "how" and "much" are stopwords, leaving a bare noun that a title-matching
  // insight note wins. A price-shaped question implicitly asks about pricing,
  // so inject the term and let the ordinary scorer do the rest — the canonical
  // figures live in files NAMED for pricing.
  if (/\bhow much\b|\bprice\b|\bcost\b|\bfee\b|\bcharge\b|\bpricing\b/.test(q) && !/pric/.test(q)) {
    q += ' pricing';
  }
  const raw = q.match(/[a-z0-9][a-z0-9.'-]*/g) ?? [];
  const seen = new Set<string>();
  const terms: Array<SearchTerm & { weight: number }> = [];
  for (const t of raw) {
    const word = t.replace(/^[.'-]+|[.'-]+$/g, '');
    if (!word) continue;
    const numeric = /\d/.test(word);
    if (!numeric && (word.length < 3 || STOPWORDS.has(word))) continue;

    let term: SearchTerm;
    if (numeric) {
      term = { pattern: word, mode: 'regex' };
    } else if (word.length >= 5) {
      term = { pattern: termStem(word) ?? word, mode: 'fixed' };
    } else {
      term = { pattern: word, mode: 'word' };
    }
    if (seen.has(term.pattern)) continue;
    seen.add(term.pattern);
    terms.push({ ...term, weight: word.length });
  }
  // Longest first: the rarest word is the most discriminating, and if the cap
  // bites it should bite the filler.
  terms.sort((a, b) => b.weight - a.weight);
  return terms.slice(0, max).map(({ pattern, mode }) => ({ pattern, mode }));
}

/** The ripgrep pattern + flags for one term. */
export function rgArgsFor(term: SearchTerm): string[] {
  if (term.mode === 'word') return ['-F', '-w', '-e', term.pattern];
  if (term.mode === 'fixed') {
    // MOD #106c: a stem matches at a WORD START, never mid-word. Raw substring
    // matching had "seller" hitting inside "reseller", which is how "are we a
    // one stop shop for sellers" came back with an Uttermost reseller note. The
    // stem still does its job — \bpric finds "price" and "pricing", \bstat
    // finds "stats" and "statistics".
    return ['-e', `\\b${term.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`];
  }
  if (term.mode === 'regex') {
    // "2500" must also find "$2,500" — the canonical pricing file writes the
    // comma, and without this the term looked absent and forced a decline.
    // MOD #106c: ESCAPE FIRST. Unescaped, "7.2" went to ripgrep as a regex
    // whose dot matches anything — it counted "7-2", "702" and "v7x2" as
    // occurrences, which inflated the term's document count, collapsed its
    // weight, and cost the section-number signal exactly where it mattered.
    // Rust's regex engine has no lookbehind, so the boundary is spelled out.
    const esc = term.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const commaTolerant = esc.replace(/(?<=\d)(?=(\d{3})+$)/g, ',?');
    return ['-e', `(^|[^0-9.])${commaTolerant}([^0-9.]|$)`];
  }
  return ['-F', '-e', term.pattern];
}

/** The JavaScript matcher for one term, used for filename/heading/body scoring. */
export function termRegExp(term: SearchTerm): RegExp {
  const esc = term.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (term.mode === 'word') return new RegExp(`\\b${esc}\\b`, 'i');
  if (term.mode === 'regex') {
    const commaTolerant = esc.replace(/(?<=\d)(?=(\d{3})+$)/g, ',?');
    // Not adjacent to another digit or dot: "7.2" must not match "7.2.2", which
    // is how the lane once answered the overtime charge when asked about notice.
    return new RegExp(`(?<![\\d.])${commaTolerant}(?![\\d.])`, 'i');
  }
  return new RegExp(`\\b${esc}`, 'i');
}

export function termHitsIn(text: string, term: SearchTerm): boolean {
  return termRegExp(term).test(text);
}

function runRg(args: string[], timeoutMs = 1_500): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      process.env.RG_BIN?.trim() || 'rg',
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => resolve(stdout ?? ''),
    );
  });
}

export interface VaultHit {
  /** Transcripts/sessions/raw — corroborating material, never load-bearing. */
  raw?: boolean;
  /** Admitted on similarity alone — held to the unsupported bar. */
  rescued?: boolean;
  /** MOD #106g — key word is structurally what this doc/section is about,
   *  via an unrelaxed match. Counts as corroboration at the floor. */
  keyStructural?: boolean;
  /** MOD #106g — winning section elected by a derived clause doc at ≥0.6. */
  clauseBacked?: boolean;
  /** Absolute path — returned for the UI, NEVER spoken. */
  path: string;
  title: string;
  snippet: string;
  score: number;
  similarity?: number;
  legs: 'both' | 'lexical' | 'semantic';
}

/** === JARVIS MOD #106c — documents are not the unit of an answer ===========
 *  Scoring whole FILES made `lessons.md` — one file, a hundred unrelated
 *  lessons, every business word in the vocabulary — win on term coverage for
 *  questions it does not answer. It beat the mechanics-lien clause on a
 *  mechanics-lien question. A document is a container; the thing that answers a
 *  question is a SECTION of one. So: split on markdown headings, score each
 *  section on its own merits, and let the best section carry its document.
 *  Files with no headings (every memory note) are one section, which is exactly
 *  right — they are single-topic by construction. */
export interface DocSection {
  heading: string;
  text: string;
  /** Character offsets into the frontmatter-stripped body. MOD #106d uses them
   *  to decide which section a semantically-matched chunk belongs to. */
  start: number;
  end: number;
}

export function splitSections(body: string, maxChars = 4_000): DocSection[] {
  const withoutFrontmatter = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
  const lines = withoutFrontmatter.split('\n');
  const sections: DocSection[] = [];
  let heading = '';
  let buf: string[] = [];
  let cursor = 0;
  let sectionStart = 0;
  const flush = (end: number) => {
    const text = buf.join('\n').trim();
    if (text || heading) {
      sections.push({ heading, text: text.slice(0, maxChars), start: sectionStart, end });
    }
    buf = [];
    sectionStart = end;
  };
  for (const line of lines) {
    const lineStart = cursor;
    cursor += line.length + 1;
    // A heading, or the contract's own convention: a bolded clause number
    // ("- **5.2.3 Working Utilities** — HVAC set to 74°F"). The agreement puts
    // its real answers in bullets like that, under a coarse "## 5." heading.
    if (/^#{1,6}\s+\S/.test(line) || /^-?\s*\*\*\d+(\.\d+)*\s/.test(line)) {
      flush(lineStart);
      // A heading is a LABEL, not a sentence. The contract writes whole clauses
      // as one bolded bullet — "- **2.1 Automatic Renewal.** Contract
      // automatically renews each month unless … notice … terminate …" — and
      // taking the whole line as the heading gave that clause four heading-
      // weight hits, so "how many days notice to terminate" answered with §2.1's
      // thirty days instead of §7.2's ten. Only the bolded label is the heading;
      // the sentence itself stays in the body, where it belongs.
      heading = /^#/.test(line)
        ? line.replace(/^#+\s*/, '').trim()
        : (line.match(/\*\*(.+?)\*\*/)?.[1] ?? line.replace(/^-?\s*/, '')).replace(/\*\*/g, '').trim();
      // A bolded clause line IS its own content as well as its own heading —
      // "- **5.2.3 Working Utilities** — HVAC set to 74°F" answers in one line.
      if (!/^#/.test(line)) buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush(withoutFrontmatter.length);
  return sections.length
    ? sections
    : [{ heading: '', text: withoutFrontmatter.slice(0, maxChars), start: 0, end: withoutFrontmatter.length }];
}

/** A file's display title: the first markdown H1 if it has one, else the
 *  filename de-slugified. "feedback_paint_policy.md" → "paint policy". */
export function noteTitle(file: string, body: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return path
    .basename(file, '.md')
    .replace(/^(feedback|reference|project|user)_/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/** The passage a person would read out.
 *
 *  MOD #106b — HEADINGS WIN. A document is organised by its headings, and the
 *  section a question is about is the one whose HEADING carries the question's
 *  words. Scoring every line equally produced a live wrong answer: "how many
 *  days notice to terminate a staging contract" anchored on §2.1 Automatic
 *  Renewal (which says "thirty (30) days") because that one line happened to
 *  contain three query words, while §7.2 "Post Installation Notice to
 *  Terminate" — the actual answer, ten days — sat one heading away. A model
 *  handed that passage reads out "thirty days" for a ten-day requirement.
 *  So: if any heading matches two or more distinct terms (or one numeric term),
 *  the best such heading is the anchor and its body follows. */
export function bestPassage(body: string, terms: SearchTerm[], max = 420): string {
  // MOD #106b: memory files open with a YAML block, and passages were quoting
  // it — "name: reference-staging-pricing-quickref … originSessionId:
  // fefb0625-aa63-4bdd-…" went into the voice model's context, where at best it
  // wastes the budget and at worst it gets read aloud. The `description` line
  // is still used, for ranking, before this strip.
  const lines = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').split('\n');
  const matchers = terms.map((t) => ({ t, re: termRegExp(t) }));
  const distinctHits = (line: string) => matchers.filter(({ re }) => re.test(line));

  let bestIdx = -1;
  let bestScore = -1;
  let bestHeadingIdx = -1;
  let bestHeadingScore = -1;

  for (let i = 0; i < lines.length; i++) {
    const hits = distinctHits(lines[i]);
    if (hits.length === 0) continue;
    const isHeading = /^#{1,6}\s/.test(lines[i]) || /^\*\*[\d.]+\s/.test(lines[i].trim());
    let s = 0;
    for (const { t } of hits) s += t.mode === 'regex' ? 3 : 2;
    s += (hits.length - 1) * 2; // covering more of the question beats repeating one word

    if (isHeading) {
      const anchorworthy = hits.length >= 2 || hits.some(({ t }) => t.mode === 'regex');
      if (anchorworthy && s > bestHeadingScore) {
        bestHeadingScore = s;
        bestHeadingIdx = i;
      }
      s += 2;
    }
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }
  if (bestHeadingIdx >= 0) bestIdx = bestHeadingIdx;
  if (bestIdx < 0) {
    return lines.find((l) => l.trim() && !l.startsWith('---'))?.trim().slice(0, max) ?? '';
  }
  const parts: string[] = [];
  for (let i = bestIdx; i < lines.length && parts.join(' ').length < max; i++) {
    const l = lines[i].trim();
    if (!l || l === '---') continue;
    parts.push(l.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/^[-*]\s*/, ''));
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Leg A — ripgrep. One process per term (parallel, ~40ms each) so we can score
 *  by how many DISTINCT query terms a file carries; an OR-of-terms single call
 *  would rank a file matching one common word alongside one matching all four. */
async function lexicalLeg(
  terms: SearchTerm[],
  roots: string[],
): Promise<{
  files: Map<string, { termHits: number; terms: SearchTerm[] }>;
  /** How many files each term appears in — the corpus rarity of that word. */
  termCounts: Map<string, number>;
  /** The terms as actually searched, after any stem relaxation. Everything
   *  downstream must score against THESE, not the originals. */
  effective: SearchTerm[];
}> {
  const perTerm = await Promise.all(
    terms.map(async (t) => {
      let term = t;
      let out = await runRg(['-il', '--glob', '*.md', ...rgArgsFor(term), '--', ...roots]);
      // === MOD #106c — one vocabulary mismatch must not kill a whole query. ===
      // "marketing STATISTICS" found nothing because the note that answers it
      // writes "stats", and a zero-hit term ends the search outright (rightly —
      // that is what makes "zamboni" decline). So before declaring a word
      // absent, shorten the stem and look again: "statistic" → "statisti" →
      // … → "stat", which finds it. Words the corpus genuinely does not contain
      // ("scuba" → "scub", "zamboni" → "zamb") stay at zero and still decline.
      if (!out.trim() && term.mode === 'fixed') {
        const orig = term.pattern.length;
        for (let len = term.pattern.length - 1; len >= 4 && !out.trim(); len--) {
          // Two characters of grace covers inflection ("statisti" → "statist");
          // anything shorter is vocabulary guessing and is marked as such.
          term = { pattern: term.pattern.slice(0, len), mode: 'fixed', relaxed: orig - len >= 2 };
          out = await runRg(['-il', '--glob', '*.md', ...rgArgsFor(term), '--', ...roots]);
        }
      }
      // === MOD #106c — a long word that almost nothing matches is usually a
      // SPELLING difference, not an absent subject. "statistics" appears in
      // five documents, none of them the note that answers the question —
      // which says "stats". Widen the stem once and merge; the widened term
      // is common, so weighting demotes it automatically and the question is
      // then carried by its other words. Short words are never widened: "pet"
      // must not become "pe".
      let files = out.split('\n').filter(Boolean);
      if (term.mode === 'fixed' && term.pattern.length >= 8 && files.length <= RARE_SUBJECT_DOCS) {
        const wide: SearchTerm = { pattern: term.pattern.slice(0, 4), mode: 'fixed' };
        const wideOut = await runRg(['-il', '--glob', '*.md', ...rgArgsFor(wide), '--', ...roots]);
        const wideFiles = wideOut.split('\n').filter(Boolean);
        if (wideFiles.length > files.length) {
          term = { ...wide, relaxed: true };
          files = wideFiles;
        }
      }
      return { term, files };
    }),
  );
  const files = new Map<string, { termHits: number; terms: SearchTerm[] }>();
  const termCounts = new Map<string, number>();
  for (const { term, files: hits } of perTerm) {
    termCounts.set(term.pattern, hits.length);
    for (const f of hits) {
      const cur = files.get(f) ?? { termHits: 0, terms: [] };
      cur.termHits += 1;
      cur.terms.push(term);
      files.set(f, cur);
    }
  }
  return { files, termCounts, effective: perTerm.map((p) => p.term) };
}

interface SidecarHit {
  source?: string;
  filename?: string;
  snippet?: string;
  similarity?: number;
  /** MOD #106d — the full chunk and a short anchor prefix, so a chunk can be
   *  located inside its file and ELECT the section that contains it. */
  text?: string;
  head?: string;
  /** Set when this hit came from a derived clause document (MOD #106e). */
  clause?: string;
}

export interface SemanticLegResult {
  hits: SidecarHit[] | null;
  /** Why the leg produced nothing: 'down' (unreachable/erroring) vs 'timeout'
   *  (alive, just slower than the spoken budget). The distinction is spoken:
   *  see vaultSearch. */
  reason?: 'down' | 'timeout';
}

/** Leg B — the warm mmrag sidecar. Returns hits:null (not []) when the sidecar
 *  did not answer, because "no answer" and "found nothing" must not look alike. */
export async function semanticLeg(query: string, roots: string[]): Promise<SemanticLegResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${MMRAG_SIDECAR_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 40, not 8. The sidecar's raw hits are dominated by transcripts and
      // scraped pages; measured 2026-08-09, asking for 8 left FIVE results
      // after the vault/memory post-filter and the right file was not among
      // them. At 40 the filter keeps ~70 and still returns in ~250ms.
      // The roots go WITH the request so the sidecar drops non-vault chunks
      // before serialising them. Returning all ~600 candidates' full text cost
      // ~1MB per query and put p95 at 4.2s.
      body: JSON.stringify({
        query,
        n_results: 40,
        source_prefixes: [...roots.map((r) => `${r}/`), `${DERIVED_ROOT}/`],
      }),
      signal: AbortSignal.timeout(MMRAG_SIDECAR_TIMEOUT_MS),
    });
    if (!res.ok) return { hits: null, reason: 'down' };
    const body = (await res.json()) as { ok?: boolean; results?: SidecarHit[] };
    if (!body.ok || !Array.isArray(body.results)) return { hits: null, reason: 'down' };
    // POST-FILTER. The uhs collection also holds transcripts, invoices, and
    // scraped pages; only the vault and the memory corpora are "what we know".
    // ATTRIBUTION: a derived clause hit is rewritten to the real agreement
    // before anything else sees it, so the answer, the sources array and the
    // spoken text all refer to the contract — never to a generated file.
    const derived = derivedIndex();
    const mapped: SidecarHit[] = [];
    for (const r of body.results) {
      const src = r.source ?? '';
      if (!src.endsWith('.md')) continue;
      const entry = derived.get(src);
      if (entry) {
        mapped.push({ ...r, source: entry.source, clause: entry.clause });
        continue;
      }
      if (roots.some((root) => src.startsWith(`${root}/`))) mapped.push(r);
    }
    return { hits: mapped };
  } catch (err) {
    // A deadline miss is not an outage. Anything at or past the budget is the
    // Gemini embedding call being slow; anything well short of it is the
    // sidecar refusing the connection.
    const timedOut =
      (err as Error)?.name === 'TimeoutError' ||
      Date.now() - started >= MMRAG_SIDECAR_TIMEOUT_MS - 50;
    return { hits: null, reason: timedOut ? 'timeout' : 'down' };
  }
}

export interface VaultSearchResult extends LaneResult {
  sources: string[];
  degraded: boolean;
}

export async function vaultSearch(query: string): Promise<VaultSearchResult> {
  const q = query.trim();
  if (!q) {
    return { ok: false, output: 'Ask what they want looked up.', sources: [], degraded: false };
  }

  let roots: string[];
  try {
    roots = knowledgeRoots();
  } catch (err) {
    return {
      ...unavailable('The knowledge base', (err as Error).message),
      sources: [],
      degraded: true,
    };
  }
  if (roots.length === 0) {
    return {
      ...unavailable('The knowledge base', 'no vault or memory directory exists at the configured path'),
      sources: [],
      degraded: true,
    };
  }

  const asked = searchTerms(q);
  // The normalized query goes to BOTH legs: the documents write "7.2" and
  // "$2,500", and the voice model is instructed to speak numbers as words.
  const normalized = normalizeSpokenNumbers(q);
  const [lex0, semantic] = await Promise.all([
    asked.length
      ? lexicalLeg(asked, roots)
      : Promise.resolve({
          files: new Map<string, { termHits: number; terms: SearchTerm[] }>(),
          termCounts: new Map<string, number>(),
          effective: [] as SearchTerm[],
        }),
    semanticLeg(normalized, roots),
  ]);
  // Score against the terms as actually searched — stem relaxation may have
  // shortened one of them, and scoring the un-relaxed form would find nothing.
  const terms = lex0.effective.length ? lex0.effective : asked;
  const policyQuestion = isPolicyQuestion(q);
  const lexical = lex0.files;
  const degraded = semantic.hits === null;
  // Only a sidecar that is genuinely DOWN is worth saying out loud. Since the
  // gate rewrite the semantic leg cannot introduce a result — it re-ranks what
  // ripgrep already found — so a deadline miss costs ordering, not coverage,
  // and announcing it would be narrating the machinery for no gain. An outage
  // is different: it is a fact about the system Scott should hear once.
  const degradedAloud = semantic.reason === 'down' ? ' Only the keyword index answered.' : '';

  // === MOD #106b — A TERM THE VAULT HAS NEVER SEEN IS THE ANSWER ============
  // Round 1 chose a "required" term as the rarest one WITH hits, so a term with
  // ZERO hits was silently excluded from the ballot. "policy on renting jet
  // skis" therefore guarded on "policy" — a word in half the vault — and
  // returned the mileage policy under a prompt that says "answer from that",
  // which is a confabulation instruction. If a real word of the question
  // appears nowhere in what we have written down, we do not have the answer.
  const unknownTerms = terms.filter((t) => (lex0.termCounts.get(t.pattern) ?? 0) === 0);
  if (unknownTerms.length > 0) {
    return {
      ok: true,
      degraded,
      sources: [],
      output:
        `Nothing in the vault on ${q}.` +
        degradedAloud +
        ' Say plainly that we have nothing written down on that, and offer to run the full lookup with ask_jarvis. Do not answer from any other document.',
    };
  }

  const semanticByPath = new Map<string, SidecarHit>();
  // MOD #106d: every chunk is kept, not just the file's best one. A chunk is
  // the unit the embedding actually scored, and which chunk matched decides
  // which SECTION answers — the whole point of the hybrid join.
  const chunksByPath = new Map<string, SidecarHit[]>();
  for (const hit of semantic.hits ?? []) {
    const src = hit.source ?? '';
    const prev = semanticByPath.get(src);
    if (!prev || (hit.similarity ?? 0) > (prev.similarity ?? 0)) semanticByPath.set(src, hit);
    chunksByPath.set(src, [...(chunksByPath.get(src) ?? []), hit]);
  }

  const candidates = new Set<string>([...lexical.keys(), ...semanticByPath.keys()]);
  const hits: VaultHit[] = [];

  // The word the corpus almost never uses is the word carrying the question.
  const requiredTerm = terms.length
    ? [...terms].sort(
        (a, b) => (lex0.termCounts.get(a.pattern) ?? 0) - (lex0.termCounts.get(b.pattern) ?? 0),
      )[0]
    : undefined;

  // === MOD #106c — not every word carries the question equally ==============
  // Round 2 counted a hit on "staging" (707 documents) the same as a hit on
  // "hvac" (3). That is why "do we work with section 8 housing" scored 30 on a
  // note about open houses — four common words, four hits, high score — while
  // real answers scored the same. Inverse document frequency is the standard
  // answer and it fixes both directions at once: it starves questions made
  // entirely of common words, and it lets one rare word carry a real answer.
  const corpusSize = Math.max(
    ...[...lex0.termCounts.values()].map((c) => c * 4),
    1_000,
  );
  const idf = (t: SearchTerm): number => {
    const df = lex0.termCounts.get(t.pattern) ?? 1;
    return Math.max(0.2, Math.log(corpusSize / (1 + df)));
  };

  /** The single word carrying the question: the rarest, by weight. A section
   *  that does not contain it is not answering this question, however much of
   *  the surrounding vocabulary it happens to own.
   *
   *  MOD #106f — modal and framing words are excluded from this choice, though
   *  they still score. They are rare enough to win on weight while naming
   *  nothing: "where are we ALLOWED to get listing photos" picked "allow" and
   *  answered from the file-hygiene protocol, and "how OFTEN do we post a blog"
   *  picked "often" and found nothing at all. The subject of those questions is
   *  photos and blogs. */
  const KEY_TERM_EXCLUDE = new Set([
    'allow', 'often', 'permit', 'suppos', 'abl', 'requir', 'need', 'usual',
    'typic', 'normal', 'general', 'ever', 'alway', 'never', 'still', 'actual',
    'suppose', 'able', 'require',
  ]);
  const keyCandidates = terms.filter((t) => !KEY_TERM_EXCLUDE.has(t.pattern));
  const keyTerm = (keyCandidates.length ? keyCandidates : terms).length
    ? [...(keyCandidates.length ? keyCandidates : terms)].sort((a, b) => idf(b) - idf(a))[0]
    : undefined;

  for (const file of candidates) {
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // === MOD #106g — an INDEX is a map, not a territory. MEMORY.md and the
    // extended-index files are lists of links to answers; retrieving one as
    // "the answer" produced the worst miss of the closing review (a card-
    // declines question answered with a dump of markdown links). Detected
    // structurally, not just by name, so future index files are covered too.
    const baseRaw = path.basename(file).toLowerCase();
    if (baseRaw === 'memory.md' || /extended[_-]?index/.test(baseRaw)) continue;
    {
      const lines = body.split('\n').filter((l) => l.trim().length > 0);
      const linkLines = lines.filter((l) => /^\s*[-|*]\s*\[[^\]]+\]\(/.test(l)).length;
      if (lines.length >= 15 && linkLines / lines.length > 0.6) continue;
    }
    const sem = semanticByPath.get(file);
    const lex = lexical.get(file);
    // Separators become spaces: a stem matches at a WORD START, and "_" is a
    // word character to a regex, so `\bpric` never matched inside
    // "reference_uhs_pricing_figures.md". Filename evidence was silently dead
    // for every underscore-named memory note until a unit test caught it.
    const base = path.basename(file).toLowerCase().replace(/[_\-.]+/g, ' ');
    // What the document says it IS: its title and the frontmatter `description`
    // every memory note carries. Far stronger evidence of what a file answers
    // than how often a word appears in its body.
    // MOD #106c: `name:` joins `description:` here. A memory note's name line is
    // its claim — "MLS Matrix is the sole photo source (not Zillow)" — and
    // leaving it out is why the canonical Zillow DECISION lost to an incidental
    // note about 3D tours.
    const identity = `${noteTitle(file, body)} ${body.match(/^name:\s*(.+)$/m)?.[1] ?? ''} ${
      body.match(/^description:\s*(.+)$/m)?.[1] ?? ''
    }`;
    // A document recording a settled decision is the canonical answer to "what
    // is our position / policy / rule on X", above any note that merely
    // discusses X. The vault marks these explicitly; honour the marker.
    const settledDecision = /decision \(locked|locked-in|non-negotiable|no exceptions|binding until/i.test(
      body.slice(0, 1200),
    );
    // MOD #106f — authority counts only for questions that ask what our policy
    // IS. Applied unconditionally it would put a standing rule above the
    // specific incident note that actually answers "what went wrong with X".
    const authoritative = policyQuestion && isAuthoritative(file, body);
    // MOD #106b: a document that says of itself that it is NOT ours is not our
    // answer. Honour the marker the document already carries rather than
    // blacklisting the filename of the Colorado mileage policy that kept winning.
    const provisional = /\bnot (?:yet )?adopted\b|\bunder review\b|\bfor reference only\b/i.test(
      body.slice(0, 800),
    );

    // MOD #106c: term hits are computed HERE, against the real text, rather than
    // taken from ripgrep. ripgrep's job is candidate generation; this is
    // scoring, and doing it directly is what lets a semantic-only candidate be
    // scored on the same footing as a lexical one.
    // === MOD #106d — CHUNKS ELECT SECTIONS ==================================
    // The embedding scored a 1,500-character chunk, not a file. Locating that
    // chunk inside the document tells us WHICH section the embedding actually
    // liked, so semantic evidence lands on the same unit as lexical evidence
    // and the two can be added instead of guessed between.
    const fileChunks = chunksByPath.get(file) ?? [];
    // Locate each chunk ONCE, by character offset in the same frontmatter-
    // stripped body the sections were cut from. Matching against section text
    // directly failed constantly — mmrag chunks a file from its raw start, so
    // chunk 0 begins inside the YAML block that sections do not contain, and
    // every such chunk silently fell back to a weak file-level similarity.
    const strippedBody = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
    const normBody = normalizeForMatch(strippedBody);
    const located: Array<{ at: number; sim: number }> = [];
    for (const c of fileChunks) {
      // Try several windows, not just the head. A chunk that begins inside the
      // YAML block starts with text the stripped body does not contain, so a
      // single head anchor located nothing and every memory note fell back to
      // the weak file-level similarity — which is why sims sat at 0.37-0.46
      // when the real chunk match was 0.7+.
      const full = normalizeForMatch(c.text ?? c.head ?? c.snippet ?? '');
      let at = -1;
      for (const from of [0, 150, 350, 700, 1100]) {
        if (from + 40 > full.length) break;
        const anchor = full.slice(from, from + 60);
        at = normBody.indexOf(anchor);
        if (at >= 0) {
          at = Math.max(0, at - from); // anchor offset → chunk start
          break;
        }
      }
      if (at >= 0) located.push({ at, sim: c.similarity ?? 0 });
    }
    // Offsets are into the NORMALISED body; scale them back to raw offsets so
    // they can be compared with section boundaries.
    const scale = normBody.length ? strippedBody.length / normBody.length : 1;
    // MOD #106e: a derived clause hit knows its clause NUMBER, so it elects its
    // section by identity rather than by text search — exact, and it works for
    // clauses whose title is their whole content ("5.2.5 Weapons and Valuables
    // Removed"), which are far too short to anchor by text.
    const clauseSims = new Map<string, number>();
    for (const c of fileChunks) {
      if (!c.clause) continue;
      clauseSims.set(c.clause, Math.max(clauseSims.get(c.clause) ?? 0, c.similarity ?? 0));
    }
    const simFor = (section: DocSection): { sim: number; clauseBacked: boolean } => {
      let textSim = 0;
      for (const l of located) {
        const at = l.at * scale;
        if (at >= section.start - 200 && at < section.end + 200) textSim = Math.max(textSim, l.sim);
      }
      const number = section.heading.match(/^(\d+(?:\.\d+)*)\b/)?.[1];
      // MOD #106g — sub-clauses corroborate their PARENT section. The section
      // splitter stops at the level the document's headings actually reach
      // ("5.2"), while derived clause docs go deeper ("5.2.5 Weapons"). A
      // strong match on 5.2.5 is evidence FOR the 5.2 section that contains
      // it — without the prefix walk, the weapons and HVAC clauses scored as
      // uncorroborated body text and declined.
      let clauseSim = 0;
      if (number) {
        for (const [cl, cs] of clauseSims) {
          if (cl === number || cl.startsWith(number + '.')) clauseSim = Math.max(clauseSim, cs);
        }
      }
      // MOD #106g — a derived CLAUSE doc is ~a sentence of precisely scoped
      // text; matching one at 0.6 is far stronger evidence than matching a
      // 1,500-char transcript chunk at 0.6. Election by clause counts as
      // corroboration at the floor even below the general trust threshold —
      // without this, §5.2.5 (weapons) and §5.2.3 (HVAC 74°F), whose answers
      // live in clause BODIES with mid-range similarity, decline.
      return {
        sim: Math.max(textSim, clauseSim),
        clauseBacked: clauseSim >= 0.6 && clauseSim >= textSim,
      };
    };
    // A chunk that straddles a heading boundary matches no section cleanly; the
    // file's best similarity is then a weak fallback rather than nothing.
    const fileSim = semanticByPath.get(file)?.similarity ?? 0;

    let best: {
      score: number;
      section: DocSection;
      covered: number;
      sim: number;
      /** Admitted on similarity alone, with no query word in the section. */
      rescued: boolean;
      keyStructural: boolean;
      clauseBacked: boolean;
    } | null = null;
    for (const section of splitSections(body)) {
      const { sim: sectionSim, clauseBacked } = simFor(section);
      const effectiveSim = sectionSim || fileSim * 0.6;
      let score = 0;
      let covered = 0;
      let coveredWeight = 0;
      let keyCovered = false;
      /** Key term found in the section HEADING, the document's NAME, or its
       *  self-description — and via an UNRELAXED pattern. Body mentions and
       *  vocabulary-guessed matches don't count as proof of aboutness. */
      let keyStructural = false;
      let headingHits = 0;
      for (const t of terms) {
        const inHeading = termHitsIn(section.heading, t);
        const inBase = termHitsIn(base, t);
        const inIdentity = termHitsIn(identity, t);
        const inBody = termHitsIn(section.text, t);
        if (!inHeading && !inBase && !inIdentity && !inBody) continue;
        covered += 1;
        coveredWeight += idf(t);
        if (inHeading) headingHits += 1;
        if (keyTerm && t.pattern === keyTerm.pattern) {
          keyCovered = true;
          if (!t.relaxed && (inHeading || inBase || inIdentity)) keyStructural = true;
        }
        // Where a word appears says what it means: in the heading of the very
        // section under discussion, or in the document's own name, it is the
        // subject; in the body it is a mention. And WHICH word it is matters
        // more still — see idf().
        const placement =
          (inHeading ? 4 : 0) + (inBase ? 3 : 0) + (inIdentity ? 2 : 0) + (inBody ? 1 : 0) +
          // A clause NUMBER in a heading means this section IS that clause.
          // Without this, "section seven point two" ranked a note that merely
          // cites §7.2 above the agreement whose own heading is 7.2.
          // A clause NUMBER in a heading is a near-exact match: this section
          // IS §7.2. Without a decisive weight here, a note that merely CITES
          // §7.2 outranked the agreement whose own heading is 7.2.
          (inHeading && t.mode === 'regex' ? 12 : 0);
        // The key word is the question; weight it accordingly.
        score += idf(t) * placement * (keyTerm && t.pattern === keyTerm.pattern ? 1.5 : 1);
      }
      if (covered === 0) continue;
      // Two of the question's words in ONE heading is aboutness, not breadth:
      // "Post Installation Notice to Terminate" answers "how many days notice
      // to terminate", where §2.1 Automatic Renewal merely mentions both words
      // somewhere in a long section — and answers "thirty days" for a ten-day
      // requirement.
      if (headingHits >= 2) score *= 1.6;
      // The word that carries the question must be IN the section. Without
      // this, "what is the pet policy in the staging contract" was answered by
      // the staging agreement — which covers "staging", "contract" and "policy"
      // in its own title and has no pet clause at all. Covering only the words
      // a document is trivially about is not covering the question.
      // A CONFIDENT CHUNK MAY CARRY THE SECTION. This is the recall half of
      // the hybrid: "how honest do we have to be about marketing STATISTICS"
      // cannot match a note that says "stats", and no amount of stemming makes
      // every paraphrase reachable. Above the rescue floor the embedding is
      // evidence in its own right; every decoy the critics caught scored
      // 0.60-0.74, so the bar sits deliberately above them.
      // MOD #106e RETIRED the similarity-only bypass. It existed for paraphrase
      // recall, but chunk-level election now delivers that (a clause elects its
      // own section, so "does the client have to remove weapons" reaches 5.2.5
      // WITH the word "weapons" in it). What the bypass still did was let a
      // question's vocabulary go unmatched entirely — which is how "pet policy
      // in the staging contract" got answered by contract clauses matching
      // "policy" and "contract" at 0.72. A query word must land somewhere.
      if (keyTerm && !keyCovered) continue;
      // Coverage SCALES the evidence rather than adding to it — as an additive
      // bonus it handed "are we a one stop shop for sellers" 46 points for four
      // incidental body hits. And it is measured by WEIGHT, not by count: the
      // canonical "MLS not Zillow" decision covers the only word that matters
      // in "what is our position on Zillow" and should not be halved for
      // missing the filler word, which is exactly how it lost to a note about
      // 3D tours.
      // MOD #106c round 2 of tuning: coverage is a modest modifier, not a
      // multiplier that lets a long section win on breadth. "how many days
      // notice to terminate" picked §2.1 Automatic Renewal — a long section
      // touching every word of the question — over §7.2, whose HEADING is
      // "Post Installation Notice to Terminate". Breadth is not aboutness.
      const totalWeight = terms.reduce((a, t) => a + idf(t), 0) || 1;
      score *= 0.5 + 0.5 * (coveredWeight / totalWeight);
      // The join: semantic points on the same scale as lexical ones. Similarity
      // below SEMANTIC_BASE is noise on this corpus (everything scores ~0.5),
      // so only the part above it counts.
      score += Math.max(0, effectiveSim - SEMANTIC_BASE) * SEMANTIC_GAIN;
      // MOD #106e — STRONG semantic support is direct evidence that THIS
      // section answers the question, and it has to be able to outweigh sheer
      // lexical bulk. A long note that happens to use "tenant" and "staging" a
      // dozen times was scoring 60 on word count while clause 7.5, which is
      // literally titled "Termination Prior to Tenant Occupancy", sat lower.
      // Raw material is excluded: a transcript matching at 0.72 is still not a
      // written policy, and boosting it would undo the pet-policy decline.
      // ...and ONLY when a real query word also landed here. Without that
      // condition the boost resurrected the pet policy: "pet policy in the
      // staging contract" matches contract clauses at 0.72 all day long, on the
      // strength of "policy" and "contract" alone, and the contract has no pet
      // clause. Strong semantics AMPLIFY a lexical anchor; they do not replace one.
      if (
        effectiveSim >= SEMANTIC_RESCUE_FLOOR &&
        keyCovered &&
        !/\/(transcripts|sessions|raw)\//.test(file)
      ) {
        score *= 1.6;
      }
      if (!best || score > best.score) {
        best = { score, section, covered, sim: effectiveSim, rescued: !keyCovered, keyStructural, clauseBacked };
      }
    }
    if (!best) continue;

    let score = best.score;
    // MOD #106d: the file-level similarity bonus is GONE — semantic evidence is
    // now joined at section level, where it belongs. Only the agreement bonus
    // survives, and only as a tie-breaker.
    if (lex && sem) score *= 1.05;
    // A settled decision is the canonical answer ABOUT ITS OWN SUBJECT — only
    // when the question's key word is what the document is named for.
    if (settledDecision && keyTerm && termHitsIn(identity, keyTerm)) score *= 1.4;
    if (authoritative) score *= AUTHORITY_WEIGHT;
    if (provisional) score *= 0.6;
    // Transcripts, session logs and raw captures are RAW MATERIAL, not written
    // knowledge. They are long, they mention everything once, and they were the
    // source of several confident wrong answers — the CE-class recording
    // standing in for a pet policy we do not have. They can still answer when
    // nothing else does; they just stop outranking documents we authored.
    // MOD #106g — the trillion-prompts library is agent-prompt REFERENCE
    // material. "do we accept bitcoin payments" was answered from a
    // btc-mining-tracker prompt template: about bitcoin, not about us.
    const rawMaterial = /\/(transcripts|sessions|raw)\/|\/external\/trillion-prompts\//.test(file);
    // MOD #106g — vault/research/ holds surveys of OTHER people's ideas (the
    // smart-glasses landscape, the Colorado mileage policy). One of them
    // answered "how much is a consultation" because its title says
    // "Consultation Capture". Research informs; it does not speak for UHS.
    const researchMaterial = /\/vault\/research\//.test(file);
    if (rawMaterial) score *= 0.55;
    if (researchMaterial) score *= 0.6;

    hits.push({
      path: file,
      title: noteTitle(file, body),
      snippet: bestPassage(
        best.section.heading ? `# ${best.section.heading}\n${best.section.text}` : best.section.text,
        terms.length ? terms : [{ pattern: normalized, mode: 'fixed' as const }],
      ),
      score,
      raw: rawMaterial,
      rescued: best.rescued,
      keyStructural: best.keyStructural,
      clauseBacked: best.clauseBacked,
      similarity: best.sim,
      legs: lex && sem ? 'both' : lex ? 'lexical' : 'semantic',
    });
  }

  // === MOD #106c — the semantic leg gets a narrow way back in. ===
  // Round 2 made it a pure re-ranker, which was honest but cost recall: a
  // question phrased in words the document never uses ("how honest do we have
  // to be about marketing STATISTICS" against a note that says "stats") was
  // unreachable. A very confident embedding is real evidence — every decoy the
  // critics caught scored 0.60-0.74, so the bar sits above them. Below it, a
  // semantic-only hit still cannot carry a result.
  const rescued = hits.filter(
    (h) => h.legs !== 'semantic' || (h.similarity ?? 0) >= SEMANTIC_RESCUE_FLOOR,
  );
  hits.length = 0;
  hits.push(...rescued.sort((a, b) => b.score - a.score));

  // MOD #106c RETIRED the rare-word-subject decline. It was a blunt proxy for
  // "nobody wrote about this", and it cost real answers: "marketing STATISTICS"
  // and "what temperature should the HVAC be" both declined because their rare
  // word appears only in body text — in the right document, saying the right
  // thing. Term weighting plus the floor below now separate an incidental
  // mention from a subject, on evidence rather than on a document count.

  // === MOD #106d — the floor now depends on WHAT KIND of evidence won. =====
  // A section the embeddings never saw at all (similarity exactly zero) won on
  // word overlap alone, and word overlap alone is what "do we work with section
  // 8 housing" and "are we a one stop shop for sellers" produce — every word
  // common, no anchor, no meaning. Those need to clear a much higher bar.
  // Raw material — transcripts, session logs — is held to the same high bar
  // however well it embeds: a recording that says "pet" once, and matches a pet
  // question at 0.72, still is not a written policy we can quote back.
  // MOD #106g — the closing review measured the miss mode: 6 of 8 misses
  // returned an UNRELATED document rather than declining, because weak-but-
  // nonzero semantic support (decoys live at 0.55-0.70) plus body-only word
  // overlap cleared the supported floor. Support now means CORROBORATION:
  // the embedding genuinely trusts the section, OR the question's key word is
  // structurally what the document is about (unrelaxed), OR a derived clause
  // doc elected the section. Everything else faces the unsupported bar.
  //
  // And the floor is PER-HIT eligibility, not a guillotine on the winner: a
  // topically-adjacent decoy outranking the real clause must not take the
  // real clause down with it. Each hit passes or fails on its own evidence;
  // the answer is the best hit that passes; decline only when none do.
  const passesFloor = (h: VaultHit): boolean => {
    const corroborated =
      (h.similarity ?? 0) >= SEMANTIC_TRUST_FLOOR ||
      h.keyStructural === true ||
      h.clauseBacked === true;
    const unsupported =
      (h.similarity ?? 0) === 0 || h.raw === true || h.rescued === true || !corroborated;
    return h.score >= (unsupported ? RELEVANCE_FLOOR_UNSUPPORTED : RELEVANCE_FLOOR);
  };
  if (process.env.VAULT_SEARCH_DEBUG === '1') {
    for (const h of hits.slice(0, 6)) {
      console.log(
        `[vault_search:pre-floor] ${path.basename(h.path)} score=${h.score.toFixed(1)} sim=${(h.similarity ?? 0).toFixed(2)} ` +
          `keyStruct=${h.keyStructural} clause=${h.clauseBacked} raw=${h.raw} rescued=${h.rescued} pass=${passesFloor(h)}`,
      );
    }
  }
  const eligible = hits.filter(passesFloor);
  hits.length = 0;
  hits.push(...eligible);

  if (process.env.VAULT_SEARCH_DEBUG === '1') {
    console.log(
      `[vault_search] ${q} | terms=${terms.map((t) => `${t.pattern}:${t.mode}:${lex0.termCounts.get(t.pattern) ?? 0}`).join(',')} | ` +
        `key=${keyTerm?.pattern} | ` +
        hits
          .slice(0, 5)
          .map((h) => `${path.basename(h.path)}=${h.score.toFixed(1)}(${h.legs},sim=${(h.similarity ?? 0).toFixed(2)})`)
          .join(' '),
    );
  }

  if (hits.length === 0) {
    return {
      ok: true,
      degraded,
      sources: [],
      output:
        `Nothing in the vault on ${q}.` +
        degradedAloud +
        ' Say that plainly and offer to run the full lookup with ask_jarvis.',
    };
  }

  // Passage two is company for passage one, not a consolation prize. If the
  // runner-up scores far below the winner it is a decoy, and handing it to the
  // model only gives it something wrong to blend in.
  const top = hits
    .slice(0, 2)
    .filter((h, i) => h.snippet && (i === 0 || h.score >= hits[0].score * 0.45));
  const passages = top.map((h) => `${h.title}: ${h.snippet}`).join(' || ');
  const shaping =
    ' — Answer the question from that, in one or two sentences, forty words maximum. ' +
    'Never read a file name, path, or URL aloud.';
  return {
    ok: true,
    degraded,
    sources: hits.slice(0, 5).map((h) => h.path),
    output: `${passages}${degradedAloud ? ` ||${degradedAloud}` : ''}${shaping}`,
  };
}

// --- project_status ----------------------------------------------------------
// worklist.json + TODO.md, both plain files on this disk. No credentials, no
// network. "What am I working on" was a 30-second ask_jarvis round trip to read
// a file the dashboard process can open in a millisecond.

export interface WorklistTask {
  id?: string;
  title?: string;
  description?: string;
  dependencies?: string[];
  completion_criteria?: string[];
  testing_criteria?: string[];
  status?: string;
  priority?: string;
  notes?: string;
}

const DONE_STATUSES = new Set(['complete', 'completed', 'done']);

export function readWorklist(): WorklistTask[] | null {
  try {
    const raw = fs.readFileSync(path.join(jarvisRoot(), 'worklist.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { tasks?: WorklistTask[] } | WorklistTask[];
    const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;
    return Array.isArray(tasks) ? tasks : null;
  } catch {
    return null;
  }
}

/** Loose match of a spoken phrase against one task. Same shape as the contract
 *  ranker: whole-phrase hits dominate, individual tokens accumulate. */
export function scoreTask(task: WorklistTask, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  // Coerced, not trusted: worklist.json is hand-edited and some ids are bare
  // numbers, which crashed the lane live ("task.id.toLowerCase is not a
  // function") the first time anyone asked about one task by name.
  const id = String(task.id ?? '');
  const hay = `${id} ${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
  let score = 0;
  if (hay.includes(q)) score += 100;
  for (const t of q.split(/\s+/).filter((t) => t.length > 2)) {
    if (hay.includes(t)) score += 10;
  }
  if (id.toLowerCase() === q) score += 200;
  return score;
}

export async function projectStatus(query?: string): Promise<LaneResult> {
  let root: string;
  try {
    root = jarvisRoot();
  } catch (err) {
    return unavailable('Project status', (err as Error).message);
  }
  const tasks = readWorklist();
  if (!tasks) {
    return unavailable('Project status', 'the work list could not be read from disk');
  }

  const q = query?.trim() ?? '';
  if (q) {
    const ranked = tasks
      .map((t) => ({ t, score: scoreTask(t, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) {
      return { ok: true, output: `Nothing on the work list matches ${q}.` };
    }
    if (ranked.length > 1 && ranked[1].score >= ranked[0].score * 0.9) {
      const names = ranked.slice(0, 3).map((x) => x.t.title ?? x.t.id ?? 'untitled');
      return {
        ok: true,
        output: `${ranked.length} tasks match: ${spokenList(names)}. Ask which one they mean.`,
      };
    }
    const t = ranked[0].t;
    const status = (t.status ?? 'unknown').replace(/[-_]/g, ' ');
    let out = `${t.title ?? t.id}: ${status}.`;
    const openDeps = (t.dependencies ?? []).map(String).filter((d) => {
      const dep = tasks.find((x) => String(x.id ?? '') === d);
      return dep && !DONE_STATUSES.has((dep.status ?? '').toLowerCase());
    });
    if (openDeps.length) out += ` Blocked on ${spokenList(openDeps)}.`;
    else if (t.notes?.trim()) out += ` ${t.notes.trim().slice(0, 160)}`;
    return { ok: true, output: out };
  }

  const counts = new Map<string, number>();
  for (const t of tasks) {
    const s = (t.status ?? 'unknown').toLowerCase();
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const done = [...counts.entries()]
    .filter(([s]) => DONE_STATUSES.has(s))
    .reduce((a, [, n]) => a + n, 0);
  const next = tasks.find((t) => (t.status ?? '').toLowerCase() === 'incomplete');
  const blocked = counts.get('blocked') ?? 0;

  let out = `${done} of ${tasks.length} work-list tasks complete`;
  out += blocked ? `, ${blocked} blocked.` : '.';
  if (next) out += ` Next up: ${next.title ?? next.id}.`;
  // TODO.md is the human-maintained companion; its absence is not an error, but
  // a stale one is worth flagging rather than quietly speaking old news.
  try {
    const stat = fs.statSync(path.join(root, 'TODO.md'));
    const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86_400_000);
    if (ageDays > 14) out += ` The task file hasn't been touched in ${ageDays} days.`;
  } catch {
    /* no TODO.md — fine */
  }
  return { ok: true, output: out };
}
// === END JARVIS MOD #106 ===
