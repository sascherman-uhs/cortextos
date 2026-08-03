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
  return d.toLocaleDateString('en-US', {
    ...(dateOnly ? {} : { timeZone: PT }),
    month: 'long',
    day: 'numeric',
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
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
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
  const keyOf = (e: GCalEvent) =>
    e.start?.dateTime ? ptDateKey(new Date(e.start.dateTime)) : (e.start?.date ?? '');

  const today = items.filter((e) => keyOf(e) === todayKey);
  const tomorrow = items.filter((e) => keyOf(e) === tomorrowKey);

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

  if (row.destage_date) {
    return `${head}: removal already scheduled for ${spokenDate(row.destage_date)}.`;
  }
  // Pre-install: the term starts the day after install, so the later dates do
  // not exist yet. Saying "no notice date" would read as a data problem; this
  // is the contract working as written.
  if (!row.contract_end_date) {
    const staged = row.stage_date ? `installs ${spokenDate(row.stage_date)}` : 'has no install date set';
    return `${head} ${staged}. Paid-through and notice dates are set once it's staged.`;
  }

  const notice = noticeDate(row.contract_end_date);
  const daysToNotice = Math.round(
    (new Date(`${notice}T12:00:00`).getTime() - Date.now()) / 86_400_000,
  );
  const bits: string[] = [];
  if (row.stage_date) bits.push(`staged ${spokenDate(row.stage_date)}`);
  bits.push(`paid through ${spokenDate(row.contract_end_date)}`);
  bits.push(`notice to terminate by ${spokenDate(notice)}`);

  let out = `${head}: ${spokenList(bits)}.`;
  // The number Scott actually acts on — surfaced only when it's decision-time.
  if (daysToNotice < 0) {
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

  const endpoint = new URL(`${url.replace(/\/$/, '')}/rest/v1/projects`);
  endpoint.searchParams.set('select', CONTRACT_SELECT);
  endpoint.searchParams.set('status', `in.(${OPEN_STATUSES.join(',')})`);
  endpoint.searchParams.set('limit', '300');

  let rows: ContractRow[];
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      return unavailable('Contract lookup', `the projects table returned status ${res.status}`);
    }
    const body = (await res.json()) as ContractRow[] | { message?: string };
    if (!Array.isArray(body)) {
      return unavailable('Contract lookup', 'the projects table returned an unexpected shape');
    }
    rows = body;
  } catch {
    return unavailable('Contract lookup', 'the projects table could not be reached');
  }

  const ranked = rows
    .map((r) => ({ r, score: scoreContract(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return { ok: true, output: `No open contract matches ${query}.` };
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
  return { ok: true, output: spokenContract(ranked[0].r) };
}
// === END JARVIS MOD #52 ===
