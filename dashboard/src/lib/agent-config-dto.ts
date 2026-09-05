/**
 * dashboard/src/lib/agent-config-dto.ts — OS-02b-ui
 *
 * Redaction boundary for `GET /api/agents/[name]/config` (contract §7).
 * The raw agent config.json holds cron prompt bodies, inline tokens and other
 * secrets. Only the fields listed here ever leave the server, and cron entries
 * are reduced to their schedule metadata — prompts are dropped entirely.
 */

/** Operational fields that are safe to display AND writable via PATCH. */
export const WRITABLE_CONFIG_FIELDS = [
  'timezone',
  'day_mode_start',
  'day_mode_end',
  'communication_style',
  'approval_rules',
  'max_session_seconds',
  'max_crashes_per_day',
  'startup_delay',
  'ctx_warning_threshold',
  'ctx_handoff_threshold',
] as const;

/** Safe to display, not writable here. `model` is deliberately absent (§5). */
export const READONLY_CONFIG_FIELDS = ['runtime', 'enabled', 'org', 'emoji', 'role'] as const;

export interface CronSummary {
  name: string;
  schedule: string | null;
  enabled: boolean;
  /** Present so the UI can say "has a prompt" without ever showing it. */
  has_prompt: boolean;
}

export type AgentConfigDTO = Record<string, unknown> & { crons?: CronSummary[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Build the redacted DTO. Anything not on an allowlist is dropped, so a new
 * secret-bearing field added upstream cannot leak by default.
 */
export function buildAgentConfigDTO(raw: unknown): AgentConfigDTO {
  const cfg = isPlainObject(raw) ? raw : {};
  const dto: AgentConfigDTO = {};

  for (const key of [...WRITABLE_CONFIG_FIELDS, ...READONLY_CONFIG_FIELDS]) {
    const v = cfg[key];
    if (v === undefined) continue;
    // approval_rules is the only nested object allowed through; re-shape it so
    // an unexpected nested field cannot ride along.
    if (key === 'approval_rules') {
      const ar = isPlainObject(v) ? v : {};
      dto.approval_rules = {
        always_ask: Array.isArray(ar.always_ask) ? ar.always_ask.filter((x) => typeof x === 'string') : [],
        never_ask: Array.isArray(ar.never_ask) ? ar.never_ask.filter((x) => typeof x === 'string') : [],
      };
      continue;
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') dto[key] = v;
  }

  if (Array.isArray(cfg.crons)) {
    dto.crons = cfg.crons.filter(isPlainObject).map((c) => ({
      name: typeof c.name === 'string' ? c.name : '',
      schedule: typeof c.schedule === 'string' ? c.schedule : null,
      enabled: c.enabled !== false,
      has_prompt: typeof c.prompt === 'string' && c.prompt.length > 0,
    }));
  }

  return dto;
}
