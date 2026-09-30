/**
 * Submission proof from Claude Code's own session record (V5-1, R4-1, R4-5).
 *
 * Why this exists (2026-09-30). The daemon decided "did the agent get this
 * Telegram message?" by looking for the block's header in the PTY output. At
 * 05:38 Claude Code rendered a long paste COLLAPSED as `[Pasted text #1 +9
 * lines]`, the header never appeared, and Scott was told "I may have missed
 * your message" about a photo that was sitting in the agent's input box. The
 * terminal is a rendering, not a record. Claude Code's session JSONL
 * (`~/.claude/projects/<cwd-slug>/*.jsonl`) is the record: every prompt it
 * accepted is written there with its provenance.
 *
 * Proof = an entry carrying the update's unique token (`⟦u:<update_id>⟧`,
 * emitted by every Telegram formatter) that is one of:
 *   - a GENUINE submitted prompt: `type:"user"` with origin.kind "human",
 *     turnOrigin "human", promptSource present, no toolUseResult /
 *     sourceToolAssistantUUID, not a compaction summary, not transcript-only,
 *     not meta, not a sidechain, and no tool_result content part;
 *   - a `queued_command` attachment with origin.kind "human", humanTurn true,
 *     commandMode "prompt" — how Claude Code records a prompt submitted while a
 *     turn was running and absorbed into that turn. 23 of the 49 Telegram
 *     pastes in jarvis-telegram's 9/28–9/29 session exist ONLY in this form; a
 *     `type:"user"`-only rule would have called every one of them stuck;
 *   - (submission only, not consumption) a `queue-operation` `enqueue` entry:
 *     written the moment the composer accepted Enter while a turn was running.
 *     It proves the paste was submitted, not that the model has read it — and
 *     only when its text IS our block (enqueue rows carry no provenance; task
 *     notifications are enqueued too — enqueueIsOurPaste).
 * Anything else — tool results that echo the token, compaction summaries,
 * sidechains, entries whose provenance fields are missing (a future Claude
 * Code schema) — proves nothing, and "nothing found" means UNKNOWN, never
 * "dropped".
 *
 * Search scope is every `*.jsonl` in the agent's project dir, NOT one bound
 * session: several agents and interactive sessions share the uhsJARVIS cwd, and
 * the token is unique per update, so binding is unnecessary (and binding by
 * mtime would be wrong). Each scan fully re-reads every file modified since the
 * attempt started (R4-5: no byte cursors — idempotent by construction). A
 * partial trailing line is ignored until it is complete. Parsed per-file
 * results may be cached keyed by (dev, ino, size, mtime_ns), with a FULL
 * re-read on any change — never a partial read.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { claudeProjectSlug } from '../bus/model-registry.js';

/** The per-update identity token every Telegram formatter puts in its header line. */
export function telegramToken(updateId: number | string): string {
  return `⟦u:${updateId}⟧`;
}

/**
 * PTY text normalized for needle matching (A1): every CSI / OSC / other escape
 * sequence and ALL whitespace removed. The current TUI draws spaces as cursor
 * moves and wraps long lines, so neither spaces nor line breaks survive into
 * the log — compare with both sides normalized.
 */
export function normalizePtyText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=!]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\s+/g, '');
}

/** Any Telegram token — used to decide which prompt texts are worth caching. */
const TOKEN_PREFIX = '⟦u:';
/** Boot prompts carry `Current UTC time: <iso>` — unique per spawn (see bootMarkerFromPrompt). */
const BOOT_MARKER_PREFIX = 'Current UTC time: ';

/**
 * The unique marker of a spawn's boot prompt, e.g.
 * "Current UTC time: 2026-09-30T12:36:53.749Z". Both the fresh and the
 * continue prompt carry it, with a millisecond timestamp taken at spawn.
 */
export function bootMarkerFromPrompt(prompt: string): string | null {
  const m = prompt.match(/Current UTC time: (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/);
  return m ? `${BOOT_MARKER_PREFIX}${m[1]}` : null;
}

/** `~/.claude/projects/<slug>` for a launch cwd (same slug rule as model-registry). */
export function claudeProjectDirFor(cwd: string, projectsRoot = join(homedir(), '.claude', 'projects')): string {
  return join(projectsRoot, claudeProjectSlug(cwd));
}

export type EvidenceKind = 'prompt' | 'queued_command' | 'enqueue';

export interface TranscriptEvidence {
  kind: EvidenceKind;
  /** Entry uuid; enqueue entries have none, so one is derived from session + timestamp. */
  uuid: string;
  ts: number;
  text: string;
  file: string;
}

interface FileParse {
  /** Evidence whose text carries a token or a boot marker — nothing else can ever match. */
  evidence: TranscriptEvidence[];
  /** Turn-end timestamps (system turn_duration / stop_hook_summary). */
  turnEnds: number[];
  /** Genuine prompts seen (any text) and the latest one's timestamp — schema self-check. */
  genuineCount: number;
  latestGenuineTs: number;
}

export interface ScanSnapshot {
  files: Map<string, FileParse>;
  durationMs: number;
  filesRead: number;
  filesConsidered: number;
  /** Set when the project dir itself could not be listed. */
  error?: string;
}

/** Substrings a line must contain to be worth JSON-parsing at all (all ASCII keys). */
const LINE_NEEDLES = ['"promptSource"', '"queued_command"', '"queue-operation"', '"turn_duration"', '"stop_hook_summary"'].map(
  (s) => Buffer.from(s, 'utf-8'),
);

function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') return null;
    const type = (p as { type?: unknown }).type;
    // A tool_result part means this "user" entry is the harness handing a tool
    // result back to the model — the classic false positive (lines 84/89 of the
    // recorded session). Never a submitted prompt.
    if (type === 'tool_result') return null;
    if (type === 'text' && typeof (p as { text?: unknown }).text === 'string') parts.push((p as { text: string }).text);
  }
  return parts.join('\n');
}

type Classified =
  | { kind: EvidenceKind; uuid: string; ts: number; text: string; genuine: boolean }
  | { kind: 'turn_end'; ts: number }
  | null;

/**
 * Classify one parsed JSONL entry. Exported for tests: every provenance rule
 * lives here and nowhere else.
 */
export function classifyEntry(e: unknown): Classified {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (Number.isNaN(ts)) return null;
  if (o.isSidechain === true || o.isMeta === true) return null;

  if (o.type === 'system' && (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary')) {
    return { kind: 'turn_end', ts };
  }

  if (o.type === 'user') {
    if (o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return null;
    if ('toolUseResult' in o || 'sourceToolAssistantUUID' in o) return null;
    const origin = o.origin as { kind?: unknown } | undefined;
    // Positive provenance: every one of these must be present. Missing fields
    // (an older or newer Claude Code) => not proof. Never guess.
    if (!origin || origin.kind !== 'human') return null;
    if (o.turnOrigin !== 'human') return null;
    if (typeof o.promptSource !== 'string' || !o.promptSource) return null;
    if (typeof o.uuid !== 'string' || !o.uuid) return null;
    const msg = o.message as { content?: unknown } | undefined;
    const text = textOfContent(msg?.content);
    if (text === null) return null;
    return { kind: 'prompt', uuid: o.uuid, ts, text, genuine: true };
  }

  if (o.type === 'attachment') {
    const a = o.attachment as Record<string, unknown> | undefined;
    if (!a || a.type !== 'queued_command') return null;
    const origin = a.origin as { kind?: unknown } | undefined;
    if (!origin || origin.kind !== 'human') return null;
    if (a.humanTurn !== true || a.commandMode !== 'prompt') return null;
    if (typeof a.prompt !== 'string') return null;
    if (typeof o.uuid !== 'string' || !o.uuid) return null;
    return { kind: 'queued_command', uuid: o.uuid, ts, text: a.prompt, genuine: true };
  }

  if (o.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string') {
    const sid = typeof o.sessionId === 'string' ? o.sessionId : '?';
    return { kind: 'enqueue', uuid: `enqueue:${sid}:${o.timestamp as string}`, ts, text: o.content, genuine: false };
  }
  return null;
}

/** Parse one whole file. Only complete lines; the prefilter only skips lines no rule can match. */
export function parseTranscriptBuffer(buf: Buffer, file: string): FileParse {
  const out: FileParse = { evidence: [], turnEnds: [], genuineCount: 0, latestGenuineTs: 0 };
  const lineStarts = new Set<number>();
  // A partial trailing line (no terminating newline yet) is ignored until complete.
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return out;
  for (const needle of LINE_NEEDLES) {
    let at = buf.indexOf(needle, 0);
    while (at >= 0 && at < end) {
      const start = at === 0 ? 0 : buf.lastIndexOf(0x0a, at - 1) + 1;
      lineStarts.add(start);
      const nl = buf.indexOf(0x0a, at);
      at = nl < 0 ? -1 : buf.indexOf(needle, nl + 1);
    }
  }
  for (const start of [...lineStarts].sort((a, b) => a - b)) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0 || nl > end) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf-8', start, nl));
    } catch {
      continue;
    }
    const c = classifyEntry(parsed);
    if (!c) continue;
    if (c.kind === 'turn_end') {
      out.turnEnds.push(c.ts);
      continue;
    }
    if (c.genuine && c.kind === 'prompt') {
      out.genuineCount++;
      if (c.ts > out.latestGenuineTs) out.latestGenuineTs = c.ts;
    }
    if (c.text.includes(TOKEN_PREFIX) || c.text.includes(BOOT_MARKER_PREFIX)) {
      out.evidence.push({ kind: c.kind, uuid: c.uuid, ts: c.ts, text: c.text, file });
    }
  }
  return out;
}

export interface SubmissionFinding {
  /** 'consumed' = the model has the text; 'submitted' = the composer accepted Enter. */
  phase: 'consumed' | 'submitted';
  evidence: TranscriptEvidence;
}

export class ClaudeTranscriptScanner {
  readonly projectDir: string;
  readonly cacheEnabled: boolean;
  private cache = new Map<string, { key: string; parse: FileParse }>();
  private durations: number[] = [];
  private log: (msg: string) => void;

  constructor(projectDir: string, opts: { cache?: boolean; log?: (msg: string) => void } = {}) {
    this.projectDir = projectDir;
    this.cacheEnabled = opts.cache ?? true;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Fully re-read every top-level `*.jsonl` whose mtime is >= sinceMs (less a
   * small skew). Cached parses are reused only when (dev, ino, size, mtime_ns)
   * are all unchanged; any change means a full re-read of that file.
   */
  scan(sinceMs: number): ScanSnapshot {
    const t0 = performance.now();
    const snap: ScanSnapshot = { files: new Map(), durationMs: 0, filesRead: 0, filesConsidered: 0 };
    let names: string[];
    try {
      names = readdirSync(this.projectDir).filter((n) => n.endsWith('.jsonl'));
    } catch (err) {
      snap.error = `cannot list ${this.projectDir}: ${String(err)}`;
      snap.durationMs = performance.now() - t0;
      return snap;
    }
    const seen = new Set<string>();
    for (const n of names) {
      const path = join(this.projectDir, n);
      let st;
      try {
        st = statSync(path, { bigint: true });
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      // mtime_ns → ms for the window test; the window is widened by 2 s so a
      // write in the same second as attempt_started_at is never skipped.
      if (Number(st.mtimeNs / 1_000_000n) < sinceMs - 2_000) continue;
      snap.filesConsidered++;
      seen.add(path);
      const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
      const hit = this.cacheEnabled ? this.cache.get(path) : undefined;
      if (hit && hit.key === key) {
        snap.files.set(path, hit.parse);
        continue;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(path);
      } catch {
        continue;
      }
      snap.filesRead++;
      const parse = parseTranscriptBuffer(buf, path);
      if (this.cacheEnabled) this.cache.set(path, { key, parse });
      snap.files.set(path, parse);
    }
    // Forget files that fell out of the window or vanished.
    for (const p of [...this.cache.keys()]) if (!seen.has(p)) this.cache.delete(p);
    snap.durationMs = performance.now() - t0;
    this.durations.push(snap.durationMs);
    if (this.durations.length > 500) this.durations.shift();
    return snap;
  }

  /** p95 of recent scan durations (ms), for the log line and the R4-5 measurement. */
  p95(): number {
    if (this.durations.length === 0) return 0;
    const s = [...this.durations].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
  }

  scanCount(): number {
    return this.durations.length;
  }
}

/**
 * Per-attempt filters over a snapshot (R4-1): the entry carries the token, its
 * own timestamp is >= the attempt start (so copied/replayed history cannot
 * count), and its uuid is not one this record already counted. A consuming
 * entry (prompt / queued_command) wins over an enqueue; earliest first.
 */
export function findSubmission(
  snap: ScanSnapshot,
  token: string,
  attemptStartedAtMs: number,
  countedUuids: readonly string[] = [],
): SubmissionFinding | null {
  let consumed: TranscriptEvidence | null = null;
  let submitted: TranscriptEvidence | null = null;
  for (const parse of snap.files.values()) {
    for (const ev of parse.evidence) {
      if (ev.ts < attemptStartedAtMs) continue;
      if (countedUuids.includes(ev.uuid)) continue;
      if (!ev.text.includes(token)) continue;
      if (ev.kind === 'enqueue') {
        // An enqueue row carries no provenance at all, and task notifications
        // and agent messages are enqueued the same way (18 of 44 in the real
        // previous session). It corroborates a submission only when the queued
        // text IS our paste — see enqueueIsOurPaste.
        if (!enqueueIsOurPaste(ev.text, token)) continue;
        if (!submitted || ev.ts < submitted.ts) submitted = ev;
      } else if (!consumed || ev.ts < consumed.ts) {
        consumed = ev;
      }
    }
  }
  if (consumed) return { phase: 'consumed', evidence: consumed };
  if (submitted) return { phase: 'submitted', evidence: submitted };
  return null;
}

/**
 * Does this queued composer text consist of OUR block? True only when it
 * starts — after an optional `<pasted_content id="…">` wrapper, which is how
 * Claude Code records a paste — with a `=== TELEGRAM` header line carrying the
 * token. A task notification (`<task-notification>…`) or agent message
 * (`<agent-message …>`) that merely echoes the token somewhere in its body can
 * never match: its text starts with its own tag.
 */
export function enqueueIsOurPaste(text: string, token: string): boolean {
  const body = text.replace(/^\s*(?:<pasted_content\b[^>]*>\s*)?/, '');
  if (!body.startsWith('=== TELEGRAM')) return false;
  const nl = body.indexOf('\n');
  const header = nl < 0 ? body : body.slice(0, nl);
  return header.includes(token);
}

/**
 * Boot readiness for ONE spawn (R4-4): this spawn's boot prompt (identified by
 * its unique `Current UTC time:` marker) was recorded as a genuine prompt, and
 * a turn-end entry follows it in the same file. That is Claude Code itself
 * saying the boot turn finished — the only reliable "at prompt" signal
 * available: the PTY heuristic (isAtPrompt) matched 0 of 125 injections on
 * 2026-09-24..30 because the current TUI draws `❯` and elides spaces.
 */
export function bootTurnEnded(snap: ScanSnapshot, marker: string): { ready: boolean; promptTs?: number; turnEndTs?: number } {
  for (const parse of snap.files.values()) {
    const boot = parse.evidence.find((ev) => ev.kind === 'prompt' && ev.text.includes(marker));
    if (!boot) continue;
    const after = parse.turnEnds.filter((t) => t >= boot.ts).sort((a, b) => a - b)[0];
    if (after !== undefined) return { ready: true, promptTs: boot.ts, turnEndTs: after };
    return { ready: false, promptTs: boot.ts };
  }
  return { ready: false };
}

/** Latest genuine prompt timestamp in a snapshot (0 = none) — the schema self-check. */
export function latestGenuinePrompt(snap: ScanSnapshot): number {
  let t = 0;
  for (const p of snap.files.values()) if (p.latestGenuineTs > t) t = p.latestGenuineTs;
  return t;
}

/**
 * One scanner per project dir, shared by every checker in the daemon: several
 * agents launch in the same cwd, and scanning the same files once per agent
 * would multiply the cost for nothing.
 */
const sharedScanners = new Map<string, ClaudeTranscriptScanner>();
export function sharedScanner(projectDir: string, log?: (msg: string) => void): ClaudeTranscriptScanner {
  let s = sharedScanners.get(projectDir);
  if (!s) {
    s = new ClaudeTranscriptScanner(projectDir, { cache: proofScanCacheEnabled(), log });
    sharedScanners.set(projectDir, s);
  }
  return s;
}

/**
 * R4-5: the (dev, ino, size, mtime_ns) cache is on because the measured p95 on
 * the real uhsJARVIS project dir exceeded 250 ms without it (see LOCAL_MODS
 * #53). TELEGRAM_PROOF_SCAN_CACHE=0 turns it off.
 */
export function proofScanCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.TELEGRAM_PROOF_SCAN_CACHE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}
