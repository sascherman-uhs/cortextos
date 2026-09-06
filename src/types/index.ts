// cortextOS Node.js - Core Type Definitions
// These types match the bash version's JSON formats exactly for backward compatibility

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export const PRIORITY_MAP: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export const VALID_PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// Message Bus Types

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  priority: Priority;
  timestamp: string; // ISO 8601
  text: string;
  reply_to: string | null;
  sig?: string; // Security (H10): HMAC-SHA256 signature — optional for backwards compat
}

// Task Types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface TaskOutput {
  /** Output kind. "file" links to a saved deliverable; other shapes reserved. */
  type: 'file';
  /** For type:"file", the path to the file relative to CTX_ROOT (forward-slash separated). */
  value: string;
  /** Optional human-readable label shown in dashboard task detail. */
  label?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  type: 'agent' | 'human';
  needs_approval: boolean;
  status: TaskStatus;
  assigned_to: string;
  created_by: string;
  org: string;
  priority: Priority;
  project: string;
  kpi_key: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  completed_at: string | null;
  due_date: string | null;
  archived: boolean;
  result?: string;
  /** Linked deliverables (files saved via `cortextos bus save-output`). */
  outputs?: TaskOutput[];
  /**
   * Dependency DAG edges (beads-inspired). Optional so existing task
   * files remain valid with these fields absent. `blocked_by` lists
   * task IDs that must reach `completed` before this task can
   * progress; `blocks` is the reverse view, maintained symmetrically
   * at create-time so queries in either direction are cheap.
   */
  blocks?: string[];
  blocked_by?: string[];
}

// Event Types

export type EventCategory =
  | 'action'
  | 'error'
  | 'metric'
  | 'milestone'
  | 'heartbeat'
  | 'message'
  | 'task'
  | 'approval'
  | 'agent_activity';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface Event {
  id: string;
  agent: string;
  org: string;
  timestamp: string; // ISO 8601
  category: EventCategory;
  event: string;
  severity: EventSeverity;
  metadata: Record<string, unknown>;
}

// Heartbeat Types

export interface Heartbeat {
  agent: string;
  org: string;
  display_name?: string; // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  status: string;
  current_task: string;
  mode: 'day' | 'night';
  last_heartbeat: string; // ISO 8601
  loop_interval: string;
  // Legacy field — sync.ts falls back to this if last_heartbeat absent
  timestamp?: string;
}

// Approval Types

export type ApprovalCategory =
  | 'external-comms'
  | 'financial'
  | 'deployment'
  | 'data-deletion'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  title: string;
  requesting_agent: string;
  org: string;
  category: ApprovalCategory;
  status: ApprovalStatus;
  description: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// Agent Config Types (config.json)

export interface EcosystemFeatureConfig {
  enabled?: boolean;
}

export interface EcosystemConfig {
  /** Daily git snapshots of agent workspace. Agent stages safe files, reviews diff, commits. */
  local_version_control?: EcosystemFeatureConfig;
  /** 24h cron to check canonical repo for framework updates. Requires upstream git remote. */
  upstream_sync?: EcosystemFeatureConfig;
  /** Weekly cron to browse community catalog and surface new skills/templates to user. */
  catalog_browse?: EcosystemFeatureConfig;
  /** On-demand workflow to publish custom skills/templates to the community catalog. */
  community_publish?: EcosystemFeatureConfig;
}

export interface AgentConfig {
  startup_delay?: number;
  max_session_seconds?: number;
  max_crashes_per_day?: number;
  /**
   * Sliding-window crash-loop detector. When N crashes occur within the window,
   * the agent auto-pauses (status: 'halted') instead of retrying. Absent = legacy
   * daily counter only.
   */
  crash_window?: { seconds: number; max_crashes?: number };
  model?: string;
  /**
   * Whether to launch Claude Code with `--dangerously-skip-permissions`.
   * Defaults to true (back-compat: agents run unattended). Set to false to keep
   * Claude Code's permission system engaged so the PermissionRequest hook
   * (hook-permission-telegram) gates tool use instead of everything auto-running.
   * Only applies to the claude-code runtime (Hermes never passes the flag).
   */
  dangerously_skip_permissions?: boolean;
  /** Path to a role-scoped .mcp.json. When set, Claude Code is launched with
   *  --mcp-config <path> --strict-mcp-config so only the listed servers load,
   *  preventing the global ~/.mcp.json from multiplying across all sessions. */
  mcp_config?: string;
  working_directory?: string;
  enabled?: boolean;
  crons?: CronEntry[];
  timezone?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  communication_style?: string;
  approval_rules?: {
    always_ask: string[];
    never_ask: string[];
  };
  ecosystem?: EcosystemConfig;
  /** Context window % at which to warn agent + user. Default: 70. Absent = observe-only. */
  ctx_warning_threshold?: number;
  /** Context window % at which to inject handoff prompt and hard-restart. Default: 80. */
  ctx_handoff_threshold?: number;
  /**
   * Fallback context window cap (tokens) for codex-app-server agents when the
   * server's `thread/tokenUsage/updated` event reports `modelContextWindow=null`.
   * Defaults to 256000 when unset. Only applied to the codex-app-server runtime.
   */
  codex_context_cap?: number;
  /**
   * Agent runtime. Defaults to 'claude-code' when absent.
   * 'hermes' selects the HermesPTY spawn path (Python persistent REPL,
   * NousResearch/hermes-agent) with Hermes-specific bootstrap, session
   * continuity, and exit handling.
   */
  runtime?: 'claude-code' | 'hermes' | 'codex-app-server' | 'kimi';
  /**
   * Whether this agent runs a Telegram poller. Defaults to true when absent
   * (preserves existing behaviour). Set to false on specialist agents that
   * should not own a Telegram bot — only the designated orchestrator agent
   * should poll. Requires BOT_TOKEN + CHAT_ID to already be unset or the
   * poller will be skipped regardless.
   */
  telegram_polling?: boolean;
}

export interface CronEntry {
  name: string;
  /** For recurring crons: how often to fire (e.g. "4h", "1d"). */
  interval?: string;
  /** For time-anchored crons: a cron expression (e.g. "0 8 * * *"). Takes precedence over interval. */
  cron?: string;
  /** For one-shot crons: ISO 8601 datetime when the cron should fire. */
  fire_at?: string;
  prompt: string;
  /** "recurring" (default) restores on every session start.
   *  "once" restores only if fire_at is still in the future; deleted after firing. */
  type?: 'recurring' | 'once' | 'disabled';
}

// ---------------------------------------------------------------------------
// External Persistent Cron System — Subtask 1.1
// ---------------------------------------------------------------------------
//
// CronDefinition is the canonical record stored in per-agent crons.json files:
//   .cortextOS/state/agents/{agent_name}/crons.json
//
// The file is an array of CronDefinition objects.  The daemon reads it, schedules
// each enabled cron, and injects the prompt into the agent's PTY on schedule.
//
// Operators may edit crons.json by hand (it is intentionally human-readable).
// Keep all field names lowercase-snake-case and all times as ISO 8601 UTC.
//
// Example records
// ---------------
//
// Heartbeat — every 6 hours (interval shorthand):
// {
//   "name": "heartbeat",
//   "schedule": "6h",
//   "prompt": "Read HEARTBEAT.md and execute the heartbeat workflow.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Periodic health check and status update."
// }
//
// Daily morning briefing — fixed local time via cron expression:
// {
//   "name": "morning-briefing",
//   "schedule": "0 13 * * *",
//   "prompt": "Prepare and send the morning briefing to James.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Daily 09:00 ET briefing (UTC offset applied in schedule).",
//   "last_fired_at": "2026-04-28T13:00:01.042Z",
//   "fire_count": 14
// }
//
// Weekly report — cron expression with day-of-week restriction:
// {
//   "name": "weekly-report",
//   "schedule": "0 16 * * 1",
//   "prompt": "Compile and send the weekly performance report.",
//   "enabled": true,
//   "created_at": "2026-04-01T00:00:00.000Z",
//   "description": "Every Monday at 12:00 ET (16:00 UTC).",
//   "fire_count": 3
// }

/**
 * A single persistent cron definition stored in an agent's crons.json.
 *
 * Stored at: `.cortextOS/state/agents/{agent_name}/crons.json`
 *
 * The `schedule` field accepts two formats:
 *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
 *     Parsed by `parseDurationMs()` from `src/bus/cron-state.ts`.
 *   - Standard 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"` (every 6h)
 *     Evaluated by the daemon scheduler (Subtask 1.3).
 *
 * The daemon fires the cron by injecting `[CRON: {name}] {prompt}` into
 * the agent's PTY session.
 */
export interface CronDefinition {
  // ------------------------------------------------------------------
  // Required fields — must be present for the daemon to schedule this cron.
  // ------------------------------------------------------------------

  /**
   * Unique identifier for this cron within the agent.
   * Used as the key for lookups, updates, and deletions.
   * Must be unique per agent; slugs like "heartbeat" or "morning-briefing" are recommended.
   *
   * @example "heartbeat"
   * @example "morning-briefing"
   */
  name: string;

  /**
   * The prompt text injected into the agent PTY when the cron fires.
   * The daemon prepends `[CRON: {name}] ` automatically for traceability.
   *
   * @example "Read HEARTBEAT.md and execute the heartbeat workflow."
   */
  prompt: string;

  /**
   * When and how often this cron fires.
   *
   * Accepted formats:
   *   - Interval shorthand: `"6h"`, `"30m"`, `"1d"`, `"2w"`
   *     The cron fires every N units after its previous fire (or after daemon start
   *     if it has never fired).
   *   - 5-field cron expression: `"0 8 * * *"`, `"0 0,6,12,18 * * *"`, `"0 16 * * 1"`
   *     Evaluated against the daemon's wall clock (daemon timezone = server timezone).
   *
   * @example "6h"         — every six hours
   * @example "0 13 * * *" — daily at 13:00 UTC
   * @example "0 16 * * 1" — every Monday at 16:00 UTC
   */
  schedule: string;

  /**
   * Whether the daemon should fire this cron.
   * Set to `false` to pause a cron without deleting it.
   *
   * @default true
   */
  enabled: boolean;

  /**
   * ISO 8601 UTC timestamp of when this cron definition was created.
   * Set automatically by `cortextos bus add-cron`; operators should not modify this.
   *
   * @example "2026-04-01T00:00:00.000Z"
   */
  created_at: string;

  // ------------------------------------------------------------------
  // Optional fields — populated at runtime or by operators.
  // ------------------------------------------------------------------

  /**
   * ISO 8601 UTC timestamp of the most recent successful fire.
   * Updated by the daemon scheduler (Subtask 1.3) after each fire.
   * Absent when the cron has never fired.
   *
   * @example "2026-04-28T13:00:01.042Z"
   */
  last_fired_at?: string;

  /**
   * ISO 8601 UTC timestamp set by the scheduler IMMEDIATELY before it awaits
   * the onFire dispatch — i.e. before the agent has acked. On daemon crash
   * mid-fire, this lets `loadCrons` recompute `referenceMs` from the attempt
   * timestamp instead of the stale `last_fired_at`, preventing a double-fire
   * via the catch-up gate. Tradeoff: a fire whose dispatch genuinely failed
   * pre-crash will be skipped one window — preferable to guaranteed re-fire.
   */
  last_fire_attempted_at?: string;

  /**
   * Total number of times this cron has successfully fired.
   * Incremented by the daemon on each successful PTY injection.
   * Absent (or 0) when the cron has never fired.
   */
  fire_count?: number;

  /**
   * Optional pre-fire gate. When set to `"inbox"`, the daemon only injects the
   * cron prompt if the agent's bus inbox ({CTX_ROOT}/inbox/{agentName}/) holds
   * at least one pending message file. An empty inbox counts as a successful
   * fire (schedule advances, fire_count untouched) with a `[cron-gate]` log
   * line and NO PTY injection — so recurring "check inbox" crons stop burning
   * an LLM turn just to discover there is nothing to do (2026-08-18: the three
   * 10-minute task-check crons alone were ~432 idle sessions/day on API billing).
   *
   * @example "inbox"
   */
  gate?: 'inbox';

  /**
   * ISO 8601 UTC timestamp for one-shot crons — when the cron should fire once
   * and then be deleted. Mutually exclusive with recurring `schedule` semantics:
   * if `fire_at` is set, the daemon treats this as a one-shot regardless of
   * `schedule`. Used by `cron-health.ts` to flag never-fired one-shots that
   * are still inside their grace window as healthy rather than stale.
   *
   * @example "2026-05-15T14:00:00.000Z"
   */
  fire_at?: string;

  /**
   * Human-readable description of what this cron does.
   * Optional — for operator documentation and dashboard display.
   *
   * @example "Periodic health check and status update."
   */
  description?: string;

  /**
   * Arbitrary key-value pairs for agent-specific context.
   * Not interpreted by the daemon; surfaced in dashboard + execution logs.
   *
   * @example { "priority": "high", "source": "/loop" }
   */
  metadata?: Record<string, unknown>;

  /**
   * When true, the Test Fire button in the dashboard is disabled and the
   * IPC fire-cron handler refuses manual-trigger requests.
   *
   * Use this for crons that must only run on their schedule (e.g. crons
   * that do destructive operations or have strict rate-limit contracts).
   *
   * @default false (manual fire is allowed by default — opt-out model)
   */
  manualFireDisabled?: boolean;
}

// ---------------------------------------------------------------------------
// Cron Execution Log — Subtask 1.5
// ---------------------------------------------------------------------------

/**
 * A single entry in the per-agent cron execution log
 * (`$CTX_ROOT/.cortextOS/state/agents/{agent}/cron-execution.log`).
 *
 * The file is JSONL (one JSON object per line, newline-separated).
 * It is append-only; log rotation prunes to the last 1 000 lines.
 *
 * Status semantics:
 *   "fired"   — the fire attempt succeeded on this attempt.
 *   "retried" — this attempt failed but more retries remain (see `error`).
 *   "failed"  — final failure after exhausting all retries (see `error`).
 */
export interface CronExecutionLogEntry {
  /** ISO 8601 UTC timestamp of the fire attempt. */
  ts: string;
  /** Cron name (matches CronDefinition.name). */
  cron: string;
  /** Outcome of this attempt. */
  status: 'fired' | 'retried' | 'failed';
  /** Attempt index (1-based). */
  attempt: number;
  /** Wall-clock duration of the fire attempt in milliseconds. */
  duration_ms: number;
  /** Error message if status is "retried" or "failed"; null otherwise. */
  error: string | null;
}

export interface OrgContext {
  name?: string;
  description?: string;
  industry?: string;
  icp?: string;
  value_prop?: string;
  timezone?: string;
  orchestrator?: string;
  day_mode_start?: string;
  day_mode_end?: string;
  default_approval_categories?: string[];
  communication_style?: string;
  dashboard_url?: string;
  /** When true, agents are instructed at startup that every task submitted
   *  for review must have at least one file deliverable attached via
   *  save-output. The instruction is injected into the boot prompt
   *  dynamically — no agent markdown files are modified. */
  require_deliverables?: boolean;
}

// Telegram Types

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}

/**
 * One item in a Telegram message's reaction list. Telegram supports
 * `type: 'emoji'` (standard emoji, the only shape we handle today) and
 * `type: 'custom_emoji'` (premium custom emoji, carrying a `custom_emoji_id`
 * instead of an `emoji` character). Shaped as a tagged union so call sites
 * can narrow safely.
 */
export type TelegramReactionType =
  | { type: 'emoji'; emoji: string }
  | { type: 'custom_emoji'; custom_emoji_id: string };

/**
 * A `message_reaction` update fires when a user adds or removes an
 * emoji reaction on a chat message the bot can see. `old_reaction` and
 * `new_reaction` are the reaction state before/after — empty means "no
 * reaction", so the diff is (new) minus (old). Requires
 * `allowed_updates: ['message_reaction']` in the getUpdates call.
 */
export interface TelegramMessageReaction {
  chat: TelegramChat;
  user?: TelegramUser;
  message_id: number;
  date: number;
  old_reaction: TelegramReactionType[];
  new_reaction: TelegramReactionType[];
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video?: TelegramVideo;
  video_note?: TelegramVideoNote;
  caption?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideo {
  file_id: string;
  duration: number;
  file_name?: string;
}

export interface TelegramVideoNote {
  file_id: string;
  duration: number;
}

// Task Management Report Types

export interface StaleTaskReport {
  stale_in_progress: Task[];
  stale_pending: Task[];
  stale_human: Task[];
  overdue: Task[];
}

export interface ArchiveReport {
  archived: number;
  skipped: number;
  dry_run: boolean;
}

// Environment / Context Types

export interface CtxEnv {
  instanceId: string;
  ctxRoot: string;
  frameworkRoot: string;
  agentName: string;
  agentDir: string;
  org: string;
  projectRoot: string;
  timezone?: string;
  orchestrator?: string;
}

// Bus Path Types

export interface BusPaths {
  ctxRoot: string;
  inbox: string;
  inflight: string;
  processed: string;
  logDir: string;
  stateDir: string;
  taskDir: string;
  approvalDir: string;
  analyticsDir: string;
  /**
   * Per-org deliverables root: {ctxRoot}/orgs/{org}/deliverables/.
   * Files saved here are servable by the dashboard's /api/media route because
   * they live under CTX_ROOT.
   */
  deliverablesDir: string;
}

// IPC Types

export type IPCCommandType =
  | 'status'
  | 'start-agent'
  | 'stop-agent'
  | 'restart-agent'
  | 'wake'
  | 'list-agents'
  | 'spawn-worker'
  | 'terminate-worker'
  | 'list-workers'
  | 'inject-worker'
  | 'reload-crons'
  | 'fire-cron'
  | 'inject-agent'
  | 'list-all-crons'
  | 'list-cron-executions'
  | 'add-cron'
  | 'update-cron'
  | 'remove-cron'
  | 'fleet-health'
  | 'ingress-transfer';

// ---------------------------------------------------------------------------
// Execution log pagination response — Subtask 4.3
// ---------------------------------------------------------------------------

/**
 * Paginated response for list-cron-executions IPC command.
 */
export interface CronExecutionLogPage {
  entries: CronExecutionLogEntry[];
  /** Total matching entries (after cronName + statusFilter applied). */
  total: number;
  /** True when there are more entries older than this page. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// list-all-crons response shape — Subtask 4.1
// ---------------------------------------------------------------------------

/**
 * One row returned by the `list-all-crons` IPC command.
 * Combines the cron definition with runtime state (last fire, next fire, status).
 */
export interface CronSummaryRow {
  /** Agent that owns this cron. */
  agent: string;
  /** Org the agent belongs to (from enabled-agents.json). */
  org: string;
  /** Full cron definition as stored in crons.json. */
  cron: CronDefinition;
  /**
   * ISO 8601 timestamp of the most recent fire attempt.
   * Null when the cron has never fired (no execution log entry).
   */
  lastFire: string | null;
  /**
   * Outcome of the most recent execution log entry.
   * Null when the cron has never fired.
   */
  lastStatus: 'fired' | 'retried' | 'failed' | null;
  /**
   * ISO 8601 timestamp of the next scheduled fire.
   * Computed from the cron's schedule + last_fired_at (or now).
   */
  nextFire: string;
}

// ---------------------------------------------------------------------------
// Fleet Health — Subtask 4.4
// ---------------------------------------------------------------------------

export type CronHealthState = 'healthy' | 'warning' | 'failure' | 'never-fired';

/** Health record for a single cron, returned by the fleet-health IPC command. */
export interface CronHealthRow {
  agent: string;
  org: string;
  cronName: string;
  state: CronHealthState;
  reason: string;
  lastFire: number | null;
  expectedIntervalMs: number;
  gapMs: number | null;
  successRate24h: number;
  firesLast24h: number;
  nextFire: string;
}

/** Per-agent breakdown in the fleet-health summary. */
export interface AgentHealthSummary {
  agent: string;
  org: string;
  total: number;
  healthy: number;
  warning: number;
  failure: number;
  neverFired: number;
}

/** Full response returned by the fleet-health IPC command. */
export interface FleetHealthResponse {
  rows: CronHealthRow[];
  summary: {
    total: number;
    healthy: number;
    warning: number;
    failure: number;
    neverFired: number;
    agents: Record<string, AgentHealthSummary>;
  };
}

export interface IPCRequest {
  type: IPCCommandType;
  agent?: string;
  data?: Record<string, unknown>;
  /**
   * BUG-015: human-readable identifier of the caller (e.g. 'cortextos enable',
   * 'cortextos bus soft-restart-all'). Logged by the daemon on every incoming
   * IPC request so we can trace which CLI command triggered which daemon action.
   * Optional for backwards compatibility — older clients fall back to 'unknown'.
   */
  source?: string;
}

// Worker Types

export type WorkerStatusValue = 'starting' | 'running' | 'completed' | 'failed';

export interface WorkerStatus {
  name: string;
  status: WorkerStatusValue;
  pid?: number;
  dir: string;
  parent?: string;
  spawnedAt: string;
  exitCode?: number;
}

export interface IPCResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * Structured error code for failed responses. Lets operators distinguish
   * "agent does not exist" (NOT_FOUND) from "request collapsed against an
   * in-flight identical op" (DEDUPED). See issue #346.
   */
  code?: 'NOT_FOUND' | 'DEDUPED' | 'INVALID_INPUT' | 'NOT_RUNNING';
}

// Agent Discovery Types

export interface AgentInfo {
  name: string;
  org: string;
  display_name?: string;  // user-configured name from IDENTITY.md (e.g. "Alpha", "Beta")
  role: string;
  enabled: boolean;
  running: boolean;
  last_heartbeat: string | null;
  current_task: string | null;
  mode: string | null;
}

// Agent Status (returned by daemon)

export interface AgentStatus {
  name: string;
  status: 'running' | 'stopped' | 'crashed' | 'starting' | 'halted';
  pid?: number;
  uptime?: number; // seconds
  lastHeartbeat?: string;
  sessionStart?: string;
  crashCount?: number;
  model?: string;
}

// ---------------------------------------------------------------------------
// Model routing registry (OS-02b-core)
// ---------------------------------------------------------------------------
//
// Implements `.planning/agentic-os/model-routing-contract.md`. The registry is
// the single authority for "which model does this consumer run on". Agent
// config.json keeps `runtime`; its `model` field becomes LEGACY — imported as a
// pin by `cortextos model migrate --bootstrap`, never edited by this system.
//
// All types here are ADDITIVE. The `AgentConfig.runtime` union is unchanged;
// the adapter map (below) is what actually decides which adapters exist, so a
// new adapter can be registered without a code change to that union.

/** Activation mode for one consumer (agent name or JARVIS call-site id). */
export type ModelActivationMode = 'shadow' | 'enforced';

/** How a model entry is billed. Drives the cost preview on a switch. */
export type ModelBillingMode = 'subscription_quota' | 'api_cash' | 'local';

export type ModelEntryStatus = 'active' | 'deprecated' | 'unavailable';

/** A bounded, non-billing health probe descriptor. */
export interface ModelHealthProbe {
  /**
   * `cli-print`  — a CLI login/credential presence check (never a billed call).
   * `env-key`    — presence of the named environment variable.
   * `http-tags`  — a local HTTP GET (ollama `/api/tags`).
   * `none`       — no probe is possible for this entry.
   */
  kind: 'cli-print' | 'env-key' | 'http-tags' | 'none';
  timeout_ms?: number;
  url?: string;
}

export interface ModelEntry {
  model_id: string;
  provider: string;
  runtime_adapter: string;
  capability_tags: string[];
  context_window: number;
  billing_mode: ModelBillingMode;
  cost_class: number;
  auth_source: string | null;
  status: ModelEntryStatus;
  health_probe?: ModelHealthProbe;
  /** Optional human note (e.g. why an entry is marked unavailable). */
  note?: string;
}

export interface ModelAdapterDescriptor {
  version: number;
  /**
   * How this adapter is told which model to run. `null` means the adapter has
   * no explicit-selection mechanism — it can be described but never enforced.
   */
  selection: string | null;
  /** Where a runtime-observed model id can be read back, or null if nowhere. */
  observed_source: string | null;
  supports: string[];
  auth_source: string | null;
  /**
   * Agent `runtime` values this adapter can host. Absent = the adapter id is
   * itself the runtime name (the common case).
   */
  hosts_runtimes?: string[];
}

export type ModelPinKind = 'explicit' | 'legacy-migration' | 'proposed-invalid';

export interface ModelPin {
  entry_id: string;
  kind: ModelPinKind;
  reason: string;
  actor: string;
  created_at: string;
  expires_at: string | null;
  fallback?: string[];
  /**
   * Human task raised for a `proposed-invalid` pin. Carried here so `resolve()`
   * can hand the UI a remediation item instead of only an error code — a
   * non-dispatchable pin is a work item, not a failed command.
   */
  task_id?: string;
}

export interface ModelRoleAssignment {
  tier: string;
  /**
   * Capability tags the MODEL must carry. Matched against a registry entry's
   * `capability_tags` during resolution (`validateCandidate`), so every value
   * here has to exist on some entry or the role becomes unresolvable.
   */
  required_capabilities: string[];
  /**
   * Properties of the ROLE itself — what this role participates in, e.g.
   * `continuous-improvement` (weekly Kaizen enrollment). Deliberately a
   * SEPARATE field from `required_capabilities`: it is never matched against
   * a model entry, so declaring one here can never make a role unresolvable.
   * Absent means the empty list.
   */
  role_capabilities?: string[];
  min_context: number;
  data_scope: string;
}

export interface ModelAgentAssignment {
  role: string;
  pin: ModelPin | null;
}

export interface ModelCallsiteAssignment {
  role: string;
  pin?: ModelPin | null;
}

export interface ModelRegistry {
  schema_version: number;
  revision: number;
  updated_at: string;
  updated_by: string;
  activation: {
    org_default: ModelActivationMode;
    consumers: Record<string, ModelActivationMode>;
  };
  adapters: Record<string, ModelAdapterDescriptor>;
  entries: Record<string, ModelEntry>;
  tiers: Record<string, string[]>;
  org_default_tier: string;
  roles: Record<string, ModelRoleAssignment>;
  agents: Record<string, ModelAgentAssignment>;
  callsites: Record<string, ModelCallsiteAssignment>;
}

export interface ModelValidationError {
  code: string;
  message: string;
}

export interface ModelResolveOverride {
  tier?: string;
  entry_id?: string;
  actor: string;
  reason: string;
}

export interface ModelResolveInput {
  agent?: string;
  callsite?: string;
  role?: string;
  override?: ModelResolveOverride;
  /**
   * Attach the newest attempt record for this consumer as `observed`.
   * Defaults to true. The spawn path passes `false` because it costs a
   * directory scan it does not need — everything else (CLI, dashboard) wants
   * desired-vs-running, so the honest answer is the default.
   */
  withObserved?: boolean;
}

export interface ModelSelection {
  entry_id: string;
  model_id: string;
  provider: string;
  runtime_adapter: string;
  billing_mode: string;
  cost_class: number;
}

export interface ModelResolution {
  registry_revision: number;
  activation: ModelActivationMode;
  requested: {
    source: 'override' | 'pin' | 'role' | 'org_default';
    tier?: string;
    entry_id?: string;
  };
  /** Ordered eligible entry ids remaining after validation filtering. */
  candidates: string[];
  selected: ModelSelection | null;
  validation: { ok: boolean; errors: ModelValidationError[]; warnings: string[] };
  /** What the agent config literally says today (shadow reporting only). */
  legacy_effective?: { model_id?: string; runtime?: string };
  /** Resolved role id, when one could be determined. */
  role?: string;
  /**
   * The model a spawn from this resolution would ACTUALLY dispatch: the legacy
   * config model in shadow, the resolved model in enforced. This — not
   * `selected.model_id` — is the "desired" half of desired-vs-running.
   */
  expected_model_id: string | null;
  /**
   * Newest runtime observation for this consumer, read from the attempt
   * journal. `null` means no attempt has been recorded yet (genuinely
   * unknown), which is different from an attempt that came back unconfirmed.
   */
  observed: ModelObservedSummary | null;
  /**
   * A validation failure a human can act on, surfaced as a work item rather
   * than only an error code. Present when the consumer carries a
   * `proposed-invalid` pin awaiting a routing decision.
   */
  remediation?: ModelRemediation;
}

export interface ModelObservedSummary {
  model_id: string | null;
  source: string | null;
  binding: ModelObservationBinding | null;
  confidence: ModelObservedConfidence;
  at: string | null;
  attempt_id: string;
}

export interface ModelRemediation {
  kind: 'proposed-invalid-pin';
  /** Consumer the pin sits on. */
  agent?: string;
  /** Entry the invalid pin names. */
  entry_id?: string;
  /** Human task raised when the pin was created, when one exists. */
  task_id?: string;
  /** Why it cannot dispatch, and what a human should decide. */
  detail: string;
}

export type ModelOperationKind = 'switch' | 'pin' | 'unpin' | 'revert' | 'activation' | 'role_capability';

export type ModelOperationState =
  | 'requested'
  | 'validated'
  | 'desired_written'
  | 'draining'
  | 'applied'
  | 'blocked'
  | 'failed';

export interface ModelRestartResult {
  agent: string;
  ok: boolean;
  detail: string;
  observed_after?: string | null;
  /** PID the agent was running under BEFORE the restart, when known. */
  pid_before?: number | null;
  /** PID read back AFTER the restart — proof a fresh process exists. */
  pid?: number | null;
  /** `sessionStart` read back after the restart. */
  session_start?: string | null;
  /** Newest attempt id recorded for this agent after the restart, if any. */
  attempt_id?: string | null;
  /**
   * True when the daemon answered the start with DEDUPED / "already in
   * registry" and a fresh session was nevertheless confirmed within the drain
   * window. The restart happened; the response was just the wrong shape.
   */
  deduped_but_restarted?: boolean;
}

export interface ModelOperationReceipt {
  operation_id: string;
  kind: ModelOperationKind;
  actor: string;
  reason: string;
  from: unknown;
  to: unknown;
  affected_consumers: string[];
  registry_revision_before: number;
  registry_revision_after: number;
  state: ModelOperationState;
  restart_results: ModelRestartResult[];
  /**
   * Whether this operation needed any agent restarted at all. `false` with
   * state `applied` is the "no restart needed" case — an empty
   * `restart_results` then means nothing was owed, not that something failed
   * to run.
   */
  restart_required: boolean;
  /** Operation id this receipt reverts, for `kind: 'revert'`. */
  revert_of?: string;
  created_at: string;
  applied_at: string | null;
  error: string | null;
}

export interface ModelEventRecord {
  operation_id: string;
  state: ModelOperationState | 'revert';
  kind: ModelOperationKind;
  actor: string;
  reason: string;
  at: string;
  registry_revision: number;
  detail?: Record<string, unknown>;
}

export type ModelObservedConfidence = 'verified' | 'unconfirmed' | 'mismatch';

/**
 * How an observed model id was tied to a specific spawn. `session-id` and
 * `thread-id` are exact; `prompt-correlated` matches the boot prompt on a
 * transcript newer than the spawn. Anything else is a guess and must leave the
 * attempt `unconfirmed`.
 */
export type ModelObservationBinding = 'session-id' | 'thread-id' | 'prompt-correlated' | 'unbound';

export interface ModelAttemptRecord {
  attempt_id: string;
  consumer: string;
  role: string | null;
  requested: ModelResolution['requested'];
  selected_entry: string | null;
  model_id: string | null;
  runtime_adapter: string | null;
  billing_mode: string | null;
  registry_revision: number;
  session_ref: string | null;
  activation: ModelActivationMode;
  /**
   * The model this spawn actually dispatches, and therefore the only baseline
   * an observation may be compared against: the legacy config model in shadow
   * mode, the resolved model in enforced mode. Optional for records written
   * before the field existed.
   */
  expected_model_id?: string | null;
  at: string;
  observed: {
    model_id: string | null;
    source: string | null;
    confidence: ModelObservedConfidence;
    at: string | null;
    /** How the transcript was attributed to this spawn (absent = legacy record). */
    binding?: ModelObservationBinding;
  };
  fallback?: { from: string; reason: string };
}

/**
 * Error classes that may trigger an automatic fallback to the next candidate.
 * Quality / refusal / policy failures MUST NOT — see contract §3.
 */
export type ModelFallbackClass = 'spawn' | 'auth' | 'quota' | 'outage';
